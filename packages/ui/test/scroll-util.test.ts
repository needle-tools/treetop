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
