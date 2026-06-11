/**
 * Shared "is the page scrolling right now?" signal. One capture-phase scroll
 * listener for the whole app (so it sees the session strip, the sticky-note
 * canvas, and any nested scroller). Consumers poll `msSinceScroll()` to DEFER
 * expensive, visibility-driven work until the user stops scrolling.
 *
 * Motivating case: clicking a session-dock item scrolls the strip to a column.
 * `TerminalView`'s IntersectionObserver then fires for every column that
 * crosses the viewport during that scroll, and each attach/detach of the xterm
 * WebGL renderer re-measures + re-renders every row — a ~200ms task on the DOM
 * fallback (a trace, 2026-06-11, showed an 8-task burst of 100–283ms). Gating
 * the renderer switch on scroll-quiescence collapses that burst into a single
 * reconcile once the strip lands.
 */

/** How long the page must be scroll-quiet before deferred work runs. */
export const SCROLL_QUIET_MS = 300;

let lastScrollMs = -Infinity;

if (typeof window !== "undefined") {
  // Capture phase + passive: we only observe, and we want scrolls on nested
  // containers (the strip, note canvas) too, not just the document.
  window.addEventListener(
    "scroll",
    () => {
      lastScrollMs = Date.now();
    },
    { capture: true, passive: true },
  );
}

/** Milliseconds since the last scroll anywhere on the page. Effectively
 *  Infinity before anything has scrolled. */
export function msSinceScroll(): number {
  return Date.now() - lastScrollMs;
}
