import {
  activePointerKey,
  canonicalHostname,
  hmacSha256Hex,
  releaseKey,
  releaseSnapshotSchema,
  sha256Hex,
  siteMarkSvg,
  timingSafeEqualString,
  type ReleaseSnapshot,
} from "@domain-monetizer/core";

interface AnalyticsEngineDataset {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

interface Env {
  SITE_CONFIG: KVNamespace;
  EVENTS: AnalyticsEngineDataset;
  CONTROL: Fetcher;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  CONTROL_SHARED_SECRET: string;
  VISITOR_HASH_SALT: string;
  TELEMETRY_EXCLUSION_SECRET?: string;
}

interface CfProperties {
  country?: string;
  regionCode?: string;
  timezone?: string;
  colo?: string;
  asn?: number;
  asOrganization?: string;
  botManagement?: { score?: number; verifiedBot?: boolean; jsDetection?: { passed?: boolean } } | null;
}

type VisitorClass = "human" | "bot" | "unknown";
type PathClass = "root" | "contact" | "quote" | "booking" | "service" | "location" | "about" | "probe" | "other";
type DeviceClass = "mobile" | "tablet" | "desktop" | "unknown";
type ReferrerClass = "direct" | "internal" | "search" | "directory" | "social" | "other";

const VISITOR_COOKIE = "dm_vid";
const QUALIFIED_DAY_COOKIE = "dm_qd";
const QUALIFIED_SESSION_EVENT = "qualified_session_v3";
const QUALIFIED_SESSION_INDEX_PREFIX = "qualified_v3:";
const VISITOR_SESSION_SECONDS = 30 * 60;

interface VisitorClassification {
  visitorClass: VisitorClass;
  reason: string;
  botScore: number | null;
}

interface TelemetryExclusion {
  salt: string;
  hashes: string[];
}

const securityHeaders: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function withHeaders(response: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries({ ...securityHeaders, ...extra })) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorResponse(status: number, title: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="/__dm/site-v2.css"></head><body class="system-page"><main><h1>${title}</h1><p>This site is not currently available.</p></main></body></html>`;
  return withHeaders(new Response(body, { status, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } }));
}

function telemetryExclusion(secret: string | undefined): TelemetryExclusion | null {
  if (!secret) return null;
  const match = secret.match(/^v1:([a-f0-9]{64}):([a-f0-9]{64}(?:,[a-f0-9]{64})*)$/);
  return match ? { salt: match[1]!, hashes: match[2]!.split(",") } : null;
}

async function isTelemetryExcluded(request: Request, env: Env): Promise<boolean> {
  const exclusion = telemetryExclusion(env.TELEMETRY_EXCLUSION_SECRET);
  const sourceIp = request.headers.get("cf-connecting-ip")?.trim().toLowerCase();
  if (!exclusion || !sourceIp) return false;
  const sourceHash = await sha256Hex(`${exclusion.salt}:${sourceIp}`);
  return exclusion.hashes.some((expected) => timingSafeEqualString(sourceHash, expected));
}

function classifyVisitor(request: Request, interaction = false): VisitorClassification {
  const cf = request.cf as CfProperties | undefined;
  if (cf?.botManagement?.verifiedBot) return { visitorClass: "bot", reason: "verified_bot", botScore: cf.botManagement.score ?? null };
  const score = cf?.botManagement?.score;
  if (typeof score === "number") return { visitorClass: score >= 30 ? "human" : "bot", reason: "bot_score", botScore: score };
  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (!userAgent) return { visitorClass: "unknown", reason: "missing_ua", botScore: null };
  if (/(bot|crawler|spider|headless|preview|fetch|monitor|scanner|curl|wget|python|httpclient|axios|node\.js)/.test(userAgent)) {
    return { visitorClass: "bot", reason: "ua_automation", botScore: null };
  }
  const browserLike = /(mozilla|chrome|safari|firefox|edg)\//.test(userAgent);
  if (interaction && browserLike) return { visitorClass: "human", reason: "browser_interaction", botScore: null };
  const navigation = request.headers.get("sec-fetch-mode") === "navigate" && request.headers.get("sec-fetch-dest") === "document";
  const acceptsHtml = request.headers.get("accept")?.toLowerCase().includes("text/html") ?? false;
  if (browserLike && navigation && acceptsHtml) return { visitorClass: "human", reason: "browser_navigation", botScore: null };
  if (browserLike) return { visitorClass: "unknown", reason: "browser_ua_only", botScore: null };
  return { visitorClass: "unknown", reason: "unrecognized_client", botScore: null };
}

function classifyPath(pathname: string): PathClass {
  const path = pathname.toLowerCase();
  if (path === "/") return "root";
  if (/(^|\/)(?:wp-admin|wp-login|wp-content|wp-includes|xmlrpc|admin|login|signin|account|phpmyadmin|cgi-bin|vendor|boaform|\.well-known|\.env|\.git|\.svn|\.hg|\.aws)(?:\/|\.|$)|\.(?:php|asp|aspx|jsp|cgi|exe|sql|bak|ini|conf|config|log|zip|tar|gz|7z|rar|yml|yaml)(?:$|\/)/.test(path)) return "probe";
  if (/(^|\/)(?:contact|contact-us|support)(?:\/|$)/.test(path)) return "contact";
  if (/(^|\/)(?:quote|estimate|pricing|get-a-quote|request-a-quote)(?:\/|$)/.test(path)) return "quote";
  if (/(^|\/)(?:book|booking|schedule|appointment)(?:\/|$)/.test(path)) return "booking";
  if (/(^|\/)(?:services?|repair|installation|maintenance|replacement)(?:\/|$)/.test(path)) return "service";
  if (/(^|\/)(?:locations?|service-areas?|areas-we-serve)(?:\/|$)/.test(path)) return "location";
  if (/(^|\/)(?:about|about-us|team|staff)(?:\/|$)/.test(path)) return "about";
  return "other";
}

function isSubresourceRequest(request: Request): boolean {
  const destination = request.headers.get("sec-fetch-dest")?.toLowerCase();
  return Boolean(destination && destination !== "document" && destination !== "iframe");
}

function classifyDevice(request: Request): DeviceClass {
  const mobileHint = request.headers.get("sec-ch-ua-mobile");
  if (mobileHint === "?1") return "mobile";
  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (/(ipad|tablet|kindle|silk)/.test(userAgent)) return "tablet";
  if (/(mobile|iphone|ipod|android)/.test(userAgent)) return "mobile";
  if (/(windows|macintosh|linux|cros|mozilla|chrome|safari|firefox|edg)\b/.test(userAgent)) return "desktop";
  return "unknown";
}

function classifyReferrer(request: Request, hostname: string): ReferrerClass {
  const raw = request.headers.get("referer");
  if (!raw) return "direct";
  try {
    const referrerHostname = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    if (referrerHostname === hostname || referrerHostname === `www.${hostname}`) return "internal";
    if (/(^|\.)(?:google|bing|yahoo|duckduckgo|ecosia|baidu|yandex)\./.test(`${referrerHostname}.`)) return "search";
    if (/(^|\.)(?:yelp|yellowpages|mapquest|angi|homeadvisor|bbb|thumbtack)\./.test(`${referrerHostname}.`)) return "directory";
    if (/(^|\.)(?:facebook|instagram|tiktok|linkedin|twitter|reddit|youtube)\./.test(`${referrerHostname}.`) || referrerHostname === "x.com") return "social";
    return "other";
  } catch {
    return "other";
  }
}

function coarseRegion(request: Request): string {
  const cf = request.cf as CfProperties | undefined;
  const region = cf?.regionCode?.toUpperCase() ?? "";
  return cf?.country === "US" && /^[A-Z]{2}$/.test(region) ? region : "XX";
}

function localTimeBucket(request: Request): string {
  const timezone = (request.cf as CfProperties | undefined)?.timezone;
  if (!timezone) return "unknown";
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23", timeZone: timezone }).format(new Date()));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "unknown";
    const start = Math.floor(hour / 4) * 4;
    return `${String(start).padStart(2, "0")}-${String(start + 3).padStart(2, "0")}`;
  } catch {
    return "unknown";
  }
}

function eventPoint(
  request: Request,
  snapshot: ReleaseSnapshot,
  kind: string,
  classification: VisitorClassification,
  visitorIdHash: string | null,
): { blobs: string[]; doubles: number[]; indexes: string[] } {
  const cf = request.cf as CfProperties | undefined;
  return {
    indexes: [snapshot.domainId],
    blobs: [
      kind,
      snapshot.hostname,
      snapshot.releaseId,
      classification.visitorClass,
      cf?.country ?? "XX",
      cf?.colo ?? "unknown",
      visitorIdHash ?? "",
      classification.reason,
      typeof cf?.asn === "number" ? String(cf.asn) : "",
      cf?.asOrganization?.slice(0, 100) ?? "",
      classifyPath(new URL(request.url).pathname),
      classifyDevice(request),
      classifyReferrer(request, snapshot.hostname),
      coarseRegion(request),
      localTimeBucket(request),
    ],
    doubles: [1, classification.botScore ?? -1],
  };
}

function qualifiedSessionPoint(snapshot: ReleaseSnapshot, country: string): { blobs: string[]; doubles: number[]; indexes: string[] } {
  return {
    // One signed browser marker permits exactly one point per hostname and UTC
    // day. A dedicated per-domain index isolates this low-volume stream from
    // the tenant's much higher-volume view stream, which can otherwise make
    // Analytics Engine sample qualified-session points on busy domains.
    indexes: [`${QUALIFIED_SESSION_INDEX_PREFIX}${snapshot.domainId}`],
    blobs: [QUALIFIED_SESSION_EVENT, snapshot.hostname, snapshot.domainId, snapshot.releaseId, country],
    doubles: [1],
  };
}

function cookieValue(request: Request, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`))?.[1] ?? null;
}

