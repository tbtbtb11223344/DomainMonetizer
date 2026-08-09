import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsData, completedUtcDayCount, latestCompletedUtcDate, missingCompletedUtcDates, rollupCoverageTarget, rollupDate, rollupMissingCompletedDates } from "./metrics";

interface CapturedStatement {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
  all: <T>() => Promise<{ results: T[] }>;
}

function fakeDatabase(queryResults: unknown[] = [], expectedCanaryResults: unknown[] = []) {
  const statements: CapturedStatement[] = [];
  const batches: CapturedStatement[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const statement: CapturedStatement = {
            sql,
            args,
            run: async () => ({ meta: { changes: 1 } }),
            all: async <T>() => ({ results: (sql.includes("COUNT(h.id) AS expected_canaries") ? expectedCanaryResults : queryResults) as T[] }),
          };
          statements.push(statement);
          return statement;
        },
      };
    },
    async batch(batch: CapturedStatement[]) {
      batches.push(batch);
      return [];
    },
  };
  return { db: db as unknown as D1Database, statements, batches };
}

function environment(db: D1Database) {
  return {
    DB: db,
    SITE_CONFIG: {} as KVNamespace,
    ASSETS: {} as Fetcher,
    ENVIRONMENT: "test",
    ALLOWED_ADMIN_EMAIL: "operator@example.com",
    ACCESS_TEAM_DOMAIN: "access.example.com",
    ACCESS_AUD: "audience",
    ALLOW_LOCAL_ADMIN: "false",
    CONTROL_SHARED_SECRET: "control-secret",
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    ANALYTICS_READ_TOKEN: "analytics-token",
    ANALYTICS_DATASET: "domain_monetizer_events",
    TELEMETRY_MIN_DATE: "2026-08-05",
    EXACT_SESSION_MIN_DATE: "2026-08-05",
    PREVIEW_HOSTNAME: "preview.multibrands.net",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analytics rollups", () => {
  it("measures coverage against the actual latest completed UTC day", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    expect(latestCompletedUtcDate(now)).toBe("2026-08-09");
    expect(completedUtcDayCount("2026-08-05", now)).toBe(5);
    expect(completedUtcDayCount("2026-08-11", now)).toBe(0);
    expect(rollupCoverageTarget("2026-08-05", 4, "2026-08-08", now)).toEqual({
      latestCompletedDate: "2026-08-09",
      expectedFullDays: 5,
      complete: false,
    });
    expect(rollupCoverageTarget("2026-08-05", 5, "2026-08-09", now).complete).toBe(true);
  });

  it("plans the oldest missing completed dates and bounds automatic recovery", () => {
    const now = new Date("2026-08-12T04:17:00.000Z");
    const successful = ["2026-08-05", "2026-08-07", "2026-08-10"];
    expect(missingCompletedUtcDates("2026-08-05", successful, now, 3)).toEqual(["2026-08-06", "2026-08-08", "2026-08-09"]);
    expect(missingCompletedUtcDates("2026-08-12", [], now)).toEqual([]);
  });

  it("automatically replays a missing completed day after an earlier success", async () => {
    const { db } = fakeDatabase([{ metric_date: "2026-08-05" }]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const batch = await rollupMissingCompletedDates(environment(db), new Date("2026-08-07T04:17:00.000Z"));

    expect(batch.plannedDates).toEqual(["2026-08-06"]);
    expect(batch.results).toEqual([{ skipped: false, metricDate: "2026-08-06", domainRows: 0, countryRows: 0, sourceRows: 0, canaryRows: 0, expectedCanaries: 0, observedCanaries: 0, canarySampleInterval: 1, telemetryVerified: false, maxSampleInterval: 1, uniqueSampleInterval: 1 }]);
    expect(batch.failures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("parses the SQL API envelope and rejects the old assumed array shape", () => {
    expect(analyticsData<{ value: number }>({ data: [{ value: 3 }] })).toEqual([{ value: 3 }]);
    expect(() => analyticsData([{ value: 3 }])).toThrow("data array");
  });

  it("preserves a bounded Analytics API diagnostic when a query is rejected", async () => {
    const { db, statements } = fakeDatabase([], [{ domain_id: "dom_1", expected_canaries: "4" }]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      if (body.includes("AS us_unique_visitors")) {
        return new Response("Input was invalid: unsupported aggregate", { status: 422 });
      }
      return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } });
    }));

    await expect(rollupDate(environment(db), "2026-08-05", new Date("2026-08-06T12:00:00.000Z")))
      .rejects.toThrow("Analytics query failed (422): Input was invalid: unsupported aggregate");

    const finish = [...statements].reverse().find((statement) => statement.sql.startsWith("UPDATE analytics_rollup_runs SET"));
    expect(finish?.args).toContain("Analytics query failed (422): Input was invalid: unsupported aggregate");
  });

  it("skips launch data before the clean telemetry boundary", async () => {
    const { db, statements, batches } = fakeDatabase();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await rollupDate(environment(db), "2026-08-04", new Date("2026-08-05T12:00:00.000Z"));

    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(batches).toHaveLength(0);
    expect(statements.some((statement) => statement.sql.includes("analytics_rollup_runs"))).toBe(true);
    expect(statements.at(-1)?.args).toContain("skipped");
  });

  it("rejects partial and future UTC days before creating a rollup run", async () => {
    const { db, statements } = fakeDatabase();

    await expect(rollupDate(environment(db), "2026-08-05", new Date("2026-08-05T12:00:00.000Z")))
      .rejects.toThrow("completed UTC day");
    await expect(rollupDate(environment(db), "2026-08-06", new Date("2026-08-05T12:00:00.000Z")))
      .rejects.toThrow("completed UTC day");

    expect(statements).toHaveLength(0);
  });

  it("excludes preview traffic and persists qualified, unique, and country metrics", async () => {
    const { db, batches } = fakeDatabase([], [{ domain_id: "dom_1", expected_canaries: "4" }]);
    const responses = [
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", views: "12", engaged_visits: "4", likely_human_views: "7", bot_views: "3", unknown_views: "2", human_engaged_visits: "3", us_likely_human_views: "5", clicks: "0", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", unique_visitors: "6", us_unique_visitors: "4", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", country: "US", views: "8", likely_human_views: "5", human_engaged_visits: "2", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", visitor_class: "human", classification_reason: "browser_navigation", country: "US", asn: "7922", as_org: "Comcast Cable", views: "5", engaged_visits: "2", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", observed_canaries: "4", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", path_class: "service", device_class: "mobile", referrer_class: "search", views: "4", likely_human_views: "3", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", region_code: "TX", local_time_bucket: "08-11", views: "4", likely_human_views: "3", max_sample_interval: "1" }] },
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = responses.shift();
      expect(String(init?.body)).toContain("blob2 != 'preview.multibrands.net'");
      expect(String(init?.body)).toContain("timestamp >= toDateTime('2026-08-05 00:00:00')");
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await rollupDate(environment(db), "2026-08-05", new Date("2026-08-06T12:00:00.000Z"));

    expect(result).toMatchObject({ skipped: false, domainRows: 1, countryRows: 1, sourceRows: 1, canaryRows: 1, expectedCanaries: 4, observedCanaries: 4, canarySampleInterval: 1, telemetryVerified: true, maxSampleInterval: 1, uniqueSampleInterval: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const queryBodies = fetchMock.mock.calls.map((call) => String(call[1]?.body));
    expect(queryBodies.filter((body) => body.includes("max(_sample_interval) AS max_sample_interval"))).toHaveLength(7);
    expect(queryBodies.some((body) => body.includes("blob10 AS as_org"))).toBe(true);
    expect(queryBodies.some((body) => body.includes("AS unique_visitors") && body.includes("AS us_unique_visitors") && body.includes("blob1 = 'qualified_session_v3'") && body.includes("index1 IN ('dom_1')"))).toBe(true);
    expect(queryBodies.some((body) => body.includes("blob11 AS path_class") && body.includes("blob12 AS device_class") && body.includes("blob13 AS referrer_class"))).toBe(true);
    expect(queryBodies.some((body) => body.includes("blob14 AS region_code") && body.includes("blob15 AS local_time_bucket"))).toBe(true);
    expect(queryBodies.some((body) => body.includes("blob1 = 'health_canary'") && body.includes("blob8 = 'health_scheduled'"))).toBe(true);
    expect(queryBodies.filter((body) => body.includes("sumIf") && body.includes("blob1 IN"))).toHaveLength(3);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toHaveLength(12);
    expect(batch[0]!.sql).toContain("UPDATE daily_domain_metrics SET views=0");
    expect(batch[1]!.sql).toContain("DELETE FROM daily_domain_country_metrics");
    expect(batch[2]!.sql).toContain("DELETE FROM daily_domain_source_metrics");
    expect(batch[3]!.sql).toContain("DELETE FROM daily_domain_telemetry_health");
    expect(batch[4]!.sql).toContain("DELETE FROM daily_domain_intent_metrics");
    expect(batch[5]!.sql).toContain("DELETE FROM daily_domain_context_metrics");
    const domain = batch[6]!;
    expect(domain.sql).toContain("unique_visitors");
    expect(domain.sql).toContain("max_sample_interval");
    expect(domain.args).toEqual(expect.arrayContaining(["dom_1", "2026-08-05", 12, 7, 3, 2, 5, 6, 4]));
    expect(batch[7]!.args).toEqual(expect.arrayContaining(["US", 8, 5, 2]));
    expect(batch[8]!.args).toEqual(expect.arrayContaining(["human", "browser_navigation", "US", 7922, "Comcast Cable", 5, 2]));
    expect(batch[9]!.args).toEqual(expect.arrayContaining(["dom_1", "2026-08-05", 4, 4, 1, 1]));
    expect(batch[10]!.args).toEqual(expect.arrayContaining(["dom_1", "2026-08-05", "service", "mobile", "search", 4, 3]));
    expect(batch[11]!.args).toEqual(expect.arrayContaining(["dom_1", "2026-08-05", "TX", "08-11", 4, 3]));
  });

  it("retains the legacy session query before the isolated-session boundary", async () => {
    const { db } = fakeDatabase();
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } });
    }));
    const env = { ...environment(db), EXACT_SESSION_MIN_DATE: "2026-08-06" };

    await rollupDate(env, "2026-08-05", new Date("2026-08-06T12:00:00.000Z"));

    expect(bodies.some((body) => body.includes("count(DISTINCT blob7)") && body.includes("blob1 = 'view'"))).toBe(true);
    expect(bodies.some((body) => body.includes("blob1 = 'qualified_session_v3'"))).toBe(false);
  });

  it("clears stale traffic and country rows even when a rerun is empty", async () => {
    const { db, batches } = fakeDatabase();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } })));

    const result = await rollupDate(environment(db), "2026-08-05", new Date("2026-08-06T12:00:00.000Z"));

    expect(result).toMatchObject({ skipped: false, domainRows: 0, countryRows: 0, sourceRows: 0 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(6);
    expect(batches[0]![0]!.sql).toContain("SET views=0");
    expect(batches[0]![1]!.sql).toContain("DELETE FROM daily_domain_country_metrics");
    expect(batches[0]![2]!.sql).toContain("DELETE FROM daily_domain_source_metrics");
    expect(batches[0]![3]!.sql).toContain("DELETE FROM daily_domain_telemetry_health");
    expect(batches[0]![4]!.sql).toContain("DELETE FROM daily_domain_intent_metrics");
    expect(batches[0]![5]!.sql).toContain("DELETE FROM daily_domain_context_metrics");
  });

  it("persists sampling evidence so distinct sessions cannot silently become decision-grade", async () => {
    const { db, statements, batches } = fakeDatabase([], [{ domain_id: "dom_1", expected_canaries: "4" }]);
    const responses = [
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", views: "20", engaged_visits: "0", likely_human_views: "20", bot_views: "0", unknown_views: "0", human_engaged_visits: "0", us_likely_human_views: "20", clicks: "0", max_sample_interval: "10" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", unique_visitors: "2", us_unique_visitors: "1", max_sample_interval: "20" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", country: "US", views: "20", likely_human_views: "20", human_engaged_visits: "0", max_sample_interval: "10" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", visitor_class: "human", classification_reason: "browser_navigation", country: "US", asn: "7922", as_org: "Comcast Cable", views: "20", engaged_visits: "0", max_sample_interval: "10" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", observed_canaries: "4", max_sample_interval: "1" }] },
      { data: [] },
      { data: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { headers: { "Content-Type": "application/json" } })));

    const result = await rollupDate(environment(db), "2026-08-05", new Date("2026-08-06T12:00:00.000Z"));

    expect(result.maxSampleInterval).toBe(20);
    expect(result.uniqueSampleInterval).toBe(20);
    const domainInsert = batches[0]!.find((statement) => statement.sql.startsWith("INSERT INTO daily_domain_metrics"));
    expect(domainInsert?.args.slice(-3, -1)).toEqual([20, 20]);
    const finish = [...statements].reverse().find((statement) => statement.sql.startsWith("UPDATE analytics_rollup_runs SET"));
    expect(finish?.args.slice(9, 11)).toEqual([20, 20]);
  });

  it("keeps exact sessions separate from sampled quality breakdowns", async () => {
    const { db, statements, batches } = fakeDatabase([], [{ domain_id: "dom_1", expected_canaries: "4" }]);
    const responses = [
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", views: "30", engaged_visits: "3", likely_human_views: "20", bot_views: "5", unknown_views: "5", human_engaged_visits: "2", us_likely_human_views: "12", clicks: "0", max_sample_interval: "3" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", unique_visitors: "8", us_unique_visitors: "6", max_sample_interval: "1" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", country: "US", views: "30", likely_human_views: "20", human_engaged_visits: "2", max_sample_interval: "3" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", visitor_class: "human", classification_reason: "browser_navigation", country: "US", asn: "7922", as_org: "Comcast Cable", views: "20", engaged_visits: "2", max_sample_interval: "3" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", observed_canaries: "4", max_sample_interval: "1" }] },
      { data: [] },
      { data: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { headers: { "Content-Type": "application/json" } })));

    const result = await rollupDate(environment(db), "2026-08-05", new Date("2026-08-06T12:00:00.000Z"));

    expect(result).toMatchObject({ maxSampleInterval: 3, uniqueSampleInterval: 1 });
    const domainInsert = batches[0]!.find((statement) => statement.sql.startsWith("INSERT INTO daily_domain_metrics"));
    expect(domainInsert?.args.slice(-3, -1)).toEqual([3, 1]);
    const finish = [...statements].reverse().find((statement) => statement.sql.startsWith("UPDATE analytics_rollup_runs SET"));
    expect(finish?.args.slice(9, 11)).toEqual([3, 1]);
  });

  it("marks the event pipeline unverified when a scheduled canary is missing", async () => {
    const { db, statements, batches } = fakeDatabase([], [{ domain_id: "dom_1", expected_canaries: "4" }]);
    const responses = [
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", observed_canaries: "3", max_sample_interval: "1" }] },
      { data: [] },
      { data: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responses.shift()), { headers: { "Content-Type": "application/json" } })));

    const result = await rollupDate(environment(db), "2026-08-05", new Date("2026-08-06T12:00:00.000Z"));

    expect(result).toMatchObject({ expectedCanaries: 4, observedCanaries: 3, canarySampleInterval: 1, telemetryVerified: false });
    const telemetryInsert = batches[0]!.find((statement) => statement.sql.startsWith("INSERT INTO daily_domain_telemetry_health"));
    expect(telemetryInsert?.args).toEqual(expect.arrayContaining(["dom_1", "2026-08-05", 4, 3, 1, 0]));
    const finish = [...statements].reverse().find((statement) => statement.sql.startsWith("UPDATE analytics_rollup_runs SET"));
    expect(finish?.args.slice(4, 9)).toEqual([1, 4, 3, 1, 0]);
  });
});
