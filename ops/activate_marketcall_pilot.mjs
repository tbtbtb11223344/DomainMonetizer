import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateMarketcallPilotContract } from "./marketcall_pilot_contract.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const argumentsSet = new Set(process.argv.slice(2).filter((argument) => argument !== "--"));
const apply = argumentsSet.has("--apply");
const postbacksConfigured = argumentsSet.has("--postbacks-configured");
for (const argument of argumentsSet) {
  if (argument !== "--apply" && argument !== "--postbacks-configured") throw new Error(`Unknown argument: ${argument}`);
}
if (apply && !postbacksConfigured) throw new Error("--apply requires --postbacks-configured after provider readback");

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
  try {
    fileValues = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...fileValues, ...process.env };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runWrangler(environment, argumentsList) {
  const result = spawnSync(process.execPath, [wranglerBin, ...argumentsList], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: environment.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_API_TOKEN,
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Wrangler exited ${result.status}`);
  return result.stdout;
}

function d1(environment, sql) {
  const output = runWrangler(environment, [
    "d1", "execute", "domain-monetizer", "--remote", "--config", "apps/control/wrangler.jsonc", "--command", sql, "--json",
  ]);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.some((result) => result.success !== true)) throw new Error("D1 command did not complete successfully");
  return parsed;
}

async function callControl(environment, path, init = {}) {
  const headers = {
    Authorization: `Bearer ${environment.OPERATOR_API_TOKEN}`,
    "Content-Type": "application/json",
    ...(environment.CF_ACCESS_CLIENT_ID ? {
      "CF-Access-Client-Id": environment.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": environment.CF_ACCESS_CLIENT_SECRET,
    } : {}),
  };
  const response = await fetch(`https://admin.multibrands.net${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status})`);
  return body;
}

const environment = await loadEnvironment();
if (!environment.MARKETCALL_API_KEY) throw new Error("MARKETCALL_API_KEY is required");
if (Boolean(environment.CF_ACCESS_CLIENT_ID) !== Boolean(environment.CF_ACCESS_CLIENT_SECRET)) {
  throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be provided together");
}
const spec = JSON.parse(await readFile(new URL("./marketcall_pilot.json", import.meta.url), "utf8"));
const campaignsById = new Map(spec.campaigns.map((campaign) => [campaign.campaignId, campaign]));
const placements = [
  ...spec.campaigns.map((campaign) => ({
    hostname: campaign.hostname,
    campaignId: campaign.campaignId,
    routingPolicyId: campaign.routingPolicyId,
    expectedDomainVertical: null,
  })),
  ...spec.placements,
].map((placement) => {
  const campaign = campaignsById.get(placement.campaignId);
  if (!campaign) throw new Error(`${placement.hostname}: committed placement references an unknown campaign`);
  return { ...placement, campaign };
});
if (new Set(placements.map((placement) => placement.hostname)).size !== placements.length) {
  throw new Error("Committed Marketcall placements contain a duplicate hostname");
}
const providerChecks = [];
for (const campaign of spec.campaigns) {
  const response = await fetch(`https://www.marketcall.com/api/v1/affiliate/offers/${campaign.offerExternalId}`, {
    headers: { Accept: "application/json", "X-Api-Key": environment.MARKETCALL_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  const offer = body?.data;
  if (!response.ok || !offer) throw new Error(`Marketcall offer ${campaign.offerExternalId} is unavailable (${response.status})`);
  if (offer.state !== "Active") throw new Error(`Marketcall offer ${campaign.offerExternalId} is ${String(offer.state)}, not Active`);
  if (offer.country?.code !== "US") throw new Error(`Marketcall offer ${campaign.offerExternalId} is not a US offer`);
  if (!Array.isArray(offer.programs) || !offer.programs.map(String).includes(campaign.campaignExternalId)) {
    throw new Error(`Campaign ${campaign.campaignExternalId} is not attached to Marketcall offer ${campaign.offerExternalId}`);
  }
  providerChecks.push({
    hostname: campaign.hostname,
    offerExternalId: campaign.offerExternalId,
    campaignExternalId: campaign.campaignExternalId,
    offerState: offer.state,
  });
}

if (!apply) {
  console.log(JSON.stringify({ mode: "check", providerChecks, next: "Run with --apply --postbacks-configured only after the webhook and provider postbacks are verified." }, null, 2));
  process.exit(0);
}
for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "OPERATOR_API_TOKEN"]) {
  if (!environment[key]) throw new Error(`${key} is required for activation`);
}

const webhookHealth = await fetch("https://webhooks.multibrands.net/healthz", { signal: AbortSignal.timeout(15_000) });
if (!webhookHealth.ok) throw new Error(`Webhook hostname is not healthy (${webhookHealth.status})`);
const inventorySql = `SELECT d.hostname,o.id AS offer_id,o.external_id AS offer_external_id,o.status AS offer_status,ac.id AS campaign_id,ac.external_id AS campaign_external_id,ac.status AS campaign_status,ac.destination_type,ac.destination_value FROM domains d JOIN affiliate_campaigns ac ON ac.domain_id=d.id JOIN offers o ON o.id=ac.offer_id WHERE d.hostname IN (${spec.campaigns.map((campaign) => sqlLiteral(campaign.hostname)).join(",")}) ORDER BY d.hostname`;
const inventory = d1(environment, inventorySql)[0]?.results ?? [];
for (const campaign of spec.campaigns) {
  const row = inventory.find((item) => item.hostname === campaign.hostname
    && item.offer_id === campaign.offerId
    && item.campaign_id === campaign.campaignId
    && String(item.offer_external_id) === campaign.offerExternalId
    && String(item.campaign_external_id) === campaign.campaignExternalId);
  if (!row) throw new Error(`${campaign.hostname}: committed offer/campaign mapping is missing from D1`);
  if (row.destination_type !== "phone" || !/^\+[1-9]\d{7,14}$/u.test(String(row.destination_value ?? ""))) {
    throw new Error(`${campaign.hostname}: D1 campaign destination is not a valid E.164 phone number`);
  }
}
const placementInventorySql = `SELECT hostname,vertical,country,lifecycle_status FROM domains WHERE hostname IN (${placements.map((placement) => sqlLiteral(placement.hostname)).join(",")}) ORDER BY hostname`;
const placementInventory = d1(environment, placementInventorySql)[0]?.results ?? [];
for (const placement of placements) {
  const domain = placementInventory.find((row) => row.hostname === placement.hostname);
  if (!domain || domain.country !== "US" || domain.lifecycle_status !== "published") {
    throw new Error(`${placement.hostname}: placement target is not a published US domain`);
  }
  if (placement.expectedDomainVertical && domain.vertical !== placement.expectedDomainVertical) {
    throw new Error(`${placement.hostname}: domain vertical=${String(domain.vertical)}, expected ${placement.expectedDomainVertical}`);
  }
}

runWrangler(environment, ["d1", "time-travel", "info", "domain-monetizer", "--config", "apps/control/wrangler.jsonc"]);
const now = new Date().toISOString();
const auditId = `audit_${randomBytes(16).toString("hex")}`;
const statements = [];
for (const campaign of spec.campaigns) {
  statements.push(
    `UPDATE offers SET status='active',metadata_json=json_set(metadata_json,'$.routing_ready',1,'$.provider_offer_state','Active'),updated_at=${sqlLiteral(now)} WHERE id=${sqlLiteral(campaign.offerId)} AND provider='marketcall' AND external_id=${sqlLiteral(campaign.offerExternalId)}`,
    `UPDATE affiliate_campaigns SET status='active',metadata_json=json_set(metadata_json,'$.provider_campaign_state','Approved','$.provider_promo_state','Accepted'),approved_at=COALESCE(approved_at,${sqlLiteral(now)}),updated_at=${sqlLiteral(now)} WHERE id=${sqlLiteral(campaign.campaignId)} AND provider='marketcall' AND external_id=${sqlLiteral(campaign.campaignExternalId)} AND offer_id=${sqlLiteral(campaign.offerId)}`,
  );
}
for (const placement of placements) {
  const { campaign } = placement;
  statements.push(
    `INSERT INTO routing_policies (id,domain_id,vertical,country,offer_id,priority,weight,status,starts_at,ends_at,created_at,updated_at,campaign_id) SELECT ${sqlLiteral(placement.routingPolicyId)},d.id,NULL,'US',o.id,10,100,'active',${sqlLiteral(now)},NULL,${sqlLiteral(now)},${sqlLiteral(now)},ac.id FROM domains d JOIN offers o ON o.id=${sqlLiteral(campaign.offerId)} JOIN affiliate_campaigns ac ON ac.id=${sqlLiteral(campaign.campaignId)} AND ac.offer_id=o.id WHERE d.hostname=${sqlLiteral(placement.hostname)} ON CONFLICT(id) DO UPDATE SET domain_id=excluded.domain_id,vertical=NULL,country='US',offer_id=excluded.offer_id,priority=10,weight=100,status='active',starts_at=COALESCE(routing_policies.starts_at,excluded.starts_at),ends_at=NULL,updated_at=excluded.updated_at,campaign_id=excluded.campaign_id`,
  );
}
statements.push(`INSERT INTO audit_log (id,actor,action,entity_type,entity_id,request_id,before_json,after_json,occurred_at) VALUES (${sqlLiteral(auditId)},'codex-cli','marketcall_pilot.activate','portfolio','pilot-2026-08-05',NULL,NULL,${sqlLiteral(JSON.stringify({ mode: spec.mode, campaigns: spec.campaigns.map(({ hostname, offerExternalId, campaignExternalId }) => ({ hostname, offerExternalId, campaignExternalId })), placements: placements.map(({ hostname, campaign }) => ({ hostname, offerExternalId: campaign.offerExternalId, campaignExternalId: campaign.campaignExternalId })) }))},${sqlLiteral(now)})`);
d1(environment, `${statements.join(";")};`);

const releases = [];
for (const placement of placements) {
  const published = await callControl(environment, `/api/domains/${encodeURIComponent(placement.hostname)}/publish`, { method: "POST", body: "{}" });
  releases.push({ hostname: placement.hostname, releaseId: published.releaseId });
}

const verification = d1(environment, "SELECT d.hostname,o.provider,o.external_id AS offer_external_id,ac.external_id AS campaign_external_id,ac.destination_type,o.status AS offer_status,ac.status AS campaign_status,rp.status AS routing_status FROM routing_policies rp JOIN domains d ON d.id=rp.domain_id JOIN offers o ON o.id=rp.offer_id JOIN affiliate_campaigns ac ON ac.id=rp.campaign_id WHERE rp.status='active' ORDER BY d.hostname; SELECT (SELECT COUNT(*) FROM offers WHERE status='active') AS active_offers,(SELECT COUNT(*) FROM affiliate_campaigns WHERE status='active') AS active_campaigns,(SELECT COUNT(*) FROM routing_policies WHERE status='active') AS active_routing_policies,(SELECT COUNT(*) FROM clicks) AS clicks,(SELECT COUNT(*) FROM conversions) AS conversions,(SELECT COUNT(*) FROM postback_inbox) AS postbacks,(SELECT COUNT(*) FROM postback_inbox WHERE processing_status='failed') AS failed_postbacks,(SELECT COUNT(*) FROM postback_inbox WHERE processing_status='rejected') AS rejected_postbacks");
const activeRoutes = verification[0]?.results ?? [];
const counts = verification[1]?.results?.[0] ?? {};
const contractIssues = evaluateMarketcallPilotContract({
  mode: spec.mode,
  activeOffers: Number(counts.active_offers ?? 0),
  activeCampaigns: Number(counts.active_campaigns ?? 0),
  activeRoutingPolicies: Number(counts.active_routing_policies ?? 0),
  clicks: Number(counts.clicks ?? 0),
  conversions: Number(counts.conversions ?? 0),
  postbacks: Number(counts.postbacks ?? 0),
  failedPostbacks: Number(counts.failed_postbacks ?? 0),
  rejectedPostbacks: Number(counts.rejected_postbacks ?? 0),
  activeRoutes,
}, spec);
if (contractIssues.length) throw new Error(`Activated Marketcall routes failed D1 readback verification: ${contractIssues.join("; ")}`);
console.log(JSON.stringify({ mode: "applied", providerChecks, releases, activeRoutes }, null, 2));
