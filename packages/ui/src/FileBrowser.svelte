<script lang="ts">
  import SessionHeader from "./SessionHeader.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import { getDaemonKV } from "./daemon-kv";
  import { joinPath, formatSize, formatMtime, fetchDir, type FileEntry } from "./file-browser-utils";
  import { ICONS } from "./icons";

  export let wtPath: string;
  export let source: string;
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};

  const KV_KEY = "supergit:fileBrowser:state";

  let currentDir: string = wtPath;
  let entries: FileEntry[] = [];
  let expanded: Record<string, FileEntry[]> = {};
  let loading = false;
  let error: string | null = null;
  let dirHistory: string[] = [];
  let selected: Set<string> = new Set();

  let savedExpandedPaths: string[] = [];

  function loadPersistedState() {
    try {
      const raw = getDaemonKV().getItem(KV_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const state = parsed?.[source];
      if (!state) return;
      if (typeof state.currentDir === "string") currentDir = state.currentDir;
      if (typeof state.dirHistory === "object" && Array.isArray(state.dirHistory)) {
        dirHistory = state.dirHistory.filter((x: unknown): x is string => typeof x === "string");
      }
      if (Array.isArray(state.expanded)) {
        savedExpandedPaths = state.expanded.filter((x: unknown): x is string => typeof x === "string");
      }
      if (Array.isArray(state.selected)) {
        selected = new Set(state.selected.filter((x: unknown): x is string => typeof x === "string"));
      }
    } catch {}
  }

  function persistState() {
    try {
      const raw = getDaemonKV().getItem(KV_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[source] = {
        currentDir,
        dirHistory,
        expanded: Object.keys(expanded),
        selected: [...selected],
      };
      getDaemonKV().setItem(KV_KEY, JSON.stringify(all));
    } catch {}
  }

  async function loadCurrentDir() {
    loading = true;
    error = null;
    entries = [];
    try {
      entries = await fetchDir(currentDir);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      entries = [];
    }
    loading = false;
    if (savedExpandedPaths.length > 0) {
      const toRestore = savedExpandedPaths;
      savedExpandedPaths = [];
      await restoreExpanded(toRestore);
    }
  }

  async function restoreExpanded(paths: string[]) {
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          return { path: p, children: await fetchDir(p) };
        } catch {
          return null;
        }
      }),
    );
    const next: Record<string, FileEntry[]> = { ...expanded };
    for (const r of results) {
      if (r) next[r.path] = r.children;
    }
    expanded = next;
  }

  function enterDir(name: string) {
    dirHistory = [...dirHistory, currentDir];
    currentDir = joinPath(currentDir, name);
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  function goUp() {
    if (dirHistory.length > 0) {
      currentDir = dirHistory[dirHistory.length - 1]!;
      dirHistory = dirHistory.slice(0, -1);
    } else {
      const parent = currentDir.replace(/\/[^/]+\/?$/, "");
      if (parent && parent !== currentDir) {
        currentDir = parent || "/";
      }
    }
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  async function toggleExpand(name: string, parentDir?: string) {
    const base = parentDir ?? currentDir;
    const fullPath = joinPath(base, name);
    if (expanded[fullPath]) {
      const next = { ...expanded };
      delete next[fullPath];
      expanded = next;
    } else {
      try {
        const children = await fetchDir(fullPath);
        expanded = { ...expanded, [fullPath]: children };
      } catch {}
    }
    persistState();
  }

  let lastSelectedPath: string | null = null;

  function visibleFilePaths(): string[] {
    const paths: string[] = [];
    for (const entry of entries) {
      const fp = joinPath(currentDir, entry.name);
      paths.push(fp);
      const children = expanded[fp];
      if (children) {
        for (const child of children) {
          const cp = joinPath(fp, child.name);
          paths.push(cp);
          const grandchildren = expanded[cp];
          if (grandchildren) {
            for (const gc of grandchildren) {
              paths.push(joinPath(cp, gc.name));
            }
          }
        }
      }
    }
    return paths;
  }

  function handleSelect(path: string, e: MouseEvent) {
    const metaKey = e.metaKey || e.ctrlKey;
    if (e.shiftKey && lastSelectedPath) {
      const all = visibleFilePaths();
      const a = all.indexOf(lastSelectedPath);
      const b = all.indexOf(path);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const range = all.slice(lo, hi + 1);
        const next = metaKey ? new Set(selected) : new Set<string>();
        for (const p of range) next.add(p);
        selected = next;
        persistState();
        return;
      }
    }
    if (metaKey) {
      const next = new Set(selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      selected = next;
    } else {
      selected = new Set([path]);
    }
    lastSelectedPath = path;
    persistState();
  }

  async function openFile(name: string, parentDir?: string) {
    const dir = parentDir ?? currentDir;
    const fullPath = joinPath(dir, name);
    try {
      await fetch("/api/open-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fullPath }),
      });
    } catch {}
  }

  function breadcrumbs(path: string): { name: string; path: string }[] {
    const parts = path.split("/").filter(Boolean);
    const crumbs: { name: string; path: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({
        name: parts[i]!,
        path: "/" + parts.slice(0, i + 1).join("/"),
      });
    }
    return crumbs;
  }

  function navigateTo(path: string) {
    dirHistory = [...dirHistory, currentDir];
    currentDir = path;
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  function copyPaths() {
    const text = selected.size > 0
      ? [...selected].join("\n")
      : currentDir;
    void navigator.clipboard.writeText(text).then(() => {
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copied = false; }, 1200);
    });
  }

  $: selectedNames = [...selected].map((p) => p.split("/").pop() ?? p);

  loadPersistedState();
  void loadCurrentDir();

  $: displayName = currentDir.split("/").pop() || currentDir;
