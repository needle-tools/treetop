/**
 * "Is the dashboard worth polling for right now?" — a single source of
 * truth the rest of the app consults before kicking off optional
 * background work (visible-fetch git pulls, transient-session polling,
 * etc.). The SSE stream + fs_change-driven refreshes are unaffected;
 * this only gates work the UI initiates on a timer.
 *
 * The dashboard sits in a tab for hours; meanwhile the daemon runs
 * `git fetch` on every visible repo every 30 s, and every fetch
 * touches `.git/FETCH_HEAD` which the worktree watcher broadcasts as
 * `fs_change`, and every fs_change triggers a fresh /api/repos refresh.
 * On a 20-worktree workspace that's a steady ~15-20% daemon CPU pulse
 * the user does not benefit from when they aren't looking. Pausing
 * the polling closes the loop.
 *
 * "Idle" is the OR of:
 *   - the tab is hidden (`document.hidden`)
 *   - no mouse / keyboard / scroll / touch event in the last
 *     `ACTIVITY_IDLE_MS` (default 10 s)
 *
 * When the user comes back (visibilitychange → visible, or a fresh
 * input event after a quiet period) we want one immediate catch-up
 * refresh — otherwise the dashboard shows stale data until the next
 * timer fires. Callers register a `onResume` listener for that.
 */

export const ACTIVITY_IDLE_MS = 10_000;

/** Injected clock; tests override to control "now". */
type Clock = () => number;

interface IdleState {
  lastActivityMs: number;
  hidden: boolean;
  clock: Clock;
  resumeListeners: Set<() => void>;
}

function createState(clock: Clock = Date.now): IdleState {
  return {
    lastActivityMs: clock(),
    hidden: false,
    clock,
    resumeListeners: new Set(),
  };
}

const moduleState = createState();

export function isUiIdleWith(state: IdleState): boolean {
  if (state.hidden) return true;
  return state.clock() - state.lastActivityMs > ACTIVITY_IDLE_MS;
}

export function isUiIdle(): boolean {
  return isUiIdleWith(moduleState);
}

/** Record user activity. Wakes resume listeners if we were idle. */
export function bumpActivityWith(state: IdleState): void {
  const wasIdle = isUiIdleWith(state);
  state.lastActivityMs = state.clock();
  if (wasIdle && !isUiIdleWith(state)) {
    for (const cb of state.resumeListeners) {
      try {
        cb();
      } catch {
        // listener exceptions don't propagate
      }
    }
  }
}

export function bumpActivity(): void {
  bumpActivityWith(moduleState);
}

/** Update the tab-visibility input. */
export function setHiddenWith(state: IdleState, hidden: boolean): void {
  const wasIdle = isUiIdleWith(state);
  state.hidden = hidden;
  if (!hidden) {
    // Coming back into view counts as activity — keeps the idle clock
    // honest so we don't immediately re-pause if no event arrives.
    state.lastActivityMs = state.clock();
  }
  if (wasIdle && !isUiIdleWith(state)) {
    for (const cb of state.resumeListeners) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }
}

export function setHidden(hidden: boolean): void {
  setHiddenWith(moduleState, hidden);
}

export function onResumeWith(state: IdleState, cb: () => void): () => void {
  state.resumeListeners.add(cb);
  return () => {
    state.resumeListeners.delete(cb);
  };
}

export function onResume(cb: () => void): () => void {
  return onResumeWith(moduleState, cb);
}

/** Install the DOM listeners. Returns a teardown function. SSR-safe
 *  (no-op when `document` isn't defined). */
export function installIdleTracker(): () => void {
  if (typeof document === "undefined") return () => {};
  const events = [
    "mousemove",
    "keydown",
    "click",
    "scroll",
    "touchstart",
  ] as const;
  const onEvent = (): void => bumpActivity();
  for (const ev of events) {
    document.addEventListener(ev, onEvent, { passive: true });
  }
  const onVisibility = (): void => setHidden(document.hidden);
  document.addEventListener("visibilitychange", onVisibility);
  // Seed initial visibility — the tab may have been opened in the
  // background.
  setHidden(document.hidden);
  return () => {
    for (const ev of events) document.removeEventListener(ev, onEvent);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Test-only: a fresh state instance with an injected clock. */
export function createIdleStateForTest(clock: Clock): IdleState {
  return createState(clock);
}
