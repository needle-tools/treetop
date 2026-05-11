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

  let repos: Repo[] = [];
  let newRepoPath = "";
  let loading = false;
  let error = "";

  async function loadRepos() {
    loading = true;
    error = "";
    try {
      const res = await fetch("/api/repos");
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      repos = await res.json();
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
      await loadRepos();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function removeRepo(id: string) {
    error = "";
    try {
      const res = await fetch(`/api/repos/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        throw new Error(`HTTP ${res.status}`);
      }
      await loadRepos();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(loadRepos);
</script>

<main>
  <header>
    <h1>supergit</h1>
    <p class="muted">v0 — dashboard for repos and worktrees</p>
  </header>

  <section class="add">
    <input
      type="text"
      placeholder="/absolute/path/to/your/repo"
      bind:value={newRepoPath}
      on:keydown={(e) => e.key === "Enter" && addRepo()}
    />
    <button on:click={addRepo} disabled={!newRepoPath.trim()}>Add repo</button>
    <button class="refresh" on:click={loadRepos}>Refresh</button>
  </section>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading && repos.length === 0}
    <p class="muted">Loading…</p>
  {:else if repos.length === 0}
    <p class="muted">No repos registered yet. Add the absolute path to a git repo above.</p>
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
                    <span class="branch detached">detached @ {wt.head.slice(0, 7)}</span>
                  {:else if wt.bare}
                    <span class="branch bare">bare</span>
                  {:else}
                    <span class="branch">{wt.branch}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="muted nopad">No worktrees detected (is this a git repo?).</p>
          {/if}
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
    background: #0f0f10;
    color: #e8e8e8;
  }
  main {
    max-width: 960px;
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
    background: #2563eb;
    border: 0;
    color: white;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:hover:not(:disabled) {
    background: #3175f0;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.refresh {
    background: #2a2a2b;
  }
  button.refresh:hover {
    background: #333;
  }
  .error {
    background: #3f1f1f;
    color: #ffaaaa;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin: 0 0 1rem;
    font-size: 0.9rem;
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
    margin: 0.75rem 0;
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
</style>
