import { readFile } from "node:fs/promises";

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

async function loadEnvironment() {
  let fileValues = {};
  try { fileValues = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return { ...fileValues, ...process.env };
}

const environment = await loadEnvironment();
const baseUrl = (environment.CONTROL_URL || "https://admin.multibrands.net").replace(/\/$/u, "");
if (!environment.OPERATOR_API_TOKEN) throw new Error("OPERATOR_API_TOKEN is required in the environment or .env.");
const headers = { Authorization: `Bearer ${environment.OPERATOR_API_TOKEN}` };
if (environment.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = environment.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = environment.CF_ACCESS_CLIENT_SECRET;
}
const seed = JSON.parse(await readFile(new URL("./expansion_seed.json", import.meta.url), "utf8"));
const response = await fetch(`${baseUrl}/api/domains?limit=500&cohort=${encodeURIComponent(seed.cohortKey)}`, { headers, signal: AbortSignal.timeout(15_000) });
const body = await response.json().catch(() => null);
if (!response.ok || !Array.isArray(body?.domains)) throw new Error(`Expansion inventory unavailable (${response.status}).`);

const expectedByHostname = new Map(seed.domains.map((domain) => [domain.hostname, domain]));
const actualByHostname = new Map(body.domains.map((domain) => [domain.hostname, domain]));
const issues = [];
for (const [hostname, expected] of expectedByHostname) {
  const actual = actualByHostname.get(hostname);
  if (!actual) { issues.push(`${hostname}: missing from expansion cohort`); continue; }
  if (actual.cohortKey !== seed.cohortKey) issues.push(`${hostname}: wrong cohort key`);
  if (actual.sourceType !== "parking" || actual.sourceStatus !== "available") issues.push(`${hostname}: source eligibility changed`);
  if ((actual.sourceLabels ?? []).some((label) => String(label).toLowerCase() === "traffic2")) issues.push(`${hostname}: Traffic2 label is present`);
  if (actual.vertical !== expected.vertical) issues.push(`${hostname}: vertical mismatch`);
  if (actual.country !== expected.country) issues.push(`${hostname}: country mismatch`);
  if (JSON.stringify(actual.aiCategories ?? []) !== JSON.stringify(expected.aiCategories)) issues.push(`${hostname}: AI categories mismatch`);
  if ((actual.localEvidence ?? []).length < 2) issues.push(`${hostname}: fewer than two local-directory evidence rows`);
  if (!actual.trafficProfile || Number(actual.trafficProfile.coveredDays ?? 0) < 10) issues.push(`${hostname}: traffic profile is incomplete`);
}
const unexpected = body.domains.filter((domain) => !expectedByHostname.has(domain.hostname)).map((domain) => domain.hostname).sort();
if (unexpected.length) issues.push(`Unexpected expansion domains: ${unexpected.join(", ")}`);
const report = { auditedAt: new Date().toISOString(), guard: issues.length ? "FAIL" : "PASS", cohort: seed.cohortKey, expectedHostnames: [...expectedByHostname.keys()].sort(), domains: body.domains.map((domain) => ({ hostname: domain.hostname, lifecycleStatus: domain.lifecycleStatus, cohortKey: domain.cohortKey })).sort((a, b) => a.hostname.localeCompare(b.hostname)), issues };
console.log(JSON.stringify(report, null, 2));
if (issues.length) process.exitCode = 1;
