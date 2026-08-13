function normalizedRoute(route) {
  return {
    hostname: String(route?.hostname ?? ""),
    provider: String(route?.provider ?? ""),
    offerExternalId: String(route?.offer_external_id ?? ""),
    campaignExternalId: String(route?.campaign_external_id ?? ""),
    destinationType: String(route?.destination_type ?? ""),
    offerStatus: String(route?.offer_status ?? ""),
    campaignStatus: String(route?.campaign_status ?? ""),
    routingStatus: String(route?.routing_status ?? ""),
  };
}

function routeKey(route) {
  return `${route.hostname}|${route.provider}|${route.offerExternalId}|${route.campaignExternalId}|${route.destinationType}`;
}

export function expectedMarketcallRoutes(spec) {
  const campaignsById = new Map(spec.campaigns.map((campaign) => [campaign.campaignId, campaign]));
  const primaryRoutes = spec.campaigns.map((campaign) => ({
    hostname: campaign.hostname,
    provider: spec.provider,
    offerExternalId: campaign.offerExternalId,
    campaignExternalId: campaign.campaignExternalId,
    destinationType: campaign.destinationType,
  }));
  const sharedRoutes = (spec.placements ?? []).map((placement) => {
    const campaign = campaignsById.get(placement.campaignId);
    if (!campaign) return null;
    return {
      hostname: placement.hostname,
      provider: spec.provider,
      offerExternalId: campaign.offerExternalId,
      campaignExternalId: campaign.campaignExternalId,
      destinationType: campaign.destinationType,
    };
  }).filter(Boolean);
  return [...primaryRoutes, ...sharedRoutes].sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
}

export function evaluateMarketcallPilotContract(monetization, spec) {
  const issues = [];
  if (!monetization || typeof monetization !== "object") return ["Monetization state is missing from the control-plane overview"];
  if (!spec || spec.mode !== "economic_pilot" || spec.provider !== "marketcall" || !Array.isArray(spec.campaigns) || spec.campaigns.length === 0 || !Array.isArray(spec.placements)) {
    return ["Committed Marketcall pilot contract is malformed"];
  }

  const expected = expectedMarketcallRoutes(spec);
  if (expected.length !== spec.campaigns.length + spec.placements.length) return ["Committed Marketcall placement references an unknown campaign"];
  const expectedOfferCount = new Set(spec.campaigns.map((campaign) => campaign.offerExternalId)).size;
  const expectedCampaignCount = new Set(spec.campaigns.map((campaign) => campaign.campaignExternalId)).size;
  const expectedRouteCount = expected.length;
  if (monetization.mode !== spec.mode) issues.push(`Monetization mode=${String(monetization.mode)}, expected ${spec.mode}`);
  for (const [label, value, expectedCount] of [
    ["active offers", monetization.activeOffers, expectedOfferCount],
    ["active campaigns", monetization.activeCampaigns, expectedCampaignCount],
    ["active routing policies", monetization.activeRoutingPolicies, expectedRouteCount],
  ]) {
    if (Number(value) < expectedCount) issues.push(`${label}=${Number(value)}, expected at least ${expectedCount}`);
  }
  for (const [label, value] of Object.entries({
    clicks: monetization.clicks,
    conversions: monetization.conversions,
    postbacks: monetization.postbacks,
  })) {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) issues.push(`${label} is not a valid non-negative count`);
  }
  if (Number(monetization.failedPostbacks ?? 0) !== 0) issues.push(`failed postbacks=${Number(monetization.failedPostbacks)}`);
  if (Number(monetization.rejectedPostbacks ?? 0) !== 0) issues.push(`rejected postbacks=${Number(monetization.rejectedPostbacks)}`);

  if (!Array.isArray(monetization.activeRoutes)) {
    issues.push("Active monetization routes are missing from the control-plane overview");
    return issues;
  }
  const actual = monetization.activeRoutes.map(normalizedRoute).sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
  const actualKeys = actual.map(routeKey);
  const expectedKeys = expected.map(routeKey);
  const expectedHostnames = new Set(expected.map((route) => route.hostname));
  const pilotActual = actual.filter((route) => expectedHostnames.has(route.hostname));
  const pilotActualKeys = pilotActual.map(routeKey);
  if (JSON.stringify(pilotActualKeys) !== JSON.stringify(expectedKeys)) {
    issues.push(`Active Marketcall route set differs from the committed pilot contract (observed ${actualKeys.join(", ") || "none"})`);
  }
  for (const route of pilotActual) {
    if (route.offerStatus !== "active" || route.campaignStatus !== "active" || route.routingStatus !== "active") {
      issues.push(`${route.hostname}: offer, campaign, and routing policy must all be active`);
    }
  }
  return issues;
}
