ALTER TABLE analytics_rollup_runs ADD COLUMN source_rows INTEGER NOT NULL DEFAULT 0;

CREATE TABLE daily_domain_source_metrics (
  domain_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  visitor_class TEXT NOT NULL CHECK (visitor_class IN ('human', 'bot', 'unknown')),
  classification_reason TEXT NOT NULL,
  country TEXT NOT NULL,
  asn INTEGER NOT NULL DEFAULT 0,
  as_org TEXT NOT NULL DEFAULT '',
  views INTEGER NOT NULL DEFAULT 0,
  engaged_visits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(domain_id, metric_date, visitor_class, classification_reason, country, asn, as_org),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE INDEX idx_source_metrics_domain_date ON daily_domain_source_metrics(domain_id, metric_date);
CREATE INDEX idx_source_metrics_asn ON daily_domain_source_metrics(asn, metric_date);
