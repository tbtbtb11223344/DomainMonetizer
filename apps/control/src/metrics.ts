import { randomId } from "@domain-monetizer/core";
import { nowIso } from "./db";
import type { Env } from "./types";

interface AnalyticsEnvelope {
  data?: unknown;
}

interface MetricRow {
  domain_id: string;
  metric_date: string;
  views: string | number;
  engaged_visits: string | number;
  likely_human_views: string | number;
  bot_views: string | number;
  unknown_views: string | number;
  human_engaged_visits: string | number;
  us_likely_human_views: string | number;
  clicks: string | number;
  max_sample_interval: string | number;
}

interface UniqueRow {
  domain_id: string;
  metric_date: string;
  unique_visitors: string | number;
  max_sample_interval: string | number;
}

interface CountryRow {
  domain_id: string;
  metric_date: string;
  country: string;
  views: string | number;
  likely_human_views: string | number;
  human_engaged_visits: string | number;
  max_sample_interval: string | number;
}

interface SourceRow {
  domain_id: string;
  metric_date: string;
  visitor_class: string;
  classification_reason: string;
  country: string;
  asn: string | number;
  as_org: string;
  views: string | number;
  engaged_visits: string | number;
  max_sample_interval: string | number;
}

interface CanaryRow {
  domain_id: string;
  metric_date: string;
  observed_canaries: string | number;
  max_sample_interval: string | number;
}

interface ExpectedCanaryRow {
  domain_id: string;
  expected_canaries: string | number;
}

interface IntentRow {
  domain_id: string;
  metric_date: string;
  path_class: string;
  device_class: string;
  referrer_class: string;
  views: string | number;
  likely_human_views: string | number;
  max_sample_interval: string | number;
}

interface ContextRow {
  domain_id: string;
  metric_date: string;
  region_code: string;
  local_time_bucket: string;
  views: string | number;
  likely_human_views: string | number;
  max_sample_interval: string | number;
}

export interface RollupResult {
  skipped: boolean;
  metricDate: string;
  domainRows: number;
  countryRows: number;
  sourceRows: number;
  canaryRows: number;
  expectedCanaries: number;
  observedCanaries: number;
  canarySampleInterval: number;
  telemetryVerified: boolean;
  maxSampleInterval: number;
  uniqueSampleInterval: number;
}

export interface RollupBatchResult {
  plannedDates: string[];
  results: RollupResult[];
  failures: Array<{ metricDate: string; message: string }>;
}

const AUTOMATIC_ROLLUP_LIMIT = 5;

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && utcDate(new Date(`${value}T00:00:00.000Z`)) === value;
}

export function latestCompletedUtcDate(now = new Date()): string {
  const completed = new Date(now);
  completed.setUTCHours(0, 0, 0, 0);
  completed.setUTCDate(completed.getUTCDate() - 1);
  return utcDate(completed);
}

