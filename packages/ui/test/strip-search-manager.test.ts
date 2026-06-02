/**
 * Faithful copies of App.svelte's strip-search logic as of commit 4142178.
 * Step 2 extracts these (computeStripFilterByWt + a createStripSearchManager
 * factory with the same injected collaborators) and re-points the tests;
 * staying green proves the extraction is behavior-preserving.
 *
 * The shims below turn every closed-over reactive variable into an explicit
 * injectable collaborator so the logic can be exercised in a domless bun:test.
 *
 * StripFilter shape (App.svelte lines 5189–5192):
 *   interface StripFilter {
 *     matched: Set<string>;   // sources of ALL sessions that matched the query
 *     notOpen: AgentSession[]; // matched sessions not currently open as a column
 *   }
 *
 * computeStripFilterByWt iterates Object.keys(stripSearchQuery).  For each
 * wtPath whose query trims to non-empty it calls filterSessions(all, q) to get
 * a scored+ranked list, builds matched from that list's sources, then derives
 * notOpen as the ranked sessions whose source is NOT in openSessionsByWt[wtPath].
 * A whitespace-only or absent query → NO entry in the result map (strip renders
 * unfiltered for that worktree).
 */

import { test, expect, describe } from "bun:test";
import { filterSessions, type AgentSession } from "../src/sessionSearch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StripFilter {
  matched: Set<string>;
  notOpen: AgentSession[];
}

// ---------------------------------------------------------------------------
// State shape injected into every shim
// ---------------------------------------------------------------------------

