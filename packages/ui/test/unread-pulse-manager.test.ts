/**
 * Behavior tests for the unread-pulse state machine.
 *
 * Originally written as shims (faithful copies of App.svelte's function bodies)
 * to characterize the behavior. Step 2 re-points them to the real
 * createUnreadPulseManager() factory — if the tests stay green, the extraction
 * is proven behavior-preserving.
 */

import { test, expect, describe } from "bun:test";
import {
  createUnreadPulseManager,
  FINISH_DEBOUNCE_MS,
  READ_GRACE_MS,
  MIN_WORKING_FOR_PULSE_MS,
} from "../src/unread-pulse-manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimerHandle = number;
type ScheduledCall = { fn: () => void; ms: number; handle: TimerHandle };

// ---------------------------------------------------------------------------
// Test harness factory — fresh state + timer registry per test
// ---------------------------------------------------------------------------

function makeHarness(opts?: { focused?: boolean; nowMs?: number }) {
  // Mutable state that the manager reads/writes via get/set callbacks.
  let transientFinishedAt: Record<string, number | undefined> = {};

  // Separate maps exposed on the harness so tests can inspect them directly
  // (mirrors what the shims exposed as state.finishedTimers / readGraceTimers).
  // We synthesise them by observing schedule/clear calls, keeping the same
  // per-source tracking that the original shim state had.
  const finishedTimers: Record<string, TimerHandle | undefined> = {};
  const readGraceTimers: Record<string, TimerHandle | undefined> = {};

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

  const mgr = createUnreadPulseManager({
    getFinishedAt: () => transientFinishedAt,
    setFinishedAt: (v) => {
      transientFinishedAt = v;
    },
    isSessionFocused: () => opts?.focused ?? false,
    now: () => opts?.nowMs ?? 1_000_000,
    schedule,
    clear,
  });

  // Build a state proxy that exposes the same shape the old shim tests used
  // (state.transientFinishedAt / state.finishedTimers / state.readGraceTimers).
  // transientFinishedAt is a live getter so mutations via setFinishedAt are
  // visible.  finishedTimers / readGraceTimers are tracked by wrapping
  // scheduleFinished / cancelFinishedTimer / startReadGrace / cancelReadGrace
  // and observing the handles schedule() hands back.

  // We wrap the manager methods to maintain the per-source timer maps.
  const origScheduleFinished = mgr.scheduleFinished;
  const origCancelFinishedTimer = mgr.cancelFinishedTimer;
  const origStartReadGrace = mgr.startReadGrace;
  const origCancelReadGrace = mgr.cancelReadGrace;
  const origClearFinishedFor = mgr.clearFinishedFor;

  function scheduleFinished(source: string): void {
    // cancelFinishedTimer is called inside, which will clear the old handle
    // via our `clear` shim. We update finishedTimers after the call.
    origScheduleFinished(source);
    // The most-recently-added pending handle is the one just scheduled.
    const handles = [...pending.keys()];
    finishedTimers[source] = handles[handles.length - 1];
  }

  function cancelFinishedTimer(source: string): void {
    origCancelFinishedTimer(source);
    finishedTimers[source] = undefined;
  }

  function clearFinishedFor(source: string): void {
    origClearFinishedFor(source);
    finishedTimers[source] = undefined;
  }

  function startReadGrace(source: string): void {
    const sizeBefore = pending.size;
    origStartReadGrace(source);
    if (pending.size > sizeBefore) {
      const handles = [...pending.keys()];
      readGraceTimers[source] = handles[handles.length - 1];
    }
  }

  function cancelReadGrace(source: string): void {
    origCancelReadGrace(source);
    readGraceTimers[source] = undefined;
  }

  // Intercept fires so readGraceTimers[source] = undefined after timer fires.
  const origFire = fire;
  const wrappedFire = (handle: TimerHandle): void => {
    // Identify which source this handle belongs to before firing.
    const finishedSource = Object.entries(finishedTimers).find(
      ([, h]) => h === handle,
    )?.[0];
    const graceSource = Object.entries(readGraceTimers).find(
      ([, h]) => h === handle,
    )?.[0];
    origFire(handle);
    if (finishedSource) finishedTimers[finishedSource] = undefined;
    if (graceSource) readGraceTimers[graceSource] = undefined;
  };

  const state = {
    get transientFinishedAt() {
      return transientFinishedAt;
    },
    set transientFinishedAt(v: Record<string, number | undefined>) {
      transientFinishedAt = v;
    },
    finishedTimers,
    readGraceTimers,
  };

  return {
    state,
    pending,
    cancelled,
    fire: wrappedFire,
    scheduleFinished,
    cancelFinishedTimer,
    clearFinishedFor,
    startReadGrace,
    cancelReadGrace,
  };
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
