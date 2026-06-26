/**
 * `use:colVisibility` — pause + DE-PROMOTE a session column's animations while
 * it's scrolled off-screen.
 *
 * Why: each session column header carries always-on animations (the agent
 * "working" glow, the idle "zZZ" sleep trail). An always-running animation
 * auto-promotes its element to a compositor layer, and `Layerize` walks the
 * entire layer tree — on- AND off-screen — every frame. With a wall of working
 * agents, the off-screen pills add 0 paint but bloat that walk, which a trace
 * showed dominating renderer CPU under load (plans/performance.md, round 3).
 *
 * Toggling `.col-offscreen` lets base.css apply `animation: none` to the
 * column's descendants. We use `none` (not `animation-play-state: paused` like
 * the tab-hidden / ui-idle gates) on purpose: `paused` stops the per-frame
 * work but keeps the element composited, so the Layerize walk wouldn't shrink.
 * `none` removes the auto-promotion → the layer leaves the tree.
 *
 * Mirrors App.svelte's existing `rowVisibility` action for worktree rows.
 */

export const COL_OFFSCREEN_CLASS = "col-offscreen";
export const VISIBILITY_ROOT_MARGIN_PX = 300;

interface OffscreenClassTarget {
  classList: {
    add: (name: string) => void;
    toggle: (name: string, force?: boolean) => boolean;
  };
}

/** Pessimistically de-promote animations before IntersectionObserver's first
 * async callback. The observer immediately removes this class again for
 * actually visible nodes, but offscreen restored columns/rows don't get one
 * critical first-frame layerization pass with every animation alive. */
export function markOffscreenUntilMeasured(
  node: OffscreenClassTarget,
  className: string,
): void {
  node.classList.add(className);
}

export function syncOffscreenClass(
  node: OffscreenClassTarget,
  className: string,
  isIntersecting: boolean,
): void {
  node.classList.toggle(className, !isIntersecting);
}

/** Pure decision: an off-screen (non-intersecting) column should pause. */
export function shouldPauseColumn(isIntersecting: boolean): boolean {
  return !isIntersecting;
}

export function rectNearViewport(
  rect: Pick<DOMRect, "top" | "bottom" | "left" | "right">,
  viewport: { width: number; height: number },
  marginPx = VISIBILITY_ROOT_MARGIN_PX,
): boolean {
  return (
    rect.bottom >= -marginPx &&
    rect.top <= viewport.height + marginPx &&
    rect.right >= -marginPx &&
    rect.left <= viewport.width + marginPx
  );
}

export function elementNearViewport(
  node: HTMLElement,
  viewport: { width: number; height: number } = {
    width: window.innerWidth,
    height: window.innerHeight,
  },
): boolean {
  return rectNearViewport(node.getBoundingClientRect(), viewport);
}

export function colVisibility(node: HTMLElement) {
  if (typeof IntersectionObserver === "undefined") return {};
  markOffscreenUntilMeasured(node, COL_OFFSCREEN_CLASS);
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        syncOffscreenClass(node, COL_OFFSCREEN_CLASS, entry.isIntersecting);
      }
    },
    // A generous margin pre-activates a column just before it scrolls into
    // view, so its animations are already running when the user sees it
    // (no pop-in). threshold 0: any sliver visible counts as on-screen.
    { root: null, rootMargin: `${VISIBILITY_ROOT_MARGIN_PX}px`, threshold: 0 },
  );
  io.observe(node);
  return {
    destroy() {
      io.disconnect();
    },
  };
}
