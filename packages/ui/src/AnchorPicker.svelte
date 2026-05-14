<script lang="ts">
  /**
   * A list of "every anchorable place in this workspace" — one row per
   * worktree, plus one per repo that has no worktrees. Renders as a
   * `.agents-list` of `.agent-row`s so it slots into the existing
   * popover visual language (sessions picker, worktree picker, etc.)
   * without inventing a parallel one.
   *
   * Pure presentational: dispatches `pick: { anchor }` on selection
   * and `cancel: void` on Esc/close. The parent decides whether to
   * wrap it in `<Popover variant="agents">` (StickyNote edit mode)
   * or render it inline (orphan-notes tray, which is already inside
   * a popover and would otherwise nest).
   */
  import { createEventDispatcher } from "svelte";

  interface Worktree {
    path: string;
    branch: string;
  }
  interface Repo {
    id: string;
    name?: string;
    path: string;
    worktrees?: Worktree[];
  }

  export let repos: Repo[] = [];
  export let currentAnchor: string | null = null;

  const dispatch = createEventDispatcher<{
    pick: { anchor: string };
    cancel: void;
  }>();

  function repoLabel(r: Repo): string {
    return r.name ?? r.path.split("/").filter(Boolean).pop() ?? r.path;
  }
</script>

<ul class="agents-list anchor-list">
  {#each repos as repo (repo.id)}
    {#if repo.worktrees && repo.worktrees.length > 0}
      {#each repo.worktrees as wt (wt.path)}
        {@const anchor = `worktree:${wt.path}`}
        <li>
          <button
            type="button"
            class="agent-row anchor-row"
            class:dimmed={anchor === currentAnchor}
            disabled={anchor === currentAnchor}
            on:click={() => dispatch("pick", { anchor })}
            title={wt.path}
          >
            <span class="agent-row-name">{repoLabel(repo)}</span>
            <span class="agent-title">{wt.branch}</span>
            {#if anchor === currentAnchor}
              <span class="anchor-here">(here)</span>
            {/if}
          </button>
        </li>
      {/each}
    {:else}
      {@const anchor = `repo:${repo.path}`}
      <li>
        <button
          type="button"
          class="agent-row anchor-row"
          class:dimmed={anchor === currentAnchor}
          disabled={anchor === currentAnchor}
          on:click={() => dispatch("pick", { anchor })}
          title={repo.path}
        >
          <span class="agent-row-name">{repoLabel(repo)}</span>
          <span class="agent-title muted">(no worktrees)</span>
          {#if anchor === currentAnchor}
            <span class="anchor-here">(here)</span>
          {/if}
        </button>
      </li>
    {/if}
  {/each}
  {#if repos.length === 0}
    <li class="anchor-picker-empty muted">No repos registered.</li>
  {/if}
</ul>
