import {
  activePointerKey,
  canonicalHostname,
  releaseKey,
  releaseSnapshotSchema,
  sha256Hex,
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
}

interface CfProperties {
  country?: string;
  colo?: string;
  botManagement?: { score?: number; verifiedBot?: boolean };
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

function classifyVisitor(request: Request): "human" | "bot" | "unknown" {
  const cf = request.cf as CfProperties | undefined;
  if (cf?.botManagement?.verifiedBot) return "bot";
  const score = cf?.botManagement?.score;
  if (typeof score === "number") return score >= 30 ? "human" : "bot";
  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (!userAgent) return "unknown";
  if (/(bot|crawler|spider|headless|preview|fetch|monitor|scanner|curl|wget)/.test(userAgent)) return "bot";
  if (/(mozilla|chrome|safari|firefox|edg)\//.test(userAgent)) return "human";
  return "unknown";
}

function eventPoint(request: Request, snapshot: ReleaseSnapshot, kind: string, humanClass: string): { blobs: string[]; doubles: number[]; indexes: string[] } {
  const cf = request.cf as CfProperties | undefined;
  return {
    indexes: [snapshot.domainId],
    blobs: [kind, snapshot.hostname, snapshot.releaseId, humanClass, cf?.country ?? "XX", cf?.colo ?? "unknown"],
    doubles: [1],
  };
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
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)dm_vid=([a-f0-9]{32})/)?.[1];
  return cookie ? sha256Hex(`${env.VISITOR_HASH_SALT}:${cookie}`) : null;
}

async function handleEngagement(request: Request, snapshot: ReleaseSnapshot, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0] !== "application/json") return new Response(null, { status: 415 });
  const body: { releaseId?: string } = await request.json<{ releaseId?: string }>().catch(() => ({}));
  if (body.releaseId !== snapshot.releaseId) return new Response(null, { status: 409 });
  env.EVENTS.writeDataPoint(eventPoint(request, snapshot, "engaged", classifyVisitor(request)));
  return withHeaders(new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }));
}

async function handleGo(request: Request, snapshot: ReleaseSnapshot, slot: string, env: Env): Promise<Response> {
  const declared = snapshot.offerSlots.find((item) => item.slot === slot && item.enabled);
  if (!declared) return errorResponse(404, "Offer unavailable");
  const humanClass = classifyVisitor(request);
  const cf = request.cf as CfProperties | undefined;
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
      visitorIdHash: await visitorHash(request, env),
      likelyHuman: humanClass === "human" ? true : humanClass === "bot" ? false : null,
      country: cf?.country ?? null,
      userAgentClass: humanClass,
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
  env.EVENTS.writeDataPoint(eventPoint(request, snapshot, "click", humanClass));
  return withHeaders(Response.redirect(destination, 302), { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
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
  if (!snapshot) return errorResponse(404, "Site not configured");
  if (snapshot.state === "paused") return withHeaders(new Response(snapshot.html, { status: 503, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "Retry-After": "300" } }));

  if (url.pathname === "/events/engaged") return handleEngagement(request, snapshot, env);
  if (url.pathname.startsWith("/go/")) return handleGo(request, snapshot, url.pathname.slice(4), env);
  if (url.pathname === "/robots.txt") return withHeaders(new Response("User-agent: *\nAllow: /\nSitemap: https://" + hostname + "/sitemap.xml\n", { headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=3600" } }));
  if (url.pathname === "/sitemap.xml") return withHeaders(new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${hostname}/</loc></url></urlset>`, { headers: { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "public, max-age=3600" } }));
  if (url.pathname !== "/") return errorResponse(404, "Page not found");

  const humanClass = classifyVisitor(request);
  env.EVENTS.writeDataPoint(eventPoint(request, snapshot, "view", humanClass));
  const headers = new Headers({
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    "ETag": `"${snapshot.releaseId}"`,
    "Vary": "Accept-Encoding",
  });
  if (!request.headers.get("cookie")?.includes("dm_vid=")) {
    headers.append("Set-Cookie", `dm_vid=${crypto.randomUUID().replaceAll("-", "")}; Max-Age=1800; Path=/; Secure; HttpOnly; SameSite=Lax`);
  }
  return withHeaders(new Response(request.method === "HEAD" ? null : snapshot.html, { headers }));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).catch(() => errorResponse(500, "Temporarily unavailable"));
  },
} satisfies ExportedHandler<Env>;
