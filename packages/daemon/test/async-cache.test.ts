import { describe, expect, test } from "bun:test";
import { createStaleWhileRevalidateCache } from "../src/async-cache";

describe("createStaleWhileRevalidateCache", () => {
  test("awaits the first load and reuses fresh cached values", async () => {
    let now = 1_000;
    let calls = 0;
    const cache = createStaleWhileRevalidateCache({
      ttlMs: 5_000,
      clock: () => now,
      load: async () => ++calls,
    });

    expect(await cache.get()).toBe(1);
    now += 4_000;
    expect(await cache.get()).toBe(1);
    expect(calls).toBe(1);
  });

  test("returns stale values immediately while one background refresh runs", async () => {
    let now = 0;
    let calls = 0;
    let release!: (value: number) => void;
    const cache = createStaleWhileRevalidateCache({
      ttlMs: 5_000,
      clock: () => now,
      load: async () => {
        calls++;
        if (calls === 1) return 1;
        return await new Promise<number>((resolve) => {
          release = resolve;
        });
      },
    });

    expect(await cache.get()).toBe(1);
    now = 6_000;

    const a = cache.get();
    const b = cache.get();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(calls).toBe(2);

    release(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.get()).toBe(2);
    expect(calls).toBe(2);
  });

  test("keeps the stale value when a background refresh fails", async () => {
    let now = 0;
    let calls = 0;
    const errors: unknown[] = [];
    const cache = createStaleWhileRevalidateCache({
      ttlMs: 5_000,
      clock: () => now,
      onRefreshError: (err) => errors.push(err),
      load: async () => {
        calls++;
        if (calls === 2) throw new Error("boom");
        return calls;
      },
    });

    expect(await cache.get()).toBe(1);
    now = 6_000;
    expect(await cache.get()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(await cache.get()).toBe(1);
  });

  test("shares the cold in-flight load when no cached value exists", async () => {
    let calls = 0;
    let release!: (value: number) => void;
    const cache = createStaleWhileRevalidateCache({
      ttlMs: 5_000,
      load: async () => {
        calls++;
        return await new Promise<number>((resolve) => {
          release = resolve;
        });
      },
    });

    const a = cache.get();
    const b = cache.get();
    release(7);

    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(calls).toBe(1);
  });
});