interface StripSearchState {
  stripSearchOpen: Record<string, boolean>;
  stripSearchQuery: Record<string, string>;
  stripSearchAutoUnfolded: Record<string, boolean>;
  lastStripSearchQuery: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Harness factory — creates fresh state + spy collaborators per test
// ---------------------------------------------------------------------------

function makeHarness(opts?: {
  /** Pre-populated rowFolded map (defaults to all false / absent). */
  rowFolded?: Record<string, boolean>;
  /** Pre-populated pickerSessionsByWt map. */
  pickerSessionsByWt?: Record<string, AgentSession[]>;
  /** Pre-populated openSessionsByWt map (sources currently shown as columns). */
  openSessionsByWt?: Record<string, { source: string }[]>;
}) {
  // Mutable state, mirrors the 4 Records in App.svelte.
  let state: StripSearchState = {
    stripSearchOpen: {},
    stripSearchQuery: {},
    stripSearchAutoUnfolded: {},
    lastStripSearchQuery: {},
  };

  // Separate row-fold state (lives in App.svelte but is injected here).
  let rowFolded: Record<string, boolean> = { ...(opts?.rowFolded ?? {}) };

  // Session data maps (driven by the test scenario).
  const pickerSessionsByWt: Record<string, AgentSession[]> =
    opts?.pickerSessionsByWt ?? {};
  const openSessionsByWt: Record<string, { source: string }[]> =
    opts?.openSessionsByWt ?? {};

  // Spy for scrollToAndFlashSession — records every call.
  const flashCalls: { wtPath: string; source: string }[] = [];
  function scrollToAndFlashSession(wtPath: string, source: string): void {
    flashCalls.push({ wtPath, source });
  }

  // ---------------------------------------------------------------------------
  // Shim: computeStripFilterByWt
  // Faithful copy of App.svelte lines 5193-5208.
  // ---------------------------------------------------------------------------
  function computeStripFilterByWt(): Record<string, StripFilter> {
    const m: Record<string, StripFilter> = {};
    for (const wtPath of Object.keys(state.stripSearchQuery)) {
      const q = state.stripSearchQuery[wtPath] ?? "";
      if (!q.trim()) continue;
      const all = pickerSessionsByWt[wtPath] ?? [];
      const ranked = filterSessions(all, q);
      const matched = new Set(ranked.map((s) => s.source));
      const openSet = new Set(
        (openSessionsByWt[wtPath] ?? []).map((o) => o.source),
      );
      const notOpen = ranked.filter((s) => !openSet.has(s.source));
      m[wtPath] = { matched, notOpen };
    }
    return m;
  }

  // ---------------------------------------------------------------------------
  // Shim: openStripSearch
  // Faithful copy of App.svelte lines 620-635.
  // ---------------------------------------------------------------------------
  function openStripSearch(rowKey: string, wtPath: string): void {
    if (rowFolded[rowKey]) {
      state = {
        ...state,
        stripSearchAutoUnfolded: {
          ...state.stripSearchAutoUnfolded,
          [rowKey]: true,
        },
      };
      rowFolded = { ...rowFolded, [rowKey]: false };
    }
    state = {
      ...state,
      stripSearchOpen: { ...state.stripSearchOpen, [wtPath]: true },
    };
    const restore = state.lastStripSearchQuery[wtPath];
    if (restore) {
      state = {
        ...state,
        stripSearchQuery: { ...state.stripSearchQuery, [wtPath]: restore },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Shim: closeStripSearch
  // Faithful copy of App.svelte lines 639-658.
  // ---------------------------------------------------------------------------
  function closeStripSearch(rowKey: string, wtPath: string): void {
    state = {
      ...state,
      stripSearchOpen: { ...state.stripSearchOpen, [wtPath]: false },
      stripSearchQuery: { ...state.stripSearchQuery, [wtPath]: "" },
    };
    if (state.lastStripSearchQuery[wtPath]) {
      state = {
        ...state,
        lastStripSearchQuery: {
          ...state.lastStripSearchQuery,
          [wtPath]: "",
        },
      };
    }
    if (state.stripSearchAutoUnfolded[rowKey]) {
      rowFolded = { ...rowFolded, [rowKey]: true };
      state = {
        ...state,
        stripSearchAutoUnfolded: {
          ...state.stripSearchAutoUnfolded,
          [rowKey]: false,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Shim: pinRowOpenAfterPick
  // Faithful copy of App.svelte lines 688-695.
  // ---------------------------------------------------------------------------
  function pinRowOpenAfterPick(rowKey: string): void {
    if (state.stripSearchAutoUnfolded[rowKey]) {
      state = {
        ...state,
        stripSearchAutoUnfolded: {
          ...state.stripSearchAutoUnfolded,
          [rowKey]: false,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Shim: commitStripSearch
  // Faithful copy of App.svelte lines 666-682.
  // ---------------------------------------------------------------------------
  function commitStripSearch(
    rowKey: string,
    wtPath: string,
    source: string,
  ): void {
    if (!state.stripSearchOpen[wtPath]) return;
    const filter = computeStripFilterByWt()[wtPath];
    if (!filter || !filter.matched.has(source)) return;
    const q = state.stripSearchQuery[wtPath] ?? "";
    if (q.trim()) {
      state = {
        ...state,
        lastStripSearchQuery: { ...state.lastStripSearchQuery, [wtPath]: q },
      };
    }
    pinRowOpenAfterPick(rowKey);
    state = {
      ...state,
      stripSearchOpen: { ...state.stripSearchOpen, [wtPath]: false },
      stripSearchQuery: { ...state.stripSearchQuery, [wtPath]: "" },
    };
    scrollToAndFlashSession(wtPath, source);
  }

  return {
    get state() {
      return state;
    },
    set state(v: StripSearchState) {
      state = v;
    },
    get rowFolded() {
      return rowFolded;
    },
    set rowFolded(v: Record<string, boolean>) {
      rowFolded = v;
    },
    flashCalls,
    computeStripFilterByWt,
    openStripSearch,
    closeStripSearch,
    commitStripSearch,
    pinRowOpenAfterPick,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkSession(
  overrides: Partial<AgentSession> & { source: string },
): AgentSession {
  return {
    agent: "claude",
    cwd: "/wt",
    lastActive: "2024-01-01T10:00:00Z",
    ...overrides,
  };
}

// ===========================================================================
// computeStripFilterByWt — pure filter (HIGHEST VALUE, pinned thoroughly)
// ===========================================================================

describe("computeStripFilterByWt — empty / whitespace query", () => {
  test("no entry in stripSearchQuery → empty result map", () => {
    const h = makeHarness();
    const result = h.computeStripFilterByWt();
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("entry present but value is empty string → no entry in result (strip renders unfiltered)", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt/a": "" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt/a"]).toBeUndefined();
  });

  test("entry present but value is whitespace only → no entry in result", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt/a": "   " },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt/a"]).toBeUndefined();
  });

  test("one wt has empty query, another has real query → only the real one appears", () => {
    const sessions = [
      mkSession({ source: "/s/a.jsonl", title: "alpha work" }),
    ];
    const h = makeHarness({ pickerSessionsByWt: { "/wt/b": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt/a": "", "/wt/b": "alpha" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt/a"]).toBeUndefined();
    expect(result["/wt/b"]).toBeDefined();
  });
});

describe("computeStripFilterByWt — matched set and notOpen partition", () => {
  const sessions: AgentSession[] = [
    mkSession({ source: "/s/a.jsonl", title: "refactor the UI layout" }),
    mkSession({ source: "/s/b.jsonl", title: "fix daemon crash bug" }),
    mkSession({ source: "/s/c.jsonl", title: "add dark mode support" }),
    mkSession({ source: "/s/d.jsonl", title: "update readme" }),
  ];

  test("query matching one session → matched Set contains exactly that source", () => {
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "readme" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt"]!.matched.has("/s/d.jsonl")).toBe(true);
    expect(result["/wt"]!.matched.size).toBe(1);
  });

  test("query matching multiple sessions → matched contains all matching sources and no non-matching ones", () => {
    // "add" matches both "add dark mode support" and "readme" does not, but
    // "a" subsequence-matches many — use a precise substring "dark" for clarity.
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "dark" },
    };
    const result = h.computeStripFilterByWt();
    const matched = result["/wt"]!.matched;
    expect(matched.has("/s/c.jsonl")).toBe(true); // "add dark mode support"
    expect(matched.has("/s/a.jsonl")).toBe(false);
    expect(matched.has("/s/b.jsonl")).toBe(false);
    expect(matched.has("/s/d.jsonl")).toBe(false);
  });

  test("no sessions have pickerSessionsByWt entry → matched is empty Set", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt/new": "anything" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt/new"]!.matched.size).toBe(0);
    expect(result["/wt/new"]!.notOpen).toHaveLength(0);
  });

  test("notOpen contains matched sessions not in openSessionsByWt", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [{ source: "/s/a.jsonl" }] },
    });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "refactor" },
    };
    const result = h.computeStripFilterByWt();
    // "refactor the UI layout" → /s/a.jsonl matches, but it IS open → notOpen = []
    expect(result["/wt"]!.notOpen).toHaveLength(0);
    expect(result["/wt"]!.matched.has("/s/a.jsonl")).toBe(true);
  });

  test("notOpen contains matched sessions that are NOT currently open as a column", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
    });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "daemon" },
    };
    const result = h.computeStripFilterByWt();
    // "fix daemon crash bug" → /s/b.jsonl matches, not open → in notOpen
    expect(result["/wt"]!.notOpen.map((s) => s.source)).toContain("/s/b.jsonl");
  });

  test("session open as a column is in matched but not in notOpen", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [{ source: "/s/b.jsonl" }] },
    });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "daemon" },
    };
    const result = h.computeStripFilterByWt();
    const filter = result["/wt"]!;
    expect(filter.matched.has("/s/b.jsonl")).toBe(true);
    expect(filter.notOpen.map((s) => s.source)).not.toContain("/s/b.jsonl");
  });

  test("some matched open, some matched not open → correct partition", () => {
    // query "e" (subsequence/substring) may hit several; use exact field match.
    const sessions2: AgentSession[] = [
      mkSession({ source: "/s/x.jsonl", title: "foo bar" }),
      mkSession({ source: "/s/y.jsonl", title: "foo baz" }),
      mkSession({ source: "/s/z.jsonl", title: "foo qux" }),
    ];
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions2 },
      openSessionsByWt: { "/wt": [{ source: "/s/x.jsonl" }, { source: "/s/y.jsonl" }] },
    });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "foo" },
    };
    const result = h.computeStripFilterByWt();
    const filter = result["/wt"]!;
    // All 3 match "foo"
    expect(filter.matched.size).toBe(3);
    // Only /s/z.jsonl is not open
    expect(filter.notOpen.map((s) => s.source)).toEqual(["/s/z.jsonl"]);
  });

  test("notOpen preserves the order returned by filterSessions (score-ranked)", () => {
    // Title match scores higher than firstUserMessage match.
    const sessions3: AgentSession[] = [
      mkSession({ source: "/s/low.jsonl", firstUserMessage: "search me" }),
      mkSession({ source: "/s/high.jsonl", title: "search me" }),
    ];
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions3 } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "search me" },
    };
    const result = h.computeStripFilterByWt();
    // High-score session (title match) must come first in notOpen.
    const notOpenSources = result["/wt"]!.notOpen.map((s) => s.source);
    expect(notOpenSources[0]).toBe("/s/high.jsonl");
    expect(notOpenSources[1]).toBe("/s/low.jsonl");
  });
});

