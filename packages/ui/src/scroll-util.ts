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

export interface ScrollSnapshotEntry {
  el: HTMLElement;
  scrollTop: number;
  scrollLeft: number;
}

/**
 * Capture scroll offsets for one or more nested scroll containers before a
 * disclosure/layout mutation. Restoring the snapshot keeps a click-to-expand
 * interaction from being interpreted as permission to yank the reader to a
 * different part of the transcript.
 */
export function captureScrollSnapshot(
  elements: readonly (HTMLElement | null | undefined)[],
): ScrollSnapshotEntry[] {
  const seen = new Set<HTMLElement>();
  const out: ScrollSnapshotEntry[] = [];
  for (const el of elements) {
    if (!el || seen.has(el)) continue;
    seen.add(el);
    out.push({
      el,
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
    });
  }
  return out;
}

export function restoreScrollSnapshot(
  snapshot: readonly ScrollSnapshotEntry[],
): void {
  for (const entry of snapshot) {
    if (!entry.el.isConnected) continue;
    entry.el.scrollTop = entry.scrollTop;
    entry.el.scrollLeft = entry.scrollLeft;
  }
}

export interface StickScrollerToBottomOpts {
  /** How long to keep following delayed content growth. */
  durationMs?: number;
  raf?: (cb: () => void) => number;
  cancelRaf?: (id: number) => void;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
  ResizeObserver?: typeof ResizeObserver;
  MutationObserver?: typeof MutationObserver;
}

const activeTailSticks = new WeakMap<HTMLElement, () => void>();

/**
 * Temporarily park a scroll container at its tail while late content
 * hydrates. Used when a session column is revealed/focused: markdown,
 * images, and async transcript hydration can add or resize children after
 * the initial "go to bottom" frame.
 *
 * The helper stops when the user clearly takes over via wheel/touch/pointer
 * or when `durationMs` elapses.
 */
export function stickScrollerToBottom(
  scroller: HTMLElement,
  opts: StickScrollerToBottomOpts = {},
): () => void {
  activeTailSticks.get(scroller)?.();

  const raf =
    opts.raf ??
    ((cb: () => void) =>
      requestAnimationFrame(() => {
        cb();
      }));
  const cancelRaf = opts.cancelRaf ?? cancelAnimationFrame;
  const setTimer = opts.setTimeout ?? setTimeout;
  const clearTimer = opts.clearTimeout ?? clearTimeout;
  const ResizeObserverCtor = opts.ResizeObserver ?? globalThis.ResizeObserver;
  const MutationObserverCtor =
    opts.MutationObserver ?? globalThis.MutationObserver;
  const durationMs = opts.durationMs ?? 4000;

  let done = false;
  let rafId = 0;
  const observed = new WeakSet<Element>();

  const stick = () => {
    if (done || rafId) return;
    rafId = raf(() => {
      rafId = 0;
      if (done) return;
      scroller.scrollTop = 1_000_000_000;
    });
  };

  const ro = ResizeObserverCtor
    ? new ResizeObserverCtor(() => {
        stick();
      })
    : null;

  const observeElement = (el: Element) => {
    if (!ro || observed.has(el)) return;
    observed.add(el);
    ro.observe(el);
  };

  const observeChildren = () => {
    observeElement(scroller);
    for (const child of Array.from(scroller.children)) observeElement(child);
  };

  observeChildren();

  const mo = MutationObserverCtor
    ? new MutationObserverCtor(() => {
        observeChildren();
        stick();
      })
    : null;
  mo?.observe(scroller, { childList: true, subtree: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (done) return;
    done = true;
    if (rafId) cancelRaf(rafId);
    ro?.disconnect();
    mo?.disconnect();
    if (timer !== undefined) clearTimer(timer);
    scroller.removeEventListener("wheel", stop, true);
    scroller.removeEventListener("touchstart", stop, true);
    scroller.removeEventListener("pointerdown", stop, true);
    scroller.removeEventListener("keydown", stop, true);
    if (activeTailSticks.get(scroller) === stop) activeTailSticks.delete(scroller);
  };

  timer = setTimer(stop, durationMs);
  activeTailSticks.set(scroller, stop);
  scroller.addEventListener("wheel", stop, { capture: true, passive: true });
  scroller.addEventListener("touchstart", stop, { capture: true, passive: true });
  scroller.addEventListener("pointerdown", stop, true);
  scroller.addEventListener("keydown", stop, true);
  stick();
  return stop;
}
