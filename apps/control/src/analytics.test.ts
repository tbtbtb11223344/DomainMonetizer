import { describe, expect, it } from "vitest";
import { analyticsBounds, analyticsRunSelectionSql, buildAnalyticsResponse, parseAnalyticsRange, type BuildAnalyticsInput } from "./analytics";

const domains = [
  { id: "dom_a", hostname: "alpha.example", measurement_started_at: "2026-08-01T00:00:00.000Z" },
  { id: "dom_b", hostname: "beta.example", measurement_started_at: "2026-08-12T00:00:00.000Z" },
];

function input(overrides: Partial<BuildAnalyticsInput> = {}): BuildAnalyticsInput {
  return {
    range: "7d",
    bounds: { current: { start: "2026-08-11", end: "2026-08-13" }, previous: null },
    exactSessionStartDate: "2026-08-12",
    selectedDomainId: null,
    domains,
    metrics: [
      { domain_id: "dom_a", metric_date: "2026-08-11", us_unique_visitors: 10, unique_sample_interval: 1, telemetry_version: 3 },
      { domain_id: "dom_a", metric_date: "2026-08-12", us_unique_visitors: 5, unique_sample_interval: 1, telemetry_version: 4 },
      { domain_id: "dom_b", metric_date: "2026-08-12", us_unique_visitors: 3, unique_sample_interval: 1, telemetry_version: 4 },
    ],
    runs: [
      { metric_date: "2026-08-11", unique_sample_interval: 1, telemetry_verified: 1 },
      { metric_date: "2026-08-12", unique_sample_interval: 1, telemetry_verified: 1 },
    ],
    health: [
      { domain_id: "dom_a", metric_date: "2026-08-11", verified: 1 },
      { domain_id: "dom_a", metric_date: "2026-08-12", verified: 1 },
      { domain_id: "dom_b", metric_date: "2026-08-12", verified: 1 },
    ],
    conversions: [
      { domain_id: "dom_a", metric_date: "2026-08-11", provider_recorded_calls: 2, qualified_calls: 1, pending_calls: 0, unsuccessful_calls: 1 },
      { domain_id: "dom_a", metric_date: "2026-08-12", provider_recorded_calls: 1, qualified_calls: 1, pending_calls: 0, unsuccessful_calls: 0 },
      { domain_id: "dom_b", metric_date: "2026-08-12", provider_recorded_calls: 1, qualified_calls: 0, pending_calls: 1, unsuccessful_calls: 0 },
      { domain_id: null, metric_date: "2026-08-12", provider_recorded_calls: 1, qualified_calls: 0, pending_calls: 0, unsuccessful_calls: 1 },
    ],
    ...overrides,
  };
}

describe("analytics range contract", () => {
  it("accepts only committed range names", () => {
    expect(parseAnalyticsRange("7d")).toBe("7d");
    expect(parseAnalyticsRange("30d")).toBe("30d");
    expect(parseAnalyticsRange("all")).toBe("all");
    expect(parseAnalyticsRange("90d")).toBeNull();
  });

  it("adds an equal prior window only when retained history is sufficient", () => {
    expect(analyticsBounds("7d", "2026-07-01", "2026-08-11")).toEqual({
      current: { start: "2026-08-05", end: "2026-08-11" },
      previous: { start: "2026-07-29", end: "2026-08-04" },
    });
    expect(analyticsBounds("7d", "2026-08-05", "2026-08-11").previous).toBeNull();
    expect(analyticsBounds("all", "2026-08-05", "2026-08-11")).toEqual({
      current: { start: "2026-08-05", end: "2026-08-11" },
      previous: null,
    });
  });

  it("treats the latest failed retry as unavailable instead of reviving an older success", () => {
    const sql = analyticsRunSelectionSql();
    const latestRunSubquery = sql.slice(sql.indexOf("JOIN ("), sql.indexOf(") latest"));
    expect(latestRunSubquery).not.toContain("status='succeeded'");
    expect(sql).toContain("WHERE r.status='succeeded'");
  });
});

describe("analytics response", () => {
  it("keeps legacy, exact, and missing rollup days distinct", () => {
    const response = buildAnalyticsResponse(input());

    expect(response.points.map((point) => [point.date, point.usQualifiedVisitors, point.visitorQuality])).toEqual([
      ["2026-08-11", 10, "estimated"],
      ["2026-08-12", 8, "exact"],
      ["2026-08-13", null, "unavailable"],
    ]);
    expect(response.summary).toMatchObject({
      usQualifiedVisitors: 18,
      providerRecordedCalls: 5,
      qualifiedCalls: 2,
      pendingCalls: 1,
      unsuccessfulCalls: 2,
      unattributedProviderRecordedCalls: 1,
      unattributedQualifiedCalls: 0,
      approximate: true,
      coverageComplete: false,
      exactDays: 1,
      estimatedDays: 1,
      unavailableDays: 1,
    });
  });

  it("uses per-domain measurement and attribution boundaries", () => {
    const response = buildAnalyticsResponse(input({ selectedDomainId: "dom_b" }));

    expect(response.scope).toEqual({ domainId: "dom_b", hostname: "beta.example" });
    expect(response.rankings).toEqual([]);
    expect(response.points[0]).toMatchObject({ visitorQuality: "unavailable", visitorQualityReason: "not_measured" });
    expect(response.points[1]).toMatchObject({ usQualifiedVisitors: 3, providerRecordedCalls: 1, qualifiedCalls: 0, pendingCalls: 1, unsuccessfulCalls: 0, telemetryVerified: true });
    expect(response.summary.unattributedProviderRecordedCalls).toBe(0);
  });

  it("ranks every measured domain and keeps unattributed calls out of rows", () => {
    const response = buildAnalyticsResponse(input({ bounds: { current: { start: "2026-08-12", end: "2026-08-12" }, previous: null } }));

    expect(response.rankings.map((row) => [row.hostname, row.usQualifiedVisitors, row.providerRecordedCalls, row.qualifiedCalls])).toEqual([
      ["alpha.example", 5, 1, 1],
      ["beta.example", 3, 1, 0],
    ]);
    expect(response.summary.providerRecordedCalls).toBe(3);
    expect(response.summary.qualifiedCalls).toBe(1);
    expect(response.summary.unattributedProviderRecordedCalls).toBe(1);
  });

  it("suppresses visitor comparisons across mixed measurement semantics", () => {
    const response = buildAnalyticsResponse(input({
      bounds: { current: { start: "2026-08-12", end: "2026-08-12" }, previous: { start: "2026-08-11", end: "2026-08-11" } },
    }));

    expect(response.comparison).toMatchObject({
      usQualifiedVisitorsChange: null,
      providerRecordedCallsChange: 50,
      qualifiedCallsChange: 0,
    });
  });
});
