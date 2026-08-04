import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { requireAdmin, requireSameOrigin } from "./auth";
import { mountApi, mountInternal, mountRunner } from "./api";
import { checkPublishedTenants } from "./health";
import { rollupMissingCompletedDates } from "./metrics";
import type { Env, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const HEALTH_CRON = "47 */6 * * *";

export function mutableResponse(response: Response): Response {
  const copy = new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  if (copy.headers.get("Content-Type")?.toLowerCase().includes("text/html")) {
    copy.headers.set("Cache-Control", "no-store");
  }
  return copy;
}

app.use("*", async (c, next) => {
  const requestId = c.req.header("Cf-Ray") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
});

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
    },
    crossOriginOpenerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-origin",
    referrerPolicy: "no-referrer",
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xContentTypeOptions: "nosniff",
    xFrameOptions: "DENY",
  }),
);

app.get("/healthz", (c) => c.json({ ok: true, service: "control" }));

mountInternal(app);
mountRunner(app);

app.use("/api/*", requireAdmin);
app.use("/api/*", requireSameOrigin);
mountApi(app);

app.use("*", requireAdmin);
app.get("*", async (c) => mutableResponse(await c.env.ASSETS.fetch(c.req.raw)));

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), message: error.message }));
  return c.json(
    {
      error: "Internal server error",
      requestId: c.get("requestId"),
      ...(c.get("authMethod") === "operator-token" ? { detail: error.message } : {}),
    },
    500,
  );
});

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const task = controller.cron === HEALTH_CRON
      ? checkPublishedTenants(env, new Date(controller.scheduledTime), fetch, "scheduled").then((batch) => {
        if (batch.truncated) throw new Error(`Tenant health check reached its ${batch.checked}-domain pilot limit`);
        console.log(JSON.stringify({ level: batch.ready === batch.checked ? "info" : "warn", task: "tenant_health", ...batch }));
      })
      : rollupMissingCompletedDates(env, new Date(controller.scheduledTime)).then((batch) => {
        if (batch.failures.length) {
          throw new Error(`Analytics rollup failed: ${batch.failures.map((failure) => `${failure.metricDate} (${failure.message})`).join(", ")}`);
        }
        console.log(JSON.stringify({ level: "info", task: "analytics_rollup", ...batch }));
      });
    ctx.waitUntil(task.catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", task: controller.cron === HEALTH_CRON ? "tenant_health" : "analytics_rollup", message: error instanceof Error ? error.message : "Unknown error" }));
      throw error;
    }));
  },
} satisfies ExportedHandler<Env>;
