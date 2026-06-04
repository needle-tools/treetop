<script lang="ts">
  /**
   * The dirty-status tilde (`~`) plus its rocking wave, as shown in the
   * SessionDock's push/pull/dirty arrow rows.
   *
   * The wave is a SMIL <animate> that morphs the path geometry — NOT a CSS
   * `d:` keyframe. CSS `d` only interpolates in Chromium; supergit ships in
   * electrobun's WKWebView (WebKit) on macOS, where a CSS `d:` animation is
   * ignored and the glyph sits frozen (it animates on Windows because that
   * is WebView2 / Chromium). SMIL morphs in both engines, so the original
   * flowing wave works everywhere.
   *
   * It lives in its own component for two reasons: SMIL has no reduced-motion
   * gate (so we omit <animate> in JS here), and keeping the <animate> element
   * out of the large SessionDock template sidesteps a svelte2tsx parse quirk.
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
        dur="1.83s"
        repeatCount="indefinite"
        calcMode="spline"
        keyTimes="0;0.765;0.874;0.891;1"
        keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
        values="M2 6c1-2 3-2 4 0s3 2 4 0;M2 6c1-2 3-2 4 0s3 2 4 0;M2 6c1 2 3 2 4 0s3 -2 4 0;M2 6c1 2 3 2 4 0s3 -2 4 0;M2 6c1-2 3-2 4 0s3 2 4 0"
      ></animate>{/if}</path
  ></svg
>

<style>
  /* Mirrors SessionDock's `.dock-arrow-glyph` so the dirty tilde matches the
     ↑/↓ arrows: 12px, repo-coloured stroke (inherits `--arrow-color` from the
     dock's arrow row through the DOM; falls back to muted), no fill. The
     dirty glyph only renders when there's no ahead/behind arrow, so it's
     never a sibling of one — no sibling-margin rule needed here. */
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
