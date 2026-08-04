import { describe, expect, it } from "vitest";
import { decideEvidence, type EvidenceInputs } from "./evidence";

const ready: EvidenceInputs = {
  observedFullDays: 14,
  minimumReviewDays: 14,
  rollupCoverageComplete: true,
  allTenantsReady: true,
  allTenantsReliable: true,
  telemetryPipelineVerified: true,
  sessionSamplingDetected: false,
  measurementOnly: true,
  qualifiedSessions: 10,
  minimumQualifiedSessions: 10,
};

describe("scale-review evidence decision", () => {
  it("keeps the pilot collecting until the full observation window settles", () => {
    expect(decideEvidence({ ...ready, observedFullDays: 13 })).toEqual({ status: "collecting", blockers: ["observation_window"] });
  });

  it("blocks review when coverage, readiness, or exactness is not proven", () => {
    expect(decideEvidence({
      ...ready,
      rollupCoverageComplete: false,
      allTenantsReady: false,
      allTenantsReliable: false,
      telemetryPipelineVerified: false,
      sessionSamplingDetected: true,
    })).toEqual({ status: "collecting", blockers: ["rollup_coverage", "tenant_readiness", "tenant_reliability", "telemetry_pipeline", "qualified_session_sampling"] });
  });

  it("distinguishes insufficient natural traffic from an operational defect", () => {
    expect(decideEvidence({ ...ready, qualifiedSessions: 9 })).toEqual({ status: "insufficient_signal", blockers: ["qualified_sessions"] });
  });

  it("blocks review if monetization is active during the measurement-only pilot", () => {
    expect(decideEvidence({ ...ready, measurementOnly: false })).toEqual({ status: "collecting", blockers: ["monetization_state"] });
  });

  it("opens review only after every independent gate passes", () => {
    expect(decideEvidence(ready)).toEqual({ status: "review_ready", blockers: [] });
  });
});
