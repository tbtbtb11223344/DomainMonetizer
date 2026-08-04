CREATE TABLE daily_domain_context_metrics (
  domain_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  region_code TEXT NOT NULL,
  local_time_bucket TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likely_human_views INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(domain_id, metric_date, region_code, local_time_bucket),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE INDEX idx_context_metrics_date ON daily_domain_context_metrics(metric_date, region_code, local_time_bucket);
