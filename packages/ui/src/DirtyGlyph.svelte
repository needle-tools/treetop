<script lang="ts">
  /**
   * The dirty-status tilde (`~`) plus its rocking wave, shown in the
   * SessionDock's push/pull/dirty arrow rows. The motion is intentional — the
   * dock is always on screen and the wiggle draws attention to uncommitted
   * work.
   *
   * Technique: a SMIL `<animate>` that morphs the path geometry (the humps
   * rock up↔down). NOT a CSS `d:` keyframe — CSS `d` only interpolates in
   * Chromium; in electrobun's WKWebView (WebKit, macOS) it freezes. SMIL
   * morphs in both engines.
   *
   * Perf history (see plans/performance.md): we briefly replaced this morph
   * with a composited `translateX` scroll, thinking the per-frame geometry
   * repaint was a major renderer cost. Tracing with the F8 debug panel proved
   * otherwise — the real cost (Layerize 54%) was a layer tree bloated by an
   * always-running invisible dock-spinner promoting every idle dot. Gating
   * that spinner dropped Layerize to ~5%. With the tree small, this morph's
   * marginal cost is just a little Paint that scales with the number of
   * visible dirty sessions — affordable for normal dirty counts — so we kept
   * the nicer rock. If you ever have dozens of dirty repos on screen at once
   * and Paint climbs, the composited alternative is documented in the perf
   * notes.
   *
   * Lives in its own component because SMIL has no reduced-motion gate (so we
   * omit the <animate> in JS), and keeping <animate> out of the large
   * SessionDock template sidesteps a svelte2tsx parse quirk.
   */
  import { onMount } from "svelte";
  import { GIT_DIRTY } from "./icons";

  let reduceMotion = false;
  let mq: MediaQueryList | null = null;
  const onChange = () => {
    reduceMotion = mq?.matches ?? false;
  };
  onMount(() => {
    mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion = mq.matches;
    mq.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  });
</script>

<svg class="dirty-glyph" viewBox="0 0 12 12" aria-hidden="true"
  ><path d={GIT_DIRTY}
    >{#if !reduceMotion}<animate
        attributeName="d"
        dur="3s"
        repeatCount="indefinite"
        calcMode="spline"
        keyTimes="0;0.05;0.1;0.15;0.2;1"
        keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
        values="M2 6c1-2 3-2 4 0s3 2 4 0;M2 6c1 2 3 2 4 0s3 -2 4 0;M2 6c1-2 3-2 4 0s3 2 4 0;M2 6c1 2 3 2 4 0s3 -2 4 0;M2 6c1-2 3-2 4 0s3 2 4 0;M2 6c1-2 3-2 4 0s3 2 4 0"
      ></animate>{/if}</path
  ></svg
>

<style>
  /* Mirrors SessionDock's `.dock-arrow-glyph` so the dirty tilde matches the
     ↑/↓ arrows: 12px, repo-coloured stroke (inherits `--arrow-color` from the
     dock's arrow row through the DOM; falls back to muted), no fill. */
  .dirty-glyph {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
    fill: none;
    stroke: var(--arrow-color, var(--text-muted, #9a9aa0));
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
