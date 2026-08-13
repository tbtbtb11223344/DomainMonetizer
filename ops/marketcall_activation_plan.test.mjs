import { describe, expect, it } from "vitest";
import { planMarketcallActivations, REQUIRED_MARKETCALL_POSTBACK_STATUSES } from "./marketcall_activation_plan.mjs";

function fixture() {
  return {
    provider: "marketcall",
    campaigns: [{
      offerId: "10211",
      offerTitle: "Flooring",
      offerVertical: "flooring",
      campaignId: "351334",
      campaignTitle: "Two flooring websites",
      campaignState: "approved",
      did: "+18442129585",
      didStatus: "approved",
      trafficSources: ["SEO"],
      materials: [
        { hostname: "piedmontfloor.com", materialId: "91806", materialState: "accepted" },
        { hostname: "marbleshooters.net", materialId: "91807", materialState: "manager_moderation" },
      ],
    }],
  };
}

function verifiedPostbacks() {
  return {
    campaigns: [{
      campaignId: "351334",
      postbacks: REQUIRED_MARKETCALL_POSTBACK_STATUSES.map((status, index) => ({ id: String(10_000 + index), status, active: true })),
    }],
  };
}

describe("per-website Marketcall activation planning", () => {
  it("allows an accepted website to activate while a shared-campaign website remains pending", () => {
    const plan = planMarketcallActivations(fixture(), verifiedPostbacks());
    expect(plan.placements.find((item) => item.hostname === "piedmontfloor.com")).toMatchObject({
      activationReady: true,
      routingPolicyId: "route_marketcall_351334",
      blockers: [],
    });
    expect(plan.placements.find((item) => item.hostname === "marbleshooters.net")).toMatchObject({
      activationReady: false,
      routingPolicyId: "route_marketcall_351334_marbleshooters_net",
      blockers: ["material_not_accepted"],
    });
  });

  it("keeps an approved website dormant until all six campaign postbacks are verified", () => {
    const plan = planMarketcallActivations(fixture());
    expect(plan.placements[0]).toMatchObject({
      providerReady: true,
      activationReady: false,
      blockers: ["postbacks_not_verified"],
    });
  });

  it("rejects non-SEO and invalid DID configurations", () => {
    const applications = fixture();
    applications.campaigns[0].trafficSources = ["SEO", "PPC"];
    applications.campaigns[0].did = "8442129585";
    const plan = planMarketcallActivations(applications, verifiedPostbacks());
    expect(plan.placements[0].blockers).toEqual(expect.arrayContaining(["did_invalid", "traffic_source_not_seo_only"]));
  });
});
