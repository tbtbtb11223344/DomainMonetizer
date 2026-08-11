import { readFile } from "node:fs/promises";
import { evaluateMarketcallPilotContract } from "./marketcall_pilot_contract.mjs";
import { currentDayCanaryIssues, evidenceContractIssues, pilotDecision, rollupCoveragePending } from "./pilot_decision.mjs";

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

function nextUtcDate(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function readCurrentDayCanaries(environment, schedule, allowedDomainIds) {
  const required = Number(schedule?.requiredByNowPerDomain ?? 0);
  if (required === 0) return { checked: false, requiredByNowPerDomain: 0, rows: [] };
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error("Cloudflare Analytics credentials are unavailable");
  const dataset = environment.ANALYTICS_DATASET || "domain_monetizer_events";
  if (!/^[a-zA-Z0-9_]+$/u.test(dataset)) throw new Error("Analytics dataset name is invalid");
  const date = schedule.date;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("Current-day schedule date is invalid");
  const requestedDomainIds = [...new Set(allowedDomainIds ?? [])];
  const allowed = requestedDomainIds.filter((value) => typeof value === "string" && /^dom_[a-f0-9]+$/u.test(value));
  if (allowed.length === 0 || allowed.length !== requestedDomainIds.length) {
    throw new Error("Pilot canary scope is empty or contains invalid domain IDs");
  }
  const domainFilter = ` AND index1 IN (${allowed.map((value) => `'${value}'`).join(",")})`;
  const sql = `SELECT index1 AS domain_id, count(DISTINCT blob7) AS distinct_canaries, max(_sample_interval) AS max_sample_interval FROM ${dataset} WHERE timestamp >= toDateTime('${date} 00:00:00') AND timestamp < toDateTime('${nextUtcDate(date)} 00:00:00') AND blob1 = 'health_canary' AND blob8 = 'health_scheduled' AND blob7 != ''${domainFilter} GROUP BY index1`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/plain" },
    body: sql,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body?.data)) {
    throw new Error(`Current-day Analytics canary query failed (${response.status})`);
  }
  return {
    checked: true,
    requiredByNowPerDomain: required,
    rows: body.data.map((row) => ({
      domain_id: String(row.domain_id ?? ""),
      distinct_canaries: Number(row.distinct_canaries ?? 0),
      max_sample_interval: Number(row.max_sample_interval ?? 1),
    })),
  };
}

const environment = await loadEnvironment();
const baseUrl = (environment.CONTROL_URL || "https://admin.multibrands.net").replace(/\/$/u, "");
const pilotSeed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));
const marketcallPilot = JSON.parse(await readFile(new URL("./marketcall_pilot.json", import.meta.url), "utf8"));
const pilotCohort = "pilot-2026-08-05";
const expectedHostnames = pilotSeed.domains.map((domain) => domain.hostname).sort();
const expectedByHostname = new Map(pilotSeed.domains.map((domain) => [domain.hostname, domain]));
const headers = accessHeaders(environment);

const [domainsResult, overviewResult] = await Promise.all([
  readJson(`${baseUrl}/api/domains?limit=500&cohort=${encodeURIComponent(pilotCohort)}`, { headers }),
  readJson(`${baseUrl}/api/metrics/overview?cohort=${encodeURIComponent(pilotCohort)}`, { headers }),
]);

if (!domainsResult.response.ok || !Array.isArray(domainsResult.body?.domains)) {
  throw new Error(`Domain inventory unavailable (${domainsResult.response.status}).`);
}
if (!overviewResult.response.ok || !overviewResult.body) {
  throw new Error(`Metrics overview unavailable (${overviewResult.response.status}).`);
}

const domains = domainsResult.body.domains;
const overview = overviewResult.body;
const pilotDomainIds = new Set(domains.map((domain) => domain.id));
const inventoryByHostname = new Map(domains.map((domain) => [domain.hostname, domain]));
const healthByHostname = new Map((overview.healthChecks ?? []).map((check) => [check.hostname, check]));
const issues = [];
const pendingRollupCoverage = rollupCoveragePending({
  now: new Date(),
  latestCompletedDate: overview.latestCompletedDate,
  observedFullDays: overview.observedFullDays,
  expectedFullDays: overview.expectedFullDays,
  latestRun: overview.latestRun,
});
if (pilotDomainIds.size !== domains.length || [...pilotDomainIds].some((value) => typeof value !== "string" || !/^dom_[a-f0-9]+$/u.test(value))) {
  issues.push("Pilot inventory returned missing, duplicate, or invalid domain IDs");
}

