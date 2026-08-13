import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { planMarketcallActivations } from "./marketcall_activation_plan.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const argumentsSet = new Set(process.argv.slice(2).filter((argument) => argument !== "--"));
const apply = argumentsSet.delete("--apply");
if (argumentsSet.size) throw new Error(`Unknown argument: ${[...argumentsSet].join(", ")}`);

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/gu)) {
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
  if (value === null || value === undefined) return "NULL";
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
    maxBuffer: 8 * 1024 * 1024,
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
  const response = await fetch(`https://admin.multibrands.net${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${environment.OPERATOR_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(environment.CF_ACCESS_CLIENT_ID ? {
        "CF-Access-Client-Id": environment.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": environment.CF_ACCESS_CLIENT_SECRET,
      } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status})`);
  return body;
}

async function marketcall(environment, path) {
  const response = await fetch(`https://www.marketcall.com/api/v1/affiliate${path}`, {
    headers: { Accept: "application/json", "X-Api-Key": environment.MARKETCALL_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) throw new Error(`Marketcall ${path} failed (${response.status})`);
  return body.data;
}

function contentBlockers(placement, row) {
  const blockers = [];
  let content;
  try {
    content = JSON.parse(row?.content_json ?? "null");
  } catch {
    return ["approved_content_invalid"];
  }
  if (!content || typeof content !== "object") return ["approved_content_missing"];
  const disclosure = String(content.disclosure ?? "").toLowerCase();
  if (!disclosure.includes("independent") || !disclosure.includes("may receive compensation")) blockers.push("affiliate_disclosure_missing");
  const guard = placement.contentGuard;
  if (guard?.ctaLabel && content.cta?.label !== guard.ctaLabel) blockers.push("offer_scope_cta_mismatch");
  const searchable = JSON.stringify({ ...content, image: { alt: content.image?.alt } }).toLowerCase();
  for (const phrase of guard?.requiredPhrases ?? []) {
    if (!searchable.includes(String(phrase).toLowerCase())) blockers.push(`offer_scope_missing:${phrase}`);
  }
  for (const phrase of guard?.forbiddenPhrases ?? []) {
    if (searchable.includes(String(phrase).toLowerCase())) blockers.push(`offer_scope_forbidden:${phrase}`);
  }
  return blockers;
}

function normalizedPhone(value) {
  const digits = String(value ?? "").replace(/\D/gu, "");
  return digits ? `+${digits}` : "";
}

function unique(values) {
  return [...new Set(values)];
}

const environment = await loadEnvironment();
for (const key of ["MARKETCALL_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
  if (!environment[key]) throw new Error(`${key} is required`);
}
if (Boolean(environment.CF_ACCESS_CLIENT_ID) !== Boolean(environment.CF_ACCESS_CLIENT_SECRET)) {
  throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be provided together");
}
if (apply && !environment.OPERATOR_API_TOKEN) throw new Error("OPERATOR_API_TOKEN is required for activation");

const applications = JSON.parse(await readFile(new URL("./marketcall_expansion_applications.json", import.meta.url), "utf8"));
const postbacks = JSON.parse(await readFile(new URL("./marketcall_postbacks.json", import.meta.url), "utf8"));
const scopeContent = JSON.parse(await readFile(new URL("./marketcall_scope_content.json", import.meta.url), "utf8"));
const plan = planMarketcallActivations(applications, postbacks);
const asOf = Date.parse(applications.asOf);
const ledgerFresh = Number.isFinite(asOf) && Date.now() - asOf <= 72 * 60 * 60 * 1000;
const campaignChecks = new Map();

for (const campaign of plan.campaigns) {
  const blockers = [];
  let offerState = null;
  let programState = null;
  try {
    const [offer, program] = await Promise.all([
      marketcall(environment, `/offers/${campaign.offerExternalId}`),
      marketcall(environment, `/programs/${campaign.campaignExternalId}`),
    ]);
    offerState = offer.state ?? null;
    programState = program.status ?? null;
    if (offer.state !== "Active") blockers.push("provider_offer_not_active");
    if (offer.country?.code !== "US") blockers.push("provider_offer_not_us");
    if (!Array.isArray(offer.programs) || !offer.programs.map(String).includes(campaign.campaignExternalId)) blockers.push("provider_campaign_not_attached");
    if (Number(program.status) !== 6) blockers.push("provider_campaign_not_approved");
    if (String(program.offer_id) !== campaign.offerExternalId) blockers.push("provider_campaign_offer_mismatch");
    if (normalizedPhone(program.phone) !== campaign.did) blockers.push("provider_did_mismatch");
    if (JSON.stringify((program.sources ?? []).map((source) => source.title)) !== JSON.stringify(["SEO"])) blockers.push("provider_traffic_source_not_seo_only");
  } catch (error) {
    blockers.push(`provider_read_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  campaignChecks.set(campaign.campaignExternalId, { blockers, offerState, programState });
}

const hostnameSql = plan.placements.map((placement) => sqlLiteral(placement.hostname)).join(",");
const inventory = d1(environment, `SELECT d.id AS domain_id,d.hostname,d.vertical,d.country,d.lifecycle_status,d.active_release_id,(SELECT cv.id FROM content_versions cv WHERE cv.domain_id=d.id AND cv.status='approved' ORDER BY cv.version DESC LIMIT 1) AS approved_content_id,(SELECT cv.content_json FROM content_versions cv WHERE cv.domain_id=d.id AND cv.status='approved' ORDER BY cv.version DESC LIMIT 1) AS content_json,(SELECT rv.content_version_id FROM release_versions rv WHERE rv.id=d.active_release_id) AS active_content_id FROM domains d WHERE d.hostname IN (${hostnameSql}) ORDER BY d.hostname; SELECT o.id,o.external_id,o.status FROM offers o WHERE o.provider='marketcall'; SELECT ac.id,ac.external_id,ac.offer_id,ac.destination_type,ac.destination_value,ac.status FROM affiliate_campaigns ac WHERE ac.provider='marketcall'; SELECT rp.id,rp.domain_id,rp.offer_id,rp.campaign_id,rp.status FROM routing_policies rp WHERE rp.id LIKE 'route_marketcall_%'`);
const domainsByHostname = new Map((inventory[0]?.results ?? []).map((row) => [row.hostname, row]));
const offersByExternalId = new Map((inventory[1]?.results ?? []).map((row) => [String(row.external_id), row]));
const campaignsByExternalId = new Map((inventory[2]?.results ?? []).map((row) => [String(row.external_id), row]));
const routesById = new Map((inventory[3]?.results ?? []).map((row) => [row.id, row]));
const contentUpdates = [];

if (apply) {
  for (const placement of plan.placements) {
    const replacement = scopeContent[placement.hostname];
    const domain = domainsByHostname.get(placement.hostname);
    if (!replacement || !domain || contentBlockers(placement, domain).length === 0) continue;
    const replacementBlockers = contentBlockers(placement, { content_json: JSON.stringify(replacement) });
    if (replacementBlockers.length) throw new Error(`${placement.hostname}: committed scope content is invalid (${replacementBlockers.join(", ")})`);
    const created = await callControl(environment, `/api/domains/${encodeURIComponent(placement.hostname)}/content`, {
      method: "POST",
      body: JSON.stringify({ content: replacement, provenance: "codex" }),
    });
    await callControl(environment, `/api/content/${encodeURIComponent(created.id)}/approve`, { method: "POST", body: "{}" });
    domain.content_json = JSON.stringify(replacement);
    domain.approved_content_id = created.id;
    contentUpdates.push({ hostname: placement.hostname, contentId: created.id });
  }
}

let webhookHealthy = false;
try {
  const webhookHealth = await fetch("https://webhooks.multibrands.net/healthz", { signal: AbortSignal.timeout(15_000) });
  webhookHealthy = webhookHealth.ok;
} catch {
  webhookHealthy = false;
}

const placementStatus = plan.placements.map((placement) => {
  const blockers = [...placement.blockers];
  if (!ledgerFresh) blockers.push("application_ledger_stale");
  if (!webhookHealthy) blockers.push("webhook_unhealthy");
  blockers.push(...(campaignChecks.get(placement.campaignExternalId)?.blockers ?? ["provider_read_missing"]));
  const domain = domainsByHostname.get(placement.hostname);
  if (!domain) blockers.push("domain_missing");
  else {
    if (domain.country !== "US") blockers.push("domain_not_us");
    if (domain.lifecycle_status !== "published") blockers.push("domain_not_published");
    if (!domain.approved_content_id) blockers.push("approved_content_missing");
    blockers.push(...contentBlockers(placement, domain));
  }
  const existingOffer = offersByExternalId.get(placement.offerExternalId);
  if (existingOffer && existingOffer.id !== placement.offerId) blockers.push("offer_id_conflict");
  const existingCampaign = campaignsByExternalId.get(placement.campaignExternalId);
  if (existingCampaign && existingCampaign.id !== placement.campaignId) blockers.push("campaign_id_conflict");
  const route = routesById.get(placement.routingPolicyId);
  const alreadyActive = Boolean(domain && route
    && route.domain_id === domain.domain_id
    && route.offer_id === placement.offerId
    && route.campaign_id === placement.campaignId
    && route.status === "active"
    && existingOffer?.status === "active"
    && existingCampaign?.status === "active"
    && existingCampaign?.destination_type === "phone"
    && existingCampaign?.destination_value === placement.did);
  return {
    ...placement,
    blockers: unique(blockers),
    activationReady: blockers.length === 0,
    alreadyActive,
    needsPublish: Boolean(domain && domain.active_content_id !== domain.approved_content_id),
  };
});

if (!apply) {
  console.log(JSON.stringify({
    mode: "check",
    ledgerAsOf: applications.asOf,
    ledgerFresh,
    webhookHealthy,
    ready: placementStatus.filter((item) => item.activationReady).map((item) => item.hostname),
    active: placementStatus.filter((item) => item.alreadyActive).map((item) => item.hostname),
    blocked: placementStatus.filter((item) => !item.activationReady).map((item) => ({ hostname: item.hostname, blockers: item.blockers })),
    provider: plan.campaigns.map((campaign) => ({
      campaignId: campaign.campaignExternalId,
      offerId: campaign.offerExternalId,
      offerState: campaignChecks.get(campaign.campaignExternalId)?.offerState ?? null,
      programState: campaignChecks.get(campaign.campaignExternalId)?.programState ?? null,
    })),
  }, null, 2));
} else {
const providerReady = placementStatus.filter((placement) => placement.blockers.every((blocker) => blocker === "postbacks_not_verified"));
const ready = placementStatus.filter((placement) => placement.activationReady);
const mutations = ready.filter((placement) => !placement.alreadyActive);
const statements = [];
const now = new Date().toISOString();
const providerReadyByCampaign = Map.groupBy(providerReady, (placement) => placement.campaignExternalId);
const campaignSetupIds = new Set(providerReady
  .filter((placement) => !offersByExternalId.has(placement.offerExternalId) || !campaignsByExternalId.has(placement.campaignExternalId))
  .map((placement) => placement.campaignExternalId));

for (const [campaignExternalId, placements] of providerReadyByCampaign) {
  if (!campaignSetupIds.has(campaignExternalId)) continue;
  const placement = placements[0];
  const domain = domainsByHostname.get(placement.hostname);
  const campaign = plan.campaigns.find((item) => item.campaignExternalId === campaignExternalId);
  const metadata = {
    title: placement.offerTitle,
    traffic_source: "SEO",
    routing_ready: 1,
    provider_offer_state: "Active",
    activation_policy: "per_website",
  };
  const campaignMetadata = {
    title: placement.campaignTitle,
    traffic_source: "SEO",
    promo_materials: campaign.materials.map((material) => ({ id: String(material.materialId), hostname: material.hostname, state: material.materialState })),
    provider_campaign_state: "Approved",
    provider_promo_state: "Accepted",
    postbacks_verified: 1,
  };
  statements.push(
    `INSERT INTO offers (id,provider,external_id,vertical,country,destination_url,status,metadata_json,created_at,updated_at) VALUES (${sqlLiteral(placement.offerId)},'marketcall',${sqlLiteral(placement.offerExternalId)},${sqlLiteral(placement.offerVertical || String(domain.vertical).toLowerCase().replace(/[^a-z0-9]+/gu, "_"))},'US','','active',${sqlLiteral(JSON.stringify(metadata))},${sqlLiteral(now)},${sqlLiteral(now)}) ON CONFLICT(provider,external_id) DO UPDATE SET vertical=excluded.vertical,country='US',status='active',metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
    `INSERT INTO affiliate_campaigns (id,provider,external_id,offer_id,domain_id,destination_type,destination_value,status,metadata_json,submitted_at,approved_at,created_at,updated_at) VALUES (${sqlLiteral(placement.campaignId)},'marketcall',${sqlLiteral(placement.campaignExternalId)},${sqlLiteral(placement.offerId)},${sqlLiteral(domain.domain_id)},'phone',${sqlLiteral(placement.did)},'approved',${sqlLiteral(JSON.stringify(campaignMetadata))},${sqlLiteral(applications.asOf)},${sqlLiteral(applications.asOf)},${sqlLiteral(now)},${sqlLiteral(now)}) ON CONFLICT(provider,external_id) DO UPDATE SET offer_id=excluded.offer_id,domain_id=excluded.domain_id,destination_type='phone',destination_value=excluded.destination_value,status=CASE WHEN affiliate_campaigns.status='active' THEN 'active' ELSE 'approved' END,metadata_json=excluded.metadata_json,approved_at=COALESCE(affiliate_campaigns.approved_at,excluded.approved_at),updated_at=excluded.updated_at`,
  );
}

for (const placement of mutations) {
  const domain = domainsByHostname.get(placement.hostname);
  statements.push(
    `UPDATE offers SET status='active',updated_at=${sqlLiteral(now)} WHERE id=${sqlLiteral(placement.offerId)} AND provider='marketcall' AND external_id=${sqlLiteral(placement.offerExternalId)}`,
    `UPDATE affiliate_campaigns SET status='active',updated_at=${sqlLiteral(now)} WHERE id=${sqlLiteral(placement.campaignId)} AND provider='marketcall' AND external_id=${sqlLiteral(placement.campaignExternalId)} AND offer_id=${sqlLiteral(placement.offerId)}`,
    `UPDATE routing_policies SET status='paused',ends_at=${sqlLiteral(now)},updated_at=${sqlLiteral(now)} WHERE domain_id=${sqlLiteral(domain.domain_id)} AND status='active' AND id<>${sqlLiteral(placement.routingPolicyId)}`,
    `INSERT INTO routing_policies (id,domain_id,vertical,country,offer_id,priority,weight,status,starts_at,ends_at,created_at,updated_at,campaign_id) VALUES (${sqlLiteral(placement.routingPolicyId)},${sqlLiteral(domain.domain_id)},NULL,'US',${sqlLiteral(placement.offerId)},10,100,'active',${sqlLiteral(now)},NULL,${sqlLiteral(now)},${sqlLiteral(now)},${sqlLiteral(placement.campaignId)}) ON CONFLICT(id) DO UPDATE SET domain_id=excluded.domain_id,vertical=NULL,country='US',offer_id=excluded.offer_id,priority=10,weight=100,status='active',starts_at=COALESCE(routing_policies.starts_at,excluded.starts_at),ends_at=NULL,updated_at=excluded.updated_at,campaign_id=excluded.campaign_id`,
  );
}

if (statements.length) {
  const auditId = `audit_${randomBytes(16).toString("hex")}`;
  statements.push(`INSERT INTO audit_log (id,actor,action,entity_type,entity_id,request_id,before_json,after_json,occurred_at) VALUES (${sqlLiteral(auditId)},'codex-cli','marketcall.sync_activations','portfolio','marketcall-expansion',NULL,NULL,${sqlLiteral(JSON.stringify({ activated: mutations.map(({ hostname, offerExternalId, campaignExternalId, materialExternalId }) => ({ hostname, offerExternalId, campaignExternalId, materialExternalId })), policy: "per_website" }))},${sqlLiteral(now)})`);
  runWrangler(environment, ["d1", "time-travel", "info", "domain-monetizer", "--config", "apps/control/wrangler.jsonc"]);
  d1(environment, `${statements.join(";")};`);
}

const publishTargets = ready.filter((placement) => !placement.alreadyActive || placement.needsPublish);
const releases = [];
for (const placement of publishTargets) {
  const published = await callControl(environment, `/api/domains/${encodeURIComponent(placement.hostname)}/publish`, { method: "POST", body: "{}" });
  releases.push({ hostname: placement.hostname, releaseId: published.releaseId });
}

const verification = d1(environment, `SELECT d.hostname,d.active_release_id,o.provider,o.external_id AS offer_external_id,o.status AS offer_status,ac.external_id AS campaign_external_id,ac.destination_type,ac.destination_value,ac.status AS campaign_status,rp.id AS routing_policy_id,rp.status AS routing_status,rv.content_version_id,rv.snapshot_json FROM routing_policies rp JOIN domains d ON d.id=rp.domain_id JOIN offers o ON o.id=rp.offer_id JOIN affiliate_campaigns ac ON ac.id=rp.campaign_id LEFT JOIN release_versions rv ON rv.id=d.active_release_id WHERE d.hostname IN (${hostnameSql}) ORDER BY d.hostname`);
const verifiedByHostname = new Map((verification[0]?.results ?? []).map((row) => [row.hostname, row]));
const verificationIssues = [];
for (const placement of ready) {
  const row = verifiedByHostname.get(placement.hostname);
  if (!row
    || row.provider !== "marketcall"
    || String(row.offer_external_id) !== placement.offerExternalId
    || String(row.campaign_external_id) !== placement.campaignExternalId
    || row.destination_type !== "phone"
    || row.destination_value !== placement.did
    || row.offer_status !== "active"
    || row.campaign_status !== "active"
    || row.routing_status !== "active") {
    verificationIssues.push(`${placement.hostname}: D1 activation readback mismatch`);
    continue;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch {
    verificationIssues.push(`${placement.hostname}: published snapshot is invalid`);
    continue;
  }
  const offerSlotEnabled = Array.isArray(snapshot?.offerSlots)
    && snapshot.offerSlots.some((slot) => slot?.slot === "primary" && slot?.enabled === true);
  const callPathPublished = typeof snapshot?.html === "string"
    && snapshot.html.includes('href="/go/primary"')
    && snapshot.html.includes('data-offer="enabled"');
  if (!offerSlotEnabled || !callPathPublished || snapshot?.state !== "live") {
    verificationIssues.push(`${placement.hostname}: published call CTA readback mismatch`);
  }
}

const readiness = [];
for (const placement of ready) {
  try {
    const response = await fetch(`https://${placement.hostname}/readyz`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null);
    const row = verifiedByHostname.get(placement.hostname);
    const exact = response.status === 200 && body?.ok === true && body?.state === "live" && body?.hostname === placement.hostname && body?.releaseId === row?.active_release_id;
    readiness.push({ hostname: placement.hostname, exact, releaseId: body?.releaseId ?? null });
    if (!exact) verificationIssues.push(`${placement.hostname}: live readiness mismatch`);
  } catch (error) {
    readiness.push({ hostname: placement.hostname, exact: false, releaseId: null });
    verificationIssues.push(`${placement.hostname}: live readiness failed (${error instanceof Error ? error.message : String(error)})`);
  }
}
if (verificationIssues.length) throw new Error(`Marketcall activation verification failed: ${verificationIssues.join("; ")}`);

console.log(JSON.stringify({
  mode: statements.length || releases.length || contentUpdates.length ? "applied" : "no_op",
  campaignsPrepared: [...campaignSetupIds],
  activated: mutations.map((placement) => placement.hostname),
  published: releases,
  contentUpdated: contentUpdates,
  ready: ready.map((placement) => placement.hostname),
  pending: placementStatus.filter((placement) => !placement.activationReady).map((placement) => ({ hostname: placement.hostname, blockers: placement.blockers })),
  readiness,
}, null, 2));
}
