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

/** Rows a note may anchor to: present, onscreen, not folded, notes not hidden.
 *  Mirrors the visibility rules documented on findAnchorLi in
 *  StickyNotesLayer.svelte. */
export const VISIBLE_ROW_SELECTOR =
  "[data-wt-row]:not(.row-offscreen):not(.row-folded):not(.row-notes-hidden)";

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

/** Read a row rect at most once during a single layout pass. */
export function cachedRowRect<T, Rect>(
  rects: Map<T, Rect>,
  row: T,
  measure: (row: T) => Rect,
): Rect {
  const cached = rects.get(row);
  if (cached) return cached;
  const rect = measure(row);
  rects.set(row, rect);
  return rect;
}

export interface StickyNoteMountState {
  hasPosition: boolean;
  editing: boolean;
  staged: boolean;
  flying: boolean;
  removing: boolean;
  dragging: boolean;
  attachmentDropActive: boolean;
}

/** Hidden/folded-row notes do not need a mounted Svelte component or
 *  DOM subtree. Keep them mounted only while transient local state
 *  would be harmful to tear down mid-interaction. */
export function shouldMountStickyNote(state: StickyNoteMountState): boolean {
  return (
    state.hasPosition ||
    state.editing ||
    state.staged ||
    state.flying ||
    state.removing ||
    state.dragging ||
    state.attachmentDropActive
  );
}

/** Loose shape of MutationRecord.target: elements expose closest(),
 *  text nodes reach their element via parentElement. */
export interface MutationTargetLike {
  closest?(selector: string): unknown;
  matches?(selector: string): boolean;
  getAttribute?(name: string): string | null;
  className?: unknown;
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

type MutationRecordLike = {
  type?: string;
  attributeName?: string | null;
  oldValue?: string | null;
  target: MutationTargetLike | null;
};

const COL_NON_LAYOUT_CLASSES = new Set([
  "col-offscreen",
  "session-col-flash",
]);

function classTokens(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

function currentClassName(target: MutationTargetLike): string | null {
  if (typeof target.getAttribute === "function") {
    return target.getAttribute("class") ?? "";
  }
  return typeof target.className === "string" ? target.className : null;
}

function changedClassTokens(oldValue: string, newValue: string): Set<string> {
  const oldTokens = classTokens(oldValue);
  const newTokens = classTokens(newValue);
  const changed = new Set<string>();
  for (const token of oldTokens) {
    if (!newTokens.has(token)) changed.add(token);
  }
  for (const token of newTokens) {
    if (!oldTokens.has(token)) changed.add(token);
  }
  return changed;
}

function isNonLayoutVisibilityClassMutation(record: MutationRecordLike): boolean {
  if (record.type !== "attributes" || record.attributeName !== "class") {
    return false;
  }
  const target = record.target;
  if (!target || typeof target.matches !== "function") return false;
  if (typeof record.oldValue !== "string") return false;
  const current = currentClassName(target);
  if (current === null) return false;
  const changed = changedClassTokens(record.oldValue, current);
  if (changed.size === 0) return true;
  const allowed = target.matches(".session-col")
    ? COL_NON_LAYOUT_CLASSES
    : null;
  if (!allowed) return false;
  for (const token of changed) {
    if (!allowed.has(token)) return false;
  }
  return true;
}

/** True when a MutationObserver batch can change sticky-note anchor
 *  geometry. Drops known decorative visibility/flash class churn before
 *  it schedules a full note reposition pass; keeps the safe default for
 *  anything structural or unrecognized. */
export function mutationsAffectStickyNoteLayout(
  records: readonly MutationRecordLike[],
): boolean {
  if (records.length === 0) return true;
  if (mutationsAllInsideTerminal(records)) return false;
  for (const record of records) {
    if (!isNonLayoutVisibilityClassMutation(record)) return true;
  }
  return false;
}
