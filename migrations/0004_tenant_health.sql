CREATE TABLE tenant_health_checks (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'not_ready', 'unreachable')),
  http_status INTEGER,
  latency_ms INTEGER NOT NULL,
  expected_release_id TEXT NOT NULL,
  observed_release_id TEXT,
  error_message TEXT,
  checked_at TEXT NOT NULL,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE INDEX idx_tenant_health_domain_time ON tenant_health_checks(domain_id, checked_at DESC);
CREATE INDEX idx_tenant_health_time ON tenant_health_checks(checked_at);
