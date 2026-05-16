<script lang="ts">
  /**
   * Animated "zZZ" trail rendered inside the agent pill when a TUI
   * column is idle. Three z spans share a single conveyor animation
   * with three resting positions (A → B → C → out). The spans are
   * phase-offset by 1/3 of the cycle (via negative animation-delay)
   * so on first paint one z already sits at each position — the
   * trail reads as a complete "zZZ" immediately instead of building
   * up over the first cycle.
   *
   * Each z grows in scale as it travels A → B → C, so the trail
   * visually fans out: small z near the badge, larger Z further out.
   *
   * Inherits `color` from its parent via currentColor; the consumer
   * (SessionHeader's `.sleep-z`) sets it to `var(--agent-color)` so
   * the trail matches the agent's brand colour.
   *
   * `visible` gates the animation. When false the slot still
   * reserves layout — only the children's opacity collapses — so
   * toggling working↔idle never reflows the pill width.
   */
  export let visible: boolean = true;
</script>

<span class="sleep-z" class:visible aria-hidden={!visible}>
  <span class="z" aria-hidden="true">z</span>
  <span class="z" aria-hidden="true">z</span>
</span>

<style>
  .sleep-z {
    position: relative;
    display: inline-block;
    /* Reserve one z-glyph of horizontal space so the pill width is
       identical whether the trail is visible or not. The animated
       z's themselves overflow this slot upward and to the right. */
    width: 0.7em;
    height: 1em;
    /* Vertically centre on the surrounding text line — when this
       component is dropped inline alongside other text, the trail's
       resting position lines up with the text middle instead of the
       baseline. */
    vertical-align: middle;
    color: currentColor;
    pointer-events: none;
    overflow: visible;
  }
  .sleep-z .z {
    position: absolute;
    left: 0;
    /* Anchor each z at the slot's vertical centre rather than its
       baseline. `top: 50%` lands the z's top edge at the centre, and
       the negative `margin-top` (in the z's own font-size units —
       line-height is 1 so half of font-size is exactly the right
       offset) shifts it up by half its own height. Using margin
       instead of `translateY(-50%)` keeps the transform property
       free for the animation. */
    top: 50%;
    margin-top: -0.5em;
    font-family: ui-monospace, monospace;
    font-style: italic;
    font-weight: 600;
    font-size: 0.9em;
    line-height: 1;
    opacity: 0;
    transform-origin: 0% 50%;
    will-change: transform, opacity;
  }
  /* Two z's share the keyframe at phase offsets 0% / 50% (via a
     negative animation-delay), so the second z is always half a
     cycle behind the first — the trail reads as a steady "zZ" pair
     with breathing room between them. Per-segment timing functions
     inside the @keyframes block ease each leg of the path so the
     four waypoints blend into a smooth S-curve sway rather than a
     polyline. */
  .sleep-z.visible .z {
    animation: sleep-z-conveyor 3.6s infinite;
  }
  .sleep-z .z:nth-child(2) {
    animation-delay: -1.8s;
  }
  /* Y rises monotonically while X zig-zags right → left → right on
     the way up. Rotation leans in the OPPOSITE direction of travel
     (counter-banking) so the z reads as relaxed/lazy rather than
     leaning into its motion. Per-keyframe `animation-timing-function`
     applies ease-in-out to each segment, blending the four waypoints
     into a smooth S-curve sway rather than a polyline of straight
     legs — the z visibly follows a curve through the air. */
  @keyframes sleep-z-conveyor {
    0% {
      transform: translate(0, 0) rotate(8deg) scale(0.45);
      opacity: 0;
      animation-timing-function: ease-out;
    }
    12% {
      opacity: 0.95;
      animation-timing-function: ease-in-out;
    }
    33% {
      transform: translate(0.7em, -0.3em) rotate(-10deg) scale(0.75);
      animation-timing-function: ease-in-out;
    }
    66% {
      transform: translate(-0.15em, -1.6em) rotate(10deg) scale(1);
      animation-timing-function: ease-in-out;
    }
    85% {
      opacity: 0.55;
      animation-timing-function: ease-in;
    }
    100% {
      transform: translate(1.2em, -2.4em) rotate(-14deg) scale(1.3);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sleep-z.visible .z {
      animation: none;
    }
    /* Static fallback: a single z resting at the start, no motion. */
    .sleep-z.visible .z:nth-child(1) {
      opacity: 0.85;
    }
    .sleep-z.visible .z:nth-child(2) {
      opacity: 0;
    }
  }
</style>
