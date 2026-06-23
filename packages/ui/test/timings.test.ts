/**
 * Unit tests for packages/ui/src/timings.ts
 *
 * The module is a rolling latency recorder for hot paths: pure, sync (except
 * timeAsync), zero-dep. Tests assert real numeric behaviour over known sample
 * sets to make the percentile logic trustworthy.
 *
 * API mirrors packages/daemon/src/timings.ts exactly (same public surface,
 * same semantics) — plus a dev-only `__sgTimings` global (tested indirectly
 * via the module itself, not assertable in bun test where import.meta.env is
 * undefined and the guard is a no-op).
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  record,
  time,
  timeAsync,
  snapshot,
  recentSlowSamples,
  reset,
} from "../src/timings";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Record values 1..n under a given name and return what snapshot() says. */
function fill(name: string, n: number) {
  for (let i = 1; i <= n; i++) record(name, i);
  return snapshot()[name]!;
}

// ── always start each test clean ─────────────────────────────────────────────

beforeEach(() => reset());

// -----------------------------------------------------------------------------
// 1. Basic percentile correctness over a known sample set
// -----------------------------------------------------------------------------
describe("percentile computation over a known sample set", () => {
  test("p50 ≈ 50 when recording 1..100", () => {
    const s = fill("latency", 100);
    // p50 of [1..100] = 50 or 51 depending on rounding — accept 49–52
    expect(s.p50).toBeGreaterThanOrEqual(49);
    expect(s.p50).toBeLessThanOrEqual(52);
  });

  test("p95 ≈ 95 when recording 1..100", () => {
    const s = fill("latency", 100);
    // p95 of [1..100] — accept 94–97
    expect(s.p95).toBeGreaterThanOrEqual(94);
    expect(s.p95).toBeLessThanOrEqual(97);
  });

  test("max is 100 when recording 1..100", () => {
    const s = fill("latency", 100);
    expect(s.max).toBe(100);
  });

  test("last is the most-recently recorded value", () => {
    record("x", 7);
    record("x", 3);
    record("x", 99);
    const s = snapshot()["x"]!;
    expect(s.last).toBe(99);
  });

  test("count reflects total recordings (not capped)", () => {
    const s = fill("latency", 100);
    expect(s.count).toBe(100);
  });
});

// -----------------------------------------------------------------------------
// 2. Ring-buffer cap — recording > N=256 samples
// -----------------------------------------------------------------------------
describe("ring-buffer cap at N=256", () => {
  test("count keeps climbing past 256", () => {
    const s = fill("cap", 300);
    expect(s.count).toBe(300);
  });

  test("max and last reflect the retained window (last 256 of 1..300 → max 300)", () => {
    const s = fill("cap", 300);
    // window is samples 45..300 (last 256), max is 300
    expect(s.max).toBe(300);
    expect(s.last).toBe(300);
  });

  test("p50 reflects the retained window, not all 300 samples", () => {
    // last 256 of [1..300] = [45..300]; p50 of that ≈ 172–173
    const s = fill("cap", 300);
    expect(s.p50).toBeGreaterThanOrEqual(150);
    expect(s.p50).toBeLessThanOrEqual(200);
    // p50 must be well above 50 (which would be the whole-set median)
    expect(s.p50).toBeGreaterThan(100);
  });
});

// -----------------------------------------------------------------------------
// 3. time() — sync wrapper
// -----------------------------------------------------------------------------
describe("time() sync wrapper", () => {
  test("returns the function's return value", () => {
    const val = time("t", () => 42);
    expect(val).toBe(42);
  });

  test("records a sample (count increments)", () => {
    time("sync-path", () => "hello");
    const s = snapshot()["sync-path"]!;
    expect(s.count).toBe(1);
  });

  test("records even when fn throws, and re-throws", () => {
    expect(() =>
      time("err-path", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const s = snapshot()["err-path"]!;
    expect(s.count).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 4. timeAsync() — async wrapper
// -----------------------------------------------------------------------------
describe("timeAsync() async wrapper", () => {
  test("returns the resolved value", async () => {
    const val = await timeAsync("async-t", async () => 99);
    expect(val).toBe(99);
  });

  test("records a sample (count increments)", async () => {
    await timeAsync("async-path", async () => "ok");
    const s = snapshot()["async-path"]!;
    expect(s.count).toBe(1);
  });

  test("records even when the promise rejects, and re-throws", async () => {
    await expect(
      timeAsync("async-err", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
    const s = snapshot()["async-err"]!;
    expect(s.count).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 5. Non-finite / negative ms is ignored
// -----------------------------------------------------------------------------
describe("non-finite and negative ms guards", () => {
  test("NaN is ignored", () => {
    record("guard", NaN);
    expect(snapshot()["guard"]).toBeUndefined();
  });

  test("Infinity is ignored", () => {
    record("guard", Infinity);
    expect(snapshot()["guard"]).toBeUndefined();
  });

  test("-Infinity is ignored", () => {
    record("guard", -Infinity);
    expect(snapshot()["guard"]).toBeUndefined();
  });

  test("negative ms is ignored", () => {
    record("guard", -1);
    expect(snapshot()["guard"]).toBeUndefined();
  });

  test("zero ms is accepted (valid latency)", () => {
    record("guard", 0);
    const s = snapshot()["guard"]!;
    expect(s.count).toBe(1);
    expect(s.last).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// 6. reset() clears all state
// -----------------------------------------------------------------------------
describe("reset()", () => {
  test("clears all recorded spans", () => {
    fill("a", 10);
    fill("b", 5);
    reset();
    expect(snapshot()).toEqual({});
  });

  test("count starts at zero again after reset", () => {
    fill("r", 50);
    reset();
    record("r", 1);
    expect(snapshot()["r"]!.count).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 7. snapshot() — absent for unrecorded names
// -----------------------------------------------------------------------------
describe("snapshot() absent-key behaviour", () => {
  test("unrecorded span is absent (not present with zeros)", () => {
    expect(snapshot()["never-recorded"]).toBeUndefined();
  });

  test("snapshot returns an independent object (mutations don't affect internals)", () => {
    record("snap", 10);
    const s1 = snapshot();
    s1["snap"]!.count = 9999;
    const s2 = snapshot();
    expect(s2["snap"]!.count).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// 8. Multiple independent spans don't interfere
// -----------------------------------------------------------------------------
describe("multiple independent spans", () => {
  test("recording span A doesn't affect span B", () => {
    fill("a", 10);
    fill("b", 5);
    expect(snapshot()["a"]!.count).toBe(10);
    expect(snapshot()["b"]!.count).toBe(5);
  });
});

describe("recent slow samples", () => {
  test("keeps slow samples newest-first and omits sub-frame work", () => {
    record("fast", 5);
    record("slow-a", 17);
    record("slow-b", 31);

    expect(recentSlowSamples()).toMatchObject([
      { name: "slow-b", ms: 31 },
      { name: "slow-a", ms: 17 },
    ]);
  });

  test("honors the caller limit", () => {
    record("slow-a", 17);
    record("slow-b", 31);
    record("slow-c", 45);

    expect(recentSlowSamples(2).map((s) => s.name)).toEqual([
      "slow-c",
      "slow-b",
    ]);
  });
});
