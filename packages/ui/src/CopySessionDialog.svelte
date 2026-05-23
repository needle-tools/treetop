<script lang="ts">
  import { activeCopy, closeCopy } from "./copy-session-dialog";

  interface Worktree {
    path: string;
    branch: string;
  }
  interface RepoGroup {
    repoName: string;
    repoPath: string;
    worktrees: Worktree[];
  }

  let targets: RepoGroup[] = [];
  let loading = false;
  let copying = false;
  let result:
    | { kind: "idle" }
    | { kind: "ok"; copiedTo: string }
    | { kind: "error"; message: string } = { kind: "idle" };

  let lastSource: string | null = null;
  $: if ($activeCopy && $activeCopy.source !== lastSource) {
    lastSource = $activeCopy.source;
    copying = false;
    result = { kind: "idle" };
    void loadTargets();
  }
  $: if (!$activeCopy) lastSource = null;

  async function loadTargets() {
    loading = true;
    try {
      const res = await fetch("/api/copy-targets");
      if (!res.ok) return;
      const body = (await res.json()) as { targets?: RepoGroup[] };
      targets = body.targets ?? [];
    } catch {
      targets = [];
    } finally {
      loading = false;
    }
  }

  async function copyTo(wt: Worktree) {
    if (!$activeCopy || copying) return;
    copying = true;
    result = { kind: "idle" };
    try {
      const res = await fetch("/api/sessions/copy-to", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: $activeCopy.source,
          targetCwd: wt.path,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; copiedTo?: string; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        result = { kind: "error", message: body?.error ?? `HTTP ${res.status}` };
        return;
      }
      result = { kind: "ok", copiedTo: body.copiedTo ?? wt.path };
      setTimeout(() => closeCopy(), 1500);
    } catch (e) {
      result = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    } finally {
      copying = false;
    }
  }

  function shortPath(wt: Worktree): string {
    const parts = wt.path.replace(/\\/g, "/").split("/");
    return parts.slice(-2).join("/");
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!$activeCopy) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeCopy();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $activeCopy}
  <div
    class="copy-overlay"
    on:click={closeCopy}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="copy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="copy-title"
      on:click|stopPropagation
    >
      <h2 id="copy-title" class="copy-title">Copy to</h2>
      <p class="copy-blurb">
        Copy this session to another worktree so you can resume it
        there. Paths are rewritten automatically.
      </p>

      {#if loading}
        <p class="copy-loading">Loading…</p>
      {:else if targets.length === 0}
        <p class="copy-empty">No repos found in this workspace.</p>
      {:else}
        <div class="copy-targets">
          {#each targets as group (group.repoPath)}
            <div class="copy-group">
              <span class="copy-repo-name">{group.repoName}</span>
              <ul class="copy-wt-list">
                {#each group.worktrees as wt (wt.path)}
                  <li>
                    <button
                      type="button"
                      class="copy-wt-btn"
                      disabled={copying}
                      on:click={() => copyTo(wt)}
                      title={wt.path}
                    >
                      <span class="copy-wt-branch">{wt.branch || shortPath(wt)}</span>
                      <span class="copy-wt-path">{shortPath(wt)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}

      {#if result.kind === "error"}
        <p class="copy-result copy-err" role="alert">{result.message}</p>
      {:else if result.kind === "ok"}
        <p class="copy-result copy-ok">
          Copied. You can resume this session from that worktree now.
        </p>
      {/if}

      <div class="copy-buttons">
        <button type="button" class="copy-btn" on:click={closeCopy}>
          {result.kind === "ok" ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .copy-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .copy-dialog {
    min-width: 380px;
    max-width: min(520px, 92vw);
    max-height: 80vh;
    overflow-y: auto;
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .copy-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .copy-blurb {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .copy-loading,
  .copy-empty {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .copy-targets {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .copy-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .copy-repo-name {
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--text-muted);
    padding-left: 0.1rem;
  }
  .copy-wt-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .copy-wt-btn {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
    background: color-mix(in srgb, var(--surface-2) 35%, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .copy-wt-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    border-color: color-mix(in srgb, var(--text-muted) 50%, transparent);
  }
  .copy-wt-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .copy-wt-branch {
    font-weight: 500;
    font-size: 0.83rem;
    color: var(--text-1, inherit);
  }
  .copy-wt-path {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .copy-result {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.4;
    padding: 0.5rem 0.6rem;
    border-radius: 4px;
  }
  .copy-ok {
    background: color-mix(in srgb, #2ecc71 18%, transparent);
    color: color-mix(in srgb, #2ecc71 80%, var(--text));
  }
  .copy-err {
    background: color-mix(in srgb, #c0392b 22%, transparent);
    color: #fff;
  }
  .copy-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }
  .copy-btn {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .copy-btn:hover,
  .copy-btn:focus-visible {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
    outline: none;
  }
</style>
