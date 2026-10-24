import { expect, test } from "bun:test";
import { BackgroundLease } from "../src/background-lease";

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const options = {
    now: () => now,
    schedule(run: () => void, delay: number) {
      const key = id++;
      timers.set(key, { at: now + delay, run });
      return () => {
        timers.delete(key);
      };
    },
  };
  return {
    options,
    sleep(ms: number) {
      now += ms;
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = Math.max(now, next[1].at);
        timers.delete(next[0]);
        next[1].run();
      }
      now = end;
    },
    pending: () => [...timers.values()].map((t) => t.run),
  };
}

test("broker expires after fifteen awake minutes without a UI and cannot leak indefinitely", () => {
  const fake = clock();
  let stopped = 0;
  const lease = new BackgroundLease({
    timers: fake.options,
    expire: () => {
      stopped++;
    },
    log: () => {},
  });
  fake.advance(899_999);
  expect(stopped).toBe(0);
  fake.advance(1);
  expect(stopped).toBe(1);
  fake.advance(900_000);
  expect(stopped).toBe(1);
  lease.dispose();
});

test("a reconnected UI invalidates an already queued cleanup callback", () => {
  const fake = clock();
  let stopped = 0;
  const lease = new BackgroundLease({
    timers: fake.options,
    expire: () => {
      stopped++;
    },
    log: () => {},
  });
  const stale = fake.pending()[0]!;
  fake.advance(899_000);
  lease.renew("new-window", 1);
  stale();
  fake.advance(899_999);
  expect(stopped).toBe(0);
  fake.advance(1);
  expect(stopped).toBe(1);
  lease.dispose();
});

test("multiple windows keep sessions alive and stale reports cannot extend a lease", () => {
  const fake = clock();
  let stopped = 0;
  const lease = new BackgroundLease({
    timers: fake.options,
    expire: () => {
      stopped++;
    },
    log: () => {},
  });
  lease.renew("first", 10);
  fake.advance(400_000);
  lease.renew("second", 1);
  fake.advance(400_000);
  expect(lease.renew("first", 9)).toBe(false);
  fake.advance(499_999);
  expect(stopped).toBe(0);
  fake.advance(1);
  expect(stopped).toBe(1);
  lease.dispose();
});

test("standby maintenance wake cannot reap sessions before UI reconnection", () => {
  const fake = clock();
  let stopped = 0;
  const lease = new BackgroundLease({
    timers: fake.options,
    expire: () => {
      stopped++;
    },
    log: () => {},
  });
  fake.sleep(3_441_000);
  fake.advance(0);
  expect(stopped).toBe(0);
  fake.advance(800);
  lease.renew("resumed", 1);
  for (let i = 0; i < 10; i++) {
    fake.advance(120_000);
    lease.renew("resumed", i + 2);
  }
  expect(stopped).toBe(0);
  lease.dispose();
  expect(fake.pending()).toHaveLength(0);
});

test("renewal during an asynchronous cleanup decision fences off the old cleanup", () => {
  const fake = clock();
  let cleanupGeneration = -1;
  const lease = new BackgroundLease({
    timers: fake.options,
    expire: (generation) => {
      cleanupGeneration = generation;
    },
    log: () => {},
  });
  fake.advance(900_000);
  expect(lease.isCurrent(cleanupGeneration)).toBe(true);
  expect(lease.renew("returned-before-kill", 1)).toBe(true);
  expect(lease.isCurrent(cleanupGeneration)).toBe(false);
  lease.dispose();
});
