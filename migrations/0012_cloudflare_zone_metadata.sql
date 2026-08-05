ALTER TABLE domains ADD COLUMN cloudflare_zone_id TEXT;
ALTER TABLE domains ADD COLUMN assigned_nameservers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE domains ADD COLUMN nameservers_verified_at TEXT;

CREATE UNIQUE INDEX idx_domains_cloudflare_zone_id
ON domains(cloudflare_zone_id)
WHERE cloudflare_zone_id IS NOT NULL;
