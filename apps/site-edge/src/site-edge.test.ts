import { compileHomeServicesHtml, contentSchema, hmacSha256Hex, releaseSnapshotSchema, sha256Hex } from "@domain-monetizer/core";
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

function environment(overrides: Record<string, string> = {}, state: "live" | "paused" = "live", envOverrides: Record<string, unknown> = {}) {
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
      ...envOverrides,
    },
    events,
  };
}

function responseCookie(response: Response, name: string): string | undefined {
  return response.headers.get("Set-Cookie")?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`))?.[1];
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

  it("qualifies a browser once per hostname and UTC day", async () => {
    const { env, events } = environment();
    const browserHeaders = {
      Accept: "text/html,application/xhtml+xml",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
    };
    const view = await worker.fetch(new Request("https://pilot-example.com/", { headers: browserHeaders }), env as never);
    const visitorCookie = responseCookie(view, "dm_vid");
    const qualifiedCookie = responseCookie(view, "dm_qd");
    expect(visitorCookie).toMatch(/^[a-f0-9]{32}$/);
    expect(qualifiedCookie).toMatch(/^\d{8}\.[a-f0-9]{64}$/);
    expect(view.headers.get("Set-Cookie")).toContain("Max-Age=1800");
    const viewPoint = events[0] as { blobs: string[] };
    expect(viewPoint.blobs[3]).toBe("human");
    expect(viewPoint.blobs[7]).toBe("browser_navigation");
    const firstSessionPoint = events[1] as { blobs: string[]; indexes: string[] };
    expect(firstSessionPoint.blobs).toEqual(["qualified_session_v4", "pilot-example.com", "dom_test", "rel_test", "XX"]);
    expect(firstSessionPoint.indexes).toEqual([`qualified_v4:dom_test:${viewPoint.blobs[6]![0]}`]);

    const cookieHeader = `dm_vid=${visitorCookie}; dm_qd=${qualifiedCookie}`;
    await worker.fetch(new Request("https://pilot-example.com/services/repair", {
      headers: { ...browserHeaders, Cookie: cookieHeader },
    }), env as never);

    const engagement = await worker.fetch(new Request("https://pilot-example.com/events/engaged", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Origin: "https://pilot-example.com",
        "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      },
      body: JSON.stringify({ releaseId: "rel_test" }),
    }), env as never);
    expect(engagement.status).toBe(204);
    expect(responseCookie(engagement, "dm_qd")).toBeUndefined();
    const engagementPoint = events[3] as { blobs: string[] };
    expect(engagementPoint.blobs[3]).toBe("human");
    expect(engagementPoint.blobs[6]).toBe(viewPoint.blobs[6]);
    expect(events.filter((point) => (point as { blobs: string[] }).blobs[0] === "qualified_session_v4")).toHaveLength(1);
  });

  it("lets a verified same-origin interaction qualify an initially unknown browser", async () => {
    const { env, events } = environment();
    const view = await worker.fetch(new Request("https://pilot-example.com/"), env as never);
    const visitorCookie = responseCookie(view, "dm_vid");
    expect(responseCookie(view, "dm_qd")).toBeUndefined();

    const engagement = await worker.fetch(new Request("https://pilot-example.com/events/engaged", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `dm_vid=${visitorCookie}`,
        Origin: "https://pilot-example.com",
        "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      },
      body: JSON.stringify({ releaseId: "rel_test" }),
    }), env as never);

    expect(engagement.status).toBe(204);
    expect(responseCookie(engagement, "dm_qd")).toMatch(/^\d{8}\.[a-f0-9]{64}$/);
    expect(events.map((point) => (point as { blobs: string[] }).blobs[0])).toEqual(["view", "engaged", "qualified_session_v4"]);
  });

  it("does not issue a session or record visitor events for a secret-hashed excluded source IP", async () => {
    const excludedIp = "203.0.113.19";
    const salt = "a".repeat(64);
    const excludedHash = await sha256Hex(`${salt}:${excludedIp}`);
    const { env, events } = environment({}, "live", { TELEMETRY_EXCLUSION_SECRET: `v1:${salt}:${excludedHash}` });
    const browserHeaders = {
      Accept: "text/html,application/xhtml+xml",
      "CF-Connecting-IP": excludedIp,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
    };

    const view = await worker.fetch(new Request("https://pilot-example.com/", { headers: browserHeaders }), env as never);
    expect(view.status).toBe(200);
    expect(view.headers.get("X-DM-Telemetry")).toBe("excluded");
    expect(view.headers.get("Set-Cookie")).toBeNull();

    const engagement = await worker.fetch(new Request("https://pilot-example.com/events/engaged", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": excludedIp,
        "Content-Type": "application/json",
        Cookie: `dm_vid=${"b".repeat(32)}`,
        Origin: "https://pilot-example.com",
        "User-Agent": browserHeaders["User-Agent"],
      },
      body: JSON.stringify({ releaseId: "rel_test" }),
    }), env as never);
    expect(engagement.status).toBe(204);
    expect(engagement.headers.get("X-DM-Telemetry")).toBe("excluded");
    expect(events).toHaveLength(0);

    const otherVisitor = await worker.fetch(new Request("https://pilot-example.com/", {
      headers: { ...browserHeaders, "CF-Connecting-IP": "203.0.113.20" },
    }), env as never);
    expect(otherVisitor.headers.get("X-DM-Telemetry")).toBeNull();
    expect(events).toHaveLength(2);
  });

  it("ignores engagement without the issued session and rejects cross-origin beacons", async () => {
    const { env, events } = environment();
    const request = (origin: string, cookie?: string) => new Request("https://pilot-example.com/events/engaged", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: `dm_vid=${cookie}` } : {}),
        Origin: origin,
        "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      },
      body: JSON.stringify({ releaseId: "rel_test" }),
    });

    const noSession = await worker.fetch(request("https://pilot-example.com"), env as never);
    const crossOrigin = await worker.fetch(request("https://attacker.example", "a".repeat(32)), env as never);

    expect(noSession.status).toBe(204);
    expect(crossOrigin.status).toBe(403);
    expect(events).toHaveLength(0);
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

  it("records an authenticated readiness canary without creating visitor traffic", async () => {
    const { env, events } = environment();
    const checkId = `health_${"a".repeat(32)}`;
    const signature = await hmacSha256Hex("test-secret", `${checkId}:scheduled:pilot-example.com`);
    const response = await worker.fetch(new Request("https://pilot-example.com/readyz", {
      headers: {
        "X-DM-Health-Id": checkId,
        "X-DM-Health-Source": "scheduled",
        "X-DM-Health-Signature": signature,
      },
    }), env as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(events).toHaveLength(1);
    const point = events[0] as { blobs: string[] };
    expect(point.blobs[0]).toBe("health_canary");
    expect(point.blobs[3]).toBe("unknown");
    expect(point.blobs[6]).toBe(checkId);
    expect(point.blobs[7]).toBe("health_scheduled");
  });

  it("ignores forged or malformed readiness canaries", async () => {
    const { env, events } = environment();
    await worker.fetch(new Request("https://pilot-example.com/readyz", {
      headers: {
        "X-DM-Health-Id": `health_${"b".repeat(32)}`,
        "X-DM-Health-Source": "scheduled",
        "X-DM-Health-Signature": await hmacSha256Hex("wrong-secret", `health_${"b".repeat(32)}:scheduled:pilot-example.com`),
      },
    }), env as never);
    await worker.fetch(new Request("https://pilot-example.com/readyz", {
      headers: {
        "X-DM-Health-Id": "not-a-health-id",
        "X-DM-Health-Source": "scheduled",
        "X-DM-Health-Signature": await hmacSha256Hex("test-secret", "not-a-health-id:scheduled:pilot-example.com"),
      },
    }), env as never);

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

  it("serves safe legacy paths and records only coarse entry context", async () => {
    const { env, events } = environment();
    const request = new Request("https://pilot-example.com/services/repair?customer=private", {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://www.google.com/search?q=repair",
        "Sec-CH-UA-Mobile": "?1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "User-Agent": "Mozilla/5.0 (iPhone) AppleWebKit/537.36 Mobile Safari/537.36",
      },
    });
    Object.defineProperty(request, "cf", { value: { country: "US", regionCode: "TX", timezone: "America/Chicago" } });
    const response = await worker.fetch(request, env as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.text()).toContain("independent referral website");
    const point = events[0] as { blobs: string[] };
    const qualifiedPoint = events[1] as { blobs: string[]; indexes: string[] };
    expect(point.blobs.slice(10, 13)).toEqual(["service", "mobile", "search"]);
    expect(point.blobs[13]).toBe("TX");
    expect(point.blobs[14]).toMatch(/^(?:00-03|04-07|08-11|12-15|16-19|20-23)$/);
    expect(point.blobs.join(" ")).not.toContain("customer=private");
    expect(point.blobs.join(" ")).not.toContain("google.com");
    expect(qualifiedPoint.blobs).toEqual(["qualified_session_v4", "pilot-example.com", "dom_test", "rel_test", "US"]);
    expect(qualifiedPoint.indexes).toEqual([`qualified_v4:dom_test:${point.blobs[6]![0]}`]);
  });

  it("keeps sensitive and executable probe paths fail-closed", async () => {
    const { env, events } = environment();
    for (const path of ["/.env", "/wp-login.php", "/admin", "/backup.sql", "/archive.zip", "/.well-known/test"]) {
      const response = await worker.fetch(new Request(`https://pilot-example.com${path}`), env as never);
      expect(response.status).toBe(404);
    }
    expect(events).toHaveLength(0);
  });

  it("does not turn legacy subresource requests into page views", async () => {
    const { env, events } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/old-logo.png", {
      headers: { "Sec-Fetch-Dest": "image" },
    }), env as never);

    expect(response.status).toBe(404);
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

  it("serves a site-specific monogram favicon without recording a visit", async () => {
    const { env, events } = environment();
    const response = await worker.fetch(new Request("https://pilot-example.com/__dm/assets/site-mark.svg"), env as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=UTF-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("ETag")).toBe('"site-mark-rel_test"');
    expect(await response.text()).toContain(">TA</text>");
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

  it("opens an approved call campaign without exposing its number in tenant HTML", async () => {
    const enabledSnapshot = releaseSnapshotSchema.parse({
      schemaVersion: 1,
      releaseId: "rel_test",
      domainId: "dom_test",
      hostname: "pilot-example.com",
      state: "live",
      templateKey: "home-services",
      content,
      offerSlots: [{ slot: "primary", enabled: true }],
      html: compileHomeServicesHtml({ content, hostname: "pilot-example.com", releaseId: "rel_test", offerEnabled: true }),
      compiledAt: "2026-08-04T12:00:00.000Z",
    });
    let clickInput: Record<string, unknown> | null = null;
    const control = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      clickInput = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        destination: { type: "phone", value: "+18005550123" },
        destinationUrl: null,
        clickId: "clk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
    } };
    const { env, events } = environment({ "release:rel_test": JSON.stringify(enabledSnapshot) }, "live", { CONTROL: control });

    const page = await worker.fetch(new Request("https://pilot-example.com/"), env as never);
    expect(await page.text()).not.toContain("+18005550123");
    const response = await worker.fetch(new Request("https://pilot-example.com/go/primary", {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36" },
    }), env as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("tel:+18005550123");
    expect(clickInput).toMatchObject({ measurementEligible: true });
    expect(events.some((point) => (point as { blobs: string[] }).blobs[0] === "click")).toBe(true);
  });

  it("keeps operator phone actions in the audit ledger but out of measurement", async () => {
    const enabledSnapshot = releaseSnapshotSchema.parse({
      schemaVersion: 1,
      releaseId: "rel_test",
      domainId: "dom_test",
      hostname: "pilot-example.com",
      state: "live",
      templateKey: "home-services",
      content,
      offerSlots: [{ slot: "primary", enabled: true }],
      html: compileHomeServicesHtml({ content, hostname: "pilot-example.com", releaseId: "rel_test", offerEnabled: true }),
      compiledAt: "2026-08-04T12:00:00.000Z",
    });
    const excludedIp = "203.0.113.19";
    const salt = "a".repeat(64);
    const excludedHash = await sha256Hex(`${salt}:${excludedIp}`);
    let clickInput: Record<string, unknown> | null = null;
    const control = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      clickInput = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ destination: { type: "phone", value: "+18005550123" }, clickId: "clk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    } };
    const { env, events } = environment({ "release:rel_test": JSON.stringify(enabledSnapshot) }, "live", {
      CONTROL: control,
      TELEMETRY_EXCLUSION_SECRET: `v1:${salt}:${excludedHash}`,
    });

    const response = await worker.fetch(new Request("https://pilot-example.com/go/primary", {
      headers: {
        "CF-Connecting-IP": excludedIp,
        "User-Agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36",
      },
    }), env as never);

    expect(response.status).toBe(302);
    expect(clickInput).toMatchObject({ measurementEligible: false });
    expect(events.some((point) => (point as { blobs: string[] }).blobs[0] === "click")).toBe(false);
  });

  it("rejects malformed phone destinations from the control plane", async () => {
    const enabledSnapshot = releaseSnapshotSchema.parse({
      schemaVersion: 1,
      releaseId: "rel_test",
      domainId: "dom_test",
      hostname: "pilot-example.com",
      state: "live",
      templateKey: "home-services",
      content,
      offerSlots: [{ slot: "primary", enabled: true }],
      html: compileHomeServicesHtml({ content, hostname: "pilot-example.com", releaseId: "rel_test", offerEnabled: true }),
      compiledAt: "2026-08-04T12:00:00.000Z",
    });
    const control = { fetch: async () => Response.json({
      destination: { type: "phone", value: "1-800-555-0123" },
      clickId: "clk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }) };
    const { env } = environment({ "release:rel_test": JSON.stringify(enabledSnapshot) }, "live", { CONTROL: control });

    const response = await worker.fetch(new Request("https://pilot-example.com/go/primary"), env as never);
    expect(response.status).toBe(503);
  });
});
