import { test, expect, describe } from "bun:test";
import { restoreScrollAfterDelay, type ScrollRestoreEnv } from "../src/scroll-restore";
import { type CoalescerTimer } from "../src/terminal-resize";

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
    flush() {
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending: () => pending !== null,
    clears: () => clears,
  };
}

/** Fake user-scroll source the test can fire manually. */
function fakeUserScroll() {
  let cb: (() => void) | null = null;
  let unsubscribed = false;
  return {
    subscribe: (fn: () => void) => {
      cb = fn;
      return () => {
        unsubscribed = true;
        cb = null;
      };
    },
    fire: () => cb?.(),
    unsubscribed: () => unsubscribed,
  };
}

function makeEnv(): {
  env: ScrollRestoreEnv;
  ft: ReturnType<typeof fakeTimer>;
  us: ReturnType<typeof fakeUserScroll>;
  scrolledTo: () => number[];
} {
  const ft = fakeTimer();
  const us = fakeUserScroll();
  const scrolls: number[] = [];
  return {
    ft,
    us,
    scrolledTo: () => scrolls,
    env: {
      timer: ft.timer,
      scrollTo: (y) => scrolls.push(y),
      onUserScroll: us.subscribe,
    },
  };
}

describe("restoreScrollAfterDelay", () => {
  test("scrolls to the target once the delay elapses with no user scroll", () => {
    const { env, ft, us, scrolledTo } = makeEnv();
    restoreScrollAfterDelay(1200, 200, env);

    expect(scrolledTo()).toEqual([]); // nothing until the timer fires
    ft.flush();
    expect(scrolledTo()).toEqual([1200]);
    expect(us.unsubscribed()).toBe(true); // listener cleaned up after firing
  });

  test("a user scroll before the delay aborts the restore", () => {
    const { env, ft, us, scrolledTo } = makeEnv();
    restoreScrollAfterDelay(1200, 200, env);

    us.fire(); // user took over
    expect(ft.hasPending()).toBe(false); // pending restore was cleared
    expect(us.unsubscribed()).toBe(true);

    ft.flush(); // even if the timer somehow fires, nothing happens
    expect(scrolledTo()).toEqual([]);
  });

  test("cancel() drops a pending restore without scrolling", () => {
    const { env, ft, scrolledTo } = makeEnv();
    const cancel = restoreScrollAfterDelay(1200, 200, env);

    cancel();
    expect(ft.hasPending()).toBe(false);
    ft.flush();
    expect(scrolledTo()).toEqual([]);
  });

  test("a user scroll after the restore already fired is a no-op", () => {
    const { env, ft, us, scrolledTo } = makeEnv();
    restoreScrollAfterDelay(1200, 200, env);

    ft.flush();
    expect(scrolledTo()).toEqual([1200]);

    us.fire(); // late scroll — must not re-scroll or throw
    expect(scrolledTo()).toEqual([1200]);
  });

  test("cancel() after firing is a harmless no-op", () => {
    const { env, ft, scrolledTo } = makeEnv();
    const cancel = restoreScrollAfterDelay(1200, 200, env);

    ft.flush();
    expect(scrolledTo()).toEqual([1200]);
    expect(() => cancel()).not.toThrow();
    expect(scrolledTo()).toEqual([1200]);
  });
});
