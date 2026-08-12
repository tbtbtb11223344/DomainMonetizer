export type AnalyticsRange = "7d" | "30d" | "all";
export type VisitorQuality = "exact" | "estimated" | "unavailable";
export type VisitorQualityReason = "exact" | "legacy" | "sampled" | "rollup_unavailable" | "not_measured";

const DAY_MS = 86_400_000;

export interface AnalyticsBounds {
  current: { start: string; end: string };
  previous: { start: string; end: string } | null;
}

export interface AnalyticsDomainRow {
  id: string;
  hostname: string;
  measurement_started_at: string;
}

export interface AnalyticsMetricRow {
  domain_id: string;
  metric_date: string;
  us_unique_visitors: number | string;
  unique_sample_interval: number | string;
  telemetry_version: number | string;
}

export interface AnalyticsRunRow {
  metric_date: string;
  unique_sample_interval: number | string;
  telemetry_verified: number | string;
}

export interface AnalyticsHealthRow {
  domain_id: string;
  metric_date: string;
  verified: number | string;
}

export interface AnalyticsClickRow {
  domain_id: string;
  metric_date: string;
  unique_call_clickers: number | string;
  total_call_clicks: number | string;
}

export interface AnalyticsConversionRow {
  domain_id: string | null;
  metric_date: string;
  confirmed_calls: number | string;
}

export interface AnalyticsPoint {
  date: string;
  usQualifiedVisitors: number | null;
  uniqueCallClickers: number;
  totalCallClicks: number;
  providerConfirmedCalls: number;
  unattributedConfirmedCalls: number;
  visitorQuality: VisitorQuality;
  visitorQualityReason: VisitorQualityReason;
  sampleInterval: number;
  telemetryVerified: boolean;
}

export interface AnalyticsSummary {
  usQualifiedVisitors: number;
  uniqueCallClickers: number;
  totalCallClicks: number;
  providerConfirmedCalls: number;
  unattributedConfirmedCalls: number;
  intentRate: number | null;
  approximate: boolean;
  coverageComplete: boolean;
  exactDays: number;
  estimatedDays: number;
  unavailableDays: number;
}

export interface AnalyticsComparison {
  label: string;
  usQualifiedVisitorsChange: number | null;
  uniqueCallClickersChange: number | null;
  totalCallClicksChange: number | null;
  intentRateChange: number | null;
}

export interface AnalyticsRanking {
  domainId: string;
  hostname: string;
  usQualifiedVisitors: number;
  uniqueCallClickers: number;
  totalCallClicks: number;
  providerConfirmedCalls: number;
  intentRate: number | null;
  approximate: boolean;
  coverageComplete: boolean;
}

