<script lang="ts">
  /**
   * Per-row source-control panel: the chevron + last-commit summary line
   * that's always visible, plus the foldout (Unstaged/Staged tabs +
   * inline diff + History list) shown when `expanded` is true.
   *
   * This component owns every piece of source-control state that used
   * to live as `Record<wtPath, X>` maps inside App.svelte:
   *
   *   - diffTab / workdirDiff / stagedDiff / diffLoading / fullFile
   *   - commits / commitsLoading / commitsExhausted
   *   - openCommitSha / commitDiff (keyed by sha only — wtPath is implicit)
   *
   * The only state that *stays* in App.svelte is `commitsExpanded` (it
   * persists to localStorage so a foldout-open state survives reloads),
   * passed in via the `expanded` prop and toggled via `on:toggle`.
   *
   * The FS-change handler in App.svelte's SSE subscription bumps a
   * `fsChangeKey` prop; this component watches it and refetches the
   * active diff so the panel doesn't go stale.
   *
   * Phase 2 of the App.svelte refactor — see plans/PLAN.md
   * "App.svelte refactor (componentization)".
   */
  import { createEventDispatcher } from "svelte";
  import DiffViewer from "./DiffViewer.svelte";

  interface FileStatus {
    staged: number;
    unstaged: number;
    untracked: number;
  }
  interface LastCommit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
  }
  interface WorktreeInput {
    path: string;
    fileStatus: FileStatus;
    lastCommit: LastCommit | null;
  }

  export let wt: WorktreeInput;
  export let expanded: boolean;
  /** When true, the foldout shows the sticky "Hide ✕" close button at
   *  the top of the History pane (only matters when the row is in zen
   *  mode — the chevron is harder to find against a big diff). */
  export let inZen = false;
  /** Bumped by App.svelte whenever the daemon's FS watcher broadcasts
   *  `fs_change` for this worktree's path. The pane invalidates its
   *  cached diff and refetches whichever tab is open. */
  export let fsChangeKey = 0;
  /** Surface a human-readable error string (matches App.svelte's
   *  `error` banner style). Optional — most failures are silent. */
  export let onError: ((message: string) => void) | undefined = undefined;

  const dispatch = createEventDispatcher<{ toggle: void }>();

  type DiffTab = "workdir" | "staged";
  const COMMITS_BATCH = 50;
  const FULL_FILE_CONTEXT = 99999;
  const DEFAULT_CONTEXT = 2;

  let diffTab: DiffTab = "workdir";
  let workdirDiff: string | undefined = undefined;
  let stagedDiff: string | undefined = undefined;
  let diffLoading = false;
  let fullFile = false;

  let commits: LastCommit[] | undefined = undefined;
  let commitsLoading = false;
  let commitsExhausted = false;

  let openCommitSha: string | null = null;
  let commitDiff: Record<string, string> = {};

  // `summary.text !== "clean"` is what the inline-diff block guards on
  // in the original template — we replicate that boolean here.
  $: dirty =
    wt.fileStatus.staged +
      wt.fileStatus.unstaged +
      wt.fileStatus.untracked >
    0;
  $: anyChanges = dirty || wt.fileStatus.staged > 0;

  // Track which `path / expanded / fsChangeKey` state we've already
  // reacted to so each transition fires its side-effect exactly once.
  let lastExpandedPath: string | null = null;
  let lastFsChangeKey = fsChangeKey;
  $: void onExpandedChange(expanded, wt.path);
  $: void onFsChange(fsChangeKey, wt.path);

  async function onExpandedChange(open: boolean, path: string) {
    const key = `${path}|${open}`;
    if (lastExpandedPath === key) return;
    lastExpandedPath = key;
    if (!open) return;
    // First time opening for this worktree-path: pull the initial
    // commits list and default the tab to "workdir" (which auto-fetches
    // the diff).
    if (commits === undefined) await loadCommitsInitial();
    if (!hasTabBeenSet) setDiffTab("workdir");
  }

  async function onFsChange(_key: number, _path: string) {
    if (_key === lastFsChangeKey) return;
    lastFsChangeKey = _key;
    // Drop cached diffs; the active-tab refetch below repopulates
    // whichever one the user is looking at.
    workdirDiff = undefined;
    stagedDiff = undefined;
    if (!expanded) return;
    if (diffTab === "workdir") void loadWorkdirDiff();
    else void loadStagedDiff();
  }

  let hasTabBeenSet = false;

  function reportError(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (onError) onError(msg);
    else console.error(msg);
  }

  function contextLines(): number {
    return fullFile ? FULL_FILE_CONTEXT : DEFAULT_CONTEXT;
  }

  async function fetchDiff(kind: DiffTab): Promise<string> {
    const qs = new URLSearchParams({
      path: wt.path,
      kind,
      context: String(contextLines()),
    });
    const res = await fetch(`/api/diff?${qs.toString()}`);
    if (!res.ok) throw new Error(`/api/diff: ${res.status}`);
    return res.text();
  }

  async function loadWorkdirDiff() {
    diffLoading = true;
    try {
      workdirDiff = await fetchDiff("workdir");
    } catch (e) {
      reportError(e);
    } finally {
      diffLoading = false;
    }
  }

  async function loadStagedDiff() {
    diffLoading = true;
    try {
      stagedDiff = await fetchDiff("staged");
    } catch (e) {
      reportError(e);
    } finally {
      diffLoading = false;
    }
  }

  function setDiffTab(tab: DiffTab) {
    diffTab = tab;
    hasTabBeenSet = true;
    if (tab === "workdir" && workdirDiff === undefined) void loadWorkdirDiff();
    if (tab === "staged" && stagedDiff === undefined) void loadStagedDiff();
  }

  /** ±2 lines ↔ Full file: drop cached diffs and refetch with the
   *  new context level. */
  async function toggleFullFile() {
    fullFile = !fullFile;
    workdirDiff = undefined;
    stagedDiff = undefined;
    commitDiff = {};
    if (diffTab === "workdir") await loadWorkdirDiff();
    else await loadStagedDiff();
    if (openCommitSha) {
      try {
        const qs = new URLSearchParams({
          path: wt.path,
          sha: openCommitSha,
          context: String(contextLines()),
        });
        const res = await fetch(`/api/commit?${qs.toString()}`);
        if (res.ok) commitDiff = { ...commitDiff, [openCommitSha]: await res.text() };
      } catch (e) {
        reportError(e);
      }
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
        path: wt.path,
        sha,
        context: String(contextLines()),
      });
      const res = await fetch(`/api/commit?${qs.toString()}`);
      if (!res.ok) throw new Error(`/api/commit: ${res.status}`);
      commitDiff = { ...commitDiff, [sha]: await res.text() };
    } catch (e) {
      reportError(e);
    } finally {
      diffLoading = false;
    }
  }

  async function fetchCommits(before?: string): Promise<LastCommit[]> {
    const qs = new URLSearchParams({
      path: wt.path,
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
      reportError(e);
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
      reportError(e);
    } finally {
      commitsLoading = false;
    }
  }

  function relTime(iso: string): string {
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }
</script>

{#if wt.lastCommit}
  <!-- "Topmost commit" row: chevron + last-commit summary, placed
       below the sessions strip in App.svelte's row layout. The chevron
       toggles the source-control panel (staging + history) below. -->
  <div class="row-commit muted small">
    <button
      class="chevron"
      class:open={expanded}
      title={expanded ? "Hide source control" : "Show source control"}
      aria-label={expanded ? "Hide source control" : "Show source control"}
      on:click={() => dispatch("toggle")}
    >
      <span class="arrow">▸</span>
    </button>
    <span class="sha">{wt.lastCommit.shortSha}</span>
    <span class="commit-subject">{wt.lastCommit.subject}</span>
    <span class="commit-author">{wt.lastCommit.author}</span>
    <span class="commit-time">{relTime(wt.lastCommit.time)}</span>
  </div>
{/if}

{#if expanded}
  <div class="expanded">
    {#if inZen}
      <button
        class="hide-history-btn"
        title="Hide source control"
        on:click={() => dispatch("toggle")}
      >Hide ✕</button>
    {/if}
    {#if anyChanges}
      <div class="inline-diff">
        <div class="tabs-row">
          <div class="tabs">
            <button
              class="tab"
              class:active={diffTab === "workdir"}
              on:click={() => setDiffTab("workdir")}
            >
              Unstaged
              {#if dirty}
                <span class="tab-count">{wt.fileStatus.unstaged + wt.fileStatus.untracked}</span>
              {/if}
            </button>
            <button
              class="tab"
              class:active={diffTab === "staged"}
              on:click={() => setDiffTab("staged")}
            >
              Staged
              {#if wt.fileStatus.staged > 0}
                <span class="tab-count">{wt.fileStatus.staged}</span>
              {/if}
            </button>
          </div>
          <button
            class="ctx-toggle"
            class:active={fullFile}
            title={fullFile
              ? "Showing whole file — click for ±2 lines"
              : "Showing ±2 lines context — click for whole file"}
            on:click={() => void toggleFullFile()}
          >{fullFile ? "Full file" : "±2 lines"}</button>
        </div>

        {#if diffTab === "workdir"}
          {#if diffLoading && workdirDiff === undefined}
            <p class="muted small nopad">Loading diff…</p>
          {:else if workdirDiff}
            <DiffViewer text={workdirDiff} />
          {:else}
            <p class="muted small nopad">Nothing unstaged.</p>
          {/if}
        {:else}
          {#if diffLoading && stagedDiff === undefined}
            <p class="muted small nopad">Loading diff…</p>
          {:else if stagedDiff}
            <DiffViewer text={stagedDiff} />
          {:else}
            <p class="muted small nopad">Nothing staged.</p>
          {/if}
        {/if}
      </div>
    {/if}
    <h3 class="commits-heading">History</h3>
    <div class="commits">
      {#if commitsLoading && commits === undefined}
        <p class="muted small nopad">Loading…</p>
      {:else if commits}
        {#each commits as c (c.sha)}
          <button
            class="commit-row"
            class:open={openCommitSha === c.sha}
            on:click={() => void openCommit(c.sha)}
          >
            <code class="sha">{c.shortSha}</code>
            <span class="commit-subject">{c.subject}</span>
            <span class="commit-author">{c.author}</span>
            <span class="commit-time">{relTime(c.time)}</span>
          </button>
          {#if openCommitSha === c.sha}
            {#if commitDiff[c.sha] !== undefined}
              <div class="inline-commit">
                <DiffViewer text={commitDiff[c.sha]} />
              </div>
            {:else}
              <p class="muted small nopad">Loading commit…</p>
            {/if}
          {/if}
        {/each}
        {#if !commitsExhausted}
          <button
            class="tiny load-more"
            on:click={() => void loadMoreCommits()}
            disabled={commitsLoading}
            >{commitsLoading ? "Loading…" : "Load more"}</button
          >
        {:else}
          <span class="muted small">— end of history</span>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<!-- All visual rules live in packages/ui/src/styles/source-control.css
     + worktree-row.css (chevron, row-commit, sha, commit-subject) +
     zen-row.css (.hide-history-btn). No scoped <style> here. -->
