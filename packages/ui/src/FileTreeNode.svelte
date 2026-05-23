<script lang="ts">
  import { ICONS } from "./icons";
  import { joinPath, formatSize, formatMtime, type FileEntry } from "./file-browser-utils";

  export let entry: FileEntry;
  export let parentDir: string;
  export let expanded: Record<string, FileEntry[]>;
  export let selected: Set<string>;
  export let copiedPaths: Set<string>;
  export let gitStatusByDir: Record<string, Map<string, string>>;
  export let showDotfiles: boolean;
  export let onSelect: (path: string, e: MouseEvent) => void;
  export let onDblClick: (path: string, type: string) => void;
  export let onToggleExpand: (name: string, parentDir: string) => void;

  $: fullPath = joinPath(parentDir, entry.name);
  $: isExpanded = !!expanded[fullPath];
  $: children = isExpanded
    ? (expanded[fullPath] ?? []).filter((e) => showDotfiles || !e.name.startsWith("."))
    : [];
  $: myGitStatus = gitStatusByDir[parentDir]?.get(entry.name);
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
    title={entry.type === "directory"
      ? "Click icon to expand, double-click to enter"
      : "Click to select, double-click to open"}
  >
    {#if entry.type === "directory"}
      <span
        class="fb-arrow fb-icon-clickable"
        role="button"
        tabindex="-1"
        on:click|stopPropagation={() => onToggleExpand(entry.name, parentDir)}
      ><svg class="fb-tri" class:fb-tri-open={isExpanded} viewBox="0 0 8 8"><polygon points="2,1 7,4 2,7"/></svg></span>
      <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.folder.paths ?? [] as d}<path {d}/>{/each}</svg></span>
    {:else}
      <span class="fb-arrow-spacer" aria-hidden="true"></span>
      <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.document.paths ?? [] as d}<path {d}/>{/each}</svg></span>
    {/if}
    <span class="fb-name">{entry.name}</span>
    {#if copiedPaths.has(fullPath)}<span class="fb-copied-hint">copied</span>{/if}
    {#if myGitStatus}<span class="fb-git">{myGitStatus}</span>{/if}
    <span class="fb-mtime muted">{formatMtime(entry.mtime)}</span>
    <span class="fb-size muted">{entry.type === "directory" ? "" : formatSize(entry.size)}</span>
  </div>
  {#if entry.type === "directory" && isExpanded && children.length > 0}
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
          {onSelect}
          {onDblClick}
          {onToggleExpand}
        />
      {/each}
    </ul>
  {/if}
</li>
