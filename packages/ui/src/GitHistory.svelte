<script context="module" lang="ts">
  interface Commit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
    parents?: number;
    refs?: string[];
  }
  interface PreviewEntry {
    value?: Commit[];
    at: number;
    version: number;
    pending?: Promise<Commit[]>;
  }
  const previewCache = new Map<string, PreviewEntry>();
  function previewKey(
    daemonId: string | undefined,
    path: string,
    tag: string | undefined,
    branch: string | undefined,
  ) {
    return JSON.stringify([
      daemonId ?? "",
      path,
      tag ? ["tag", tag] : branch ? ["branch", branch] : ["HEAD"],
    ]);
  }
  function previewEntry(key: string): PreviewEntry {
    const entry = previewCache.get(key) ?? { at: 0, version: -1 };
    previewCache.delete(key);
    previewCache.set(key, entry);
    if (previewCache.size > 64)
      previewCache.delete(previewCache.keys().next().value!);
    return entry;
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { apiUrl } from "./api";
  import SessionHeader from "./SessionHeader.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import type { SessionMenuItem } from "./SessionMenu.svelte";
  import { ICONS } from "./icons";

  export let wtPath: string;
  export let source: string;
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};
  export let fsChangeKey = 0;
  /** Owning daemon for this worktree. Undefined ⇒ local daemon
   *  (byte-identical behaviour). Set for remote daemon folder rows. */
  export let daemonId: string | undefined = undefined;
  /** Compact reuse of this exact history renderer for a tag hover preview. */
  export let preview = false;
  export let tag: string | undefined = undefined;
  export let branch: string | undefined = undefined;

  const COMMITS_BATCH = 50;
  const FULL_FILE_CONTEXT = 99999;
  const DEFAULT_CONTEXT = 2;

  let commits: Commit[] | undefined = undefined;
  let commitsLoading = false;
  let commitsExhausted = false;
  let commitsError = "";
  const requests = new AbortController();
  let tagAnchor: HTMLElement | null = null;
  let hoverTag: string | null = null;
  let showTagTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTagTimer: ReturnType<typeof setTimeout> | undefined;

  function keepTagOpen() {
    clearTimeout(hideTagTimer);
  }
  function closeTag() {
    clearTimeout(showTagTimer);
    clearTimeout(hideTagTimer);
    hoverTag = null;
  }
  function leaveTag() {
    clearTimeout(showTagTimer);
    clearTimeout(hideTagTimer);
    hideTagTimer = setTimeout(closeTag, 200);
  }
  function showTag(
    event: MouseEvent | FocusEvent | KeyboardEvent,
    ref: string,
  ) {
    if (preview || !ref.startsWith("tag:")) return;
    keepTagOpen();
    clearTimeout(showTagTimer);
    const anchor = event.currentTarget as HTMLElement;
    showTagTimer = setTimeout(() => {
      tagAnchor = anchor;
      hoverTag = ref.replace(/^tag:\s*/, "");
    }, 250);
  }
  function tagPopup(node: HTMLElement) {
    document.body.appendChild(node);
    const position = () => {
      if (!tagAnchor?.isConnected) {
        closeTag();
        return;
      }
      const anchor = tagAnchor.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`;
      const below = anchor.bottom + 6;
      node.style.top = `${Math.max(8, below + rect.height > window.innerHeight - 8 ? anchor.top - rect.height - 6 : below)}px`;
    };
    const resize = new ResizeObserver(position);
    resize.observe(node);
    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return {
      destroy() {
        resize.disconnect();
        window.removeEventListener("scroll", position, true);
        window.removeEventListener("resize", position);
        node.remove();
      },
    };
  }

  let openCommitSha: string | null = null;
  let commitDiff: Record<string, string> = {};
  let diffLoading = false;
  let fullFile = false;

  let showDiff = true;
  let allBranches = false;

  function contextLines(): number {
    return fullFile ? FULL_FILE_CONTEXT : DEFAULT_CONTEXT;
  }

  function relTime(iso: string): string {
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  async function fetchCommits(before?: string): Promise<Commit[]> {
    const qs = new URLSearchParams({
      path: wtPath,
      limit: String(preview ? 10 : COMMITS_BATCH),
    });
    if (before) qs.set("before", before);
    if (allBranches) qs.set("all", "1");
    if (tag) qs.set("tag", tag);
    if (branch) qs.set("branch", branch);
    const res = await fetch(apiUrl(`/api/commits?${qs.toString()}`, daemonId), {
      signal: preview ? undefined : requests.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function loadCommitsInitial() {
    const key = previewKey(daemonId, wtPath, tag, branch);
    const cached = preview ? previewEntry(key) : undefined;
    if (cached?.value) {
      commits = cached.value;
      commitsError = "";
      if (cached.version === fsChangeKey && Date.now() - cached.at < 30_000)
        return;
    } else if (commits !== undefined) return;
    commitsLoading = true;
    commitsError = "";
    try {
      let list: Commit[];
      if (cached) {
        if (!cached.pending) {
          const version = fsChangeKey;
          cached.pending = fetchCommits()
            .then((value) => {
              cached.value = value;
              cached.at = Date.now();
              cached.version = version;
              return value;
            })
            .finally(() => {
              cached.pending = undefined;
            });
        }
        list = await cached.pending;
      } else list = await fetchCommits();
      if (
        requests.signal.aborted ||
        (preview && key !== previewKey(daemonId, wtPath, tag, branch))
      )
        return;
      commits = list;
      commitsExhausted = list.length < COMMITS_BATCH;
      if (cached && cached.version !== fsChangeKey)
        queueMicrotask(() => {
          if (!requests.signal.aborted) void loadCommitsInitial();
        });
    } catch (e) {
      if (
        requests.signal.aborted ||
        (preview && key !== previewKey(daemonId, wtPath, tag, branch))
      )
        return;
      if (commits === undefined)
        commitsError = e instanceof Error ? e.message : String(e);
      console.error("GitHistory: loadCommitsInitial", e);
    } finally {
      commitsLoading = false;
    }
  }

  let observedFsChangeKey = fsChangeKey;
  let observedPreviewKey = previewKey(daemonId, wtPath, tag, branch);
  $: if (preview) {
    const key = previewKey(daemonId, wtPath, tag, branch);
    if (observedPreviewKey !== key || observedFsChangeKey !== fsChangeKey) {
      if (observedPreviewKey !== key) commits = undefined;
      observedPreviewKey = key;
      observedFsChangeKey = fsChangeKey;
      void loadCommitsInitial();
    }
  }

  async function reloadCommits() {
    commits = undefined;
    commitsExhausted = false;
    openCommitSha = null;
    commitDiff = {};
    await loadCommitsInitial();
  }

  async function loadMoreCommits() {
    if (commits === undefined) return;
    const before = commits[commits.length - 1]?.sha;
    if (!before) return;
    commitsLoading = true;
    try {
      const more = await fetchCommits(before);
      commits = [...commits, ...more];
      commitsExhausted = more.length < COMMITS_BATCH;
    } catch (e) {
      console.error("GitHistory: loadMoreCommits", e);
    } finally {
      commitsLoading = false;
    }
  }

  async function openCommit(sha: string) {
    if (openCommitSha === sha) {
      openCommitSha = null;
      return;
    }
    openCommitSha = sha;
    if (commitDiff[sha] !== undefined) return;
    diffLoading = true;
    try {
      const qs = new URLSearchParams({
        path: wtPath,
        sha,
        context: String(contextLines()),
      });
      const res = await fetch(apiUrl(`/api/commit?${qs.toString()}`, daemonId));
      if (!res.ok) throw new Error(`/api/commit: ${res.status}`);
      commitDiff = { ...commitDiff, [sha]: await res.text() };
    } catch (e) {
      console.error("GitHistory: openCommit", e);
    } finally {
      diffLoading = false;
    }
  }

  async function toggleFullFile() {
    fullFile = !fullFile;
    commitDiff = {};
    if (openCommitSha) {
      diffLoading = true;
      try {
        const qs = new URLSearchParams({
          path: wtPath,
          sha: openCommitSha,
          context: String(contextLines()),
        });
        const res = await fetch(
          apiUrl(`/api/commit?${qs.toString()}`, daemonId),
        );
        if (res.ok) commitDiff = { [openCommitSha]: await res.text() };
      } catch (e) {
        console.error("GitHistory: toggleFullFile", e);
      } finally {
        diffLoading = false;
      }
    }
  }

  $: repoName = wtPath.split("/").pop() || wtPath;

  $: menuItems = [
    {
      kind: "action" as const,
      label: allBranches ? "Current branch" : "All branches",
      icon: allBranches ? "◎" : "⊕",
      keepOpen: true,
      onSelect: () => {
        allBranches = !allBranches;
        void reloadCommits();
      },
    },
    {
      kind: "action" as const,
      label: showDiff ? "Hide diffs" : "Show diffs",
      icon: showDiff ? "◉" : "○",
      keepOpen: true,
      onSelect: () => {
        showDiff = !showDiff;
      },
    },
    {
      kind: "action" as const,
      label: fullFile ? "±2 lines context" : "Full file context",
      icon: fullFile ? "◇" : "◈",
      keepOpen: true,
      onSelect: () => {
        void toggleFullFile();
      },
    },
  ] satisfies SessionMenuItem[];

  let sentinelEl: HTMLDivElement;
  let observer: IntersectionObserver | null = null;

  function setupObserver(node: HTMLDivElement) {
    sentinelEl = node;
    observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !commitsLoading &&
          !commitsExhausted
        ) {
          void loadMoreCommits();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
  }

  onDestroy(() => {
    observer?.disconnect();
    requests.abort();
    closeTag();
  });

  void loadCommitsInitial();
</script>

<svelte:window
  on:keydown={(event) => {
    if (event.key === "Escape") closeTag();
  }}
/>

<div class="session git-history" class:gh-preview={preview}>
  {#if !preview}
    <SessionHeader
      agent="history"
      agentLabel="history"
      {source}
      manualTitle={repoName}
      mode="read"
      canResume={false}
      canEnd={false}
      {onClose}
      {onDragStart}
      lastActivityFallback={commits
        ? `${commits.length}${commitsExhausted ? "" : "+"} commits`
        : ""}
      closeTitle="Close this git history panel."
      {menuItems}
    />
  {/if}

  <div class="gh-content">
    {#if commitsError}
      <div class="gh-status" role="alert">{commitsError}</div>
    {:else if commitsLoading && commits === undefined}
      <div class="gh-status"><LoadingSpinner size="1.2rem" /></div>
    {:else if commits && commits.length === 0}
      <div class="gh-status muted small">No commits yet.</div>
    {:else if commits}
      <div class="gh-list">
        <div class="gh-rail"></div>
        {#each commits as c (c.sha)}
          <div class="gh-commit-row">
            <div class="gh-dot" class:gh-dot-merge={(c.parents ?? 1) > 1}></div>
            <button
              class="gh-commit"
              class:open={openCommitSha === c.sha}
              on:click={() => void openCommit(c.sha)}
            >
              <span class="gh-subject">
                {#if !preview && c.refs && c.refs.length > 0}
                  {#each c.refs as ref}
                    {#if ref.startsWith("tag:")}
                      <span
                        class="gh-ref gh-ref-tag"
                        role="button"
                        aria-label={`View history at ${ref.replace(/^tag:\s*/, "")}`}
                        aria-haspopup="dialog"
                        tabindex="0"
                        on:click={(event) => {
                          event.stopPropagation();
                          showTag(event, ref);
                        }}
                        on:keydown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            showTag(event, ref);
                          }
                        }}
                        on:mouseenter={(event) => showTag(event, ref)}
                        on:mouseleave={leaveTag}
                        on:focus={(event) => showTag(event, ref)}
                        on:blur={leaveTag}
                        ><svg
                          class="gh-tag-icon"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          >{#each ICONS.tag.paths as d}<path
                              {d}
                            />{/each}{#each ICONS.tag.circles ?? [] as c}<circle
                              cx={c.cx}
                              cy={c.cy}
                              r={c.r}
                            />{/each}</svg
                        >{ref.replace(/^tag: /, "")}</span
                      >
                    {:else}
                      <span
                        class="gh-ref"
                        class:gh-ref-head={ref.startsWith("HEAD")}>{ref}</span
                      >
                    {/if}
                  {/each}
                {/if}
                <span class="gh-subject-text">{c.subject}</span>
              </span>
              <span class="gh-author">{c.author}</span>
              <span class="gh-time">{relTime(c.time)}</span>
              <code class="gh-sha">{c.shortSha}</code>
            </button>
          </div>
          {#if showDiff && openCommitSha === c.sha}
            <div class="gh-diff">
              {#if commitDiff[c.sha] !== undefined}
                <DiffViewer
                  text={commitDiff[c.sha]}
                  showCommitHeader={false}
                  worktreePath={wtPath}
                  sourceKind="commit"
                  sha={c.sha}
                  {daemonId}
                />
              {:else if diffLoading}
                <div class="gh-diff-loading">
                  <LoadingSpinner size="1rem" />
                </div>
              {/if}
            </div>
          {/if}
        {/each}
        {#if !preview && !commitsExhausted}
          <div class="gh-sentinel" use:setupObserver>
            {#if commitsLoading}
              <LoadingSpinner size="0.8rem" />
            {/if}
          </div>
        {:else if !preview}
          <div class="gh-end-row">
            <div class="gh-rail-cap"></div>
            <span class="gh-end muted small">end of history</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if hoverTag}
  <div
    class="gh-tag-popover"
    role="dialog"
    aria-label={`History at ${hoverTag}`}
    tabindex="-1"
    use:tagPopup
    on:mouseenter={keepTagOpen}
    on:mouseleave={leaveTag}
    on:focusin={keepTagOpen}
    on:focusout={leaveTag}
  >
    <div class="gh-tag-heading">
      {hoverTag} <span class="muted small">Recent commits</span>
    </div>
    {#key hoverTag}
      <svelte:self
        {wtPath}
        {daemonId}
        source={`${source}:tag:${hoverTag}`}
        {fsChangeKey}
        preview={true}
        tag={hoverTag}
      />
    {/key}
  </div>
{/if}

<style>
  .gh-tag-popover {
    position: fixed;
    z-index: 10000;
    width: min(720px, calc(100vw - 16px));
    max-height: calc(100vh - 16px);
    overflow: auto;
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    box-shadow: 0 8px 28px #0005;
  }
  .gh-tag-heading {
    padding: 0.6rem;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .git-history.gh-preview {
    height: auto;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0;
    width: min(680px, calc(100vw - 48px));
    max-width: 100%;
  }
  .gh-preview .gh-content {
    max-height: 55vh;
  }
  .gh-preview .gh-list {
    padding: 0;
  }
  .gh-preview .gh-rail {
    top: calc(0.35rem + 4px);
  }
  .gh-tag-popover .gh-preview {
    width: 100%;
  }
  .gh-preview .gh-author {
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .git-history {
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
  .gh-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    max-height: 50vh;
    overscroll-behavior-y: contain;
  }
  .gh-status {
    padding: 1rem;
    text-align: center;
  }
  .gh-list {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0.25rem 0.25rem 0.25rem 0;
  }
  .gh-rail {
    position: absolute;
    top: calc(0.25rem + 0.35rem + 4px);
    bottom: 0;
    left: 10px;
    width: 2.5px;
    background: var(--chip-purple-text);
    opacity: 0.45;
    z-index: 0;
  }
  .gh-commit-row {
    display: flex;
    align-items: center;
    min-width: 0;
    position: relative;
    z-index: 1;
  }
  .gh-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--chip-purple-text);
    border: 1.5px solid var(--surface-1);
    flex-shrink: 0;
    margin-left: 6px;
    margin-right: 2px;
    z-index: 1;
  }
  .gh-dot-merge {
    width: 10px;
    height: 10px;
    margin-left: 5px;
    margin-right: 1px;
    background: var(--chip-orange-text);
  }
  .gh-commit {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    gap: 0 0.5rem;
    align-items: baseline;
    padding: 0.35rem 0.5rem;
    font-size: var(--fs-md);
    color: var(--text-4);
    overflow: hidden;
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    flex: 1;
    width: auto;
    min-width: 0;
  }
  .gh-commit:hover {
    background: var(--surface-2);
  }
  .gh-commit.open {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .gh-sha {
    font-family: ui-monospace, monospace;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .gh-subject {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    overflow: hidden;
    min-width: 0;
    white-space: nowrap;
  }
  .gh-subject-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--text-2);
  }
  .gh-author {
    white-space: nowrap;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .gh-time {
    white-space: nowrap;
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .gh-ref {
    flex-shrink: 0;
    font-size: var(--fs-xs);
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--chip-purple-bg);
    color: var(--chip-purple-text);
    white-space: nowrap;
    font-family: ui-monospace, monospace;
  }
  .gh-ref-head {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .gh-ref-tag {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--surface-3);
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }
  .gh-tag-icon {
    width: 0.7em;
    height: 0.7em;
    flex-shrink: 0;
  }
  .gh-diff {
    padding: 0.15rem 0 0.4rem 20px;
    position: relative;
    z-index: 1;
  }
  .gh-diff :global(.diff) {
    font-size: var(--fs-sm);
    background: transparent;
    border: none;
  }
  .gh-diff :global(.file-btn) {
    font-size: var(--fs-sm);
  }
  .gh-diff :global(.file-list) {
    font-size: var(--fs-sm);
  }
  .gh-diff-loading {
    padding: 0.5rem 0;
    text-align: center;
  }
  .gh-sentinel {
    padding: 0.5rem;
    text-align: center;
    min-height: 1px;
  }
  .gh-end-row {
    display: flex;
    align-items: center;
    position: relative;
    z-index: 1;
  }
  .gh-rail-cap {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--surface-1);
    border: 2px solid var(--chip-purple-text);
    opacity: 0.45;
    flex-shrink: 0;
    margin-left: 6px;
    margin-right: 2px;
  }
  .gh-end {
    padding: 0.3rem 0.5rem;
    font-style: italic;
  }
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: var(--fs-md);
  }
</style>
