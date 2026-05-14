/**
 * Age-based gating for the `↑N` push-badge heartbeat blink. Pulled out
 * of `App.svelte` so the threshold math can be unit-tested with a
 * fixed `now` instead of `Date.now()`.
 */

/**
 * Minutes the oldest unpushed commit must have been sitting locally
 * before the heartbeat pulsate kicks in. Fresh commits stay calm —
 * you just made them; you know they're there — and the nudge starts
 * when the work has been parked.
 */
export const BLINK_AHEAD_MINUTES = 20;

export interface AheadAgeSource {
  /** ISO-8601 timestamp of the oldest unpushed commit, or null /
   *  undefined when the branch has no unpushed commits / the daemon
   *  hasn't yet surfaced an oldest-time. Both null and undefined are
   *  accepted to match the BranchStatus shape in App.svelte. */
  aheadOldestTime?: string | null;
}

/**
 * True when the oldest unpushed commit is older than
 * `BLINK_AHEAD_MINUTES`. `nowMs` is parameterised so tests can pin
 * the clock; production callers omit it and we read `Date.now()`.
 */
export function aheadAged(
  b: AheadAgeSource,
  nowMs: number = Date.now(),
): boolean {
  if (!b.aheadOldestTime) return false;
  const ageM = (nowMs - Date.parse(b.aheadOldestTime)) / 60_000;
  return ageM >= BLINK_AHEAD_MINUTES;
}
