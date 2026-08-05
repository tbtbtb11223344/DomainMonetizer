import { readFile } from "node:fs/promises";

const apiBase = "https://api.cloudflare.com/client/v4";

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

function sameNameservers(actual, expected) {
  const normalize = (values) => [...new Set((values ?? []).map((value) => String(value).trim().toLowerCase()))].sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

async function readJson(url, init) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const environment = await loadEnvironment();
const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
const apiToken = environment.CLOUDFLARE_API_TOKEN;
const operatorToken = environment.OPERATOR_API_TOKEN;
const accessClientId = environment.CF_ACCESS_CLIENT_ID;
const accessClientSecret = environment.CF_ACCESS_CLIENT_SECRET;
if (!accountId || !apiToken || !operatorToken) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and OPERATOR_API_TOKEN are required.");
}
if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
  throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be provided together.");
}

const seed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));
const controlUrl = (environment.CONTROL_URL || "https://admin.multibrands.net").replace(/\/$/u, "");
const controlHeaders = {
  Authorization: `Bearer ${operatorToken}`,
  "Content-Type": "application/json",
  ...(accessClientId ? {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  } : {}),
};
const stored = [];

for (const domain of seed.domains) {
  if (!domain.cloudflareZoneId || !Array.isArray(domain.assignedNameservers)) {
    throw new Error(`${domain.hostname}: approved Cloudflare zone metadata is missing from the pilot seed.`);
  }
  const query = new URLSearchParams({ "account.id": accountId, name: domain.hostname, status: "active" });
  const zoneResult = await readJson(`${apiBase}/zones?${query}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!zoneResult.response.ok || !zoneResult.body?.success || zoneResult.body.result?.length !== 1) {
    throw new Error(`${domain.hostname}: active Cloudflare zone lookup failed or was not unique.`);
  }
  const zone = zoneResult.body.result[0];
  if (zone.id !== domain.cloudflareZoneId || !sameNameservers(zone.name_servers, domain.assignedNameservers)) {
    throw new Error(`${domain.hostname}: live Cloudflare assignment differs from the approved pilot seed; no metadata was written.`);
  }

  const updateResult = await readJson(`${controlUrl}/api/domains/${encodeURIComponent(domain.hostname)}/cloudflare-zone`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ cloudflareZoneId: zone.id, assignedNameservers: zone.name_servers }),
  });
  if (!updateResult.response.ok || !updateResult.body?.domain) {
    throw new Error(`${domain.hostname}: DomainMonetizer metadata update failed (${updateResult.response.status}).`);
  }
  const updated = updateResult.body.domain;
  if (updated.cloudflareZoneId !== zone.id || !sameNameservers(updated.assignedNameservers, zone.name_servers) || !updated.nameserversVerifiedAt) {
    throw new Error(`${domain.hostname}: DomainMonetizer metadata readback did not match the live Cloudflare assignment.`);
  }
  stored.push({
    hostname: updated.hostname,
    cloudflareZoneId: updated.cloudflareZoneId,
    assignedNameservers: updated.assignedNameservers,
    nameserversVerifiedAt: updated.nameserversVerifiedAt,
  });
}

console.log(JSON.stringify({ synced: stored.length, domains: stored }, null, 2));
