<script lang="ts">
  /**
   * Shared shell for every dashboard popover. Two anchorings:
   *
   * - `variant="actions"` — header-bar buttons, anchored top-right of the
   *   triggering button. Fixed 380px width, max-height 520px. Used for
   *   Recent actions, Events/Errors, TUIs overview.
   *
   * - `variant="agents"` — worktree-row buttons, anchored top-left of the
   *   triggering button. max-content width, capped at min(250ch, 90vw).
   *   Used for branch picker, new-agent picker, sessions picker, wt picker.
   *
   * Per-variant width / padding overrides come from extra classes the
   * caller passes via `extraClass` (e.g. `extraClass="events-popover"`).
   * That keeps the variant-specific selectors valid (the global selectors
   * like `.events-popover .popover-head` still resolve correctly).
   *
   * Clamping is applied unconditionally — overlap with the viewport edge
   * is always wrong. Pass `unclamped` to skip it if you really need to.
   *
   * Optional `head` slot for the popover heading (sticky-styled by the
   * legacy `.popover-head` rule via the `popover-head` class).
   */
  import { clampToViewport } from "./popover";

  export let variant: "actions" | "agents";
  export let extraClass = "";
  /** Extra class on the head wrapper — composes alongside `.popover-head`
   *  for variants that already had a second class (e.g.
   *  `branch-popover-head`, `events-popover .popover-head` overrides). */
  export let headClass = "";
  export let unclamped = false;
  /** Forwarded to the root element so callers can style or anchor on it. */
  export let id: string | undefined = undefined;

  $: rootClass =
    `${variant === "actions" ? "actions-popover" : "agents-popover"} ${extraClass}`.trim();
  $: headClassFull = `popover-head ${headClass}`.trim();
</script>

{#if unclamped}
  <div class={rootClass} {id} role="menu">
    {#if $$slots.head}
      <div class={headClassFull}>
        <slot name="head" />
      </div>
    {/if}
    <slot />
  </div>
{:else}
  <div class={rootClass} {id} role="menu" use:clampToViewport>
    {#if $$slots.head}
      <div class={headClassFull}>
        <slot name="head" />
      </div>
    {/if}
    <slot />
  </div>
{/if}

<!-- Styles live in packages/ui/src/styles/popover.css (imported from
     main.ts). Keeping shared component CSS in a global stylesheet
     avoids Svelte's per-component scope hashing — `extraClass`-based
     variant rules can target the Popover root directly without needing
     :global() wrappers in every caller. -->
