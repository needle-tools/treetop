/**
 * Decide whether the 5-minute TUI auto-summary timer should fire an
 * Ollama summary for the session it's watching (see SessionView's
 * tuiSummaryTimer).
 *
 * Two reasons to fire:
 *   1. An existing summary has drifted from the live conversation
 *      (the UI's `shouldShowRefresh`: a summary exists AND ≥2 new turns
 *      since it was generated). Its own drift gate keeps this from
 *      re-firing on unchanged content.
 *   2. The session has never been summarised but now has enough
 *      conversation to be worth a first ("seed") summary.
 *
 * The seed path is gated on the turn count having GROWN since the last
 * attempt. Without that guard, a session with no installed Ollama model
 * (or a failing generation) would retry the seed every interval forever
 * on unchanged content — the kind of pile-up that made auto-summary get
 * disabled for never-summarised TUIs in the first place.
 */

export interface TuiAutoSummaryInput {
  /** A summary stream is already running for this session. */
  refreshing: boolean;
  /** A cached summary body already exists for this session. */
  hasSummary: boolean;
  /** Current count of sampled user/assistant text turns. */
  sampledCount: number;
  /** `sampledCount` at the last auto-summary attempt (-1 if never). */
  lastAttemptCount: number;
  /** An existing summary has drifted ≥2 messages (UI's shouldShowRefresh). */
  summaryDrifted: boolean;
}

/** Minimum sampled turns before a never-summarised TUI is worth an
 *  automatic first summary — below this there's too little conversation
 *  to produce a useful label. */
export const MIN_TURNS_TO_SEED = 2;

export function shouldAutoSummarizeTui(i: TuiAutoSummaryInput): boolean {
  if (i.refreshing) return false;
  // Refresh an existing, drifted summary.
  if (i.summaryDrifted) return true;
  // Seed the first summary once there's enough conversation, but only
  // when the turn count has grown since our last attempt.
  return (
    !i.hasSummary &&
    i.sampledCount >= MIN_TURNS_TO_SEED &&
    i.sampledCount > i.lastAttemptCount
  );
}
