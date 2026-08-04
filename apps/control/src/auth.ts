import { timingSafeEqualString } from "@domain-monetizer/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import type { Env, Variables } from "./types";

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function teamIssuer(teamDomain: string): string {
  return `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
}

function remoteKeys(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const issuer = teamIssuer(teamDomain);
  const existing = jwksByTeam.get(issuer);
  if (existing) return existing;
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksByTeam.set(issuer, keys);
  return keys;
}

export function accessAssertionFromHeaders(headers: Headers): string {
  const assertion = headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (assertion) return assertion;

  const cookies = headers.get("Cookie") ?? "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "CF_Authorization") continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export async function requireAdmin(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next): Promise<Response | void> {
  const authorization = c.req.header("Authorization") ?? "";
  const operatorToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (operatorToken && c.env.OPERATOR_API_TOKEN && timingSafeEqualString(operatorToken, c.env.OPERATOR_API_TOKEN)) {
    c.set("actor", "codex-cli");
    c.set("authMethod", "operator-token");
    return next();
  }
  if (c.env.ENVIRONMENT === "development" && c.env.ALLOW_LOCAL_ADMIN === "true") {
    c.set("actor", c.env.ALLOWED_ADMIN_EMAIL.toLowerCase());
    c.set("authMethod", "operator-token");
    return next();
  }
  const assertion = accessAssertionFromHeaders(c.req.raw.headers);
  if (!assertion || !c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) return c.json({ error: "Access authentication required" }, 401);
  try {
    const verified = await jwtVerify(assertion, remoteKeys(c.env.ACCESS_TEAM_DOMAIN), {
      audience: c.env.ACCESS_AUD,
      issuer: teamIssuer(c.env.ACCESS_TEAM_DOMAIN),
    });
    const email = typeof verified.payload.email === "string" ? verified.payload.email.toLowerCase() : "";
    if (email !== c.env.ALLOWED_ADMIN_EMAIL.toLowerCase()) return c.json({ error: "Forbidden" }, 403);
    c.set("actor", email);
    c.set("authMethod", "access");
    return next();
  } catch {
    return c.json({ error: "Invalid Access assertion" }, 401);
  }
}

export async function requireSameOrigin(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next): Promise<Response | void> {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (c.get("authMethod") === "operator-token") return next();
  if (c.env.ENVIRONMENT === "development" && c.env.ALLOW_LOCAL_ADMIN === "true") return next();
  const origin = c.req.header("Origin");
  const expected = new URL(c.req.url).origin;
  if (!origin || origin !== expected) return c.json({ error: "Cross-origin mutation rejected" }, 403);
  return next();
}
