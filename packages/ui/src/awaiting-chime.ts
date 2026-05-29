/**
 * "AI has been waiting for me too long" chime.
 *
 * Mirrors the side-dock's pulsating `awaiting` signal (SessionDock's
 * `dot-awaiting`): a session that's been continuously awaiting user
 * input for {@link AWAITING_CHIME_MS} fires a one-shot sound as an
 * audible nudge. The chime fires once per awaiting *episode* per
 * source — when the session stops awaiting (the user replied, or it
 * went back to working) the latch resets so the next stall chimes
 * again.
 *
 * Pure + clock-injected so it can be unit-tested without timers; the
 * App drives it from a reactive `syncAwaiting` (on dock-entry change)
 * plus an interval calling `dueForChime`.
 */

/** Grace period: how long a session must stay continuously awaiting
 *  before the nudge sound fires. */
export const AWAITING_CHIME_MS = 60_000;

export interface AwaitingChimeState {
  /** source → ms timestamp when its current awaiting episode began. */
  since: Map<string, number>;
  /** Sources that already chimed for their current awaiting episode. */
  fired: Set<string>;
}

export function createAwaitingChimeState(): AwaitingChimeState {
  return { since: new Map(), fired: new Set() };
}

/** Reconcile tracked episodes with the live set of currently-awaiting
 *  sources: stamp newly-awaiting ones, and drop (clearing the fired
 *  latch) any that stopped awaiting. */
export function syncAwaiting(
  state: AwaitingChimeState,
  awaitingSources: Iterable<string>,
  now: number,
): void {
  const live = new Set(awaitingSources);
  for (const src of live) {
    if (!state.since.has(src)) state.since.set(src, now);
  }
  for (const src of [...state.since.keys()]) {
    if (!live.has(src)) {
      state.since.delete(src);
      state.fired.delete(src);
    }
  }
}

/** Sources that have now crossed the grace threshold and haven't
 *  chimed yet for this episode. Latches them as fired before
 *  returning, so a given episode is reported exactly once. The caller
 *  plays the nudge sound when the result is non-empty. */
export function dueForChime(
  state: AwaitingChimeState,
  now: number,
): string[] {
  const due: string[] = [];
  for (const [src, since] of state.since) {
    if (state.fired.has(src)) continue;
    if (now - since >= AWAITING_CHIME_MS) {
      state.fired.add(src);
      due.push(src);
    }
  }
  return due;
}
