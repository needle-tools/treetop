/**
 * Tests for the animation/layer debug overlay's pure CSS-override builder.
 *
 * The overlay (DebugPanel.svelte) lets us A/B which CSS-animation group owns
 * the renderer's Layerize cost (see plans/performance.md — the dock's ~75
 * composited layers rebuild every frame). It injects ONE static stylesheet
 * up front and toggles `html.dbg-<id>` classes to disable a group live, so we
 * don't rebuild between experiments. buildOverrideCss() generates that sheet;
 * it's the only non-glue logic, so it's the thing we pin.
 */
import { describe, expect, test } from "bun:test";
import {
  ANIM_GROUPS,
  buildOverrideCss,
  classForGroup,
  markerLabel,
} from "../src/anim-debug";

describe("anim-debug groups", () => {
  test("every group has a stable id, a label, and at least one selector", () => {
    for (const g of ANIM_GROUPS) {
      expect(g.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.selectors.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique", () => {
    const ids = ANIM_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("includes the prime suspects from the trace", () => {
    const ids = ANIM_GROUPS.map((g) => g.id);
    // The "all" master switch plus the dock animations that the layer-border
    // capture showed promoted-and-animated.
    expect(ids).toContain("all");
    expect(ids).toContain("dock-arrows");
    // The idle "zZZ" sleep trail — one infinite transform/opacity animation
    // per idle pill × 2 z-spans, a real layer-count contributor.
    expect(ids).toContain("sleep-z");
    // No "dirty-wave" group: that wiggle is a SMIL <animate>, not a CSS
    // animation, so `animation: none` can't disable it.
    expect(ids).not.toContain("dirty-wave");
  });

  test("classForGroup namespaces the toggle class", () => {
    expect(classForGroup("dock-arrows")).toBe("dbg-dock-arrows");
  });
});

describe("markerLabel (trace annotation)", () => {
  test("empty set reads as all-enabled", () => {
    expect(markerLabel(new Set())).toBe("dbg: all enabled");
  });

  test("lists disabled ids", () => {
    expect(markerLabel(new Set(["dock-arrows"]))).toBe(
      "dbg: disabled [dock-arrows]",
    );
  });

  test("is order-independent (sorted) so equal states share a label", () => {
    const a = markerLabel(new Set(["working-pill", "dock-arrows"]));
    const b = markerLabel(new Set(["dock-arrows", "working-pill"]));
    expect(a).toBe(b);
    expect(a).toBe("dbg: disabled [dock-arrows, working-pill]");
  });
});

describe("buildOverrideCss", () => {
  const css = buildOverrideCss(ANIM_GROUPS);

  test("emits one rule per group, gated on its html.dbg-<id> class", () => {
    for (const g of ANIM_GROUPS) {
      expect(css).toContain(`html.${classForGroup(g.id)}`);
    }
  });

  test("disables animation with !important so it beats component rules", () => {
    expect(css).toContain("animation: none !important");
  });

  test("the 'all' group sweeps every element and pseudo-element", () => {
    const allRule = css
      .split("}")
      .find((r) => r.includes(`html.${classForGroup("all")}`));
    expect(allRule).toBeDefined();
    expect(allRule).toContain("*");
    expect(allRule).toContain("::before");
    expect(allRule).toContain("::after");
  });

  test("each group's own selectors appear in its rule", () => {
    for (const g of ANIM_GROUPS) {
      if (g.id === "all") continue;
      const rule = css
        .split("}")
        .find((r) => r.includes(`html.${classForGroup(g.id)}`));
      expect(rule, `${g.id} rule`).toBeDefined();
      for (const sel of g.selectors) {
        expect(rule, `${g.id} -> ${sel}`).toContain(sel);
      }
    }
  });

  test("is deterministic", () => {
    expect(buildOverrideCss(ANIM_GROUPS)).toBe(css);
  });
});