function utcDay(now = new Date()): { compact: string; secondsRemaining: number } {
  const compact = now.toISOString().slice(0, 10).replaceAll("-", "");
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { compact, secondsRemaining: Math.max(1, Math.ceil((next - now.getTime()) / 1000)) };
}

async function qualifiedDayCookie(request: Request, snapshot: ReleaseSnapshot, env: Env): Promise<string | null> {
  const { compact, secondsRemaining } = utcDay();
  const expected = await hmacSha256Hex(env.VISITOR_HASH_SALT, `qualified:v3:${compact}:${snapshot.hostname}`);
  const current = cookieValue(request, QUALIFIED_DAY_COOKIE)?.match(/^(\d{8})\.([a-f0-9]{64})$/);
  if (current?.[1] === compact && timingSafeEqualString(current[2]!, expected)) return null;
  return `${QUALIFIED_DAY_COOKIE}=${compact}.${expected}; Max-Age=${secondsRemaining}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

async function recordQualifiedSession(
  request: Request,
  snapshot: ReleaseSnapshot,
  env: Env,
  country: string,
): Promise<string | null> {
  const marker = await qualifiedDayCookie(request, snapshot, env);
  if (!marker) return null;
  env.EVENTS.writeDataPoint(qualifiedSessionPoint(snapshot, country));
  return marker;
}

async function writeHealthCanary(request: Request, snapshot: ReleaseSnapshot, env: Env): Promise<void> {
  if (request.method !== "GET") return;
  const signature = request.headers.get("X-DM-Health-Signature") ?? "";
  const checkId = request.headers.get("X-DM-Health-Id") ?? "";
  const source = request.headers.get("X-DM-Health-Source") ?? "";
  if (!signature || !env.CONTROL_SHARED_SECRET) return;
  if (!/^health_[a-f0-9]{32}$/.test(checkId) || (source !== "manual" && source !== "scheduled")) return;
  const expected = await hmacSha256Hex(env.CONTROL_SHARED_SECRET, `${checkId}:${source}:${snapshot.hostname}`);
  if (!timingSafeEqualString(signature, expected)) return;
  env.EVENTS.writeDataPoint(eventPoint(
    request,
    snapshot,
    "health_canary",
    { visitorClass: "unknown", reason: `health_${source}`, botScore: null },
    checkId,
  ));
}

async function loadSnapshot(hostname: string, env: Env): Promise<ReleaseSnapshot | null> {
  const pointer = await env.SITE_CONFIG.get(activePointerKey(hostname));
  if (!pointer) return null;
  const raw = await env.SITE_CONFIG.get(releaseKey(pointer));
  if (!raw) return null;
  const parsed = releaseSnapshotSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.hostname !== hostname || parsed.data.releaseId !== pointer) return null;
  return parsed.data;
}

async function visitorHash(request: Request, env: Env): Promise<string | null> {
  const cookie = cookieValue(request, VISITOR_COOKIE)?.match(/^[a-f0-9]{32}$/)?.[0];
  return cookie ? sha256Hex(`${env.VISITOR_HASH_SALT}:${new Date().toISOString().slice(0, 10)}:${cookie}`) : null;
}

async function pageVisitor(request: Request, env: Env): Promise<{ hash: string; cookie: string }> {
  const existing = cookieValue(request, VISITOR_COOKIE)?.match(/^[a-f0-9]{32}$/)?.[0];
  const id = existing ?? crypto.randomUUID().replaceAll("-", "");
  return { hash: await sha256Hex(`${env.VISITOR_HASH_SALT}:${new Date().toISOString().slice(0, 10)}:${id}`), cookie: id };
}

async function handleEngagement(request: Request, snapshot: ReleaseSnapshot, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0] !== "application/json") return new Response(null, { status: 415 });
  if (request.headers.get("origin") !== `https://${snapshot.hostname}`) return withHeaders(new Response(null, { status: 403 }));
  if (await isTelemetryExcluded(request, env)) {
    return withHeaders(new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-DM-Telemetry": "excluded" } }));
  }
  const hashedVisitor = await visitorHash(request, env);
  if (!hashedVisitor) return withHeaders(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
  const body: { releaseId?: string } = await request.json<{ releaseId?: string }>().catch(() => ({}));
  if (body.releaseId !== snapshot.releaseId) return new Response(null, { status: 409 });
  const classification = classifyVisitor(request, true);
  env.EVENTS.writeDataPoint(eventPoint(request, snapshot, "engaged", classification, hashedVisitor));
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (classification.visitorClass === "human") {
    const marker = await recordQualifiedSession(request, snapshot, env, ((request.cf as CfProperties | undefined)?.country ?? "XX"));
    if (marker) headers.append("Set-Cookie", marker);
  }
  return withHeaders(new Response(null, { status: 204, headers }));
}

async function handleGo(request: Request, snapshot: ReleaseSnapshot, slot: string, env: Env): Promise<Response> {
  const declared = snapshot.offerSlots.find((item) => item.slot === slot && item.enabled);
  if (!declared) return errorResponse(404, "Offer unavailable");
  const classification = classifyVisitor(request, true);
  const cf = request.cf as CfProperties | undefined;
  const hashedVisitor = await visitorHash(request, env);
  const internal = await env.CONTROL.fetch("https://control.internal/internal/click", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DM-Internal-Secret": env.CONTROL_SHARED_SECRET,
    },
    body: JSON.stringify({
      domainId: snapshot.domainId,
      releaseId: snapshot.releaseId,
      slot,
      visitorIdHash: hashedVisitor,
      likelyHuman: classification.visitorClass === "human" ? true : classification.visitorClass === "bot" ? false : null,
      country: cf?.country ?? null,
      userAgentClass: classification.visitorClass,
    }),
  });
  if (!internal.ok) return errorResponse(503, "Offer temporarily unavailable");
  const payload = await internal.json<{ destinationUrl: string; clickId: string }>();
  let destination: URL;
  try {
    destination = new URL(payload.destinationUrl);
  } catch {
    return errorResponse(503, "Offer temporarily unavailable");
  }
  if (destination.protocol !== "https:") return errorResponse(503, "Offer temporarily unavailable");
  if (!(await isTelemetryExcluded(request, env))) {
    env.EVENTS.writeDataPoint(eventPoint(request, snapshot, "click", classification, hashedVisitor));
  }
  return withHeaders(Response.redirect(destination, 302), { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__dm/assets/site-mark.svg" && (request.method === "GET" || request.method === "HEAD")) {
    let hostname: string;
    try {
      hostname = canonicalHostname(request.headers.get("host") ?? url.hostname);
    } catch {
      return errorResponse(400, "Invalid hostname");
    }
    const snapshot = await loadSnapshot(hostname, env).catch(() => null);
    if (snapshot) {
      return withHeaders(new Response(request.method === "HEAD" ? null : siteMarkSvg(snapshot.content), {
        headers: {
          "Content-Type": "image/svg+xml; charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
          "ETag": `"site-mark-${snapshot.releaseId}"`,
        },
      }));
    }
  }
  if (url.pathname.startsWith("/__dm/")) return withHeaders(await env.ASSETS.fetch(request), { "Cache-Control": "public, max-age=86400, immutable" });
  if (url.pathname === "/healthz") return withHeaders(Response.json({ ok: true, service: "site-edge" }), { "Cache-Control": "no-store" });
  if (request.method !== "GET" && request.method !== "HEAD" && !(request.method === "POST" && url.pathname === "/events/engaged")) return new Response(null, { status: 405 });

  let hostname: string;
  try {
    hostname = canonicalHostname(request.headers.get("host") ?? url.hostname);
  } catch {
    return errorResponse(400, "Invalid hostname");
  }
  const requestedHostname = (request.headers.get("host") ?? url.hostname).toLowerCase().replace(/:\d+$/, "");
  if (requestedHostname === `www.${hostname}`) {
    url.hostname = hostname;
    return withHeaders(Response.redirect(url, 301), { "Cache-Control": "public, max-age=3600" });
  }
  const snapshot = await loadSnapshot(hostname, env).catch(() => null);
  if (url.pathname === "/readyz") {
    if (snapshot) await writeHealthCanary(request, snapshot, env);
    const live = snapshot?.state === "live";
    const payload = snapshot
      ? { ok: live, service: "site-edge", hostname, state: snapshot.state, releaseId: snapshot.releaseId }
      : { ok: false, service: "site-edge", hostname, state: "missing" };
    return withHeaders(new Response(request.method === "HEAD" ? null : JSON.stringify(payload), {
      status: live ? 200 : 503,
      headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" },
    }));
  }
  if (!snapshot) return errorResponse(404, "Site not configured");
  if (snapshot.state === "paused") return withHeaders(new Response(snapshot.html, { status: 503, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "Retry-After": "300" } }));

  if (url.pathname === "/events/engaged") return handleEngagement(request, snapshot, env);
  if (url.pathname.startsWith("/go/")) return handleGo(request, snapshot, url.pathname.slice(4), env);
  if (url.pathname === "/robots.txt") return withHeaders(new Response("User-agent: *\nAllow: /\nSitemap: https://" + hostname + "/sitemap.xml\n", { headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=3600" } }));
  if (url.pathname === "/sitemap.xml") return withHeaders(new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${hostname}/</loc></url></urlset>`, { headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=3600" } }));
  if (classifyPath(url.pathname) === "probe" || isSubresourceRequest(request)) return errorResponse(404, "Page not found");

  const headers = new Headers({
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-store",
    "ETag": `"${snapshot.releaseId}"`,
    "Vary": "Accept-Encoding",
    "X-Robots-Tag": "noindex, nofollow",
  });
  const telemetryExcluded = await isTelemetryExcluded(request, env);
  if (telemetryExcluded) headers.set("X-DM-Telemetry", "excluded");
  if (request.method === "GET" && !telemetryExcluded) {
    const visitor = await pageVisitor(request, env);
    const classification = classifyVisitor(request);
    env.EVENTS.writeDataPoint(eventPoint(request, snapshot, "view", classification, visitor.hash));
    if (classification.visitorClass === "human") {
      const marker = await recordQualifiedSession(request, snapshot, env, ((request.cf as CfProperties | undefined)?.country ?? "XX"));
      if (marker) headers.append("Set-Cookie", marker);
    }
    headers.append("Set-Cookie", `${VISITOR_COOKIE}=${visitor.cookie}; Max-Age=${VISITOR_SESSION_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  }
  return withHeaders(new Response(request.method === "HEAD" ? null : snapshot.html, { headers }));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).catch(() => errorResponse(500, "Temporarily unavailable"));
  },
} satisfies ExportedHandler<Env>;
