<script lang="ts">
  import { activeCopy, closeCopy } from "./copy-session-dialog";

  interface WorkspaceInfo {
    name: string;
    path: string;
  }

  let workspaces: WorkspaceInfo[] = [];
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
    void loadWorkspaces();
  }
  $: if (!$activeCopy) lastSource = null;

  async function loadWorkspaces() {
    loading = true;
    try {
      const res = await fetch("/api/workspaces");
      if (!res.ok) return;
      const body = (await res.json()) as { workspaces?: WorkspaceInfo[] };
      workspaces = body.workspaces ?? [];
    } catch {
      workspaces = [];
    } finally {
      loading = false;
    }
  }

  async function copyTo(ws: WorkspaceInfo) {
    if (!$activeCopy || copying) return;
    copying = true;
    result = { kind: "idle" };
    try {
      const res = await fetch("/api/sessions/copy-to-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: $activeCopy.source,
          targetWorkspace: ws.path,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; copiedTo?: string; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        result = { kind: "error", message: body?.error ?? `HTTP ${res.status}` };
        return;
      }
      result = {
        kind: "ok",
        copiedTo: body.copiedTo ?? ws.path,
      };
      setTimeout(() => closeCopy(), 1500);
    } catch (e) {
      result = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    } finally {
      copying = false;
    }
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
        Copy this session to another workspace so you can resume it
        there. Paths are rewritten automatically if the repo lives at
        a different location.
      </p>

      {#if loading}
        <p class="copy-loading">Loading workspaces…</p>
      {:else if workspaces.length === 0}
        <p class="copy-empty">
          No other workspaces found. Create a workspace under
          <code>~/supergit/workspaces/</code> and add the same repo
          to it, then this dialog will list it here.
        </p>
      {:else}
        <ul class="copy-list">
          {#each workspaces as ws (ws.path)}
            <li>
              <button
                type="button"
                class="copy-ws-btn"
                disabled={copying}
                on:click={() => copyTo(ws)}
              >
                <span class="copy-ws-name">{ws.name}</span>
                <span class="copy-ws-path">{ws.path}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if result.kind === "error"}
        <p class="copy-result copy-err" role="alert">{result.message}</p>
      {:else if result.kind === "ok"}
        <p class="copy-result copy-ok">
          Copied. You can resume this session from the target workspace.
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
    padding: 0.5rem 0.6rem;
    background: color-mix(in srgb, var(--surface-2) 25%, transparent);
    border-radius: 4px;
    line-height: 1.4;
  }
  .copy-empty code {
    font-size: 0.78rem;
  }
  .copy-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 240px;
    overflow-y: auto;
  }
  .copy-ws-btn {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    padding: 0.55rem 0.65rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
    background: color-mix(in srgb, var(--surface-2) 35%, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .copy-ws-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    border-color: color-mix(in srgb, var(--text-muted) 50%, transparent);
  }
  .copy-ws-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .copy-ws-name {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text-1, inherit);
  }
  .copy-ws-path {
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
