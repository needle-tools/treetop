<script lang="ts">
  import Diff from "./Diff.svelte";
  import DiffLoader from "./DiffLoader.svelte";
  import FileSystemIcon from "./FileSystemIcon.svelte";
  import Tooltip from "./Tooltip.svelte";
  import type {
    VisualWorkArtifact,
    VisualWorkArtifactChange,
  } from "./last-user-message";
  import {
    buildSparseArtifactRows,
    sparseArtifactRowActionSummary,
    sparseArtifactRowDiffChanges,
    sparseArtifactRowLifecycle,
    sparseArtifactSignature,
    type SparseArtifactTreeRow,
  } from "./sparse-artifact-tree";

  export let artifacts: readonly VisualWorkArtifact[] = [];
  export let worktreePath: string | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let sha: string | undefined = undefined;
  export let diffFallback: "none" | "git" = "none";
  export let onOpenPath:
    | ((artifact: VisualWorkArtifact, event: MouseEvent) => void)
    | undefined = undefined;

  let cachedSignature = "";
  let cachedRows: SparseArtifactTreeRow[] = [];

  function stableRows(
    values: readonly VisualWorkArtifact[],
  ): SparseArtifactTreeRow[] {
    const signature = sparseArtifactSignature(values, worktreePath);
    if (signature === cachedSignature) return cachedRows;
    cachedSignature = signature;
    cachedRows = buildSparseArtifactRows(values, worktreePath);
    return cachedRows;
  }

  function changeLabel(
    change: VisualWorkArtifactChange,
    index: number,
  ): string {
    const parts = [`Change ${index + 1}`];
    if (change.additions !== undefined || change.deletions !== undefined) {
      parts.push(`+${change.additions ?? 0} −${change.deletions ?? 0}`);
    } else {
      parts.push(
        change.fileAction === "added"
          ? "created"
          : change.fileAction === "deleted"
            ? "deleted"
            : change.action === "changed"
              ? "write"
              : change.action === "produced"
                ? "created"
                : "read",
      );
    }
    return parts.join(" · ");
  }

  $: rows = stableRows(artifacts);
</script>

