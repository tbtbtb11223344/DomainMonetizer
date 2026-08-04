import { timingSafeEqualString } from "@domain-monetizer/core";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import type { Env, Variables } from "./types";

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteKeys(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const normalized = teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const existing = jwksByTeam.get(normalized);
  if (existing) return existing;
  const keys = createRemoteJWKSet(new URL(`https://${normalized}/cdn-cgi/access/certs`));
  jwksByTeam.set(normalized, keys);
  return keys;
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
  const assertion = c.req.header("Cf-Access-Jwt-Assertion");
  if (!assertion || !c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) return c.json({ error: "Access authentication required" }, 401);
  try {
    const verified = await jwtVerify(assertion, remoteKeys(c.env.ACCESS_TEAM_DOMAIN), { audience: c.env.ACCESS_AUD });
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
