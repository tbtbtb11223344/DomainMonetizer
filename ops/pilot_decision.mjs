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
  return {
    action: "continue_collecting",
    requiresUserReview: false,
    rationale: "The clean observation window is still accumulating.",
  };
}
