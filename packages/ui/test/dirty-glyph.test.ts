/**
 * Contract for the SessionDock dirty-changes wave (DirtyGlyph.svelte).
 *
 * History (see plans/performance.md): we briefly replaced the SMIL `d`-morph
 * with a composited `translateX` scroll, suspecting the per-frame geometry
 * repaint was a major renderer cost. The F8 debug-panel trace proved the real
 * cost was elsewhere — a layer tree bloated by an always-running invisible
 * dock spinner promoting every idle dot (Layerize 54% → 5% once gated). With
 * the tree small, the morph's marginal Paint is affordable, so we kept the
 * nicer "rock" and went back to SMIL.
 *
 * So these guards pin the SMIL technique (the earlier "no morph" guard was
 * specific to the bloated-tree era and no longer applies):
 *   - the wave is a SMIL <animate> on `d` (animates in BOTH WebKit + Chromium,
 *     unlike a CSS `d:` keyframe which freezes in WKWebView),
 *   - reduced-motion drops the <animate>,
 *   - the stroke stays theme-driven.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/DirtyGlyph.svelte"),
  "utf-8",
);
const FLAT = SOURCE.replace(/\s+/g, " ");
const TEMPLATE = SOURCE.slice(
  SOURCE.indexOf("</script>") + "</script>".length,
  SOURCE.indexOf("<style>"),
);

describe("DirtyGlyph wave", () => {
  test("morphs the path via a SMIL <animate attributeName='d'>", () => {
    expect(TEMPLATE).toContain("<animate");
    expect(TEMPLATE).toMatch(/attributeName\s*=\s*["']d["']/);
    expect(TEMPLATE).toMatch(/repeatCount\s*=\s*["']indefinite["']/);
  });

  test("does NOT use a CSS `d:` keyframe (frozen in WebKit/WKWebView)", () => {
    expect(FLAT).not.toMatch(/@keyframes[^}]*\bd\s*:/);
  });

  test("gates the animation on reduced-motion (omits <animate> in JS)", () => {
    // SMIL has no media-query gate, so the component conditionally renders the
    // <animate> only when motion is allowed.
    expect(FLAT).toMatch(/prefers-reduced-motion/);
    expect(FLAT).toMatch(/\{#if\s*!?\s*reduceMotion\s*\}\s*<animate/);
  });

  test("stays themeable — stroke follows the dock arrow colour", () => {
    expect(SOURCE).toMatch(/stroke:\s*var\(--arrow-color/);
  });
});
