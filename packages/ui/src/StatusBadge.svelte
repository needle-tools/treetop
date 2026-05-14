<script lang="ts">
  /**
   * Single-pill summary of a worktree's git state. Used wherever we
   * want the same look-and-feel for ahead / behind / dirty signals —
   * folded row-heads (priority-picked single pill) AND expanded rows
   * (multiple pills, one StatusBadge call per signal). Same component
   * everywhere so the edge-flow streak + heartbeat pulsate stay in
   * sync across surfaces.
   *
   * Priority when more than one count is non-zero:
   *     1. unpushed commits  ↑N  green (can pulsate — "ready to push")
   *     2. behind upstream   ↓N  orange ("pull or merge")
   *     3. dirty workdir     ~N  grey  ("uncommitted changes")
   *
   * Callers that want both ahead AND behind visible (expanded view)
   * render two StatusBadge instances, each with only one count set.
   *
   * When all three are zero, renders nothing.
   */

  export let ahead = 0;
  export let behind = 0;
  /** staged + unstaged + untracked file count. */
  export let dirty = 0;
  /** Layer the heartbeat-blink animation on top of the (push only) edge
   *  flow. Wired up to real state via `aheadAged()` for unpushed commits
   *  older than BLINK_AHEAD_MINUTES; previewable with the `?pulsate=1`
   *  debug param in App.svelte. No-op for behind / dirty. */
  export let pulsate = false;
</script>

{#if ahead > 0}
  <span class="status-badge status-badge-ahead" class:pulsate>↑{ahead}</span>
{:else if behind > 0}
  <span class="status-badge status-badge-behind">↓{behind}</span>
{:else if dirty > 0}
  <span class="status-badge status-badge-dirty">~{dirty}</span>
{/if}

<!-- Styles live globally in packages/ui/src/styles/worktree-row.css so
     consumers don't need any extra wiring. -->
