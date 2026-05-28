import { test, expect, describe } from "bun:test";
import { claudeSessionMenuItems, effortIcon } from "../src/claude-session-menu";
import type { SessionMenuItem } from "../src/SessionMenu.svelte";

function noop() {}

/** Labels of the children flagged as the currently-active option (the
 *  trailing-check marker). */
function selectedLabels(item: SessionMenuItem | undefined): string[] {
  if (item?.kind !== "submenu") throw new Error("expected submenu");
  return item.children
    .filter((c) => c.kind === "action" && c.selected)
    .map((c) => c.label);
}

describe("claudeSessionMenuItems", () => {
  test("produces a Claude: Model and Claude: Effort submenu, both filled SVG", () => {
    const items = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(items.map((i) => i.label)).toEqual(["Claude: Model", "Claude: Effort"]);
    expect(items.every((i) => i.kind === "submenu")).toBe(true);
    // Headers carry a filled SVG glyph (not emoji).
    for (const header of items) {
      expect(header.iconSvg && header.iconSvg.length > 0).toBe(true);
      expect(header.iconFilled).toBe(true);
    }
  });

  test("Model submenu offers opus / sonnet / haiku", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    if (model?.kind !== "submenu") throw new Error("expected submenu");
    expect(model.children.map((c) => c.label)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("Effort submenu lists levels high→low (max at top, low at bottom)", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    if (effort?.kind !== "submenu") throw new Error("expected submenu");
    expect(effort.children.map((c) => c.label)).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  test("effort levels are colour-coded filled gauge glyphs that grow per level", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    if (effort?.kind !== "submenu") throw new Error("expected submenu");
    // Distinct colours, all set.
    const colors = effort.children.map((c) =>
      c.kind === "action" ? c.iconColor : undefined,
    );
    expect(colors.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
    expect(new Set(colors).size).toBe(colors.length);
    // Each level is a single filled gauge-arc path…
    expect(effort.children.every((c) => c.iconSvg?.length === 1)).toBe(true);
    expect(effort.children.every((c) => c.iconFilled === true)).toBe(true);
    // …over a shared dim full-sweep track (same for every level)…
    const tracks = effort.children.map((c) => c.iconTrackPaths?.[0]);
    expect(tracks.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(tracks).size).toBe(1);
    // …and the fill arc geometry differs per level (a growing sweep), so no
    // two levels render the same coloured glyph.
    const arcs = effort.children.map((c) => c.iconSvg?.[0]);
    expect(new Set(arcs).size).toBe(arcs.length);
  });

  test("uses SVG icons throughout — never emoji/unicode glyphs", () => {
    const items = claudeSessionMenuItems({
      currentModel: "opus",
      detectedModel: undefined,
      currentEffort: "high",
      onPickModel: noop,
      onPickEffort: noop,
    });
    const all: SessionMenuItem[] = [
      ...items,
      ...items.flatMap((i) => (i.kind === "submenu" ? i.children : [])),
    ];
    for (const it of all) {
      expect((it as { icon?: string }).icon).toBeUndefined();
    }
  });

  test("checkmarks the model currently enabled (persisted override wins)", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: "sonnet",
      detectedModel: "claude-opus-4-8",
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(model)).toEqual(["sonnet"]);
  });

  test("checkmarks the detected model's tier when no override is set", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: "claude-haiku-4-5-20251001",
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(model)).toEqual(["haiku"]);
  });

  test("checkmarks nothing when neither override nor detected model is known", () => {
    const [model] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(model)).toEqual([]);
  });

  test("checkmarks only the effort override", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: "claude-opus-4-8",
      currentEffort: "max",
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(effort)).toEqual(["max"]);
  });

  test("checkmarks no effort when none is set (no detection channel)", () => {
    const [, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: "claude-opus-4-8",
      currentEffort: undefined,
      onPickModel: noop,
      onPickEffort: noop,
    });
    expect(selectedLabels(effort)).toEqual([]);
  });

  test("effortIcon returns a colour-coded gauge arc, or undefined when unset", () => {
    expect(effortIcon(undefined)).toBeUndefined();
    expect(effortIcon("")).toBeUndefined();
    expect(effortIcon("bogus")).toBeUndefined();
    const low = effortIcon("low");
    const max = effortIcon("max");
    // One filled arc path per level; the sweep (path geometry) and colour
    // both differ between low and max.
    expect(low?.paths.length).toBe(1);
    expect(max?.paths.length).toBe(1);
    expect(low?.paths[0]).not.toBe(max?.paths[0]);
    expect(typeof low?.color).toBe("string");
    expect(low?.color).not.toBe(max?.color);
    // Both carry the same full-sweep dim track behind the coloured fill.
    expect(low?.trackPaths.length).toBe(1);
    expect(low?.trackPaths[0]).toBe(max?.trackPaths[0]);
    // max's fill arc is the full sweep, so it equals the track geometry.
    expect(max?.paths[0]).toBe(max?.trackPaths[0]);
  });

  test("picking an item invokes the matching callback", () => {
    let pickedModel: string | undefined;
    let pickedEffort: string | undefined;
    const [model, effort] = claudeSessionMenuItems({
      currentModel: undefined,
      detectedModel: undefined,
      currentEffort: undefined,
      onPickModel: (m) => (pickedModel = m),
      onPickEffort: (e) => (pickedEffort = e),
    });
    if (model?.kind !== "submenu" || effort?.kind !== "submenu") {
      throw new Error("expected submenus");
    }
    const opus = model.children.find((c) => c.label === "opus");
    const high = effort.children.find((c) => c.label === "high");
    if (opus?.kind !== "action" || high?.kind !== "action") {
      throw new Error("expected action children");
    }
    const rect = {} as DOMRect;
    opus.onSelect(rect);
    high.onSelect(rect);
    expect(pickedModel).toBe("opus");
    expect(pickedEffort).toBe("high");
  });
});
