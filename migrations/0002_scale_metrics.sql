ALTER TABLE daily_domain_metrics ADD COLUMN bot_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_domain_metrics ADD COLUMN unknown_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_domain_metrics ADD COLUMN human_engaged_visits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_domain_metrics ADD COLUMN us_likely_human_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_domain_metrics ADD COLUMN unique_visitors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_domain_metrics ADD COLUMN telemetry_version INTEGER NOT NULL DEFAULT 2;

CREATE TABLE daily_domain_country_metrics (
  domain_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  country TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likely_human_views INTEGER NOT NULL DEFAULT 0,
  human_engaged_visits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(domain_id, metric_date, country),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE INDEX idx_country_metrics_date ON daily_domain_country_metrics(metric_date, country);

CREATE TABLE analytics_rollup_runs (
  id TEXT PRIMARY KEY,
  metric_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'skipped', 'failed')),
  domain_rows INTEGER NOT NULL DEFAULT 0,
  country_rows INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_rollup_runs_date ON analytics_rollup_runs(metric_date, started_at);
