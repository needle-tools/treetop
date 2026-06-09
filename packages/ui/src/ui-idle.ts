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
  /** Last idle value broadcast to idleListeners — for edge detection. */
  idle: boolean;
  idleListeners: Set<(idle: boolean) => void>;
}

function createState(clock: Clock = Date.now): IdleState {
  return {
    lastActivityMs: clock(),
    hidden: false,
    clock,
    resumeListeners: new Set(),
    idle: false,
    idleListeners: new Set(),
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

/**
 * Recompute idle and notify `onIdleChange` listeners *only* when it
 * flips. This is the edge that drives the `body.ui-idle` class. The
 * idle→active edge happens synchronously inside `bumpActivity` /
 * `setHidden`; the active→idle edge is timer-driven (the user just
 * stopped moving), so `installIdleTracker` re-checks via this after
 * `ACTIVITY_IDLE_MS` of quiet.
 */
export function syncIdleWith(state: IdleState): boolean {
  const idle = isUiIdleWith(state);
  if (idle !== state.idle) {
    state.idle = idle;
    for (const cb of state.idleListeners) {
      try {
        cb(idle);
      } catch {
        // listener exceptions don't propagate
      }
    }
  }
  return idle;
}

export function syncIdle(): boolean {
  return syncIdleWith(moduleState);
}

export function onIdleChangeWith(
  state: IdleState,
  cb: (idle: boolean) => void,
): () => void {
  state.idleListeners.add(cb);
  return () => {
    state.idleListeners.delete(cb);
  };
}

export function onIdleChange(cb: (idle: boolean) => void): () => void {
  return onIdleChangeWith(moduleState, cb);
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
  syncIdleWith(state);
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
  syncIdleWith(state);
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

  // The active→idle edge is silent (the user just stopped touching the
  // mouse) — nothing fires it on its own. Arm a one-shot timer after
  // every input that re-checks once the quiet window elapses; that's
  // what flips `body.ui-idle` on. Re-armed on each event, so it only
  // actually fires after ACTIVITY_IDLE_MS of real quiet. The +50ms
  // slack ensures the clock has crossed the threshold when we check.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(syncIdle, ACTIVITY_IDLE_MS + 50);
  };

  const events = [
    "mousemove",
    "keydown",
    "click",
    "scroll",
    "touchstart",
  ] as const;
  const onEvent = (): void => {
    bumpActivity();
    armIdleTimer();
  };
  for (const ev of events) {
    document.addEventListener(ev, onEvent, { passive: true });
  }
  const onVisibility = (): void => {
    setHidden(document.hidden);
    if (document.hidden) {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    } else {
      armIdleTimer();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Pause decorative always-on CSS animations while idle. Driven via
  // the `body.ui-idle` class — see the rule in styles/base.css. Only
  // ambient effects are tagged there; functional spinners keep moving.
  const offIdle = onIdleChange((idle) => {
    document.body.classList.toggle("ui-idle", idle);
  });

  // Seed initial visibility — the tab may have been opened in the
  // background — and start watching for the first idle window.
  setHidden(document.hidden);
  armIdleTimer();

  return () => {
    for (const ev of events) document.removeEventListener(ev, onEvent);
    document.removeEventListener("visibilitychange", onVisibility);
    if (idleTimer) clearTimeout(idleTimer);
    offIdle();
    document.body.classList.remove("ui-idle");
  };
}

/** Test-only: a fresh state instance with an injected clock. */
export function createIdleStateForTest(clock: Clock): IdleState {
  return createState(clock);
}

// ---------------------------------------------------------------------------
// Typing gate (`body.is-typing`)
//
// Separate from the idle gate above. A 2026-06-09 trace showed that while
// the user types into a field (composer, sticky note, or a terminal's hidden
// textarea), every keystroke forced a ~29ms `Layerize` over a ~376-layer
// compositor tree — the always-on decorative animations (status-badge edge
// sweeps / pulses) each auto-promote their element to a layer and bloat that
// walk. base.css uses `body.is-typing` to DE-PROMOTE that ambient set
// (`animation: none`, so the layers leave the tree) for the duration of a
// keystroke burst, making each keystroke's Layerize cheap. The class clears
// `TYPING_IDLE_MS` after the last keystroke, so the animations resume the
// moment you pause. See plans/performance.md ("Layerize storm during typing").
// ---------------------------------------------------------------------------

/** How long after the last keystroke we keep `body.is-typing` on. Long
 *  enough to span the gap between keystrokes in a normal typing burst,
 *  short enough that the decorative animations resume promptly on pause. */
export const TYPING_IDLE_MS = 600;

/** Is this event target a field the user types into? Covers `<input>`,
 *  `<textarea>` (incl. xterm.js's hidden `.xterm-helper-textarea`), and
 *  contenteditable surfaces (sticky notes). Pure — exported for testing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || target.isContentEditable;
}

/** Install the `body.is-typing` tracker. Returns a teardown function.
 *  SSR-safe (no-op when `document` isn't defined). */
export function installTypingTracker(): () => void {
  if (typeof document === "undefined") return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    document.body.classList.remove("is-typing");
  };
  const onKeydown = (e: KeyboardEvent): void => {
    if (!isEditableTarget(e.target)) return;
    document.body.classList.add("is-typing");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      document.body.classList.remove("is-typing");
    }, TYPING_IDLE_MS);
  };
  // Capture so we still see the keystroke even if a handler stops
  // propagation (xterm.js, CodeMirror-style editors, etc.).
  document.addEventListener("keydown", onKeydown, {
    capture: true,
    passive: true,
  });
  return () => {
    document.removeEventListener("keydown", onKeydown, { capture: true });
    stop();
  };
}
