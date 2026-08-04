import { describe, expect, it } from "vitest";
import { evaluateProjectContract } from "./cloudflare_project_contract.mjs";

function baseline(overrides = {}) {
  return {
    billableSubscriptions: [],
    warnings: [],
    workers: ["domain-monetizer-control", "domain-monetizer-site-edge"],
    schedules: {
      "domain-monetizer-control": ["17 4 * * *", "47 */6 * * *"],
      "domain-monetizer-site-edge": [],
    },
    d1Databases: ["domain-monetizer"],
    kvNamespaces: ["domain-monetizer-site-config"],
    queues: [],
    accessApps: [{ name: "DomainMonetizer Admin", domain: "admin.multibrands.net", type: "self_hosted" }],
    workerBindings: [
      { worker: "domain-monetizer-control", bindings: [{ name: "DB", type: "d1" }] },
      { worker: "domain-monetizer-site-edge", bindings: [{ name: "EVENTS", type: "analytics_engine" }] },
    ],
    ...overrides,
  };
}

describe("Cloudflare free pilot contract", () => {
  it("accepts the exact free project inventory", () => {
    expect(evaluateProjectContract(baseline())).toEqual([]);
  });

  it("fails closed when schedules or inventory reads drift", () => {
    const inventory = baseline({
      warnings: ["Access inventory unavailable"],
      schedules: { "domain-monetizer-control": ["17 4 * * *"], "domain-monetizer-site-edge": [] },
    });
    expect(evaluateProjectContract(inventory)).toEqual(expect.arrayContaining([
      expect.stringContaining("inventory is incomplete"),
      expect.stringContaining("schedules differ"),
    ]));
  });

  it("rejects billable subscriptions and out-of-scope bindings", () => {
    const inventory = baseline({
      billableSubscriptions: [{ name: "Workers Paid" }],
      workerBindings: [{ worker: "domain-monetizer-control", bindings: [{ name: "UPLOADS", type: "r2_bucket" }] }],
    });
    expect(evaluateProjectContract(inventory)).toEqual(expect.arrayContaining([
      expect.stringContaining("positive-price"),
      expect.stringContaining("r2_bucket"),
    ]));
  });
});
