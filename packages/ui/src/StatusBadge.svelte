<script lang="ts">
  /**
   * Single-pill summary of a worktree's git state. Used in the folded
   * row-head where there's only horizontal room for one badge, and
   * picks the highest-priority signal:
   *
   *     1. unpushed commits  ↑N  green (pulses — "ready to push")
   *     2. behind upstream   ↓N  orange ("pull or merge")
   *     3. dirty workdir     ~N  grey  ("uncommitted changes")
   *
   * When all three are zero, renders nothing.
   *
   * Designed as a tiny reusable primitive — the styles live in
   * `styles/worktree-row.css` so other surfaces can use it later.
   */

  export let ahead = 0;
  export let behind = 0;
  /** staged + unstaged + untracked file count. */
  export let dirty = 0;
</script>

{#if ahead > 0}
  <span class="status-badge status-badge-ahead">↑{ahead}</span>
{:else if behind > 0}
  <span class="status-badge status-badge-behind">↓{behind}</span>
{:else if dirty > 0}
  <span class="status-badge status-badge-dirty">~{dirty}</span>
{/if}

<!-- Styles live globally in packages/ui/src/styles/worktree-row.css so
     consumers don't need any extra wiring. -->
