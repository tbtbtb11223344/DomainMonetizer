import { describe, expect, it } from "vitest";
import { accessAssertionFromHeaders } from "./auth";

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
