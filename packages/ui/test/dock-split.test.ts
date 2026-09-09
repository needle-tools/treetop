import { describe, expect, test } from "bun:test";
import {
  dockArrowAnimationDelayMs,
  dockToggleOffset,
  reposWithLiveSessions,
  shouldMeasureDockBackdrop,
  splitDockEntries,
  type SplittableDockEntry,
} from "../src/dock-split";

function entry(
  repoId: string,
  source: string,
  exited = false,
): SplittableDockEntry {
  return { repoId, source, exited };
}

describe("splitDockEntries", () => {
  test("empty list → empty top and bottom", () => {
    expect(splitDockEntries([], true)).toEqual({ top: [], bottom: [] });
  });

  test("single entry → goes to top", () => {
    const e = entry("r1", "s1");
    expect(splitDockEntries([e], true)).toEqual({ top: [e], bottom: [] });
  });

  test("active entries stay above the toggle in lane order", () => {
    const a = entry("r1", "s1");
    const b = entry("r2", "s2");
    const c = entry("r3", "s3", true);
    const result = splitDockEntries([a, b], true);
    expect(result.top).toEqual([a, b]);
    expect(result.bottom).toEqual([]);
    expect(splitDockEntries([a, c, b], true).top).toEqual([a, b]);
  });

  test("two entries, same repo → not split (all top)", () => {
    const a = entry("r1", "s1");
    const b = entry("r1", "s2");
    const result = splitDockEntries([a, b], true);
    expect(result.top).toEqual([a, b]);
    expect(result.bottom).toEqual([]);
  });

  test("inactive entries stay below the toggle in lane order", () => {
    const a1 = entry("r1", "a1");
    const a2 = entry("r1", "a2", true);
    const b1 = entry("r2", "b1", true);
    const b2 = entry("r2", "b2");
    const result = splitDockEntries([a1, a2, b1, b2], true);
    expect(result.top).toEqual([a1, b2]);
    expect(result.bottom).toEqual([a2, b1]);
  });

  test("active-only mode filters out inactive entries without reordering", () => {
    const a = entry("r1", "a");
    const b = entry("r2", "b", true);
    const c = entry("r3", "c");
    const result = splitDockEntries([a, b, c], false);
    expect(result.top).toEqual([a, c]);
    expect(result.bottom).toEqual([]);
  });

  test("showInactive=false hides exited entries", () => {
    const a = entry("r1", "a", false);
    const b = entry("r1", "b", true); // exited
    const c = entry("r2", "c", false);
    const result = splitDockEntries([a, b, c], false);
    expect(result.top).toEqual([a, c]);
    expect(result.bottom).toEqual([]);
  });

  test("showInactive=true keeps exited entries below active ones", () => {
    const a = entry("r1", "a", false);
    const b = entry("r1", "b", true);
    const c = entry("r2", "c", false);
    const result = splitDockEntries([a, b, c], true);
    expect(result.top).toEqual([a, c]);
    expect(result.bottom).toEqual([b]);
  });

  test("inactive bucket preserves lane order across projects", () => {
    const fastvid = entry("fastvid", "fastvid-stopped", true);
    const supergit = entry("supergit", "supergit-active", false);
    const marketing = entry("marketing", "marketing-stopped", true);
    const needle = entry("needle", "needle-stopped", true);

    const result = splitDockEntries(
      [fastvid, supergit, marketing, needle],
      true,
    );

    expect(result.top.map((e) => e.repoId)).toEqual(["supergit"]);
    expect(result.bottom.map((e) => e.repoId)).toEqual([
      "fastvid",
      "marketing",
      "needle",
    ]);
  });

  test("all entries from one repo → no split possible", () => {
    const entries = [entry("r1", "s1"), entry("r1", "s2"), entry("r1", "s3")];
    const result = splitDockEntries(entries, true);
    expect(result.top).toEqual(entries);
    expect(result.bottom).toEqual([]);
  });

  test("all exited with showInactive=false → empty", () => {
    const entries = [entry("r1", "s1", true), entry("r2", "s2", true)];
    const result = splitDockEntries(entries, false);
    expect(result.top).toEqual([]);
    expect(result.bottom).toEqual([]);
  });

  // The dock template keys `{#each split.top/bottom as e (e.source)}`, so a
  // duplicate `source` value crashes Svelte with `each_key_duplicate`.
  // Upstream can leak dupes (same real session source listed under two
  // worktrees in openSessionsByWt before isForeignToWorktree converges,
  // pickerSessionsByWt merging an agent and a same-source shell, etc.) —
  // splitter is the last spot between data and render, so it dedupes
  // defensively, keeping the first occurrence to preserve manual order.
  test("dedupes entries with duplicate sources, keeping the first", () => {
    const a = entry("r1", "dup");
    const b = entry("r1", "unique");
    const c = entry("r2", "dup"); // collides with a
    const result = splitDockEntries([a, b, c], true);
    const allSources = [...result.top, ...result.bottom].map((e) => e.source);
    expect(allSources).toEqual(["dup", "unique"]);
    expect(allSources).toEqual([...new Set(allSources)]);
  });

  test("dedupe applies before exited filtering and split", () => {
    const a = entry("r1", "s1", false);
    const b = entry("r2", "s1", true); // dup source, exited
    const c = entry("r2", "s2", false);
    // Without dedupe, even showInactive=false would still let the second
    // `s1` slip through to splitting if it weren't exited — pin both
    // orders.
    const r1 = splitDockEntries([a, b, c], true);
    expect([...r1.top, ...r1.bottom].map((e) => e.source)).toEqual([
      "s1",
      "s2",
    ]);
    const r2 = splitDockEntries([a, b, c], false);
    expect([...r2.top, ...r2.bottom].map((e) => e.source)).toEqual([
      "s1",
      "s2",
    ]);
  });
});

