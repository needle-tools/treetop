<script lang="ts">
  /**
   * Centered "manage remote daemon" dialog, opened from the Daemons popover's
   * per-row "⋯" button. Shows the daemon's name + address and the folders
   * (repos) currently tracked on it, with a destructive "Remove daemon" action
   * at the bottom. Removal itself (and its double-confirm) is the parent's
   * `onRemove` — this component is just the presentation. Chrome mirrors
   * AddRemoteDaemonDialog / ConfirmDialog so the app's dialogs read as one
   * family; colours come from styles/tokens.css.
   */
  export let open = false;
  export let daemon: {
    id: string;
    label: string;
    host: string;
    port: number;
  } | null = null;
  /** Repos/folders tracked on this daemon. */
  export let repos: Array<{ id: string; name: string; path: string }> = [];
  /** Tunnel reachability, when known. */
  export let online: boolean | undefined = undefined;
  /** Run the (double-confirmed) removal. May be async. */
  export let onRemove: () => void | Promise<void> = () => {};
  /** Scroll the dashboard to a folder's row (and close this dialog). */
  export let onFocus: (repo: { id: string }) => void = () => {};
  export let onClose: () => void = () => {};

  let busy = false;

  function close(): void {
    if (busy) return;
    open = false;
    onClose();
  }

  async function remove(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await onRemove();
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
</script>

{#if open && daemon}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="dd-overlay" on:click={close}>
    <div
      class="dd-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Remote daemon"
      on:click|stopPropagation
      on:keydown={onKeydown}
    >
      <h2 class="dd-title">{daemon.label}</h2>
      <p class="dd-host">
        <span class="dd-addr">{daemon.host}:{daemon.port}</span>
        {#if online === true}<span class="dd-status online">online</span>
        {:else if online === false}<span class="dd-status offline"
            >offline</span
          >{/if}
      </p>

      <div class="dd-section">
        <span class="dd-section-label">Folders ({repos.length})</span>
        {#if repos.length === 0}
          <p class="dd-empty">No folders added on this daemon yet.</p>
        {:else}
          <ul class="dd-repos">
            {#each repos as r (r.id)}
              <li class="dd-repo">
                <span class="dd-repo-meta">
                  <span class="dd-repo-name">{r.name}</span>
                  <span class="dd-repo-path">{r.path}</span>
                </span>
                <button
                  class="dd-repo-focus"
                  title="Scroll to this folder"
                  aria-label="Scroll to this folder"
                  on:click={() => onFocus(r)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" />
                    <path
                      d="M8 1v2M8 13v2M1 8h2M13 8h2"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="dd-actions">
        <button class="dd-cancel" on:click={close} disabled={busy}>Close</button>
        <button class="dd-remove" on:click={remove} disabled={busy}>
          Remove daemon
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dd-overlay {
    position: fixed;
    inset: 0;
    background: var(--shadow-overlay);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .dd-modal {
    box-sizing: border-box;
    background: var(--surface-1);
    color: inherit;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 1rem 1.1rem 1.1rem;
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    overflow-y: auto;
    overflow-x: hidden;
    box-shadow: 0 12px 32px var(--shadow-overlay);
  }
  .dd-title {
    margin: 0 0 0.2rem;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .dd-host {
    margin: 0 0 0.9rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--fs-md);
    color: var(--text-muted);
  }
  .dd-addr {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .dd-status {
    font-size: var(--fs-sm);
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }
  .dd-status.online {
    color: #3fb950;
    background: color-mix(in srgb, #3fb950 16%, transparent);
  }
  .dd-status.offline {
    color: #f85149;
    background: color-mix(in srgb, #f85149 16%, transparent);
  }
  .dd-section {
    margin-bottom: 1rem;
  }
  .dd-section-label {
    display: block;
    font-size: var(--fs-md);
    color: var(--text-3);
    margin-bottom: 0.4rem;
  }
  .dd-empty {
    margin: 0;
    font-size: var(--fs-md);
    color: var(--text-faint);
  }
  .dd-repos {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 14rem;
    overflow-y: auto;
  }
  .dd-repo {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
  }
  .dd-repo-meta {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    flex: 1;
  }
  .dd-repo-focus {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--surface-2);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 0.25rem;
    cursor: pointer;
  }
  .dd-repo-focus:hover {
    color: inherit;
    border-color: var(--brand);
  }
  .dd-repo-name {
    font-size: var(--fs-lg);
  }
  .dd-repo-path {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
  }
  .dd-actions {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .dd-actions button {
    font: inherit;
    font-size: var(--fs-lg);
    padding: 0.35rem 0.8rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .dd-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .dd-cancel {
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
  }
  .dd-cancel:hover:not(:disabled) {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
  }
  /* Destructive: reddish tinted background + border. */
  .dd-remove {
    border: 1px solid color-mix(in srgb, var(--error) 50%, transparent);
    background: color-mix(in srgb, var(--error) 16%, transparent);
    color: var(--error-text, var(--error));
  }
  .dd-remove:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 28%, transparent);
    border-color: color-mix(in srgb, var(--error) 70%, transparent);
  }
</style>
