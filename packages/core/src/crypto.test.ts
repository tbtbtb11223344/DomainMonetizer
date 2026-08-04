import { describe, expect, it } from "vitest";
import { hmacSha256Hex, timingSafeEqualString } from "./crypto";

describe("cryptographic helpers", () => {
  it("creates stable keyed health signatures without exposing the secret", async () => {
    const first = await hmacSha256Hex("control-secret", "health_id:scheduled:example.com");
    const second = await hmacSha256Hex("control-secret", "health_id:scheduled:example.com");
    const forged = await hmacSha256Hex("wrong-secret", "health_id:scheduled:example.com");

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toContain("control-secret");
    expect(timingSafeEqualString(first, second)).toBe(true);
    expect(timingSafeEqualString(first, forged)).toBe(false);
  });
});
