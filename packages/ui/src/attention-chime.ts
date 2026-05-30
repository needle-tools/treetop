/**
 * "An agent has needed me for a while" chime.
 *
 * Mirrors the two ways the side-dock signals a session wants the user:
 *   - `awaiting`  — an explicit prompt is sitting unanswered
 *                   (dock's `dot-awaiting`); flicker-prone, so its
 *                   episode start is tracked across syncs.
 *   - `finishedAt`— the agent completed a turn the user hasn't focused
 *                   yet (dock's `dot-unread-pulse`); already a stable
 *                   timestamp, so it needs no bookkeeping.
 *
 * A source that has continuously needed attention for {@link
 * ATTENTION_CHIME_MS} fires a one-shot nudge. It chimes once per
 * episode: when the session stops needing attention (the user replied,
 * focused it, or it went back to working) the latch resets, so the
 * next stall chimes again. `finishedAt` wins over `awaiting` when both
 * are present — it's the stabler clock.
 *
 * Pure + clock-injected so it can be unit-tested without timers. The
 * App drives `syncAttention` reactively (on dock-entry change) and
 * `dueForChime` from an interval / on tab refocus.
 */

/** Grace period: how long a session must continuously need attention
 *  before the nudge sound fires. */
export const ATTENTION_CHIME_MS = 60_000;

export interface AttentionInput {
  source: string;
  /** An explicit prompt is waiting (dock `dot-awaiting`). */
  awaiting: boolean;
  /** ms timestamp the agent finished its last turn, if unread. */
  finishedAt?: number;
}

export interface AttentionChimeState {
  /** source → first time the current awaiting run was observed. The
   *  finished-turn signal carries its own stable timestamp; only the
   *  flicker-prone awaiting signal needs this. */
  awaitingSince: Map<string, number>;
  /** source → the episode-start timestamp we already chimed for, so a
   *  fresh episode (different start) chimes again but the same one
   *  doesn't repeat. */
  fired: Map<string, number>;
}

export function createAttentionChimeState(): AttentionChimeState {
  return { awaitingSince: new Map(), fired: new Map() };
}

/** The timestamp at which `e` started needing the user, or null when
 *  it doesn't. `finishedAt` (stable) wins over the tracked awaiting
 *  start when both apply. */
export function attentionSince(
  state: AttentionChimeState,
  e: AttentionInput,
): number | null {
  if (typeof e.finishedAt === "number") return e.finishedAt;
  if (e.awaiting) return state.awaitingSince.get(e.source) ?? null;
  return null;
}

/** Reconcile per-source bookkeeping with the live entries: stamp the
 *  start of new awaiting runs, forget runs that ended, and drop the
 *  fired latch / tracking for sources that no longer need attention or
 *  have disappeared. */
export function syncAttention(
  state: AttentionChimeState,
  entries: AttentionInput[],
  now: number,
): void {
  const live = new Set<string>();
  for (const e of entries) {
    live.add(e.source);
    if (e.awaiting) {
      if (!state.awaitingSince.has(e.source))
        state.awaitingSince.set(e.source, now);
    } else {
      state.awaitingSince.delete(e.source);
    }
  }
  for (const src of [...state.awaitingSince.keys()]) {
    if (!live.has(src)) state.awaitingSince.delete(src);
  }
  // Clear the fired latch once a source stops needing attention (or
  // vanishes) so its next episode is eligible to chime again.
  const bySource = new Map(entries.map((e) => [e.source, e]));
  for (const src of [...state.fired.keys()]) {
    const e = bySource.get(src);
    if (!e || attentionSince(state, e) === null) state.fired.delete(src);
  }
}

/** Sources that have continuously needed attention for at least the
 *  grace period and haven't chimed yet this episode. Latches them
 *  (keyed by episode start) before returning, so each episode is
 *  reported exactly once. The caller plays the nudge when the result
 *  is non-empty. */
export function dueForChime(
  state: AttentionChimeState,
  entries: AttentionInput[],
  now: number,
): string[] {
  const due: string[] = [];
  for (const e of entries) {
    const since = attentionSince(state, e);
    if (since === null) continue;
    if (now - since < ATTENTION_CHIME_MS) continue;
    if (state.fired.get(e.source) === since) continue;
    state.fired.set(e.source, since);
    due.push(e.source);
  }
  return due;
}
