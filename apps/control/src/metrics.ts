import type { Env } from "./types";

interface AnalyticsRow {
  domain_id: string;
  metric_date: string;
  views: number;
  engaged_visits: number;
  likely_human_views: number;
  clicks: number;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function rollupYesterday(env: Env): Promise<{ skipped: boolean; rows: number }> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.ANALYTICS_READ_TOKEN) return { skipped: true, rows: 0 };
  if (!/^[a-zA-Z0-9_]+$/.test(env.ANALYTICS_DATASET)) throw new Error("Invalid analytics dataset name");
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 86_400_000);
  const sql = `SELECT index1 AS domain_id, toDate(timestamp) AS metric_date, SUM(CASE WHEN blob1 = 'view' THEN double1 ELSE 0 END) AS views, SUM(CASE WHEN blob1 = 'engaged' THEN double1 ELSE 0 END) AS engaged_visits, SUM(CASE WHEN blob1 = 'view' AND blob4 = 'human' THEN double1 ELSE 0 END) AS likely_human_views, SUM(CASE WHEN blob1 = 'click' THEN double1 ELSE 0 END) AS clicks FROM ${env.ANALYTICS_DATASET} WHERE timestamp >= '${utcDate(start)} 00:00:00' AND timestamp < '${utcDate(end)} 00:00:00' GROUP BY index1, metric_date`;
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ANALYTICS_READ_TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
  });
  if (!response.ok) throw new Error(`Analytics query failed (${response.status})`);
  const rows = await response.json<AnalyticsRow[]>();
  const timestamp = new Date().toISOString();
  if (rows.length) {
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare("INSERT INTO daily_domain_metrics (domain_id, metric_date, views, engaged_visits, likely_human_views, clicks, conversions, revenue_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?) ON CONFLICT(domain_id, metric_date) DO UPDATE SET views=excluded.views, engaged_visits=excluded.engaged_visits, likely_human_views=excluded.likely_human_views, clicks=excluded.clicks, updated_at=excluded.updated_at")
          .bind(row.domain_id, row.metric_date, row.views, row.engaged_visits, row.likely_human_views, row.clicks, timestamp),
      ),
    );
  }
  return { skipped: false, rows: rows.length };
}
