-- v4 bounds Analytics Engine write-cardinality with deterministic per-domain
-- shards. The new evidence boundary is the first full UTC day after deploy.
UPDATE measurement_cohorts
SET exact_session_start_date = '2026-08-12', updated_at = datetime('now')
WHERE exact_session_start_date < '2026-08-12';

ALTER TABLE clicks ADD COLUMN campaign_id TEXT REFERENCES affiliate_campaigns(id);
ALTER TABLE clicks ADD COLUMN action_type TEXT NOT NULL DEFAULT 'redirect'
  CHECK (action_type IN ('redirect', 'phone'));
ALTER TABLE clicks ADD COLUMN measurement_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (measurement_eligible IN (0, 1));

-- Existing economic-pilot clicks were served only through active phone
-- campaigns. Preserve their exact campaign attribution and classify the
-- click-to-call handoff as a phone action.
UPDATE clicks
SET campaign_id = (
      SELECT rp.campaign_id
      FROM routing_policies rp
      JOIN affiliate_campaigns ac ON ac.id = rp.campaign_id
      WHERE rp.domain_id = clicks.domain_id
        AND rp.offer_id = clicks.offer_id
        AND ac.destination_type = 'phone'
      ORDER BY rp.priority, rp.id
      LIMIT 1
    ),
    action_type = 'phone'
WHERE EXISTS (
  SELECT 1
  FROM routing_policies rp
  JOIN affiliate_campaigns ac ON ac.id = rp.campaign_id
  WHERE rp.domain_id = clicks.domain_id
    AND rp.offer_id = clicks.offer_id
    AND ac.destination_type = 'phone'
);

CREATE INDEX idx_clicks_campaign_occurred ON clicks(campaign_id, occurred_at);
CREATE INDEX idx_clicks_action_occurred ON clicks(action_type, occurred_at);
