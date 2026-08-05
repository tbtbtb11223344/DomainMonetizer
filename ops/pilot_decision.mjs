export function pilotDecision({ guard, evidenceStatus }) {
  if (guard !== "PASS") {
    return {
      action: "repair_pilot",
      requiresUserReview: false,
      rationale: "An operational guard failed; repair and re-verify the existing pilot before interpreting traffic.",
    };
  }
  if (evidenceStatus === "insufficient_signal") {
    return {
      action: "do_not_scale",
      requiresUserReview: true,
      rationale: "The completed observation window did not produce the minimum exact qualified-session signal.",
    };
  }
  if (evidenceStatus === "review_ready") {
    return {
      action: "review_scale_candidate",
      requiresUserReview: true,
      rationale: "The evidence gate passed; review per-domain traffic quality before authorizing any expansion.",
    };
  }
  if (evidenceStatus !== "collecting") {
    return {
      action: "repair_pilot",
      requiresUserReview: false,
      rationale: "The control plane returned an unknown evidence status; reconcile the API contract before continuing.",
    };
  }
  return {
    action: "continue_collecting",
    requiresUserReview: false,
    rationale: "The clean observation window is still accumulating.",
  };
}

const evidenceStatuses = new Set(["collecting", "insufficient_signal", "review_ready"]);
const decisionOutcomeBlockers = new Set(["observation_window", "qualified_sessions"]);
const operationalBlockers = new Set([
  "rollup_coverage",
  "tenant_readiness",
  "tenant_reliability",
  "telemetry_pipeline",
  "qualified_session_sampling",
  "monetization_state",
]);

export function evidenceContractIssues({ evidenceStatus, reviewBlockers }) {
  const issues = [];
  if (!evidenceStatuses.has(evidenceStatus)) {
    issues.push(`Unknown evidence status: ${String(evidenceStatus)}`);
  }
  if (!Array.isArray(reviewBlockers)) {
    issues.push("Evidence blockers are missing or malformed");
    return issues;
  }
  for (const blocker of reviewBlockers) {
    if (operationalBlockers.has(blocker)) {
      issues.push(`Evidence gate reports ${blocker}`);
    } else if (!decisionOutcomeBlockers.has(blocker)) {
      issues.push(`Unknown evidence blocker: ${String(blocker)}`);
    }
  }
  if (evidenceStatus === "review_ready" && reviewBlockers.length > 0) {
    issues.push("review_ready is inconsistent with non-empty evidence blockers");
  }
  if (evidenceStatus === "insufficient_signal"
    && (reviewBlockers.length !== 1 || reviewBlockers[0] !== "qualified_sessions")) {
    issues.push("insufficient_signal is inconsistent with its evidence blockers");
  }
  if (evidenceStatus === "collecting" && reviewBlockers.length === 0) {
    issues.push("collecting is inconsistent with an empty evidence-blocker list");
  }
  return issues;
}
