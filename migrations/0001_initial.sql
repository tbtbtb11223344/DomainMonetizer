PRAGMA foreign_keys = ON;

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  lifecycle_status TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle_status IN ('draft', 'ready', 'published', 'paused', 'retired')),
  registrar TEXT,
  source_type TEXT,
  source_status TEXT,
  source_labels_json TEXT NOT NULL DEFAULT '[]',
  vertical TEXT,
  country TEXT,
  locale TEXT NOT NULL DEFAULT 'en-US',
  ai_summary TEXT,
  ai_keywords_json TEXT NOT NULL DEFAULT '[]',
  traffic_30d_visitors INTEGER,
  parking_30d_revenue_usd REAL,
  traffic_evidence_at TEXT,
  active_release_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_release_id) REFERENCES release_versions(id)
);

CREATE INDEX idx_domains_status ON domains(lifecycle_status);
CREATE INDEX idx_domains_vertical ON domains(vertical);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  created_at TEXT NOT NULL,
  UNIQUE(template_key, version)
);

CREATE TABLE content_versions (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('manual', 'import', 'codex')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  UNIQUE(domain_id, version)
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT,
  vertical TEXT NOT NULL,
  country TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, external_id)
);

CREATE TABLE routing_policies (
  id TEXT PRIMARY KEY,
  domain_id TEXT,
  vertical TEXT,
  country TEXT,
  offer_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);

CREATE TABLE release_versions (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  template_version_id TEXT NOT NULL,
  content_version_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'compiled' CHECK (status IN ('compiled', 'published', 'superseded', 'failed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (template_version_id) REFERENCES template_versions(id),
  FOREIGN KEY (content_version_id) REFERENCES content_versions(id),
  UNIQUE(domain_id, version)
);

CREATE TABLE domain_deployments (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publish', 'rollback', 'pause', 'resume')),
  previous_release_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (release_id) REFERENCES release_versions(id)
);

CREATE TABLE clicks (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  visitor_id_hash TEXT,
  likely_human INTEGER,
  country TEXT,
  user_agent_class TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (domain_id) REFERENCES domains(id),
  FOREIGN KEY (release_id) REFERENCES release_versions(id),
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);

CREATE INDEX idx_clicks_domain_occurred ON clicks(domain_id, occurred_at);

CREATE TABLE postback_inbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'rejected', 'failed')),
  error_message TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, idempotency_key)
);

CREATE TABLE conversions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  click_id TEXT,
  domain_id TEXT,
  offer_id TEXT,
  status TEXT NOT NULL,
  payout_usd REAL,
  occurred_at TEXT,
  received_at TEXT NOT NULL,
  raw_inbox_id TEXT NOT NULL,
  FOREIGN KEY (click_id) REFERENCES clicks(id),
  FOREIGN KEY (domain_id) REFERENCES domains(id),
  FOREIGN KEY (offer_id) REFERENCES offers(id),
  FOREIGN KEY (raw_inbox_id) REFERENCES postback_inbox(id),
  UNIQUE(provider, external_id)
);

CREATE TABLE daily_domain_metrics (
  domain_id TEXT NOT NULL,
  metric_date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  engaged_visits INTEGER NOT NULL DEFAULT 0,
  likely_human_views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  revenue_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(domain_id, metric_date),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  not_before TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_runnable ON jobs(status, not_before, created_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_id TEXT,
  before_json TEXT,
  after_json TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, occurred_at);

INSERT INTO template_versions (id, template_key, version, schema_version, status, created_at)
VALUES ('tpl-home-services-v1', 'home-services', 1, 1, 'active', datetime('now'));
