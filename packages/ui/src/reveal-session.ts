/**
 * Pure decision model for "user clicked a session-related button on a
 * row." Pulled out of `App.svelte` so the state-transition matrix
 * (folded × open × click-source) can be unit-tested without standing
 * up the full component tree.
 *
 * The component layer reads the plan back and applies its boolean
 * actions via the existing imperative helpers (`unfoldRowIfFolded`,
 * `toggleOpenSessionInWt`, `scrollToAndFlashSession`).
 */

import { SYNTHETIC_SOURCE_PREFIXES, sessionSurfaceKeys } from "./storage";

/** Two call sources that share most of the matrix:
 *
 *   - `reveal` — the row-head "most recent session" badge: never
 *     closes; always brings the session into view.
 *   - `reveal-or-toggle` — the picker entries: behave like `reveal`
 *     when the row is folded (so the user can't accidentally close
 *     something they can't see), but keep familiar toggle semantics
 *     when the row is expanded.
 */
export type RevealMode = "reveal" | "reveal-or-toggle";

export interface RevealInput {
  /** Whether the worktree row is currently folded. */
  rowFolded: boolean;
  /** Whether this specific session is already in `openSessionsByWt`. */
  isOpen: boolean;
  mode: RevealMode;
}

export interface RevealPlan {
  /** Unfold the row before doing anything else. Idempotent — caller
   *  no-ops when already unfolded. */
  unfold: boolean;
  /** Open the session (no-op if already open). */
  open: boolean;
  /** Close the session (no-op if already closed). */
  close: boolean;
  /** Scroll the strip to the session column + flash a 2s outline.
   *  Only meaningful when the column is becoming visible; on a plain
   *  expanded-row close we skip it (nothing to land on). */
  scrollAndFlash: boolean;
}

/**
 * Map a click + current state to the set of actions to perform.
 *
 * The two modes diverge only in the expanded-row case:
 *   - `reveal`              never closes — clicking an already-open
 *                           session in an expanded row just re-scrolls
 *                           to it (the × on the column closes).
 *   - `reveal-or-toggle`    flips open ↔ closed; no scroll-flash,
 *                           since the user can already see what
 *                           changed.
 *
 * Folded-row paths are identical: unfold + open-if-needed + scroll-
 * flash. Toggle-style "click again to close" doesn't make sense from
 * a folded row because the user can't observe the current state, so
 * both modes agree to never close on first click.
 */
export function planReveal(input: RevealInput): RevealPlan {
  const { rowFolded, isOpen, mode } = input;

  if (rowFolded) {
    return {
      unfold: true,
      open: !isOpen,
      close: false,
      scrollAndFlash: true,
    };
  }

  if (mode === "reveal") {
    return {
      unfold: false,
      open: !isOpen,
      close: false,
      scrollAndFlash: true,
    };
  }

  // mode === "reveal-or-toggle", expanded row → classic toggle.
  return {
    unfold: false,
    open: !isOpen,
    close: isOpen,
    scrollAndFlash: false,
  };
}

export interface DockEntryLookupRepo {
  id: string;
  worktrees?: DockEntryLookupWorktree[];
}

export interface DockEntryLookupWorktree {
  path: string;
  agents?: DockEntryLookupSession[];
}

export interface DockEntryLookupSession {
  agent: string;
  source?: string;
  transcriptSource?: string;
  resumeSessionId?: string;
  sessionId?: string;
}

export interface DockEntryLookupInput extends DockEntryLookupSession {
  repoId: string;
  wtPath: string;
  source: string;
}

export function dockEntryExistsInLoadedRepos(
  repos: readonly DockEntryLookupRepo[],
  entry: DockEntryLookupInput,
): boolean {
  const repo = repos.find((r) => r.id === entry.repoId);
  const wt = repo?.worktrees?.find((w) => w.path === entry.wtPath);
  if (!wt) return false;

  if (SYNTHETIC_SOURCE_PREFIXES.some((p) => entry.source.startsWith(p))) {
    return true;
  }

  const entryKeys = sessionSurfaceKeys(entry);
  return (wt.agents ?? []).some((agent) =>
    sessionSurfaceKeys(agent).some((key) => entryKeys.includes(key)),
  );
}
