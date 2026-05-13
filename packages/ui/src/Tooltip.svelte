<script lang="ts">
  /** A lightweight hover tooltip: wraps a trigger and shows a popover
   *  with rich content (slot) after a brief mouseover delay. Doesn't
   *  attempt full positioning intelligence — anchored under the
   *  trigger, with a `placement="top"` opt-in for cases where below
   *  would clip. For free-form interactive popovers, use Popover.svelte
   *  instead; this is for short, read-only hover hints.
   *
   *  `onShow` fires once per hover-cycle when the delay elapses and the
   *  tooltip opens. Use it to lazy-fetch the content the parent will
   *  render in the `content` slot. */
  export let showDelayMs = 250;
  export let placement: "top" | "bottom" = "bottom";
  export let onShow: () => void = () => {};
  /** `wide` raises the max-width so longer commit subjects (up to ~40ch
   *  in a 4-column grid) have room to render in full without forcing
   *  the default tooltips elsewhere to grow. */
  export let variant: "default" | "wide" = "default";

  let open = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function start() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      open = true;
      onShow();
    }, showDelayMs);
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    open = false;
  }
</script>

<!-- Both wrap and popup are `<div>`s so the content slot can carry
     block-level children (file lists, commit rows) without browsers
     hoisting them out of an inline `<span>` parent and leaving the
     popup visually empty. `display: inline-flex` keeps the wrap
     looking like a span at the layout level. -->
<div
  class="tt-wrap"
  on:mouseenter={start}
  on:mouseleave={stop}
  on:focusin={start}
  on:focusout={stop}
  role="presentation"
>
  <slot name="trigger" />
  {#if open}
    <div class="tt tt-{placement} tt-{variant}" role="tooltip">
      <slot name="content" />
    </div>
  {/if}
</div>

<style>
  .tt-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .tt {
    position: absolute;
    left: 0;
    /* Has to win against xterm + agent column headers below the row.
     * 50 lost to those layers in practice; 1000 keeps the tooltip on
     * top of essentially everything except modals. */
    z-index: 1000;
    min-width: 12rem;
    max-width: 28rem;
    background: var(--surface-3, #2a2a2c);
    color: var(--text-1, #e8e8e8);
    border: 1px solid var(--surface-2, #1f1f21);
    padding: 0.45rem 0.55rem;
    border-radius: var(--radius-sm, 0.35rem);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    pointer-events: none;
    /* Default to letting content wrap; consumers can override per-row.
     * Without this, the popup's `nowrap` clipped multi-line content to
     * a single ellipsis. */
    white-space: normal;
  }
  /* Wider footprint for commit-list tooltips so the 40ch subject column
     has room to render in full alongside sha/author/date. */
  .tt-wide {
    max-width: 44rem;
  }
  .tt-bottom {
    top: calc(100% + 0.35rem);
  }
  .tt-top {
    bottom: calc(100% + 0.35rem);
  }
</style>
