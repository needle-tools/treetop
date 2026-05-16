<script lang="ts">
  /**
   * Reusable loading-spinner glyph — the small rotating ring used
   * throughout the dashboard (`loading repos…` on the empty App
   * shell, `loading session…` in SessionView, `starting terminal…`
   * in TerminalView, etc.).
   *
   * Renders as an inline span sized by the caller. Border ring uses
   * `currentColor`, so the spinner adopts whatever text-colour the
   * parent has — no need to thread brand colour as a prop. Animates
   * via a single keyframe in this component's scoped style block.
   *
   * Other call sites that still inline their own `.spinner` class
   * (App.svelte's `.loading-overlay .spinner`, SessionView's
   * `.spinner` block, SessionHeader's same) can be folded onto this
   * component as a follow-up; out of scope for this turn.
   */
  /** CSS size string for the spinner's bounding box (width AND
   *  height). Pass any CSS length — `"14px"`, `"0.85rem"`, `"1em"`. */
  export let size: string = "0.85rem";
  /** Stroke thickness of the ring. Defaults to 2px which matches
   *  the existing `.loading-overlay .spinner` look across the app. */
  export let thickness: string = "2px";
  /** Assistive-tech label so screen readers announce the spinner
   *  rather than silently skipping it. */
  export let label: string = "Loading";
</script>

<span
  class="loading-spinner"
  style="width: {size}; height: {size}; border-width: {thickness};"
  role="status"
  aria-label={label}
></span>

<style>
  /* Same look as App.svelte's `.loading-overlay .spinner`:
     transparent-ish base ring with a solid `currentColor` cap that
     rotates. Inline-block so it sits next to text without forcing
     a line break; flex-shrink:0 so it survives a tight flex
     parent. */
  .loading-spinner {
    display: inline-block;
    border-style: solid;
    border-color: color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: loading-spinner-spin 0.6s linear infinite;
    flex-shrink: 0;
    vertical-align: middle;
  }
  @keyframes loading-spinner-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
