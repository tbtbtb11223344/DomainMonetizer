import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { requireAdmin, requireSameOrigin } from "./auth";
import { mountApi, mountInternal, mountRunner } from "./api";
import { rollupYesterday } from "./metrics";
import type { Env, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

export function mutableResponse(response: Response): Response {
  return new Response(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
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
  return c.json({ error: "Internal server error", requestId: c.get("requestId") }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      rollupYesterday(env).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", task: "analytics_rollup", message: error instanceof Error ? error.message : "Unknown error" }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