describe("computeStripFilterByWt — case-insensitivity and trimming", () => {
  const sessions: AgentSession[] = [
    mkSession({ source: "/s/a.jsonl", title: "Refactor the Auth Module" }),
    mkSession({ source: "/s/b.jsonl", title: "unrelated task" }),
  ];

  test("query is lowercased before matching — uppercase query matches lowercase title field", () => {
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "AUTH" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt"]!.matched.has("/s/a.jsonl")).toBe(true);
    expect(result["/wt"]!.matched.has("/s/b.jsonl")).toBe(false);
  });

  test("query is lowercased — mixed case query matches correctly", () => {
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "ReFaCtoR" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt"]!.matched.has("/s/a.jsonl")).toBe(true);
  });

  test("leading/trailing whitespace in query is trimmed before matching (not before the empty-check)", () => {
    // The real code: q.trim() for the empty check; filterSessions receives the
    // original q (which in turn does its own rawQuery.trim()). Net effect: a
    // query of '  auth  ' is treated the same as 'auth'.
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "  auth  " },
    };
    const result = h.computeStripFilterByWt();
    // Not empty (trim is non-empty), so a filter entry is produced.
    expect(result["/wt"]).toBeDefined();
    expect(result["/wt"]!.matched.has("/s/a.jsonl")).toBe(true);
  });

  test("title field matching is case-insensitive (fieldScore lowercases haystack)", () => {
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "module" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt"]!.matched.has("/s/a.jsonl")).toBe(true);
  });

  test("non-matching query → matched is empty Set, result entry still present", () => {
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt": "zzz-no-match-zzz" },
    };
    const result = h.computeStripFilterByWt();
    // Entry IS present because the query is non-empty — it just has an empty matched set.
    expect(result["/wt"]).toBeDefined();
    expect(result["/wt"]!.matched.size).toBe(0);
    expect(result["/wt"]!.notOpen).toHaveLength(0);
  });

  test("multiple worktrees are computed independently", () => {
    const sessA = [mkSession({ source: "/s/a.jsonl", title: "alpha work" })];
    const sessB = [mkSession({ source: "/s/b.jsonl", title: "beta work" })];
    const h = makeHarness({
      pickerSessionsByWt: { "/wt/a": sessA, "/wt/b": sessB },
    });
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt/a": "alpha", "/wt/b": "beta" },
    };
    const result = h.computeStripFilterByWt();
    expect(result["/wt/a"]!.matched.has("/s/a.jsonl")).toBe(true);
    expect(result["/wt/b"]!.matched.has("/s/b.jsonl")).toBe(true);
    // No cross-contamination.
    expect(result["/wt/a"]!.matched.has("/s/b.jsonl")).toBe(false);
    expect(result["/wt/b"]!.matched.has("/s/a.jsonl")).toBe(false);
  });
});

