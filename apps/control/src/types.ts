export interface Env {
  DB: D1Database;
  SITE_CONFIG: KVNamespace;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  ALLOWED_ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOW_LOCAL_ADMIN: string;
  CONTROL_SHARED_SECRET: string;
  CODEX_RUNNER_SECRET?: string;
  OPERATOR_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_READ_TOKEN?: string;
  ANALYTICS_DATASET: string;
  TELEMETRY_MIN_DATE?: string;
  EXACT_SESSION_MIN_DATE?: string;
  PREVIEW_HOSTNAME?: string;
}

export interface Variables {
  actor: string;
  authMethod: "access" | "operator-token";
  requestId: string;
}

export interface DomainRow {
  id: string;
  hostname: string;
  lifecycle_status: string;
  registrar: string | null;
  source_type: string | null;
  source_status: string | null;
  source_labels_json: string;
  vertical: string | null;
  country: string | null;
  locale: string;
  ai_summary: string | null;
  ai_keywords_json: string;
  ai_categories_json: string;
  local_evidence_json: string;
  traffic_profile_json: string;
  cohort_key: string;
  measurement_started_at: string | null;
  traffic_30d_visitors: number | null;
  parking_30d_revenue_usd: number | null;
  traffic_evidence_at: string | null;
  cloudflare_zone_id: string | null;
  assigned_nameservers_json: string;
  nameservers_verified_at: string | null;
  active_release_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentRow {
  id: string;
  domain_id: string;
  version: number;
  content_json: string;
  content_sha256: string;
  provenance: string;
  status: string;
  created_by: string;
  created_at: string;
  approved_at: string | null;
}

export interface ReleaseRow {
  id: string;
  domain_id: string;
  version: number;
  template_version_id: string;
  content_version_id: string;
  snapshot_json: string;
  snapshot_sha256: string;
  status: string;
  created_by: string;
  created_at: string;
  published_at: string | null;
}
