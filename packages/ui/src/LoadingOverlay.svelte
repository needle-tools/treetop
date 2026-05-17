<script lang="ts">
  /**
   * Chrome-free centred loading status used in both TerminalView's
   * "starting terminal…" state and SessionView's "loading session…"
   * read-mode state. Renders a spinner glyph next to a short label,
   * absolutely positioned inside the nearest `position: relative`
   * ancestor and nudged up by one line height so it sits comfortably
   * above the optical centre.
   *
   * No background, border, or shadow — reads as inline text on
   * whatever surface it overlays. Call sites that need an error
   * callout (or any other chrome) should render their own variant
   * rather than extending this one.
   */
  export let text: string = "Loading…";
</script>

<div class="loading-overlay" role="status" aria-live="polite">
  <span class="loading-overlay-spinner" aria-hidden="true"></span>
  <span>{text}</span>
</div>

<style>
  .loading-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, calc(-50% - 1lh));
    z-index: 2;
    color: var(--text-1);
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: 0;
    box-shadow: none;
    padding: 0;
  }
  .loading-overlay-spinner {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: loading-overlay-spin 0.6s linear infinite;
  }
  @keyframes loading-overlay-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading-overlay-spinner {
      animation: none;
    }
  }
</style>
