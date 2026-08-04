import { describe, expect, it, vi } from "vitest";
import { checkPublishedTenants, HEALTH_CHECK_LIMIT, summarizeTenantHealth } from "./health";

interface CapturedStatement {
  sql: string;
  args: unknown[];
  all: <T>() => Promise<{ results: T[] }>;
}

function fakeDatabase(domains: unknown[]) {
  const batches: CapturedStatement[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            all: async <T>() => ({ results: (sql.startsWith("SELECT") ? domains : []) as T[] }),
          };
        },
      };
    },
    async batch(statements: CapturedStatement[]) {
      batches.push(statements);
      return [];
    },
  };
  return { db: db as unknown as D1Database, batches };
}

describe("tenant health checks", () => {
  it("requires fresh checks and exact release alignment for portfolio readiness", () => {
    const domains = [
      { domain_id: "dom_ready", hostname: "ready.example", lifecycle_status: "published", active_release_id: "rel_ready" },
      { domain_id: "dom_mismatch", hostname: "mismatch.example", lifecycle_status: "published", active_release_id: "rel_new" },
      { domain_id: "dom_stale", hostname: "stale.example", lifecycle_status: "published", active_release_id: "rel_stale" },
      { domain_id: "dom_draft", hostname: "draft.example", lifecycle_status: "draft", active_release_id: null },
    ];
    const latest = [
      { domain_id: "dom_ready", status: "ready" as const, http_status: 200, latency_ms: 40, expected_release_id: "rel_ready", observed_release_id: "rel_ready", error_message: null, checked_at: "2026-08-05T06:47:00.000Z" },
      { domain_id: "dom_mismatch", status: "ready" as const, http_status: 200, latency_ms: 50, expected_release_id: "rel_old", observed_release_id: "rel_old", error_message: null, checked_at: "2026-08-05T06:47:00.000Z" },
      { domain_id: "dom_stale", status: "ready" as const, http_status: 200, latency_ms: 60, expected_release_id: "rel_stale", observed_release_id: "rel_stale", error_message: null, checked_at: "2026-08-04T20:00:00.000Z" },
    ];

    const result = summarizeTenantHealth(domains, latest, new Date("2026-08-05T08:00:00.000Z"));

    expect(result.health).toEqual({ published: 3, ready: 1, reliable: 3, failing: 1, stale: 1, unchecked: 0, scheduledChecks: 0, expectedScheduledChecks: 0, readyScheduledChecks: 0, reliabilityThreshold: 0.95, lastCheckedAt: "2026-08-05T06:47:00.000Z" });
    expect(result.allTenantsReady).toBe(false);
    expect(result.allTenantsReliable).toBe(true);
    expect(result.healthChecks.find((check) => check.domainId === "dom_mismatch")).toMatchObject({ fresh: true, releaseMatches: false });
    expect(result.healthChecks.find((check) => check.domainId === "dom_stale")).toMatchObject({ fresh: false, releaseMatches: true });
  });

  it("requires an exact live hostname and release match", async () => {
    const domains = [
      { id: "dom_ready", hostname: "ready.example", active_release_id: "rel_ready" },
      { id: "dom_stale", hostname: "stale.example", active_release_id: "rel_new" },
      { id: "dom_down", hostname: "down.example", active_release_id: "rel_down" },
    ];
    const { db, batches } = fakeDatabase(domains);
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ready.example")) return Response.json({ ok: true, hostname: "ready.example", state: "live", releaseId: "rel_ready" });
      if (url.includes("stale.example")) return Response.json({ ok: true, hostname: "stale.example", state: "live", releaseId: "rel_old" });
      throw new Error("DNS lookup failed");
    });

    const result = await checkPublishedTenants({ DB: db }, new Date("2026-08-05T00:47:00.000Z"), request as typeof fetch, "scheduled");

    expect(result).toMatchObject({ checked: 3, ready: 1, notReady: 1, unreachable: 1, truncated: false, checkSource: "scheduled" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every((call) => String(call[0]).endsWith("/readyz"))).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
    expect(batches[0]![0]!.sql).toContain("DELETE FROM tenant_health_checks");
    const inserts = batches[0]!.slice(1);
    expect(inserts.map((statement) => statement.args[2])).toEqual(["ready", "not_ready", "unreachable"]);
    expect(inserts.every((statement) => statement.args.at(-1) === "scheduled")).toBe(true);
    expect(inserts[0]!.sql).toContain("ON CONFLICT(domain_id,checked_at)");
    expect(inserts[1]!.args).toEqual(expect.arrayContaining(["rel_new", "rel_old"]));
    expect(String(inserts[2]!.args[7])).toContain("DNS lookup failed");
  });

  it("requires 95 percent scheduled coverage and readiness for every tenant", () => {
    const domains = ["ready", "tolerated", "coverage", "readiness"].map((name) => ({
      domain_id: `dom_${name}`,
      hostname: `${name}.example`,
      lifecycle_status: "published",
      active_release_id: `rel_${name}`,
    }));
    const scheduled = [
      { domain_id: "dom_ready", scheduled_checks: 56, ready_scheduled_checks: 56 },
      { domain_id: "dom_tolerated", scheduled_checks: 56, ready_scheduled_checks: 54 },
      { domain_id: "dom_coverage", scheduled_checks: 53, ready_scheduled_checks: 53 },
      { domain_id: "dom_readiness", scheduled_checks: 56, ready_scheduled_checks: 53 },
    ];

    const result = summarizeTenantHealth(domains, [], new Date("2026-08-19T04:17:00.000Z"), scheduled, 56);

    expect(result.health).toMatchObject({ published: 4, reliable: 2, scheduledChecks: 221, expectedScheduledChecks: 224, readyScheduledChecks: 216 });
    expect(result.allTenantsReliable).toBe(false);
    expect(result.healthChecks.find((check) => check.domainId === "dom_tolerated")).toMatchObject({ reliable: true, scheduledChecks: 56, readyScheduledChecks: 54 });
    expect(result.healthChecks.find((check) => check.domainId === "dom_coverage")).toMatchObject({ reliable: false, scheduleCoverage: 53 / 56 });
    expect(result.healthChecks.find((check) => check.domainId === "dom_readiness")).toMatchObject({ reliable: false, readinessRate: 53 / 56 });
  });

  it("bounds a pilot invocation below the free-plan subrequest ceiling", async () => {
    const domains = Array.from({ length: HEALTH_CHECK_LIMIT + 1 }, (_, index) => ({
      id: `dom_${index}`,
      hostname: `domain-${index}.example`,
      active_release_id: `rel_${index}`,
    }));
    const { db } = fakeDatabase(domains);
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const hostname = new URL(String(input)).hostname;
      const index = hostname.match(/domain-(\d+)/)?.[1];
      return Response.json({ ok: true, hostname, state: "live", releaseId: `rel_${index}` });
    });

    const result = await checkPublishedTenants({ DB: db }, new Date("2026-08-05T00:47:00.000Z"), request as typeof fetch);

    expect(result.checked).toBe(HEALTH_CHECK_LIMIT);
    expect(result.ready).toBe(HEALTH_CHECK_LIMIT);
    expect(result.truncated).toBe(true);
    expect(request).toHaveBeenCalledTimes(HEALTH_CHECK_LIMIT);
  });
});