describe("reposWithLiveSessions", () => {
  test("empty list → no repos", () => {
    expect(reposWithLiveSessions([]).size).toBe(0);
  });

  test("a live session marks its repo", () => {
    const ids = reposWithLiveSessions([entry("r1", "s1")]);
    expect(ids.has("r1")).toBe(true);
  });

  test("exited-only sessions do not mark their repo", () => {
    const ids = reposWithLiveSessions([
      entry("r1", "s1", true),
      entry("r1", "s2", true),
    ]);
    expect(ids.has("r1")).toBe(false);
  });

  test("one live session among exited ones still marks the repo", () => {
    const ids = reposWithLiveSessions([
      entry("r1", "s1", true),
      entry("r1", "s2"),
    ]);
    expect(ids.has("r1")).toBe(true);
  });

  test("only repos with live sessions are reported", () => {
    const ids = reposWithLiveSessions([
      entry("r1", "s1"),
      entry("r2", "s2", true),
      entry("r3", "s3"),
    ]);
    expect([...ids].sort()).toEqual(["r1", "r3"]);
  });
});

describe("dock repo status animation", () => {
  test("keeps the existing ten-second arrow cadence without a ten-second active timeline", () => {
    expect(dockArrowAnimationDelayMs(true)).toBe(800);
    expect(dockArrowAnimationDelayMs(false)).toBe(9_200);
    expect(
      dockArrowAnimationDelayMs(true) + dockArrowAnimationDelayMs(false),
    ).toBe(10_000);
  });
});

describe("dockToggleOffset", () => {
  const VH = 1000;

  test("toggle already at the column's midpoint → no nudge", () => {
    expect(
      dockToggleOffset({
        viewportHeight: VH,
        dockHeight: 200,
        toggleCenter: 100,
      }),
    ).toBe(0);
  });

  test("toggle dangling at the bottom → nudge the dock up", () => {
    // Inactive dots hidden ⇒ empty bottom stack ⇒ the toggle is the
    // last row of a 200-tall column, 10px from its bottom edge.
    expect(
      dockToggleOffset({
        viewportHeight: VH,
        dockHeight: 200,
        toggleCenter: 190,
      }),
    ).toBe(-90);
  });

  test("toggle near the top → nudge the dock down", () => {
    expect(
      dockToggleOffset({
        viewportHeight: VH,
        dockHeight: 200,
        toggleCenter: 30,
      }),
    ).toBe(70);
  });

  test("result is absolute — the shift already applied doesn't feed back", () => {
    // Same geometry measured twice (the measurement is dock-relative,
    // so a mid-glide re-measure returns the same target).
    const once = dockToggleOffset({
      viewportHeight: VH,
      dockHeight: 200,
      toggleCenter: 190,
    });
    const twice = dockToggleOffset({
      viewportHeight: VH,
      dockHeight: 200,
      toggleCenter: 190,
    });
    expect(twice).toBe(once);
  });

  test("never nudges the column off screen", () => {
    // 900-tall column leaves only 50px of slack on either side.
    expect(
      dockToggleOffset({
        viewportHeight: VH,
        dockHeight: 900,
        toggleCenter: 860,
      }),
    ).toBe(-50);
    expect(
      dockToggleOffset({
        viewportHeight: VH,
        dockHeight: 900,
        toggleCenter: 40,
      }),
    ).toBe(50);
  });

  test("a tall column with the toggle last stays clamped, not centred", () => {
    // The accepted trade-off: centring a last-row toggle needs the
    // whole column to fit in the top half of the screen. A 700-tall
    // column can't, so it moves as far as the clamp allows and the
    // toggle stays below centre rather than clipping the top dots.
    const dockHeight = 700;
    const toggleCenter = 690;
    const shift = dockToggleOffset({
      viewportHeight: VH,
      dockHeight,
      toggleCenter,
    });
    expect(shift).toBe(-150); // clamped, not the -340 that would centre it
    // Dock top after the shift is exactly the viewport top — no clipping.
    const dockTop = VH / 2 - dockHeight / 2 + shift;
    expect(dockTop).toBe(0);
    // …and the toggle genuinely still sits below centre.
    expect(dockTop + toggleCenter).toBeGreaterThan(VH / 2);
  });

  test("column taller than the viewport → no nudge, scroll owns layout", () => {
    expect(
      dockToggleOffset({
        viewportHeight: VH,
        dockHeight: 1200,
        toggleCenter: 1100,
      }),
    ).toBe(0);
  });
});

describe("shouldMeasureDockBackdrop", () => {
  test("does not measure while labels are hidden", () => {
    expect(shouldMeasureDockBackdrop(false, 50)).toBe(false);
  });

  test("measures only when visible and non-empty", () => {
    expect(shouldMeasureDockBackdrop(true, 0)).toBe(false);
    expect(shouldMeasureDockBackdrop(true, 1)).toBe(true);
  });
});
