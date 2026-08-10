import {
  activePointerKey,
  compileHomeServicesHtml,
  cloudflareZoneMetadataSchema,
  contentMutationSchema,
  contentSchema,
  domainImportSchema,
  pausedHtml,
  randomId,
  releaseKey,
  releaseSnapshotSchema,
  sha256Hex,
  timingSafeEqualString,
  type DomainContent,
  type ReleaseSnapshot,
} from "@domain-monetizer/core";
import { Hono } from "hono";
import { z } from "zod";
import { auditStatement, nextVersion, nowIso } from "./db";
import { decideEvidence } from "./evidence";
import { checkPublishedTenants, SCHEDULED_HEALTH_CHECKS_PER_DAY, summarizeCurrentDaySchedule, summarizeTenantHealth, type HealthPortfolioDomain, type LatestTenantHealthRow, type ScheduledTenantHealthRow } from "./health";
import { completedUtcDayCount, latestCompletedUtcDate, rollupCoverageTarget, rollupDate } from "./metrics";
import type { ContentRow, DomainRow, Env, ReleaseRow, Variables } from "./types";

const HOME_SERVICES_TEMPLATE_VERSION_ID = "tpl-home-services-v2";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

interface OverviewDomainRow extends HealthPortfolioDomain {
  likely_human_views: number | string;
  unique_visitors: number | string;
  us_unique_visitors: number | string;
  sampled_unique_visitors: number | string;
  sampled_us_unique_visitors: number | string;
  sampled_unique_sample_interval: number | string;
  human_engaged_visits: number | string;
  max_sample_interval: number | string;
  unique_sample_interval: number | string;
}

interface MonetizationStateRow {
  active_offers: number | string;
  active_campaigns: number | string;
  active_routing_policies: number | string;
  clicks: number | string;
  conversions: number | string;
  postbacks: number | string;
}

