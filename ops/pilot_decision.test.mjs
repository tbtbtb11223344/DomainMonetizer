import { describe, expect, it } from "vitest";
import { currentDayCanaryIssues, evidenceContractIssues, pilotDecision, rollupCoveragePending } from "./pilot_decision.mjs";

describe("pilot decision handoff", () => {
  it("prioritizes operational repair over traffic interpretation", () => {
    expect(pilotDecision({ guard: "FAIL", evidenceStatus: "review_ready" })).toMatchObject({
      action: "repair_pilot",
      requiresUserReview: false,
    });
  });

  it("keeps a healthy incomplete pilot collecting quietly", () => {
    expect(pilotDecision({ guard: "PASS", evidenceStatus: "collecting" })).toMatchObject({
      action: "continue_collecting",
      requiresUserReview: false,
    });
  });

  it("recommends against expansion when the completed window lacks signal", () => {
    expect(pilotDecision({ guard: "PASS", evidenceStatus: "insufficient_signal" })).toMatchObject({
      action: "do_not_scale",
      requiresUserReview: true,
    });
  });

  it("requires human traffic-quality review before expansion", () => {
    expect(pilotDecision({ guard: "PASS", evidenceStatus: "review_ready" })).toMatchObject({
      action: "review_scale_candidate",
      requiresUserReview: true,
    });
  });

  it("fails closed on an unknown evidence status", () => {
    expect(pilotDecision({ guard: "PASS", evidenceStatus: "new_status" })).toMatchObject({
      action: "repair_pilot",
      requiresUserReview: false,
    });
  });
});

describe("evidence API contract", () => {
  it("accepts the three valid status and blocker combinations", () => {
    expect(evidenceContractIssues({ evidenceStatus: "collecting", reviewBlockers: ["observation_window"] })).toEqual([]);
    expect(evidenceContractIssues({ evidenceStatus: "insufficient_signal", reviewBlockers: ["qualified_sessions"] })).toEqual([]);
    expect(evidenceContractIssues({ evidenceStatus: "review_ready", reviewBlockers: [] })).toEqual([]);
  });

  it("surfaces operational and unknown blockers", () => {
    expect(evidenceContractIssues({
      evidenceStatus: "collecting",
      reviewBlockers: ["telemetry_pipeline", "future_blocker"],
    })).toEqual(expect.arrayContaining([
      "Evidence gate reports telemetry_pipeline",
      "Unknown evidence blocker: future_blocker",
    ]));
  });

  it("treats historical quality gaps as additional collection while the decision-grade window is open", () => {
    expect(evidenceContractIssues({
      evidenceStatus: "collecting",
      reviewBlockers: ["observation_window", "tenant_reliability", "telemetry_pipeline", "qualified_session_sampling"],
    })).toEqual([]);
  });

  it("tolerates only the one expected coverage gap before the daily rollup grace deadline", () => {
    const pending = rollupCoveragePending({
      now: new Date("2026-08-11T01:01:00.000Z"),
      latestCompletedDate: "2026-08-10",
      observedFullDays: 5,
      expectedFullDays: 6,
      latestRun: { status: "succeeded", metric_date: "2026-08-09" },
    });
    expect(pending).toBe(true);
    expect(evidenceContractIssues({
      evidenceStatus: "collecting",
      reviewBlockers: ["observation_window", "rollup_coverage"],
      pendingRollupCoverage: pending,
    })).toEqual([]);
  });

  it("fails closed on overdue, multi-day, or previously failed rollup coverage", () => {
    const base = {
      latestCompletedDate: "2026-08-10",
      observedFullDays: 5,
      expectedFullDays: 6,
      latestRun: { status: "succeeded", metric_date: "2026-08-09" },
    };
    expect(rollupCoveragePending({ ...base, now: new Date("2026-08-11T04:27:00.000Z") })).toBe(false);
    expect(rollupCoveragePending({ ...base, now: new Date("2026-08-11T01:01:00.000Z"), observedFullDays: 4 })).toBe(false);
    expect(rollupCoveragePending({ ...base, now: new Date("2026-08-11T01:01:00.000Z"), latestRun: { status: "failed", metric_date: "2026-08-10" } })).toBe(false);
    expect(evidenceContractIssues({
      evidenceStatus: "collecting",
      reviewBlockers: ["observation_window", "rollup_coverage"],
      pendingRollupCoverage: false,
    })).toContain("Evidence gate reports rollup_coverage");
  });

  it("rejects inconsistent status and blocker combinations", () => {
    expect(evidenceContractIssues({ evidenceStatus: "review_ready", reviewBlockers: ["qualified_sessions"] })).toContain(
      "review_ready is inconsistent with non-empty evidence blockers",
    );
    expect(evidenceContractIssues({ evidenceStatus: "collecting", reviewBlockers: [] })).toContain(
      "collecting is inconsistent with an empty evidence-blocker list",
    );
  });
});

