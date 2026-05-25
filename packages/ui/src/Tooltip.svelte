<script lang="ts" context="module">
  /** Svelte-context key for the ancestor-tooltip hover controls.
   *  A descendant component (e.g. a nested hover popup that gets
   *  portal'd to <body>, so the outer tooltip can't see the cursor
   *  enter it via DOM) calls `getContext(TOOLTIP_HOVER_CTX)` to get
   *  `{ cancelHide, scheduleHide }` from the nearest enclosing
   *  Tooltip and pin it open while the user interacts with the
   *  nested popup. Exported (not just a private symbol) so consumers
   *  can import the exact key without stringly-typed mismatch. */
  export const TOOLTIP_HOVER_CTX = Symbol("tooltipHover");
  export interface TooltipHoverCtx {
    cancelHide(): void;
    scheduleHide(): void;
  }
</script>

<script lang="ts">
  import { getContext, setContext } from "svelte";
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
  /** Delay before the tooltip closes after the cursor leaves both the
   *  trigger and the popup. Gives users time to slide onto the popup to
   *  read/select its contents without it vanishing under the cursor. */
  export let hideDelayMs = 200;
  export let placement: "top" | "bottom" = "bottom";
  export let onShow: () => void = () => {};
  /** `wide` raises the max-width so longer commit subjects (up to ~40ch
   *  in a 4-column grid) have room to render in full without forcing
   *  the default tooltips elsewhere to grow. */
  export let variant: "default" | "wide" = "default";
  /** When true, the popup is teleported to `<body>` via a Svelte
   *  action and positioned with `position: fixed` against the
   *  trigger's bounding rect. Use this when an ancestor of the
   *  trigger has `overflow: hidden` (which would clip the default
   *  absolutely-positioned popup). Default off so existing tooltips
   *  behave identically. */
  export let escapeClip: boolean = false;

  let open = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Trigger wrapper — used by the portal action to anchor coords. */
  let wrapEl: HTMLDivElement | null = null;

  /** Svelte action: move the popup to document.body, position it
   *  with `position: fixed` against `wrapEl`'s rect, and reposition
   *  on scroll/resize while open. Cleaned up on unmount so it can't
   *  leak across hover cycles. */
  function portal(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    document.body.appendChild(node);
    function reposition() {
      if (!wrapEl) return;
      const r = wrapEl.getBoundingClientRect();
      const margin = 6;
      node.style.position = "fixed";
      // First pass: place flush with the trigger's left + below/above
      // it. We measure the popup's natural size in this position and
      // then clamp horizontally + flip vertically below so it never
      // overflows the viewport. (Initial style writes are inside the
      // same task; the browser only paints once after we're done.)
      node.style.left = `${Math.round(r.left)}px`;
      node.style.right = "auto";
      if (placement === "top") {
        node.style.bottom = `${Math.round(window.innerHeight - r.top + margin)}px`;
        node.style.top = "auto";
      } else {
        node.style.top = `${Math.round(r.bottom + margin)}px`;
        node.style.bottom = "auto";
      }

      // Horizontal clamp. The menubar lives flush against the right
      // edge of the viewport, so a tooltip anchored to its trigger's
      // left would otherwise extend past the right edge. Prefer
      // right-alignment to the trigger when the tooltip is wider than
      // the space to the right; only after that, hard-clamp into the
      // viewport so even very wide tooltips remain fully visible.
      const tr = node.getBoundingClientRect();
      let left = r.left;
      if (left + tr.width > window.innerWidth - margin) {
        left = r.right - tr.width;
      }
      if (left + tr.width > window.innerWidth - margin) {
        left = window.innerWidth - tr.width - margin;
      }
      if (left < margin) left = margin;
      node.style.left = `${Math.round(left)}px`;

      // Vertical flip. If the requested placement would push the
      // tooltip past the viewport edge, swap to the opposite side
      // when there's more room there. Don't oscillate: only flip when
      // the chosen side genuinely won't fit.
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const wantsBottom = placement !== "top";
      const fitsBottom = tr.height <= spaceBelow;
      const fitsTop = tr.height <= spaceAbove;
      if (wantsBottom && !fitsBottom && fitsTop) {
        node.style.top = "auto";
        node.style.bottom = `${Math.round(window.innerHeight - r.top + margin)}px`;
      } else if (!wantsBottom && !fitsTop && fitsBottom) {
        node.style.bottom = "auto";
        node.style.top = `${Math.round(r.bottom + margin)}px`;
      }
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return {
      destroy() {
        window.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", reposition);
        node.remove();
      },
    };
  }

  function start() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (open) return;
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
    // TEMP DEBUG: don't auto-close on mouseleave so the tooltip stays
    // on screen for visual inspection. Toggle via ?ttkeep in the URL,
    // or remove this guard once styling work is done. Default is
    // STILL auto-close so production behaviour is unaffected.
    const keep =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("ttkeep");
    if (keep) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      open = false;
      hideTimer = null;
    }, hideDelayMs);
  }

  /** Cancel a pending hide when the cursor moves onto the popup. */
  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  const parentCtx = getContext<TooltipHoverCtx | undefined>(TOOLTIP_HOVER_CTX);

  function popupEnter() {
    cancelHide();
    parentCtx?.cancelHide();
  }
  function popupLeave() {
    stop();
    parentCtx?.scheduleHide();
  }

  setContext<TooltipHoverCtx>(TOOLTIP_HOVER_CTX, {
    cancelHide() { cancelHide(); parentCtx?.cancelHide(); },
    scheduleHide() { stop(); parentCtx?.scheduleHide(); },
  });
