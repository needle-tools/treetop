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

  interface Commit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
    parents?: number;
    refs?: string[];
  }

  const COMMITS_BATCH = 50;
  const FULL_FILE_CONTEXT = 99999;
  const DEFAULT_CONTEXT = 2;

  let commits: Commit[] | undefined = undefined;
  let commitsLoading = false;
  let commitsExhausted = false;

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
      limit: String(COMMITS_BATCH),
    });
    if (before) qs.set("before", before);
    if (allBranches) qs.set("all", "1");
    const res = await fetch(apiUrl(`/api/commits?${qs.toString()}`));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function loadCommitsInitial() {
    if (commits !== undefined) return;
    commitsLoading = true;
    try {
      const list = await fetchCommits();
      commits = list;
      commitsExhausted = list.length < COMMITS_BATCH;
    } catch (e) {
      console.error("GitHistory: loadCommitsInitial", e);
    } finally {
      commitsLoading = false;
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
      const res = await fetch(apiUrl(`/api/commit?${qs.toString()}`));
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
        const res = await fetch(apiUrl(`/api/commit?${qs.toString()}`));
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
  });

  void loadCommitsInitial();
</script>

<div class="session git-history">
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

  <div class="gh-content">
    {#if commitsLoading && commits === undefined}
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
                {#if c.refs && c.refs.length > 0}
                  {#each c.refs as ref}
                    <span
                      class="gh-ref"
                      class:gh-ref-head={ref.startsWith("HEAD")}
                      class:gh-ref-tag={ref.startsWith("tag:")}
                      >{#if ref.startsWith("tag:")}<svg
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
                        >{/if}{ref.replace(/^tag: /, "")}</span
                    >
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
                <DiffViewer text={commitDiff[c.sha]} showCommitHeader={false} />
              {:else if diffLoading}
                <div class="gh-diff-loading">
                  <LoadingSpinner size="1rem" />
                </div>
              {/if}
            </div>
          {/if}
        {/each}
        {#if !commitsExhausted}
          <div class="gh-sentinel" use:setupObserver>
            {#if commitsLoading}
              <LoadingSpinner size="0.8rem" />
            {/if}
          </div>
        {:else}
          <div class="gh-end-row">
            <div class="gh-rail-cap"></div>
            <span class="gh-end muted small">end of history</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
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
    width: 100%;
    flex-shrink: 0;
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
