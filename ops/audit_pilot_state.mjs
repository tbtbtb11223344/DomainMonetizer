import { readFile } from "node:fs/promises";

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

async function loadEnvironment() {
  let fileValues = {};
  try {
    fileValues = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...fileValues, ...process.env };
}

function accessHeaders(environment) {
  const operatorToken = environment.OPERATOR_API_TOKEN;
  const accessClientId = environment.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = environment.CF_ACCESS_CLIENT_SECRET;
  if (!operatorToken) throw new Error("OPERATOR_API_TOKEN is required in the environment or .env.");
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be provided together.");
  }
  return {
    Authorization: `Bearer ${operatorToken}`,
    ...(accessClientId ? {
      "CF-Access-Client-Id": accessClientId,
      "CF-Access-Client-Secret": accessClientSecret,
    } : {}),
  };
}

async function readJson(url, init = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const environment = await loadEnvironment();
const baseUrl = (environment.CONTROL_URL || "https://admin.multibrands.net").replace(/\/$/u, "");
const pilotSeed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));
const expectedHostnames = pilotSeed.domains.map((domain) => domain.hostname).sort();
const headers = accessHeaders(environment);

const [domainsResult, overviewResult] = await Promise.all([
  readJson(`${baseUrl}/api/domains?limit=500`, { headers }),
  readJson(`${baseUrl}/api/metrics/overview`, { headers }),
]);

if (!domainsResult.response.ok || !Array.isArray(domainsResult.body?.domains)) {
  throw new Error(`Domain inventory unavailable (${domainsResult.response.status}).`);
}
if (!overviewResult.response.ok || !overviewResult.body) {
  throw new Error(`Metrics overview unavailable (${overviewResult.response.status}).`);
}

const domains = domainsResult.body.domains;
const overview = overviewResult.body;
const inventoryByHostname = new Map(domains.map((domain) => [domain.hostname, domain]));
const healthByHostname = new Map((overview.healthChecks ?? []).map((check) => [check.hostname, check]));
const issues = [];

for (const hostname of expectedHostnames) {
  const domain = inventoryByHostname.get(hostname);
  if (!domain) {
    issues.push(`${hostname}: missing from the control-plane inventory`);
    continue;
  }
  if (domain.sourceType !== "parking") issues.push(`${hostname}: source type is not parking`);
  if (domain.sourceStatus !== "available") issues.push(`${hostname}: source status is not available`);
  if ((domain.sourceLabels ?? []).some((label) => String(label).trim().toLowerCase() === "traffic2")) {
    issues.push(`${hostname}: Traffic2 label is present`);
  }
  if (domain.lifecycleStatus !== "published" || !domain.activeReleaseId) {
    issues.push(`${hostname}: no published active release`);
  }
}

const readiness = await Promise.all(expectedHostnames.map(async (hostname) => {
  try {
    const result = await readJson(`https://${hostname}/readyz`, { headers: { Accept: "application/json" } });
    const expectedReleaseId = inventoryByHostname.get(hostname)?.activeReleaseId ?? null;
    const exact = result.response.status === 200
      && result.body?.ok === true
      && result.body?.state === "live"
      && result.body?.hostname === hostname
      && result.body?.releaseId === expectedReleaseId;
    if (!exact) issues.push(`${hostname}: public readiness does not match the active release`);
    return {
      hostname,
      status: result.response.status,
      exact,
      expectedReleaseId,
      observedReleaseId: typeof result.body?.releaseId === "string" ? result.body.releaseId : null,
    };
  } catch (error) {
    issues.push(`${hostname}: readiness request failed`);
    return { hostname, status: null, exact: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}));

for (const hostname of expectedHostnames) {
  const check = healthByHostname.get(hostname);
  if (!check) {
    issues.push(`${hostname}: no stored tenant health check`);
    continue;
  }
  if (!check.fresh || check.status !== "ready" || !check.releaseMatches) {
    issues.push(`${hostname}: stored tenant health is stale, failing, or release-mismatched`);
  }
  if (Number(check.expectedScheduledChecks ?? 0) > 0 && !check.reliable) {
    issues.push(`${hostname}: scheduled health reliability is below the required threshold`);
  }
}

const expectedSet = new Set(expectedHostnames);
const unexpectedPublished = domains
  .filter((domain) => domain.lifecycleStatus === "published" && !expectedSet.has(domain.hostname))
  .map((domain) => domain.hostname)
  .sort();
if (unexpectedPublished.length) issues.push(`Unexpected published domains: ${unexpectedPublished.join(", ")}`);

const operationalBlockers = new Set([
  "rollup_coverage",
  "tenant_readiness",
  "tenant_reliability",
  "telemetry_pipeline",
  "qualified_session_sampling",
]);
for (const blocker of overview.reviewBlockers ?? []) {
  if (operationalBlockers.has(blocker)) issues.push(`Evidence gate reports ${blocker}`);
}

if (!overview.currentDaySchedule) {
  issues.push("Current-day readiness schedule state is missing from the control-plane overview");
} else if (!overview.currentDaySchedule.healthy) {
  issues.push(`Current-day readiness schedule is out of contract: ${overview.currentDaySchedule.observedChecks} observed, ${overview.currentDaySchedule.requiredChecks} required, ${overview.currentDaySchedule.expectedChecks} expected, ${overview.currentDaySchedule.readyChecks} ready`);
}

const monetization = overview.monetization;
if (!monetization) {
  issues.push("Monetization state is missing from the control-plane overview");
} else {
  for (const [label, value] of Object.entries({
    "active offers": monetization.activeOffers,
    "active routing policies": monetization.activeRoutingPolicies,
    clicks: monetization.clicks,
    conversions: monetization.conversions,
    postbacks: monetization.postbacks,
  })) {
    if (Number(value ?? 0) !== 0) issues.push(`Measurement-only invariant violated: ${label}=${Number(value)}`);
  }
}

const report = {
  auditedAt: new Date().toISOString(),
  guard: issues.length ? "FAIL" : "PASS",
  pilot: {
    expectedHostnames,
    publishedDomains: domains.filter((domain) => domain.lifecycleStatus === "published").map((domain) => domain.hostname).sort(),
    readiness,
  },
  evidence: {
    telemetryStartDate: overview.telemetryStartDate,
    latestCompletedDate: overview.latestCompletedDate,
    observedFullDays: overview.observedFullDays,
    expectedFullDays: overview.expectedFullDays,
    rollupCoverageComplete: overview.rollupCoverageComplete,
    evidenceStatus: overview.evidenceStatus,
    reviewBlockers: overview.reviewBlockers,
    totals: overview.totals,
    health: overview.health,
    currentDaySchedule: overview.currentDaySchedule,
    sampling: overview.sampling,
    telemetry: overview.telemetry,
    monetization: overview.monetization,
    latestRun: overview.latestRun,
  },
  issues,
  notes: [
    "This audit uses only protected control-plane reads and /readyz; it does not create visitor views.",
    "observation_window and qualified_sessions are evidence outcomes, not operational failures.",
  ],
};

console.log(JSON.stringify(report, null, 2));
if (issues.length) process.exitCode = 2;
