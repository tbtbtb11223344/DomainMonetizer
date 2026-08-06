import { readFile } from "node:fs/promises";

const baseUrl = (process.env.CONTROL_URL || "https://admin.multibrands.net").replace(/\/$/, "");
const token = process.env.OPERATOR_API_TOKEN;
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const publish = process.argv.includes("--publish");
const activate = process.argv.includes("--activate-cohort");
if (!token) throw new Error("OPERATOR_API_TOKEN is required");
if (Boolean(accessClientId) !== Boolean(accessClientSecret)) throw new Error("Both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required together");

const seed = JSON.parse(await readFile(new URL("./expansion_seed.json", import.meta.url), "utf8"));

async function call(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(accessClientId ? { "CF-Access-Client-Id": accessClientId, "CF-Access-Client-Secret": accessClientSecret } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

await call("/api/domains/import", { method: "POST", body: JSON.stringify({ domains: seed.domains }) });
if (publish) {
  const inventory = await call(`/api/domains?limit=500&cohort=${encodeURIComponent(seed.cohortKey)}`);
  const byHostname = new Map((inventory.domains ?? []).map((domain) => [domain.hostname, domain]));
  const missingAssignments = seed.domains
    .map((domain) => byHostname.get(domain.hostname))
    .filter((domain) => !domain?.cloudflareZoneId || !Array.isArray(domain.assignedNameservers) || domain.assignedNameservers.length !== 2 || !domain.nameserversVerifiedAt)
    .map((domain) => domain?.hostname ?? "unknown");
  if (missingAssignments.length) throw new Error(`Refusing to publish without verified Cloudflare assignments: ${missingAssignments.join(", ")}`);
}
const results = [];
for (const domain of seed.domains) {
  const hostname = domain.hostname;
  const created = await call(`/api/domains/${hostname}/content`, {
    method: "POST",
    body: JSON.stringify({ content: seed.content[hostname], provenance: "manual" }),
  });
  await call(`/api/content/${created.id}/approve`, { method: "POST", body: "{}" });
  if (publish) {
    const published = await call(`/api/domains/${hostname}/publish`, { method: "POST", body: "{}" });
    results.push({ hostname, contentId: created.id, releaseId: published.releaseId, lifecycle: "published" });
  } else {
    results.push({ hostname, contentId: created.id, lifecycle: "ready" });
  }
}
if (publish && activate) await call(`/api/cohorts/${encodeURIComponent(seed.cohortKey)}/activate`, { method: "POST", body: "{}" });
console.log(JSON.stringify({ imported: seed.domains.length, cohort: seed.cohortKey, publish, activate: publish && activate, results }, null, 2));
