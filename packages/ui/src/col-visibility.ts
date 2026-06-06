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

/** Pure decision: an off-screen (non-intersecting) column should pause. */
export function shouldPauseColumn(isIntersecting: boolean): boolean {
  return !isIntersecting;
}

export function colVisibility(node: HTMLElement) {
  if (typeof IntersectionObserver === "undefined") return {};
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        node.classList.toggle(
          COL_OFFSCREEN_CLASS,
          shouldPauseColumn(entry.isIntersecting),
        );
      }
    },
    // A generous margin pre-activates a column just before it scrolls into
    // view, so its animations are already running when the user sees it
    // (no pop-in). threshold 0: any sliver visible counts as on-screen.
    { root: null, rootMargin: "300px", threshold: 0 },
  );
  io.observe(node);
  return {
    destroy() {
      io.disconnect();
    },
  };
}
