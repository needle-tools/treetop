/**
 * Why this exists: the dashboard's `load()` is called from many places —
 * the initial mount, every SSE `change` / `error` event, the
 * newSessionPollTimer's 3s tick, refreshes after add/remove/checkout/
 * pull/push/color/link mutations, etc. Each call streams `/api/repos`
 * NDJSON end-to-end (manifest + one frame per repo). On workspaces with
 * many repos that's hundreds of ms of git fan-out per call; an SSE
 * burst (rapid `fs_change` from a build, multiple mutations landing in
 * the same tick) easily issues two or three concurrent loads that all
 * do the same work and race each other writing into `repos`.
 *
 * The fix is a single-flight wrapper: while a load is already running,
 * callers receive the *same* in-flight promise instead of starting a
 * fresh one. A new load can begin only after the previous one settles.
 *
 * Kept generic so any other "expensive idempotent refresh" can reuse it.
 */

import { test, expect, describe } from "bun:test";
import { singleFlight } from "../src/single-flight";

describe("singleFlight", () => {
  test("concurrent calls share the same in-flight promise", async () => {
    let started = 0;
    let resolveInner: (v: number) => void = () => {};
    const inner = (): Promise<number> => {
      started += 1;
      return new Promise((res) => {
        resolveInner = res;
      });
    };

    const sf = singleFlight(inner);
    const a = sf();
    const b = sf();
    const c = sf();

    expect(started).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);

    resolveInner(42);
    expect(await a).toBe(42);
    expect(await b).toBe(42);
    expect(await c).toBe(42);
  });

  test("a new call starts a fresh run after the previous one resolves", async () => {
    let started = 0;
    const inner = async (): Promise<number> => {
      started += 1;
      return started;
    };

    const sf = singleFlight(inner);
    const first = await sf();
    const second = await sf();

    expect(started).toBe(2);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  test("forwards arguments to the run that wins the flight", async () => {
    const args: string[] = [];
    let resolveInner: (v: string) => void = () => {};
    const inner = (reason: string): Promise<string> => {
      args.push(reason);
      if (args.length > 1) return Promise.resolve(reason);
      return new Promise((res) => {
        resolveInner = res;
      });
    };

    const sf = singleFlight(inner);
    const first = sf("initial");
    const second = sf("coalesced");

    expect(first).toBe(second);
    expect(args).toEqual(["initial"]);

    resolveInner("done");
    expect(await second).toBe("done");

    expect(await sf("next")).toBe("next");
    expect(args).toEqual(["initial", "next"]);
  });

  test("a new call starts a fresh run after the previous one rejects", async () => {
    let started = 0;
    let rejectInner: (e: Error) => void = () => {};
    const inner = (): Promise<number> => {
      started += 1;
      if (started === 1) {
        return new Promise((_res, rej) => {
          rejectInner = rej;
        });
      }
      return Promise.resolve(99);
    };

    const sf = singleFlight(inner);
    const failed = sf();
    rejectInner(new Error("boom"));
    await expect(failed).rejects.toThrow("boom");

    // Second call must start a *new* run (the failed promise is no
    // longer cached) — otherwise a one-time network blip would wedge
    // every future load() into the same rejected promise.
    const ok = await sf();
    expect(started).toBe(2);
    expect(ok).toBe(99);
  });

  test("abandons a hung in-flight call once it outlives maxPendingMs", async () => {
    // The wedge this guards against: a fetch that stalls while the machine
    // sleeps never settles, so without a staleness bound every later
    // caller receives the same dead promise and the dashboard never
    // refreshes until a full reload. With maxPendingMs set, a caller that
    // arrives after the in-flight call has outlived the bound starts a
    // fresh run instead.
    let started = 0;
    let now = 1000;
    const clock = () => now;
    const inner = (): Promise<number> => {
      started += 1;
      // First call hangs forever; later calls resolve to their ordinal.
      if (started === 1) return new Promise<number>(() => {});
      return Promise.resolve(started);
    };
    const sf = singleFlight(inner, { maxPendingMs: 30_000, clock });

    const hung = sf();
    expect(started).toBe(1);

    // Still within the bound → coalesce onto the hung promise.
    now = 1000 + 30_000;
    expect(sf()).toBe(hung);
    expect(started).toBe(1);

    // Past the bound → abandon the hung call and start fresh.
    now = 1000 + 30_001;
    const fresh = sf();
    expect(started).toBe(2);
    expect(fresh).not.toBe(hung);
    expect(await fresh).toBe(2);
  });

  test("without maxPendingMs, an in-flight call coalesces indefinitely", () => {
    let started = 0;
    const inner = (): Promise<number> => {
      started += 1;
      return new Promise<number>(() => {});
    };
    const sf = singleFlight(inner);
    const a = sf();
    const b = sf();
    expect(a).toBe(b);
    expect(started).toBe(1);
  });

  test("does not collapse calls that arrive after settle but in the same tick", async () => {
    // Guards a subtle bug: if the wrapper cleared `inFlight` via
    // .then() inside the same microtask the inner resolved, a caller
    // landing in the *next* microtask could re-enter while inFlight
    // was still set. This test verifies the wrapper is robust to that
    // — once the inner has settled, the very next call starts a new
    // run, not a shared one.
    let started = 0;
    const inner = async (): Promise<number> => {
      started += 1;
      return started;
    };
    const sf = singleFlight(inner);

    await sf();
    await sf();
    expect(started).toBe(2);
  });
});
