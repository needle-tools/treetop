/**
 * Tiny custom scroll animator for dock-pick scrolls.
 *
 * Native `element.scrollTo({ behavior: "smooth" })` / `scrollIntoView`
 * animate over a browser-fixed duration that scales with distance — for
 * the session dock's "click a dot, jump to the column" jump that reads
 * as sluggish. `animateValue` drives a single numeric value (a
 * scrollLeft / scrollTop) over a short, tunable duration so the jump
 * feels snappy. The clock + scheduler are injectable so the rAF loop is
 * deterministic under test.
 */

/** Ease-out cubic: fast start, gentle settle. Pins t=0→0 and t=1→1. */
export function easeOutCubic(t: number): number {
  const c = 1 - t;
  return 1 - c * c * c;
}

export interface AnimateValueOpts {
  from: number;
  to: number;
  /** Animation length in ms. <= 0 snaps straight to `to`. */
  duration: number;
  /** Called each frame with the current value. */
  apply: (value: number) => void;
  ease?: (t: number) => number;
  now?: () => number;
  raf?: (cb: (t: number) => void) => void;
}

/** Animate `from` → `to` over `duration` ms, calling `apply` each frame.
 *  Always finishes exactly on `to`. Returns immediately; the work runs
 *  on the injected (or real) rAF. */
export function animateValue(opts: AnimateValueOpts): void {
  const { from, to, duration, apply } = opts;
  const ease = opts.ease ?? easeOutCubic;
  const now = opts.now ?? (() => performance.now());
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));

  if (duration <= 0 || from === to) {
    apply(to);
    return;
  }

  const start = now();
  const step = (): void => {
    const t = Math.min(1, (now() - start) / duration);
    // Snap the final frame to `to` so float easing never lands short.
    apply(t >= 1 ? to : from + (to - from) * ease(t));
    if (t < 1) raf(step);
  };
  raf(step);
}

/** Window scrollY that vertically centers an anchor in the viewport,
 *  clamped to the scrollable range. `anchorTop` is the anchor's
 *  `getBoundingClientRect().top` (viewport-relative). */
export function centerScrollTarget(
  anchorTop: number,
  anchorHeight: number,
  viewportHeight: number,
  currentScrollY: number,
  maxScrollY: number,
): number {
  const target =
    currentScrollY + anchorTop - (viewportHeight - anchorHeight) / 2;
  return Math.max(0, Math.min(target, maxScrollY));
}
