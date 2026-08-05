import { describe, expect, it } from "vitest";
import { mutableResponse, scheduledTaskForCron } from "./index";

describe("control response handling", () => {
  it("copies asset responses before middleware adds security headers", async () => {
    const source = new Response("admin shell", {
      headers: { "Content-Type": "text/html" },
      status: 200,
    });

    const copied = mutableResponse(source);
    copied.headers.set("X-Frame-Options", "DENY");

    expect(copied.status).toBe(200);
    expect(copied.headers.get("Content-Type")).toBe("text/html");
    expect(copied.headers.get("Cache-Control")).toBe("no-store");
    expect(copied.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await copied.text()).toBe("admin shell");
  });

  it("preserves immutable caching for fingerprinted static assets", async () => {
    const source = new Response("compiled asset", {
      headers: {
        "Content-Type": "text/javascript",
      },
    });

    const copied = mutableResponse(source, "/assets/app.123.js");

    expect(copied.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await copied.text()).toBe("compiled asset");
  });
});

describe("scheduled task routing", () => {
  it("maps only the two committed cron expressions", () => {
    expect(scheduledTaskForCron("47 */6 * * *")).toBe("tenant_health");
    expect(scheduledTaskForCron("17 4 * * *")).toBe("analytics_rollup");
  });

  it("fails closed for an unrecognized cron expression", () => {
    expect(() => scheduledTaskForCron("0 * * * *")).toThrow("Unrecognized cron trigger");
  });
});
