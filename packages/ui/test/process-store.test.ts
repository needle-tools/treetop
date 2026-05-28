/**
 * Tests for the process telemetry store. Two reactive surfaces:
 *
 *  1. `recordSamples` maintains a rolling 5-minute history per process
 *     (for the sparklines) and prunes dead processes — the leak risk is
 *     real (a long-running dashboard sees hundreds of short-lived TUIs).
 *  2. `procByOwnerId` / `procByPid` are derived indexes the session
 *     columns read on every render; they must recompute when
 *     `processStore` changes.
 *
 * The module holds singleton state, so each test resets it first.
 */

import { test, expect, describe, beforeEach, afterEach, setSystemTime } from "bun:test";
import { get } from "svelte/store";
import {
  recordSamples,
  getHistory,
  processStore,
  procHistory,
  procByOwnerId,
  procByPid,
  type ProcEntry,
} from "../src/process-store";

function proc(over: Partial<ProcEntry> & { id: string; pid: number }): ProcEntry {
  return {
    cmd: ["x"],
    cwd: "/",
    cpuPercent: 0,
    memBytes: 0,
    ...over,
  };
}

beforeEach(() => {
  // recordSamples([]) drops history for all processes (none are "live"),
  // and resets procHistory to an empty map. processStore.set clears the
  // raw list so the derived indexes start empty too.
  recordSamples([]);
  processStore.set([]);
});

afterEach(() => {
  // Reset the faked clock so a sibling test/file sees real time.
  setSystemTime();
});

describe("recordSamples / getHistory", () => {
  test("records one sample per process", () => {
    recordSamples([
      proc({ id: "p1", pid: 1, cpuPercent: 10, memBytes: 1000 }),
      proc({ id: "p2", pid: 2, cpuPercent: 20, memBytes: 2000 }),
    ]);
    const h1 = getHistory("p1");
    expect(h1.length).toBe(1);
    expect(h1[0]!.cpuPercent).toBe(10);
    expect(h1[0]!.memBytes).toBe(1000);
    expect(getHistory("p2")[0]!.cpuPercent).toBe(20);
  });

  test("appends across successive samples for the same process", () => {
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 10, memBytes: 1 })]);
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 11, memBytes: 1 })]);
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 12, memBytes: 1 })]);
    expect(getHistory("p1").map((s) => s.cpuPercent)).toEqual([10, 11, 12]);
  });

  test("getHistory returns [] for an unknown process", () => {
    expect(getHistory("never-seen")).toEqual([]);
  });

  test("drops the history of a process that disappears from the sample", () => {
    // The leak guard: once a TUI exits it's no longer in the sample, so
    // its buffer must be deleted rather than accumulating forever.
    recordSamples([
      proc({ id: "p1", pid: 1 }),
      proc({ id: "p2", pid: 2 }),
    ]);
    recordSamples([proc({ id: "p1", pid: 1 })]); // p2 gone
    // p1 keeps accumulating (two samples); p2's buffer is reclaimed.
    expect(getHistory("p1").length).toBe(2);
    expect(getHistory("p2")).toEqual([]);
  });

  test("trims samples older than the 5-minute window", () => {
    const t0 = new Date("2026-05-28T12:00:00.000Z");
    setSystemTime(t0);
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 1 })]);
    // Jump 6 minutes; the t0 sample is now older than the 5-minute cutoff.
    setSystemTime(new Date(t0.getTime() + 6 * 60 * 1000));
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 2 })]);
    const h = getHistory("p1");
    expect(h.length).toBe(1);
    expect(h[0]!.cpuPercent).toBe(2);
  });

  test("keeps samples that are still inside the window", () => {
    const t0 = new Date("2026-05-28T12:00:00.000Z");
    setSystemTime(t0);
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 1 })]);
    setSystemTime(new Date(t0.getTime() + 2 * 60 * 1000)); // 2 min later
    recordSamples([proc({ id: "p1", pid: 1, cpuPercent: 2 })]);
    expect(getHistory("p1").map((s) => s.cpuPercent)).toEqual([1, 2]);
  });

  test("publishes a fresh procHistory map on each record (reactivity)", () => {
    const before = get(procHistory);
    recordSamples([proc({ id: "p1", pid: 1 })]);
    const after = get(procHistory);
    // New Map reference so Svelte's store equality fires subscribers.
    expect(after).not.toBe(before);
    expect(after.get("p1")?.length).toBe(1);
  });
});

describe("procByOwnerId (derived)", () => {
  test("indexes only processes that carry an ownerId", () => {
    processStore.set([
      proc({ id: "p1", pid: 1, ownerId: "owner-a" }),
      proc({ id: "p2", pid: 2 }), // no ownerId
    ]);
    const map = get(procByOwnerId);
    expect(map.size).toBe(1);
    expect(map.get("owner-a")?.id).toBe("p1");
  });

  test("recomputes when processStore changes", () => {
    processStore.set([proc({ id: "p1", pid: 1, ownerId: "a" })]);
    expect(get(procByOwnerId).get("a")?.id).toBe("p1");
    processStore.set([proc({ id: "p2", pid: 2, ownerId: "a" })]);
    expect(get(procByOwnerId).get("a")?.id).toBe("p2");
  });

  test("last writer wins when two processes share an ownerId", () => {
    processStore.set([
      proc({ id: "p1", pid: 1, ownerId: "a" }),
      proc({ id: "p2", pid: 2, ownerId: "a" }),
    ]);
    expect(get(procByOwnerId).get("a")?.id).toBe("p2");
  });
});

describe("procByPid (derived)", () => {
  test("indexes every process by pid", () => {
    processStore.set([
      proc({ id: "p1", pid: 111 }),
      proc({ id: "p2", pid: 222 }),
    ]);
    const map = get(procByPid);
    expect(map.get(111)?.id).toBe("p1");
    expect(map.get(222)?.id).toBe("p2");
  });

  test("is empty for an empty process list", () => {
    processStore.set([]);
    expect(get(procByPid).size).toBe(0);
  });
});
