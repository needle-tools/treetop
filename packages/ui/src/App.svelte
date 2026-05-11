<script lang="ts">
  import { onMount } from "svelte";
  import { ExpandedStore } from "./storage";

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

  interface Worktree {
    path: string;
    branch: string;
    head: string;
    bare: boolean;
    detached: boolean;
    fileStatus: FileStatus;
    branchStatus: BranchStatus | null;
    lastCommit: LastCommit | null;
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

  // commit history per worktree-path: list, expanded flag, loading flag, done flag
  let commitsByPath: Record<string, LastCommit[]> = {};
  let commitsExpanded: Record<string, boolean> = {};
  let commitsLoading: Record<string, boolean> = {};
  let commitsExhausted: Record<string, boolean> = {};
  const COMMITS_BATCH = 10;
  const expandedStore = new ExpandedStore(
    typeof window !== "undefined" ? window.localStorage : ({ getItem: () => null, setItem: () => {} }),
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
      const res = await fetch(`/api/events/${id}/${toggle}`, { method: "POST" });
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

  async function fetchCommits(wtPath: string, before?: string): Promise<LastCommit[]> {
    const qs = new URLSearchParams({ path: wtPath, limit: String(COMMITS_BATCH) });
    if (before) qs.set("before", before);
    const res = await fetch(`/api/commits?${qs.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
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

  async function toggleCommits(wtPath: string) {
    error = "";
    const willExpand = !commitsExpanded[wtPath];
    commitsExpanded = { ...commitsExpanded, [wtPath]: willExpand };
    persistExpanded();
    if (willExpand) await loadCommitsInitial(wtPath);
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

  async function loadEditors() {
    try {
      const res = await fetch("/api/editors");
      if (!res.ok) return;
      editors = await res.json();
    } catch {
      // Ignore — open buttons just won't render until reload succeeds.
    }
  }

  function subscribeToStream(): () => void {
    const es = new EventSource("/api/stream");
    es.addEventListener("change", () => {
      void load();
    });
    es.onopen = () => {
      streamConnected = true;
    };
    es.onerror = () => {
      streamConnected = false;
      // EventSource auto-reconnects; no manual retry needed.
    };
    return () => es.close();
  }

  function eventLabel(ev: Event): string {
    if (ev.type === "add_repo") {
      const inv = ev.inverse as { repo?: { name?: string; path?: string } } | undefined;
      const name = inv?.repo?.name ?? (ev.payload?.path as string | undefined)?.split("/").filter(Boolean).pop();
      return `Added ${name ?? "(unknown)"}`;
    }
    if (ev.type === "remove_repo") {
      const inv = ev.inverse as { repo?: { name?: string; path?: string } } | undefined;
      const name = inv?.repo?.name ?? inv?.repo?.path;
      return `Removed ${name ?? "(unknown)"}`;
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

  // Only show real actions in the history; hide the undo/redo toggle events
  // (they're computed into the `undone` flag on the original action).
  $: visibleEvents = events.filter(
    (e) => e.type !== "undo" && e.type !== "redo",
  );

  onMount(() => {
    restoreExpanded();
    void loadEditors();
    void load().then(() => {
      // Fetch commits for any worktree that was expanded before reload.
      for (const [path, expanded] of Object.entries(commitsExpanded)) {
        if (expanded) void loadCommitsInitial(path);
      }
    });
    return subscribeToStream();
  });
</script>

<main>
  <header>
    <h1>
      supergit
      <span class="live" class:on={streamConnected} title={streamConnected ? "live (SSE connected)" : "offline (SSE disconnected)"}>
        {streamConnected ? "● live" : "○ offline"}
      </span>
    </h1>
    <p class="muted">v0 — dashboard for repos, worktrees, and recent actions</p>
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

  <div class="columns">
    <section class="repos-col">
      <h2>Repos</h2>
      {#if loading && repos.length === 0}
        <p class="muted">Loading…</p>
      {:else if repos.length === 0}
        <p class="muted">No repos registered yet.</p>
      {:else}
        <ul class="repos">
          {#each repos as repo (repo.id)}
            <li>
              <div class="repo-header">
                {#if editingRepoId === repo.id}
                  <input
                    class="name-edit"
                    bind:value={editRepoName}
                    autofocus
                    on:keydown={(e) => {
                      if (e.key === "Enter") commitRenameRepo(repo.id);
                      if (e.key === "Escape") cancelRenameRepo();
                    }}
                    on:blur={() => commitRenameRepo(repo.id)}
                  />
                {:else}
                  <button
                    class="name-btn"
                    title="Click to rename"
                    on:click={() => startRenameRepo(repo)}
                  >
                    <strong>{repo.name}</strong>
                    <span class="pencil">✎</span>
                  </button>
                {/if}
                <span class="muted path">{repo.path}</span>
                <button
                  class="remove"
                  title="Remove from workspace"
                  on:click={() => removeRepo(repo.id)}>×</button
                >
              </div>
              {#if repo.worktrees.length > 0}
                <ul class="worktrees">
                  {#each repo.worktrees as wt}
                    {@const summary = statusSummary(wt.fileStatus)}
                    <li class="wt">
                      <div class="wt-row1">
                        <code class="wt-path">{wt.path}</code>
                        {#if wt.detached}
                          <span class="branch detached"
                            >detached @ {wt.head.slice(0, 7)}</span
                          >
                        {:else if wt.bare}
                          <span class="branch bare">bare</span>
                        {:else}
                          <span class="branch">{wt.branch}</span>
                        {/if}
                      </div>

                      <div class="wt-row2">
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
                            <span class="muted small ab-clean">in sync</span>
                          {/if}
                        {:else if !wt.detached && !wt.bare && wt.branchStatus}
                          <span class="muted small">no upstream</span>
                        {/if}

                        <div class="wt-actions">
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
                        <div class="wt-row3 muted small">
                          <code class="sha">{wt.lastCommit.shortSha}</code>
                          <span class="commit-subject">{wt.lastCommit.subject}</span>
                          <span class="commit-author">— {wt.lastCommit.author}</span>
                          <span class="commit-time">{relTime(wt.lastCommit.time)}</span>
                        </div>

                        {#if commitsExpanded[wt.path]}
                          <div class="commits">
                            {#if commitsLoading[wt.path] && !commitsByPath[wt.path]}
                              <p class="muted small nopad">Loading…</p>
                            {:else if commitsByPath[wt.path]}
                              {#each commitsByPath[wt.path] as c (c.sha)}
                                <div class="commit-row">
                                  <code class="sha">{c.shortSha}</code>
                                  <span class="commit-subject">{c.subject}</span>
                                  <span class="commit-author">— {c.author}</span>
                                  <span class="commit-time">{relTime(c.time)}</span>
                                </div>
                              {/each}
                              {#if !commitsExhausted[wt.path]}
                                <button
                                  class="tiny load-more"
                                  on:click={() => loadMoreCommits(wt.path)}
                                  disabled={commitsLoading[wt.path]}
                                >{commitsLoading[wt.path] ? "Loading…" : "Load more"}</button>
                              {:else}
                                <span class="muted small">— end of history</span>
                              {/if}
                            {/if}
                          </div>
                        {/if}

                        <button
                          class="chevron"
                          class:open={commitsExpanded[wt.path]}
                          title={commitsExpanded[wt.path] ? "Hide history" : "Show history"}
                          aria-label={commitsExpanded[wt.path] ? "Hide history" : "Show history"}
                          on:click={() => toggleCommits(wt.path)}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="muted nopad">No worktrees detected.</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="events-col">
      <h2>Recent actions</h2>
      {#if visibleEvents.length === 0}
        <p class="muted">No actions yet.</p>
      {:else}
        <ul class="events">
          {#each visibleEvents.slice(0, 30) as ev (ev.id)}
            <li class:undone={ev.undone}>
              <div class="ev-row">
                <span class="ev-type">{eventLabel(ev)}</span>
                <span class="muted ev-time">{relTime(ev.timestamp)}</span>
              </div>
              <div class="ev-meta">
                <span class="actor actor-{ev.actor}">{ev.actor}</span>
                {#if ev.reversible}
                  {#if ev.undone}
                    <button class="redo" on:click={() => toggleEvent(ev.id, "redo")}
                      >Redo</button
                    >
                  {:else}
                    <button class="undo" on:click={() => toggleEvent(ev.id, "undo")}
                      >Undo</button
                    >
                  {/if}
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</main>

<style>
  :global(body) {
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      system-ui,
      sans-serif;
    margin: 0;
    background: #0f0f10;
    color: #e8e8e8;
  }
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }
  header {
    margin-bottom: 1.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.01em;
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }
  .live {
    font-size: 0.75rem;
    color: #666;
    letter-spacing: 0.04em;
  }
  .live.on {
    color: #16a34a;
  }
  h2 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
  }
  .muted {
    color: #888;
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
    background: #1a1a1b;
    border: 1px solid #2a2a2b;
    color: inherit;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.95rem;
  }
  input:focus {
    outline: none;
    border-color: #2563eb;
  }
  button {
    padding: 0.55rem 1rem;
    background: #2a2a2b;
    border: 0;
    color: inherit;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:hover:not(:disabled) {
    background: #333;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.primary {
    background: #2563eb;
    color: white;
  }
  button.primary:hover:not(:disabled) {
    background: #3175f0;
  }
  button.refresh {
    margin-left: auto;
  }
  button.tiny {
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
  }
  .error {
    background: #3f1f1f;
    color: #ffaaaa;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }
  .columns {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 1.5rem;
  }
  @media (max-width: 800px) {
    .columns {
      grid-template-columns: 1fr;
    }
  }
  .repos {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .repos > li {
    background: #1a1a1b;
    border: 1px solid #2a2a2b;
    border-radius: 8px;
    padding: 1rem 1.1rem;
    margin: 0 0 0.75rem;
  }
  .repo-header {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
  }
  .repo-header strong {
    font-size: 1rem;
  }
  .name-btn {
    background: transparent;
    border: 0;
    color: inherit;
    padding: 0.1rem 0.3rem;
    margin: 0 0 0 -0.3rem;
    border-radius: 4px;
    cursor: text;
    font: inherit;
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
  }
  .name-btn:hover {
    background: #2a2a2b;
  }
  .name-btn .pencil {
    color: #666;
    font-size: 0.8rem;
    opacity: 0;
  }
  .name-btn:hover .pencil {
    opacity: 1;
  }
  .name-edit {
    padding: 0.15rem 0.4rem;
    font-size: 1rem;
    font-weight: 700;
    background: #1a1a1b;
    border: 1px solid #2563eb;
    border-radius: 4px;
    color: inherit;
    width: auto;
    max-width: 240px;
    flex: 0 0 auto;
  }
  .path {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .remove {
    margin-left: auto;
    background: transparent;
    color: #888;
    padding: 0.2rem 0.55rem;
    font-size: 1.1rem;
    line-height: 1;
  }
  .remove:hover {
    background: #3f1f1f;
    color: #ffaaaa;
  }
  .worktrees {
    list-style: none;
    padding: 0;
    margin: 0.6rem 0 0;
  }
  .wt {
    padding: 0.6rem 0;
    border-top: 1px solid #2a2a2b;
  }
  .wt-row1 {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .wt-row2 {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.35rem;
  }
  .wt-row3 {
    margin-top: 0.35rem;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    overflow: hidden;
  }
  .wt-path {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    color: #c0c0c0;
    overflow-wrap: anywhere;
    flex: 1;
  }
  .branch {
    background: #1a3a5a;
    color: #aacdef;
    padding: 0.1rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    white-space: nowrap;
  }
  .branch.detached {
    background: #3a2a1a;
    color: #efcdaa;
  }
  .branch.bare {
    background: #2a2a3a;
    color: #aaaacc;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #d97706;
    display: inline-block;
  }
  .status-dot.clean {
    background: #16a34a;
  }
  .ab {
    background: #2a2a3a;
    color: #d8d8ff;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
  }
  .ab-clean {
    margin-left: 0;
  }
  .wt-actions {
    margin-left: auto;
    display: flex;
    gap: 0.3rem;
  }
  .sha {
    font-family: ui-monospace, monospace;
    color: #a0a0a0;
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
  .chevron {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    margin-top: 0.4rem;
    padding: 0.3rem 0;
    background: transparent;
    border: 0;
    border-top: 1px dashed transparent;
    color: #666;
    cursor: pointer;
    border-radius: 4px;
  }
  .chevron:hover {
    background: #232325;
    color: #d0d0d0;
    border-top-color: #2a2a2b;
  }
  .chevron svg {
    transition: transform 0.15s ease-out;
  }
  .chevron.open svg {
    transform: rotate(180deg);
  }
  .commits {
    margin-top: 0.5rem;
    padding-left: 0.8rem;
    border-left: 2px solid #2a2a2b;
  }
  .commit-row {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.2rem 0;
    font-size: 0.8rem;
    color: #b0b0b0;
    overflow: hidden;
  }
  .load-more {
    margin-top: 0.4rem;
  }
  .events {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .events > li {
    background: #1a1a1b;
    border: 1px solid #2a2a2b;
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
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
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .ev-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.35rem;
  }
  .actor {
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .actor-user {
    background: #1a3a5a;
    color: #aacdef;
  }
  .actor-agent {
    background: #3a1a3a;
    color: #efaaef;
  }
  .actor-supergit {
    background: #2a2a2b;
    color: #c0c0c0;
  }
  .undo,
  .redo {
    margin-left: auto;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    background: #2a2a2b;
  }
  .undo:hover {
    background: #3a2a1a;
    color: #efcdaa;
  }
  .redo:hover {
    background: #1a3a2a;
    color: #cdefaa;
  }
</style>
