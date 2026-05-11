<script lang="ts">
  import { onMount } from "svelte";
  import { ExpandedStore } from "./storage";
  import DiffViewer from "./DiffViewer.svelte";
  import SessionView from "./SessionView.svelte";

  interface FileStatus {
    staged: number;
    unstaged: number;
    untracked: number;
  }
  interface BranchStatus {
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
  }
  interface LastCommit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
  }
  interface AgentSession {
    agent: "claude" | "codex" | "copilot";
    cwd: string;
    lastActive: string;
    sessionId?: string;
    source: string;
  }
  interface ActivityEvent {
    agent: "claude" | "codex" | "copilot";
    cwd: string;
    sessionId: string;
    summary: string;
    timestamp: string;
    source: string;
  }
  interface Worktree {
    path: string;
    branch: string;
    head: string;
    bare: boolean;
    detached: boolean;
    fileStatus: FileStatus;
    branchStatus: BranchStatus | null;
    lastCommit: LastCommit | null;
    agents?: AgentSession[];
  }
  interface Repo {
    id: string;
    path: string;
    name: string;
    addedAt: string;
    worktrees: Worktree[];
  }
  interface Event {
    id: string;
    timestamp: string;
    type: string;
    actor: "user" | "agent" | "supergit";
    payload: any;
    inverse?: any;
    undone: boolean;
    reversible: boolean;
    redoable: boolean;
  }
  interface EditorDescriptor {
    name: string;
    cmd: string;
  }

  let repos: Repo[] = [];
  let events: Event[] = [];
  let editors: EditorDescriptor[] = [];
  let newRepoPath = "";
  let loading = false;
  let error = "";
  let streamConnected = false;

  let editingRepoId: string | null = null;
  let editRepoName = "";

  let actionsOpen = false;

  // Live activity stream keyed by the agent's cwd (≈ worktree path).
  // Capped to MAX_ACTIVITY entries per cwd; newest first.
  const MAX_ACTIVITY = 8;
  let activityByCwd: Record<string, ActivityEvent[]> = {};

  // Per worktree: which session is currently opened in the SessionView panel.
  // null = closed. Stored by source path so it round-trips across SSE updates.
  let openSession: Record<string, { agent: AgentSession["agent"]; source: string } | null> = {};

  // diff viewer per worktree
  type DiffTab = "workdir" | "staged";
  let diffTab: Record<string, DiffTab> = {};
  let workdirDiff: Record<string, string> = {};
  let stagedDiff: Record<string, string> = {};
  let openCommitSha: Record<string, string | null> = {};
  let commitDiff: Record<string, string> = {};
  let diffLoading: Record<string, boolean> = {};
  // Per-worktree: false = ±2 lines of context (default); true = whole file.
  let fullFile: Record<string, boolean> = {};
  const FULL_FILE_CONTEXT = 99999;
  const DEFAULT_CONTEXT = 2;

  // commit history per worktree-path
  let commitsByPath: Record<string, LastCommit[]> = {};
  let commitsExpanded: Record<string, boolean> = {};
  let commitsLoading: Record<string, boolean> = {};
  let commitsExhausted: Record<string, boolean> = {};
  const COMMITS_BATCH = 50;

  const expandedStore = new ExpandedStore(
    typeof window !== "undefined"
      ? window.localStorage
      : ({ getItem: () => null, setItem: () => {} }),
    "supergit:commitsExpanded",
  );

  function restoreExpanded() {
    const paths = expandedStore.load();
    if (paths.size === 0) return;
    const next: Record<string, boolean> = {};
    for (const p of paths) next[p] = true;
    commitsExpanded = next;
  }
  function persistExpanded() {
    const paths = Object.entries(commitsExpanded)
      .filter(([, v]) => v)
      .map(([k]) => k);
    expandedStore.save(paths);
  }

  async function load() {
    loading = true;
    error = "";
    try {
      const [r, e] = await Promise.all([
        fetch("/api/repos"),
        fetch("/api/events"),
      ]);
      if (!r.ok) throw new Error(`/api/repos: ${r.status}`);
      if (!e.ok) throw new Error(`/api/events: ${e.status}`);
      repos = await r.json();
      events = await e.json();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function addRepo() {
    if (!newRepoPath.trim()) return;
    error = "";
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: newRepoPath.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      newRepoPath = "";
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function pickAndAdd() {
    error = "";
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      if (res.status === 204) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { path } = (await res.json()) as { path: string };
      newRepoPath = path;
      await addRepo();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function startRenameRepo(repo: Repo) {
    editingRepoId = repo.id;
    editRepoName = repo.name;
  }
  function cancelRenameRepo() {
    editingRepoId = null;
    editRepoName = "";
  }
  async function commitRenameRepo(id: string) {
    const name = editRepoName.trim();
    if (!name) {
      cancelRenameRepo();
      return;
    }
    error = "";
    try {
      const res = await fetch(`/api/repos/${id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      editingRepoId = null;
      editRepoName = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function removeRepo(id: string) {
    error = "";
    try {
      const res = await fetch(`/api/repos/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function toggleEvent(id: string, toggle: "undo" | "redo") {
    error = "";
    try {
      const res = await fetch(`/api/events/${id}/${toggle}`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function openIn(path: string, app: string) {
    error = "";
    try {
      const res = await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, app }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function fetchCommits(
    wtPath: string,
    before?: string,
  ): Promise<LastCommit[]> {
    const qs = new URLSearchParams({ path: wtPath, limit: String(COMMITS_BATCH) });
    if (before) qs.set("before", before);
    const res = await fetch(`/api/commits?${qs.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  function contextFor(wtPath: string): number {
    return fullFile[wtPath] ? FULL_FILE_CONTEXT : DEFAULT_CONTEXT;
  }
  async function fetchDiff(wtPath: string, kind: DiffTab): Promise<string> {
    const qs = new URLSearchParams({
      path: wtPath,
      kind,
      context: String(contextFor(wtPath)),
    });
    const res = await fetch(`/api/diff?${qs.toString()}`);
    if (!res.ok) throw new Error(`/api/diff: ${res.status}`);
    return res.text();
  }

  /** Flip ±2 lines ↔ Full file, drop the worktree's cached diffs, refetch. */
  async function toggleFullFile(wtPath: string) {
    fullFile = { ...fullFile, [wtPath]: !fullFile[wtPath] };

    const wd = { ...workdirDiff };
    delete wd[wtPath];
    workdirDiff = wd;

    const sd = { ...stagedDiff };
    delete sd[wtPath];
    stagedDiff = sd;

    const cd: Record<string, string> = {};
    for (const k in commitDiff) {
      if (!k.startsWith(`${wtPath}:`)) cd[k] = commitDiff[k]!;
    }
    commitDiff = cd;

    const tab = diffTab[wtPath] ?? "workdir";
    if (tab === "workdir") await loadWorkdirDiff(wtPath);
    else await loadStagedDiff(wtPath);

    // If a commit was open, refetch its diff with the new context.
    const sha = openCommitSha[wtPath];
    if (sha) {
      try {
        const qs = new URLSearchParams({
          path: wtPath,
          sha,
          context: String(contextFor(wtPath)),
        });
        const res = await fetch(`/api/commit?${qs.toString()}`);
        if (res.ok) {
          commitDiff = {
            ...commitDiff,
            [`${wtPath}:${sha}`]: await res.text(),
          };
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  async function loadWorkdirDiff(wtPath: string) {
    diffLoading = { ...diffLoading, [wtPath]: true };
    try {
      workdirDiff = {
        ...workdirDiff,
        [wtPath]: await fetchDiff(wtPath, "workdir"),
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading = { ...diffLoading, [wtPath]: false };
    }
  }
  async function loadStagedDiff(wtPath: string) {
    diffLoading = { ...diffLoading, [wtPath]: true };
    try {
      stagedDiff = {
        ...stagedDiff,
        [wtPath]: await fetchDiff(wtPath, "staged"),
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading = { ...diffLoading, [wtPath]: false };
    }
  }
  function setDiffTab(wtPath: string, tab: DiffTab) {
    diffTab = { ...diffTab, [wtPath]: tab };
    if (tab === "workdir" && workdirDiff[wtPath] === undefined)
      loadWorkdirDiff(wtPath);
    if (tab === "staged" && stagedDiff[wtPath] === undefined)
      loadStagedDiff(wtPath);
  }
  async function openCommit(wtPath: string, sha: string) {
    if (openCommitSha[wtPath] === sha) {
      openCommitSha = { ...openCommitSha, [wtPath]: null };
      return;
    }
    openCommitSha = { ...openCommitSha, [wtPath]: sha };
    if (commitDiff[`${wtPath}:${sha}`] !== undefined) return;
    diffLoading = { ...diffLoading, [wtPath]: true };
    try {
      const qs = new URLSearchParams({
        path: wtPath,
        sha,
        context: String(contextFor(wtPath)),
      });
      const res = await fetch(`/api/commit?${qs.toString()}`);
      if (!res.ok) throw new Error(`/api/commit: ${res.status}`);
      const text = await res.text();
      commitDiff = { ...commitDiff, [`${wtPath}:${sha}`]: text };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading = { ...diffLoading, [wtPath]: false };
    }
  }

  async function loadCommitsInitial(wtPath: string) {
    if (commitsByPath[wtPath]) return;
    commitsLoading = { ...commitsLoading, [wtPath]: true };
    try {
      const list = await fetchCommits(wtPath);
      commitsByPath = { ...commitsByPath, [wtPath]: list };
      commitsExhausted = {
        ...commitsExhausted,
        [wtPath]: list.length < COMMITS_BATCH,
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      commitsLoading = { ...commitsLoading, [wtPath]: false };
    }
  }

  async function loadMoreCommits(wtPath: string) {
    error = "";
    const existing = commitsByPath[wtPath] ?? [];
    const before = existing[existing.length - 1]?.sha;
    if (!before) return;
    commitsLoading = { ...commitsLoading, [wtPath]: true };
    try {
      const more = await fetchCommits(wtPath, before);
      commitsByPath = {
        ...commitsByPath,
        [wtPath]: [...existing, ...more],
      };
      commitsExhausted = {
        ...commitsExhausted,
        [wtPath]: more.length < COMMITS_BATCH,
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      commitsLoading = { ...commitsLoading, [wtPath]: false };
    }
  }

  async function toggleCommits(wtPath: string) {
    error = "";
    const willExpand = !commitsExpanded[wtPath];
    commitsExpanded = { ...commitsExpanded, [wtPath]: willExpand };
    persistExpanded();
    if (willExpand) {
      await loadCommitsInitial(wtPath);
      if (!diffTab[wtPath]) setDiffTab(wtPath, "workdir");
    }
  }

  async function loadEditors() {
    try {
      const res = await fetch("/api/editors");
      if (!res.ok) return;
      editors = await res.json();
    } catch {
      // ignore
    }
  }

  function subscribeToStream(): () => void {
    const es = new EventSource("/api/stream");
    es.addEventListener("change", () => {
      void load();
    });
    es.addEventListener("activity", (rawEvt: MessageEvent) => {
      try {
        const ev = JSON.parse(rawEvt.data) as ActivityEvent;
        const existing = activityByCwd[ev.cwd] ?? [];
        const next = [ev, ...existing].slice(0, MAX_ACTIVITY);
        activityByCwd = { ...activityByCwd, [ev.cwd]: next };
      } catch {
        // ignore malformed
      }
    });
    es.onopen = () => {
      streamConnected = true;
    };
    es.onerror = () => {
      streamConnected = false;
    };
    return () => es.close();
  }

  function eventLabel(ev: Event): string {
    if (ev.type === "add_repo") {
      const inv = ev.inverse as
        | { repo?: { name?: string; path?: string } }
        | undefined;
      const name =
        inv?.repo?.name ??
        (ev.payload?.path as string | undefined)
          ?.split("/")
          .filter(Boolean)
          .pop();
      return `Added ${name ?? "(unknown)"}`;
    }
    if (ev.type === "remove_repo") {
      const inv = ev.inverse as
        | { repo?: { name?: string; path?: string } }
        | undefined;
      const name = inv?.repo?.name ?? inv?.repo?.path;
      return `Removed ${name ?? "(unknown)"}`;
    }
    if (ev.type === "rename_repo") {
      const p = ev.payload as { newName?: string };
      const inv = ev.inverse as { oldName?: string };
      return `Renamed ${inv?.oldName ?? "?"} → ${p?.newName ?? "?"}`;
    }
    return ev.type;
  }

  function relTime(iso: string): string {
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  function statusSummary(s: FileStatus): { clean: boolean; text: string } {
    const total = s.staged + s.unstaged + s.untracked;
    if (total === 0) return { clean: true, text: "clean" };
    const parts: string[] = [];
    if (s.staged) parts.push(`${s.staged} staged`);
    if (s.unstaged) parts.push(`${s.unstaged} unstaged`);
    if (s.untracked) parts.push(`${s.untracked} untracked`);
    return { clean: false, text: parts.join(", ") };
  }

  // Flat list: one row per worktree (or one placeholder row per registered
  // path that has no worktrees yet).
  $: rows = repos.flatMap((repo) =>
    repo.worktrees.length > 0
      ? repo.worktrees.map((wt) => ({
          repo,
          wt,
          key: `${repo.id}|${wt.path}`,
        }))
      : [{ repo, wt: null as Worktree | null, key: `${repo.id}|none` }],
  );

  // Only "real" actions in the dropdown; toggle events are hidden.
  $: visibleEvents = events.filter(
    (e) => e.type !== "undo" && e.type !== "redo",
  );

  function handleDocClick(e: MouseEvent) {
    if (!actionsOpen) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".actions-anchor")) actionsOpen = false;
  }

  // Svelte action: focus + select the node when it's mounted. Used on the
  // rename input so clicking the repo chip drops you straight into typing.
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
    return {};
  }

  onMount(() => {
    restoreExpanded();
    void loadEditors();
    void load().then(() => {
      for (const [path, expanded] of Object.entries(commitsExpanded)) {
        if (expanded) void loadCommitsInitial(path);
      }
    });
    document.addEventListener("click", handleDocClick);
    const unsubStream = subscribeToStream();
    return () => {
      document.removeEventListener("click", handleDocClick);
      unsubStream();
    };
  });
</script>

<main>
  <header>
    <h1>
      <img src="/needle-logo.svg" alt="" class="brand-mark" />
      supergit
      <span
        class="live"
        class:on={streamConnected}
        title={streamConnected ? "live (SSE connected)" : "offline (SSE disconnected)"}
      >
        {streamConnected ? "● live" : "○ offline"}
      </span>

      <div class="actions-anchor">
        <button
          class="actions-btn"
          class:open={actionsOpen}
          on:click={() => (actionsOpen = !actionsOpen)}
          title="Recent actions"
        >
          Actions
          {#if visibleEvents.length > 0}
            <span class="count">{visibleEvents.length}</span>
          {/if}
        </button>
        {#if actionsOpen}
          <div class="actions-popover" role="menu">
            <div class="popover-head">Recent actions</div>
            {#if visibleEvents.length === 0}
              <p class="muted small nopad">No actions yet.</p>
            {:else}
              <ul class="events">
                {#each visibleEvents.slice(0, 50) as ev (ev.id)}
                  <li class:undone={ev.undone}>
                    <div class="ev-row">
                      <span class="ev-type">{eventLabel(ev)}</span>
                      <span class="muted ev-time">{relTime(ev.timestamp)}</span>
                    </div>
                    <div class="ev-meta">
                      <span class="actor actor-{ev.actor}">{ev.actor}</span>
                      {#if ev.reversible}
                        {#if ev.undone}
                          <button
                            class="undo"
                            on:click={() => toggleEvent(ev.id, "redo")}>Redo</button
                          >
                        {:else}
                          <button
                            class="undo"
                            on:click={() => toggleEvent(ev.id, "undo")}>Undo</button
                          >
                        {/if}
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    </h1>
    <p class="muted">v0 — multi-repo, multi-agent, worktree-first dashboard</p>
  </header>

  <section class="add">
    <button class="primary" on:click={pickAndAdd}>Pick folder…</button>
    <input
      type="text"
      placeholder="…or paste an absolute path"
      bind:value={newRepoPath}
      on:keydown={(e) => e.key === "Enter" && addRepo()}
    />
    <button on:click={addRepo} disabled={!newRepoPath.trim()}>Add</button>
    <button class="refresh" on:click={load}>Refresh</button>
  </section>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading && repos.length === 0}
    <p class="muted">Loading…</p>
  {:else if rows.length === 0}
    <p class="muted">No repos registered yet. Pick a folder above to start.</p>
  {:else}
    <ul class="rows">
      {#each rows as row (row.key)}
        {@const { repo, wt } = row}
        {@const summary = wt ? statusSummary(wt.fileStatus) : null}
        <li class="row">
          <div class="row-left">
            {#if wt && wt.lastCommit}
              <button
                class="chevron"
                class:open={commitsExpanded[wt.path]}
                title={commitsExpanded[wt.path] ? "Hide history" : "Show history"}
                aria-label={commitsExpanded[wt.path] ? "Hide history" : "Show history"}
                on:click={() => toggleCommits(wt.path)}
              >
                <span class="arrow">▾</span>
              </button>
            {/if}
          </div>
          <div class="row-content">
          <div class="row-head">
            {#if editingRepoId === repo.id}
              <input
                class="name-edit"
                use:focusAndSelect
                bind:value={editRepoName}
                on:keydown={(e) => {
                  if (e.key === "Enter") commitRenameRepo(repo.id);
                  if (e.key === "Escape") cancelRenameRepo();
                }}
                on:blur={() => commitRenameRepo(repo.id)}
              />
            {:else}
              <button
                class="repo-chip"
                title="Rename repo"
                on:click={() => startRenameRepo(repo)}
              >
                {repo.name}
                <span class="pencil">✎</span>
              </button>
            {/if}

            {#if wt}
              {#if wt.detached}
                <span class="branch detached">detached @ {wt.head.slice(0, 7)}</span>
              {:else if wt.bare}
                <span class="branch bare">bare</span>
              {:else}
                <span class="branch">{wt.branch}</span>
              {/if}
              {#if wt.agents && wt.agents.length > 0}
                {@const a = wt.agents[0]}
                <button
                  class="agent-badge agent-{a.agent}"
                  title={`Click to read this ${a.agent} session\nLast active ${relTime(a.lastActive)}\n${a.source}`}
                  on:click={() => {
                    const cur = openSession[wt.path];
                    if (cur && cur.source === a.source) {
                      openSession = { ...openSession, [wt.path]: null };
                    } else {
                      openSession = {
                        ...openSession,
                        [wt.path]: { agent: a.agent, source: a.source },
                      };
                    }
                  }}
                >
                  <span class="agent-dot"></span>
                  {a.agent} · {relTime(a.lastActive)}
                  {#if wt.agents.length > 1}
                    <span class="agent-extra">+{wt.agents.length - 1}</span>
                  {/if}
                </button>
              {/if}
              <code class="wt-path">{wt.path}</code>
            {:else}
              <code class="wt-path">{repo.path}</code>
              <span class="branch warn">no worktrees</span>
            {/if}

            <button
              class="remove"
              title="Remove repo from workspace"
              on:click={() => removeRepo(repo.id)}>×</button
            >
          </div>

          {#if wt && openSession[wt.path]}
            {@const s = openSession[wt.path]!}
            <div class="session-panel">
              <SessionView
                agent={s.agent}
                source={s.source}
                onClose={() => (openSession = { ...openSession, [wt.path]: null })}
              />
            </div>
          {/if}

          {#if wt && activityByCwd[wt.path] && activityByCwd[wt.path].length > 0}
            {@const latest = activityByCwd[wt.path][0]}
            <div class="row-activity" title={`source: ${latest.source}`}>
              <span class="agent-dot agent-{latest.agent}"></span>
              <span class="activity-text">{latest.summary}</span>
              <span class="activity-time muted">{relTime(latest.timestamp)}</span>
            </div>
          {/if}

          {#if wt && summary}
            <div class="row-status">
              <span
                class="status-dot"
                class:clean={summary.clean}
                title={summary.text}
              ></span>
              <span class="muted small">{summary.text}</span>
              {#if wt.branchStatus && wt.branchStatus.upstream}
                {#if wt.branchStatus.ahead > 0 || wt.branchStatus.behind > 0}
                  <span class="ab" title={`vs ${wt.branchStatus.upstream}`}>
                    {#if wt.branchStatus.ahead > 0}↑{wt.branchStatus.ahead}{/if}
                    {#if wt.branchStatus.behind > 0}↓{wt.branchStatus.behind}{/if}
                  </span>
                {:else}
                  <span class="muted small">in sync</span>
                {/if}
              {:else if !wt.detached && !wt.bare && wt.branchStatus}
                <span class="muted small">no upstream</span>
              {/if}

              <div class="row-actions">
                {#each editors as ed}
                  <button
                    class="tiny"
                    on:click={() => openIn(wt.path, ed.cmd)}
                    title={`Open in ${ed.name}`}>{ed.name}</button
                  >
                {/each}
                <button
                  class="tiny"
                  on:click={() => openIn(wt.path, "fork")}
                  title="Open in Fork">Fork</button
                >
                <button
                  class="tiny"
                  on:click={() => openIn(wt.path, "terminal")}
                  title="Open in terminal">Terminal</button
                >
              </div>
            </div>

            {#if wt.lastCommit}
              <div class="row-commit muted small">
                <code class="sha">{wt.lastCommit.shortSha}</code>
                <span class="commit-subject">{wt.lastCommit.subject}</span>
                <span class="commit-author">{wt.lastCommit.author}</span>
                <span class="commit-time">{relTime(wt.lastCommit.time)}</span>
              </div>

              {#if commitsExpanded[wt.path]}
                <div class="expanded">
                  <div class="tabs-row">
                    <div class="tabs">
                      <button
                        class="tab"
                        class:active={(diffTab[wt.path] ?? "workdir") === "workdir"}
                        on:click={() => setDiffTab(wt.path, "workdir")}
                      >
                        Unstaged
                        {#if summary.text !== "clean"}
                          <span class="tab-count">{wt.fileStatus.unstaged + wt.fileStatus.untracked}</span>
                        {/if}
                      </button>
                      <button
                        class="tab"
                        class:active={diffTab[wt.path] === "staged"}
                        on:click={() => setDiffTab(wt.path, "staged")}
                      >
                        Staged
                        {#if wt.fileStatus.staged > 0}
                          <span class="tab-count">{wt.fileStatus.staged}</span>
                        {/if}
                      </button>
                    </div>
                    <button
                      class="ctx-toggle"
                      class:active={fullFile[wt.path]}
                      title={fullFile[wt.path]
                        ? "Showing whole file — click for ±2 lines"
                        : "Showing ±2 lines context — click for whole file"}
                      on:click={() => toggleFullFile(wt.path)}
                    >{fullFile[wt.path] ? "Full file" : "±2 lines"}</button>
                  </div>

                  {#if (diffTab[wt.path] ?? "workdir") === "workdir"}
                    {#if diffLoading[wt.path] && workdirDiff[wt.path] === undefined}
                      <p class="muted small nopad">Loading diff…</p>
                    {:else if workdirDiff[wt.path]}
                      <DiffViewer text={workdirDiff[wt.path]} />
                    {:else}
                      <p class="muted small nopad">Nothing unstaged.</p>
                    {/if}
                  {:else}
                    {#if diffLoading[wt.path] && stagedDiff[wt.path] === undefined}
                      <p class="muted small nopad">Loading diff…</p>
                    {:else if stagedDiff[wt.path]}
                      <DiffViewer text={stagedDiff[wt.path]} />
                    {:else}
                      <p class="muted small nopad">Nothing staged.</p>
                    {/if}
                  {/if}

                  <h3 class="commits-heading">History</h3>
                  <div class="commits">
                    {#if commitsLoading[wt.path] && !commitsByPath[wt.path]}
                      <p class="muted small nopad">Loading…</p>
                    {:else if commitsByPath[wt.path]}
                      {#each commitsByPath[wt.path] as c (c.sha)}
                        <button
                          class="commit-row"
                          class:open={openCommitSha[wt.path] === c.sha}
                          on:click={() => openCommit(wt.path, c.sha)}
                        >
                          <code class="sha">{c.shortSha}</code>
                          <span class="commit-subject">{c.subject}</span>
                          <span class="commit-author">{c.author}</span>
                          <span class="commit-time">{relTime(c.time)}</span>
                        </button>
                        {#if openCommitSha[wt.path] === c.sha}
                          {#if commitDiff[`${wt.path}:${c.sha}`] !== undefined}
                            <div class="inline-commit">
                              <DiffViewer text={commitDiff[`${wt.path}:${c.sha}`]} />
                            </div>
                          {:else}
                            <p class="muted small nopad">Loading commit…</p>
                          {/if}
                        {/if}
                      {/each}
                      {#if !commitsExhausted[wt.path]}
                        <button
                          class="tiny load-more"
                          on:click={() => loadMoreCommits(wt.path)}
                          disabled={commitsLoading[wt.path]}
                          >{commitsLoading[wt.path] ? "Loading…" : "Load more"}</button
                        >
                      {:else}
                        <span class="muted small">— end of history</span>
                      {/if}
                    {/if}
                  </div>
                </div>
              {/if}
            {/if}
          {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  :global(body) {
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      system-ui,
      sans-serif;
    margin: 0;
    background: var(--surface-0);
    color: var(--text-1);
  }
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 1.5rem;
    min-width: 0;
  }
  header {
    margin-bottom: 1.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .brand-mark {
    height: 1.6rem;
    width: auto;
    display: inline-block;
  }
  .live {
    font-size: 0.75rem;
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }
  .live.on {
    color: var(--status-clean);
  }

  /* Actions popover */
  .actions-anchor {
    position: relative;
    margin-left: auto;
  }
  .actions-btn {
    padding: 0.4rem 0.75rem;
    background: var(--surface-2);
    color: var(--text-2);
    border: 0;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .actions-btn:hover,
  .actions-btn.open {
    background: var(--surface-3);
    color: var(--text-1);
  }
  .actions-btn .count {
    background: var(--brand);
    color: white;
    padding: .4em 0.4em;
    border-radius: 999px;
    font-size: 0.7rem;
    min-width: 1.2rem;
    text-align: center;
  }
  .actions-popover {
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    width: 380px;
    max-width: 90vw;
    max-height: 520px;
    overflow: auto;
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.7rem;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .popover-head {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
  }

  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.8rem;
  }
  .nopad {
    margin: 0.5rem 0 0 0;
  }

  .add {
    display: flex;
    gap: 0.5rem;
    margin: 1rem 0 1.5rem;
    align-items: center;
  }
  input {
    flex: 1;
    padding: 0.55rem 0.75rem;
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    color: inherit;
    border-radius: var(--radius-md);
    font-family: inherit;
    font-size: 0.95rem;
  }
  input:focus {
    outline: none;
    border-color: var(--brand);
  }
  button {
    padding: 0.55rem 1rem;
    background: var(--surface-2);
    border: 0;
    color: inherit;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:hover:not(:disabled) {
    background: var(--surface-3);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--brand);
    color: white;
  }
  button.primary:hover:not(:disabled) {
    background: var(--brand-hover);
  }
  button.refresh {
    margin-left: auto;
  }
  button.tiny {
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
  }

  .error {
    background: var(--error-bg);
    color: var(--error-text);
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }

  /* Worktree rows */
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .row {
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-lg);
    padding: 0.65rem 0.75rem;
    margin: 0 0 0.6rem;
    min-width: 0;
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 0.5rem;
    align-items: start;
  }
  .row-left {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Stay pinned to the top of the row so the chevron sits next to the
       row header, not centered across the (much taller) expanded row. */
    height: 28px;
  }
  .row-content {
    min-width: 0;
  }
  .session-panel {
    margin-top: 0.5rem;
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: nowrap;
    min-width: 0;
  }
  .repo-chip {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
    padding: 0.18rem 0.55rem;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
  }
  .repo-chip:hover {
    filter: brightness(1.15);
  }
  .repo-chip .pencil {
    opacity: 0;
    font-size: 0.7rem;
  }
  .repo-chip:hover .pencil {
    opacity: 0.8;
  }
  .name-edit {
    padding: 0.15rem 0.4rem;
    font-size: 0.85rem;
    background: var(--surface-1);
    border: 1px solid var(--brand);
    border-radius: var(--radius-sm);
    color: inherit;
    width: auto;
    max-width: 240px;
    flex: 0 0 auto;
  }
  .wt-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
    font-size: 0.82rem;
    color: var(--text-3);
  }
  .branch {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .branch.detached {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .branch.bare {
    background: var(--chip-indigo-bg);
    color: var(--chip-grey-text);
  }
  .branch.warn {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .agent-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    text-transform: lowercase;
    border: 0;
    cursor: pointer;
  }
  .agent-badge:hover {
    filter: brightness(1.15);
  }
  .agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .agent-badge.agent-claude {
    background: var(--chip-purple-bg);
    color: var(--chip-purple-text);
  }
  .agent-badge.agent-codex {
    background: var(--chip-green-bg);
    color: var(--chip-green-text);
  }
  .agent-badge.agent-copilot {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .agent-extra {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 999px;
    padding: 0 0.35rem;
    font-size: 0.65rem;
  }
  .row-activity {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
    padding: 0.25rem 0.5rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: 0.74rem;
    color: var(--text-3);
    min-width: 0;
  }
  .row-activity .agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .row-activity .agent-dot.agent-claude {
    background: var(--chip-purple-text);
  }
  .row-activity .agent-dot.agent-codex {
    background: var(--chip-green-text);
  }
  .row-activity .agent-dot.agent-copilot {
    background: var(--chip-blue-text);
  }
  .activity-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity-time {
    flex: 0 0 auto;
    font-size: 0.7rem;
  }
  .remove {
    background: transparent;
    color: var(--text-muted);
    padding: 0.15rem 0.5rem;
    font-size: 1.05rem;
    line-height: 1;
    flex: 0 0 auto;
  }
  .remove:hover {
    background: var(--error-bg);
    color: var(--error-text);
  }

  .row-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-dirty);
    display: inline-block;
  }
  .status-dot.clean {
    background: var(--status-clean);
  }
  .ab {
    background: var(--chip-indigo-bg);
    color: var(--chip-indigo-text);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
  }
  .row-actions {
    margin-left: auto;
    display: flex;
    gap: 0.3rem;
  }

  .row-commit {
    margin-top: 0.45rem;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    overflow: hidden;
  }
  .sha {
    font-family: ui-monospace, monospace;
    color: var(--text-5);
  }
  .commit-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .commit-author,
  .commit-time {
    white-space: nowrap;
  }

  /* Expanded section */
  .expanded {
    margin-top: 0.6rem;
    padding-left: 0.8rem;
    border-left: 2px solid var(--surface-2);
    min-width: 0;
  }
  .tabs-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
  }
  .ctx-toggle {
    padding: 0.25rem 0.6rem;
    background: var(--surface-2);
    color: var(--text-muted);
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
  }
  .ctx-toggle:hover {
    color: var(--text-2);
  }
  .ctx-toggle.active {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .tab {
    padding: 0.25rem 0.6rem;
    background: var(--surface-2);
    border: 0;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .tab:hover {
    color: var(--text-2);
  }
  .tab.active {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .tab-count {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 999px;
    padding: 0 0.4rem;
    font-size: 0.7rem;
  }

  .commits-heading {
    margin: 0.85rem 0 0.3rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .commits {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }
  .commit-row {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
    color: var(--text-4);
    overflow: hidden;
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    width: 100%;
  }
  .commit-row:hover {
    background: var(--surface-2);
  }
  .commit-row.open {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .inline-commit {
    margin: 0.15rem 0.5rem 0.4rem 1.6rem;
  }
  .load-more {
    margin-top: 0.4rem;
    align-self: flex-start;
  }

  .chevron {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    margin: 0;
    background: transparent;
    border: 0;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: var(--radius-sm);
    flex: 0 0 auto;
    font-size: 0.85rem;
    line-height: 1;
  }
  .chevron:hover {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .chevron .arrow {
    display: inline-block;
    line-height: 1;
    transition: transform 0.15s ease-out;
  }
  .chevron.open .arrow {
    transform: rotate(180deg);
  }

  /* Events list inside the popover */
  .events {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .events > li {
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.65rem;
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
  }
  .events > li.undone {
    opacity: 0.55;
  }
  .ev-row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
  }
  .ev-type {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .ev-time {
    font-size: 0.72rem;
    white-space: nowrap;
  }
  .ev-meta {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.3rem;
  }
  .actor {
    font-size: 0.68rem;
    padding: 0.08rem 0.45rem;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .actor-user {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .actor-agent {
    background: var(--chip-purple-bg);
    color: var(--chip-purple-text);
  }
  .actor-supergit {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .undo {
    margin-left: auto;
    padding: 0.18rem 0.55rem;
    font-size: 0.72rem;
    background: var(--surface-2);
  }
  .undo:hover {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
</style>