</script>

<!-- Both wrap and popup are `<div>`s so the content slot can carry
     block-level children (file lists, commit rows) without browsers
     hoisting them out of an inline `<span>` parent and leaving the
     popup visually empty. `display: inline-flex` keeps the wrap
     looking like a span at the layout level. -->
<div
  class="tt-wrap"
  bind:this={wrapEl}
  on:mouseenter={start}
  on:mouseleave={stop}
  on:focusin={start}
  on:focusout={stop}
  role="presentation"
>
  <slot name="trigger" />
  {#if open}
    {#if escapeClip}
      <!-- Teleported to <body> via the portal action; positioning
           switches to position:fixed so an `overflow:hidden` ancestor
           of the trigger can't clip it. -->
      <div
        class="tt tt-{placement} tt-{variant} tt-portal"
        role="tooltip"
        use:portal
        on:mouseenter={popupEnter}
        on:mouseleave={popupLeave}
      >
        <slot name="content" />
      </div>
    {:else}
      <div
        class="tt tt-{placement} tt-{variant}"
        role="tooltip"
        on:mouseenter={popupEnter}
        on:mouseleave={popupLeave}
      >
        <slot name="content" />
      </div>
    {/if}
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
    /* Receive mouse events so the cursor can slide onto the popup and
     * keep it open (the parent listens for mouseenter/mouseleave on the
     * popup itself to cancel/start the hide timer). */
    pointer-events: auto;
    /* Default to letting content wrap; consumers can override per-row.
     * Without this, the popup's `nowrap` clipped multi-line content to
     * a single ellipsis. */
    white-space: normal;
  }
  /* Wider footprint for commit-list tooltips. The previous 64rem
     ceiling was the active bottleneck once `COMMIT_SUBJECT_MAX`
     bumped to 200 chars — drop it and let viewport width be the
     only cap. `92vw` keeps the tooltip from butting against the
     right edge on small screens.
     No `min-width` here on purpose: that would also widen
     `tt-wide` tooltips whose content is shorter (e.g. the changed-
     files list), leaving big empty gutters. The commit grid sets
     its own floor — see `.wt-tt-commits` in worktree-row.css. */
  .tt-wide {
    max-width: 96vw;
  }
  .tt-bottom {
    top: calc(100% + 0.35rem);
  }
  .tt-top {
    bottom: calc(100% + 0.35rem);
  }
</style>
