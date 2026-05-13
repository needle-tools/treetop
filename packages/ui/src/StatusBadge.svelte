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

  /** Build a single tooltip listing every non-zero state, not just the
   *  one we render as the badge. A folded row with ↑2 and 3 dirty
   *  files shouldn't hide the dirty count behind "expand to see" —
   *  the user wants the full picture on hover.
   *
   *  Plain `$:` reactive with explicit named deps (rather than the
   *  earlier IIFE form) so Svelte's static-analysis dependency
   *  tracker definitely re-runs this when the counts change. */
  function buildTitle(a: number, b: number, d: number): string {
    const lines: string[] = [];
    if (a > 0)
      lines.push(`${a} unpushed commit${a === 1 ? "" : "s"} (push pending)`);
    if (b > 0)
      lines.push(`${b} commit${b === 1 ? "" : "s"} behind upstream (pull / rebase)`);
    if (d > 0)
      lines.push(`${d} uncommitted change${d === 1 ? "" : "s"} in working tree`);
    if (lines.length === 0) return "";
    lines.push("");
    lines.push("Click the row chevron to expand for full details.");
    return lines.join("\n");
  }
  $: fullTitle = buildTitle(ahead, behind, dirty);
</script>

{#if ahead > 0}
  <span class="status-badge status-badge-ahead" title={fullTitle}>↑{ahead}</span>
{:else if behind > 0}
  <span class="status-badge status-badge-behind" title={fullTitle}>↓{behind}</span>
{:else if dirty > 0}
  <span class="status-badge status-badge-dirty" title={fullTitle}>~{dirty}</span>
{/if}

<!-- Styles live globally in packages/ui/src/styles/worktree-row.css so
     consumers don't need any extra wiring. -->
