/**
 * Perf-regression guard: the dock spinner must only animate while a dot is
 * actually active.
 *
 * An always-running CSS animation auto-promotes its element to a compositor
 * layer (see plans/performance.md + web.dev animations guide). The spinner
 * lives inside EVERY dock dot, so leaving `dock-spin` running unconditionally
 * (even at opacity:0 on idle dots) promoted every idle session circle to its
 * own layer — pure layer-count waste in the Layerize walk. The fix gates the
 * animation on explicit state classes. If a refactor moves it back onto the
 * bare `.dock-dot-spinner`, this fails loudly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/SessionDock.svelte"),
  "utf-8",
);
const FLAT = SOURCE.replace(/\s+/g, " ");

describe("dock spinner is gated to active dots", () => {
  test("dock-spin only animates under active-state selectors", () => {
    expect(FLAT).toMatch(
      /\.dock-dot\.dot-working\s+\.dock-dot-spinner,\s*\.dock-dot\.dot-terminal-active\s+\.dock-dot-spinner\s*\{[^}]*animation:\s*dock-spin/,
    );
  });

  test("the bare .dock-dot-spinner rule does NOT run the spin animation", () => {
    // Find the standalone `.dock-dot-spinner { ... }` rule (the layout one,
    // identified by `position: absolute`) and assert it carries no animation,
    // so idle dots don't auto-promote.
    const m = FLAT.match(/\.dock-dot-spinner\s*\{([^}]*position:\s*absolute[^}]*)\}/);
    expect(m, "standalone .dock-dot-spinner rule").not.toBeNull();
    expect(m![1]).not.toContain("animation:");
  });

});