export function completedUtcDayCount(startDate: string, now = new Date()): number {
  if (!validDate(startDate)) throw new Error("Invalid telemetry start date");
  const latest = latestCompletedUtcDate(now);
  if (latest < startDate) return 0;
  return Math.floor((Date.parse(`${latest}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000) + 1;
}

export function rollupCoverageTarget(
  startDate: string,
  observedFullDays: number,
  rollupThrough: string | null,
  now = new Date(),
): { latestCompletedDate: string; expectedFullDays: number; complete: boolean } {
  const latestCompletedDate = latestCompletedUtcDate(now);
  const expectedFullDays = completedUtcDayCount(startDate, now);
  return {
    latestCompletedDate,
    expectedFullDays,
    complete: expectedFullDays === observedFullDays && (expectedFullDays === 0 || rollupThrough === latestCompletedDate),
  };
}

export function missingCompletedUtcDates(
  startDate: string,
  successfulDates: Iterable<string>,
  now = new Date(),
  limit = AUTOMATIC_ROLLUP_LIMIT,
): string[] {
  if (!validDate(startDate)) throw new Error("Invalid telemetry start date");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid analytics backfill limit");
  const latest = latestCompletedUtcDate(now);
  if (latest < startDate) return [];
  const successful = new Set(successfulDates);
  const missing: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  while (utcDate(cursor) <= latest && missing.length < limit) {
    const date = utcDate(cursor);
    if (!successful.has(date)) missing.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return missing;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function integer(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

export function analyticsData<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as AnalyticsEnvelope).data)) {
    throw new Error("Analytics response did not contain a data array");
  }
  return (payload as { data: T[] }).data;
}

async function queryAnalytics<T>(env: Env, sql: string): Promise<T[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ANALYTICS_READ_TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
  });
  if (!response.ok) throw new Error(`Analytics query failed (${response.status})`);
  return analyticsData<T>(await response.json<unknown>());
}

export async function rollupDate(env: Env, metricDate: string, now = new Date()): Promise<RollupResult> {
  if (!validDate(metricDate)) throw new Error("Invalid analytics metric date");
  if (metricDate > latestCompletedUtcDate(now)) throw new Error("Analytics metric date must be a completed UTC day");
  if (!/^[a-zA-Z0-9_]+$/.test(env.ANALYTICS_DATASET)) throw new Error("Invalid analytics dataset name");
  if (env.TELEMETRY_MIN_DATE && !validDate(env.TELEMETRY_MIN_DATE)) throw new Error("Invalid telemetry minimum date");

  const startedAt = nowIso();
  const runId = randomId("rollup");
  await env.DB.prepare("INSERT INTO analytics_rollup_runs (id, metric_date, status, started_at) VALUES (?, ?, 'running', ?)")
    .bind(runId, metricDate, startedAt).run();

  const finish = async (status: "succeeded" | "skipped" | "failed", domainRows: number, countryRows: number, sourceRows: number, canaryRows: number, expectedCanaries: number, observedCanaries: number, canarySampleInterval: number, telemetryVerified: boolean, maxSampleInterval: number, uniqueSampleInterval: number, error?: string) => {
    await env.DB.prepare("UPDATE analytics_rollup_runs SET status=?, domain_rows=?, country_rows=?, source_rows=?, canary_rows=?, expected_canaries=?, observed_canaries=?, canary_sample_interval=?, telemetry_verified=?, max_sample_interval=?, unique_sample_interval=?, error_message=?, completed_at=? WHERE id=?")
      .bind(status, domainRows, countryRows, sourceRows, canaryRows, expectedCanaries, observedCanaries, canarySampleInterval, telemetryVerified ? 1 : 0, maxSampleInterval, uniqueSampleInterval, error ?? null, nowIso(), runId).run();
  };

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.ANALYTICS_READ_TOKEN) {
    await finish("skipped", 0, 0, 0, 0, 0, 0, 1, false, 1, 1, "Analytics credentials are not configured");
    return { skipped: true, metricDate, domainRows: 0, countryRows: 0, sourceRows: 0, canaryRows: 0, expectedCanaries: 0, observedCanaries: 0, canarySampleInterval: 1, telemetryVerified: false, maxSampleInterval: 1, uniqueSampleInterval: 1 };
  }
  if (env.TELEMETRY_MIN_DATE && metricDate < env.TELEMETRY_MIN_DATE) {
    await finish("skipped", 0, 0, 0, 0, 0, 0, 1, false, 1, 1, `Before clean telemetry boundary ${env.TELEMETRY_MIN_DATE}`);
    return { skipped: true, metricDate, domainRows: 0, countryRows: 0, sourceRows: 0, canaryRows: 0, expectedCanaries: 0, observedCanaries: 0, canarySampleInterval: 1, telemetryVerified: false, maxSampleInterval: 1, uniqueSampleInterval: 1 };
  }

  const start = `${metricDate} 00:00:00`;
  const endDate = new Date(`${metricDate}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = `${utcDate(endDate)} 00:00:00`;
  const preview = env.PREVIEW_HOSTNAME?.trim().toLowerCase() || "preview.invalid";
  const where = `timestamp >= toDateTime(${sqlString(start)}) AND timestamp < toDateTime(${sqlString(end)}) AND blob2 != ${sqlString(preview)}`;

  try {
    const metricsSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, sumIf(_sample_interval * double1, blob1 = 'view') AS views, sumIf(_sample_interval * double1, blob1 = 'engaged') AS engaged_visits, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'human') AS likely_human_views, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'bot') AS bot_views, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'unknown') AS unknown_views, sumIf(_sample_interval * double1, blob1 = 'engaged' AND blob4 = 'human') AS human_engaged_visits, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'human' AND blob5 = 'US') AS us_likely_human_views, sumIf(_sample_interval * double1, blob1 = 'click') AS clicks, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 IN ('view', 'engaged', 'click') GROUP BY index1, metric_date`;
    const uniquesSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, count(DISTINCT blob7) AS unique_visitors, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 = 'view' AND blob4 = 'human' AND blob7 != '' GROUP BY index1, metric_date`;
    const countriesSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, blob5 AS country, sumIf(_sample_interval * double1, blob1 = 'view') AS views, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'human') AS likely_human_views, sumIf(_sample_interval * double1, blob1 = 'engaged' AND blob4 = 'human') AS human_engaged_visits, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 IN ('view', 'engaged') GROUP BY index1, metric_date, country`;
    const sourcesSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, blob4 AS visitor_class, blob8 AS classification_reason, blob5 AS country, blob9 AS asn, blob10 AS as_org, sumIf(_sample_interval * double1, blob1 = 'view') AS views, sumIf(_sample_interval * double1, blob1 = 'engaged') AS engaged_visits, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob7 != '' AND blob1 IN ('view', 'engaged') GROUP BY index1, metric_date, visitor_class, classification_reason, country, asn, as_org`;
    const canariesSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, count(DISTINCT blob7) AS observed_canaries, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 = 'health_canary' AND blob8 = 'health_scheduled' AND blob7 != '' GROUP BY index1, metric_date`;
    const intentSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, blob11 AS path_class, blob12 AS device_class, blob13 AS referrer_class, sum(_sample_interval * double1) AS views, sumIf(_sample_interval * double1, blob4 = 'human') AS likely_human_views, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 = 'view' GROUP BY index1, metric_date, path_class, device_class, referrer_class`;
    const contextSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, blob14 AS region_code, blob15 AS local_time_bucket, sum(_sample_interval * double1) AS views, sumIf(_sample_interval * double1, blob4 = 'human') AS likely_human_views, max(_sample_interval) AS max_sample_interval FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 = 'view' GROUP BY index1, metric_date, region_code, local_time_bucket`;
    const [metricRows, uniqueRows, countryRows, sourceRows, canaryRows, intentRows, contextRows] = await Promise.all([
      queryAnalytics<MetricRow>(env, metricsSql),
      queryAnalytics<UniqueRow>(env, uniquesSql),
      queryAnalytics<CountryRow>(env, countriesSql),
      queryAnalytics<SourceRow>(env, sourcesSql),
      queryAnalytics<CanaryRow>(env, canariesSql),
      queryAnalytics<IntentRow>(env, intentSql),
      queryAnalytics<ContextRow>(env, contextSql),
    ]);
    const expectedRows = await env.DB.prepare(
      "SELECT d.id AS domain_id,COUNT(h.id) AS expected_canaries FROM domains d LEFT JOIN tenant_health_checks h ON h.domain_id=d.id AND h.check_source='scheduled' AND h.checked_at>=? AND h.checked_at<? WHERE d.lifecycle_status='published' GROUP BY d.id",
    ).bind(`${metricDate}T00:00:00.000Z`, `${utcDate(endDate)}T00:00:00.000Z`).all<ExpectedCanaryRow>();
    const uniqueByDomain = new Map(uniqueRows.map((row) => [`${row.domain_id}:${row.metric_date}`, integer(row.unique_visitors)]));
    const sampleByDomain = new Map<string, number>();
    for (const row of [...metricRows, ...uniqueRows, ...countryRows, ...sourceRows, ...intentRows, ...contextRows]) {
      const key = `${row.domain_id}:${row.metric_date}`;
      sampleByDomain.set(key, Math.max(sampleByDomain.get(key) ?? 1, integer(row.max_sample_interval) || 1));
    }
    const uniqueSampleByDomain = new Map(uniqueRows.map((row) => [`${row.domain_id}:${row.metric_date}`, integer(row.max_sample_interval) || 1]));
    const maxSampleInterval = Math.max(1, ...sampleByDomain.values());
    const uniqueSampleInterval = Math.max(1, ...uniqueSampleByDomain.values());
    const expectedByDomain = new Map(expectedRows.results.map((row) => [row.domain_id, integer(row.expected_canaries)]));
    const observedByDomain = new Map(canaryRows.map((row) => [row.domain_id, integer(row.observed_canaries)]));
    const canarySampleByDomain = new Map(canaryRows.map((row) => [row.domain_id, integer(row.max_sample_interval) || 1]));
    const canaryDomainIds = new Set([...expectedByDomain.keys(), ...observedByDomain.keys()]);
    const expectedCanaries = [...expectedByDomain.values()].reduce((sum, count) => sum + count, 0);
    const observedCanaries = [...observedByDomain.values()].reduce((sum, count) => sum + count, 0);
    const canarySampleInterval = Math.max(1, ...canarySampleByDomain.values());
    const telemetryVerified = canaryDomainIds.size > 0 && [...canaryDomainIds].every((domainId) => {
      const expected = expectedByDomain.get(domainId) ?? 0;
      return expected > 0 && observedByDomain.get(domainId) === expected && (canarySampleByDomain.get(domainId) ?? 1) === 1;
    });
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE daily_domain_metrics SET views=0, engaged_visits=0, likely_human_views=0, clicks=0, bot_views=0, unknown_views=0, human_engaged_visits=0, us_likely_human_views=0, unique_visitors=0, max_sample_interval=1, unique_sample_interval=1, telemetry_version=2, updated_at=? WHERE metric_date=?")
        .bind(timestamp, metricDate),
      env.DB.prepare("DELETE FROM daily_domain_country_metrics WHERE metric_date=?").bind(metricDate),
      env.DB.prepare("DELETE FROM daily_domain_source_metrics WHERE metric_date=?").bind(metricDate),
      env.DB.prepare("DELETE FROM daily_domain_telemetry_health WHERE metric_date=?").bind(metricDate),
      env.DB.prepare("DELETE FROM daily_domain_intent_metrics WHERE metric_date=?").bind(metricDate),
      env.DB.prepare("DELETE FROM daily_domain_context_metrics WHERE metric_date=?").bind(metricDate),
    ];
    for (const row of metricRows) {
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_metrics (domain_id, metric_date, views, engaged_visits, likely_human_views, clicks, conversions, revenue_usd, bot_views, unknown_views, human_engaged_visits, us_likely_human_views, unique_visitors, max_sample_interval, unique_sample_interval, telemetry_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 2, ?) ON CONFLICT(domain_id, metric_date) DO UPDATE SET views=excluded.views, engaged_visits=excluded.engaged_visits, likely_human_views=excluded.likely_human_views, clicks=excluded.clicks, bot_views=excluded.bot_views, unknown_views=excluded.unknown_views, human_engaged_visits=excluded.human_engaged_visits, us_likely_human_views=excluded.us_likely_human_views, unique_visitors=excluded.unique_visitors, max_sample_interval=excluded.max_sample_interval, unique_sample_interval=excluded.unique_sample_interval, telemetry_version=excluded.telemetry_version, updated_at=excluded.updated_at")
          .bind(
            row.domain_id,
            row.metric_date,
            integer(row.views),
            integer(row.engaged_visits),
            integer(row.likely_human_views),
            integer(row.clicks),
            integer(row.bot_views),
            integer(row.unknown_views),
            integer(row.human_engaged_visits),
            integer(row.us_likely_human_views),
            uniqueByDomain.get(`${row.domain_id}:${row.metric_date}`) ?? 0,
            sampleByDomain.get(`${row.domain_id}:${row.metric_date}`) ?? 1,
            uniqueSampleByDomain.get(`${row.domain_id}:${row.metric_date}`) ?? 1,
            timestamp,
          ),
      );
    }
    for (const row of countryRows) {
      const country = /^[A-Z]{2}$/.test(row.country) ? row.country : "XX";
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_country_metrics (domain_id, metric_date, country, views, likely_human_views, human_engaged_visits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(domain_id, metric_date, country) DO UPDATE SET views=excluded.views, likely_human_views=excluded.likely_human_views, human_engaged_visits=excluded.human_engaged_visits, updated_at=excluded.updated_at")
          .bind(row.domain_id, row.metric_date, country, integer(row.views), integer(row.likely_human_views), integer(row.human_engaged_visits), timestamp),
      );
    }
    for (const row of sourceRows) {
      const visitorClass = row.visitor_class === "human" || row.visitor_class === "bot" ? row.visitor_class : "unknown";
      const reason = /^[a-z0-9_]{1,50}$/.test(row.classification_reason) ? row.classification_reason : "unrecognized";
      const country = /^[A-Z]{2}$/.test(row.country) ? row.country : "XX";
      const asOrg = String(row.as_org ?? "").slice(0, 100);
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_source_metrics (domain_id, metric_date, visitor_class, classification_reason, country, asn, as_org, views, engaged_visits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(domain_id, metric_date, visitor_class, classification_reason, country, asn, as_org) DO UPDATE SET views=excluded.views, engaged_visits=excluded.engaged_visits, updated_at=excluded.updated_at")
          .bind(row.domain_id, row.metric_date, visitorClass, reason, country, integer(row.asn), asOrg, integer(row.views), integer(row.engaged_visits), timestamp),
      );
    }
    for (const domainId of canaryDomainIds) {
      const expected = expectedByDomain.get(domainId) ?? 0;
      const observed = observedByDomain.get(domainId) ?? 0;
      const sampleInterval = canarySampleByDomain.get(domainId) ?? 1;
      const verified = expected > 0 && observed === expected && sampleInterval === 1;
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_telemetry_health (domain_id,metric_date,expected_canaries,observed_canaries,canary_sample_interval,verified,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(domain_id,metric_date) DO UPDATE SET expected_canaries=excluded.expected_canaries,observed_canaries=excluded.observed_canaries,canary_sample_interval=excluded.canary_sample_interval,verified=excluded.verified,updated_at=excluded.updated_at")
          .bind(domainId, metricDate, expected, observed, sampleInterval, verified ? 1 : 0, timestamp),
      );
    }
    const pathClasses = new Set(["root", "contact", "quote", "booking", "service", "location", "about", "other"]);
    const deviceClasses = new Set(["mobile", "tablet", "desktop", "unknown"]);
    const referrerClasses = new Set(["direct", "internal", "search", "directory", "social", "other"]);
    for (const row of intentRows) {
      const pathClass = pathClasses.has(row.path_class) ? row.path_class : "other";
      const deviceClass = deviceClasses.has(row.device_class) ? row.device_class : "unknown";
      const referrerClass = referrerClasses.has(row.referrer_class) ? row.referrer_class : "other";
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_intent_metrics (domain_id,metric_date,path_class,device_class,referrer_class,views,likely_human_views,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(domain_id,metric_date,path_class,device_class,referrer_class) DO UPDATE SET views=excluded.views,likely_human_views=excluded.likely_human_views,updated_at=excluded.updated_at")
          .bind(row.domain_id, row.metric_date, pathClass, deviceClass, referrerClass, integer(row.views), integer(row.likely_human_views), timestamp),
      );
    }
    const timeBuckets = new Set(["00-03", "04-07", "08-11", "12-15", "16-19", "20-23", "unknown"]);
    for (const row of contextRows) {
      const regionCode = /^[A-Z]{2}$/.test(row.region_code) ? row.region_code : "XX";
      const localTimeBucket = timeBuckets.has(row.local_time_bucket) ? row.local_time_bucket : "unknown";
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_context_metrics (domain_id,metric_date,region_code,local_time_bucket,views,likely_human_views,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(domain_id,metric_date,region_code,local_time_bucket) DO UPDATE SET views=excluded.views,likely_human_views=excluded.likely_human_views,updated_at=excluded.updated_at")
          .bind(row.domain_id, row.metric_date, regionCode, localTimeBucket, integer(row.views), integer(row.likely_human_views), timestamp),
      );
    }
    await env.DB.batch(statements);
    await finish("succeeded", metricRows.length, countryRows.length, sourceRows.length, canaryRows.length, expectedCanaries, observedCanaries, canarySampleInterval, telemetryVerified, maxSampleInterval, uniqueSampleInterval);
    return { skipped: false, metricDate, domainRows: metricRows.length, countryRows: countryRows.length, sourceRows: sourceRows.length, canaryRows: canaryRows.length, expectedCanaries, observedCanaries, canarySampleInterval, telemetryVerified, maxSampleInterval, uniqueSampleInterval };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown analytics rollup failure";
    await finish("failed", 0, 0, 0, 0, 0, 0, 1, false, 1, 1, message.slice(0, 500)).catch(() => undefined);
    throw error;
  }
}

export async function rollupMissingCompletedDates(
  env: Env,
  now = new Date(),
  limit = AUTOMATIC_ROLLUP_LIMIT,
): Promise<RollupBatchResult> {
  const latest = latestCompletedUtcDate(now);
  const startDate = env.TELEMETRY_MIN_DATE?.trim() || latest;
  if (!validDate(startDate)) throw new Error("Invalid telemetry minimum date");
  if (latest < startDate) return { plannedDates: [], results: [], failures: [] };

  const successful = await env.DB.prepare(
    "SELECT DISTINCT metric_date FROM analytics_rollup_runs WHERE status='succeeded' AND metric_date>=? AND metric_date<=?",
  ).bind(startDate, latest).all<{ metric_date: string }>();
  const plannedDates = missingCompletedUtcDates(startDate, successful.results.map((row) => row.metric_date), now, limit);
  const results: RollupResult[] = [];
  const failures: RollupBatchResult["failures"] = [];
  for (const metricDate of plannedDates) {
    try {
      results.push(await rollupDate(env, metricDate, now));
    } catch (error) {
      failures.push({
        metricDate,
        message: (error instanceof Error ? error.message : "Unknown analytics rollup failure").slice(0, 500),
      });
    }
  }
  return { plannedDates, results, failures };
}
