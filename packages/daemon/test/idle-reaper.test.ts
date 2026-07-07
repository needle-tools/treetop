import { test, expect, describe } from "bun:test";
import {
  selectIdleTerminals,
  selectStaleUnattachedSpawns,
  IdleReaper,
} from "../src/idle-reaper";
import type {
  IdleCandidate,
  UnattachedSpawnCandidate,
} from "../src/idle-reaper";

// A fixed "now" so the tests don't depend on the wall clock.
const NOW = Date.parse("2026-06-12T12:00:00.000Z");
const IDLE_MS = 10 * 60 * 1000;
/** ISO timestamp `ageMs` before NOW. */
const ago = (ageMs: number) => new Date(NOW - ageMs).toISOString();

function candidate(over: Partial<IdleCandidate> = {}): IdleCandidate {
  return {
    id: "t1",
    pid: 100,
    isAlive: true,
    isSsh: true,
    visibleCount: 0,
    lastOutputAt: ago(IDLE_MS + 1000), // idle past the threshold by default
    ...over,
  };
}

describe("selectIdleTerminals", () => {
  test("reaps a hidden, idle ssh terminal", () => {
    expect(selectIdleTerminals([candidate()], { now: NOW, idleMs: IDLE_MS })).toEqual([
      "t1",
    ]);
  });

  test("spares a terminal with an on-screen socket", () => {
    expect(
      selectIdleTerminals([candidate({ visibleCount: 1 })], {
        now: NOW,
        idleMs: IDLE_MS,
      }),
    ).toEqual([]);
  });

  test("spares a non-ssh terminal (agents, dev servers)", () => {
    expect(
      selectIdleTerminals([candidate({ isSsh: false })], {
        now: NOW,
        idleMs: IDLE_MS,
      }),
    ).toEqual([]);
  });

  test("spares a terminal that emitted output within the window", () => {
    expect(
      selectIdleTerminals([candidate({ lastOutputAt: ago(IDLE_MS - 1000) })], {
        now: NOW,
        idleMs: IDLE_MS,
      }),
    ).toEqual([]);
  });

  test("spares an already-dead terminal", () => {
    expect(
      selectIdleTerminals([candidate({ isAlive: false })], {
        now: NOW,
        idleMs: IDLE_MS,
      }),
    ).toEqual([]);
  });

  test("reaps exactly at the threshold boundary", () => {
    expect(
      selectIdleTerminals([candidate({ lastOutputAt: ago(IDLE_MS) })], {
        now: NOW,
        idleMs: IDLE_MS,
      }),
    ).toEqual(["t1"]);
  });

  test("ignores a candidate with an unparseable timestamp", () => {
    expect(
      selectIdleTerminals([candidate({ lastOutputAt: "not-a-date" })], {
        now: NOW,
        idleMs: IDLE_MS,
      }),
    ).toEqual([]);
  });

  test("selects only the qualifying terminals from a mixed set", () => {
    const set: IdleCandidate[] = [
      candidate({ id: "reap-me" }),
      candidate({ id: "visible", visibleCount: 2 }),
      candidate({ id: "agent", isSsh: false }),
      candidate({ id: "busy", lastOutputAt: ago(1000) }),
      candidate({ id: "dead", isAlive: false }),
      candidate({ id: "reap-me-too" }),
    ];
    expect(
      selectIdleTerminals(set, { now: NOW, idleMs: IDLE_MS }).sort(),
    ).toEqual(["reap-me", "reap-me-too"]);
  });
});

