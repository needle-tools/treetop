<script lang="ts">
  import { apiUrl } from "./api";
  import ChangedFilesTooltipBody from "./ChangedFilesTooltipBody.svelte";
  import Tooltip from "./Tooltip.svelte";

  interface CommitFileStat {
    path: string;
    added: number;
    removed: number;
    binary: boolean;
  }

  export let worktreePath: string;
  export let sha: string;
  export let daemonId: string | undefined = undefined;

  let state: "idle" | "loading" | "ready" | "error" = "idle";
  let rows: CommitFileStat[] = [];

  $: void load(worktreePath, sha);

  async function load(wt: string, commitSha: string): Promise<void> {
    if (!wt || !commitSha) return;
    state = "loading";
    rows = [];
    try {
      const qs = new URLSearchParams({ path: wt, sha: commitSha });
      const res = await fetch(
        apiUrl(`/api/commit-files?${qs.toString()}`, daemonId),
      );
      if (!res.ok) {
        state = "error";
        return;
      }
      const data = (await res.json()) as CommitFileStat[];
      if (wt !== worktreePath || commitSha !== sha) return;
      rows = data;
      state = "ready";
    } catch {
      state = "error";
    }
  }

  function basename(path: string): string {
    return path.split(/[\\/]/).pop() || path;
  }

  $: totalAdded = rows.reduce((sum, row) => sum + row.added, 0);
  $: totalRemoved = rows.reduce((sum, row) => sum + row.removed, 0);
  $: binaryCount = rows.filter((row) => row.binary).length;
  $: summary =
    rows.length === 1
      ? `${basename(rows[0]!.path)}`
      : `${rows.length} files`;
  $: commitSummary = {
    staged: [] as string[],
    unstaged: rows.map((row) => row.path),
    untracked: [] as string[],
    stats: Object.fromEntries(rows.map((row) => [row.path, row])),
  };
</script>

{#if state === "loading"}
  <span class="commit-file-toolbar commit-file-toolbar-loading">
    <span class="popover-spinner" aria-label="Loading changed files"></span>
  </span>
{:else if state === "ready" && rows.length > 0}
  <span class="commit-file-toolbar">
    <Tooltip variant="wide">
      <span slot="trigger" class="commit-file-summary" title="Changed files">
        <span class="commit-file-summary-text">{summary}</span>
        {#if totalAdded > 0}
          <span class="commit-file-added">+{totalAdded}</span>
        {/if}
        {#if totalRemoved > 0}
          <span class="commit-file-removed">−{totalRemoved}</span>
        {/if}
        {#if binaryCount > 0}
          <span class="commit-file-bin">{binaryCount} bin</span>
        {/if}
      </span>
      <span slot="content" class="commit-file-changes-tooltip">
        <ChangedFilesTooltipBody
          summary={commitSummary}
          {worktreePath}
          {daemonId}
          {sha}
          labels={{ unstaged: "changed" }}
          layout="tree"
        />
      </span>
    </Tooltip>
  </span>
{/if}

<style>
  .commit-file-toolbar {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    min-width: 0;
  }
  .commit-file-toolbar-loading {
    min-width: 1rem;
  }
  .commit-file-summary {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    min-width: 0;
    max-width: 18rem;
    padding: 0.03rem 0.25rem 0.08rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--text-1, #e8e8e8) 8%, transparent);
    color: var(--text-2);
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    line-height: 1.2;
    cursor: default;
    white-space: nowrap;
  }
  .commit-file-summary:hover {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-1, #e8e8e8) 13%, transparent);
  }
  .commit-file-summary-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .commit-file-added,
  .commit-file-removed,
  .commit-file-bin {
    flex: 0 0 auto;
    font-family: ui-monospace, monospace;
    font-size: 0.66rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .commit-file-added {
    color: var(--status-clean, #5bbf76);
  }
  .commit-file-removed {
    color: var(--error-text, #ffaaaa);
  }
  .commit-file-bin,
  .commit-file-changes-tooltip {
    color: var(--text-3);
  }
  .commit-file-changes-tooltip {
    display: block;
    min-width: min(28rem, 86vw);
  }
</style>
