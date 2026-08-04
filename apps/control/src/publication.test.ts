import { describe, expect, it, vi } from "vitest";
import { switchActivePointer } from "./api";

function kvNamespace(input: { failInitialPut?: boolean; failRecovery?: boolean } = {}) {
  let putCount = 0;
  return {
    put: vi.fn(async () => {
      putCount += 1;
      if (putCount === 1 && input.failInitialPut) throw new Error("Initial KV write failed");
      if (putCount > 1 && input.failRecovery) throw new Error("Recovery KV write failed");
    }),
    delete: vi.fn(async () => {
      if (input.failRecovery) throw new Error("Recovery KV delete failed");
    }),
  };
}

describe("active release pointer switching", () => {
  it("publishes the runtime pointer before committing the control-plane state", async () => {
    const order: string[] = [];
    const kv = kvNamespace();
    kv.put.mockImplementation(async () => { order.push("pointer"); });
    const commit = vi.fn(async () => { order.push("database"); });

    await switchActivePointer(kv as never, "example.com", "rel_next", "rel_previous", commit);

    expect(order).toEqual(["pointer", "database"]);
    expect(kv.put).toHaveBeenCalledWith("site:example.com:active", "rel_next");
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("does not mutate D1 when the runtime pointer cannot be written", async () => {
    const kv = kvNamespace({ failInitialPut: true });
    const commit = vi.fn(async () => undefined);

    await expect(switchActivePointer(kv as never, "example.com", "rel_next", "rel_previous", commit))
      .rejects.toThrow("Initial KV write failed");

    expect(commit).not.toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("restores the previous pointer when the D1 commit fails", async () => {
    const kv = kvNamespace();
    const commit = vi.fn(async () => { throw new Error("D1 commit failed"); });

    await expect(switchActivePointer(kv as never, "example.com", "rel_next", "rel_previous", commit))
      .rejects.toThrow("D1 commit failed");

    expect(kv.put.mock.calls).toEqual([
      ["site:example.com:active", "rel_next"],
      ["site:example.com:active", "rel_previous"],
    ]);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("removes a first-publication pointer when its D1 commit fails", async () => {
    const kv = kvNamespace();
    const commit = vi.fn(async () => { throw new Error("D1 commit failed"); });

    await expect(switchActivePointer(kv as never, "example.com", "rel_first", null, commit))
      .rejects.toThrow("D1 commit failed");

    expect(kv.put).toHaveBeenCalledWith("site:example.com:active", "rel_first");
    expect(kv.delete).toHaveBeenCalledWith("site:example.com:active");
  });

  it("preserves the original commit error if pointer recovery also fails", async () => {
    const kv = kvNamespace({ failRecovery: true });
    const commit = vi.fn(async () => { throw new Error("D1 commit failed"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(switchActivePointer(kv as never, "example.com", "rel_next", "rel_previous", commit))
      .rejects.toThrow("D1 commit failed");

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"task":"active_pointer_recovery"'));
    consoleError.mockRestore();
  });
});