const decisionGradeWindowComplete = !overview.reviewBlockers?.includes("observation_window");
for (const hostname of expectedHostnames) {
  const domain = inventoryByHostname.get(hostname);
  const expected = expectedByHostname.get(hostname);
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
  if (domain.cloudflareZoneId !== expected.cloudflareZoneId) {
    issues.push(`${hostname}: stored Cloudflare zone ID does not match the approved assignment`);
  }
  const storedNameservers = [...new Set((domain.assignedNameservers ?? []).map((value) => String(value).toLowerCase()))].sort();
  const expectedNameservers = [...new Set((expected.assignedNameservers ?? []).map((value) => String(value).toLowerCase()))].sort();
  if (JSON.stringify(storedNameservers) !== JSON.stringify(expectedNameservers)) {
    issues.push(`${hostname}: stored assigned nameservers do not match the approved assignment`);
  }
  if (!domain.nameserversVerifiedAt || Number.isNaN(Date.parse(domain.nameserversVerifiedAt))) {
    issues.push(`${hostname}: Cloudflare nameserver verification timestamp is missing or invalid`);
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
  if (decisionGradeWindowComplete && Number(check.expectedScheduledChecks ?? 0) > 0 && !check.reliable) {
    issues.push(`${hostname}: scheduled health reliability is below the required threshold`);
  }
}

const expectedSet = new Set(expectedHostnames);
const unexpectedPublished = domains
  .filter((domain) => domain.lifecycleStatus === "published" && !expectedSet.has(domain.hostname))
  .map((domain) => domain.hostname)
  .sort();
if (unexpectedPublished.length) issues.push(`Unexpected published domains: ${unexpectedPublished.join(", ")}`);

issues.push(...evidenceContractIssues({
  evidenceStatus: overview.evidenceStatus,
  reviewBlockers: overview.reviewBlockers,
  pendingRollupCoverage,
}));

if (!overview.currentDaySchedule) {
  issues.push("Current-day readiness schedule state is missing from the control-plane overview");
} else if (!overview.currentDaySchedule.healthy) {
  issues.push(`Current-day readiness schedule is out of contract: ${overview.currentDaySchedule.observedChecks} observed, ${overview.currentDaySchedule.requiredChecks} required, ${overview.currentDaySchedule.expectedChecks} expected, ${overview.currentDaySchedule.readyChecks} ready`);
}

let currentDayCanaries = { checked: false, requiredByNowPerDomain: 0, rows: [] };
try {
  currentDayCanaries = await readCurrentDayCanaries(environment, overview.currentDaySchedule, pilotDomainIds);
  issues.push(...currentDayCanaryIssues({ schedule: overview.currentDaySchedule, rows: currentDayCanaries.rows, allowedDomainIds: pilotDomainIds }));
} catch (error) {
  issues.push(error instanceof Error ? error.message : "Current-day Analytics canary query failed");
}

issues.push(...evaluateMarketcallPilotContract(overview.monetization, marketcallPilot));

const report = {
  auditedAt: new Date().toISOString(),
  guard: issues.length ? "FAIL" : "PASS",
  pilot: {
    cohortKey: pilotCohort,
    expectedHostnames,
    publishedDomains: domains.filter((domain) => domain.lifecycleStatus === "published").map((domain) => domain.hostname).sort(),
    readiness,
  },
  evidence: {
    telemetryStartDate: overview.telemetryStartDate,
    exactSessionStartDate: overview.exactSessionStartDate,
    latestCompletedDate: overview.latestCompletedDate,
    observedFullDays: overview.observedFullDays,
    decisionGradeDays: overview.decisionGradeDays,
    expectedFullDays: overview.expectedFullDays,
    rollupCoverageComplete: overview.rollupCoverageComplete,
    pendingScheduledRollup: pendingRollupCoverage,
    evidenceStatus: overview.evidenceStatus,
    reviewBlockers: overview.reviewBlockers,
    totals: overview.totals,
    domainTotals: overview.domains,
    health: overview.health,
    currentDaySchedule: overview.currentDaySchedule,
    currentDayCanaries,
    sampling: overview.sampling,
    telemetry: overview.telemetry,
    monetization: overview.monetization,
    latestRun: overview.latestRun,
  },
  decision: pilotDecision({ guard: issues.length ? "FAIL" : "PASS", evidenceStatus: overview.evidenceStatus }),
  issues,
  notes: [
    "This audit uses only protected control-plane reads and /readyz; it does not create visitor views.",
    "observation_window and qualified_sessions are evidence outcomes, not operational failures.",
    "The economic-pilot guard requires the exact approved Marketcall campaign placements and rejects failed or rejected provider postbacks.",
    ...(pendingRollupCoverage ? ["The one-day coverage gap is expected before the 04:17 UTC rollup and its ten-minute grace deadline."] : []),
  ],
};

console.log(JSON.stringify(report, null, 2));
if (issues.length) process.exitCode = 2;
