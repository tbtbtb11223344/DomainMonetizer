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
const accumulatingQualityBlockers = new Set([
  "tenant_reliability",
  "telemetry_pipeline",
  "qualified_session_sampling",
]);

export function rollupCoveragePending({
  now = new Date(),
  latestCompletedDate,
  observedFullDays,
  expectedFullDays,
  latestRun,
}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(latestCompletedDate ?? ""))) return false;
  const observed = Number(observedFullDays);
  const expected = Number(expectedFullDays);
  if (!Number.isInteger(observed) || !Number.isInteger(expected) || expected - observed !== 1) return false;

  const graceDeadlineMinutesUtc = 4 * 60 + 27;
  const currentMinutesUtc = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (currentMinutesUtc >= graceDeadlineMinutesUtc) return false;

  const expectedLatest = new Date(now);
  expectedLatest.setUTCHours(0, 0, 0, 0);
  expectedLatest.setUTCDate(expectedLatest.getUTCDate() - 1);
  if (latestCompletedDate !== expectedLatest.toISOString().slice(0, 10)) return false;
  if (expected === 1 && observed === 0 && !latestRun) return true;
  if (latestRun?.status !== "succeeded" || !/^\d{4}-\d{2}-\d{2}$/u.test(String(latestRun.metric_date ?? ""))) return false;

  const nextRunDate = new Date(`${latestRun.metric_date}T00:00:00.000Z`);
  nextRunDate.setUTCDate(nextRunDate.getUTCDate() + 1);
  return nextRunDate.toISOString().slice(0, 10) === latestCompletedDate;
}

export function evidenceContractIssues({ evidenceStatus, reviewBlockers, pendingRollupCoverage = false }) {
  const issues = [];
  if (!evidenceStatuses.has(evidenceStatus)) {
    issues.push(`Unknown evidence status: ${String(evidenceStatus)}`);
  }
  if (!Array.isArray(reviewBlockers)) {
    issues.push("Evidence blockers are missing or malformed");
    return issues;
  }
  const observationWindowOpen = reviewBlockers.includes("observation_window");
  for (const blocker of reviewBlockers) {
    if (operationalBlockers.has(blocker)) {
      if (blocker === "rollup_coverage" && pendingRollupCoverage) {
        continue;
      }
      if (!(observationWindowOpen && accumulatingQualityBlockers.has(blocker))) {
        issues.push(`Evidence gate reports ${blocker}`);
      }
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

export function currentDayCanaryIssues({ schedule, rows, allowedDomainIds }) {
  if (!schedule || Number(schedule.requiredByNowPerDomain ?? 0) === 0) return [];
  if (!Array.isArray(rows)) return ["Current-day Analytics Engine canaries are missing or malformed"];

  const issues = [];
  const allowed = allowedDomainIds ? new Set(allowedDomainIds) : null;
  if (allowed && (allowed.size === 0 || [...allowed].some((value) => typeof value !== "string" || !/^dom_[a-f0-9]+$/u.test(value)))) {
    return ["Current-day canary scope is empty or contains invalid domain IDs"];
  }
  const domains = (Array.isArray(schedule.domains) ? schedule.domains : [])
    .filter((domain) => !allowed || allowed.has(domain.domainId));
  const expectedDomainIds = new Set(domains.map((domain) => domain.domainId));
  const rowByDomain = new Map(rows.map((row) => [row.domain_id, row]));
  for (const row of rows) {
    if (!expectedDomainIds.has(row.domain_id)) {
      issues.push(`Unexpected current-day health canary domain: ${String(row.domain_id)}`);
    }
  }
  for (const domain of domains) {
    const row = rowByDomain.get(domain.domainId);
    const observedCanaries = Number(row?.distinct_canaries ?? 0);
    const maxSampleInterval = Number(row?.max_sample_interval ?? 1);
    const required = Number(domain.requiredByNow ?? schedule.requiredByNowPerDomain ?? 0);
    const storedChecks = Number(domain.observedChecks ?? 0);
    if (observedCanaries < required || observedCanaries > storedChecks) {
      issues.push(`${domain.hostname}: current-day scheduled canaries=${observedCanaries}, required=${required}, stored checks=${storedChecks}`);
    }
    if (maxSampleInterval !== 1) {
      issues.push(`${domain.hostname}: current-day health canary query is sampled at ${maxSampleInterval}`);
    }
  }
  return issues;
}
