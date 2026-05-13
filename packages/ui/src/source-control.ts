/**
 * Pure helpers for SourceControlPane. Extracted so the convergence rule
 * that decides "do we need to (re)fetch the diff?" is testable without
 * mounting the component.
 *
 * The rule lives here because it has to be applied from three
 * lifecycle transitions and getting it right in all three is what
 * fixed the "Nothing unstaged." regression where:
 *   1. user opened the pane → workdir diff loaded
 *   2. user collapsed the pane
 *   3. fs_change cleared the cached diff (but skipped the refetch
 *      because the pane was collapsed)
 *   4. user re-opened the pane → cache was undefined, `hasTabBeenSet`
 *      was already true, no entry point re-triggered the load
 *      → user saw a stale empty body
 * The fix is to converge to "expanded + active-tab-undefined ⇒ load"
 * from every transition, and have one shared decision function so the
 * three call sites can't drift apart again.
 */

export type DiffTab = "workdir" | "staged";

export interface DiffCacheState {
  /** True when the source-control pane is on screen and rendering its
   *  diff body. When false, no fetches are needed. */
  expanded: boolean;
  /** Which tab the user has active. The other tab's cache stays
   *  whatever it already was (we only refetch the visible one). */
  diffTab: DiffTab;
  /** Undefined ⇒ no fetch has completed yet (or fs_change cleared it).
   *  Empty string ⇒ daemon returned no changes (we don't refetch in
   *  that case — empty is a valid, cached answer). */
  workdirDiff: string | undefined;
  stagedDiff: string | undefined;
}

/** Return which (if any) diff needs to be fetched right now. The
 *  caller dispatches the appropriate `load*Diff()` call. `null` means
 *  "nothing to do." */
export function pendingDiffLoad(state: DiffCacheState): DiffTab | null {
  if (!state.expanded) return null;
  if (state.diffTab === "workdir" && state.workdirDiff === undefined) {
    return "workdir";
  }
  if (state.diffTab === "staged" && state.stagedDiff === undefined) {
    return "staged";
  }
  return null;
}
