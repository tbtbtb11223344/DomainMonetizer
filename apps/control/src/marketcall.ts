import { randomId, sha256Hex, timingSafeEqualString } from "@domain-monetizer/core";
import type { Context } from "hono";
import { z } from "zod";
import { nowIso } from "./db";
import type { Env, Variables } from "./types";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const identifierSchema = z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const clickIdSchema = z.string().trim().regex(/^clk_[a-f0-9]{32}$/).optional();
const outcomeSchema = z.enum(["pending", "accepted", "rejected"]);

export interface MarketcallPostback {
  eventId: string;
  campaignId: string;
  clickId?: string;
  outcome: z.infer<typeof outcomeSchema>;
  providerStatus: string;
  payoutUsd: number | null;
  occurredAt: string | null;
}

interface CampaignRow {
  id: string;
  offer_id: string;
  domain_id: string;
}

interface ClickRow {
  id: string;
  offer_id: string;
  domain_id: string;
}

interface InboxRow {
  id: string;
  processing_status: string;
}

function firstValue(fields: URLSearchParams, names: string[]): string {
  for (const name of names) {
    const value = fields.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function normalizedTimestamp(raw: string): string | null {
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseMarketcallFields(fields: URLSearchParams): MarketcallPostback {
  const eventId = identifierSchema.parse(firstValue(fields, ["event_id", "call_id", "lead_id", "tid"]));
  const campaignId = identifierSchema.parse(firstValue(fields, ["campaign_id", "program_id"]));
  const clickId = clickIdSchema.parse(firstValue(fields, ["subid"]) || undefined);
  const outcome = outcomeSchema.parse(firstValue(fields, ["outcome"]));
  const providerStatus = firstValue(fields, ["status", "state", "state_title"]).slice(0, 100) || outcome;
  const payoutRaw = firstValue(fields, ["payout", "earn"]);
  const payout = payoutRaw ? Number(payoutRaw) : null;
  if (payout !== null && (!Number.isFinite(payout) || payout < 0 || payout > 100_000)) throw new Error("Invalid payout");
  const currency = firstValue(fields, ["currency"]);
  if (currency && currency.toUpperCase() !== "USD") throw new Error("Unsupported currency");
  const parsed = {
    eventId,
    campaignId,
    outcome,
    providerStatus,
    payoutUsd: outcome === "accepted" ? payout : null,
    occurredAt: normalizedTimestamp(firstValue(fields, ["occurred_at", "call_timestamp", "lead_timestamp", "date"])),
  };
  return clickId ? { ...parsed, clickId } : parsed;
}

async function requestFields(request: Request): Promise<URLSearchParams> {
  const url = new URL(request.url);
  const fields = new URLSearchParams();
  if (request.method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 8_192) throw new Error("Postback body too large");
    const contentType = ((request.headers.get("content-type") ?? "").split(";", 1)[0] ?? "").toLowerCase();
    if (contentType === "application/json") {
      const rawBody = await request.text();
      if (rawBody.length > 8_192) throw new Error("Postback body too large");
      const body = (() => {
        try {
          return JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          return null;
        }
      })();
      if (!body || Array.isArray(body)) throw new Error("Invalid JSON postback");
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string" || typeof value === "number") fields.set(key, String(value));
      }
    } else if (contentType === "application/x-www-form-urlencoded") {
      const body = await request.text();
      if (body.length > 8_192) throw new Error("Postback body too large");
      for (const [key, value] of new URLSearchParams(body)) fields.set(key, value);
    }
  }
  for (const [key, value] of url.searchParams) fields.set(key, value);
  return fields;
}

function safePayload(input: MarketcallPostback): string {
  return JSON.stringify({
    eventId: input.eventId,
    campaignId: input.campaignId,
    clickId: input.clickId ?? null,
    outcome: input.outcome,
    providerStatus: input.providerStatus,
    payoutUsd: input.payoutUsd,
    occurredAt: input.occurredAt,
  });
}

export async function processMarketcallPostback(db: D1Database, input: MarketcallPostback): Promise<{ duplicate: boolean }> {
  const receivedAt = nowIso();
  const idempotencyKey = await sha256Hex(safePayload(input));
  const inboxId = randomId("pb");
  await db.prepare(
    "INSERT INTO postback_inbox (id, provider, idempotency_key, payload_json, signature_valid, processing_status, received_at) VALUES (?, 'marketcall', ?, ?, 1, 'received', ?) ON CONFLICT(provider, idempotency_key) DO NOTHING",
  ).bind(inboxId, idempotencyKey, safePayload(input), receivedAt).run();
  const inbox = await db.prepare("SELECT id, processing_status FROM postback_inbox WHERE provider='marketcall' AND idempotency_key=?")
    .bind(idempotencyKey).first<InboxRow>();
  if (!inbox) throw new Error("Postback inbox insert failed");
  if (inbox.processing_status === "processed" || inbox.processing_status === "rejected") return { duplicate: true };

  try {
    const campaign = await db.prepare(
      "SELECT id, offer_id, domain_id FROM affiliate_campaigns WHERE provider='marketcall' AND external_id=? AND status IN ('approved', 'active', 'paused', 'retired')",
    ).bind(input.campaignId).first<CampaignRow>();
    if (!campaign) {
      await db.prepare("UPDATE postback_inbox SET processing_status='rejected', error_message='Unknown Marketcall campaign', processed_at=? WHERE id=?")
        .bind(nowIso(), inbox.id).run();
      return { duplicate: false };
    }

    let click: ClickRow | null = null;
    if (input.clickId) {
      click = await db.prepare("SELECT id, offer_id, domain_id FROM clicks WHERE id=?").bind(input.clickId).first<ClickRow>();
      if (!click || click.offer_id !== campaign.offer_id || click.domain_id !== campaign.domain_id) {
        await db.prepare("UPDATE postback_inbox SET processing_status='rejected', error_message='Click attribution mismatch', processed_at=? WHERE id=?")
          .bind(nowIso(), inbox.id).run();
        return { duplicate: false };
      }
    }

    await db.prepare(
      "INSERT INTO conversions (id, provider, external_id, click_id, domain_id, offer_id, status, payout_usd, occurred_at, received_at, raw_inbox_id) VALUES (?, 'marketcall', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, external_id) DO UPDATE SET click_id=COALESCE(excluded.click_id, conversions.click_id), domain_id=excluded.domain_id, offer_id=excluded.offer_id, status=CASE WHEN excluded.status='pending' AND conversions.status IN ('accepted','rejected') THEN conversions.status ELSE excluded.status END, payout_usd=CASE WHEN excluded.status='pending' AND conversions.status IN ('accepted','rejected') THEN conversions.payout_usd ELSE excluded.payout_usd END, occurred_at=COALESCE(excluded.occurred_at, conversions.occurred_at), received_at=excluded.received_at, raw_inbox_id=excluded.raw_inbox_id",
    ).bind(
      randomId("conv"),
      input.eventId,
      click?.id ?? null,
      campaign.domain_id,
      campaign.offer_id,
      input.outcome,
      input.payoutUsd,
      input.occurredAt,
      receivedAt,
      inbox.id,
    ).run();
    await db.prepare("UPDATE postback_inbox SET processing_status='processed', error_message=NULL, processed_at=? WHERE id=?")
      .bind(nowIso(), inbox.id).run();
    return { duplicate: false };
  } catch (error) {
    await db.prepare("UPDATE postback_inbox SET processing_status='failed', error_message=?, processed_at=? WHERE id=?")
      .bind(error instanceof Error ? error.message.slice(0, 500) : "Unknown processing error", nowIso(), inbox.id).run();
    throw error;
  }
}

export async function handleMarketcallPostback(c: AppContext): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "POST") return c.json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  const configuredSecret = c.env.MARKETCALL_POSTBACK_SECRET ?? "";
  const providedSecret = c.req.param("token") ?? "";
  if (!configuredSecret || !providedSecret || !timingSafeEqualString(providedSecret, configuredSecret)) return c.json({ error: "Not found" }, 404);
  try {
    const input = parseMarketcallFields(await requestFields(c.req.raw));
    const result = await processMarketcallPostback(c.env.DB, input);
    return c.json({ ok: true, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof Error && /Invalid|Unsupported|too large/.test(error.message))) {
      return c.json({ error: "Invalid postback" }, 400);
    }
    throw error;
  }
}
