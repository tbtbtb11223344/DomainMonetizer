import { describe, expect, it, vi } from "vitest";
import { accessAssertionFromHeaders, requireSameOrigin } from "./auth";

function sameOriginContext(input: {
  method: string;
  origin?: string;
  authMethod?: "access" | "operator-token";
  environment?: string;
  allowLocalAdmin?: string;
}) {
  const headers = new Headers();
  if (input.origin) headers.set("Origin", input.origin);
  return {
    env: {
      ENVIRONMENT: input.environment ?? "production",
      ALLOW_LOCAL_ADMIN: input.allowLocalAdmin ?? "false",
    },
    req: {
      method: input.method,
      url: "https://admin.multibrands.net/api/health/check",
      header: (name: string) => headers.get(name) ?? undefined,
    },
    get: (name: string) => name === "authMethod" ? input.authMethod ?? "access" : undefined,
    json: (body: unknown, status: number) => Response.json(body, { status }),
  } as never;
}

describe("Cloudflare Access assertion extraction", () => {
  it("prefers the origin assertion header", () => {
    const headers = new Headers({
      "Cf-Access-Jwt-Assertion": "header.jwt.value",
      Cookie: "CF_Authorization=cookie.jwt.value",
    });

    expect(accessAssertionFromHeaders(headers)).toBe("header.jwt.value");
  });

  it("uses the signed browser authorization cookie when the header is absent", () => {
    const headers = new Headers({
      Cookie: "unrelated=value; CF_Authorization=cookie.jwt.value; another=value",
    });

    expect(accessAssertionFromHeaders(headers)).toBe("cookie.jwt.value");
  });

  it("fails closed when neither signed token is present", () => {
    expect(accessAssertionFromHeaders(new Headers({ Cookie: "unrelated=value" }))).toBe("");
  });
});

describe("same-origin mutation boundary", () => {
  it("allows read-only browser requests without an Origin header", async () => {
    const next = vi.fn(async () => undefined);

    const response = await requireSameOrigin(sameOriginContext({ method: "GET" }), next);

    expect(response).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows same-origin Access mutations", async () => {
    const next = vi.fn(async () => undefined);

    const response = await requireSameOrigin(sameOriginContext({
      method: "POST",
      origin: "https://admin.multibrands.net",
    }), next);

    expect(response).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", undefined],
    ["foreign", "https://attacker.example"],
  ])("rejects %s Origin on Access mutations", async (_label, origin) => {
    const next = vi.fn(async () => undefined);

    const response = await requireSameOrigin(sameOriginContext(origin ? { method: "POST", origin } : { method: "POST" }), next);

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({ error: "Cross-origin mutation rejected" });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the independent operator token without a browser Origin", async () => {
    const next = vi.fn(async () => undefined);

    const response = await requireSameOrigin(sameOriginContext({ method: "POST", authMethod: "operator-token" }), next);

    expect(response).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows explicitly enabled local development without an Origin", async () => {
    const next = vi.fn(async () => undefined);

    const response = await requireSameOrigin(sameOriginContext({
      method: "POST",
      environment: "development",
      allowLocalAdmin: "true",
    }), next);

    expect(response).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
