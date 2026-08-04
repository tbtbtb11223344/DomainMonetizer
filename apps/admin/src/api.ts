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
  max_sample_interval: number;
  unique_sample_interval: number;
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
  check_source: "manual" | "scheduled";
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
  scheduledChecks: number;
  expectedScheduledChecks: number;
  readyScheduledChecks: number;
  scheduleCoverage: number;
  readinessRate: number;
  reliable: boolean;
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
  max_sample_interval: number;
  unique_sample_interval: number;
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
  totals: { likelyHumanViews: number; uniqueVisitors: number; humanEngagedVisits: number; maxSampleInterval: number; uniqueSampleInterval: number };
  domains: DomainMetricSummary[];
  health: { published: number; ready: number; reliable: number; failing: number; stale: number; unchecked: number; scheduledChecks: number; expectedScheduledChecks: number; readyScheduledChecks: number; reliabilityThreshold: number; lastCheckedAt: string | null };
  healthChecks: CurrentTenantHealth[];
  sampling: { detected: boolean; maxSampleInterval: number; uniqueSampleInterval: number; exactQualifiedSessions: boolean };
  telemetry: { pipelineVerified: boolean; verifiedDays: number; expectedDays: number };
  reviewBlockers: string[];
  latestRun: { metric_date: string; status: string; expected_canaries: number; observed_canaries: number; canary_sample_interval: number; telemetry_verified: number; error_message: string | null; completed_at: string | null } | null;
}

export interface TelemetryHealthDay {
  metric_date: string;
  expected_canaries: number;
  observed_canaries: number;
  canary_sample_interval: number;
  verified: number;
  updated_at: string;
}

export interface IntentMetric {
  path_class: string;
  device_class: string;
  referrer_class: string;
  views: number;
  likely_human_views: number;
}

export interface ContextMetric {
  region_code: string;
  local_time_bucket: string;
  views: number;
  likely_human_views: number;
}

export interface DomainDetail {
  domain: DomainSummary;
  contents: VersionSummary[];
  releases: VersionSummary[];
  metrics: MetricDay[];
  countryMetrics: CountryMetric[];
  sourceMetrics: SourceMetric[];
  intentMetrics: IntentMetric[];
  contextMetrics: ContextMetric[];
  telemetryHealth: TelemetryHealthDay[];
  healthChecks: TenantHealthCheck[];
}

export interface JobSummary {
  id: string;
  job_type: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  error_message: string | null;
  hostname: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  request_id: string | null;
  occurred_at: string;
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

export async function listJobs(): Promise<JobSummary[]> {
  const result = await request<{ jobs: JobSummary[] }>("/api/jobs");
  return result.jobs;
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  const result = await request<{ events: AuditEvent[] }>("/api/audit");
  return result.events;
}

export async function mutate(path: string): Promise<Record<string, unknown>> {
  return request(path, { method: "POST", body: "{}" });
}
