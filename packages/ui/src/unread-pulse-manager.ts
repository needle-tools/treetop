/**
 * Extracted unread-pulse state machine from App.svelte.
 *
 * createUnreadPulseManager() owns the two timer maps and exposes the five
 * functions that were previously closed over App.svelte's reactive vars.
 * The reactive `transientFinishedAt` variable stays in App.svelte (so
 * Svelte's reactivity system sees assignments); this factory reads/writes it
 * through injected get/set callbacks.
 */

// ---------------------------------------------------------------------------
// Constants (exported so App.svelte and tests can pin real values)
// ---------------------------------------------------------------------------

export const FINISH_DEBOUNCE_MS = 8_000;
export const READ_GRACE_MS = 3_000;
export const MIN_WORKING_FOR_PULSE_MS = 3_000;

// ---------------------------------------------------------------------------
// Dep types
// ---------------------------------------------------------------------------

type TimerHandle = ReturnType<typeof setTimeout>;

export interface UnreadPulseDeps {
  /** Read the current value of transientFinishedAt. */
  getFinishedAt(): Record<string, number | undefined>;
  /** Write a new value to transientFinishedAt (triggers Svelte reactivity). */
  setFinishedAt(next: Record<string, number | undefined>): void;
  /** Returns true when the session column for this source has DOM focus. */
  isSessionFocused(source: string): boolean;
  /** Defaults to Date.now(). Injectable for tests. */
  now?(): number;
  /** Defaults to setTimeout. Injectable for tests. */
  schedule?(fn: () => void, ms: number): TimerHandle;
  /** Defaults to clearTimeout. Injectable for tests. */
  clear?(handle: TimerHandle): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUnreadPulseManager(deps: UnreadPulseDeps) {
  const {
    getFinishedAt,
    setFinishedAt,
    isSessionFocused,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    clear = (h) => clearTimeout(h),
  } = deps;

  // Internal timer maps — not visible to callers.
  const finishedTimers: Record<string, TimerHandle | undefined> = {};
  const readGraceTimers: Record<string, TimerHandle | undefined> = {};

  function cancelFinishedTimer(source: string): void {
    const t = finishedTimers[source];
    if (t) {
      clear(t);
      finishedTimers[source] = undefined;
    }
  }

  function clearFinishedFor(source: string): void {
    cancelFinishedTimer(source);
    if (getFinishedAt()[source] !== undefined) {
      setFinishedAt({
        ...getFinishedAt(),
        [source]: undefined,
      });
    }
  }

  function scheduleFinished(source: string): void {
    cancelFinishedTimer(source);
    finishedTimers[source] = schedule(() => {
      finishedTimers[source] = undefined;
      // If the user is currently focused inside the column when
      // the AI finishes, they don't need the dock to remind them
      // about an "unread" turn — they're already looking. Skip.
      if (isSessionFocused(source)) return;
      setFinishedAt({
        ...getFinishedAt(),
        [source]: now(),
      });
    }, FINISH_DEBOUNCE_MS);
  }

  function cancelReadGrace(source: string): void {
    const t = readGraceTimers[source];
    if (t) {
      clear(t);
      readGraceTimers[source] = undefined;
    }
  }

  function startReadGrace(source: string): void {
    cancelReadGrace(source);
    if (getFinishedAt()[source] === undefined) return;
    readGraceTimers[source] = schedule(() => {
      readGraceTimers[source] = undefined;
      clearFinishedFor(source);
    }, READ_GRACE_MS);
  }

  return {
    scheduleFinished,
    cancelFinishedTimer,
    clearFinishedFor,
    startReadGrace,
    cancelReadGrace,
  };
}
