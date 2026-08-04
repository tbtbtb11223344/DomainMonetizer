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
}

interface UniqueRow {
  domain_id: string;
  metric_date: string;
  unique_visitors: string | number;
}

interface CountryRow {
  domain_id: string;
  metric_date: string;
  country: string;
  views: string | number;
  likely_human_views: string | number;
  human_engaged_visits: string | number;
}

export interface RollupResult {
  skipped: boolean;
  metricDate: string;
  domainRows: number;
  countryRows: number;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && utcDate(new Date(`${value}T00:00:00.000Z`)) === value;
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

export async function rollupDate(env: Env, metricDate: string): Promise<RollupResult> {
  if (!validDate(metricDate)) throw new Error("Invalid analytics metric date");
  if (!/^[a-zA-Z0-9_]+$/.test(env.ANALYTICS_DATASET)) throw new Error("Invalid analytics dataset name");
  if (env.TELEMETRY_MIN_DATE && !validDate(env.TELEMETRY_MIN_DATE)) throw new Error("Invalid telemetry minimum date");

  const startedAt = nowIso();
  const runId = randomId("rollup");
  await env.DB.prepare("INSERT INTO analytics_rollup_runs (id, metric_date, status, started_at) VALUES (?, ?, 'running', ?)")
    .bind(runId, metricDate, startedAt).run();

  const finish = async (status: "succeeded" | "skipped" | "failed", domainRows: number, countryRows: number, error?: string) => {
    await env.DB.prepare("UPDATE analytics_rollup_runs SET status=?, domain_rows=?, country_rows=?, error_message=?, completed_at=? WHERE id=?")
      .bind(status, domainRows, countryRows, error ?? null, nowIso(), runId).run();
  };

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.ANALYTICS_READ_TOKEN) {
    await finish("skipped", 0, 0, "Analytics credentials are not configured");
    return { skipped: true, metricDate, domainRows: 0, countryRows: 0 };
  }
  if (env.TELEMETRY_MIN_DATE && metricDate < env.TELEMETRY_MIN_DATE) {
    await finish("skipped", 0, 0, `Before clean telemetry boundary ${env.TELEMETRY_MIN_DATE}`);
    return { skipped: true, metricDate, domainRows: 0, countryRows: 0 };
  }

  const start = `${metricDate} 00:00:00`;
  const endDate = new Date(`${metricDate}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = `${utcDate(endDate)} 00:00:00`;
  const preview = env.PREVIEW_HOSTNAME?.trim().toLowerCase() || "preview.invalid";
  const where = `timestamp >= toDateTime(${sqlString(start)}) AND timestamp < toDateTime(${sqlString(end)}) AND blob2 != ${sqlString(preview)}`;

  try {
    const metricsSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, sumIf(_sample_interval * double1, blob1 = 'view') AS views, sumIf(_sample_interval * double1, blob1 = 'engaged') AS engaged_visits, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'human') AS likely_human_views, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'bot') AS bot_views, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'unknown') AS unknown_views, sumIf(_sample_interval * double1, blob1 = 'engaged' AND blob4 = 'human') AS human_engaged_visits, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'human' AND blob5 = 'US') AS us_likely_human_views, sumIf(_sample_interval * double1, blob1 = 'click') AS clicks FROM ${env.ANALYTICS_DATASET} WHERE ${where} GROUP BY index1, metric_date`;
    const uniquesSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, count(DISTINCT blob7) AS unique_visitors FROM ${env.ANALYTICS_DATASET} WHERE ${where} AND blob1 = 'view' AND blob4 = 'human' AND blob7 != '' GROUP BY index1, metric_date`;
    const countriesSql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, blob5 AS country, sumIf(_sample_interval * double1, blob1 = 'view') AS views, sumIf(_sample_interval * double1, blob1 = 'view' AND blob4 = 'human') AS likely_human_views, sumIf(_sample_interval * double1, blob1 = 'engaged' AND blob4 = 'human') AS human_engaged_visits FROM ${env.ANALYTICS_DATASET} WHERE ${where} GROUP BY index1, metric_date, country`;
    const [metricRows, uniqueRows, countryRows] = await Promise.all([
      queryAnalytics<MetricRow>(env, metricsSql),
      queryAnalytics<UniqueRow>(env, uniquesSql),
      queryAnalytics<CountryRow>(env, countriesSql),
    ]);
    const uniqueByDomain = new Map(uniqueRows.map((row) => [`${row.domain_id}:${row.metric_date}`, integer(row.unique_visitors)]));
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];
    for (const row of metricRows) {
      statements.push(
        env.DB.prepare("INSERT INTO daily_domain_metrics (domain_id, metric_date, views, engaged_visits, likely_human_views, clicks, conversions, revenue_usd, bot_views, unknown_views, human_engaged_visits, us_likely_human_views, unique_visitors, telemetry_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 2, ?) ON CONFLICT(domain_id, metric_date) DO UPDATE SET views=excluded.views, engaged_visits=excluded.engaged_visits, likely_human_views=excluded.likely_human_views, clicks=excluded.clicks, bot_views=excluded.bot_views, unknown_views=excluded.unknown_views, human_engaged_visits=excluded.human_engaged_visits, us_likely_human_views=excluded.us_likely_human_views, unique_visitors=excluded.unique_visitors, telemetry_version=excluded.telemetry_version, updated_at=excluded.updated_at")
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
    if (statements.length) await env.DB.batch(statements);
    await finish("succeeded", metricRows.length, countryRows.length);
    return { skipped: false, metricDate, domainRows: metricRows.length, countryRows: countryRows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown analytics rollup failure";
    await finish("failed", 0, 0, message.slice(0, 500)).catch(() => undefined);
    throw error;
  }
}

export async function rollupYesterday(env: Env): Promise<RollupResult> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 86_400_000);
  return rollupDate(env, utcDate(start));
}