// ===========================================================================
// openStripSearch
// Quirk pinned: immutable-spread identity — every write creates a new object.
// ===========================================================================

describe("openStripSearch", () => {
  test("sets stripSearchOpen[wtPath] = true", () => {
    const h = makeHarness();
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchOpen["/wt/a"]).toBe(true);
  });

  test("does not fold/unfold or touch stripSearchAutoUnfolded when row is NOT folded", () => {
    const h = makeHarness({ rowFolded: { "row-1": false } });
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBeUndefined();
    expect(h.rowFolded["row-1"]).toBe(false);
  });

  test("when row IS folded → sets stripSearchAutoUnfolded[rowKey]=true and rowFolded[rowKey]=false", () => {
    const h = makeHarness({ rowFolded: { "row-1": true } });
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(true);
    expect(h.rowFolded["row-1"]).toBe(false);
  });

  test("rowFolded for OTHER rows is not touched", () => {
    const h = makeHarness({ rowFolded: { "row-1": true, "row-2": true } });
    h.openStripSearch("row-1", "/wt/a");
    expect(h.rowFolded["row-2"]).toBe(true);
  });

  test("restores lastStripSearchQuery into stripSearchQuery when present and non-empty", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      lastStripSearchQuery: { "/wt/a": "previous query" },
    };
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchQuery["/wt/a"]).toBe("previous query");
  });

  test("does NOT restore when lastStripSearchQuery[wtPath] is absent", () => {
    const h = makeHarness();
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchQuery["/wt/a"]).toBeUndefined();
  });

  test("does NOT restore when lastStripSearchQuery[wtPath] is empty string (falsy)", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      lastStripSearchQuery: { "/wt/a": "" },
    };
    h.openStripSearch("row-1", "/wt/a");
    // No restore — the existing stripSearchQuery entry (undefined) stays.
    expect(h.state.stripSearchQuery["/wt/a"]).toBeUndefined();
  });

  test("immutable-spread: state object identity changes after call", () => {
    const h = makeHarness();
    const before = h.state;
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state).not.toBe(before);
  });

  test("immutable-spread: stripSearchOpen sub-object is a new reference after call", () => {
    const h = makeHarness();
    const beforeOpen = h.state.stripSearchOpen;
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchOpen).not.toBe(beforeOpen);
  });

  test("opening twice for the same wtPath → still open=true (idempotent result)", () => {
    const h = makeHarness();
    h.openStripSearch("row-1", "/wt/a");
    h.openStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchOpen["/wt/a"]).toBe(true);
  });
});

