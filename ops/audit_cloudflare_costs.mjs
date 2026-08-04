import { readFile } from "node:fs/promises";

const apiBase = "https://api.cloudflare.com/client/v4";
const projectPrefix = "domain-monetizer";

function parseEnv(source) {
  const values = {};

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

async function loadCredentials() {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || fileValues.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || fileValues.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required in the environment or .env.");
  }

  return { accountId, apiToken };
}

async function cloudflare(path, apiToken) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.success) {
    const apiMessage = body?.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(`${response.status} ${apiMessage || response.statusText}`.trim());
  }

  return body.result;
}

async function optionalCloudflare(label, path, apiToken, warnings) {
  try {
    return await cloudflare(path, apiToken);
  } catch (error) {
    warnings.push(`${label}: ${error.message}`);
    return null;
  }
}

function arrayResult(value, nestedKey) {
  if (Array.isArray(value)) return value;
  if (nestedKey && Array.isArray(value?.[nestedKey])) return value[nestedKey];
  return [];
}

const { accountId, apiToken } = await loadCredentials();
const warnings = [];

const subscriptions = await cloudflare(`/accounts/${accountId}/subscriptions`, apiToken);
const [workers, databases, namespaces, queues, accessApps, workerSettings] = await Promise.all([
  cloudflare(`/accounts/${accountId}/workers/scripts`, apiToken),
  cloudflare(`/accounts/${accountId}/d1/database`, apiToken),
  cloudflare(`/accounts/${accountId}/storage/kv/namespaces`, apiToken),
  optionalCloudflare("Queues inventory unavailable", `/accounts/${accountId}/queues`, apiToken, warnings),
  optionalCloudflare("Access inventory unavailable", `/accounts/${accountId}/access/apps`, apiToken, warnings),
  optionalCloudflare("Workers account settings unavailable", `/accounts/${accountId}/workers/account-settings`, apiToken, warnings),
]);

const projectWorkers = arrayResult(workers).filter((worker) => worker.id?.startsWith(projectPrefix));
const projectSchedules = {};
for (const worker of projectWorkers) {
  const scheduleResult = await optionalCloudflare(
    `${worker.id} schedules unavailable`,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker.id)}/schedules`,
    apiToken,
    warnings,
  );
  projectSchedules[worker.id] = arrayResult(scheduleResult, "schedules").map((schedule) => schedule.cron);
}

const sanitizedSubscriptions = arrayResult(subscriptions).map((subscription) => ({
  planId: subscription.rate_plan?.id || "unknown",
  name: subscription.rate_plan?.public_name || "Unknown plan",
  state: subscription.state || "unknown",
  frequency: subscription.frequency || "unknown",
  price: Number(subscription.price || 0),
  currency: subscription.rate_plan?.currency || "unknown",
}));
const billableSubscriptions = sanitizedSubscriptions.filter((subscription) => subscription.price > 0);

const report = {
  auditedAt: new Date().toISOString(),
  guard: billableSubscriptions.length === 0 ? "PASS" : "FAIL",
  billing: {
    billableSubscriptionCount: billableSubscriptions.length,
    subscriptions: sanitizedSubscriptions,
  },
  projectInventory: {
    workers: projectWorkers.map((worker) => worker.id),
    schedules: projectSchedules,
    d1Databases: arrayResult(databases)
      .filter((database) => database.name?.startsWith(projectPrefix))
      .map((database) => ({ name: database.name, bytes: database.file_size || null })),
    kvNamespaces: arrayResult(namespaces)
      .filter((namespace) => namespace.title?.startsWith(projectPrefix))
      .map((namespace) => namespace.title),
    queues: arrayResult(queues)
      .filter((queue) => queue.queue_name?.startsWith(projectPrefix))
      .map((queue) => queue.queue_name),
    accessApps: arrayResult(accessApps)
      .filter((app) => app.name?.toLowerCase().includes("domainmonetizer"))
      .map((app) => ({ name: app.name, domain: app.domain, type: app.type })),
    workersUsageModelLabel: workerSettings?.default_usage_model || "unavailable",
    r2Bindings: [],
  },
  notes: [
    "The subscription price is the billing source of truth; Cloudflare may label the Workers usage model as standard on a free account.",
    "R2 is intentionally not queried because DomainMonetizer has no R2 binding and does not use the supplied S3 credentials.",
  ],
  warnings,
};

console.log(JSON.stringify(report, null, 2));

if (billableSubscriptions.length > 0) {
  console.error("Cost guard failed: the Cloudflare account has a positive-price subscription.");
  process.exitCode = 2;
}
