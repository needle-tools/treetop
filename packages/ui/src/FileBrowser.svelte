<script lang="ts">
  import SessionHeader from "./SessionHeader.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import { getDaemonKV } from "./daemon-kv";
  import { onDestroy } from "svelte";
  import { joinPath, formatSize, formatMtime, fetchDir, fetchRemoteDir, fetchGitStatus, NavHistory, StarStore, breadcrumbs, normalizePath, computeStarredList, splitParent, type FileEntry, openRemoteFile, fetchSshHome, fetchSshStatus, confirmRemoteUpload, dismissRemoteUpload } from "./file-browser-utils";
  import { ICONS } from "./icons";
  import FileTreeNode from "./FileTreeNode.svelte";
  import type { SessionMenuItem } from "./SessionMenu.svelte";

  export let wtPath: string;
  export let source: string;
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};
  /** When set, this file browser shows a remote filesystem via SSH. */
  export let remoteTermId: string | null = null;
  /** Remote cwd from the terminal — file browser follows when followTerminal is true. */
  export let remoteCwd: string | null = null;
  /** Callback to focus/scroll to the terminal that spawned this remote browser. */
  export let onFocusTerminal: (() => void) | undefined = undefined;

  $: isRemote = !!remoteTermId;
  let followTerminal = true;
  let remoteHome = "/";

  $: if (followTerminal && remoteCwd && resolvedRemoteCwd !== currentDir) {
    doFollowNav(resolvedRemoteCwd);
  }

  $: resolvedRemoteCwd = remoteCwd
    ? remoteCwd === "~" ? remoteHome
    : remoteCwd.startsWith("~/") ? remoteHome + "/" + remoteCwd.slice(2)
    : remoteCwd
    : null;

  function doFollowNav(path: string | null) {
    if (!path || path === currentDir) return;
    nav.push(path);
    currentDir = path;
    navTick++;
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  function toggleFollow() {
    followTerminal = !followTerminal;
    if (followTerminal && resolvedRemoteCwd && resolvedRemoteCwd !== currentDir) {
      doFollowNav(resolvedRemoteCwd);
    }
  }

  const KV_KEY = "supergit:fileBrowser:state";

  let nav = new NavHistory(wtPath);
  let navTick = 0;
  let currentDir: string = wtPath;
  let entries: FileEntry[] = [];
  let expanded: Record<string, FileEntry[]> = {};
  let loading = false;
  let error: string | null = null;
  let selected: Set<string> = new Set();
  let showDotfiles = true;
  let gitStatusByDir: Record<string, Map<string, string>> = {};
  const starStore = new StarStore(getDaemonKV(), "supergit:fileBrowser:stars");
  let starred: Set<string> = starStore.load();
  let starredOnly = false;

  function toggleStar(path: string) {
    starred = starStore.toggle(starred, path);
  }
  function toggleStarredOnly() {
    starredOnly = !starredOnly;
  }

  /** Tracked remote files with sync state (modified/uploading/etc). */
  let syncFiles: { remotePath: string; localCachePath: string; state: string; error?: string }[] = [];
  let syncPollTimer: ReturnType<typeof setInterval> | null = null;

  function startSyncPolling() {
    if (!remoteTermId || syncPollTimer) return;
    const poll = async () => {
      syncFiles = await fetchSshStatus(remoteTermId!);
      if (syncFiles.length > 0 && entries.length > 0) {
        entries = entries.map((e) => {
          const remoteFull = currentDir.endsWith("/")
            ? currentDir + e.name : currentDir + "/" + e.name;
          const s = syncFiles.find((f) => f.remotePath === remoteFull);
          return s ? { ...e, sync: s.state } : e.sync ? { ...e, sync: undefined } : e;
        });
      }
    };
    void poll();
    syncPollTimer = setInterval(poll, 2000);
  }

  function stopSyncPolling() {
    if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  }

  $: if (isRemote && remoteTermId) startSyncPolling();
  onDestroy(stopSyncPolling);

  /** Get sync state for a file by its full remote path. */
  function syncStateFor(remotePath: string): { state: string; localCachePath: string } | null {
    const f = syncFiles.find((s) => s.remotePath === remotePath);
    return f ? { state: f.state, localCachePath: f.localCachePath } : null;
  }

  let savedExpandedPaths: string[] = [];

  function loadPersistedState() {
    try {
      const raw = getDaemonKV().getItem(KV_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const state = parsed?.[source];
      if (!state) return;
      if (state.nav) {
        nav = NavHistory.fromSerialized(state.nav);
        currentDir = nav.current;
      } else if (typeof state.currentDir === "string") {
        nav = new NavHistory(state.currentDir);
        currentDir = state.currentDir;
      }
      if (Array.isArray(state.expanded)) {
        savedExpandedPaths = state.expanded.filter((x: unknown): x is string => typeof x === "string");
      }
      if (Array.isArray(state.selected)) {
        selected = new Set(state.selected.filter((x: unknown): x is string => typeof x === "string"));
      }
      if (typeof state.showDotfiles === "boolean") showDotfiles = state.showDotfiles;
    } catch {}
  }

  function persistState() {
    try {
      const raw = getDaemonKV().getItem(KV_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[source] = {
        currentDir,
        nav: nav.serialize(),
        expanded: Object.keys(expanded),
        selected: [...selected],
        showDotfiles,
      };
      getDaemonKV().setItem(KV_KEY, JSON.stringify(all));
    } catch {}
  }

  async function loadCurrentDir() {
    loading = true;
    error = null;
    entries = [];
    try {
      entries = isRemote && remoteTermId
        ? await fetchRemoteDir(remoteTermId, currentDir)
        : await fetchDir(currentDir);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      entries = [];
    }
    loading = false;
    if (!isRemote) {
      fetchGitStatus(currentDir, wtPath).then((m) => {
        gitStatusByDir = { ...gitStatusByDir, [currentDir]: m };
      });
    }
    if (savedExpandedPaths.length > 0) {
      const toRestore = savedExpandedPaths;
      savedExpandedPaths = [];
      await restoreExpanded(toRestore);
    }
  }

  async function restoreExpanded(paths: string[]) {
    const fetcher = isRemote && remoteTermId
      ? (p: string) => fetchRemoteDir(remoteTermId!, p)
      : fetchDir;
    const results = await Promise.all(
      paths.map(async (p) => {
        try {
          return { path: p, children: await fetcher(p) };
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
    if (isRemote) followTerminal = false;
    const next = joinPath(currentDir, name);
    nav.push(next);
    currentDir = next;
    navTick++;
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  function goBack() {
    if (isRemote) followTerminal = false;
    const prev = nav.goBack();
    if (!prev) return;
    currentDir = prev;
    navTick++;
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  function goForward() {
    if (isRemote) followTerminal = false;
    const next = nav.goForward();
    if (!next) return;
    currentDir = next;
    navTick++;
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
        const fetcher = isRemote && remoteTermId
          ? (p: string) => fetchRemoteDir(remoteTermId!, p)
          : fetchDir;
        const children = await fetcher(fullPath);
        expanded = { ...expanded, [fullPath]: children };
        if (!isRemote) fetchGitStatus(fullPath, wtPath).then((m) => {
          gitStatusByDir = { ...gitStatusByDir, [fullPath]: m };
        });
      } catch {}
    }
    persistState();
  }

  let lastSelectedPath: string | null = null;

  function visibleFilePaths(): string[] {
    const paths: string[] = [];
    function walk(items: FileEntry[], base: string) {
      for (const entry of items) {
        const fp = joinPath(base, entry.name);
        paths.push(fp);
        const children = expanded[fp];
        if (children) walk(filterDot(children), fp);
      }
    }
    walk(visibleEntries, currentDir);
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
      if (isRemote && remoteTermId) {
        await openRemoteFile(remoteTermId, fullPath);
      } else {
        await fetch("/api/open-default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: fullPath }),
        });
      }
    } catch {}
  }

  function navigateTo(path: string) {
    if (isRemote) followTerminal = false;
    nav.push(path);
    currentDir = path;
    navTick++;
    expanded = {};
    void loadCurrentDir();
    persistState();
  }

  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedPaths: Set<string> = new Set();

  function copyPaths() {
    const text = selected.size > 0
      ? [...selected].join("\n")
      : currentDir;
    void navigator.clipboard.writeText(text).then(() => {
      copied = true;
      copiedPaths = new Set(selected);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copied = false; copiedPaths = new Set(); }, 1200);
    });
  }

  function handleNavigateToFile(filePath: string) {
    const { dir } = splitParent(filePath);
    const target = dir || "/";
    if (target !== currentDir) {
      navigateTo(target);
    }
    selected = new Set([filePath]);
    persistState();
  }

  function handleNodeDblClick(fullPath: string, type: string) {
    if (type === "directory") {
      navigateTo(fullPath);
    } else {
      const { dir, name } = splitParent(fullPath);
      openFile(name, dir);
    }
  }

  function handleNodeToggleExpand(name: string, parentDir: string) {
    toggleExpand(name, parentDir);
  }

  function handleKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "c") {
      e.preventDefault();
      copyPaths();
    } else if (meta && e.key === "a") {
      e.preventDefault();
      const all = visibleFilePaths();
      selected = new Set(all);
      persistState();
    }
  }

  function filterDot(list: FileEntry[]): FileEntry[] {
    if (showDotfiles) return list;
    return list.filter((e) => !e.name.startsWith("."));
  }

  $: visibleEntries = showDotfiles ? entries : entries.filter((e) => !e.name.startsWith("."));

  /** All starred items, with paths inside wtPath listed first (showing
   *  a worktree-relative path) and items outside (parent dirs, sibling
   *  repos) after, showing their full normalized path. */
  $: starredList = computeStarredList(starred, wtPath);
  $: canBack = (navTick, nav.canGoBack());
  $: canForward = (navTick, nav.canGoForward());
  $: visibleSelected = [...selected].filter((p) => visibleEntries.some((e) => joinPath(currentDir, e.name) === p || p.startsWith(joinPath(currentDir, e.name) + "/")));
  $: selectedNames = visibleSelected.map((p) => p.split("/").pop() ?? p);

  loadPersistedState();
  if (remoteTermId) {
    // Remote mode: fetch home dir first, then load
    loading = true;
    void fetchSshHome(remoteTermId).then((home) => {
      remoteHome = home;
      currentDir = home;
      nav = new NavHistory(home);
      void loadCurrentDir();
    });
  } else {
    void loadCurrentDir();
  }

  $: displayName = currentDir.split("/").pop() || currentDir;
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<div class="session file-browser" tabindex="0" on:keydown={handleKeydown}>
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
    lastActivityFallback="{visibleEntries.length} items"
    closeTitle="Close this file browser panel."
    menuItems={[
      {
        kind: "action",
        label: showDotfiles ? "Hide dotfiles" : "Show dotfiles",
        icon: showDotfiles ? "●" : "○",
        keepOpen: true,
        onSelect: () => { showDotfiles = !showDotfiles; persistState(); },
      },
    ] satisfies SessionMenuItem[]}
  />

  <nav class="fb-breadcrumbs">
    <button
      class="fb-nav-btn"
      on:click={goBack}
      disabled={!canBack}
    ><svg class="fb-nav-arrow" viewBox="0 0 8 8"><polygon points="6,1 1,4 6,7"/></svg></button>
    <button
      class="fb-nav-btn"
      on:click={goForward}
      disabled={!canForward}
    ><svg class="fb-nav-arrow" viewBox="0 0 8 8"><polygon points="2,1 7,4 2,7"/></svg></button>
    <button
      class="fb-nav-btn"
      on:click={() => navigateTo(wtPath)}
      disabled={currentDir === wtPath}
    ><svg class="fb-nav-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></button>
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
    <button
      class="fb-nav-btn fb-star-toggle"
      class:fb-star-toggle-on={starredOnly}
      on:click={toggleStarredOnly}
      title={starredOnly ? "Show all files" : "Show only starred"}
      aria-label="Toggle starred-only view"
    >
      {#if starredOnly}
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12,2 15,9 22,9.5 17,14 18.5,21 12,17.5 5.5,21 7,14 2,9.5 9,9"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><polygon points="12,2 15,9 22,9.5 17,14 18.5,21 12,17.5 5.5,21 7,14 2,9.5 9,9"/></svg>
      {/if}
    </button>
    {#if isRemote}
      {#if onFocusTerminal}
        <button
          class="fb-header-btn"
          on:click={onFocusTerminal}
          title="Go to terminal"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      {/if}
      <button
        class="fb-follow-btn"
        class:fb-follow-btn-active={followTerminal}
        on:click={toggleFollow}
        title={followTerminal ? "Click to stop following terminal cwd" : "Click to follow terminal cwd"}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
        {followTerminal ? "Following" : "Follow"}
      </button>
    {/if}
  </nav>

  {#each syncFiles.filter((f) => f.state === "modified") as mod (mod.remotePath)}
    <div class="fb-sync-confirm">
      <span class="fb-sync-confirm-text">
        <strong>{mod.remotePath.split("/").pop()}</strong> modified — upload to remote?
      </span>
      <button class="fb-sync-confirm-btn fb-sync-confirm-upload" on:click={() => { void confirmRemoteUpload(mod.localCachePath).then(() => loadCurrentDir()); }}>Upload</button>
      <button class="fb-sync-confirm-btn" on:click={() => {
        const fullPath = mod.localCachePath;
        void fetch("/api/open-default", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: fullPath }) });
      }}>Open</button>
      <button class="fb-sync-confirm-btn" on:click={() => { void dismissRemoteUpload(mod.localCachePath); }}>Dismiss</button>
    </div>
  {/each}

  <div class="fb-content">
    {#if starredOnly}
      {#if starredList.length === 0}
        <div class="fb-status muted small">No starred items</div>
      {:else}
        <ul class="fb-list">
          {#each starredList as item (item.fullPath)}
            <li>
              <div class="fb-row" role="button" tabindex="0"
                on:click={() => handleNavigateToFile(item.fullPath)}
                on:keydown={(e) => { if (e.key === "Enter") handleNavigateToFile(item.fullPath); }}
              >
                <span class="fb-arrow-spacer" aria-hidden="true"></span>
                <span class="fb-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">{#each ICONS.document.paths ?? [] as d}<path {d}/>{/each}</svg></span>
                <span class="fb-name fb-name-rel">{item.rel}</span>
                <button
                  class="fb-star fb-star-on"
                  on:click|stopPropagation={() => toggleStar(item.fullPath)}
                  title="Unstar"
                  aria-label="Unstar"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12,2 15,9 22,9.5 17,14 18.5,21 12,17.5 5.5,21 7,14 2,9.5 9,9"/></svg>
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if loading && entries.length === 0}
      <div class="fb-status"><LoadingSpinner size="1.2rem" /></div>
    {:else if error}
      <div class="fb-status muted small">{error}</div>
    {:else if entries.length === 0}
      <div class="fb-status muted small">Empty folder</div>
    {:else}
      <ul class="fb-list">
        {#each visibleEntries as entry (entry.name)}
          <FileTreeNode
            {entry}
            parentDir={currentDir}
            {expanded}
            {selected}
            {copiedPaths}
            {gitStatusByDir}
            {showDotfiles}
            {wtPath}
            {starred}
            onSelect={handleSelect}
            onDblClick={handleNodeDblClick}
            onToggleExpand={handleNodeToggleExpand}
            onNavigateToFile={handleNavigateToFile}
            onToggleStar={toggleStar}
          />
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
  .fb-nav-btn {
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
  .fb-nav-btn:hover:not(:disabled) {
    color: var(--text-1);
    background: var(--surface-3);
  }
  .fb-nav-btn:disabled {
    opacity: 0.25;
    cursor: default;
  }
  :global(.fb-nav-arrow) {
    width: 0.55rem;
    height: 0.55rem;
    fill: currentColor;
  }
  .fb-star-toggle :global(svg) {
    width: 0.75rem;
    height: 0.75rem;
    display: block;
  }
  .fb-star-toggle-on {
    color: #e5c248;
  }
  .fb-star-toggle-on:hover:not(:disabled) {
    color: #e5c248;
  }
  :global(.fb-nav-home) {
    width: 0.6rem;
    height: 0.6rem;
    stroke: var(--text-1);
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
</style>
