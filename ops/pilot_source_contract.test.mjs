import { describe, expect, it } from "vitest";
import { evaluatePilotSources } from "./pilot_source_contract.mjs";

const expected = [{ hostname: "example.com", vertical: "hvac", country: "US", sourceLabels: ["DomainMonetizer"] }];

describe("pilot source contract", () => {
  it("accepts an exact live source match", () => {
    expect(evaluatePilotSources(expected, { scored_candidates: [{ domain: "example.com", vertical: "hvac", country_signal: "US", risk_flags: [], labels: ["DomainMonetizer"] }] })).toEqual([]);
  });

  it("fails when a selected domain is no longer source-eligible", () => {
    expect(evaluatePilotSources(expected, { scored_candidates: [] })).toEqual([
      "example.com: no longer matches parking + available + no Traffic2 source eligibility",
    ]);
  });

  it("reports classification and risk drift", () => {
    const issues = evaluatePilotSources(expected, { scored_candidates: [{ domain: "example.com", vertical: "roofing", country_signal: "CA", risk_flags: ["former_business_identity"], labels: ["Traffic2"] }] });
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("vertical drifted"),
      expect.stringContaining("country drifted"),
      expect.stringContaining("risk flags"),
      expect.stringContaining("Traffic2"),
    ]));
  });

  it("fails when the DomainMonetizer protection label is missing", () => {
    expect(evaluatePilotSources(expected, { scored_candidates: [{ domain: "example.com", vertical: "hvac", country_signal: "US", risk_flags: [], labels: [] }] })).toEqual([
      "example.com: required source label is missing (DomainMonetizer)",
    ]);
  });
});
