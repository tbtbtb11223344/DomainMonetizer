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

function environment(overrides: Record<string, string> = {}, state: "live" | "paused" = "live") {
  const snapshot = releaseSnapshotSchema.parse({
    schemaVersion: 1,
    releaseId: "rel_test",
    domainId: "dom_test",
    hostname: "pilot-example.com",
    state,
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
    const contentSecurityPolicy = response.headers.get("Content-Security-Policy");
    expect(contentSecurityPolicy).toContain("default-src 'none'");
    expect(contentSecurityPolicy).toContain("connect-src 'self'");
    expect(contentSecurityPolicy).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(contentSecurityPolicy).not.toContain("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(events).toHaveLength(1);
    const point = events[0] as { blobs: string[] };
    expect(point.blobs[3]).toBe("unknown");
    expect(point.blobs[6]).toMatch(/^[a-f0-9]{64}$/);
    expect(point.blobs[7]).toBe("missing_ua");
  });

  it("qualifies browser navigations and keeps a stable anonymous session hash", async () => {
    const { env, events } = environment();
    const view = await worker.fetch(new Request("https://pilot-example.com/", {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      },
    }), env as never);
    const cookie = view.headers.get("Set-Cookie")?.match(/dm_vid=([a-f0-9]{32})/)?.[1];
    expect(cookie).toBeTruthy();
    const viewPoint = events[0] as { blobs: string[] };
    expect(viewPoint.blobs[3]).toBe("human");
    expect(viewPoint.blobs[7]).toBe("browser_navigation");

    const engagement = await worker.fetch(new Request("https://pilot-example.com/events/engaged", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `dm_vid=${cookie}`,
        "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      },
      body: JSON.stringify({ releaseId: "rel_test" }),
    }), env as never);
    expect(engagement.status).toBe(204);
    const engagementPoint = events[1] as { blobs: string[] };
    expect(engagementPoint.blobs[3]).toBe("human");
    expect(engagementPoint.blobs[6]).toBe(viewPoint.blobs[6]);
  });

  it("does not count HEAD probes as page views", async () => {
    const { env, events } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/", { method: "HEAD" }), env as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("distinguishes shared liveness from tenant readiness without recording traffic", async () => {
    const { env, events } = environment();
    const service = await worker.fetch(new Request("https://unknown-example.com/healthz"), env as never);
    const ready = await worker.fetch(new Request("https://pilot-example.com/readyz"), env as never);
    const readyPayload = await ready.json() as { ok: boolean; hostname: string; state: string; releaseId: string };

    expect(service.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(readyPayload).toEqual({ ok: true, service: "site-edge", hostname: "pilot-example.com", state: "live", releaseId: "rel_test" });
    expect(ready.headers.get("Cache-Control")).toBe("no-store");
    expect(ready.headers.get("Set-Cookie")).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("fails tenant readiness for missing and paused releases", async () => {
    const liveEnvironment = environment();
    const missing = await worker.fetch(new Request("https://unknown-example.com/readyz"), liveEnvironment.env as never);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ ok: false, hostname: "unknown-example.com", state: "missing" });

    const pausedEnvironment = environment({}, "paused");
    const paused = await worker.fetch(new Request("https://pilot-example.com/readyz"), pausedEnvironment.env as never);
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({ ok: false, hostname: "pilot-example.com", state: "paused", releaseId: "rel_test" });
  });

  it("supports bodyless tenant readiness probes", async () => {
    const { env, events } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/readyz", { method: "HEAD" }), env as never);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("keeps static assets cacheable while tenant HTML remains uncached", async () => {
    const { env, events } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/__dm/site-v2.css"), env as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400, immutable");
    expect(await response.text()).toBe("asset");
    expect(events).toHaveLength(0);
  });

  it("classifies automation user agents as bots", async () => {
    const { env, events } = environment();
    await worker.fetch(new Request("https://pilot-example.com/", { headers: { "User-Agent": "Mozilla/5.0 compatible; research-bot/1.0" } }), env as never);
    const point = events[0] as { blobs: string[] };
    expect(point.blobs[3]).toBe("bot");
    expect(point.blobs[7]).toBe("ua_automation");
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
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("does not allow undeclared offer slots", async () => {
    const { env } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/go/primary"), env as never);
    expect(response.status).toBe(404);
  });
});
