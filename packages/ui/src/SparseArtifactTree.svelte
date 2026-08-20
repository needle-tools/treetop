<script lang="ts">
  import Diff from "./Diff.svelte";
  import DiffLoader from "./DiffLoader.svelte";
  import Tooltip from "./Tooltip.svelte";
  import ToolIcon from "./ToolIcon.svelte";
  import type {
    VisualWorkArtifact,
    VisualWorkArtifactChange,
  } from "./last-user-message";

  export let artifacts: readonly VisualWorkArtifact[] = [];
  export let worktreePath: string | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let sha: string | undefined = undefined;
  export let diffFallback: "none" | "git" = "none";
  export let onOpenPath:
    | ((artifact: VisualWorkArtifact, event: MouseEvent) => void)
    | undefined = undefined;

  interface TreeNode {
    id: string;
    label: string;
    path: string;
    hrefPath: string;
    depth: number;
    kind: "folder" | "file" | "other";
    artifacts: VisualWorkArtifact[];
  }

  let cachedSignature = "";
  let cachedRows: TreeNode[] = [];

  function stripRange(path: string): string {
    return path.trim().replace(/:\d+(?:-\d+)?$/, "");
  }

  function normalizePath(path: string | undefined): string {
    if (!path) return "";
    return stripRange(path).replace(/\\/g, "/").replace(/\/+/g, "/");
  }

  function normalizedWorktreePath(): string {
    return normalizePath(worktreePath).replace(/\/$/, "");
  }

  function displayPathForArtifact(path: string): string {
    const clean = normalizePath(path);
    const root = normalizedWorktreePath();
    if (!root) return clean;
    if (clean === root) return ".";
    return clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
  }

  function isInsideWorktree(path: string): boolean {
    const clean = normalizePath(path);
    const root = normalizedWorktreePath();
    return !!root && (clean === root || clean.startsWith(`${root}/`));
  }

  function artifactLabel(artifact: VisualWorkArtifact): string {
    return artifact.label || normalizePath(artifact.path) || "artifact";
  }

  function artifactSignature(values: readonly VisualWorkArtifact[]): string {
    return values
      .map((artifact) =>
        [
          artifact.id,
          artifact.action,
          artifact.kind,
          normalizePath(artifact.path),
          artifact.label,
          artifact.additions ?? "",
          artifact.deletions ?? "",
          artifact.diff ?? "",
          ...(artifact.changes ?? []).map((change) =>
            [
              change.action,
              normalizePath(change.path),
              change.label,
              change.additions ?? "",
              change.deletions ?? "",
              change.diff ?? "",
            ].join("\u0003"),
          ),
        ].join("\u0001"),
      )
      .join("\u0002");
  }

  function buildRows(values: readonly VisualWorkArtifact[]): TreeNode[] {
    const fileArtifacts = values.filter((artifact) => artifact.path);
    const rows = new Map<string, TreeNode>();
    const ordered: TreeNode[] = [];

    function addRow(row: TreeNode): TreeNode {
      const existing = rows.get(row.id);
      if (existing) return existing;
      rows.set(row.id, row);
      ordered.push(row);
      return row;
    }

    for (const artifact of fileArtifacts) {
      const clean = normalizePath(artifact.path);
      const displayPath = displayPathForArtifact(clean);
      const displayParts = displayPath.split("/").filter(Boolean);
      let currentPath = "";
      displayParts.slice(0, -1).forEach((part, index) => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        addRow({
          id: `folder:${currentPath}`,
          label: part,
          path: currentPath,
          hrefPath: currentPath,
          depth: index,
          kind: "folder",
          artifacts: [],
        });
      });
      const fileLabel =
        displayParts[displayParts.length - 1] ?? artifactLabel(artifact);
      const filePath = clean || artifact.path!;
      const hrefPath = isInsideWorktree(filePath) ? displayPath : filePath;
      const fileRow = addRow({
        id: `file:${filePath}`,
        label: fileLabel,
        path: filePath,
        hrefPath,
        depth: Math.max(0, displayParts.length - 1),
        kind: artifact.kind === "image" ? "file" : "file",
        artifacts: [],
      });
      fileRow.artifacts.push(artifact);
    }

    for (const artifact of values.filter((value) => !value.path)) {
      addRow({
        id: artifact.id,
        label: artifactLabel(artifact),
        path: artifact.label,
        hrefPath: artifact.label,
        depth: 0,
        kind: "other",
        artifacts: [artifact],
      });
    }

    return ordered;
  }

  function stableRows(values: readonly VisualWorkArtifact[]): TreeNode[] {
    const signature = artifactSignature(values);
    if (signature === cachedSignature) return cachedRows;
    cachedSignature = signature;
    cachedRows = buildRows(values);
    return cachedRows;
  }

  function actionLabel(action: VisualWorkArtifact["action"]): string {
    if (action === "changed") return "write";
    if (action === "produced") return "created";
    return "read";
  }

  function artifactChanges(
    artifact: VisualWorkArtifact,
  ): VisualWorkArtifactChange[] {
    return artifact.changes && artifact.changes.length > 0
      ? artifact.changes
      : [
          {
            action: artifact.action,
            label: artifact.label,
            path: artifact.path,
            title: artifact.title,
            additions: artifact.additions,
            deletions: artifact.deletions,
            diff: artifact.diff,
            diffKind: artifact.diffKind,
          },
        ];
  }

  function rowChanges(row: TreeNode): VisualWorkArtifactChange[] {
    return row.artifacts.flatMap(artifactChanges);
  }

  function rowDiffChanges(row: TreeNode): VisualWorkArtifactChange[] {
    return rowChanges(row).filter((change) => change.diff !== undefined);
  }

  function changeLabel(
    change: VisualWorkArtifactChange,
    index: number,
  ): string {
    const parts = [`Change ${index + 1}`];
    if (change.additions !== undefined || change.deletions !== undefined) {
      parts.push(`+${change.additions ?? 0} −${change.deletions ?? 0}`);
    } else {
      parts.push(actionLabel(change.action));
    }
    return parts.join(" · ");
  }

  function artifactRange(
    artifact: VisualWorkArtifact | VisualWorkArtifactChange,
  ): string | undefined {
    const value = `${artifact.label} ${artifact.path ?? ""}`;
    const match = value.match(/:(\d+(?:-\d+)?)\b/);
    return match?.[1];
  }

  function uniqueStrings(values: Array<string | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
  }

  function rowActionSummary(row: TreeNode):
    | { kind: "changed"; additions?: number; deletions?: number }
    | { kind: "range"; label: string }
    | { kind: "action"; labels: string[] } {
    const changes = rowChanges(row);
    const changed = changes.filter((change) => change.action === "changed");
    if (changed.length > 0) {
      const additions = changed.reduce(
        (sum, change) => sum + (change.additions ?? 0),
        0,
      );
      const deletions = changed.reduce(
        (sum, change) => sum + (change.deletions ?? 0),
        0,
      );
      return {
        kind: "changed",
        additions: changed.some((change) => change.additions !== undefined)
          ? additions
          : undefined,
        deletions: changed.some((change) => change.deletions !== undefined)
          ? deletions
          : undefined,
      };
    }
    const ranges = uniqueStrings(changes.map(artifactRange));
    if (ranges.length > 0) {
      return {
        kind: "range",
        label: ranges.length === 1 ? ranges[0]! : `${ranges.length} ranges`,
      };
    }
    return {
      kind: "action",
      labels: uniqueStrings(
        changes.map((change) => actionLabel(change.action)),
      ),
    };
  }

  function rowIconName(row: TreeNode): string {
    if (row.kind === "folder") return "list_directory";
    if (row.artifacts.some((artifact) => artifact.kind === "image")) {
      return "image_generation_call";
    }
    if (row.artifacts.some((artifact) => artifact.action === "changed")) {
      return "apply_patch";
    }
    if (row.artifacts.some((artifact) => artifact.action === "produced")) {
      return "filesystem_create";
    }
    return "read_file";
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
          <ToolIcon name={rowIconName(row)} />
        </span>
        {#if row.kind === "file" && row.artifacts[0]}
          {@const artifact = row.artifacts[0]}
          {@const diffChanges = rowDiffChanges(row)}
          {@const gitDiffKind = row.artifacts.find((item) => item.diffKind)?.diffKind}
          {#if diffChanges.length > 0 || (diffFallback === "git" && gitDiffKind && worktreePath)}
            <Tooltip variant="wide" escapeClip>
              <button
                slot="trigger"
                type="button"
                class="sparse-artifact-name"
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
                  <Diff text={change.diff ?? ""} />
                {:else if diffChanges.length > 1}
                  <span class="sparse-artifact-change-chain">
                    {#each diffChanges as change, index}
                      <span class="sparse-artifact-change">
                        <span class="sparse-artifact-change-label">
                          {changeLabel(change, index)}
                        </span>
                        <Diff text={change.diff ?? ""} />
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
                  />
                {/if}
              </span>
            </Tooltip>
          {:else}
            <button
              type="button"
              class="sparse-artifact-name"
              data-supergit-session-cwd={worktreePath}
              data-supergit-daemon-id={daemonId}
              data-supergit-file-href={row.hrefPath}
              on:click={(event) => onOpenPath?.(artifact, event)}
            >
              {row.label}
            </button>
          {/if}
          {@const actionSummary = rowActionSummary(row)}
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
                <span class="sparse-artifact-action changed">write</span>
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
  button.sparse-artifact-name {
    cursor: pointer;
  }
  button.sparse-artifact-name:hover {
    color: var(--text-1);
    text-decoration: underline;
    text-decoration-thickness: 1px;
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
