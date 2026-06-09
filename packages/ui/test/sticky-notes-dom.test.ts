/**
 * Sticky-notes reposition hot path (plans/performance.md "Open TODOs —
 * Layerize" → the 1806ms querySelector).
 *
 * StickyNotesLayer repositions notes on a MutationObserver that watches
 * ALL of <main> with subtree:true. xterm's DOM renderer mutates row
 * <span>/#text nodes on every keystroke and every output chunk, so any
 * visible streaming TUI scheduled a reposition tick per frame — and each
 * tick ran a document-wide `querySelector` per note (twice: screenPosFor
 * + applyRowMargins) plus interleaved rect reads. The 2026-06-09 typing
 * trace billed 1806ms to querySelector + 200ms to getBoundingClientRect
 * for work that never moved a single note: `.xterm-host` is
 * `contain: layout`, so terminal-internal mutations CANNOT change row
 * geometry.
 *
 * Fix, pinned here:
 *   - `mutationsAllInsideTerminal` filters those records before they
 *     schedule a tick;
 *   - `buildAnchorRowMap` + `anchorRowFor` replace the per-note
 *     document-wide queries with ONE scoped querySelectorAll per pass.
 * Pure helpers are unit-tested with fakes (bun test has no DOM); the
 * component wiring is pinned by source-level guards, same approach as
 * terminal-view-mount.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VISIBLE_ROW_SELECTOR,
  anchorRowFor,
  buildAnchorRowMap,
  mutationsAllInsideTerminal,
} from "../src/sticky-notes-dom";

interface FakeRow {
  dataset: { wtRow?: string };
}

function fakeRoot(rows: FakeRow[], onQuery?: (sel: string) => void) {
  return {
    querySelectorAll(sel: string): FakeRow[] {
      onQuery?.(sel);
      return rows;
    },
  };
}

describe("buildAnchorRowMap", () => {
  test("maps rows by their worktree path using the visible-row selector", () => {
    const a = { dataset: { wtRow: "/repo/wt-a" } };
    const b = { dataset: { wtRow: "/repo/wt-b" } };
    let queried = "";
    const map = buildAnchorRowMap(fakeRoot([a, b], (sel) => (queried = sel)));
    expect(queried).toBe(VISIBLE_ROW_SELECTOR);
    expect(map.get("/repo/wt-a")).toBe(a);
    expect(map.get("/repo/wt-b")).toBe(b);
  });

  test("first row in document order wins on duplicate paths; rows without a path are skipped", () => {
    const first = { dataset: { wtRow: "/dup" } };
    const second = { dataset: { wtRow: "/dup" } };
    const map = buildAnchorRowMap(fakeRoot([{ dataset: {} }, first, second]));
    expect(map.size).toBe(1);
    expect(map.get("/dup")).toBe(first);
  });
});

describe("anchorRowFor", () => {
  const rows = new Map<string, FakeRow>([
    ["/wt-a", { dataset: { wtRow: "/wt-a" } }],
    ["/wt-b", { dataset: { wtRow: "/wt-b" } }],
  ]);

  test("resolves the first worktree anchor that has a visible row", () => {
    expect(
      anchorRowFor(rows, ["worktree:/gone", "worktree:/wt-b", "worktree:/wt-a"]),
    ).toBe(rows.get("/wt-b")!);
  });

  test("ignores non-worktree anchors and returns null when nothing matches", () => {
    expect(anchorRowFor(rows, ["repo:xyz", "worktree:/gone"])).toBeNull();
    expect(anchorRowFor(rows, [])).toBeNull();
  });
});

describe("mutationsAllInsideTerminal", () => {
  const insideXterm = {
    closest: (sel: string) => (sel === ".xterm-host" ? {} : null),
  };
  const outside = { closest: () => null };

  test("true when every record target sits inside .xterm-host", () => {
    expect(
      mutationsAllInsideTerminal([
        { target: insideXterm },
        { target: insideXterm },
      ]),
    ).toBe(true);
  });

  test("false as soon as one record escapes the terminal", () => {
    expect(
      mutationsAllInsideTerminal([{ target: insideXterm }, { target: outside }]),
    ).toBe(false);
  });

  test("text-node targets resolve through parentElement", () => {
    const textInside = { parentElement: insideXterm };
    const textOutside = { parentElement: outside };
    expect(mutationsAllInsideTerminal([{ target: textInside }])).toBe(true);
    expect(mutationsAllInsideTerminal([{ target: textOutside }])).toBe(false);
  });

  test("unresolvable or empty batches are NOT treated as terminal-internal (safe: tick)", () => {
    expect(mutationsAllInsideTerminal([{ target: null }])).toBe(false);
    expect(mutationsAllInsideTerminal([{ target: { parentElement: null } }])).toBe(
      false,
    );
    expect(mutationsAllInsideTerminal([])).toBe(false);
  });
});

describe("StickyNotesLayer wiring", () => {
  const SOURCE = readFileSync(
    join(import.meta.dir, "../src/StickyNotesLayer.svelte"),
    "utf-8",
  );

  test("the MutationObserver filters terminal-internal records", () => {
    const start = SOURCE.indexOf("mutationObs = new MutationObserver");
    expect(start, "MutationObserver not found").toBeGreaterThan(-1);
    const end = SOURCE.indexOf("resizeObs = new ResizeObserver", start);
    expect(end, "ResizeObserver after MutationObserver").toBeGreaterThan(start);
    expect(SOURCE.slice(start, end)).toContain("mutationsAllInsideTerminal");
  });

  /** Slice a function body by its declaration and a known following
   *  declaration — robust to line shifts. */
  function slice(from: string, to: string): string {
    const start = SOURCE.indexOf(from);
    expect(start, `${from} not found`).toBeGreaterThan(-1);
    const end = SOURCE.indexOf(to, start);
    expect(end, `${to} not found after ${from}`).toBeGreaterThan(start);
    return SOURCE.slice(start, end);
  }

  test("applyRowMargins resolves anchors/chips via per-pass maps, not per-note document queries", () => {
    const body = slice("function applyRowMargins", "let flyRafActive");
    expect(body).toContain("buildAnchorRowMap<HTMLElement>(document)");
    expect(body).toContain("anchorRowFor(");
    expect(body).not.toContain("findAnchorLi(");
    // The per-note `.sticky[data-note-id="..."]` lookup must not come back.
    expect(body).not.toContain("cssEscape(note.id)");
  });

  test("positionsByNoteId builds the row map once per recompute", () => {
    const body = slice("let positionsByNoteId", "function daemonIdForAnchors");
    expect(body).toContain("buildAnchorRowMap<HTMLElement>(document)");
  });
});
