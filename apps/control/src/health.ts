import { hmacSha256Hex, sha256Hex } from "@domain-monetizer/core";
import type { Env } from "./types";

export const HEALTH_CHECK_LIMIT = 20;
export const HEALTH_CHECK_CONCURRENCY = 5;
export const HEALTH_FRESH_MS = 8 * 60 * 60 * 1_000;
export const HEALTH_RELIABILITY_THRESHOLD = 0.95;
export const SCHEDULED_HEALTH_CHECKS_PER_DAY = 4;
const HEALTH_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const HEALTH_TIMEOUT_MS = 8_000;

interface HealthDomain {
  id: string;
  hostname: string;
  active_release_id: string;
}

interface ReadinessPayload {
  ok?: unknown;
  hostname?: unknown;
  state?: unknown;
  releaseId?: unknown;
}

export type TenantHealthStatus = "ready" | "not_ready" | "unreachable";
export type HealthCheckSource = "manual" | "scheduled";

export interface TenantHealthResult {
  checkId: string;
  domainId: string;
  hostname: string;
  status: TenantHealthStatus;
  httpStatus: number | null;
  latencyMs: number;
  expectedReleaseId: string;
  observedReleaseId: string | null;
  errorMessage: string | null;
  checkedAt: string;
}

export interface TenantHealthBatchResult {
  checkedAt: string;
  checked: number;
  ready: number;
  notReady: number;
  unreachable: number;
  truncated: boolean;
  checkSource: HealthCheckSource;
  results: TenantHealthResult[];
}

export interface HealthPortfolioDomain {
  domain_id: string;
  hostname: string;
  lifecycle_status: string;
  active_release_id: string | null;
}

export interface LatestTenantHealthRow {
  domain_id: string;
  status: TenantHealthStatus;
  http_status: number | null;
  latency_ms: number;
  expected_release_id: string;
  observed_release_id: string | null;
  error_message: string | null;
  checked_at: string;
}

export interface ScheduledTenantHealthRow {
  domain_id: string;
  scheduled_checks: number | string;
  ready_scheduled_checks: number | string;
}

export interface CurrentTenantHealth {
  domainId: string;
  hostname: string;
  status: TenantHealthStatus | "unchecked";
  httpStatus: number | null;
  latencyMs: number | null;
  expectedReleaseId: string | null;
  observedReleaseId: string | null;
  errorMessage: string | null;
  checkedAt: string | null;
  fresh: boolean;
  releaseMatches: boolean;
  scheduledChecks: number;
  expectedScheduledChecks: number;
  readyScheduledChecks: number;
  scheduleCoverage: number;
  readinessRate: number;
  reliable: boolean;
}

export function summarizeTenantHealth(
  domains: HealthPortfolioDomain[],
  latestHealth: LatestTenantHealthRow[],
  now = new Date(),
  scheduledHealth: ScheduledTenantHealthRow[] = [],
  expectedScheduledChecks = 0,
): {
  health: { published: number; ready: number; reliable: number; failing: number; stale: number; unchecked: number; scheduledChecks: number; expectedScheduledChecks: number; readyScheduledChecks: number; reliabilityThreshold: number; lastCheckedAt: string | null };
  healthChecks: CurrentTenantHealth[];
  allTenantsReady: boolean;
  allTenantsReliable: boolean;
} {
  const freshAfter = new Date(now.getTime() - HEALTH_FRESH_MS).toISOString();
  const latestByDomain = new Map(latestHealth.map((row) => [row.domain_id, row]));
  const scheduledByDomain = new Map(scheduledHealth.map((row) => [row.domain_id, row]));
  const publishedDomains = domains.filter((domain) => domain.lifecycle_status === "published");
  const healthChecks = publishedDomains.map<CurrentTenantHealth>((domain) => {
    const check = latestByDomain.get(domain.domain_id);
    const fresh = Boolean(check && check.checked_at >= freshAfter);
    const releaseMatches = Boolean(check && check.expected_release_id === domain.active_release_id && check.observed_release_id === domain.active_release_id);
    const scheduled = scheduledByDomain.get(domain.domain_id);
    const scheduledChecks = Number(scheduled?.scheduled_checks ?? 0);
    const readyScheduledChecks = Number(scheduled?.ready_scheduled_checks ?? 0);
    const scheduleCoverage = expectedScheduledChecks === 0 ? 1 : Math.min(1, scheduledChecks / expectedScheduledChecks);
    const readinessRate = scheduledChecks === 0 ? (expectedScheduledChecks === 0 ? 1 : 0) : readyScheduledChecks / scheduledChecks;
    const reliable = expectedScheduledChecks === 0 || (scheduleCoverage >= HEALTH_RELIABILITY_THRESHOLD && readinessRate >= HEALTH_RELIABILITY_THRESHOLD);
    return {
      domainId: domain.domain_id,
      hostname: domain.hostname,
      status: check?.status ?? "unchecked",
      httpStatus: check?.http_status ?? null,
      latencyMs: check?.latency_ms ?? null,
      expectedReleaseId: check?.expected_release_id ?? domain.active_release_id,
      observedReleaseId: check?.observed_release_id ?? null,
      errorMessage: check?.error_message ?? null,
      checkedAt: check?.checked_at ?? null,
      fresh,
      releaseMatches,
      scheduledChecks,
      expectedScheduledChecks,
      readyScheduledChecks,
      scheduleCoverage,
      readinessRate,
      reliable,
    };
  });
  const health = {
    published: publishedDomains.length,
    ready: healthChecks.filter((check) => check.fresh && check.status === "ready" && check.releaseMatches).length,
    reliable: healthChecks.filter((check) => check.reliable).length,
    failing: healthChecks.filter((check) => check.fresh && (check.status !== "ready" || !check.releaseMatches)).length,
    stale: healthChecks.filter((check) => check.checkedAt && !check.fresh).length,
    unchecked: healthChecks.filter((check) => !check.checkedAt).length,
    scheduledChecks: healthChecks.reduce((sum, check) => sum + check.scheduledChecks, 0),
    expectedScheduledChecks: expectedScheduledChecks * publishedDomains.length,
    readyScheduledChecks: healthChecks.reduce((sum, check) => sum + check.readyScheduledChecks, 0),
    reliabilityThreshold: HEALTH_RELIABILITY_THRESHOLD,
    lastCheckedAt: healthChecks.map((check) => check.checkedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
  };
  return {
    health,
    healthChecks,
    allTenantsReady: health.published > 0 && health.ready === health.published,
    allTenantsReliable: health.published > 0 && health.reliable === health.published,
  };
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value || "Unknown readiness failure");
  return message.replaceAll(/\s+/g, " ").slice(0, 300);
}