function jsonValue<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function publicDomain(row: DomainRow): Record<string, unknown> {
  return {
    id: row.id,
    hostname: row.hostname,
    lifecycleStatus: row.lifecycle_status,
    registrar: row.registrar,
    sourceType: row.source_type,
    sourceStatus: row.source_status,
    sourceLabels: jsonValue(row.source_labels_json, []),
    vertical: row.vertical,
    country: row.country,
    locale: row.locale,
    aiSummary: row.ai_summary,
    aiKeywords: jsonValue(row.ai_keywords_json, []),
    aiCategories: jsonValue(row.ai_categories_json, []),
    localEvidence: jsonValue(row.local_evidence_json, []),
    trafficProfile: jsonValue(row.traffic_profile_json, {}),
    cohortKey: row.cohort_key,
    measurementStartedAt: row.measurement_started_at,
    traffic30dVisitors: row.traffic_30d_visitors,
    parking30dRevenueUsd: row.parking_30d_revenue_usd,
    trafficEvidenceAt: row.traffic_evidence_at,
    cloudflareZoneId: row.cloudflare_zone_id,
    assignedNameservers: jsonValue(row.assigned_nameservers_json, []),
    nameserversVerifiedAt: row.nameservers_verified_at,
    activeReleaseId: row.active_release_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function domainByHostname(db: D1Database, hostname: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM domains WHERE hostname = ?").bind(hostname.toLowerCase()).first<DomainRow>();
}

async function domainById(db: D1Database, id: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first<DomainRow>();
}

export async function switchActivePointer(
  kv: KVNamespace,
  hostname: string,
  nextReleaseId: string,
  previousReleaseId: string | null,
  commit: () => Promise<unknown>,
): Promise<void> {
  const pointerKey = activePointerKey(hostname);
  await kv.put(pointerKey, nextReleaseId);
  try {
    await commit();
  } catch (error) {
    try {
      if (previousReleaseId) await kv.put(pointerKey, previousReleaseId);
      else await kv.delete(pointerKey);
    } catch (recoveryError) {
      console.error(JSON.stringify({
        level: "error",
        task: "active_pointer_recovery",
        hostname,
        nextReleaseId,
        previousReleaseId,
        message: recoveryError instanceof Error ? recoveryError.message : "Unknown pointer recovery error",
      }));
    }
    throw error;
  }
}

function zodError(error: z.ZodError): Record<string, unknown> {
  return { error: "Validation failed", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
}

async function compileRelease(
  env: Env,
  actor: string,
  requestId: string,
  domain: DomainRow,
  contentRow: ContentRow,
  state: "live" | "paused" = "live",
  hostname = domain.hostname,
): Promise<ReleaseSnapshot> {
  const content = contentSchema.parse(JSON.parse(contentRow.content_json));
  const releaseId = randomId("rel");
  const enabledOffer = await env.DB.prepare(
    "SELECT 1 AS found FROM routing_policies rp JOIN offers o ON o.id=rp.offer_id LEFT JOIN affiliate_campaigns ac ON ac.id=rp.campaign_id AND ac.offer_id=o.id AND ac.domain_id=? WHERE rp.status='active' AND o.status='active' AND (rp.domain_id=? OR rp.domain_id IS NULL) AND (rp.vertical IS NULL OR rp.vertical=?) AND (rp.country IS NULL OR rp.country=?) AND (rp.starts_at IS NULL OR rp.starts_at<=?) AND (rp.ends_at IS NULL OR rp.ends_at>?) AND (rp.campaign_id IS NULL OR ac.status='active') AND (lower(o.provider)<>'marketcall' OR ac.status='active') LIMIT 1",
  )
    .bind(domain.id, domain.id, domain.vertical, domain.country, nowIso(), nowIso())
    .first<{ found: number }>();
  const offerEnabled = Boolean(enabledOffer);
  const html = state === "live" ? compileHomeServicesHtml({ content, hostname, releaseId, offerEnabled }) : pausedHtml(hostname);
  return releaseSnapshotSchema.parse({
    schemaVersion: 1,
    releaseId,
    domainId: domain.id,
    hostname,
    state,
    templateKey: "home-services",
    content,
    offerSlots: [{ slot: content.cta.slot, enabled: state === "live" && offerEnabled }],
    html,
    compiledAt: nowIso(),
    _audit: { actor, requestId },
  });
}

async function persistPublishedRelease(
  env: Env,
  actor: string,
  requestId: string,
  domain: DomainRow,
  contentRow: ContentRow,
  snapshot: ReleaseSnapshot,
  action: "publish" | "pause",
): Promise<void> {
  const releaseVersion = await nextVersion(env.DB, "release_versions", domain.id);
  const serialized = JSON.stringify(snapshot);
  const checksum = await sha256Hex(serialized);
  const timestamp = nowIso();
  await env.DB.prepare("INSERT INTO release_versions (id, domain_id, version, template_version_id, content_version_id, snapshot_json, snapshot_sha256, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'compiled', ?, ?)")
    .bind(snapshot.releaseId, domain.id, releaseVersion, HOME_SERVICES_TEMPLATE_VERSION_ID, contentRow.id, serialized, checksum, actor, timestamp)
    .run();
  await env.SITE_CONFIG.put(releaseKey(snapshot.releaseId), serialized);
  await switchActivePointer(env.SITE_CONFIG, domain.hostname, snapshot.releaseId, domain.active_release_id, () => env.DB.batch([
    env.DB.prepare("UPDATE release_versions SET status='superseded' WHERE domain_id=? AND status='published'").bind(domain.id),
    env.DB.prepare("UPDATE release_versions SET status='published', published_at=? WHERE id=?").bind(timestamp, snapshot.releaseId),
    env.DB.prepare("UPDATE domains SET active_release_id=?, lifecycle_status=?, updated_at=? WHERE id=?").bind(snapshot.releaseId, action === "pause" ? "paused" : "published", timestamp, domain.id),
    env.DB.prepare("INSERT INTO domain_deployments (id, domain_id, release_id, action, previous_release_id, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(randomId("deploy"), domain.id, snapshot.releaseId, action, domain.active_release_id, actor, timestamp),
    auditStatement(env.DB, { actor, action: `domain.${action}`, entityType: "domain", entityId: domain.id, requestId, before: { activeReleaseId: domain.active_release_id, status: domain.lifecycle_status }, after: { activeReleaseId: snapshot.releaseId, status: action === "pause" ? "paused" : "published" } }),
  ]));
}

export function mountApi(app: App): void {
  app.get("/api/domains", async (c) => {
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const status = (c.req.query("status") ?? "").trim();
    const cohort = (c.req.query("cohort") ?? "").trim();
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (search) { clauses.push("(hostname LIKE ? OR vertical LIKE ?)"); values.push(`%${search}%`, `%${search}%`); }
    if (status) { clauses.push("lifecycle_status = ?"); values.push(status); }
    if (cohort) { clauses.push("cohort_key = ?"); values.push(cohort); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const result = await c.env.DB.prepare(`SELECT * FROM domains${where} ORDER BY COALESCE(traffic_30d_visitors, 0) DESC, hostname ASC LIMIT ?`).bind(...values, limit).all<DomainRow>();
    return c.json({ domains: result.results.map(publicDomain) });
  });

  app.get("/api/metrics/overview", async (c) => {
    const requestedCohort = (c.req.query("cohort") ?? "").trim();
    const cohort = requestedCohort
      ? await c.env.DB.prepare("SELECT key,label,telemetry_start_date,exact_session_start_date,minimum_review_days,minimum_qualified_sessions,status FROM measurement_cohorts WHERE key=?").bind(requestedCohort).first<{ key: string; label: string; telemetry_start_date: string; exact_session_start_date: string; minimum_review_days: number; minimum_qualified_sessions: number; status: string }>()
      : null;
    if (requestedCohort && !cohort) return c.json({ error: "Cohort not found" }, 404);
    const telemetryStartDate = cohort?.telemetry_start_date || (c.env.TELEMETRY_MIN_DATE && /^\d{4}-\d{2}-\d{2}$/.test(c.env.TELEMETRY_MIN_DATE)
      ? c.env.TELEMETRY_MIN_DATE
      : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    const exactSessionStartDate = cohort?.exact_session_start_date || (c.env.EXACT_SESSION_MIN_DATE && /^\d{4}-\d{2}-\d{2}$/.test(c.env.EXACT_SESSION_MIN_DATE)
      ? c.env.EXACT_SESSION_MIN_DATE
      : telemetryStartDate);
    const minimumReviewDays = Number(cohort?.minimum_review_days ?? 14);
    const minimumQualifiedSessions = Number(cohort?.minimum_qualified_sessions ?? 10);
    const coverageNow = new Date();
    const sampledDay = await c.env.DB.prepare("SELECT MAX(metric_date) AS metric_date FROM analytics_rollup_runs WHERE status='succeeded' AND metric_date>=? AND metric_date<?")
      .bind(telemetryStartDate, exactSessionStartDate)
      .first<{ metric_date: string | null }>();
    const sampledMetricDate = sampledDay?.metric_date ?? null;
    const domainWhere = requestedCohort ? " WHERE d.cohort_key=?" : "";
    const domainBinds = requestedCohort
      ? [exactSessionStartDate, exactSessionStartDate, sampledMetricDate, sampledMetricDate, sampledMetricDate, exactSessionStartDate, telemetryStartDate, requestedCohort]
      : [exactSessionStartDate, exactSessionStartDate, sampledMetricDate, sampledMetricDate, sampledMetricDate, exactSessionStartDate, telemetryStartDate];
    const [domains, latestRun, latestHealth, monetizationState] = await Promise.all([
      c.env.DB.prepare(
        `SELECT d.id AS domain_id, d.hostname, d.lifecycle_status, d.active_release_id, d.measurement_started_at, COUNT(m.metric_date) AS days_with_traffic, MIN(m.metric_date) AS first_metric_date, MAX(m.metric_date) AS last_metric_date, COALESCE(SUM(m.views),0) AS views, COALESCE(SUM(m.likely_human_views),0) AS likely_human_views, COALESCE(SUM(m.bot_views),0) AS bot_views, COALESCE(SUM(m.unknown_views),0) AS unknown_views, COALESCE(SUM(m.human_engaged_visits),0) AS human_engaged_visits, COALESCE(SUM(m.us_likely_human_views),0) AS us_likely_human_views, COALESCE(SUM(CASE WHEN m.metric_date>=? AND m.telemetry_version>=3 AND m.unique_sample_interval=1 THEN m.unique_visitors ELSE 0 END),0) AS unique_visitors, COALESCE(SUM(CASE WHEN m.metric_date>=? AND m.telemetry_version>=3 AND m.unique_sample_interval=1 THEN m.us_unique_visitors ELSE 0 END),0) AS us_unique_visitors, COALESCE(SUM(CASE WHEN m.metric_date=? THEN m.unique_visitors ELSE 0 END),0) AS sampled_unique_visitors, COALESCE(SUM(CASE WHEN m.metric_date=? THEN m.us_unique_visitors ELSE 0 END),0) AS sampled_us_unique_visitors, COALESCE(MAX(CASE WHEN m.metric_date=? THEN m.unique_sample_interval ELSE 1 END),1) AS sampled_unique_sample_interval, COALESCE(SUM(m.clicks),0) AS clicks, COALESCE(MAX(m.max_sample_interval),1) AS max_sample_interval, COALESCE(MAX(CASE WHEN m.metric_date>=? AND m.telemetry_version>=3 THEN m.unique_sample_interval ELSE 1 END),1) AS unique_sample_interval FROM domains d LEFT JOIN daily_domain_metrics m ON m.domain_id=d.id AND m.metric_date>=?${domainWhere} GROUP BY d.id,d.hostname,d.lifecycle_status,d.active_release_id,d.measurement_started_at ORDER BY d.hostname`,
      ).bind(...domainBinds).all<OverviewDomainRow>(),
      c.env.DB.prepare("SELECT id,metric_date,status,domain_rows,country_rows,source_rows,canary_rows,expected_canaries,observed_canaries,canary_sample_interval,telemetry_verified,max_sample_interval,unique_sample_interval,error_message,started_at,completed_at FROM analytics_rollup_runs ORDER BY started_at DESC LIMIT 1").first(),
      c.env.DB.prepare("SELECT h.domain_id,h.status,h.http_status,h.latency_ms,h.expected_release_id,h.observed_release_id,h.error_message,h.checked_at FROM tenant_health_checks h JOIN (SELECT domain_id,MAX(checked_at) AS checked_at FROM tenant_health_checks GROUP BY domain_id) latest ON latest.domain_id=h.domain_id AND latest.checked_at=h.checked_at").all<LatestTenantHealthRow>(),
      c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM offers WHERE status='active') AS active_offers,(SELECT COUNT(*) FROM affiliate_campaigns WHERE status='active') AS active_campaigns,(SELECT COUNT(*) FROM routing_policies WHERE status='active') AS active_routing_policies,(SELECT COUNT(*) FROM clicks) AS clicks,(SELECT COUNT(*) FROM conversions) AS conversions,(SELECT COUNT(*) FROM postback_inbox) AS postbacks").first<MonetizationStateRow>(),
    ]);
    const latestCompletedDate = latestCompletedUtcDate(coverageNow);
    const coverage = await c.env.DB.prepare("SELECT MAX(metric_date) AS metric_date,COUNT(DISTINCT metric_date) AS successful_days,COUNT(DISTINCT CASE WHEN telemetry_verified=1 THEN metric_date END) AS telemetry_verified_days,COUNT(DISTINCT CASE WHEN metric_date>=? AND unique_sample_interval=1 THEN metric_date END) AS exact_session_days,COUNT(DISTINCT CASE WHEN metric_date>=? AND unique_sample_interval=1 AND telemetry_verified=1 THEN metric_date END) AS decision_grade_days FROM analytics_rollup_runs WHERE status='succeeded' AND metric_date>=? AND metric_date<=?")
      .bind(exactSessionStartDate, exactSessionStartDate, telemetryStartDate, latestCompletedDate)
      .first<{ metric_date: string | null; successful_days: number; telemetry_verified_days: number; exact_session_days: number; decision_grade_days: number }>();
    const through = coverage?.metric_date ?? null;
    const observedFullDays = Number(coverage?.successful_days ?? 0);
    const coverageTarget = rollupCoverageTarget(telemetryStartDate, observedFullDays, through, coverageNow);
    const expectedDays = coverageTarget.expectedFullDays;
    const rollupCoverageComplete = coverageTarget.complete;
    const telemetryVerifiedDays = Number(coverage?.telemetry_verified_days ?? 0);
    const exactSessionDays = Number(coverage?.exact_session_days ?? 0);
    const qualifiedSessionKpiAvailable = exactSessionDays > 0;
    const decisionGradeDays = Number(coverage?.decision_grade_days ?? 0);
    const telemetryPipelineVerified = telemetryVerifiedDays >= minimumReviewDays;
    const healthWindowEnd = new Date(`${latestCompletedDate}T00:00:00.000Z`);
    healthWindowEnd.setUTCDate(healthWindowEnd.getUTCDate() + 1);
    const scheduledHealth = expectedDays > 0
      ? await c.env.DB.prepare("SELECT domain_id,COUNT(*) AS scheduled_checks,SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready_scheduled_checks FROM tenant_health_checks WHERE check_source='scheduled' AND checked_at>=? AND checked_at<? GROUP BY domain_id")
        .bind(`${telemetryStartDate}T00:00:00.000Z`, healthWindowEnd.toISOString()).all<ScheduledTenantHealthRow>()
      : { results: [] as ScheduledTenantHealthRow[] };
    const currentDate = coverageNow.toISOString().slice(0, 10);
    const currentDayEnd = new Date(`${currentDate}T00:00:00.000Z`);
    currentDayEnd.setUTCDate(currentDayEnd.getUTCDate() + 1);
    const currentDayScheduledHealth = currentDate >= telemetryStartDate
      ? await c.env.DB.prepare("SELECT domain_id,COUNT(*) AS scheduled_checks,SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready_scheduled_checks FROM tenant_health_checks WHERE check_source='scheduled' AND checked_at>=? AND checked_at<? GROUP BY domain_id")
        .bind(`${currentDate}T00:00:00.000Z`, currentDayEnd.toISOString()).all<ScheduledTenantHealthRow>()
      : { results: [] as ScheduledTenantHealthRow[] };
    const totals = domains.results.reduce<{ likelyHumanViews: number; uniqueVisitors: number; usUniqueVisitors: number; sampledUniqueVisitors: number; sampledUsUniqueVisitors: number; sampledUniqueSampleInterval: number; humanEngagedVisits: number; maxSampleInterval: number; uniqueSampleInterval: number }>((sum, row) => {
      sum.likelyHumanViews += Number(row.likely_human_views ?? 0);
      sum.uniqueVisitors += Number(row.unique_visitors ?? 0);
      sum.usUniqueVisitors += Number(row.us_unique_visitors ?? 0);
      sum.sampledUniqueVisitors += Number(row.sampled_unique_visitors ?? 0);
      sum.sampledUsUniqueVisitors += Number(row.sampled_us_unique_visitors ?? 0);
      sum.sampledUniqueSampleInterval = Math.max(sum.sampledUniqueSampleInterval, Number(row.sampled_unique_sample_interval ?? 1));
      sum.humanEngagedVisits += Number(row.human_engaged_visits ?? 0);
      sum.maxSampleInterval = Math.max(sum.maxSampleInterval, Number(row.max_sample_interval ?? 1));
      sum.uniqueSampleInterval = Math.max(sum.uniqueSampleInterval, Number(row.unique_sample_interval ?? 1));
      return sum;
    }, { likelyHumanViews: 0, uniqueVisitors: 0, usUniqueVisitors: 0, sampledUniqueVisitors: 0, sampledUsUniqueVisitors: 0, sampledUniqueSampleInterval: 1, humanEngagedVisits: 0, maxSampleInterval: 1, uniqueSampleInterval: 1 });
    const samplingDetected = totals.maxSampleInterval > 1;
    const sessionSamplingDetected = exactSessionDays < minimumReviewDays;
    const monetization = {
      activeOffers: Number(monetizationState?.active_offers ?? 0),
      activeCampaigns: Number(monetizationState?.active_campaigns ?? 0),
      activeRoutingPolicies: Number(monetizationState?.active_routing_policies ?? 0),
      clicks: Number(monetizationState?.clicks ?? 0),
      conversions: Number(monetizationState?.conversions ?? 0),
      postbacks: Number(monetizationState?.postbacks ?? 0),
    };
    const measurementOnly = Object.values(monetization).every((value) => value === 0);
    const expectedScheduledChecksByDomain = new Map(domains.results.map((domain) => {
      const startDate = domain.measurement_started_at?.slice(0, 10) || telemetryStartDate;
      const effectiveStart = startDate > telemetryStartDate ? startDate : telemetryStartDate;
      const days = effectiveStart <= latestCompletedDate ? completedUtcDayCount(effectiveStart, coverageNow) : 0;
      return [domain.domain_id, days * SCHEDULED_HEALTH_CHECKS_PER_DAY] as const;
    }));
    const { health, healthChecks, allTenantsReady, allTenantsReliable } = summarizeTenantHealth(
      domains.results,
      latestHealth.results,
      coverageNow,
      scheduledHealth.results,
      expectedScheduledChecksByDomain,
    );
    const currentDaySchedule = summarizeCurrentDaySchedule(domains.results, currentDayScheduledHealth.results, coverageNow, telemetryStartDate);
    const decision = decideEvidence({
      observedFullDays,
      decisionGradeDays,
      minimumReviewDays,
      rollupCoverageComplete,
      allTenantsReady,
      allTenantsReliable,
      telemetryPipelineVerified,
      sessionSamplingDetected,
      measurementOnly,
      qualifiedSessions: totals.uniqueVisitors,
      minimumQualifiedSessions,
    });
    return c.json({
      telemetryStartDate,
      exactSessionStartDate,
      sampledMetricDate,
      cohortKey: cohort?.key ?? null,
      cohortLabel: cohort?.label ?? null,
      latestCompletedDate,
      rollupThrough: through,
      observedFullDays,
      decisionGradeDays,
      expectedFullDays: expectedDays,
      rollupCoverageComplete,
      evidenceStatus: decision.status,
      minimumReviewDays,
      totals,
      domains: domains.results,
      health,
      healthChecks,
      currentDaySchedule,
      sampling: { detected: samplingDetected, maxSampleInterval: totals.maxSampleInterval, uniqueSampleInterval: totals.uniqueSampleInterval, exactQualifiedSessions: !sessionSamplingDetected, kpiAvailable: qualifiedSessionKpiAvailable, exactDays: exactSessionDays, requiredDays: minimumReviewDays },
      telemetry: { pipelineVerified: telemetryPipelineVerified, verifiedDays: telemetryVerifiedDays, expectedDays },
      monetization,
      reviewBlockers: decision.blockers,
      latestRun,
    });
  });

  app.post("/api/health/check", async (c) => {
    const result = await checkPublishedTenants(c.env);
    await auditStatement(c.env.DB, {
      actor: c.get("actor"),
      action: "health.check",
      entityType: "portfolio",
      entityId: "published",
      requestId: c.get("requestId"),
      after: { checked: result.checked, ready: result.ready, notReady: result.notReady, unreachable: result.unreachable, truncated: result.truncated },
    }).run();
    return c.json(result);
  });

  app.post("/api/metrics/rollup", async (c) => {
    const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(await c.req.json<unknown>().catch(() => null));
    if (!parsed.success) return c.json(zodError(parsed.error), 400);
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.data.date >= today) return c.json({ error: "Only completed UTC days can be rolled up" }, 409);
    const result = await rollupDate(c.env, parsed.data.date);
    await auditStatement(c.env.DB, {
      actor: c.get("actor"),
      action: "metrics.rollup",
      entityType: "analytics",
      entityId: parsed.data.date,
      requestId: c.get("requestId"),
      after: result,
    }).run();
    return c.json(result);
  });

  app.post("/api/domains/import", async (c) => {
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = z.object({ domains: z.array(domainImportSchema).min(1).max(500) }).safeParse(raw);
    if (!body.success) return c.json(zodError(body.error), 400);
    const invalid = body.data.domains.filter((domain) => domain.sourceLabels.some((label) => label.trim().toLowerCase() === "traffic2"));
    if (invalid.length) return c.json({ error: "Traffic2 domains are not eligible", hostnames: invalid.map((domain) => domain.hostname) }, 409);
    const actor = c.get("actor");
    const requestId = c.get("requestId");
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];
    const imported: string[] = [];
    for (const domain of body.data.domains) {
      const id = randomId("dom");
      statements.push(
        c.env.DB.prepare("INSERT INTO domains (id, hostname, lifecycle_status, registrar, source_type, source_status, source_labels_json, vertical, country, ai_summary, ai_keywords_json, ai_categories_json, local_evidence_json, traffic_profile_json, cohort_key, traffic_30d_visitors, parking_30d_revenue_usd, traffic_evidence_at, cloudflare_zone_id, assigned_nameservers_json, nameservers_verified_at, created_at, updated_at) VALUES (?, ?, 'draft', ?, 'parking', 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hostname) DO UPDATE SET registrar=excluded.registrar, source_type=excluded.source_type, source_status=excluded.source_status, source_labels_json=excluded.source_labels_json, vertical=excluded.vertical, country=excluded.country, ai_summary=excluded.ai_summary, ai_keywords_json=excluded.ai_keywords_json, ai_categories_json=excluded.ai_categories_json, local_evidence_json=excluded.local_evidence_json, traffic_profile_json=excluded.traffic_profile_json, cohort_key=excluded.cohort_key, traffic_30d_visitors=excluded.traffic_30d_visitors, parking_30d_revenue_usd=excluded.parking_30d_revenue_usd, traffic_evidence_at=excluded.traffic_evidence_at, cloudflare_zone_id=COALESCE(excluded.cloudflare_zone_id, domains.cloudflare_zone_id), assigned_nameservers_json=CASE WHEN excluded.cloudflare_zone_id IS NULL THEN domains.assigned_nameservers_json ELSE excluded.assigned_nameservers_json END, nameservers_verified_at=CASE WHEN excluded.cloudflare_zone_id IS NULL THEN domains.nameservers_verified_at ELSE excluded.nameservers_verified_at END, updated_at=excluded.updated_at")
          .bind(id, domain.hostname, domain.registrar ?? null, JSON.stringify(domain.sourceLabels), domain.vertical ?? null, domain.country ?? null, domain.aiSummary ?? null, JSON.stringify(domain.aiKeywords), JSON.stringify(domain.aiCategories), JSON.stringify(domain.localEvidence), JSON.stringify(domain.trafficProfile ?? {}), domain.cohortKey ?? "pilot-2026-08-05", domain.traffic30dVisitors ?? null, domain.parking30dRevenueUsd ?? null, domain.trafficEvidenceAt ?? null, domain.cloudflareZoneId ?? null, JSON.stringify(domain.assignedNameservers ?? []), domain.cloudflareZoneId ? timestamp : null, timestamp, timestamp),
        auditStatement(c.env.DB, { actor, action: "domain.import", entityType: "domain", entityId: domain.hostname, requestId, after: domain }),
      );
      imported.push(domain.hostname);
    }
    await c.env.DB.batch(statements);
    return c.json({ imported }, 201);
  });

  app.get("/api/cohorts", async (c) => {
    const result = await c.env.DB.prepare("SELECT key,label,telemetry_start_date,exact_session_start_date,minimum_review_days,minimum_qualified_sessions,status FROM measurement_cohorts ORDER BY created_at").all();
    return c.json({ cohorts: result.results });
  });

  app.post("/api/cohorts/:key/activate", async (c) => {
    const key = c.req.param("key").trim();
    const cohort = await c.env.DB.prepare("SELECT key,status FROM measurement_cohorts WHERE key=?").bind(key).first<{ key: string; status: string }>();
    if (!cohort) return c.json({ error: "Cohort not found" }, 404);
    if (cohort.status !== "planned") return c.json({ error: "Only planned cohorts can be activated" }, 409);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    const startDate = start.toISOString().slice(0, 10);
    const timestamp = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE measurement_cohorts SET telemetry_start_date=?, exact_session_start_date=?, status='active', updated_at=? WHERE key=?").bind(startDate, startDate, timestamp, key),
      c.env.DB.prepare("UPDATE domains SET measurement_started_at=?, updated_at=? WHERE cohort_key=?").bind(`${startDate}T00:00:00.000Z`, timestamp, key),
      auditStatement(c.env.DB, { actor: c.get("actor"), action: "cohort.activate", entityType: "cohort", entityId: key, requestId: c.get("requestId"), before: cohort, after: { key, status: "active", telemetryStartDate: startDate, exactSessionStartDate: startDate } }),
    ]);
    return c.json({ key, status: "active", telemetryStartDate: startDate, exactSessionStartDate: startDate });
  });

  app.get("/api/domains/:hostname", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const contents = await c.env.DB.prepare("SELECT id, version, provenance, status, created_by, created_at, approved_at FROM content_versions WHERE domain_id=? ORDER BY version DESC").bind(domain.id).all();
    const releases = await c.env.DB.prepare("SELECT id, version, status, created_by, created_at, published_at FROM release_versions WHERE domain_id=? ORDER BY version DESC").bind(domain.id).all();
    const metrics = await c.env.DB.prepare("SELECT * FROM daily_domain_metrics WHERE domain_id=? ORDER BY metric_date DESC LIMIT 30").bind(domain.id).all();
    const countryMetrics = await c.env.DB.prepare("SELECT country,SUM(views) AS views,SUM(likely_human_views) AS likely_human_views,SUM(human_engaged_visits) AS human_engaged_visits FROM daily_domain_country_metrics WHERE domain_id=? GROUP BY country ORDER BY likely_human_views DESC,views DESC LIMIT 10").bind(domain.id).all();
    const sourceMetrics = await c.env.DB.prepare("SELECT visitor_class,classification_reason,country,asn,as_org,SUM(views) AS views,SUM(engaged_visits) AS engaged_visits FROM daily_domain_source_metrics WHERE domain_id=? AND metric_date>=? GROUP BY visitor_class,classification_reason,country,asn,as_org ORDER BY views DESC,engaged_visits DESC LIMIT 12").bind(domain.id, c.env.TELEMETRY_MIN_DATE ?? "0000-01-01").all();
    const intentMetrics = await c.env.DB.prepare("SELECT path_class,device_class,referrer_class,SUM(views) AS views,SUM(likely_human_views) AS likely_human_views FROM daily_domain_intent_metrics WHERE domain_id=? AND metric_date>=? GROUP BY path_class,device_class,referrer_class ORDER BY likely_human_views DESC,views DESC LIMIT 12").bind(domain.id, c.env.TELEMETRY_MIN_DATE ?? "0000-01-01").all();
    const contextMetrics = await c.env.DB.prepare("SELECT region_code,local_time_bucket,SUM(views) AS views,SUM(likely_human_views) AS likely_human_views FROM daily_domain_context_metrics WHERE domain_id=? AND metric_date>=? GROUP BY region_code,local_time_bucket ORDER BY likely_human_views DESC,views DESC LIMIT 12").bind(domain.id, c.env.TELEMETRY_MIN_DATE ?? "0000-01-01").all();
    const telemetryHealth = await c.env.DB.prepare("SELECT metric_date,expected_canaries,observed_canaries,canary_sample_interval,verified,updated_at FROM daily_domain_telemetry_health WHERE domain_id=? ORDER BY metric_date DESC LIMIT 30").bind(domain.id).all();
    const healthChecks = await c.env.DB.prepare("SELECT status,http_status,latency_ms,expected_release_id,observed_release_id,error_message,checked_at,check_source FROM tenant_health_checks WHERE domain_id=? ORDER BY checked_at DESC LIMIT 20").bind(domain.id).all();
    return c.json({ domain: publicDomain(domain), contents: contents.results, releases: releases.results, metrics: metrics.results, countryMetrics: countryMetrics.results, sourceMetrics: sourceMetrics.results, intentMetrics: intentMetrics.results, contextMetrics: contextMetrics.results, telemetryHealth: telemetryHealth.results, healthChecks: healthChecks.results });
  });

  app.post("/api/domains/:hostname/cloudflare-zone", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const parsed = cloudflareZoneMetadataSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!parsed.success) return c.json(zodError(parsed.error), 400);
    const timestamp = nowIso();
    const before = {
      cloudflareZoneId: domain.cloudflare_zone_id,
      assignedNameservers: jsonValue(domain.assigned_nameservers_json, []),
      nameserversVerifiedAt: domain.nameservers_verified_at,
    };
    const after = { ...parsed.data, nameserversVerifiedAt: timestamp };
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE domains SET cloudflare_zone_id=?, assigned_nameservers_json=?, nameservers_verified_at=?, updated_at=? WHERE id=?")
        .bind(parsed.data.cloudflareZoneId, JSON.stringify(parsed.data.assignedNameservers), timestamp, timestamp, domain.id),
      auditStatement(c.env.DB, { actor: c.get("actor"), action: "domain.cloudflare_zone.verify", entityType: "domain", entityId: domain.id, requestId: c.get("requestId"), before, after }),
    ]);
    const updated = await domainById(c.env.DB, domain.id);
    if (!updated) return c.json({ error: "Domain metadata update could not be read back" }, 500);
    return c.json({ domain: publicDomain(updated) });
  });

  app.post("/api/domains/:hostname/content", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const parsed = contentMutationSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!parsed.success) return c.json(zodError(parsed.error), 400);
    const actor = c.get("actor");
    const timestamp = nowIso();
    const serialized = JSON.stringify(parsed.data.content);
    const contentId = randomId("cnt");
    const version = await nextVersion(c.env.DB, "content_versions", domain.id);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO content_versions (id, domain_id, version, content_json, content_sha256, provenance, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)")
        .bind(contentId, domain.id, version, serialized, await sha256Hex(serialized), parsed.data.provenance, actor, timestamp),
      auditStatement(c.env.DB, { actor, action: "content.create", entityType: "content", entityId: contentId, requestId: c.get("requestId"), after: { domainId: domain.id, version, provenance: parsed.data.provenance } }),
    ]);
    return c.json({ id: contentId, version, status: "draft" }, 201);
  });

  app.post("/api/content/:id/approve", async (c) => {
    const content = await c.env.DB.prepare("SELECT * FROM content_versions WHERE id=?").bind(c.req.param("id")).first<ContentRow>();
    if (!content) return c.json({ error: "Content not found" }, 404);
    if (content.status !== "draft") return c.json({ error: "Only draft content can be approved" }, 409);
    const timestamp = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE content_versions SET status='retired' WHERE domain_id=? AND status='approved'").bind(content.domain_id),
      c.env.DB.prepare("UPDATE content_versions SET status='approved', approved_at=? WHERE id=?").bind(timestamp, content.id),
      c.env.DB.prepare("UPDATE domains SET lifecycle_status=CASE WHEN lifecycle_status='draft' THEN 'ready' ELSE lifecycle_status END, updated_at=? WHERE id=?").bind(timestamp, content.domain_id),
      auditStatement(c.env.DB, { actor: c.get("actor"), action: "content.approve", entityType: "content", entityId: content.id, requestId: c.get("requestId"), before: { status: content.status }, after: { status: "approved" } }),
    ]);
    return c.json({ id: content.id, status: "approved" });
  });

  app.get("/api/content/:id/preview", async (c) => {
    const content = await c.env.DB.prepare("SELECT * FROM content_versions WHERE id=?").bind(c.req.param("id")).first<ContentRow>();
    if (!content) return c.json({ error: "Content not found" }, 404);
    const domain = await domainById(c.env.DB, content.domain_id);
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const parsed = contentSchema.parse(JSON.parse(content.content_json));
    const html = compileHomeServicesHtml({ content: parsed, hostname: domain.hostname, releaseId: `preview_${content.id}`, offerEnabled: false });
    return c.html(html, 200, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  });

  app.post("/api/domains/:hostname/publish", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const content = await c.env.DB.prepare("SELECT * FROM content_versions WHERE domain_id=? AND status='approved' ORDER BY version DESC LIMIT 1").bind(domain.id).first<ContentRow>();
    if (!content) return c.json({ error: "No approved content" }, 409);
    const snapshot = await compileRelease(c.env, c.get("actor"), c.get("requestId"), domain, content);
    await persistPublishedRelease(c.env, c.get("actor"), c.get("requestId"), domain, content, snapshot, "publish");
    return c.json({ releaseId: snapshot.releaseId, hostname: domain.hostname, status: "published" });
  });

  app.post("/api/domains/:hostname/preview-deploy", async (c) => {
    const previewHostname = c.env.PREVIEW_HOSTNAME?.trim().toLowerCase();
    if (!previewHostname) return c.json({ error: "Preview hostname is not configured" }, 503);
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const content = await c.env.DB.prepare("SELECT * FROM content_versions WHERE domain_id=? AND status='approved' ORDER BY version DESC LIMIT 1").bind(domain.id).first<ContentRow>();
    if (!content) return c.json({ error: "No approved content" }, 409);
    const snapshot = await compileRelease(c.env, c.get("actor"), c.get("requestId"), domain, content, "live", previewHostname);
    const serialized = JSON.stringify(snapshot);
    const ttl = 7 * 24 * 60 * 60;
    await c.env.SITE_CONFIG.put(releaseKey(snapshot.releaseId), serialized, { expirationTtl: ttl });
    await c.env.SITE_CONFIG.put(activePointerKey(previewHostname), snapshot.releaseId, { expirationTtl: ttl });
    await auditStatement(c.env.DB, {
      actor: c.get("actor"),
      action: "domain.preview_deploy",
      entityType: "domain",
      entityId: domain.id,
      requestId: c.get("requestId"),
      after: { previewHostname, releaseId: snapshot.releaseId },
    }).run();
    return c.json({ releaseId: snapshot.releaseId, sourceHostname: domain.hostname, previewHostname, expiresInSeconds: ttl });
  });

  app.post("/api/domains/:hostname/pause", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    if (!domain.active_release_id) return c.json({ error: "Domain has no active release" }, 409);
    const active = await c.env.DB.prepare("SELECT * FROM release_versions WHERE id=?").bind(domain.active_release_id).first<ReleaseRow>();
    if (!active) return c.json({ error: "Active release missing" }, 409);
    const content = await c.env.DB.prepare("SELECT * FROM content_versions WHERE id=?").bind(active.content_version_id).first<ContentRow>();
    if (!content) return c.json({ error: "Release content missing" }, 409);
    const snapshot = await compileRelease(c.env, c.get("actor"), c.get("requestId"), domain, content, "paused");
    await persistPublishedRelease(c.env, c.get("actor"), c.get("requestId"), domain, content, snapshot, "pause");
    return c.json({ releaseId: snapshot.releaseId, hostname: domain.hostname, status: "paused" });
  });

  app.post("/api/domains/:hostname/rollback/:releaseId", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const target = await c.env.DB.prepare("SELECT * FROM release_versions WHERE id=? AND domain_id=?").bind(c.req.param("releaseId"), domain.id).first<ReleaseRow>();
    if (!target) return c.json({ error: "Release not found" }, 404);
    const snapshot = releaseSnapshotSchema.parse(JSON.parse(target.snapshot_json));
    await c.env.SITE_CONFIG.put(releaseKey(target.id), target.snapshot_json);
    const timestamp = nowIso();
    await switchActivePointer(c.env.SITE_CONFIG, domain.hostname, target.id, domain.active_release_id, () => c.env.DB.batch([
      c.env.DB.prepare("UPDATE release_versions SET status='superseded' WHERE domain_id=? AND status='published'").bind(domain.id),
      c.env.DB.prepare("UPDATE release_versions SET status='published', published_at=? WHERE id=?").bind(timestamp, target.id),
      c.env.DB.prepare("UPDATE domains SET active_release_id=?, lifecycle_status=?, updated_at=? WHERE id=?").bind(target.id, snapshot.state === "paused" ? "paused" : "published", timestamp, domain.id),
      c.env.DB.prepare("INSERT INTO domain_deployments (id, domain_id, release_id, action, previous_release_id, actor, created_at) VALUES (?, ?, ?, 'rollback', ?, ?, ?)")
        .bind(randomId("deploy"), domain.id, target.id, domain.active_release_id, c.get("actor"), timestamp),
      auditStatement(c.env.DB, { actor: c.get("actor"), action: "domain.rollback", entityType: "domain", entityId: domain.id, requestId: c.get("requestId"), before: { activeReleaseId: domain.active_release_id }, after: { activeReleaseId: target.id } }),
    ]));
    return c.json({ releaseId: target.id, hostname: domain.hostname, status: snapshot.state === "paused" ? "paused" : "published" });
  });

  app.get("/api/jobs", async (c) => {
    const result = await c.env.DB.prepare("SELECT id, job_type, status, attempts, error_message, created_at, updated_at, json_extract(input_json,'$.domain.hostname') AS hostname FROM jobs ORDER BY created_at DESC LIMIT 100").all();
    return c.json({ jobs: result.results });
  });

  app.get("/api/audit", async (c) => {
    const result = await c.env.DB.prepare("SELECT id,actor,action,entity_type,entity_id,request_id,occurred_at FROM audit_log ORDER BY occurred_at DESC LIMIT 100").all();
    return c.json({ events: result.results });
  });

  app.post("/api/domains/:hostname/generate", async (c) => {
    const domain = await domainByHostname(c.env.DB, c.req.param("hostname"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const jobId = randomId("job");
    const timestamp = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO jobs (id, job_type, status, input_json, attempts, created_at, updated_at) VALUES (?, 'generate_content', 'queued', ?, 0, ?, ?)")
        .bind(jobId, JSON.stringify({ domain: publicDomain(domain), schemaVersion: 1 }), timestamp, timestamp),
      auditStatement(c.env.DB, { actor: c.get("actor"), action: "job.enqueue", entityType: "job", entityId: jobId, requestId: c.get("requestId"), after: { jobType: "generate_content", domainId: domain.id } }),
    ]);
    return c.json({ id: jobId, status: "queued" }, 202);
  });
}