// ===========================================================================
// closeStripSearch
// Quirk: explicit cancel clears lastStripSearchQuery (opposite of commit).
// ===========================================================================

describe("closeStripSearch", () => {
  test("sets stripSearchOpen[wtPath] = false", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt/a": true },
    };
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchOpen["/wt/a"]).toBe(false);
  });

  test("clears stripSearchQuery[wtPath] to empty string", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchQuery: { "/wt/a": "some query" },
    };
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchQuery["/wt/a"]).toBe("");
  });

  test("clears lastStripSearchQuery[wtPath] when it had a value (explicit cancel drops saved query)", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      lastStripSearchQuery: { "/wt/a": "saved query" },
    };
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.state.lastStripSearchQuery["/wt/a"]).toBe("");
  });

  test("does not touch lastStripSearchQuery when it had no value for that wtPath", () => {
    const h = makeHarness();
    const beforeLast = h.state.lastStripSearchQuery;
    h.closeStripSearch("row-1", "/wt/a");
    // No spread happened for lastStripSearchQuery — reference stays same.
    expect(h.state.lastStripSearchQuery).toBe(beforeLast);
  });

  test("re-folds the row when stripSearchAutoUnfolded[rowKey] was true", () => {
    const h = makeHarness({ rowFolded: { "row-1": false } });
    h.state = {
      ...h.state,
      stripSearchAutoUnfolded: { "row-1": true },
    };
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.rowFolded["row-1"]).toBe(true);
  });

  test("clears stripSearchAutoUnfolded[rowKey] after re-folding", () => {
    const h = makeHarness({ rowFolded: { "row-1": false } });
    h.state = {
      ...h.state,
      stripSearchAutoUnfolded: { "row-1": true },
    };
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(false);
  });

  test("does NOT re-fold when stripSearchAutoUnfolded[rowKey] is false/absent", () => {
    const h = makeHarness({ rowFolded: { "row-1": false } });
    h.closeStripSearch("row-1", "/wt/a");
    // Row stays unfolded.
    expect(h.rowFolded["row-1"]).toBe(false);
  });

  test("does NOT re-fold a different rowKey", () => {
    const h = makeHarness({ rowFolded: { "row-1": false, "row-2": false } });
    h.state = {
      ...h.state,
      stripSearchAutoUnfolded: { "row-1": true },
    };
    h.closeStripSearch("row-1", "/wt/a");
    // row-2 is unaffected.
    expect(h.rowFolded["row-2"]).toBe(false);
  });

  test("closing a never-opened search → all writes are still safe (no throw)", () => {
    const h = makeHarness();
    expect(() => h.closeStripSearch("row-1", "/wt/a")).not.toThrow();
    expect(h.state.stripSearchOpen["/wt/a"]).toBe(false);
    expect(h.state.stripSearchQuery["/wt/a"]).toBe("");
  });

  test("open → close round-trip: open and query are cleared, row stays unfolded when it was never folded", () => {
    const h = makeHarness({ rowFolded: { "row-1": false } });
    h.openStripSearch("row-1", "/wt/a");
    h.state = { ...h.state, stripSearchQuery: { "/wt/a": "hello" } };
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.state.stripSearchOpen["/wt/a"]).toBe(false);
    expect(h.state.stripSearchQuery["/wt/a"]).toBe("");
    expect(h.rowFolded["row-1"]).toBe(false);
  });

  test("open (row was folded) → close → row is re-folded (auto-unfold undone)", () => {
    const h = makeHarness({ rowFolded: { "row-1": true } });
    h.openStripSearch("row-1", "/wt/a");
    // Row is now unfolded, autoUnfolded flag is true.
    expect(h.rowFolded["row-1"]).toBe(false);
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(true);
    h.closeStripSearch("row-1", "/wt/a");
    expect(h.rowFolded["row-1"]).toBe(true);
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(false);
  });
});

