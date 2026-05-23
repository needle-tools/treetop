<script lang="ts">
  import { ICONS } from "./icons";
  import { joinPath, formatSize, formatMtime, type FileEntry } from "./file-browser-utils";
  import Tooltip from "./Tooltip.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";

  export let entry: FileEntry;
  export let parentDir: string;
  export let expanded: Record<string, FileEntry[]>;
  export let selected: Set<string>;
  export let copiedPaths: Set<string>;
  export let gitStatusByDir: Record<string, Map<string, string>>;
  export let showDotfiles: boolean;
  export let wtPath: string;
  export let onSelect: (path: string, e: MouseEvent) => void;
  export let onDblClick: (path: string, type: string) => void;
  export let onToggleExpand: (name: string, parentDir: string) => void;

  $: fullPath = joinPath(parentDir, entry.name);
  $: isExpanded = !!expanded[fullPath];
  $: children = isExpanded
    ? (expanded[fullPath] ?? []).filter((e) => showDotfiles || !e.name.startsWith("."))
    : [];
  $: myGitStatus = gitStatusByDir[parentDir]?.get(entry.name);
  $: isDir = entry.type === "directory";

  // --- File diff tooltip (for git badge on files) ---
  let diffText: string | null = null;
  let diffLoading = false;

  function relPath(): string {
    if (!fullPath.startsWith(wtPath)) return entry.name;
    const rel = fullPath.slice(wtPath.length);
    return rel.startsWith("/") ? rel.slice(1) : rel;
  }

  function diffKind(): string {
    if (myGitStatus === "??" || myGitStatus === "?") return "untracked";
    const x = (myGitStatus ?? "")[0];
    if (x && x !== "." && x !== " " && x !== "?") return "staged";
    return "workdir";
  }

  async function fetchDiffForKind(file: string, kind: string): Promise<string> {
    const res = await fetch(
      `/api/file-diff?path=${encodeURIComponent(wtPath)}&file=${encodeURIComponent(file)}&kind=${kind}&context=3`,
    );
    return res.ok ? await res.text() : "";
  }

  async function loadFileDiff() {
    if (diffText !== null || diffLoading) return;
    diffLoading = true;
    try {
      const file = relPath();
      const primary = diffKind();
      let text = await fetchDiffForKind(file, primary);
      if (!text && primary !== "workdir") text = await fetchDiffForKind(file, "workdir");
      if (!text && primary !== "staged") text = await fetchDiffForKind(file, "staged");
      if (!text && primary !== "untracked") text = await fetchDiffForKind(file, "untracked");
      diffText = text || "";
    } catch {
      diffText = "(failed to load diff)";
    }
    diffLoading = false;
  }

  // --- Folder stats tooltip (for directories with changes) ---
  interface FolderStat { path: string; added: number; removed: number; status: string }
  let folderStats: FolderStat[] | null = null;
  let folderStatsLoading = false;

  async function loadFolderStats() {
    if (folderStats !== null || folderStatsLoading) return;
    folderStatsLoading = true;
    try {
      const res = await fetch(
        `/api/folder-stats?wt=${encodeURIComponent(wtPath)}&folder=${encodeURIComponent(fullPath)}`,
      );
      if (res.ok) {
        const data = await res.json();
        folderStats = data.files ?? [];
      } else {
        folderStats = [];
      }
    } catch {
      folderStats = [];
    }
    folderStatsLoading = false;
  }
</script>

<li>
  <div
    class="fb-row"
    class:fb-selected={selected.has(fullPath)}
    role="button"
    tabindex="0"
    on:click={(e) => onSelect(fullPath, e)}
    on:keydown={(e) => { if (e.key === "Enter") onSelect(fullPath, e); }}
    on:dblclick={() => onDblClick(fullPath, entry.type)}
  >
    {#if isDir}
      <span
        class="fb-arrow fb-icon-clickable"
        role="button"
        tabindex="-1"
        on:click|stopPropagation={() => onToggleExpand(entry.name, parentDir)}
      ><svg class="fb-tri" class:fb-tri-open={isExpanded} viewBox="0 0 8 8"><polygon points="2,1 7,4 2,7"/></svg></span>
      <Tooltip variant="wide" placement="bottom" showDelayMs={400} onShow={loadFolderStats} escapeClip>
        <span slot="trigger" class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.folder.paths ?? [] as d}<path {d}/>{/each}</svg></span>
        <div slot="content" class="fb-git-tooltip">
          {#if folderStatsLoading}
            <LoadingSpinner size="0.9rem" />
          {:else if folderStats !== null && folderStats.length > 0}
            <div class="fb-folder-stats">
              {#each folderStats as f}
                <div class="fb-folder-stat-row">
                  <span class="fb-folder-stat-file">{f.path}</span>
                  {#if f.status === "?"}
                    <span class="fb-stat-new">new</span>
                  {:else}
                    {#if f.added > 0}<span class="fb-stat-add">+{f.added}</span>{/if}
                    {#if f.removed > 0}<span class="fb-stat-rm">-{f.removed}</span>{/if}
                  {/if}
                </div>
              {/each}
            </div>
          {:else if folderStats !== null}
            <span class="muted small">No changes in this folder</span>
          {/if}
        </div>
      </Tooltip>
    {:else}
      <span class="fb-arrow-spacer" aria-hidden="true"></span>
      <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.document.paths ?? [] as d}<path {d}/>{/each}</svg></span>
    {/if}
    <span class="fb-name">{entry.name}</span>
    {#if copiedPaths.has(fullPath)}<span class="fb-copied-hint">copied</span>{/if}
    {#if myGitStatus && !isDir}
      <Tooltip variant="wide" placement="bottom" showDelayMs={300} onShow={loadFileDiff} escapeClip>
        <span slot="trigger" class="fb-git">{myGitStatus}</span>
        <div slot="content" class="fb-git-tooltip">
          {#if diffLoading}
            <LoadingSpinner size="0.9rem" />
          {:else if diffText !== null}
            {#if diffText.length > 0}
              <pre class="fb-git-diff">{diffText}</pre>
            {:else}
              <span class="muted small">No changes to show</span>
            {/if}
          {/if}
        </div>
      </Tooltip>
    {:else if myGitStatus && isDir}
      <span class="fb-git">{myGitStatus}</span>
    {/if}
    <span class="fb-mtime muted">{formatMtime(entry.mtime)}</span>
    <span class="fb-size muted">{isDir ? "" : formatSize(entry.size)}</span>
  </div>
  {#if isDir && isExpanded && children.length > 0}
    <ul class="fb-list fb-indent">
      {#each children as child (child.name)}
        <svelte:self
          entry={child}
          parentDir={fullPath}
          {expanded}
          {selected}
          {copiedPaths}
          {gitStatusByDir}
          {showDotfiles}
          {wtPath}
          {onSelect}
          {onDblClick}
          {onToggleExpand}
        />
      {/each}
    </ul>
  {/if}
</li>
