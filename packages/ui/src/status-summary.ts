/**
 * Row-status badge text (e.g. "3 staged, 5 unstaged, 1 untracked")
 * shown next to each worktree. Pulled out of `App.svelte` so the
 * formatter can be unit-tested and — more importantly — so the
 * count derivation can prefer the freshly-loaded wt-summary path
 * arrays over the slower `/api/repos` `FileStatus` snapshot. When
 * the two disagreed (different git invocations, different fetch
 * lifecycles) the badge would read "5 unstaged" while the hover
 * tooltip showed "UNSTAGED (2)". Preferring the wt-summary once
 * it's loaded keeps the badge and the popup in lockstep.
 */

export interface FileStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  /** Submodule-internal dirt (parent's recorded SHA unchanged). Shown
   *  as a muted "N submodule" trailer; never counted as parent dirty. */
  submodules?: number;
}

/** Shape we need from a loaded wt-summary to override the badge counts.
 *  Matches `WtSummary` in App.svelte but kept structural here so this
 *  module doesn't depend on the App-internal type. */
export interface StatusSummarySource {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface StatusSummary {
  clean: boolean;
  text: string;
  submoduleText: string;
}

/**
 * `wtSummary` may be undefined (never hovered), the literal string
 * `"loading"` (request in flight), or a populated object. Only the
 * populated case overrides — the others fall back to `fileStatus`,
 * so a row the user has never hovered still shows the initial badge.
 * `submodules` always comes from `fileStatus`: wt-summary's path
 * arrays don't carry that bucket.
 */
export function statusSummary(
  fileStatus: FileStatus,
  wtSummary?: StatusSummarySource | "loading",
): StatusSummary {
  const fresh =
    wtSummary && wtSummary !== "loading" ? wtSummary : null;
  const staged = fresh ? fresh.staged.length : fileStatus.staged;
  const unstaged = fresh ? fresh.unstaged.length : fileStatus.unstaged;
  const untracked = fresh ? fresh.untracked.length : fileStatus.untracked;
  const subs = fileStatus.submodules ?? 0;
  const submoduleText =
    subs > 0 ? `${subs} submodule${subs === 1 ? "" : "s"} changed` : "";
  const total = staged + unstaged + untracked;
  if (total === 0) return { clean: true, text: "clean", submoduleText };
  const parts: string[] = [];
  if (staged) parts.push(`${staged} staged`);
  if (unstaged) parts.push(`${unstaged} unstaged`);
  if (untracked) parts.push(`${untracked} untracked`);
  return { clean: false, text: parts.join(", "), submoduleText };
}
