/**
 * Per-worktree recompute coalescing — anti-starvation for the dirty-state
 * refresh.
 *
 * Every fs_change for a worktree wants to recompute its git status. A worktree
 * with an active dev server / TUI writing files fires fs_change every watcher
 * debounce window (~300ms). Each recompute takes a slot on the shared git
 * limiter (REPOS_GIT_CONCURRENCY). With many such repos open, those chatty
 * worktrees saturate the limiter and a quiet worktree (where the only change
 * was a single commit) waits at the back of a long queue — its dirty badge
 * goes stale for tens of seconds.
 *
 * The fix: bound each worktree to at most one recompute per `minIntervalMs`,
 * with a single trailing recompute to capture whatever changed during the
 * cooldown. That frees limiter slots so the queue drains quickly and no single
 * chatty worktree can monopolize it.
 *
 * This module is the pure decision; the timer + state wiring lives in server.ts.
 */

export interface WorktreeRecomputeState {
  /** When this worktree last STARTED a recompute (ms epoch), or null. */
  lastRunAtMs: number | null;
  /** A recompute is currently running for this worktree. */
  inFlight: boolean;
  /** A trailing recompute is already scheduled (timer armed). */
  hasPendingTrailing: boolean;
}

export type WorktreeRecomputePlan =
  | { action: "run" }
  | { action: "schedule-trailing"; delayMs: number }
  | { action: "skip" };

/**
 * Decide what to do with an incoming recompute request for a worktree.
 *
 * - "run" — free to recompute immediately (idle and past the cooldown).
 * - "schedule-trailing" — too soon (in flight, or last run within the
 *   cooldown); arm a single trailing recompute after `delayMs` so the latest
 *   state is still captured without piling onto the limiter now.
 * - "skip" — a trailing recompute is already pending; this request is folded
 *   into it (classic trailing-throttle coalescing).
 */
export function planWorktreeRecompute(
  state: WorktreeRecomputeState,
  nowMs: number,
  minIntervalMs: number,
): WorktreeRecomputePlan {
  const tooSoon =
    state.lastRunAtMs !== null && nowMs - state.lastRunAtMs < minIntervalMs;

  if (!state.inFlight && !tooSoon) return { action: "run" };
  if (state.hasPendingTrailing) return { action: "skip" };

  // In flight → wait a full interval after it presumably finishes; otherwise
  // wait out the remainder of the cooldown since the last run.
  const delayMs = state.inFlight
    ? minIntervalMs
    : Math.max(0, minIntervalMs - (nowMs - (state.lastRunAtMs ?? nowMs)));
  return { action: "schedule-trailing", delayMs };
}
