CREATE TABLE affiliate_campaigns (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  external_id TEXT,
  offer_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('redirect', 'phone')),
  destination_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'active', 'paused', 'rejected', 'retired')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id),
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  UNIQUE(provider, external_id)
);

CREATE INDEX idx_affiliate_campaigns_domain_status ON affiliate_campaigns(domain_id, status);
CREATE INDEX idx_affiliate_campaigns_offer_status ON affiliate_campaigns(offer_id, status);

ALTER TABLE routing_policies ADD COLUMN campaign_id TEXT REFERENCES affiliate_campaigns(id);

CREATE INDEX idx_routing_policies_campaign ON routing_policies(campaign_id);
