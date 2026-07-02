/**
 * Tests for the small custom scroll animator behind dock-pick scrolls.
 * Native `behavior: "smooth"` has a browser-fixed duration that feels
 * sluggish for the dock; `animateValue` lets us drive a short, tunable
 * scroll. The clock + scheduler are injectable so the rAF loop is
 * fully deterministic under test.
 */

import { test, expect, describe } from "bun:test";
import {
  easeOutCubic,
  centerScrollTarget,
  animateValue,
  captureScrollSnapshot,
  restoreScrollSnapshot,
  stickScrollerToBottom,
} from "../src/scroll-util";

/** Drives animateValue's injected rAF by advancing a fake clock a fixed
 *  step per frame, flushing until the animation stops scheduling. */
function runAnimation(opts: {
  from: number;
  to: number;
  duration: number;
  stepMs: number;
}): number[] {
  const frames: number[] = [];
  let clock = 1000; // arbitrary non-zero start
  let pending: ((t: number) => void) | null = null;
  animateValue({
    from: opts.from,
    to: opts.to,
    duration: opts.duration,
    apply: (v) => frames.push(v),
    now: () => clock,
    raf: (cb) => {
      pending = cb;
    },
  });
  // Flush scheduled frames, advancing the clock each tick.
  let guard = 0;
  while (pending && guard++ < 1000) {
    const cb = pending;
    pending = null;
    clock += opts.stepMs;
    cb(clock);
  }
  return frames;
}

