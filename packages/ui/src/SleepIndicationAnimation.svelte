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
  <span class="z" aria-hidden="true">z</span>
</span>

<style>
  .sleep-z {
    position: relative;
    display: inline-block;
    /* Reserve one z-glyph of horizontal space so the pill width is
       identical whether the trail is visible or not. The animated
       z's themselves overflow this slot upward and to the right. */
    width: 0.55em;
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
    font-size: 0.7em;
    line-height: 1;
    opacity: 0;
    transform-origin: 0% 50%;
    will-change: transform, opacity;
  }
  /* One continuous linear translation from the badge out to the
     fade-away point, with rotate + scale interpolated alongside.
     Three z's share the keyframe at phase offsets 0% / 33% / 66%
     (via negative animation-delays), so each z is always within
     ~1/3 of a cycle behind its predecessor — the trail reads as a
     constant "zZZ" with smooth, uniform motion rather than the
     previous stop-go conveyor. */
  .sleep-z.visible .z {
    animation: sleep-z-conveyor 3.6s linear infinite;
  }
  .sleep-z .z:nth-child(2) {
    animation-delay: -1.2s;
  }
  .sleep-z .z:nth-child(3) {
    animation-delay: -2.4s;
  }
  /* Travel further along the Y axis than the X axis — gives the
     trail a steeper, more "rising sleep" angle (~63°) instead of
     the previous 45°. The total path length (~2.7em) is also longer
     than before, which means the 33%-phase spacing between
     consecutive z's grows past one z's font-size — so the three
     z's now read as a clear stack with breathing room, not an
     overlapping smear. */
  @keyframes sleep-z-conveyor {
    0% {
      transform: translate(0, 0) rotate(-6deg) scale(0.45);
      opacity: 0;
    }
    12% {
      opacity: 0.95;
    }
    85% {
      opacity: 0.55;
    }
    100% {
      transform: translate(1.2em, -2.4em) rotate(14deg) scale(1.3);
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
    .sleep-z.visible .z:nth-child(2),
    .sleep-z.visible .z:nth-child(3) {
      opacity: 0;
    }
  }
</style>