{#if rows.length > 0}
  <div class="sparse-artifact-tree">
    {#each rows as row (row.id)}
      <div
        class="sparse-artifact-row"
        class:folder={row.kind === "folder"}
        class:file={row.kind === "file"}
        style={`--artifact-depth: ${row.depth}`}
      >
        <span class="sparse-artifact-indent" aria-hidden="true"></span>
        <span class="sparse-artifact-icon" aria-hidden="true">
          <FileSystemIcon kind={row.kind === "folder" ? "folder" : "file"} />
        </span>
        {#if row.artifacts[0]}
          {@const artifact = row.artifacts[0]}
          {@const lifecycle = sparseArtifactRowLifecycle(row)}
          {@const diffChanges = sparseArtifactRowDiffChanges(row)}
          {@const gitDiffKind = row.artifacts.find((item) => item.diffKind)?.diffKind}
          {#if row.kind === "file" && (diffChanges.length > 0 || (diffFallback === "git" && gitDiffKind && worktreePath))}
            <Tooltip variant="wide" escapeClip>
              <button
                slot="trigger"
                type="button"
                class="sparse-artifact-name"
                class:created={lifecycle === "added"}
                class:deleted={lifecycle === "deleted"}
                data-supergit-session-cwd={worktreePath}
                data-supergit-daemon-id={daemonId}
                data-supergit-file-href={row.hrefPath}
                on:click={(event) => onOpenPath?.(artifact, event)}
              >
                {row.label}
              </button>
              <span slot="content" class="sparse-artifact-diff">
                {#if diffChanges.length === 1}
                  {@const change = diffChanges[0]}
                  <Diff text={change.diff ?? ""} hideSingleFileHeader />
                {:else if diffChanges.length > 1}
                  <span class="sparse-artifact-change-chain">
                    {#each diffChanges as change, index}
                      <span class="sparse-artifact-change">
                        <span class="sparse-artifact-change-label">
                          {changeLabel(change, index)}
                        </span>
                        <Diff text={change.diff ?? ""} hideSingleFileHeader />
                      </span>
                    {/each}
                  </span>
                {:else if diffFallback === "git" && gitDiffKind && worktreePath}
                  <DiffLoader
                    {worktreePath}
                    file={row.hrefPath}
                    kind={gitDiffKind}
                    {sha}
                    {daemonId}
                    hideSingleFileHeader
                  />
                {/if}
              </span>
            </Tooltip>
          {:else}
            <button
              type="button"
              class="sparse-artifact-name"
              class:created={lifecycle === "added"}
              class:deleted={lifecycle === "deleted"}
              data-supergit-session-cwd={worktreePath}
              data-supergit-daemon-id={daemonId}
              data-supergit-file-href={row.hrefPath}
              on:click={(event) => onOpenPath?.(artifact, event)}
            >
              {row.label}
            </button>
          {/if}
          {@const actionSummary = sparseArtifactRowActionSummary(row)}
          <span class="sparse-artifact-actions">
            {#if actionSummary.kind === "changed"}
              {#if actionSummary.additions !== undefined}
                <span class="sparse-artifact-action changed">
                  +{actionSummary.additions}
                </span>
              {/if}
              {#if actionSummary.deletions !== undefined}
                <span class="sparse-artifact-action removed">
                  −{actionSummary.deletions}
                </span>
              {/if}
              {#if actionSummary.additions === undefined && actionSummary.deletions === undefined}
                <span
                  class="sparse-artifact-action"
                  class:changed={actionSummary.fallbackLabel === "+" ||
                    actionSummary.fallbackLabel === "write"}
                  class:removed={actionSummary.fallbackLabel === "-"}
                >
                  {actionSummary.fallbackLabel}
                </span>
              {/if}
              {#if actionSummary.rangeLabel}
                <span class="sparse-artifact-action">
                  {actionSummary.rangeLabel}
                </span>
              {/if}
            {:else if actionSummary.kind === "range"}
              <span class="sparse-artifact-action">{actionSummary.label}</span>
            {:else}
              {#each actionSummary.labels as label}
                <span class="sparse-artifact-action">{label}</span>
              {/each}
            {/if}
          </span>
        {:else}
          <span class="sparse-artifact-name muted">{row.label}</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .sparse-artifact-tree {
    display: grid;
    gap: 0.08rem;
    min-width: 0;
  }
  .sparse-artifact-row {
    display: grid;
    grid-template-columns: calc(var(--artifact-depth, 0) * 0.78rem) auto minmax(
        0,
        1fr
      ) auto;
    align-items: center;
    gap: 0.22rem;
    min-width: 0;
    color: var(--text-muted);
    font-size: 0.74rem;
    line-height: 1.35;
    padding: 2px 0;
  }
  .sparse-artifact-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.78;
  }
  .sparse-artifact-name {
    min-width: 0;
    width: fit-content;
    max-width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sparse-artifact-name.created {
    color: var(--success, #58d68d);
  }
  .sparse-artifact-name.deleted {
    color: #ff8a8a;
  }
  button.sparse-artifact-name {
    cursor: pointer;
    padding: 0;
  }
  button.sparse-artifact-name:hover {
    color: var(--text-1);
    text-decoration: underline;
    text-decoration-thickness: 1px;
  }
  button.sparse-artifact-name.created:hover {
    color: var(--success, #58d68d);
  }
  button.sparse-artifact-name.deleted:hover {
    color: #ff8a8a;
  }
  .sparse-artifact-actions {
    display: inline-flex;
    gap: 0.18rem;
    min-width: 0;
  }
  .sparse-artifact-action {
    color: var(--text-muted);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }
  .sparse-artifact-action.changed {
    color: var(--success, #58d68d);
  }
  .sparse-artifact-action.removed {
    color: #ff8a8a;
  }
  .sparse-artifact-diff {
    display: grid;
    gap: 0.28rem;
    max-width: min(42rem, 76vw);
  }
  .sparse-artifact-change-chain,
  .sparse-artifact-change {
    display: grid;
    gap: 0.32rem;
  }
  .sparse-artifact-change {
    padding-top: 0.08rem;
  }
  .sparse-artifact-change + .sparse-artifact-change {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-top: 0.44rem;
  }
  .sparse-artifact-change-label {
    color: var(--text-muted);
    font-family: var(--mono-font, monospace);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }
  .sparse-artifact-empty {
    color: var(--text-muted);
    font-size: 0.72rem;
    font-style: italic;
  }
</style>
