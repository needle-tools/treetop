/**
 * createLimiter caps how many async tasks run at once. /api/repos enrich
 * used to fire getWorktreeDetails (git subprocess + output parse) for
 * every worktree across every repo simultaneously on a cold cache — a
 * thundering herd that spiked daemon RSS to multiple GB and stalled the
 * event loop (starving terminal spawns). Gating the cold git ops through
 * a shared limiter flattens that peak while preserving throughput.
 */

import { test, expect, describe } from "bun:test";
import { createLimiter } from "../src/concurrency";

const defer = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createLimiter", () => {
  test("runs every task and returns each task's own result", async () => {
    const limit = createLimiter(2);
    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => limit(async () => n * 10)),
    );
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  test("never exceeds the configured concurrency", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await defer(5);
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  test("a rejecting task rejects only its own call and frees its slot", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    // Slot must be released so later work still runs (limit=1 would
    // deadlock if the rejection leaked the slot).
    expect(await limit(async () => "ok")).toBe("ok");
  });

  test("limit of 1 serializes — tasks never overlap", async () => {
    const limit = createLimiter(1);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await defer(2);
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
});
