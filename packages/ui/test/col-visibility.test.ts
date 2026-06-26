/**
 * Off-screen session columns must DE-PROMOTE their always-on animations.
 *
 * A working agent's pill (and the idle "zZZ" sleep trail) animate forever
 * while the column exists — even scrolled off-screen. An always-running
 * animation keeps its element on a compositor layer, and `Layerize` walks the
 * WHOLE layer tree (on- and off-screen) every frame. With a wall of working
 * agents, the off-screen pills dominate renderer CPU even though you can't see
 * them — they contribute 0 paint but bloat the tree (see plans/performance.md,
 * round 3). Gating them on scroll-visibility shrinks the tree.
 *
 * Crucially this uses `animation: none` (de-promote), NOT
 * `animation-play-state: paused` like the tab-hidden / ui-idle / row-offscreen
 * gates — `paused` stops the per-frame work but keeps the layer, so the
 * Layerize walk wouldn't shrink. Pinned here so a "consistency" refactor to
 * `paused` doesn't silently undo the win.
 */
import { describe, expect, test } from "bun:test";
import {
  markOffscreenUntilMeasured,
  rectNearViewport,
  shouldPauseColumn,
  syncOffscreenClass,
} from "../src/col-visibility";

describe("shouldPauseColumn", () => {
  test("pauses when the column is not intersecting the viewport", () => {
    expect(shouldPauseColumn(false)).toBe(true);
  });
  test("runs when the column is on screen", () => {
    expect(shouldPauseColumn(true)).toBe(false);
  });
});

describe("rectNearViewport", () => {
  const viewport = { width: 1_000, height: 800 };

  test("uses the same generous margin as the column observer", () => {
    expect(
      rectNearViewport(
        { top: 1_050, bottom: 1_100, left: 0, right: 200 },
        viewport,
      ),
    ).toBe(true);
    expect(
      rectNearViewport(
        { top: 1_101, bottom: 1_151, left: 0, right: 200 },
        viewport,
      ),
    ).toBe(false);
  });

  test("rejects columns outside the horizontal margin too", () => {
    expect(
      rectNearViewport(
        { top: 0, bottom: 200, left: -299, right: -1 },
        viewport,
      ),
    ).toBe(true);
    expect(
      rectNearViewport(
        { top: 0, bottom: 200, left: -650, right: -350 },
        viewport,
      ),
    ).toBe(false);
  });
});

describe("offscreen class helpers", () => {
  function target() {
    const classes = new Set<string>();
    return {
      classes,
      node: {
        classList: {
          add(name: string) {
            classes.add(name);
          },
          toggle(name: string, force?: boolean) {
            const shouldHave = force ?? !classes.has(name);
            if (shouldHave) classes.add(name);
            else classes.delete(name);
            return shouldHave;
          },
        },
      },
    };
  }

  test("marks a node offscreen until IntersectionObserver reports reality", () => {
    const t = target();

    markOffscreenUntilMeasured(t.node, "row-offscreen");

    expect(t.classes.has("row-offscreen")).toBe(true);
  });

  test("syncs the class from observer intersection state", () => {
    const t = target();
    markOffscreenUntilMeasured(t.node, "col-offscreen");

    syncOffscreenClass(t.node, "col-offscreen", true);
    expect(t.classes.has("col-offscreen")).toBe(false);

    syncOffscreenClass(t.node, "col-offscreen", false);
    expect(t.classes.has("col-offscreen")).toBe(true);
  });
});
