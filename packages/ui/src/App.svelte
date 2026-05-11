<script lang="ts">
  import { onMount } from "svelte";

  interface Worktree {
    path: string;
    branch: string;
    head: string;
    bare: boolean;
    detached: boolean;
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
    payload: unknown;
    inverse?: unknown;
    undone: boolean;
    reversible: boolean;
  }

  let repos: Repo[] = [];
  let events: Event[] = [];
  let newRepoPath = "";
  let loading = false;
  let error = "";

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
      if (res.status === 204) return; // cancelled
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

  async function undoEvent(id: string) {
    error = "";
    try {
      const res = await fetch(`/api/events/${id}/undo`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function eventLabel(ev: Event): string {
    if (ev.type === "add_repo") {
      const p = (ev.payload as { path?: string })?.path ?? "";
      return `Added ${p}`;
    }
    if (ev.type === "remove_repo") {
      const inv = ev.inverse as { repo?: { name?: string; path?: string } } | undefined;
      const label = inv?.repo?.name ?? inv?.repo?.path ?? "(unknown)";
      return `Removed ${label}`;
    }
    if (ev.type === "undo") {
      return `Undo of ${(ev.payload as { eventId?: string })?.eventId ?? "?"}`;
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

  onMount(load);
</script>

<main>
  <header>
    <h1>supergit</h1>
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
                <strong>{repo.name}</strong>
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
                    <li>
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
      {#if events.length === 0}
        <p class="muted">No actions yet.</p>
      {:else}
        <ul class="events">
          {#each events.slice(0, 20) as ev (ev.id)}
            <li class:undone={ev.undone}>
              <div class="ev-row">
                <span class="ev-type">{eventLabel(ev)}</span>
                <span class="muted ev-time">{relTime(ev.timestamp)}</span>
              </div>
              <div class="ev-meta">
                <span class="actor actor-{ev.actor}">{ev.actor}</span>
                {#if ev.undone}
                  <span class="badge">undone</span>
                {:else if ev.reversible}
                  <button class="undo" on:click={() => undoEvent(ev.id)}
                    >Undo</button
                  >
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
  .worktrees li {
    padding: 0.45rem 0;
    border-top: 1px solid #2a2a2b;
    display: flex;
    gap: 1rem;
    align-items: center;
  }
  .wt-path {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
    color: #c0c0c0;
    overflow-wrap: anywhere;
  }
  .branch {
    background: #1a3a5a;
    color: #aacdef;
    padding: 0.1rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-left: auto;
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
  .badge {
    font-size: 0.7rem;
    color: #888;
  }
  .undo {
    margin-left: auto;
    padding: 0.2rem 0.6rem;
    font-size: 0.75rem;
    background: #2a2a2b;
  }
  .undo:hover {
    background: #3a2a1a;
    color: #efcdaa;
  }
</style>
