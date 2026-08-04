export type EvidenceStatus = "collecting" | "insufficient_signal" | "review_ready";

export interface EvidenceInputs {
  observedFullDays: number;
  minimumReviewDays: number;
  rollupCoverageComplete: boolean;
  allTenantsReady: boolean;
  sessionSamplingDetected: boolean;
  qualifiedSessions: number;
  minimumQualifiedSessions: number;
}

export interface EvidenceDecision {
  status: EvidenceStatus;
  blockers: string[];
}

export function decideEvidence(inputs: EvidenceInputs): EvidenceDecision {
  const blockers = [
    ...(inputs.observedFullDays < inputs.minimumReviewDays ? ["observation_window"] : []),
    ...(!inputs.rollupCoverageComplete ? ["rollup_coverage"] : []),
    ...(!inputs.allTenantsReady ? ["tenant_readiness"] : []),
    ...(inputs.sessionSamplingDetected ? ["qualified_session_sampling"] : []),
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