// ===========================================================================
// commitStripSearch
// Quirk: saves the query BEFORE closing (opposite order from close).
// ===========================================================================

describe("commitStripSearch", () => {
  const sessions: AgentSession[] = [
    mkSession({ source: "/s/a.jsonl", title: "matching session" }),
    mkSession({ source: "/s/b.jsonl", title: "unrelated work" }),
  ];

  function openedHarness(extra?: {
    rowFolded?: Record<string, boolean>;
    autoUnfolded?: boolean;
  }) {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
      rowFolded: extra?.rowFolded,
    });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      stripSearchQuery: { "/wt": "matching" },
    };
    if (extra?.autoUnfolded) {
      h.state = {
        ...h.state,
        stripSearchAutoUnfolded: { "row-1": true },
      };
    }
    return h;
  }

  test("no-op when stripSearchOpen[wtPath] is false", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
    });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": false },
      stripSearchQuery: { "/wt": "matching" },
    };
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    // No flash, open stays false (was already false).
    expect(h.flashCalls).toHaveLength(0);
  });

  test("no-op when source is NOT in matched set", () => {
    const h = openedHarness();
    // "/s/b.jsonl" doesn't match "matching" → not in filter.matched.
    h.commitStripSearch("row-1", "/wt", "/s/b.jsonl");
    expect(h.flashCalls).toHaveLength(0);
    expect(h.state.stripSearchOpen["/wt"]).toBe(true); // still open
  });

  test("no-op when filter is absent for wtPath (no query entry)", () => {
    const h = makeHarness({ pickerSessionsByWt: { "/wt": sessions } });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      // No stripSearchQuery entry for /wt → computeStripFilterByWt returns {}
    };
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    expect(h.flashCalls).toHaveLength(0);
  });

  test("saves non-empty query to lastStripSearchQuery before closing", () => {
    const h = openedHarness();
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    expect(h.state.lastStripSearchQuery["/wt"]).toBe("matching");
  });

  test("does NOT save to lastStripSearchQuery when query is empty string", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
    });
    // Open with empty query — but filterSessions("") returns original list
    // and scoreSession with empty query returns 1 → everything matches.
    // We need an edge case where open=true but query="" after trim.
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      stripSearchQuery: { "/wt": "" },
    };
    // With empty query, computeStripFilterByWt skips it → filter undefined → early return.
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    // Early return at !filter check, so lastStripSearchQuery stays empty.
    expect(h.state.lastStripSearchQuery["/wt"]).toBeUndefined();
  });

  test("does NOT save to lastStripSearchQuery when query is whitespace only", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
    });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      stripSearchQuery: { "/wt": "   " },
    };
    // computeStripFilterByWt: "   ".trim() is "" → no filter entry → early return.
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    expect(h.state.lastStripSearchQuery["/wt"]).toBeUndefined();
  });

  test("sets stripSearchOpen[wtPath] = false after commit", () => {
    const h = openedHarness();
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    expect(h.state.stripSearchOpen["/wt"]).toBe(false);
  });

  test("clears stripSearchQuery[wtPath] to empty string after commit", () => {
    const h = openedHarness();
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    expect(h.state.stripSearchQuery["/wt"]).toBe("");
  });

  test("calls scrollToAndFlashSession with correct wtPath and source", () => {
    const h = openedHarness();
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    expect(h.flashCalls).toHaveLength(1);
    expect(h.flashCalls[0]).toEqual({ wtPath: "/wt", source: "/s/a.jsonl" });
  });

  test("clears stripSearchAutoUnfolded[rowKey] via pinRowOpenAfterPick before closing", () => {
    const h = openedHarness({ autoUnfolded: true });
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    // pinRowOpenAfterPick cleared the flag → row stays expanded even though
    // closeStripSearch would re-fold it if the flag were still set.
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(false);
  });

  test("row stays unfolded after commit when it was auto-unfolded (pin prevents re-fold)", () => {
    // Simulate: row was folded → openStripSearch unfolded it → user commits.
    const h = makeHarness({
      rowFolded: { "row-1": false }, // already unfolded after openStripSearch
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
    });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      stripSearchQuery: { "/wt": "matching" },
      stripSearchAutoUnfolded: { "row-1": true },
    };
    h.commitStripSearch("row-1", "/wt", "/s/a.jsonl");
    // pinRowOpenAfterPick clears the flag → closeStripSearch won't re-fold.
    expect(h.rowFolded["row-1"]).toBe(false);
  });
});