const clickSchema = z.object({
  domainId: z.string().min(1).max(100),
  releaseId: z.string().min(1).max(100),
  slot: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  visitorIdHash: z.string().length(64).nullable(),
  likelyHuman: z.boolean().nullable(),
  country: z.string().max(8).nullable(),
  userAgentClass: z.enum(["human", "bot", "unknown"]),
});

export interface OfferSelection {
  offer_id: string;
  provider: string;
  destination_url: string;
  offer_metadata_json: string;
  campaign_destination_type: string | null;
  campaign_destination_value: string | null;
  campaign_metadata_json: string | null;
}

export type ClickDestination =
  | { type: "redirect"; value: string }
  | { type: "phone"; value: string };

export function resolveClickDestination(selection: OfferSelection, clickId: string): ClickDestination {
  const destinationType = selection.campaign_destination_type ?? "redirect";
  const rawValue = selection.campaign_destination_value ?? selection.destination_url;
  if (destinationType === "phone") {
    if (!/^\+[1-9]\d{7,14}$/.test(rawValue)) throw new Error("Invalid campaign phone destination");
    return { type: "phone", value: rawValue };
  }
  if (destinationType !== "redirect") throw new Error("Unsupported campaign destination");
  const destination = new URL(rawValue);
  if (destination.protocol !== "https:") throw new Error("Unsafe offer destination");
  const offerMetadata = jsonValue<{ clickIdParam?: string }>(selection.offer_metadata_json, {});
  const campaignMetadata = jsonValue<{ clickIdParam?: string }>(selection.campaign_metadata_json ?? "{}", {});
  const configuredParam = campaignMetadata.clickIdParam ?? offerMetadata.clickIdParam;
  const clickIdParam = configuredParam && /^[a-zA-Z0-9_-]{1,32}$/.test(configuredParam) ? configuredParam : "subid";
  destination.searchParams.set(clickIdParam, clickId);
  return { type: "redirect", value: destination.toString() };
}

