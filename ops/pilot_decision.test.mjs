import { describe, expect, it } from "vitest";
import { evidenceContractIssues, pilotDecision } from "./pilot_decision.mjs";

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

  it("rejects inconsistent status and blocker combinations", () => {
    expect(evidenceContractIssues({ evidenceStatus: "review_ready", reviewBlockers: ["qualified_sessions"] })).toContain(
      "review_ready is inconsistent with non-empty evidence blockers",
    );
    expect(evidenceContractIssues({ evidenceStatus: "collecting", reviewBlockers: [] })).toContain(
      "collecting is inconsistent with an empty evidence-blocker list",
    );
  });
});