// ===========================================================================
// pinRowOpenAfterPick
// ===========================================================================

describe("pinRowOpenAfterPick", () => {
  test("clears stripSearchAutoUnfolded[rowKey] when it is true", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchAutoUnfolded: { "row-1": true },
    };
    h.pinRowOpenAfterPick("row-1");
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(false);
  });

  test("no-op (no spread) when stripSearchAutoUnfolded[rowKey] is false/absent", () => {
    const h = makeHarness();
    const before = h.state;
    h.pinRowOpenAfterPick("row-1");
    // The `if` branch is not taken → state object identity unchanged.
    expect(h.state).toBe(before);
  });

  test("does not affect other rows' autoUnfolded flags", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchAutoUnfolded: { "row-1": true, "row-2": true },
    };
    h.pinRowOpenAfterPick("row-1");
    expect(h.state.stripSearchAutoUnfolded["row-2"]).toBe(true);
  });

  test("calling twice is idempotent (second call is a no-op)", () => {
    const h = makeHarness();
    h.state = {
      ...h.state,
      stripSearchAutoUnfolded: { "row-1": true },
    };
    h.pinRowOpenAfterPick("row-1");
    const afterFirst = h.state;
    h.pinRowOpenAfterPick("row-1");
    // Second call: flag is false → `if` not taken → same object.
    expect(h.state).toBe(afterFirst);
  });
});

