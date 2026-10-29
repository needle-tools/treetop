import { describe, expect, test } from "bun:test";
import { createStaleWhileRevalidateCache, createBackgroundRefresh } from "../src/async-cache";

test("background refresh returns immediately and joins the real work until completion", async () => {
  const errors: unknown[] = [];
  const refresh = createBackgroundRefresh(error => errors.push(error));
  let calls = 0;
  let release!: () => void;
  const load = () => { calls++; return new Promise<void>(resolve => {release = resolve;}); };
  expect(refresh("repo", load)).toBe(true);
  await Bun.sleep(0);
  for (let i = 0; i < 20; i++) expect(refresh("repo", load)).toBe(false);
  expect(calls).toBe(1);
  release();
  await Bun.sleep(0);
  expect(refresh("repo", async () => {throw new Error("git failed");})).toBe(true);
  await Bun.sleep(0);
  expect(errors).toHaveLength(1);
  expect(refresh("repo", async () => {calls++;})).toBe(true);
  await Bun.sleep(0);
  expect(calls).toBe(2);
});

describe("createStaleWhileRevalidateCache", () => {
  test("seeded telemetry returns immediately and shares a slow first scan", async () => {
    let calls = 0,
      release!: (value: number[]) => void;
    const seed: number[] = [];
    const cache = createStaleWhileRevalidateCache({
      ttlMs: 1000,
      initialValue: seed,
      load: () => {
        calls++;
        return new Promise<number[]>((resolve) => {
          release = resolve;
        });
      },
    });
    let returned = false;
    const first = cache.get().then((value) => {
      returned = true;
      return value;
    });
    try {
      await Bun.sleep(0);
      expect(returned).toBe(true);
      for (let i = 0; i < 20; i++) expect(await cache.get()).toBe(seed);
      expect(calls).toBe(1);
    } finally {
      release([7]);
      await first;
    }
    await Bun.sleep(0);
    expect(await cache.get()).toEqual([7]);
  });
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
