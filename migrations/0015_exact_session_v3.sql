-- v2 used a unique Analytics Engine index for every browser. Cloudflare sampled
-- the cross-index distinct query, so those rows cannot support an exact KPI.
-- v3 starts on the first full UTC day after the signed daily-marker and
-- domain-indexed stream is deployed. Historical traffic remains contextual.
UPDATE measurement_cohorts
SET exact_session_start_date = '2026-08-10', updated_at = datetime('now')
WHERE exact_session_start_date < '2026-08-10';
