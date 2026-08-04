import { compileHomeServicesHtml, contentSchema, releaseSnapshotSchema } from "@domain-monetizer/core";
import { describe, expect, it } from "vitest";
import worker from "./index";

const content = contentSchema.parse({
  schemaVersion: 1,
  locale: "en-US",
  vertical: "appliance repair",
  location: { city: "Tulsa", region: "OK", country: "US" },
  seo: { title: "Appliance repair guide in Tulsa", description: "Learn how to compare appliance repair providers in Tulsa, Oklahoma." },
  hero: { eyebrow: "A practical local guide", title: "Find the right appliance repair option", summary: "Compare providers, understand useful questions, and make a more informed choice." },
  servicesHeading: "A clearer way to compare repair providers",
  services: [
    { title: "Check experience", description: "Ask whether the provider regularly handles your appliance type and brand." },
    { title: "Confirm the estimate", description: "Understand diagnostic charges, parts, labor, and warranty terms before work starts." },
  ],
  guide: { heading: "Questions worth asking", paragraphs: ["Describe the symptom and ask what diagnostic process the provider uses.", "Confirm pricing structure, licensing requirements, and workmanship guarantees."] },
  faqHeading: "Appliance repair questions",
  faqs: [
    { question: "Should I repair or replace?", answer: "Age, repair cost, efficiency, and parts availability all matter." },
    { question: "What should an estimate include?", answer: "Look for diagnostic fees, labor, parts, taxes, and warranty information." },
  ],
  cta: { label: "Compare local options", supportingText: "Availability and eligibility vary by location.", slot: "primary" },
  disclosure: "This is an independent referral website and is not the former business that may have used this domain. We may receive compensation when you contact a provider.",
  image: { assetPath: "/__dm/assets/home-services-hero.webp", alt: "A technician checking a home appliance" },
});

function environment(overrides: Record<string, string> = {}) {
  const snapshot = releaseSnapshotSchema.parse({
    schemaVersion: 1,
    releaseId: "rel_test",
    domainId: "dom_test",
    hostname: "pilot-example.com",
    state: "live",
    templateKey: "home-services",
    content,
    offerSlots: [{ slot: "primary", enabled: false }],
    html: compileHomeServicesHtml({ content, hostname: "pilot-example.com", releaseId: "rel_test", offerEnabled: false }),
    compiledAt: "2026-08-04T12:00:00.000Z",
  });
  const values = new Map<string, string>([
    ["site:pilot-example.com:active", "rel_test"],
    ["release:rel_test", JSON.stringify(snapshot)],
    ...Object.entries(overrides),
  ]);
  const events: unknown[] = [];
  return {
    env: {
      SITE_CONFIG: { get: async (key: string) => values.get(key) ?? null },
      EVENTS: { writeDataPoint: (point: unknown) => events.push(point) },
      CONTROL: { fetch: async () => new Response(null, { status: 404 }) },
      ASSETS: { fetch: async () => new Response("asset") },
      ENVIRONMENT: "test",
      CONTROL_SHARED_SECRET: "test-secret",
      VISITOR_HASH_SALT: "test-salt",
    },
    events,
  };
}

describe("site edge", () => {
  it("serves the tenant selected by hostname with security headers", async () => {
    const { env, events } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/"), env as never);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("independent referral website");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(events).toHaveLength(1);
  });

  it("fails closed when the hostname has no active release", async () => {
    const { env } = environment();
    const response = await worker.fetch(new Request("https://unknown-example.com/"), env as never);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects www requests to the canonical apex hostname", async () => {
    const { env } = environment();
    const response = await worker.fetch(new Request("https://www.pilot-example.com/help?from=www"), env as never);
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://pilot-example.com/help?from=www");
  });

  it("does not allow undeclared offer slots", async () => {
    const { env } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/go/primary"), env as never);
    expect(response.status).toBe(404);
  });
});
