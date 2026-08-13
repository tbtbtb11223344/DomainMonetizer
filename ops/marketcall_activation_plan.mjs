export const REQUIRED_MARKETCALL_POSTBACK_STATUSES = [
  "parsed",
  "hold",
  "approved",
  "refused",
  "non_qualified",
  "no_connect",
];

function normalizedState(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function routeSuffix(hostname) {
  return String(hostname).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function postbackStatusSet(postbacks, campaignId) {
  const campaign = (postbacks?.campaigns ?? []).find((item) => String(item.campaignId) === String(campaignId));
  if (!campaign || !Array.isArray(campaign.postbacks)) return new Set();
  return new Set(campaign.postbacks
    .filter((item) => item?.active === true && String(item?.id ?? "").trim())
    .map((item) => normalizedState(item.status)));
}

function hasRequiredPostbacks(postbacks, campaignId) {
  const observed = postbackStatusSet(postbacks, campaignId);
  return REQUIRED_MARKETCALL_POSTBACK_STATUSES.every((status) => observed.has(status));
}

export function planMarketcallActivations(applications, postbacks = { campaigns: [] }) {
  if (!applications || applications.provider !== "marketcall" || !Array.isArray(applications.campaigns)) {
    throw new Error("Marketcall application ledger is malformed");
  }

  const campaignIds = new Set();
  const hostnames = new Set();
  const materialIds = new Set();
  const campaigns = [];
  const placements = [];

  for (const campaign of applications.campaigns) {
    const campaignExternalId = String(campaign.campaignId ?? "");
    const offerExternalId = String(campaign.offerId ?? "");
    if (!/^\d+$/u.test(campaignExternalId) || !/^\d+$/u.test(offerExternalId)) {
      throw new Error("Marketcall application ledger has an invalid campaign or offer identifier");
    }
    if (campaignIds.has(campaignExternalId)) throw new Error(`Duplicate Marketcall campaign ${campaignExternalId}`);
    campaignIds.add(campaignExternalId);
    if (!Array.isArray(campaign.materials) || campaign.materials.length === 0) {
      throw new Error(`Marketcall campaign ${campaignExternalId} has no website materials`);
    }

    const campaignBlockers = [];
    if (normalizedState(campaign.campaignState) !== "approved") campaignBlockers.push("campaign_not_approved");
    if (normalizedState(campaign.didStatus) !== "approved") campaignBlockers.push("did_not_approved");
    if (!/^\+1\d{10}$/u.test(String(campaign.did ?? ""))) campaignBlockers.push("did_invalid");
    if (JSON.stringify(campaign.trafficSources ?? []) !== JSON.stringify(["SEO"])) campaignBlockers.push("traffic_source_not_seo_only");
    const postbacksReady = hasRequiredPostbacks(postbacks, campaignExternalId);
    if (!postbacksReady) campaignBlockers.push("postbacks_not_verified");

    const normalizedCampaign = {
      ...campaign,
      offerExternalId,
      campaignExternalId,
      offerId: `off_marketcall_${offerExternalId}`,
      campaignId: `camp_marketcall_${campaignExternalId}`,
      providerReady: campaignBlockers.every((blocker) => blocker === "postbacks_not_verified"),
      postbacksReady,
      blockers: campaignBlockers,
    };
    campaigns.push(normalizedCampaign);

    campaign.materials.forEach((material, index) => {
      const hostname = String(material.hostname ?? "").trim().toLowerCase();
      const materialExternalId = String(material.materialId ?? "");
      if (!hostname || hostnames.has(hostname)) throw new Error(`Duplicate or missing Marketcall website ${hostname || "unknown"}`);
      if (!/^\d+$/u.test(materialExternalId) || materialIds.has(materialExternalId)) {
        throw new Error(`Duplicate or invalid Marketcall material ${materialExternalId || "unknown"}`);
      }
      hostnames.add(hostname);
      materialIds.add(materialExternalId);
      const blockers = [...campaignBlockers];
      if (normalizedState(material.materialState) !== "accepted") blockers.push("material_not_accepted");
      placements.push({
        ...material,
        hostname,
        materialExternalId,
        offerExternalId,
        campaignExternalId,
        offerId: normalizedCampaign.offerId,
        campaignId: normalizedCampaign.campaignId,
        routingPolicyId: index === 0
          ? `route_marketcall_${campaignExternalId}`
          : `route_marketcall_${campaignExternalId}_${routeSuffix(hostname)}`,
        did: String(campaign.did ?? ""),
        offerTitle: String(campaign.offerTitle ?? ""),
        campaignTitle: String(campaign.campaignTitle ?? ""),
        offerVertical: String(campaign.offerVertical ?? "").trim(),
        providerReady: blockers.every((blocker) => blocker === "postbacks_not_verified"),
        activationReady: blockers.length === 0,
        blockers,
      });
    });
  }

  return { campaigns, placements };
}
