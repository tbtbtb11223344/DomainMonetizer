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
    d1DatabaseSizes: [{ name: "domain-monetizer", bytes: 643072 }],
    kvNamespaces: ["domain-monetizer-site-config"],
    queues: [],
    accessApps: [{ name: "DomainMonetizer Admin", domain: "admin.multibrands.net", type: "self_hosted" }],
    workerDomains: [
      { hostname: "admin.multibrands.net", service: "domain-monetizer-control", environment: "production" },
      { hostname: "webhooks.multibrands.net", service: "domain-monetizer-control", environment: "production" },
      { hostname: "heavenlyaircondition.com", service: "domain-monetizer-site-edge", environment: "production" },
      { hostname: "mcneillsappliance.com", service: "domain-monetizer-site-edge", environment: "production" },
      { hostname: "phoenixroofcoating.net", service: "domain-monetizer-site-edge", environment: "production" },
      { hostname: "preview.multibrands.net", service: "domain-monetizer-site-edge", environment: "production" },
      { hostname: "www.heavenlyaircondition.com", service: "domain-monetizer-site-edge", environment: "production" },
      { hostname: "www.mcneillsappliance.com", service: "domain-monetizer-site-edge", environment: "production" },
      { hostname: "www.phoenixroofcoating.net", service: "domain-monetizer-site-edge", environment: "production" },
    ],
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

  it("fails before D1 growth can silently consume the free database limit", () => {
    const inventory = baseline({
      d1DatabaseSizes: [{ name: "domain-monetizer", bytes: 50 * 1024 * 1024 + 1 }],
    });
    expect(evaluateProjectContract(inventory)).toEqual([
      expect.stringContaining("50 MiB pilot guard"),
    ]);
  });

  it("fails closed when the D1 size cannot be verified", () => {
    const inventory = baseline({
      d1DatabaseSizes: [{ name: "domain-monetizer", bytes: null }],
    });
    expect(evaluateProjectContract(inventory)).toEqual([
      expect.stringContaining("size unavailable"),
    ]);
  });

  it("fails closed when the D1 size inventory is omitted", () => {
    const inventory = baseline();
    delete inventory.d1DatabaseSizes;
    expect(evaluateProjectContract(inventory)).toEqual([
      expect.stringContaining("size is unavailable"),
    ]);
  });

  it("rejects an unexpected Worker custom domain", () => {
    const inventory = baseline();
    inventory.workerDomains.push({ hostname: "unexpected.example", service: "domain-monetizer-site-edge", environment: "production" });
    expect(evaluateProjectContract(inventory)).toEqual([
      expect.stringContaining("Worker domains differ"),
    ]);
  });
});
