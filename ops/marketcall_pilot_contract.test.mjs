import { describe, expect, it } from "vitest";
import spec from "./marketcall_pilot.json" with { type: "json" };
import { evaluateMarketcallPilotContract, expectedMarketcallRoutes } from "./marketcall_pilot_contract.mjs";

function baseline(overrides = {}) {
  return {
    mode: "economic_pilot",
    activeOffers: 3,
    activeCampaigns: 3,
    activeRoutingPolicies: 4,
    clicks: 0,
    conversions: 0,
    postbacks: 0,
    failedPostbacks: 0,
    rejectedPostbacks: 0,
    activeRoutes: expectedMarketcallRoutes(spec).map((route) => ({
      hostname: route.hostname,
      provider: route.provider,
      offer_external_id: route.offerExternalId,
      campaign_external_id: route.campaignExternalId,
      destination_type: route.destinationType,
      offer_status: "active",
      campaign_status: "active",
      routing_status: "active",
    })),
    ...overrides,
  };
}

describe("Marketcall economic-pilot contract", () => {
  it("accepts three approved campaigns across four exact domain placements", () => {
    expect(evaluateMarketcallPilotContract(baseline(), spec)).toEqual([]);
  });

  it("allows real click and conversion counters after activation", () => {
    expect(evaluateMarketcallPilotContract(baseline({ clicks: 9, conversions: 2, postbacks: 4 }), spec)).toEqual([]);
  });

  it("rejects missing or cross-domain pilot routes", () => {
    const routes = baseline().activeRoutes;
    routes[0] = { ...routes[0], campaign_external_id: "351040" };
    expect(evaluateMarketcallPilotContract(baseline({ activeRoutes: routes }), spec)).toContainEqual(
      expect.stringContaining("route set differs"),
    );
  });

  it("allows independently activated expansion routes", () => {
    const expanded = baseline();
    expanded.activeOffers = 4;
    expanded.activeCampaigns = 4;
    expanded.activeRoutingPolicies = 5;
    expanded.activeRoutes.push({
      hostname: "piedmontfloor.com",
      provider: "marketcall",
      offer_external_id: "10211",
      campaign_external_id: "351334",
      destination_type: "phone",
      offer_status: "active",
      campaign_status: "active",
      routing_status: "active",
    });
    expect(evaluateMarketcallPilotContract(expanded, spec)).toEqual([]);
  });

  it("fails on provider-processing errors and incorrect active counts", () => {
    expect(evaluateMarketcallPilotContract(baseline({ activeOffers: 2, failedPostbacks: 1 }), spec)).toEqual(expect.arrayContaining([
      "active offers=2, expected at least 3",
      "failed postbacks=1",
    ]));
  });
});
