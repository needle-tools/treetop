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
import {
  VISIBLE_ROW_SELECTOR,
  anchorRowFor,
  buildAnchorRowMap,
  cachedRowRect,
  mutationsAffectStickyNoteLayout,
  mutationsAllInsideTerminal,
  shouldMeasureStickyRowMargins,
  shouldMountStickyNote,
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

  test("visible-row selector excludes offscreen rows", () => {
    expect(VISIBLE_ROW_SELECTOR).toContain(":not(.row-offscreen)");
  });
});

describe("anchorRowFor", () => {
  const rows = new Map<string, FakeRow>([
    ["/wt-a", { dataset: { wtRow: "/wt-a" } }],
    ["/wt-b", { dataset: { wtRow: "/wt-b" } }],
  ]);

  test("resolves the first worktree anchor that has a visible row", () => {
    expect(
      anchorRowFor(rows, [
        "worktree:/gone",
        "worktree:/wt-b",
        "worktree:/wt-a",
      ]),
    ).toBe(rows.get("/wt-b")!);
  });

  test("ignores non-worktree anchors and returns null when nothing matches", () => {
    expect(anchorRowFor(rows, ["repo:xyz", "worktree:/gone"])).toBeNull();
    expect(anchorRowFor(rows, [])).toBeNull();
  });
});

describe("cachedRowRect", () => {
  test("measures a row once per cache and reuses the same rect", () => {
    const row = { dataset: { wtRow: "/wt-a" } };
    const rect = { bottom: 10, width: 20 };
    const cache = new Map<typeof row, typeof rect>();
    let calls = 0;
    const measure = () => {
      calls++;
      return rect;
    };

    expect(cachedRowRect(cache, row, measure)).toBe(rect);
    expect(cachedRowRect(cache, row, measure)).toBe(rect);
    expect(calls).toBe(1);
  });
});

describe("shouldMountStickyNote", () => {
  const idleHidden = {
    hasPosition: false,
    editing: false,
    staged: false,
    flying: false,
    removing: false,
    dragging: false,
    attachmentDropActive: false,
  };

  test("does not mount ordinary notes whose row is hidden", () => {
    expect(shouldMountStickyNote(idleHidden)).toBe(false);
  });

  test("mounts visible notes", () => {
    expect(shouldMountStickyNote({ ...idleHidden, hasPosition: true })).toBe(
      true,
    );
  });

  test("keeps transient hidden notes mounted", () => {
    for (const key of [
      "editing",
      "staged",
      "flying",
      "removing",
      "dragging",
      "attachmentDropActive",
    ] as const) {
      expect(shouldMountStickyNote({ ...idleHidden, [key]: true })).toBe(true);
    }
  });
});

describe("shouldMeasureStickyRowMargins", () => {
  test("skips row-map work when no note components rendered", () => {
    expect(shouldMeasureStickyRowMargins(12, 0)).toBe(false);
  });

  test("measures only when stored notes have rendered stickies", () => {
    expect(shouldMeasureStickyRowMargins(0, 1)).toBe(false);
    expect(shouldMeasureStickyRowMargins(1, 1)).toBe(true);
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
      mutationsAllInsideTerminal([
        { target: insideXterm },
        { target: outside },
      ]),
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
    expect(
      mutationsAllInsideTerminal([{ target: { parentElement: null } }]),
    ).toBe(false);
    expect(mutationsAllInsideTerminal([])).toBe(false);
  });
});

describe("mutationsAffectStickyNoteLayout", () => {
  function target(
    className: string,
    matchesSelector: (sel: string) => boolean,
  ) {
    return {
      className,
      getAttribute: (name: string) => (name === "class" ? className : null),
      matches: matchesSelector,
      closest: () => null,
    };
  }

  const row = (className: string) =>
    target(className, (sel) => sel === "[data-wt-row]");
  const col = (className: string) =>
    target(className, (sel) => sel === ".session-col");
  const sessionStrip = {
    closest: (sel: string) => (sel === ".sessions-strip" ? {} : null),
  };
  const insideSessionCol = {
    closest: (sel: string) =>
      sel === ".sessions-strip" || sel === ".session-col" ? {} : null,
  };

  test("ignores column visibility and flash classes that do not move note anchors", () => {
    expect(
      mutationsAffectStickyNoteLayout([
        {
          type: "attributes",
          attributeName: "class",
          oldValue: "session-col",
          target: col("session-col col-offscreen session-col-flash"),
        },
      ]),
    ).toBe(false);
  });

  test("ignores session-strip child churn that cannot move note anchors", () => {
    expect(
      mutationsAffectStickyNoteLayout([
        { type: "childList", target: sessionStrip },
        { type: "childList", target: insideSessionCol },
      ]),
    ).toBe(false);
  });

  test("keeps scheduling for note-layout row classes and structural mutations", () => {
    expect(
      mutationsAffectStickyNoteLayout([
        {
          type: "attributes",
          attributeName: "class",
          oldValue: "row",
          target: row("row row-offscreen"),
        },
      ]),
    ).toBe(true);
    expect(
      mutationsAffectStickyNoteLayout([
        {
          type: "attributes",
          attributeName: "class",
          oldValue: "row",
          target: row("row row-folded"),
        },
      ]),
    ).toBe(true);
    expect(
      mutationsAffectStickyNoteLayout([
        {
          type: "attributes",
          attributeName: "data-wt-row",
          oldValue: "/old",
          target: row("row"),
        },
      ]),
    ).toBe(true);
    expect(
      mutationsAffectStickyNoteLayout([
        { type: "childList", target: row("row") },
      ]),
    ).toBe(true);
  });

  test("falls back to scheduling when class oldValue is unavailable", () => {
    expect(
      mutationsAffectStickyNoteLayout([
        {
          type: "attributes",
          attributeName: "class",
          target: row("row row-offscreen"),
        },
      ]),
    ).toBe(true);
  });
});
