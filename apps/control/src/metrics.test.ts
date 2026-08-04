import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsData, rollupDate } from "./metrics";

interface CapturedStatement {
  sql: string;
  args: unknown[];
  run: () => Promise<{ meta: { changes: number } }>;
}

function fakeDatabase() {
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
    PREVIEW_HOSTNAME: "preview.multibrands.net",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analytics rollups", () => {
  it("parses the SQL API envelope and rejects the old assumed array shape", () => {
    expect(analyticsData<{ value: number }>({ data: [{ value: 3 }] })).toEqual([{ value: 3 }]);
    expect(() => analyticsData([{ value: 3 }])).toThrow("data array");
  });

  it("skips launch data before the clean telemetry boundary", async () => {
    const { db, statements, batches } = fakeDatabase();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await rollupDate(environment(db), "2026-08-04");

    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(batches).toHaveLength(0);
    expect(statements.some((statement) => statement.sql.includes("analytics_rollup_runs"))).toBe(true);
    expect(statements.at(-1)?.args).toContain("skipped");
  });

  it("excludes preview traffic and persists qualified, unique, and country metrics", async () => {
    const { db, batches } = fakeDatabase();
    const responses = [
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", views: "12", engaged_visits: "4", likely_human_views: "7", bot_views: "3", unknown_views: "2", human_engaged_visits: "3", us_likely_human_views: "5", clicks: "0" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", unique_visitors: "6" }] },
      { data: [{ domain_id: "dom_1", metric_date: "2026-08-05", country: "US", views: "8", likely_human_views: "5", human_engaged_visits: "2" }] },
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = responses.shift();
      expect(String(init?.body)).toContain("blob2 != 'preview.multibrands.net'");
      expect(String(init?.body)).toContain("timestamp >= toDateTime('2026-08-05 00:00:00')");
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await rollupDate(environment(db), "2026-08-05");

    expect(result).toMatchObject({ skipped: false, domainRows: 1, countryRows: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const queryBodies = fetchMock.mock.calls.map((call) => String(call[1]?.body));
    expect(queryBodies.filter((body) => body.includes("_sample_interval"))).toHaveLength(2);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toHaveLength(2);
    const domain = batch[0]!;
    expect(domain.sql).toContain("unique_visitors");
    expect(domain.args).toEqual(expect.arrayContaining(["dom_1", "2026-08-05", 12, 7, 3, 2, 5, 6]));
    expect(batch[1]!.args).toEqual(expect.arrayContaining(["US", 8, 5, 2]));
  });
});
