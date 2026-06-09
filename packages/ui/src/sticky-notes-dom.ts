/**
 * DOM helpers for StickyNotesLayer's reposition hot path.
 *
 * The layer repositions notes from a MutationObserver covering all of
 * <main> (subtree:true) plus an afterUpdate pass — both of which used a
 * document-wide `querySelector` PER NOTE and interleaved rect reads.
 * xterm's DOM renderer mutates nodes on every keystroke / output chunk,
 * so any visible streaming TUI drove that work every frame: the
 * 2026-06-09 typing trace billed 1806ms to querySelector + 200ms to
 * getBoundingClientRect for passes that never moved a note (see
 * plans/performance.md, "Open TODOs — Layerize").
 *
 * Two levers, both here so they stay unit-testable without a DOM:
 *   - `mutationsAllInsideTerminal` — drop observer batches that are
 *     entirely terminal-internal. `.xterm-host` is `contain: layout`,
 *     so nothing inside it can change worktree-row geometry.
 *   - `buildAnchorRowMap` / `anchorRowFor` — ONE scoped querySelectorAll
 *     per reposition pass instead of a document-wide query per note.
 *
 * Generic over the element type (only `dataset.wtRow` / `closest` are
 * touched) so tests can drive them with plain objects.
 */

/** Rows a note may anchor to: present, not folded, notes not hidden.
 *  Mirrors the visibility rules documented on findAnchorLi in
 *  StickyNotesLayer.svelte. */
export const VISIBLE_ROW_SELECTOR =
  "[data-wt-row]:not(.row-folded):not(.row-notes-hidden)";

interface RowLike {
  dataset: { wtRow?: string };
}

/** Snapshot of the currently anchorable rows, keyed by worktree path.
 *  First row in document order wins (querySelector semantics). */
export function buildAnchorRowMap<T extends RowLike>(root: {
  querySelectorAll(selector: string): Iterable<T>;
}): Map<string, T> {
  const map = new Map<string, T>();
  for (const el of root.querySelectorAll(VISIBLE_ROW_SELECTOR)) {
    const path = el.dataset.wtRow;
    if (path !== undefined && !map.has(path)) map.set(path, el);
  }
  return map;
}

/** Resolve a note's anchor list against a row snapshot — the map-lookup
 *  equivalent of the old per-anchor document.querySelector. */
export function anchorRowFor<T>(
  rows: Map<string, T>,
  anchors: readonly string[],
): T | null {
  for (const a of anchors) {
    if (!a.startsWith("worktree:")) continue;
    const el = rows.get(a.slice("worktree:".length));
    if (el) return el;
  }
  return null;
}

/** Loose shape of MutationRecord.target: elements expose closest(),
 *  text nodes reach their element via parentElement. */
export interface MutationTargetLike {
  closest?(selector: string): unknown;
  parentElement?: MutationTargetLike | null;
}

/** True when every record in the batch targets a node inside
 *  `.xterm-host` — i.e. terminal-internal churn that cannot move a
 *  worktree row. Anything unresolvable (and the empty batch) returns
 *  false so the caller still schedules a tick when in doubt. */
export function mutationsAllInsideTerminal(
  records: readonly { target: MutationTargetLike | null }[],
): boolean {
  if (records.length === 0) return false;
  for (const r of records) {
    const t = r.target;
    const el = t && typeof t.closest === "function" ? t : t?.parentElement;
    if (!el || typeof el.closest !== "function" || !el.closest(".xterm-host")) {
      return false;
    }
  }
  return true;
}
