import { describe, expect, it } from "vitest";

import type { WindowCounter } from "@domain/task-7-2";

import { InMemoryRateLimitStore } from "./in-memory-rate-limit-store";

function counter(count: number, windowStartEpochMs: number): WindowCounter {
  return { count, windowStartEpochMs, blockedUntilEpochMs: null };
}

// **Validates: Requirements 2.7**
describe("InMemoryRateLimitStore", () => {
  it("stores and returns a counter before expiry", async () => {
    let now = 1_000;
    const store = new InMemoryRateLimitStore(() => now);
    await store.set("k", counter(2, 1_000), 5_000);
    now = 4_999;
    expect(await store.get("k")).toEqual(counter(2, 1_000));
  });

  it("drops an entry once its expiry passes", async () => {
    let now = 1_000;
    const store = new InMemoryRateLimitStore(() => now);
    await store.set("k", counter(2, 1_000), 5_000);
    now = 5_000;
    expect(await store.get("k")).toBeUndefined();
  });

  it("deletes on demand", async () => {
    const store = new InMemoryRateLimitStore(() => 1_000);
    await store.set("k", counter(1, 1_000), 5_000);
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });
});