</script>

<div class="session file-browser">
  <SessionHeader
    agent="files"
    agentLabel="files"
    {source}
    manualTitle={displayName}
    mode="read"
    canResume={false}
    canEnd={false}
    {onClose}
    {onDragStart}
    lastActivityFallback="{entries.length} items"
    closeTitle="Close this file browser panel."
  />

  <nav class="fb-breadcrumbs">
    <button
      class="fb-up-btn"
      on:click={goUp}
      disabled={currentDir === "/" || currentDir === wtPath}
      title="Go up one level"
    ><svg class="fb-back-tri" viewBox="0 0 8 8"><polygon points="6,1 1,4 6,7"/></svg></button>
    <div
      class="fb-path"
      role="button"
      tabindex="0"
      on:click={copyPaths}
      on:keydown={(e) => { if (e.key === "Enter") copyPaths(); }}
      title={selected.size > 0
        ? `Click to copy ${selected.size} selected path${selected.size > 1 ? "s" : ""}`
        : "Click to copy path"}
    >
      {#each breadcrumbs(currentDir) as crumb, i}
        {#if i > 0}<span class="fb-sep">/</span>{/if}
        <button
          class="fb-crumb"
          class:fb-crumb-active={i === breadcrumbs(currentDir).length - 1 && selected.size === 0}
          on:click|stopPropagation={() => navigateTo(crumb.path)}
          title={crumb.path}
        >{crumb.name}</button>
      {/each}
      {#if selectedNames.length > 0}
        <span class="fb-sep">/</span>
        <span class="fb-selected-names">
          {#each selectedNames as name, i}
            {#if i > 0}<span class="fb-sel-comma">, </span>{/if}
            <span class="fb-sel-name">{name}</span>
          {/each}
        </span>
      {/if}
      {#if copied}
        <span class="fb-copied">copied</span>
      {/if}
    </div>
  </nav>

  <div class="fb-content">
    {#if loading && entries.length === 0}
      <div class="fb-status"><LoadingSpinner size="1.2rem" /></div>
    {:else if error}
      <div class="fb-status muted small">{error}</div>
    {:else if entries.length === 0}
      <div class="fb-status muted small">Empty folder</div>
    {:else}
      <ul class="fb-list">
        {#each entries as entry (entry.name)}
          {@const fullPath = joinPath(currentDir, entry.name)}
          <li>
            <div
              class="fb-row"
              class:fb-selected={selected.has(fullPath)}
              role="button"
              tabindex="0"
              on:click={(e) => handleSelect(fullPath, e)}
              on:keydown={(e) => { if (e.key === "Enter") handleSelect(fullPath, e); }}
              on:dblclick={() => {
                if (entry.type === "directory") enterDir(entry.name);
                else openFile(entry.name);
              }}
              title={entry.type === "directory"
                ? "Click icon to expand, double-click to enter"
                : "Click to select, double-click to open"}
            >
              {#if entry.type === "directory"}
                <span
                  class="fb-arrow fb-icon-clickable"
                  role="button"
                  tabindex="-1"
                  on:click|stopPropagation={() => toggleExpand(entry.name)}
                ><svg class="fb-tri" class:fb-tri-open={expanded[fullPath]} viewBox="0 0 8 8"><polygon points="2,1 7,4 2,7"/></svg></span>
                <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.folder.paths ?? [] as d}<path {d}/>{/each}</svg></span>
              {:else}
                <span class="fb-arrow-spacer" aria-hidden="true"></span>
                <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.document.paths ?? [] as d}<path {d}/>{/each}</svg></span>
              {/if}
              <span class="fb-name">{entry.name}</span>
              <span class="fb-mtime muted">{formatMtime(entry.mtime)}</span>
              <span class="fb-size muted">{entry.type === "directory" ? "" : formatSize(entry.size)}</span>
            </div>
            {#if entry.type === "directory" && expanded[fullPath]}
              <ul class="fb-list fb-indent">
                {#each expanded[fullPath] as child (child.name)}
                  {@const childPath = joinPath(fullPath, child.name)}
                  <li>
                    <div
                      class="fb-row"
                      class:fb-selected={selected.has(childPath)}
                      role="button"
                      tabindex="0"
                      on:click={(e) => handleSelect(childPath, e)}
                      on:keydown={(e) => { if (e.key === "Enter") handleSelect(childPath, e); }}
                      on:dblclick={() => {
                        if (child.type === "directory") navigateTo(childPath);
                        else openFile(child.name, fullPath);
                      }}
                      title={child.type === "directory"
                        ? "Click icon to expand, double-click to enter"
                        : "Click to select, double-click to open"}
                    >
                      {#if child.type === "directory"}
                        <span
                          class="fb-arrow fb-icon-clickable"
                          role="button"
                          tabindex="-1"
                          on:click|stopPropagation={() => toggleExpand(child.name, fullPath)}
                        ><svg class="fb-tri" class:fb-tri-open={expanded[childPath]} viewBox="0 0 8 8"><polygon points="2,1 7,4 2,7"/></svg></span>
                        <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.folder.paths ?? [] as d}<path {d}/>{/each}</svg></span>
                      {:else}
                        <span class="fb-arrow-spacer" aria-hidden="true"></span>
                        <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.document.paths ?? [] as d}<path {d}/>{/each}</svg></span>
                      {/if}
                      <span class="fb-name">{child.name}</span>
                      <span class="fb-mtime muted">{formatMtime(child.mtime)}</span>
                      <span class="fb-size muted">{child.type === "directory" ? "" : formatSize(child.size)}</span>
                    </div>
                    {#if child.type === "directory" && expanded[childPath]}
                      <ul class="fb-list fb-indent">
                        {#each expanded[childPath] as grandchild (grandchild.name)}
                          {@const grandchildPath = joinPath(childPath, grandchild.name)}
                          <li>
                            <div
                              class="fb-row"
                              class:fb-selected={selected.has(grandchildPath)}
                              role="button"
                              tabindex="0"
                              on:click={(e) => handleSelect(grandchildPath, e)}
                              on:keydown={(e) => { if (e.key === "Enter") handleSelect(grandchildPath, e); }}
                              on:dblclick={() => {
                                if (grandchild.type === "directory") navigateTo(grandchildPath);
                                else openFile(grandchild.name, childPath);
                              }}
                              title={grandchild.type === "directory"
                                ? "Double-click to enter"
                                : "Click to select, double-click to open"}
                            >
                              {#if grandchild.type === "directory"}
                                <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.folder.paths ?? [] as d}<path {d}/>{/each}</svg></span>
                              {:else}
                                <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.document.paths ?? [] as d}<path {d}/>{/each}</svg></span>
                              {/if}
                              <span class="fb-name">{grandchild.name}</span>
                              <span class="fb-mtime muted">{formatMtime(grandchild.mtime)}</span>
                              <span class="fb-size muted">{grandchild.type === "directory" ? "" : formatSize(grandchild.size)}</span>
                            </div>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
      {#if loading}
        <div class="fb-status"><LoadingSpinner size="1.2rem" /></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .file-browser {
    position: relative;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  .fb-breadcrumbs {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0.3rem 0.6rem;
    background: color-mix(in srgb, var(--text-muted) 8%, var(--surface-1));
    border-bottom: 1px solid var(--surface-2);
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    overflow-x: auto;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .fb-up-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    padding: 0.15rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .fb-up-btn:hover:not(:disabled) {
    color: var(--text-1);
    background: var(--surface-3);
  }
  .fb-up-btn:disabled {
    opacity: 0.25;
    cursor: default;
  }
  :global(.fb-back-tri) {
    width: 0.55rem;
    height: 0.55rem;
    fill: currentColor;
  }
  .fb-sep {
    color: var(--text-faint);
  }
  .fb-crumb {
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 0.1rem 0.2rem;
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    font-family: inherit;
  }
  .fb-crumb:hover {
    color: var(--text-1);
    background: var(--surface-3);
  }
  .fb-crumb-active {
    color: var(--text-1);
    font-weight: 600;
  }
  .fb-path {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex: 1;
    min-width: 0;
    cursor: pointer;
    border-radius: var(--radius-sm);
    padding: 0.05rem 0.15rem;
  }
  .fb-path:hover {
    background: color-mix(in srgb, var(--text-muted) 8%, transparent);
  }
  .fb-selected-names {
    display: inline-flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fb-sel-name {
    color: var(--text-1);
    font-weight: 600;
  }
  .fb-sel-comma {
    color: var(--text-faint);
  }
  .fb-copied {
    color: var(--text-muted);
    font-size: 0.62rem;
    font-style: italic;
    margin-left: 0.3rem;
    flex-shrink: 0;
  }
  .fb-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    max-height: 50vh;
  }
  .fb-status {
    padding: 1rem;
    text-align: center;
  }
  .fb-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .fb-indent {
    padding-left: 1.2rem;
  }
  .fb-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.6rem;
    height: 1.45rem;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--surface-2);
    cursor: pointer;
    text-align: left;
    font-family: ui-monospace, monospace;
    box-sizing: border-box;
  }
  .fb-row:hover {
    background: color-mix(in srgb, var(--text-muted) 6%, var(--surface-1));
  }
  .fb-arrow-spacer {
    flex-shrink: 0;
    width: 0.7rem;
  }
  .fb-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 0.7rem;
    cursor: pointer;
    border-radius: 2px;
    color: var(--text-faint);
  }
  .fb-arrow:hover {
    color: var(--text-1);
    background: var(--surface-3);
  }
  :global(.fb-tri) {
    width: 0.5rem;
    height: 0.5rem;
    fill: currentColor;
    transition: transform 0.15s ease-out;
  }
  :global(.fb-tri-open) {
    transform: rotate(90deg);
  }
  .fb-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 0.85rem;
    color: var(--text-faint);
  }
  .fb-icon :global(svg) {
    width: 0.85rem;
    height: 0.85rem;
  }
  .fb-name {
    font-size: 0.72rem;
    color: var(--text-1);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fb-mtime {
    font-size: 0.62rem;
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
    text-align: right;
    min-width: 4rem;
  }
  .fb-size {
    font-size: 0.62rem;
    color: var(--text-muted);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    text-align: right;
    min-width: 4rem;
  }
  .fb-selected {
    background: color-mix(in srgb, var(--text-muted) 15%, var(--surface-1));
  }
  .fb-selected:hover {
    background: color-mix(in srgb, var(--text-muted) 22%, var(--surface-1));
  }
</style>
