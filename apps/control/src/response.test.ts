import { describe, expect, it } from "vitest";
import { mutableResponse } from "./index";

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
    expect(copied.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await copied.text()).toBe("admin shell");
  });
});
