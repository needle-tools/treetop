<script lang="ts">
  /**
   * Single-pill summary of a worktree's git state. Used wherever we
   * want the same look-and-feel for ahead / behind / dirty signals —
   * folded row-heads (priority-picked single pill) AND expanded rows
   * (multiple pills, one StatusBadge call per signal). Same component
   * everywhere so the edge-flow streak + heartbeat pulsate stay in
   * sync across surfaces.
   *
   * Priority when more than one count is non-zero is implemented in
   * the pure helper `./status-badge.ts` (testable without DOM).
   *
   * When all three counts are zero, renders nothing.
   */

  import { pickBadgeKind } from "./status-badge";

  export let ahead = 0;
  export let behind = 0;
  /** staged + unstaged + untracked file count. */
  export let dirty = 0;
  /** Layer the heartbeat-blink animation on top of the (push only) edge
   *  flow. Wired up to real state via `aheadAged()` for unpushed commits
   *  older than BLINK_AHEAD_MINUTES; previewable with the `?pulsate=1`
   *  debug param in App.svelte. No-op for behind / dirty. */
  export let pulsate = false;
  /** When set, the badge renders as a button and clicking it invokes
   *  this callback. Used by the worktree row to wire the ↑ badge to
   *  push and the ↓ badge to pull. Default null = plain decorative
   *  span (used by `?badgeanim=1` debug previews and anywhere else
   *  that just wants the look). */
  export let onClick: ((e: MouseEvent) => void) | null = null;
  /** Optional native title= for the button — surfaces a quick action
   *  hint (e.g. "Push 2 commits to origin/main") even when the wider
   *  Tooltip wrapper isn't open. */
  export let title = "";
  /** When true and the badge is clickable, swap the ↑N / ↓N label for
   *  an inline spinner and disable the button. Used to gate
   *  double-clicks while a pull/push request is in flight. */
  export let busy = false;
  /** Escalate the dirty badge to yellow (>3 files or >200 lines). */
  export let warn = false;

  $: kind = pickBadgeKind(ahead, behind, dirty);
  $: clickable = onClick !== null;
</script>

{#if kind === "ahead"}
  {#if clickable}
    <button
      type="button"
      class="status-badge status-badge-ahead status-badge-clickable"
      class:pulsate={pulsate && !busy}
      aria-label={title}
      disabled={busy}
      on:click={(e) => { e.stopPropagation(); onClick?.(e); }}
    >{#if busy}<span class="status-badge-spinner" aria-label="pushing"></span>{:else}<svg class="status-badge-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M6 2L2.5 5.5M6 2l3.5 3.5"/></svg>{ahead}{/if}</button>
  {:else}
    <span class="status-badge status-badge-ahead" class:pulsate><svg class="status-badge-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10V2M6 2L2.5 5.5M6 2l3.5 3.5"/></svg>{ahead}</span>
  {/if}
{:else if kind === "behind"}
  {#if clickable}
    <button
      type="button"
      class="status-badge status-badge-behind status-badge-clickable"
      aria-label={title}
      disabled={busy}
      on:click={(e) => { e.stopPropagation(); onClick?.(e); }}
    >{#if busy}<span class="status-badge-spinner" aria-label="pulling"></span>{:else}<svg class="status-badge-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M6 10l-3.5-3.5M6 10l3.5-3.5"/></svg>{behind}{/if}</button>
  {:else}
    <span class="status-badge status-badge-behind"><svg class="status-badge-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M6 10l-3.5-3.5M6 10l3.5-3.5"/></svg>{behind}</span>
  {/if}
{:else if kind === "dirty"}
  <span class="status-badge" class:status-badge-dirty={!warn} class:status-badge-dirty-warn={warn}><svg class="status-badge-arrow" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6c1.5-2.5 5-2.5 8 0"/></svg>{dirty}</span>
{/if}

<!-- Styles live globally in packages/ui/src/styles/worktree-row.css so
     consumers don't need any extra wiring. -->
