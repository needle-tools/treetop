/**
 * Weekly-usage pace classification — the "On pace for ~X%" line under the
 * live usage bars in AgentUsageChip.
 *
 * The load-bearing case here is 100%: landing exactly on your weekly limit is
 * OPTIMAL (maximum utilization, zero overage), not a problem. Before this it
 * fell into one of two wrong buckets — a bland "~100% — 0% headroom" or, when
 * the projection rounded to 100% from just above 1.0, the alarming red
 * "On pace to exceed limit (~100%)". Both are wrong: perfect pace gets its
 * own celebratory "PERFECT" state, and crucially it must NOT report
 * `isOverPace` (that drives the red tint + the over-pace warning sound).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyWeeklyPace } from "../src/usage-pace";

const chip = readFileSync(
  join(import.meta.dir, "../src/AgentUsageChip.svelte"),
  "utf-8",
);

describe("classifyWeeklyPace", () => {
  test("healthy under-pace: headroom label, not over, not perfect", () => {
    const r = classifyWeeklyPace(0.6, false, 0);
    expect(r.label).toBe("On pace for ~60% — 40% headroom");
    expect(r.isOverPace).toBe(false);
    expect(r.isPerfect).toBe(false);
  });

  test("clearly over pace: exceed label, over, not perfect", () => {
    const r = classifyWeeklyPace(1.2, false, 0);
    expect(r.label).toBe("On pace to exceed limit (~120%)");
    expect(r.isOverPace).toBe(true);
    expect(r.isPerfect).toBe(false);
  });

  test("exactly 100%: PERFECT, and NOT flagged over-pace", () => {
    const r = classifyWeeklyPace(1.0, false, 0);
    expect(r.isPerfect).toBe(true);
    expect(r.isOverPace).toBe(false);
    expect(r.label).toContain("PERFECT");
  });

  test("rounds UP to 100% (was the red over-pace bug): PERFECT, not over", () => {
    const r = classifyWeeklyPace(1.004, false, 0);
    expect(r.isPerfect).toBe(true);
    expect(r.isOverPace).toBe(false);
    expect(r.label).toContain("PERFECT");
  });

  test("rounds DOWN to 100%: PERFECT", () => {
    const r = classifyWeeklyPace(0.997, false, 0);
    expect(r.isPerfect).toBe(true);
    expect(r.isOverPace).toBe(false);
  });

  test("just past the perfect band (rounds to 101%): over pace again", () => {
    const r = classifyWeeklyPace(1.006, false, 0);
    expect(r.isPerfect).toBe(false);
    expect(r.isOverPace).toBe(true);
    expect(r.label).toBe("On pace to exceed limit (~101%)");
  });

  test("early window never claims PERFECT, even at 100%", () => {
    const r = classifyWeeklyPace(1.0, true, 3);
    expect(r.isPerfect).toBe(false);
    expect(r.isOverPace).toBe(false);
    expect(r.label).toBe("Projection available in ~3h (need more data)");
  });
});

describe("AgentUsageChip wires the PERFECT state", () => {
  test("delegates classification to usage-pace and renders the perfect class", () => {
    expect(chip).toContain('from "./usage-pace"');
    expect(chip).toContain("classifyWeeklyPace(");
    // Both the Claude and Codex projection rows must opt into the state.
    const perfectBindings = chip.match(/class:perfect=\{[^}]+\.isPerfect\}/g);
    expect(perfectBindings?.length).toBe(2);
  });

  test("the perfect CSS celebrates (green-ish), never the over-pace red", () => {
    const rule = chip.match(
      /\.usage-projection\.perfect[\s\S]*?\n\s*\}\s*\n\s*\}/,
    )?.[0];
    expect(rule, ".usage-projection.perfect rule not found").toBeTruthy();
    // Must not reuse the over-pace warning orange/red.
    expect(rule).not.toContain("#f97316");
  });
});