describe("current-day canary reconciliation", () => {
  const schedule = {
    requiredByNowPerDomain: 1,
    domains: [
      { domainId: "dom_1", hostname: "one.example", requiredByNow: 1, observedChecks: 1 },
      { domainId: "dom_2", hostname: "two.example", requiredByNow: 1, observedChecks: 1 },
    ],
  };

  it("accepts one exact unsampled canary per required check", () => {
    expect(currentDayCanaryIssues({ schedule, rows: [
      { domain_id: "dom_1", distinct_canaries: 1, max_sample_interval: 1 },
      { domain_id: "dom_2", distinct_canaries: 1, max_sample_interval: 1 },
    ] })).toEqual([]);
  });

  it("tolerates an in-grace stored check until it becomes required", () => {
    const inGrace = {
      requiredByNowPerDomain: 1,
      domains: [{ domainId: "dom_1", hostname: "one.example", requiredByNow: 1, observedChecks: 2 }],
    };
    expect(currentDayCanaryIssues({ schedule: inGrace, rows: [
      { domain_id: "dom_1", distinct_canaries: 1, max_sample_interval: 1 },
    ] })).toEqual([]);
  });

  it("rejects missing, extra-domain, and sampled canaries", () => {
    expect(currentDayCanaryIssues({ schedule, rows: [
      { domain_id: "dom_1", distinct_canaries: 2, max_sample_interval: 5 },
      { domain_id: "dom_extra", distinct_canaries: 1, max_sample_interval: 1 },
    ] })).toEqual(expect.arrayContaining([
      "Unexpected current-day health canary domain: dom_extra",
      expect.stringContaining("one.example: current-day scheduled canaries=2"),
      expect.stringContaining("two.example: current-day scheduled canaries=0"),
      expect.stringContaining("one.example: current-day health canary query is sampled at 5"),
    ]));
  });

  it("does not require current-day Analytics reads before the first grace deadline", () => {
    expect(currentDayCanaryIssues({ schedule: { requiredByNowPerDomain: 0, domains: [] }, rows: null })).toEqual([]);
  });

  it("can scope reconciliation to a single cohort", () => {
    expect(currentDayCanaryIssues({
      schedule,
      allowedDomainIds: new Set(["dom_1"]),
      rows: [{ domain_id: "dom_1", distinct_canaries: 1, max_sample_interval: 1 }],
    })).toEqual([]);
  });

  it("fails closed when a cohort scope is empty or malformed", () => {
    expect(currentDayCanaryIssues({ schedule, allowedDomainIds: new Set(), rows: [] })).toEqual([
      "Current-day canary scope is empty or contains invalid domain IDs",
    ]);
    expect(currentDayCanaryIssues({ schedule, allowedDomainIds: new Set([undefined]), rows: [] })).toEqual([
      "Current-day canary scope is empty or contains invalid domain IDs",
    ]);
  });
});
