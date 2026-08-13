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
  aiCategories: string[];
  localEvidence: Array<{ sourceRoot: string; locality: string; service: string }>;
  trafficProfile: { coveredDays?: number; nonzeroDays?: number; medianDailyVisitors?: number; maxDayShare?: number; provider?: string };
  cohortKey: string;
  measurementStartedAt: string | null;
  traffic30dVisitors: number | null;
  parking30dRevenueUsd: number | null;
  trafficEvidenceAt: string | null;
  cloudflareZoneId: string | null;
  assignedNameservers: string[];
  nameserversVerifiedAt: string | null;
  activeReleaseId: string | null;
  updatedAt: string;
}

export interface CohortSummary {
  key: string;
  label: string;
  telemetry_start_date: string;
  exact_session_start_date: string;
  minimum_review_days: number;
  minimum_qualified_sessions: number;
  status: string;
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
  us_unique_visitors: number;
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
  us_unique_visitors: number;
  sampled_unique_visitors: number;
  sampled_us_unique_visitors: number;
  sampled_unique_sample_interval: number;
  clicks: number;
  phone_actions: number;
  unique_phone_actions: number;
  provider_recorded_calls: number;
  provider_confirmed_calls: number;
  provider_pending_calls: number;
  provider_unsuccessful_calls: number;
  max_sample_interval: number;
  unique_sample_interval: number;
}

export interface MetricsOverview {
  telemetryStartDate: string;
  exactSessionStartDate: string;
  sampledMetricDate: string | null;
  latestCompletedDate: string;
  rollupThrough: string | null;
  observedFullDays: number;
  decisionGradeDays: number;
  expectedFullDays: number;
  rollupCoverageComplete: boolean;
  evidenceStatus: "collecting" | "insufficient_signal" | "review_ready";
  minimumReviewDays: number;
  totals: { likelyHumanViews: number; uniqueVisitors: number; usUniqueVisitors: number; sampledUniqueVisitors: number; sampledUsUniqueVisitors: number; sampledUniqueSampleInterval: number; humanEngagedVisits: number; maxSampleInterval: number; uniqueSampleInterval: number };
  domains: DomainMetricSummary[];
  health: { published: number; ready: number; reliable: number; failing: number; stale: number; unchecked: number; scheduledChecks: number; expectedScheduledChecks: number; readyScheduledChecks: number; reliabilityThreshold: number; lastCheckedAt: string | null };
  healthChecks: CurrentTenantHealth[];
  currentDaySchedule: { date: string; expectedByNowPerDomain: number; requiredByNowPerDomain: number; expectedChecks: number; requiredChecks: number; observedChecks: number; readyChecks: number; healthy: boolean; domains: Array<{ domainId: string; hostname: string; observedChecks: number; readyChecks: number; expectedByNow: number; requiredByNow: number; onSchedule: boolean; healthy: boolean }> };
  sampling: { detected: boolean; maxSampleInterval: number; uniqueSampleInterval: number; exactQualifiedSessions: boolean; kpiAvailable: boolean; exactDays: number; requiredDays: number };
  telemetry: { pipelineVerified: boolean; verifiedDays: number; expectedDays: number };
  monetization: {
    mode: "measurement_only" | "economic_pilot";
    activeOffers: number;
    activeCampaigns: number;
    activeRoutingPolicies: number;
    clicks: number;
    phoneActions: number;
    uniquePhoneActions: number;
    providerConfirmedCalls: number;
    providerRecordedCalls: number;
    qualifiedCalls: number;
    pendingCalls: number;
    unsuccessfulCalls: number;
    conversions: number;
    postbacks: number;
    failedPostbacks: number;
    rejectedPostbacks: number;
    activeRoutes: Array<{
      hostname: string;
      provider: string;
      offer_external_id: string | null;
      campaign_external_id: string | null;
      destination_type: string | null;
      offer_status: string;
      campaign_status: string | null;
      routing_status: string;
    }>;
  };
  reviewBlockers: string[];
  latestRun: { metric_date: string; status: string; expected_canaries: number; observed_canaries: number; canary_sample_interval: number; telemetry_verified: number; error_message: string | null; completed_at: string | null } | null;
}

export type AnalyticsRange = "7d" | "30d" | "all";

export interface AnalyticsPoint {
  date: string;
  usQualifiedVisitors: number | null;
  providerRecordedCalls: number;
  qualifiedCalls: number;
  pendingCalls: number;
  unsuccessfulCalls: number;
  unattributedProviderRecordedCalls: number;
  unattributedQualifiedCalls: number;
  visitorQuality: "exact" | "estimated" | "unavailable";
  visitorQualityReason: "exact" | "legacy" | "sampled" | "rollup_unavailable" | "not_measured";
  sampleInterval: number;
  telemetryVerified: boolean;
}

export interface AnalyticsSummary {
  usQualifiedVisitors: number;
  providerRecordedCalls: number;
  qualifiedCalls: number;
  pendingCalls: number;
  unsuccessfulCalls: number;
  unattributedProviderRecordedCalls: number;
  unattributedQualifiedCalls: number;
  approximate: boolean;
  coverageComplete: boolean;
  exactDays: number;
  estimatedDays: number;
  unavailableDays: number;
}

export interface AnalyticsComparison {
  label: string;
  usQualifiedVisitorsChange: number | null;
  providerRecordedCallsChange: number | null;
  qualifiedCallsChange: number | null;
}

export interface AnalyticsRanking {
  domainId: string;
  hostname: string;
  usQualifiedVisitors: number;
  providerRecordedCalls: number;
  qualifiedCalls: number;
  pendingCalls: number;
  unsuccessfulCalls: number;
  approximate: boolean;
  coverageComplete: boolean;
}

export interface AnalyticsTimeseries {
  range: AnalyticsRange;
  scope: { domainId: string | null; hostname: string | null };
  timezone: "UTC";
  from: string;
  through: string;
  exactSessionStartDate: string;
  availableDomains: Array<{ id: string; hostname: string }>;
  points: AnalyticsPoint[];
  summary: AnalyticsSummary;
  comparison: AnalyticsComparison | null;
  rankings: AnalyticsRanking[];
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

export async function listDomains(search = "", cohort = ""): Promise<DomainSummary[]> {
  const query = new URLSearchParams({ limit: "500" });
  if (search) query.set("search", search);
  if (cohort) query.set("cohort", cohort);
  const result = await request<{ domains: DomainSummary[] }>(`/api/domains?${query.toString()}`);
  return result.domains;
}

export async function getDomain(hostname: string): Promise<DomainDetail> {
  return request(`/api/domains/${encodeURIComponent(hostname)}`);
}

export async function getMetricsOverview(cohort = ""): Promise<MetricsOverview> {
  return request(`/api/metrics/overview${cohort ? `?cohort=${encodeURIComponent(cohort)}` : ""}`);
}

export async function getAnalyticsTimeseries(range: AnalyticsRange, domainId = ""): Promise<AnalyticsTimeseries> {
  const query = new URLSearchParams({ range });
  if (domainId) query.set("domainId", domainId);
  return request(`/api/metrics/timeseries?${query.toString()}`);
}

export async function listCohorts(): Promise<CohortSummary[]> {
  const result = await request<{ cohorts: CohortSummary[] }>("/api/cohorts");
  return result.cohorts;
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
