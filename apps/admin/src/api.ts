export interface DomainSummary {
  id: string;
  hostname: string;
  lifecycleStatus: "draft" | "ready" | "published" | "paused" | "retired";
  registrar: string | null;
  sourceType: string | null;
  sourceStatus: string | null;
  sourceLabels: string[];
  vertical: string | null;
  country: string | null;
  aiSummary: string | null;
  aiKeywords: string[];
  traffic30dVisitors: number | null;
  parking30dRevenueUsd: number | null;
  trafficEvidenceAt: string | null;
  activeReleaseId: string | null;
  updatedAt: string;
}

export interface VersionSummary {
  id: string;
  version: number;
  status: string;
  provenance?: string;
  created_by: string;
  created_at: string;
  approved_at?: string | null;
  published_at?: string | null;
}

export interface MetricDay {
  metric_date: string;
  views: number;
  engaged_visits: number;
  likely_human_views: number;
  bot_views: number;
  unknown_views: number;
  human_engaged_visits: number;
  us_likely_human_views: number;
  unique_visitors: number;
  clicks: number;
}

export interface CountryMetric {
  country: string;
  views: number;
  likely_human_views: number;
  human_engaged_visits: number;
}

export interface SourceMetric {
  visitor_class: "human" | "bot" | "unknown";
  classification_reason: string;
  country: string;
  asn: number;
  as_org: string;
  views: number;
  engaged_visits: number;
}

export interface TenantHealthCheck {
  status: "ready" | "not_ready" | "unreachable";
  http_status: number | null;
  latency_ms: number;
  expected_release_id: string;
  observed_release_id: string | null;
  error_message: string | null;
  checked_at: string;
}

export interface CurrentTenantHealth {
  domainId: string;
  hostname: string;
  status: "ready" | "not_ready" | "unreachable" | "unchecked";
  httpStatus: number | null;
  latencyMs: number | null;
  expectedReleaseId: string | null;
  observedReleaseId: string | null;
  errorMessage: string | null;
  checkedAt: string | null;
  fresh: boolean;
  releaseMatches: boolean;
}

export interface DomainMetricSummary {
  domain_id: string;
  hostname: string;
  days_with_traffic: number;
  first_metric_date: string | null;
  last_metric_date: string | null;
  views: number;
  likely_human_views: number;
  bot_views: number;
  unknown_views: number;
  human_engaged_visits: number;
  us_likely_human_views: number;
  unique_visitors: number;
  clicks: number;
}

export interface MetricsOverview {
  telemetryStartDate: string;
  latestCompletedDate: string;
  rollupThrough: string | null;
  observedFullDays: number;
  expectedFullDays: number;
  rollupCoverageComplete: boolean;
  evidenceStatus: "collecting" | "insufficient_signal" | "review_ready";
  minimumReviewDays: number;
  totals: { likelyHumanViews: number; uniqueVisitors: number; humanEngagedVisits: number };
  domains: DomainMetricSummary[];
  health: { published: number; ready: number; failing: number; stale: number; unchecked: number; lastCheckedAt: string | null };
  healthChecks: CurrentTenantHealth[];
  reviewBlockers: string[];
  latestRun: { metric_date: string; status: string; error_message: string | null; completed_at: string | null } | null;
}

export interface DomainDetail {
  domain: DomainSummary;
  contents: VersionSummary[];
  releases: VersionSummary[];
  metrics: MetricDay[];
  countryMetrics: CountryMetric[];
  sourceMetrics: SourceMetric[];
  healthChecks: TenantHealthCheck[];
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export async function listDomains(search = ""): Promise<DomainSummary[]> {
  const result = await request<{ domains: DomainSummary[] }>(`/api/domains?limit=500&search=${encodeURIComponent(search)}`);
  return result.domains;
}

export async function getDomain(hostname: string): Promise<DomainDetail> {
  return request(`/api/domains/${encodeURIComponent(hostname)}`);
}

export async function getMetricsOverview(): Promise<MetricsOverview> {
  return request("/api/metrics/overview");
}

export async function mutate(path: string): Promise<Record<string, unknown>> {
  return request(path, { method: "POST", body: "{}" });
}
