/**
 * Trailing-edge coalescer for terminal resizes.
 *
 * During a zen / fullscreen toggle the terminal container changes size
 * over many animation frames — macOS native fullscreen animates for
 * ~0.7s, and `window`'s `resize` (plus `ResizeObserver`) fire throughout.
 * Acting on every intermediate size sends a `SIGWINCH` storm to the PTY,
 * and the TUI app repaints mid-transition at half-settled dimensions,
 * which duplicates and clips its output.
 *
 * Routing every resize trigger through one coalescer fires the real work
 * exactly ONCE, after the size has settled (no trigger for `delayMs`).
 * Because both the ResizeObserver and the window-resize listener share a
 * single coalescer, a transition that fires both is also de-duped to one
 * resize.
 *
 * The timer is injectable so the coalescing contract is unit-testable
 * without real timers.
 */
export interface CoalescerTimer {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimer: CoalescerTimer = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ResizeCoalescer {
  /** Schedule (or reschedule) the trailing call. */
  trigger: () => void;
  /** Drop any pending call without firing it (use on teardown). */
  cancel: () => void;
}

export function createResizeCoalescer(
  run: () => void,
  delayMs: number,
  timer: CoalescerTimer = realTimer,
): ResizeCoalescer {
  let handle: unknown = null;
  const fire = () => {
    handle = null;
    run();
  };
  return {
    trigger() {
      if (handle !== null) timer.clear(handle);
      handle = timer.set(fire, delayMs);
    },
    cancel() {
      if (handle !== null) {
        timer.clear(handle);
        handle = null;
      }
    },
  };
}
