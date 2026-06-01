import { test, expect, describe } from "bun:test";
import {
  createResizeCoalescer,
  type CoalescerTimer,
} from "../src/terminal-resize";

/** Deterministic fake timer: only ever holds the most recent pending cb. */
function fakeTimer() {
  let pending: (() => void) | null = null;
  let nextId = 1;
  let clears = 0;
  const timer: CoalescerTimer = {
    set(cb) {
      pending = cb;
      return nextId++;
    },
    clear() {
      clears++;
      pending = null;
    },
  };
  return {
    timer,
    /** Fire the pending callback, as the real timer eventually would. */
    flush() {
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending: () => pending !== null,
    clears: () => clears,
  };
}

describe("createResizeCoalescer", () => {
  test("a burst of triggers fires run() exactly once", () => {
    const ft = fakeTimer();
    let runs = 0;
    const c = createResizeCoalescer(() => runs++, 100, ft.timer);

    c.trigger();
    c.trigger();
    c.trigger();
    expect(runs).toBe(0); // nothing fires until the timer elapses

    ft.flush();
    expect(runs).toBe(1);
  });

  test("each trigger reschedules (clears) the previous pending call", () => {
    const ft = fakeTimer();
    const c = createResizeCoalescer(() => {}, 100, ft.timer);

    c.trigger(); // schedules #1
    c.trigger(); // clears #1, schedules #2
    c.trigger(); // clears #2, schedules #3
    expect(ft.clears()).toBe(2);
  });

  test("a fresh trigger after firing schedules a new call", () => {
    const ft = fakeTimer();
    let runs = 0;
    const c = createResizeCoalescer(() => runs++, 100, ft.timer);

    c.trigger();
    ft.flush();
    expect(runs).toBe(1);

    c.trigger();
    ft.flush();
    expect(runs).toBe(2);
  });

  test("cancel() drops a pending call without firing it", () => {
    const ft = fakeTimer();
    let runs = 0;
    const c = createResizeCoalescer(() => runs++, 100, ft.timer);

    c.trigger();
    c.cancel();
    expect(ft.hasPending()).toBe(false);
    ft.flush(); // nothing to fire
    expect(runs).toBe(0);
  });

  test("cancel() with nothing pending is a no-op", () => {
    const ft = fakeTimer();
    const c = createResizeCoalescer(() => {}, 100, ft.timer);
    expect(() => c.cancel()).not.toThrow();
    expect(ft.clears()).toBe(0);
  });
});