describe("selectStaleUnattachedSpawns", () => {
  const GRACE_MS = 90_000;
  // `spawnedAt` is a performance.now()-style ms value; use a fixed origin so
  // the arithmetic is stable regardless of wall clock.
  const NOW_MS = 1_000_000;
  const spawnedAgo = (ageMs: number): number => NOW_MS - ageMs;

  function spawn(
    over: Partial<UnattachedSpawnCandidate> = {},
  ): UnattachedSpawnCandidate {
    return {
      id: "t1",
      spawnedAt: spawnedAgo(GRACE_MS + 1000), // past the window by default
      isAlive: true,
      ...over,
    };
  }

  test("reaps a live PTY that never attached within the grace window", () => {
    expect(
      selectStaleUnattachedSpawns([spawn()], { now: NOW_MS, graceMs: GRACE_MS }),
    ).toEqual(["t1"]);
  });

  test("spares a freshly-spawned PTY still inside the grace window", () => {
    expect(
      selectStaleUnattachedSpawns([spawn({ spawnedAt: spawnedAgo(1000) })], {
        now: NOW_MS,
        graceMs: GRACE_MS,
      }),
    ).toEqual([]);
  });

  test("spares an already-dead PTY (exit already cleaned it up)", () => {
    expect(
      selectStaleUnattachedSpawns([spawn({ isAlive: false })], {
        now: NOW_MS,
        graceMs: GRACE_MS,
      }),
    ).toEqual([]);
  });

  test("reaps exactly at the grace boundary", () => {
    expect(
      selectStaleUnattachedSpawns([spawn({ spawnedAt: spawnedAgo(GRACE_MS) })], {
        now: NOW_MS,
        graceMs: GRACE_MS,
      }),
    ).toEqual(["t1"]);
  });

  test("selects only the qualifying PTYs from a mixed set", () => {
    const set: UnattachedSpawnCandidate[] = [
      spawn({ id: "orphan" }),
      spawn({ id: "fresh", spawnedAt: spawnedAgo(1000) }),
      spawn({ id: "dead", isAlive: false }),
      spawn({ id: "orphan-too" }),
    ];
    expect(
      selectStaleUnattachedSpawns(set, {
        now: NOW_MS,
        graceMs: GRACE_MS,
      }).sort(),
    ).toEqual(["orphan", "orphan-too"]);
  });
});

describe("IdleReaper", () => {
  test("sweep kills exactly the qualifying terminals", async () => {
    const killed: string[] = [];
    const reaper = new IdleReaper({
      idleMs: IDLE_MS,
      now: () => NOW,
      getCandidates: () => [
        candidate({ id: "stale" }),
        candidate({ id: "fresh", lastOutputAt: ago(1000) }),
      ],
      killTerminal: async (id) => {
        killed.push(id);
      },
      log: () => {},
    });
    await reaper.sweep();
    expect(killed).toEqual(["stale"]);
  });

  test("sweep is a no-op when nothing qualifies", async () => {
    let called = false;
    const reaper = new IdleReaper({
      idleMs: IDLE_MS,
      now: () => NOW,
      getCandidates: () => [candidate({ visibleCount: 1 })],
      killTerminal: async () => {
        called = true;
      },
      log: () => {},
    });
    await reaper.sweep();
    expect(called).toBe(false);
  });

  test("a failing kill does not abort the rest of the sweep", async () => {
    const killed: string[] = [];
    const reaper = new IdleReaper({
      idleMs: IDLE_MS,
      now: () => NOW,
      getCandidates: () => [
        candidate({ id: "boom" }),
        candidate({ id: "ok" }),
      ],
      killTerminal: async (id) => {
        if (id === "boom") throw new Error("kill failed");
        killed.push(id);
      },
      log: () => {},
    });
    await reaper.sweep();
    expect(killed).toEqual(["ok"]);
  });

  test("logs the host of a reaped ssh terminal", async () => {
    const logs: string[] = [];
    const reaper = new IdleReaper({
      idleMs: IDLE_MS,
      now: () => NOW,
      getCandidates: () => [candidate({ id: "t1" })],
      killTerminal: async () => {},
      log: (m) => logs.push(m),
    });
    await reaper.sweep();
    expect(logs.some((l) => l.includes("t1"))).toBe(true);
  });

  test("start()/dispose() manage the sweep timer without throwing", () => {
    const reaper = new IdleReaper({
      idleMs: IDLE_MS,
      sweepMs: 10_000,
      getCandidates: () => [],
      killTerminal: async () => {},
      log: () => {},
    });
    reaper.start();
    reaper.start(); // idempotent
    reaper.dispose();
    reaper.dispose(); // idempotent
  });
});