// ===========================================================================
// Integration: open → type → commit full flow
// ===========================================================================

describe("full open → type → commit flow", () => {
  const sessions: AgentSession[] = [
    mkSession({ source: "/s/target.jsonl", title: "the target session" }),
    mkSession({ source: "/s/other.jsonl", title: "something else" }),
  ];

  test("folded row: open unfolds it, commit pins it open, close would have re-folded it (but commit prevents that)", () => {
    const h = makeHarness({
      rowFolded: { "row-1": true },
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
    });

    // Step 1: open — unfolds row.
    h.openStripSearch("row-1", "/wt");
    expect(h.rowFolded["row-1"]).toBe(false);
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(true);

    // Step 2: user types a query.
    h.state = { ...h.state, stripSearchQuery: { "/wt": "target" } };

    // Step 3: commit on the matched source.
    h.commitStripSearch("row-1", "/wt", "/s/target.jsonl");

    // Result: row stays expanded (pin cleared the flag).
    expect(h.rowFolded["row-1"]).toBe(false);
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(false);
    expect(h.state.stripSearchOpen["/wt"]).toBe(false);
    expect(h.state.lastStripSearchQuery["/wt"]).toBe("target");
    expect(h.flashCalls).toHaveLength(1);
    expect(h.flashCalls[0]).toEqual({ wtPath: "/wt", source: "/s/target.jsonl" });
  });

  test("folded row: open unfolds it, close re-folds it and clears saved query (explicit cancel)", () => {
    const h = makeHarness({
      rowFolded: { "row-1": true },
      pickerSessionsByWt: { "/wt": sessions },
    });

    h.openStripSearch("row-1", "/wt");
    h.state = { ...h.state, stripSearchQuery: { "/wt": "target" } };

    // Cancel via close (no pick).
    h.closeStripSearch("row-1", "/wt");

    expect(h.rowFolded["row-1"]).toBe(true);
    expect(h.state.stripSearchAutoUnfolded["row-1"]).toBe(false);
    expect(h.state.stripSearchOpen["/wt"]).toBe(false);
    expect(h.state.stripSearchQuery["/wt"]).toBe("");
    // lastStripSearchQuery is NOT set by close (explicit cancel path).
    expect(h.state.lastStripSearchQuery["/wt"]).toBeUndefined();
    expect(h.flashCalls).toHaveLength(0);
  });

  test("commit then re-open → query is restored from lastStripSearchQuery", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
      openSessionsByWt: { "/wt": [] },
    });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      stripSearchQuery: { "/wt": "target" },
    };

    h.commitStripSearch("row-1", "/wt", "/s/target.jsonl");
    expect(h.state.lastStripSearchQuery["/wt"]).toBe("target");

    // Re-open: should restore "target".
    h.openStripSearch("row-1", "/wt");
    expect(h.state.stripSearchQuery["/wt"]).toBe("target");
  });

  test("close (cancel) then re-open → query is blank (lastStripSearchQuery was cleared)", () => {
    const h = makeHarness({
      pickerSessionsByWt: { "/wt": sessions },
    });
    h.state = {
      ...h.state,
      stripSearchOpen: { "/wt": true },
      stripSearchQuery: { "/wt": "target" },
      lastStripSearchQuery: { "/wt": "target" },
    };

    h.closeStripSearch("row-1", "/wt");
    expect(h.state.lastStripSearchQuery["/wt"]).toBe("");

    // Re-open: restore="" is falsy → openStripSearch does not overwrite the
    // query. But closeStripSearch already wrote "" into stripSearchQuery,
    // so the entry is "" (not undefined).
    h.openStripSearch("row-1", "/wt");
    expect(h.state.stripSearchQuery["/wt"]).toBe("");
  });
});
