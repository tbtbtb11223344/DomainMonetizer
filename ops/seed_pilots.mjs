import { readFile } from "node:fs/promises";

const baseUrl = (process.env.CONTROL_URL || "https://admin.multibrands.net").replace(/\/$/, "");
const token = process.env.OPERATOR_API_TOKEN;
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!token) throw new Error("OPERATOR_API_TOKEN is required");
if (Boolean(accessClientId) !== Boolean(accessClientSecret)) throw new Error("Both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required together");

const seed = JSON.parse(await readFile(new URL("./pilot_seed.json", import.meta.url), "utf8"));

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

const results = [];
for (const domain of seed.domains) {
  const hostname = domain.hostname;
  const created = await call(`/api/domains/${hostname}/content`, {
    method: "POST",
    body: JSON.stringify({ content: seed.content[hostname], provenance: "manual" }),
  });
  await call(`/api/content/${created.id}/approve`, { method: "POST", body: "{}" });
  const published = await call(`/api/domains/${hostname}/publish`, { method: "POST", body: "{}" });
  results.push({ hostname, contentId: created.id, releaseId: published.releaseId });
}

const preview = await call(`/api/domains/${seed.domains[0].hostname}/preview-deploy`, { method: "POST", body: "{}" });
console.log(JSON.stringify({ imported: seed.domains.length, published: results, preview }, null, 2));
