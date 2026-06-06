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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COL_OFFSCREEN_CLASS, shouldPauseColumn } from "../src/col-visibility";

const here = import.meta.dir;
const baseCss = readFileSync(join(here, "../src/styles/base.css"), "utf-8");
const appSvelte = readFileSync(join(here, "../src/App.svelte"), "utf-8");

describe("shouldPauseColumn", () => {
  test("pauses when the column is not intersecting the viewport", () => {
    expect(shouldPauseColumn(false)).toBe(true);
  });
  test("runs when the column is on screen", () => {
    expect(shouldPauseColumn(true)).toBe(false);
  });
});

describe("col-offscreen wiring", () => {
  test("base.css de-promotes off-screen columns with `animation: none`", () => {
    const flat = baseCss.replace(/\s+/g, " ");
    // The rule must target the class + descendants and use `none`, not paused.
    expect(flat).toMatch(
      new RegExp(`\\.${COL_OFFSCREEN_CLASS}[^{]*\\{[^}]*animation:\\s*none`),
    );
    // Guard against a regression to play-state inside this rule.
    const rule = flat
      .split("}")
      .find((r) => r.includes(`.${COL_OFFSCREEN_CLASS}`) && r.includes("animation:"));
    expect(rule).toBeDefined();
    expect(rule).not.toContain("animation-play-state");
  });

  test("App.svelte attaches the colVisibility action to session columns", () => {
    expect(appSvelte).toContain("use:colVisibility");
    expect(appSvelte).toMatch(/import\s*\{[^}]*colVisibility[^}]*\}\s*from\s*["']\.\/col-visibility["']/);
  });
});
