<script lang="ts">
  import SessionHeader from "./SessionHeader.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import type { SessionMenuItem } from "./SessionMenu.svelte";

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
    const res = await fetch(`/api/commits?${qs.toString()}`);
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
      const res = await fetch(`/api/commit?${qs.toString()}`);
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
        const res = await fetch(`/api/commit?${qs.toString()}`);
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
      label: showDiff ? "Hide diffs" : "Show diffs",
      icon: showDiff ? "◉" : "○",
      keepOpen: true,
      onSelect: () => { showDiff = !showDiff; },
    },
    {
      kind: "action" as const,
      label: fullFile ? "±2 lines context" : "Full file context",
      icon: fullFile ? "◇" : "◈",
      keepOpen: true,
      onSelect: () => { void toggleFullFile(); },
    },
  ] satisfies SessionMenuItem[];

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
    lastActivityFallback={commits ? `${commits.length}${commitsExhausted ? "" : "+"} commits` : ""}
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
        {#each commits as c (c.sha)}
          <button
            class="gh-commit"
            class:open={openCommitSha === c.sha}
            on:click={() => void openCommit(c.sha)}
          >
            <code class="gh-sha">{c.shortSha}</code>
            <span class="gh-subject">{c.subject}</span>
            <span class="gh-meta">
              <span class="gh-author">{c.author}</span>
              <span class="gh-time">{relTime(c.time)}</span>
            </span>
          </button>
          {#if showDiff && openCommitSha === c.sha}
            <div class="gh-diff">
              {#if commitDiff[c.sha] !== undefined}
                <DiffViewer text={commitDiff[c.sha]} />
              {:else if diffLoading}
                <div class="gh-diff-loading"><LoadingSpinner size="1rem" /></div>
              {/if}
            </div>
          {/if}
        {/each}
        {#if !commitsExhausted}
          <button
            class="gh-load-more"
            on:click={() => void loadMoreCommits()}
            disabled={commitsLoading}
          >{commitsLoading ? "Loading..." : "Load more"}</button>
        {:else}
          <span class="gh-end muted small">end of history</span>
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
  }
  .gh-status {
    padding: 1rem;
    text-align: center;
  }
  .gh-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0.25rem;
  }
  .gh-commit {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto auto;
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
  }
  .gh-commit:hover {
    background: var(--surface-2);
  }
  .gh-commit.open {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .gh-sha {
    grid-row: 1;
    grid-column: 1;
    font-family: ui-monospace, monospace;
    color: var(--chip-purple-text);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .gh-subject {
    grid-row: 1;
    grid-column: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--text-2);
  }
  .gh-meta {
    grid-row: 2;
    grid-column: 1 / -1;
    display: flex;
    gap: 0.5rem;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .gh-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .gh-time {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .gh-diff {
    padding: 0.15rem 0.25rem 0.4rem 1.2rem;
  }
  .gh-diff-loading {
    padding: 0.5rem 0;
    text-align: center;
  }
  .gh-load-more {
    margin: 0.4rem 0.5rem;
    padding: 0.3rem 0.8rem;
    background: var(--surface-2);
    color: var(--text-muted);
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: var(--fs-sm);
    align-self: flex-start;
  }
  .gh-load-more:hover {
    color: var(--text-2);
  }
  .gh-load-more:disabled {
    opacity: 0.5;
    cursor: default;
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
