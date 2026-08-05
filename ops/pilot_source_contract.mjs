function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function evaluatePilotSources(expectedDomains, collected) {
  const issues = [];
  const candidates = new Map((collected.scored_candidates ?? []).map((candidate) => [normalized(candidate.domain), candidate]));
  for (const expected of expectedDomains) {
    const hostname = normalized(expected.hostname);
    const candidate = candidates.get(hostname);
    if (!candidate) {
      issues.push(`${hostname}: no longer matches parking + available + no Traffic2 source eligibility`);
      continue;
    }
    if (normalized(candidate.vertical) !== normalized(expected.vertical)) {
      issues.push(`${hostname}: DomainAnalyzer vertical drifted from ${expected.vertical} to ${candidate.vertical || "unclassified"}`);
    }
    if (normalized(candidate.country_signal) !== normalized(expected.country)) {
      issues.push(`${hostname}: DomainAnalyzer country drifted from ${expected.country} to ${candidate.country_signal || "unclassified"}`);
    }
    const riskFlags = Array.isArray(candidate.risk_flags) ? candidate.risk_flags : [];
    if (riskFlags.length) issues.push(`${hostname}: source risk flags are present (${riskFlags.join(", ")})`);
    const labels = Array.isArray(candidate.labels) ? candidate.labels : [];
    const labelKeys = new Set(labels.map(normalized));
    if (labelKeys.has("traffic2")) issues.push(`${hostname}: Traffic2 label is present`);
    const missingLabels = (expected.sourceLabels ?? [])
      .filter((label) => !labelKeys.has(normalized(label)));
    if (missingLabels.length) {
      issues.push(`${hostname}: required source label is missing (${missingLabels.join(", ")})`);
    }
  }
  const expectedSet = new Set(expectedDomains.map((domain) => normalized(domain.hostname)));
  const unexpected = [...candidates.keys()].filter((hostname) => !expectedSet.has(hostname)).sort();
  if (unexpected.length) issues.push(`Unexpected domains returned by the exact source audit: ${unexpected.join(", ")}`);
  return issues;
}