export interface AnalyticsResponse {
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

export interface BuildAnalyticsInput {
  range: AnalyticsRange;
  bounds: AnalyticsBounds;
  exactSessionStartDate: string;
  selectedDomainId: string | null;
  domains: AnalyticsDomainRow[];
  metrics: AnalyticsMetricRow[];
  runs: AnalyticsRunRow[];
  health: AnalyticsHealthRow[];
  clicks: AnalyticsClickRow[];
  conversions: AnalyticsConversionRow[];
}

function parseDate(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function isoDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number): string {
  return isoDate(parseDate(value) + days * DAY_MS);
}

function laterDate(left: string, right: string): string {
  return left > right ? left : right;
}

function integer(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function enumerateDates(start: string, end: string): string[] {
  if (start > end) return [];
  const dates: string[] = [];
  for (let cursor = parseDate(start); cursor <= parseDate(end); cursor += DAY_MS) dates.push(isoDate(cursor));
  return dates;
}

export function parseAnalyticsRange(value: string | undefined): AnalyticsRange | null {
  return value === "7d" || value === "30d" || value === "all" ? value : null;
}

export function analyticsClickAggregationSql(domainScoped: boolean): string {
  return `SELECT domain_id,substr(occurred_at,1,10) AS metric_date,COUNT(*) AS total_call_clicks,COUNT(DISTINCT CASE WHEN likely_human=1 THEN COALESCE(visitor_id_hash,id) END) AS unique_call_clickers FROM clicks WHERE action_type='phone' AND measurement_eligible=1 AND country='US' AND occurred_at>=? AND occurred_at<?${domainScoped ? " AND domain_id=?" : ""} GROUP BY domain_id,substr(occurred_at,1,10) ORDER BY metric_date,domain_id`;
}

export function analyticsRunSelectionSql(): string {
  return "SELECT r.metric_date,r.unique_sample_interval,r.telemetry_verified FROM analytics_rollup_runs r JOIN (SELECT metric_date,MAX(started_at) AS started_at FROM analytics_rollup_runs WHERE metric_date>=? AND metric_date<=? GROUP BY metric_date) latest ON latest.metric_date=r.metric_date AND latest.started_at=r.started_at WHERE r.status='succeeded' ORDER BY r.metric_date";
}

export function analyticsBounds(range: AnalyticsRange, telemetryStartDate: string, latestCompletedDate: string): AnalyticsBounds {
  if (range === "all") return { current: { start: telemetryStartDate, end: latestCompletedDate }, previous: null };
  const days = range === "7d" ? 7 : 30;
  const requestedStart = shiftDate(latestCompletedDate, -(days - 1));
  const currentStart = laterDate(telemetryStartDate, requestedStart);
  const previousEnd = shiftDate(currentStart, -1);
  const previousStart = shiftDate(previousEnd, -(days - 1));
  return {
    current: { start: currentStart, end: latestCompletedDate },
    previous: currentStart === requestedStart && previousStart >= telemetryStartDate ? { start: previousStart, end: previousEnd } : null,
  };
}

function key(domainId: string, date: string): string {
  return `${domainId}:${date}`;
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return current === 0 && previous === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function summarize(points: AnalyticsPoint[]): AnalyticsSummary {
  const usQualifiedVisitors = points.reduce((sum, point) => sum + (point.usQualifiedVisitors ?? 0), 0);
  const uniqueCallClickers = points.reduce((sum, point) => sum + point.uniqueCallClickers, 0);
  const totalCallClicks = points.reduce((sum, point) => sum + point.totalCallClicks, 0);
  const providerConfirmedCalls = points.reduce((sum, point) => sum + point.providerConfirmedCalls, 0);
  const unattributedConfirmedCalls = points.reduce((sum, point) => sum + point.unattributedConfirmedCalls, 0);
  const unavailableDays = points.filter((point) => point.visitorQuality === "unavailable").length;
  const estimatedDays = points.filter((point) => point.visitorQuality === "estimated").length;
  const exactDays = points.filter((point) => point.visitorQuality === "exact").length;
  const coverageComplete = points.length > 0 && unavailableDays === 0;
  return {
    usQualifiedVisitors,
    uniqueCallClickers,
    totalCallClicks,
    providerConfirmedCalls,
    unattributedConfirmedCalls,
    intentRate: coverageComplete && usQualifiedVisitors > 0 ? uniqueCallClickers / usQualifiedVisitors : null,
    approximate: estimatedDays > 0,
    coverageComplete,
    exactDays,
    estimatedDays,
    unavailableDays,
  };
}

function visitorSemantics(points: AnalyticsPoint[]): VisitorQualityReason | "mixed" | null {
  if (points.some((point) => point.visitorQuality === "unavailable")) return null;
  const reasons = new Set(points.map((point) => point.visitorQualityReason));
  if (reasons.size !== 1) return "mixed";
  return points[0]?.visitorQualityReason ?? null;
}

export function buildAnalyticsResponse(input: BuildAnalyticsInput): AnalyticsResponse {
  const selectedDomain = input.selectedDomainId
    ? input.domains.find((domain) => domain.id === input.selectedDomainId) ?? null
    : null;
  const domainIds = new Set(input.selectedDomainId ? [input.selectedDomainId] : input.domains.map((domain) => domain.id));
  const domainById = new Map(input.domains.map((domain) => [domain.id, domain]));
  const metricsByDate = new Map<string, AnalyticsMetricRow[]>();
  for (const row of input.metrics) {
    if (!domainIds.has(row.domain_id)) continue;
    const rows = metricsByDate.get(row.metric_date) ?? [];
    rows.push(row);
    metricsByDate.set(row.metric_date, rows);
  }
  const runByDate = new Map(input.runs.map((row) => [row.metric_date, row]));
  const healthByKey = new Map(input.health.map((row) => [key(row.domain_id, row.metric_date), row]));
  const clickByKey = new Map(input.clicks.map((row) => [key(row.domain_id, row.metric_date), row]));
  const conversionByKey = new Map(input.conversions.filter((row) => row.domain_id).map((row) => [key(row.domain_id!, row.metric_date), row]));
  const unattributedByDate = new Map(input.conversions.filter((row) => !row.domain_id).map((row) => [row.metric_date, integer(row.confirmed_calls)]));

  const pointsFor = (start: string, end: string, domainId: string | null): AnalyticsPoint[] => enumerateDates(start, end).map((date) => {
    const scopedIds = domainId
      ? (domainById.get(domainId)?.measurement_started_at.slice(0, 10) ?? "9999-12-31") <= date ? [domainId] : []
      : [...domainIds].filter((id) => (domainById.get(id)?.measurement_started_at.slice(0, 10) ?? "9999-12-31") <= date);
    const notMeasured = scopedIds.length === 0;
    const run = runByDate.get(date);
    const rows = (metricsByDate.get(date) ?? []).filter((row) => scopedIds.includes(row.domain_id));
    const sampleInterval = Math.max(integer(run?.unique_sample_interval) || 1, ...rows.map((row) => integer(row.unique_sample_interval) || 1));
    const legacy = date < input.exactSessionStartDate || rows.some((row) => integer(row.telemetry_version) < 4);
    const visitorQuality: VisitorQuality = notMeasured || !run ? "unavailable" : legacy || sampleInterval > 1 ? "estimated" : "exact";
    const visitorQualityReason: VisitorQualityReason = notMeasured
      ? "not_measured"
      : !run
        ? "rollup_unavailable"
        : sampleInterval > 1
          ? "sampled"
          : legacy
            ? "legacy"
            : "exact";
    const usQualifiedVisitors = visitorQuality === "unavailable" ? null : rows.reduce((sum, row) => sum + integer(row.us_unique_visitors), 0);
    const clickRows = scopedIds.map((id) => clickByKey.get(key(id, date))).filter((row): row is AnalyticsClickRow => Boolean(row));
    const conversionRows = scopedIds.map((id) => conversionByKey.get(key(id, date))).filter((row): row is AnalyticsConversionRow => Boolean(row));
    const telemetryVerified = domainId
      ? integer(healthByKey.get(key(domainId, date))?.verified) === 1
      : integer(run?.telemetry_verified) === 1;
    return {
      date,
      usQualifiedVisitors,
      uniqueCallClickers: clickRows.reduce((sum, row) => sum + integer(row.unique_call_clickers), 0),
      totalCallClicks: clickRows.reduce((sum, row) => sum + integer(row.total_call_clicks), 0),
      providerConfirmedCalls: conversionRows.reduce((sum, row) => sum + integer(row.confirmed_calls), 0) + (domainId ? 0 : (unattributedByDate.get(date) ?? 0)),
      unattributedConfirmedCalls: domainId ? 0 : (unattributedByDate.get(date) ?? 0),
      visitorQuality,
      visitorQualityReason,
      sampleInterval,
      telemetryVerified,
    };
  });

  const points = pointsFor(input.bounds.current.start, input.bounds.current.end, input.selectedDomainId);
  const summary = summarize(points);
  let comparison: AnalyticsComparison | null = null;
  if (input.bounds.previous) {
    const previousPoints = pointsFor(input.bounds.previous.start, input.bounds.previous.end, input.selectedDomainId);
    const previous = summarize(previousPoints);
    const currentSemantics = visitorSemantics(points);
    const previousSemantics = visitorSemantics(previousPoints);
    const comparableVisitors = summary.coverageComplete
      && previous.coverageComplete
      && currentSemantics !== null
      && currentSemantics !== "mixed"
      && currentSemantics === previousSemantics;
    comparison = {
      label: input.range === "7d" ? "previous 7 days" : "previous 30 days",
      usQualifiedVisitorsChange: comparableVisitors ? percentChange(summary.usQualifiedVisitors, previous.usQualifiedVisitors) : null,
      uniqueCallClickersChange: percentChange(summary.uniqueCallClickers, previous.uniqueCallClickers),
      totalCallClicksChange: percentChange(summary.totalCallClicks, previous.totalCallClicks),
      intentRateChange: comparableVisitors ? percentChange(summary.intentRate, previous.intentRate) : null,
    };
  }

  const rankings: AnalyticsRanking[] = input.selectedDomainId ? [] : input.domains.map((domain) => {
    const domainPoints = pointsFor(input.bounds.current.start, input.bounds.current.end, domain.id);
    const domainSummary = summarize(domainPoints);
    return {
      domainId: domain.id,
      hostname: domain.hostname,
      usQualifiedVisitors: domainSummary.usQualifiedVisitors,
      uniqueCallClickers: domainSummary.uniqueCallClickers,
      totalCallClicks: domainSummary.totalCallClicks,
      providerConfirmedCalls: domainSummary.providerConfirmedCalls,
      intentRate: domainSummary.intentRate,
      approximate: domainSummary.approximate,
      coverageComplete: domainSummary.coverageComplete,
    };
  }).sort((left, right) => right.usQualifiedVisitors - left.usQualifiedVisitors || right.uniqueCallClickers - left.uniqueCallClickers || left.hostname.localeCompare(right.hostname));

  return {
    range: input.range,
    scope: { domainId: selectedDomain?.id ?? null, hostname: selectedDomain?.hostname ?? null },
    timezone: "UTC",
    from: input.bounds.current.start,
    through: input.bounds.current.end,
    exactSessionStartDate: input.exactSessionStartDate,
    availableDomains: input.domains.map((domain) => ({ id: domain.id, hostname: domain.hostname })),
    points,
    summary,
    comparison,
    rankings,
  };
}
