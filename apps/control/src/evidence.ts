export type EvidenceStatus = "collecting" | "insufficient_signal" | "review_ready";

export interface EvidenceInputs {
  observedFullDays: number;
  decisionGradeDays: number;
  minimumReviewDays: number;
  rollupCoverageComplete: boolean;
  allTenantsReady: boolean;
  allTenantsReliable: boolean;
  telemetryPipelineVerified: boolean;
  sessionSamplingDetected: boolean;
  measurementOnly: boolean;
  qualifiedSessions: number;
  minimumQualifiedSessions: number;
}

export interface EvidenceDecision {
  status: EvidenceStatus;
  blockers: string[];
}

export function decideEvidence(inputs: EvidenceInputs): EvidenceDecision {
  const blockers = [
    ...(inputs.decisionGradeDays < inputs.minimumReviewDays ? ["observation_window"] : []),
    ...(!inputs.rollupCoverageComplete ? ["rollup_coverage"] : []),
    ...(!inputs.allTenantsReady ? ["tenant_readiness"] : []),
    ...(!inputs.allTenantsReliable ? ["tenant_reliability"] : []),
    ...(!inputs.telemetryPipelineVerified ? ["telemetry_pipeline"] : []),
    ...(inputs.sessionSamplingDetected ? ["qualified_session_sampling"] : []),
    ...(!inputs.measurementOnly ? ["monetization_state"] : []),
    ...(inputs.observedFullDays >= inputs.minimumReviewDays && inputs.qualifiedSessions < inputs.minimumQualifiedSessions ? ["qualified_sessions"] : []),
  ];
  const operationalBlocker = blockers.some((blocker) => blocker !== "qualified_sessions");
  return {
    status: operationalBlocker
      ? "collecting"
      : blockers.includes("qualified_sessions")
        ? "insufficient_signal"
        : "review_ready",
    blockers,
  };
}
