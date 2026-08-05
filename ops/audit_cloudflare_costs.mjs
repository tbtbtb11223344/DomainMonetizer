import { readFile } from "node:fs/promises";
import { evaluateProjectContract } from "./cloudflare_project_contract.mjs";

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
const [workers, databases, namespaces, queues, accessApps, workerSettings, workerDomains] = await Promise.all([
  cloudflare(`/accounts/${accountId}/workers/scripts`, apiToken),
  cloudflare(`/accounts/${accountId}/d1/database`, apiToken),
  cloudflare(`/accounts/${accountId}/storage/kv/namespaces`, apiToken),
  optionalCloudflare("Queues inventory unavailable", `/accounts/${accountId}/queues`, apiToken, warnings),
  optionalCloudflare("Access inventory unavailable", `/accounts/${accountId}/access/apps`, apiToken, warnings),
  optionalCloudflare("Workers account settings unavailable", `/accounts/${accountId}/workers/account-settings`, apiToken, warnings),
  cloudflare(`/accounts/${accountId}/workers/domains/records`, apiToken),
]);

const projectWorkers = arrayResult(workers).filter((worker) => worker.id?.startsWith(projectPrefix));
const projectSchedules = {};
const projectWorkerBindings = [];
for (const worker of projectWorkers) {
  const scheduleResult = await optionalCloudflare(
    `${worker.id} schedules unavailable`,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker.id)}/schedules`,
    apiToken,
    warnings,
  );
  projectSchedules[worker.id] = arrayResult(scheduleResult, "schedules").map((schedule) => schedule.cron);
  const settings = await optionalCloudflare(
    `${worker.id} settings unavailable`,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker.id)}/settings`,
    apiToken,
    warnings,
  );
  projectWorkerBindings.push({
    worker: worker.id,
    bindings: arrayResult(settings?.bindings).map((binding) => ({ name: binding.name || "unnamed", type: binding.type || "unknown" })),
  });
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
const projectDatabases = arrayResult(databases)
  .filter((database) => database.name?.startsWith(projectPrefix))
  .map((database) => ({ name: database.name, bytes: database.file_size ?? null }));
const projectNamespaces = arrayResult(namespaces)
  .filter((namespace) => namespace.title?.startsWith(projectPrefix))
  .map((namespace) => namespace.title);
const projectQueues = arrayResult(queues)
  .filter((queue) => queue.queue_name?.startsWith(projectPrefix))
  .map((queue) => queue.queue_name);
const projectAccessApps = arrayResult(accessApps)
  .filter((app) => app.name?.toLowerCase().includes("domainmonetizer"))
  .map((app) => ({ name: app.name, domain: app.domain, type: app.type }));
const projectWorkerDomains = arrayResult(workerDomains)
  .filter((domain) => domain.service?.startsWith(projectPrefix))
  .map((domain) => ({
    hostname: domain.hostname,
    service: domain.service,
    environment: domain.environment || "production",
    zoneId: domain.zone_id || null,
  }));
const contractIssues = evaluateProjectContract({
  billableSubscriptions,
  warnings,
  workers: projectWorkers.map((worker) => worker.id),
  schedules: projectSchedules,
  d1Databases: projectDatabases.map((database) => database.name),
  d1DatabaseSizes: projectDatabases,
  kvNamespaces: projectNamespaces,
  queues: projectQueues,
  accessApps: projectAccessApps,
  workerDomains: projectWorkerDomains,
  workerBindings: projectWorkerBindings,
});

const report = {
  auditedAt: new Date().toISOString(),
  guard: contractIssues.length === 0 ? "PASS" : "FAIL",
  billing: {
    billableSubscriptionCount: billableSubscriptions.length,
    subscriptions: sanitizedSubscriptions,
  },
  projectInventory: {
    workers: projectWorkers.map((worker) => worker.id),
    schedules: projectSchedules,
    d1Databases: projectDatabases,
    kvNamespaces: projectNamespaces,
    queues: projectQueues,
    accessApps: projectAccessApps,
    workerDomains: projectWorkerDomains,
    workersUsageModelLabel: workerSettings?.default_usage_model || "unavailable",
    workerBindings: projectWorkerBindings,
  },
  notes: [
    "The subscription price is the billing source of truth; Cloudflare may label the Workers usage model as standard on a free account.",
    "R2 bucket inventory is intentionally not queried; Worker settings prove that DomainMonetizer has no R2 binding and does not use the supplied S3 credentials.",
  ],
  warnings,
  issues: contractIssues,
};

console.log(JSON.stringify(report, null, 2));

if (contractIssues.length > 0) {
  console.error("Cloudflare pilot contract guard failed.");
  process.exitCode = 2;
}
