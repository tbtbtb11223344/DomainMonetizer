ALTER TABLE daily_domain_metrics ADD COLUMN us_unique_visitors INTEGER NOT NULL DEFAULT 0;

-- The daily-visitor identifier starts after this migration is deployed. Earlier
-- session data remains visible but is not eligible for the exact-unique KPI.
UPDATE measurement_cohorts
SET exact_session_start_date = '2026-08-08', updated_at = datetime('now')
WHERE exact_session_start_date < '2026-08-08';
