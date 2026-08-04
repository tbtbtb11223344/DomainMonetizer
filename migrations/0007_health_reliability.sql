ALTER TABLE tenant_health_checks ADD COLUMN check_source TEXT NOT NULL DEFAULT 'manual';

CREATE UNIQUE INDEX idx_tenant_health_domain_checked ON tenant_health_checks(domain_id, checked_at);
CREATE INDEX idx_tenant_health_source_time ON tenant_health_checks(check_source, checked_at);
