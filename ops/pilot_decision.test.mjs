import { describe, expect, it } from "vitest";
import { pilotDecision } from "./pilot_decision.mjs";

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
});
