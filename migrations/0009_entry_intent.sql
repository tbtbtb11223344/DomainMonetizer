CREATE TABLE daily_domain_intent_metrics (
  domain_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  path_class TEXT NOT NULL,
  device_class TEXT NOT NULL,
  referrer_class TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likely_human_views INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(domain_id, metric_date, path_class, device_class, referrer_class),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE INDEX idx_intent_metrics_date ON daily_domain_intent_metrics(metric_date, path_class, referrer_class);