async function checkDomain(
  domain: HealthDomain,
  checkedAt: string,
  request: typeof fetch,
  sharedSecret: string,
  checkSource: HealthCheckSource,
): Promise<TenantHealthResult> {
  const checkId = `health_${(await sha256Hex(`${domain.id}:${checkedAt}:${checkSource}`)).slice(0, 32)}`;
  const signature = await hmacSha256Hex(sharedSecret, `${checkId}:${checkSource}:${domain.hostname}`);
  const started = Date.now();
  try {
    const response = await request(`https://${domain.hostname}/readyz`, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "User-Agent": "DomainMonetizer-Health/1.0",
        "X-DM-Health-Id": checkId,
        "X-DM-Health-Source": checkSource,
        "X-DM-Health-Signature": signature,
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const payload: ReadinessPayload = await response.json<ReadinessPayload>().catch((): ReadinessPayload => ({}));
    const observedReleaseId = typeof payload.releaseId === "string" ? payload.releaseId : null;
    const exact = response.status === 200
      && payload.ok === true
      && payload.state === "live"
      && payload.hostname === domain.hostname
      && observedReleaseId === domain.active_release_id;
    return {
      checkId,
      domainId: domain.id,
      hostname: domain.hostname,
      status: exact ? "ready" : "not_ready",
      httpStatus: response.status,
      latencyMs: Math.max(0, Date.now() - started),
      expectedReleaseId: domain.active_release_id,
      observedReleaseId,
      errorMessage: exact
        ? null
        : boundedMessage(`Readiness mismatch: HTTP ${response.status}, state ${String(payload.state ?? "missing")}, hostname ${String(payload.hostname ?? "missing")}, release ${observedReleaseId ?? "missing"}`),
      checkedAt,
    };
  } catch (error) {
    return {
      checkId,
      domainId: domain.id,
      hostname: domain.hostname,
      status: "unreachable",
      httpStatus: null,
      latencyMs: Math.max(0, Date.now() - started),
      expectedReleaseId: domain.active_release_id,
      observedReleaseId: null,
      errorMessage: boundedMessage(error),
      checkedAt,
    };
  }
}

async function mapBounded<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function checkPublishedTenants(
  env: Pick<Env, "DB" | "CONTROL_SHARED_SECRET">,
  now = new Date(),
  request: typeof fetch = fetch,
  checkSource: HealthCheckSource = "manual",
): Promise<TenantHealthBatchResult> {
  const checkedAt = now.toISOString();
  const query = await env.DB.prepare(
    "SELECT id,hostname,active_release_id FROM domains WHERE lifecycle_status='published' AND active_release_id IS NOT NULL ORDER BY hostname LIMIT ?",
  ).bind(HEALTH_CHECK_LIMIT + 1).all<HealthDomain>();
  const truncated = query.results.length > HEALTH_CHECK_LIMIT;
  const domains = query.results.slice(0, HEALTH_CHECK_LIMIT);
  const results = await mapBounded(domains, HEALTH_CHECK_CONCURRENCY, (domain) => checkDomain(domain, checkedAt, request, env.CONTROL_SHARED_SECRET, checkSource));
  const retentionBoundary = new Date(now.getTime() - HEALTH_RETENTION_MS).toISOString();
  const statements = [env.DB.prepare("DELETE FROM tenant_health_checks WHERE checked_at<?").bind(retentionBoundary)];
  for (const result of results) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO tenant_health_checks (id,domain_id,status,http_status,latency_ms,expected_release_id,observed_release_id,error_message,checked_at,check_source) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(domain_id,checked_at) DO UPDATE SET status=excluded.status,http_status=excluded.http_status,latency_ms=excluded.latency_ms,expected_release_id=excluded.expected_release_id,observed_release_id=excluded.observed_release_id,error_message=excluded.error_message,check_source=excluded.check_source",
      ).bind(
        result.checkId,
        result.domainId,
        result.status,
        result.httpStatus,
        result.latencyMs,
        result.expectedReleaseId,
        result.observedReleaseId,
        result.errorMessage,
        result.checkedAt,
        checkSource,
      ),
    );
  }
  await env.DB.batch(statements);
  return {
    checkedAt,
    checked: results.length,
    ready: results.filter((result) => result.status === "ready").length,
    notReady: results.filter((result) => result.status === "not_ready").length,
    unreachable: results.filter((result) => result.status === "unreachable").length,
    truncated,
    checkSource,
    results,
  };
}
