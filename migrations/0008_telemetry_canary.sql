ALTER TABLE analytics_rollup_runs ADD COLUMN canary_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_rollup_runs ADD COLUMN expected_canaries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_rollup_runs ADD COLUMN observed_canaries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE analytics_rollup_runs ADD COLUMN canary_sample_interval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE analytics_rollup_runs ADD COLUMN telemetry_verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE daily_domain_telemetry_health (
  domain_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  expected_canaries INTEGER NOT NULL DEFAULT 0,
  observed_canaries INTEGER NOT NULL DEFAULT 0,
  canary_sample_interval INTEGER NOT NULL DEFAULT 1,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(domain_id, metric_date),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE INDEX idx_telemetry_health_date ON daily_domain_telemetry_health(metric_date, verified);
