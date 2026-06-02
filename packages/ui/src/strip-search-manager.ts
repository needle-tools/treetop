/**
 * Per-worktree inline session-strip search subsystem, extracted verbatim
 * from App.svelte (commit 4142178).
 *
 * Two exports:
 *   - `computeStripFilterByWt` — the pure `$:` derive: turns the current
 *     query map (+ picker/open session maps) into a `Record<wtPath,
 *     StripFilter>`. Absent / whitespace-only query → no entry for that
 *     worktree (strip renders unfiltered).
 *   - `createStripSearchManager` — the four mutating actions
 *     (open/close/commit/pinRowOpenAfterPick) as bound closures over a
 *     `deps` bag of get/set accessors. App.svelte keeps its reactive
 *     `let`s; the get/set bridges read/reassign them so Svelte's
 *     reactivity still fires on every immutable-spread write.
 *
 * The logic is moved unchanged; every direct reactive read/write in the
 * original is swapped for the injected accessor. All quirks the
 * characterization tests pin (auto-unfold tracking + re-fold,
 * lastStripSearchQuery save-vs-clear, commit's matched-guard +
 * save-then-close order, no-op object-identity when a flag is already
 * falsy) are preserved.
 */

import { filterSessions, type AgentSession } from "./sessionSearch";

/** Per worktree: which session sources are currently matched by the
 *  inline strip search, and which matches are *not* yet open as a
 *  column (those become the synthetic "more matches" pseudo-column).
 *  Absent entry / empty query → strip renders without filtering. */
export interface StripFilter {
  matched: Set<string>;
  notOpen: AgentSession[];
}

/** Pure derive: build the per-worktree strip filter from the current
 *  query map. Takes the three reactive inputs as params so Svelte's
 *  `$:` can keep tracking them by referencing them directly at the call
 *  site. */