export function mountInternal(app: App): void {
  app.post("/internal/click", async (c) => {
    const provided = c.req.header("X-DM-Internal-Secret") ?? "";
    if (!provided || !c.env.CONTROL_SHARED_SECRET || !timingSafeEqualString(provided, c.env.CONTROL_SHARED_SECRET)) return c.json({ error: "Forbidden" }, 403);
    const parsed = clickSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid click" }, 400);
    const input = parsed.data;
    const selection = await c.env.DB.prepare(
      "SELECT o.id AS offer_id, o.provider, o.destination_url, o.metadata_json AS offer_metadata_json, ac.destination_type AS campaign_destination_type, ac.destination_value AS campaign_destination_value, ac.metadata_json AS campaign_metadata_json FROM domains d JOIN routing_policies rp ON (rp.domain_id=d.id OR rp.domain_id IS NULL) JOIN offers o ON o.id=rp.offer_id LEFT JOIN affiliate_campaigns ac ON ac.id=rp.campaign_id AND ac.offer_id=o.id AND ac.domain_id=d.id WHERE d.id=? AND d.active_release_id=? AND d.lifecycle_status='published' AND rp.status='active' AND o.status='active' AND (rp.vertical IS NULL OR rp.vertical=d.vertical) AND (rp.country IS NULL OR rp.country=d.country) AND (rp.starts_at IS NULL OR rp.starts_at<=?) AND (rp.ends_at IS NULL OR rp.ends_at>?) AND (rp.campaign_id IS NULL OR ac.status='active') AND (lower(o.provider)<>'marketcall' OR ac.status='active') ORDER BY CASE WHEN rp.domain_id=d.id THEN 0 ELSE 1 END, rp.priority ASC, rp.weight DESC LIMIT 1",
    ).bind(input.domainId, input.releaseId, nowIso(), nowIso()).first<OfferSelection>();
    if (!selection) return c.json({ error: "No eligible offer" }, 404);
    const clickId = randomId("clk");
    let destination: ClickDestination;
    try {
      destination = resolveClickDestination(selection, clickId);
    } catch {
      return c.json({ error: "Unsafe offer destination" }, 500);
    }
    await c.env.DB.prepare("INSERT INTO clicks (id, domain_id, release_id, offer_id, slot, visitor_id_hash, likely_human, country, user_agent_class, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(clickId, input.domainId, input.releaseId, selection.offer_id, input.slot, input.visitorIdHash, input.likelyHuman === null ? null : input.likelyHuman ? 1 : 0, input.country, input.userAgentClass, nowIso()).run();
    return c.json({ destination, destinationUrl: destination.type === "redirect" ? destination.value : null, clickId });
  });
}

const runnerCompletionSchema = z.object({ content: contentSchema });

function runnerAuthorized(header: string | undefined, secret: string | undefined): boolean {
  return Boolean(header && secret && timingSafeEqualString(header, secret));
}

export function mountRunner(app: App): void {
  app.post("/runner/claim", async (c) => {
    if (!runnerAuthorized(c.req.header("X-DM-Runner-Secret"), c.env.CODEX_RUNNER_SECRET)) return c.json({ error: "Forbidden" }, 403);
    const timestamp = nowIso();
    const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    await c.env.DB.prepare("UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END, error_message=CASE WHEN attempts>=3 THEN 'Runner lease expired after final attempt' ELSE 'Runner lease expired; retrying' END, locked_at=NULL, not_before=CASE WHEN attempts>=3 THEN NULL ELSE ? END, updated_at=? WHERE status='running' AND locked_at<?")
      .bind(timestamp, timestamp, staleBefore).run();
    const job = await c.env.DB.prepare("UPDATE jobs SET status='running', attempts=attempts+1, locked_at=?, updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND (not_before IS NULL OR not_before<=?) ORDER BY created_at LIMIT 1) RETURNING id, job_type, input_json, attempts")
      .bind(timestamp, timestamp, timestamp).first();
    return job ? c.json({ job }) : c.json({ job: null });
  });

  app.post("/runner/:id/complete", async (c) => {
    if (!runnerAuthorized(c.req.header("X-DM-Runner-Secret"), c.env.CODEX_RUNNER_SECRET)) return c.json({ error: "Forbidden" }, 403);
    const parsed = runnerCompletionSchema.safeParse(await c.req.json<unknown>().catch(() => null));
    if (!parsed.success) return c.json(zodError(parsed.error), 400);
    const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND status='running'").bind(c.req.param("id")).first<{ id: string; input_json: string }>();
    if (!job) return c.json({ error: "Running job not found" }, 404);
    const input = jsonValue<{ domain?: { id?: string } }>(job.input_json, {});
    const domainId = input.domain?.id;
    if (!domainId) return c.json({ error: "Job has no domain" }, 409);
    const serialized = JSON.stringify(parsed.data.content);
    const contentId = randomId("cnt");
    const version = await nextVersion(c.env.DB, "content_versions", domainId);
    const timestamp = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO content_versions (id, domain_id, version, content_json, content_sha256, provenance, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'codex', 'draft', 'codex-runner', ?)")
        .bind(contentId, domainId, version, serialized, await sha256Hex(serialized), timestamp),
      c.env.DB.prepare("UPDATE jobs SET status='succeeded', output_json=?, updated_at=? WHERE id=? AND status='running'").bind(JSON.stringify({ contentId, version }), timestamp, job.id),
      auditStatement(c.env.DB, { actor: "codex-runner", action: "content.generate", entityType: "content", entityId: contentId, after: { domainId, version, jobId: job.id } }),
    ]);
    return c.json({ contentId, version, status: "draft" });
  });

  app.post("/runner/:id/fail", async (c) => {
    if (!runnerAuthorized(c.req.header("X-DM-Runner-Secret"), c.env.CODEX_RUNNER_SECRET)) return c.json({ error: "Forbidden" }, 403);
    const body = z.object({ error: z.string().min(1).max(1000), retry: z.boolean().default(false) }).safeParse(await c.req.json<unknown>().catch(() => null));
    if (!body.success) return c.json(zodError(body.error), 400);
    const timestamp = nowIso();
    const notBefore = body.data.retry ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
    const status = body.data.retry ? "queued" : "failed";
    const result = await c.env.DB.prepare("UPDATE jobs SET status=?, error_message=?, not_before=?, locked_at=NULL, updated_at=? WHERE id=? AND status='running'")
      .bind(status, body.data.error, notBefore, timestamp, c.req.param("id")).run();
    if (!result.meta.changes) return c.json({ error: "Running job not found" }, 404);
    return c.json({ id: c.req.param("id"), status });
  });
}