describe("easeOutCubic", () => {
  test("pins the endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  test("decelerates (output runs ahead of linear)", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("animateValue", () => {
  test("zero duration applies the target immediately, once", () => {
    const seen: number[] = [];
    animateValue({
      from: 0,
      to: 500,
      duration: 0,
      apply: (v) => seen.push(v),
      now: () => 0,
      raf: () => {
        throw new Error("should not schedule a frame");
      },
    });
    expect(seen).toEqual([500]);
  });

  test("no-op span (from === to) applies once without scheduling", () => {
    const seen: number[] = [];
    animateValue({
      from: 42,
      to: 42,
      duration: 200,
      apply: (v) => seen.push(v),
      now: () => 0,
      raf: () => {
        throw new Error("should not schedule a frame");
      },
    });
    expect(seen).toEqual([42]);
  });

  test("lands exactly on the target at the final frame", () => {
    const frames = runAnimation({
      from: 0,
      to: 1000,
      duration: 200,
      stepMs: 16,
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[frames.length - 1]).toBe(1000);
  });

  test("is monotonic for an increasing span and stays within bounds", () => {
    const frames = runAnimation({
      from: 100,
      to: 900,
      duration: 200,
      stepMs: 16,
    });
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1]);
      expect(frames[i]).toBeLessThanOrEqual(900);
      expect(frames[i]).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("scroll snapshots", () => {
  test("restores nested scroll positions after a disclosure changes layout", () => {
    const outer = {
      scrollTop: 420,
      scrollLeft: 12,
      get isConnected() {
        return true;
      },
    } as unknown as HTMLElement;
    const inner = {
      scrollTop: 95,
      scrollLeft: 7,
      get isConnected() {
        return true;
      },
    } as unknown as HTMLElement;

    const snapshot = captureScrollSnapshot([outer, inner, outer]);
    outer.scrollTop = 900;
    outer.scrollLeft = 44;
    inner.scrollTop = 180;
    inner.scrollLeft = 22;

    restoreScrollSnapshot(snapshot);

    expect(outer.scrollTop).toBe(420);
    expect(outer.scrollLeft).toBe(12);
    expect(inner.scrollTop).toBe(95);
    expect(inner.scrollLeft).toBe(7);
  });

  test("does not resurrect disconnected scroll containers", () => {
    let connected = true;
    const gone = {
      scrollTop: 10,
      scrollLeft: 3,
      get isConnected() {
        return connected;
      },
    } as unknown as HTMLElement;
    const snapshot = captureScrollSnapshot([gone]);
    connected = false;
    gone.scrollTop = 500;

    restoreScrollSnapshot(snapshot);

    expect(gone.scrollTop).toBe(500);
  });
});

describe("centerScrollTarget", () => {
  test("centers the anchor in the viewport", () => {
    // anchor 100px tall, top at 400 in a 1000px viewport, scrolled 0.
    // To center: target = 0 + 400 - (1000 - 100)/2 = 400 - 450 = -50,
    // clamped to 0.
    expect(centerScrollTarget(400, 100, 1000, 0, 5000)).toBe(0);
  });

  test("accounts for current scroll offset", () => {
    // Same anchor but already scrolled 300px down.
    // target = 300 + 400 - 450 = 250.
    expect(centerScrollTarget(400, 100, 1000, 300, 5000)).toBe(250);
  });

  test("clamps to the max scrollable distance", () => {
    expect(centerScrollTarget(900, 100, 1000, 4900, 5000)).toBe(5000);
  });
});

describe("stickScrollerToBottom", () => {
  function makeTailStickEnv() {
    const rafs = new Map<number, () => void>();
    let nextRaf = 1;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const listeners = new Map<string, Set<() => void>>();
    const children: Element[] = [];
    const scroller = {
      scrollTop: 0,
      children,
      addEventListener: (type: string, cb: () => void) => {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(cb);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners.get(type)?.delete(cb);
      },
    } as unknown as HTMLElement;

    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      constructor(public cb: () => void) {
        FakeResizeObserver.instances.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      disconnect() {
        this.observed = [];
      }
    }

    class FakeMutationObserver {
      static instances: FakeMutationObserver[] = [];
      constructor(public cb: () => void) {
        FakeMutationObserver.instances.push(this);
      }
      observe() {}
      disconnect() {}
    }

    return {
      scroller,
      children,
      listeners,
      resizeObservers: FakeResizeObserver.instances,
      mutationObservers: FakeMutationObserver.instances,
      opts: {
        durationMs: 1000,
        raf: (cb: () => void) => {
          const id = nextRaf++;
          rafs.set(id, cb);
          return id;
        },
        cancelRaf: (id: number) => {
          rafs.delete(id);
        },
        setTimeout: (cb: () => void) => {
          const id = nextTimer++;
          timers.set(id, cb);
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: (id: ReturnType<typeof setTimeout>) => {
          timers.delete(id as unknown as number);
        },
        ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
        MutationObserver:
          FakeMutationObserver as unknown as typeof MutationObserver,
      },
      flushRaf: () => {
        const callbacks = Array.from(rafs.values());
        rafs.clear();
        for (const cb of callbacks) cb();
      },
      fireMutation: () => {
        for (const mo of FakeMutationObserver.instances) mo.cb();
      },
      fireWheel: () => {
        for (const cb of listeners.get("wheel") ?? []) cb();
      },
    };
  }

  test("keeps a revealed transcript pinned when delayed children appear", () => {
    const env = makeTailStickEnv();

    stickScrollerToBottom(env.scroller, env.opts);
    env.flushRaf();
    expect(env.scroller.scrollTop).toBe(1_000_000_000);

    env.scroller.scrollTop = 0;
    env.children.push({} as Element);
    env.fireMutation();
    env.flushRaf();

    expect(env.scroller.scrollTop).toBe(1_000_000_000);
    expect(env.resizeObservers[0]?.observed).toContain(env.children[0]);
  });

  test("stops following once the user takes over scrolling", () => {
    const env = makeTailStickEnv();

    stickScrollerToBottom(env.scroller, env.opts);
    env.flushRaf();
    env.scroller.scrollTop = 0;

    env.fireWheel();
    env.children.push({} as Element);
    env.fireMutation();
    env.flushRaf();

    expect(env.scroller.scrollTop).toBe(0);
  });
});
