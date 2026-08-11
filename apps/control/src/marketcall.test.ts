import { describe, expect, it } from "vitest";
import { resolveClickDestination, type OfferSelection } from "./api";
import { parseMarketcallFields, resolveConversionDomain } from "./marketcall";

function selection(overrides: Partial<OfferSelection> = {}): OfferSelection {
  return {
    campaign_id: null,
    offer_id: "offer_test",
    provider: "marketcall",
    destination_url: "https://tracking.example/offer?source=domain-monetizer",
    offer_metadata_json: "{}",
    campaign_destination_type: null,
    campaign_destination_value: null,
    campaign_metadata_json: null,
    ...overrides,
  };
}

describe("affiliate click destinations", () => {
  it("adds the click id to an HTTPS redirect without losing existing parameters", () => {
    const result = resolveClickDestination(selection(), "clk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.type).toBe("redirect");
    expect(new URL(result.value).searchParams.get("source")).toBe("domain-monetizer");
    expect(new URL(result.value).searchParams.get("subid")).toBe("clk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("uses campaign metadata and destination for approved redirect campaigns", () => {
    const result = resolveClickDestination(selection({
      campaign_destination_type: "redirect",
      campaign_destination_value: "https://campaign.example/start",
      campaign_metadata_json: '{"clickIdParam":"click_id"}',
    }), "clk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(new URL(result.value).searchParams.get("click_id")).toBe("clk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("returns only a validated E.164 phone destination", () => {
    expect(resolveClickDestination(selection({
      campaign_destination_type: "phone",
      campaign_destination_value: "+18005550123",
    }), "clk_cccccccccccccccccccccccccccccccc")).toEqual({ type: "phone", value: "+18005550123" });
    expect(() => resolveClickDestination(selection({
      campaign_destination_type: "phone",
      campaign_destination_value: "(800) 555-0123",
    }), "clk_cccccccccccccccccccccccccccccccc")).toThrow("Invalid campaign phone destination");
  });

  it("rejects non-HTTPS redirect destinations", () => {
    expect(() => resolveClickDestination(selection({ destination_url: "http://tracking.example/offer" }), "clk_dddddddddddddddddddddddddddddddd"))
      .toThrow("Unsafe offer destination");
  });
});

describe("Marketcall postback parsing", () => {
  it("accepts a settled USD call without collecting caller data", () => {
    const input = parseMarketcallFields(new URLSearchParams({
      event_id: "call-123",
      campaign_id: "235812",
      subid: "clk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      outcome: "accepted",
      status: "Approved",
      payout: "21.00",
      currency: "USD",
      occurred_at: "2026-08-10T09:30:00Z",
      caller_phone: "+15555550100",
    }));
    expect(input).toEqual({
      eventId: "call-123",
      campaignId: "235812",
      clickId: "clk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      outcome: "accepted",
      providerStatus: "Approved",
      payoutUsd: 21,
      occurredAt: "2026-08-10T09:30:00.000Z",
    });
    expect(input).not.toHaveProperty("caller_phone");
  });

  it("does not recognize pending payout as settled revenue", () => {
    const input = parseMarketcallFields(new URLSearchParams({
      tid: "call.456",
      program_id: "235812",
      outcome: "pending",
      state_title: "Processing",
      earn: "21",
    }));
    expect(input.payoutUsd).toBeNull();
  });

  it("rejects unsupported currency, untrusted outcome, and malformed click ids", () => {
    expect(() => parseMarketcallFields(new URLSearchParams({ event_id: "1", campaign_id: "2", outcome: "accepted", payout: "10", currency: "EUR" }))).toThrow("Unsupported currency");
    expect(() => parseMarketcallFields(new URLSearchParams({ event_id: "1", campaign_id: "2", outcome: "paid" }))).toThrow();
    expect(() => parseMarketcallFields(new URLSearchParams({ event_id: "1", campaign_id: "2", outcome: "accepted", subid: "visitor@example.com" }))).toThrow();
  });
});

describe("Marketcall conversion attribution", () => {
  const campaign = { id: "camp_hvac", offer_id: "offer_hvac", domain_id: "dom_primary" };

  it("attributes a dedicated campaign to its only assigned domain", () => {
    expect(resolveConversionDomain(campaign, ["dom_primary"], null)).toBe("dom_primary");
  });

  it("keeps a shared-DID conversion unattributed without a click id", () => {
    expect(resolveConversionDomain(campaign, ["dom_primary", "dom_shared"], null)).toBeNull();
  });

  it("uses an exact click only when its domain has the campaign placement", () => {
    expect(resolveConversionDomain(campaign, ["dom_primary", "dom_shared"], {
      id: "clk_test",
      offer_id: "offer_hvac",
      domain_id: "dom_shared",
    })).toBe("dom_shared");
    expect(() => resolveConversionDomain(campaign, ["dom_primary", "dom_shared"], {
      id: "clk_test",
      offer_id: "offer_hvac",
      domain_id: "dom_other",
    })).toThrow("Click attribution mismatch");
  });
});
