/**
 * Faithful copies of App.svelte's unread-pulse state machine as of commit
 * cae4cadf5fb7c6dc3e5b158fbbe20ee5ecdbe276.
 *
 * Step 2 extracts a createUnreadPulseManager() factory with these same
 * injected collaborators and re-points these tests; if behavior matches,
 * the extraction is proven safe.
 *
 * (Mirrors how session-source-routing was done.)
 */

import { test, expect, describe, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Constants (pin the real values)
// ---------------------------------------------------------------------------

const FINISH_DEBOUNCE_MS = 8_000;
const READ_GRACE_MS = 3_000;
const MIN_WORKING_FOR_PULSE_MS = 3_000;

// ---------------------------------------------------------------------------
// Shim types
// ---------------------------------------------------------------------------

type TimerHandle = number;
type ScheduledCall = { fn: () => void; ms: number; handle: TimerHandle };

interface PulseState {
  transientFinishedAt: Record<string, number | undefined>;
  finishedTimers: Record<string, TimerHandle | undefined>;
  readGraceTimers: Record<string, TimerHandle | undefined>;
}

interface PulseCollaborators {
  state: PulseState;
  /** Fake setTimeout — records calls, returns a handle. */
  schedule: (fn: () => void, ms: number) => TimerHandle;
  /** Fake clearTimeout — marks the handle as cancelled. */
  clear: (handle: TimerHandle) => void;
  /** Controllable stand-in for the real isSessionFocused(). */
  isSessionFocused: (source: string) => boolean;
  /** Controllable stand-in for Date.now(). */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Shim implementations — VERBATIM copies of App.svelte's function bodies,
// with closed-over reactive state replaced by injected collaborators.
// ---------------------------------------------------------------------------

function makeShims(collab: PulseCollaborators) {
  const { state, schedule, clear, isSessionFocused, now } = collab;

  function cancelFinishedTimer(source: string): void {
    const t = state.finishedTimers[source];
    if (t) {
      clear(t);
      state.finishedTimers[source] = undefined;
    }
  }

  function clearFinishedFor(source: string): void {
    cancelFinishedTimer(source);
    if (state.transientFinishedAt[source] !== undefined) {
      state.transientFinishedAt = {
        ...state.transientFinishedAt,
        [source]: undefined,
      };
    }
  }

  function scheduleFinished(source: string): void {
    cancelFinishedTimer(source);
    state.finishedTimers[source] = schedule(() => {
      state.finishedTimers[source] = undefined;
      if (isSessionFocused(source)) return;
      state.transientFinishedAt = {
        ...state.transientFinishedAt,
        [source]: now(),
      };
    }, FINISH_DEBOUNCE_MS);
  }

  function cancelReadGrace(source: string): void {
    const t = state.readGraceTimers[source];
    if (t) {
      clear(t);
      state.readGraceTimers[source] = undefined;
    }
  }

  function startReadGrace(source: string): void {
    cancelReadGrace(source);
    if (state.transientFinishedAt[source] === undefined) return;
    state.readGraceTimers[source] = schedule(() => {
      state.readGraceTimers[source] = undefined;
      clearFinishedFor(source);
    }, READ_GRACE_MS);
  }

  return {
    scheduleFinished,
    cancelFinishedTimer,
    clearFinishedFor,
    startReadGrace,
    cancelReadGrace,
  };
}

// ---------------------------------------------------------------------------
// Test harness factory — fresh state + timer registry per test
// ---------------------------------------------------------------------------

function makeHarness(opts?: { focused?: boolean; nowMs?: number }) {
  const state: PulseState = {
    transientFinishedAt: {},
    finishedTimers: {},
    readGraceTimers: {},
  };

  let nextHandle = 1;
  const pending = new Map<TimerHandle, ScheduledCall>();
  const cancelled = new Set<TimerHandle>();

  const schedule = (fn: () => void, ms: number): TimerHandle => {
    const handle = nextHandle++;
    pending.set(handle, { fn, ms, handle });
    return handle;
  };

  const clear = (handle: TimerHandle): void => {
    cancelled.add(handle);
    pending.delete(handle);
  };

  const fire = (handle: TimerHandle): void => {
    const call = pending.get(handle);
    if (!call) throw new Error(`Timer ${handle} not pending (cleared?)`);
    pending.delete(handle);
    call.fn();
  };

  const collab: PulseCollaborators = {
    state,
    schedule,
    clear,
    isSessionFocused: () => opts?.focused ?? false,
    now: () => opts?.nowMs ?? 1_000_000,
  };

  const fns = makeShims(collab);

  return { state, pending, cancelled, fire, collab, ...fns };
}

// ===========================================================================
// Constants
// ===========================================================================

describe("constants", () => {
  test("FINISH_DEBOUNCE_MS is 8000", () => {
    expect(FINISH_DEBOUNCE_MS).toBe(8_000);
  });

  test("READ_GRACE_MS is 3000", () => {
    expect(READ_GRACE_MS).toBe(3_000);
  });

  test("MIN_WORKING_FOR_PULSE_MS is 3000", () => {
    expect(MIN_WORKING_FOR_PULSE_MS).toBe(3_000);
  });
});

// ===========================================================================
// scheduleFinished
// ===========================================================================

describe("scheduleFinished", () => {
  test("schedules a timer with ms === FINISH_DEBOUNCE_MS (8000)", () => {
    const h = makeHarness();
    h.scheduleFinished("src-a");
    expect(h.pending.size).toBe(1);
    const [call] = [...h.pending.values()];
    expect(call.ms).toBe(FINISH_DEBOUNCE_MS);
  });

  test("when fired and session is NOT focused → sets state[source] = now()", () => {
    const h = makeHarness({ focused: false, nowMs: 42_000 });
    h.scheduleFinished("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    expect(h.state.transientFinishedAt["src-a"]).toBe(42_000);
  });

  test("when fired and session IS focused → does NOT set state[source]", () => {
    const h = makeHarness({ focused: true });
    h.scheduleFinished("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
  });

  test("calling twice for the same source → only one live timer (old one cancelled)", () => {
    const h = makeHarness();
    h.scheduleFinished("src-a");
    const first = [...h.pending.values()][0].handle;
    h.scheduleFinished("src-a");
    // old timer was cancelled
    expect(h.cancelled.has(first)).toBe(true);
    // only one pending timer remains
    expect(h.pending.size).toBe(1);
  });

  test("calling for different sources → independent timers both live", () => {
    const h = makeHarness();
    h.scheduleFinished("src-a");
    h.scheduleFinished("src-b");
    expect(h.pending.size).toBe(2);
  });

  test("clears finishedTimers[source] entry after firing", () => {
    const h = makeHarness({ focused: false });
    h.scheduleFinished("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    expect(h.state.finishedTimers["src-a"]).toBeUndefined();
  });

  test("preserves other sources in transientFinishedAt when stamping", () => {
    const h = makeHarness({ focused: false, nowMs: 99 });
    h.state.transientFinishedAt["src-b"] = 55;
    h.scheduleFinished("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    expect(h.state.transientFinishedAt["src-a"]).toBe(99);
    expect(h.state.transientFinishedAt["src-b"]).toBe(55);
  });
});

// ===========================================================================
// cancelFinishedTimer
// ===========================================================================

describe("cancelFinishedTimer", () => {
  test("clears the pending timer and sets finishedTimers[source] to undefined", () => {
    const h = makeHarness();
    h.scheduleFinished("src-a");
    const handle = h.state.finishedTimers["src-a"]!;
    h.cancelFinishedTimer("src-a");
    expect(h.cancelled.has(handle)).toBe(true);
    expect(h.state.finishedTimers["src-a"]).toBeUndefined();
    expect(h.pending.size).toBe(0);
  });

  test("no-op when there is no pending timer for that source", () => {
    const h = makeHarness();
    // should not throw
    expect(() => h.cancelFinishedTimer("src-noop")).not.toThrow();
    expect(h.cancelled.size).toBe(0);
  });

  test("does not affect other sources' timers", () => {
    const h = makeHarness();
    h.scheduleFinished("src-a");
    h.scheduleFinished("src-b");
    h.cancelFinishedTimer("src-a");
    // src-b still has a live timer
    expect(h.pending.size).toBe(1);
    const remaining = [...h.pending.values()][0];
    // its state record survives
    expect(h.state.finishedTimers["src-b"]).toBe(remaining.handle);
  });
});

// ===========================================================================
// clearFinishedFor
// ===========================================================================

describe("clearFinishedFor", () => {
  test("cancels the pending finished-timer AND sets state[source] to undefined", () => {
    const h = makeHarness({ focused: false });
    h.scheduleFinished("src-a");
    // Manually stamp a value so clearFinishedFor has something to clear
    h.state.transientFinishedAt["src-a"] = 12345;
    const handle = h.state.finishedTimers["src-a"]!;

    h.clearFinishedFor("src-a");

    expect(h.cancelled.has(handle)).toBe(true);
    expect(h.state.finishedTimers["src-a"]).toBeUndefined();
    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
  });

  test("when state[source] is already undefined → skips the spread-assign (state object identity check)", () => {
    const h = makeHarness();
    // No finished timer, no stamp
    const before = h.state.transientFinishedAt;
    h.clearFinishedFor("src-a");
    // The condition `!== undefined` was false, so no spread happened;
    // the reference must be the same object.
    expect(h.state.transientFinishedAt).toBe(before);
  });

  test("preserves other source stamps when clearing one", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-b"] = 77;
    h.state.transientFinishedAt["src-a"] = 88;

    h.clearFinishedFor("src-a");

    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
    expect(h.state.transientFinishedAt["src-b"]).toBe(77);
  });

  test("no-op when both timer and stamp are absent (no throw)", () => {
    const h = makeHarness();
    expect(() => h.clearFinishedFor("src-gone")).not.toThrow();
  });
});

// ===========================================================================
// startReadGrace
// ===========================================================================

describe("startReadGrace", () => {
  test("is a no-op when transientFinishedAt[source] is undefined", () => {
    const h = makeHarness();
    h.startReadGrace("src-a");
    expect(h.pending.size).toBe(0);
  });

  test("schedules a timer with ms === READ_GRACE_MS (3000) when source is stamped", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.startReadGrace("src-a");
    expect(h.pending.size).toBe(1);
    const [call] = [...h.pending.values()];
    expect(call.ms).toBe(READ_GRACE_MS);
  });

  test("when the grace timer fires → calls clearFinishedFor (state stamp removed)", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.startReadGrace("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
  });

  test("when the grace timer fires → readGraceTimers[source] is cleared to undefined", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.startReadGrace("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    expect(h.state.readGraceTimers["src-a"]).toBeUndefined();
  });

  test("calling twice → cancels the first grace timer, starts a new one (only one live)", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.startReadGrace("src-a");
    const first = [...h.pending.values()][0].handle;
    h.startReadGrace("src-a");
    expect(h.cancelled.has(first)).toBe(true);
    expect(h.pending.size).toBe(1);
  });

  test("cancelReadGrace before firing prevents state from being cleared", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.startReadGrace("src-a");
    h.cancelReadGrace("src-a");
    // timer was cleared, stamp survives
    expect(h.pending.size).toBe(0);
    expect(h.state.transientFinishedAt["src-a"]).toBe(1000);
  });
});

// ===========================================================================
// cancelReadGrace
// ===========================================================================

describe("cancelReadGrace", () => {
  test("clears the pending grace timer and sets readGraceTimers[source] to undefined", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.startReadGrace("src-a");
    const handle = h.state.readGraceTimers["src-a"]!;
    h.cancelReadGrace("src-a");
    expect(h.cancelled.has(handle)).toBe(true);
    expect(h.state.readGraceTimers["src-a"]).toBeUndefined();
    expect(h.pending.size).toBe(0);
  });

  test("no-op when there is no pending grace timer (no throw)", () => {
    const h = makeHarness();
    expect(() => h.cancelReadGrace("src-noop")).not.toThrow();
    expect(h.cancelled.size).toBe(0);
  });

  test("does not affect other sources' grace timers", () => {
    const h = makeHarness();
    h.state.transientFinishedAt["src-a"] = 1000;
    h.state.transientFinishedAt["src-b"] = 2000;
    h.startReadGrace("src-a");
    h.startReadGrace("src-b");
    h.cancelReadGrace("src-a");
    expect(h.pending.size).toBe(1);
  });
});

// ===========================================================================
// Interaction / edge-case tests
// ===========================================================================

describe("interactions", () => {
  test("scheduleFinished → (fire while focused) → state not stamped → startReadGrace is a no-op", () => {
    const h = makeHarness({ focused: true });
    h.scheduleFinished("src-a");
    const [call] = [...h.pending.values()];
    h.fire(call.handle);
    // state not stamped because focused
    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
    // startReadGrace should be a no-op
    h.startReadGrace("src-a");
    expect(h.pending.size).toBe(0);
  });

  test("full happy path: scheduleFinished → fire → startReadGrace → fire → cleared", () => {
    const h = makeHarness({ focused: false, nowMs: 5000 });
    h.scheduleFinished("src-a");
    h.fire([...h.pending.values()][0].handle);
    expect(h.state.transientFinishedAt["src-a"]).toBe(5000);

    h.startReadGrace("src-a");
    expect(h.pending.size).toBe(1);

    h.fire([...h.pending.values()][0].handle);
    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
  });

  test("clearFinishedFor mid-flight cancels the finished-timer so it can't stamp later", () => {
    const h = makeHarness({ focused: false });
    h.scheduleFinished("src-a");
    const handle = h.state.finishedTimers["src-a"]!;
    h.clearFinishedFor("src-a");
    expect(h.cancelled.has(handle)).toBe(true);
    expect(h.pending.size).toBe(0);
    // No stamp should appear even if the timer hypothetically fired
    expect(h.state.transientFinishedAt["src-a"]).toBeUndefined();
  });
});