export function computeStripFilterByWt(
  stripSearchQuery: Record<string, string>,
  pickerSessionsByWt: Record<string, AgentSession[]>,
  openSessionsByWt: Record<string, { source: string }[]>,
): Record<string, StripFilter> {
  const m: Record<string, StripFilter> = {};
  for (const wtPath of Object.keys(stripSearchQuery)) {
    const q = stripSearchQuery[wtPath] ?? "";
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

/** Injected collaborators for the strip-search action closures. */
export interface StripSearchManagerDeps {
  getStripSearchOpen: () => Record<string, boolean>;
  setStripSearchOpen: (v: Record<string, boolean>) => void;
  getStripSearchQuery: () => Record<string, string>;
  setStripSearchQuery: (v: Record<string, string>) => void;
  getStripSearchAutoUnfolded: () => Record<string, boolean>;
  setStripSearchAutoUnfolded: (v: Record<string, boolean>) => void;
  getLastStripSearchQuery: () => Record<string, string>;
  setLastStripSearchQuery: (v: Record<string, string>) => void;
  getRowFolded: () => Record<string, boolean>;
  setRowFolded: (v: Record<string, boolean>) => void;
  /** Reads the current derived value of `stripFilterByWt`. */
  getStripFilterByWt: () => Record<string, StripFilter>;
  scrollToAndFlashSession: (wtPath: string, source: string) => unknown;
}

export interface StripSearchManager {
  openStripSearch: (rowKey: string, wtPath: string) => void;
  closeStripSearch: (rowKey: string, wtPath: string) => void;
  commitStripSearch: (rowKey: string, wtPath: string, source: string) => void;
  pinRowOpenAfterPick: (rowKey: string) => void;
}

export function createStripSearchManager(
  deps: StripSearchManagerDeps,
): StripSearchManager {
  /** Open the inline strip search for a worktree. If the row is
   *  currently folded we unfold it and remember (so close-without-pick
   *  re-folds it). The search input itself is rendered in the row
   *  head, which is visible regardless of fold state — only the strip
   *  below is hidden when folded, so unfolding is what reveals the
   *  matches the search is filtering for. */
  function openStripSearch(rowKey: string, wtPath: string): void {
    if (deps.getRowFolded()[rowKey]) {
      deps.setStripSearchAutoUnfolded({
        ...deps.getStripSearchAutoUnfolded(),
        [rowKey]: true,
      });
      deps.setRowFolded({ ...deps.getRowFolded(), [rowKey]: false });
    }
    deps.setStripSearchOpen({ ...deps.getStripSearchOpen(), [wtPath]: true });
    // Restore the last committed query so re-opening picks up where
    // the user left off; absent / empty entry = blank input.
    const restore = deps.getLastStripSearchQuery()[wtPath];
    if (restore) {
      deps.setStripSearchQuery({
        ...deps.getStripSearchQuery(),
        [wtPath]: restore,
      });
    }
  }
  /** Close the inline strip search. Clears the query, hides the input,
   *  and re-folds the row iff opening the search was what unfolded it
   *  AND no session pick has cleared the flag in the meantime. */
  function closeStripSearch(rowKey: string, wtPath: string): void {
    deps.setStripSearchOpen({ ...deps.getStripSearchOpen(), [wtPath]: false });
    deps.setStripSearchQuery({ ...deps.getStripSearchQuery(), [wtPath]: "" });
    // Explicit cancel (× / ESC) → drop the saved query so the next
    // open starts blank. A commit (`commitStripSearch`) takes the
    // opposite path: it saves the query first, then closes.
    if (deps.getLastStripSearchQuery()[wtPath]) {
      deps.setLastStripSearchQuery({
        ...deps.getLastStripSearchQuery(),
        [wtPath]: "",
      });
    }
    if (deps.getStripSearchAutoUnfolded()[rowKey]) {
      deps.setRowFolded({ ...deps.getRowFolded(), [rowKey]: true });
      deps.setStripSearchAutoUnfolded({
        ...deps.getStripSearchAutoUnfolded(),
        [rowKey]: false,
      });
    }
  }
  /** Commit the active strip search by clicking a matched session
   *  column. Saves the typed query (so re-opening restores it), pins
   *  the row open, hides the search input, and flashes/scrolls to the
   *  picked column — same "look here" cue the synthetic-column pick
   *  produces. No-op when search isn't open or the source isn't in
   *  the matched set (defensive — filtered-out columns are display:
   *  none and shouldn't receive clicks anyway). */
  function commitStripSearch(
    rowKey: string,
    wtPath: string,
    source: string,
  ): void {
    if (!deps.getStripSearchOpen()[wtPath]) return;
    const filter = deps.getStripFilterByWt()[wtPath];
    if (!filter || !filter.matched.has(source)) return;
    const q = deps.getStripSearchQuery()[wtPath] ?? "";
    if (q.trim()) {
      deps.setLastStripSearchQuery({
        ...deps.getLastStripSearchQuery(),
        [wtPath]: q,
      });
    }
    pinRowOpenAfterPick(rowKey);
    deps.setStripSearchOpen({ ...deps.getStripSearchOpen(), [wtPath]: false });
    deps.setStripSearchQuery({ ...deps.getStripSearchQuery(), [wtPath]: "" });
    void deps.scrollToAndFlashSession(wtPath, source);
  }
  /** Cancel the auto-re-fold for this row. Called as soon as the user
   *  picks a session from the synthetic "matches not in strip" column
   *  (or presses Enter on the top match): from that point on, closing
   *  the search must leave the row expanded so the just-opened column
   *  stays in view. */
  function pinRowOpenAfterPick(rowKey: string): void {
    if (deps.getStripSearchAutoUnfolded()[rowKey]) {
      deps.setStripSearchAutoUnfolded({
        ...deps.getStripSearchAutoUnfolded(),
        [rowKey]: false,
      });
    }
  }

  return {
    openStripSearch,
    closeStripSearch,
    commitStripSearch,
    pinRowOpenAfterPick,
  };
}
