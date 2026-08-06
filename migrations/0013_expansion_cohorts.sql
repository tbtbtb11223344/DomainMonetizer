CREATE TABLE measurement_cohorts (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  telemetry_start_date TEXT NOT NULL,
  exact_session_start_date TEXT NOT NULL,
  minimum_review_days INTEGER NOT NULL DEFAULT 14,
  minimum_qualified_sessions INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'complete', 'paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE domains ADD COLUMN cohort_key TEXT NOT NULL DEFAULT 'pilot-2026-08-05';
ALTER TABLE domains ADD COLUMN ai_categories_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE domains ADD COLUMN local_evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE domains ADD COLUMN traffic_profile_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE domains ADD COLUMN measurement_started_at TEXT;

CREATE INDEX idx_domains_cohort ON domains(cohort_key);

INSERT OR IGNORE INTO measurement_cohorts
  (key, label, telemetry_start_date, exact_session_start_date, status, created_at, updated_at)
VALUES
  ('pilot-2026-08-05', 'Original three-domain pilot', '2026-08-05', '2026-08-07', 'active', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO measurement_cohorts
  (key, label, telemetry_start_date, exact_session_start_date, status, created_at, updated_at)
VALUES
  ('expansion-01', 'Ten-domain local-service expansion', '2099-01-01', '2099-01-01', 'planned', datetime('now'), datetime('now'));
