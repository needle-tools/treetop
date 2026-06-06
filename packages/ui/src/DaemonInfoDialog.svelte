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
    user?: string;
  } | null = null;
  /** Repos/folders tracked on this daemon. */
  export let repos: Array<{ id: string; name: string; path: string }> = [];
  /** Tunnel reachability, when known. */
  export let online: boolean | undefined = undefined;
  /** Run the (double-confirmed) removal. May be async. */
  export let onRemove: () => void | Promise<void> = () => {};
  /** Uninstall the daemon ON the box (stop+remove the service over SSH), then
   *  remove it here. Distinct from onRemove, which only forgets it locally. */
  export let onUninstall: () => void | Promise<void> = () => {};
  /** Scroll the dashboard to a folder's row (and close this dialog). */
  export let onFocus: (repo: { id: string }) => void = () => {};
  export let onClose: () => void = () => {};

  type ConnectionDiagnosis = {
    ok: boolean;
    localPort: number | null;
    reachable: boolean;
    latencyMs: number | null;
    steps: Array<{ label: string; ok: boolean; detail: string }>;
    summary: string;
  };
  /** Tear down + reopen the SSH tunnel (fixes a stale post-sleep tunnel). */
  export let onReconnect: () => Promise<{ ok: boolean; error?: string }> =
    async () => ({ ok: true });
  /** Run a connection diagnosis (ssh → tunnel → health checklist). */
  export let onDiagnose: () => Promise<ConnectionDiagnosis> = async () => ({
    ok: true,
    localPort: null,
    reachable: true,
    latencyMs: null,
    steps: [],
    summary: "",
  });

  let busy = false;
  let reconnecting = false;
  let diagnosing = false;
  let diagnosis: ConnectionDiagnosis | null = null;
  let connMsg: { kind: "ok" | "error"; text: string } | null = null;

  async function reconnect(): Promise<void> {
    if (busy || reconnecting) return;
    reconnecting = true;
    connMsg = null;
    diagnosis = null;
    try {
      const r = await onReconnect();
      connMsg = r.ok
        ? { kind: "ok", text: "Reconnected." }
        : { kind: "error", text: r.error || "Reconnect failed." };
    } catch (e) {
      connMsg = {
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      };
    } finally {
      reconnecting = false;
    }
  }

  async function diagnose(): Promise<void> {
    if (busy || diagnosing) return;
    diagnosing = true;
    connMsg = null;
    try {
      diagnosis = await onDiagnose();
    } catch (e) {
      diagnosis = null;
      connMsg = {
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      };
    } finally {
      diagnosing = false;
    }
  }

  // Forget any connection result when the dialog is reopened for a daemon.
  $: if (!open) {
    diagnosis = null;
    connMsg = null;
  }

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

  async function uninstall(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await onUninstall();
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
        {#if daemon.user}<span
            class="dd-user"
            class:root={daemon.user === "root"}
            title={daemon.user === "root"
              ? "runs as root — full access to the box"
              : `runs as ${daemon.user}`}>{daemon.user}</span
          >{/if}
        {#if online === true}<span class="dd-status online">online</span>
        {:else if online === false}<span class="dd-status offline"
            >offline</span
          >{/if}
      </p>

      <div class="dd-section">
        <span class="dd-section-label">Connection</span>
        <div class="dd-conn-actions">
          <button
            class="dd-conn-btn"
            on:click={reconnect}
            disabled={busy || reconnecting || diagnosing}
            title="Tear down and reopen the SSH tunnel (fixes a stale tunnel after sleep)"
          >
            {reconnecting ? "Reconnecting…" : "Reconnect"}
          </button>
          <button
            class="dd-conn-btn"
            on:click={diagnose}
            disabled={busy || reconnecting || diagnosing}
            title="Check ssh, the tunnel, and the remote daemon's health"
          >
            {diagnosing ? "Diagnosing…" : "Diagnose connection"}
          </button>
        </div>
        {#if connMsg}
          <p class="dd-conn-msg" class:err={connMsg.kind === "error"}>
            {connMsg.text}
          </p>
        {/if}
        {#if diagnosis}
          <div class="dd-diag" class:ok={diagnosis.ok}>
            <p class="dd-diag-summary">{diagnosis.summary}</p>
            <ul class="dd-diag-steps">
              {#each diagnosis.steps as s (s.label)}
                <li class="dd-diag-step">
                  <span class="dd-diag-mark" class:bad={!s.ok}
                    >{s.ok ? "✓" : "✗"}</span
                  >
                  <span class="dd-diag-label">{s.label}</span>
                  <span class="dd-diag-detail">{s.detail}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>

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
        <button
          class="dd-uninstall"
          on:click={uninstall}
          disabled={busy}
          title="SSH in and run the uninstaller on the box, then remove it here"
        >
          Uninstall on box
        </button>
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
  .dd-user {
    font-size: var(--fs-sm);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
    color: var(--text-muted);
  }
  .dd-user.root {
    background: color-mix(in srgb, var(--error) 20%, transparent);
    color: var(--error-text, var(--error));
  }
  .dd-section {
    margin-bottom: 1rem;
  }
  .dd-conn-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .dd-conn-btn {
    font: inherit;
    font-size: var(--fs-md);
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .dd-conn-btn:hover:not(:disabled) {
    border-color: var(--brand);
  }
  .dd-conn-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .dd-conn-msg {
    margin: 0.5rem 0 0;
    font-size: var(--fs-md);
    color: #3fb950;
  }
  .dd-conn-msg.err {
    color: var(--error-text, var(--error));
  }
  .dd-diag {
    margin-top: 0.6rem;
    border: 1px solid var(--surface-2);
    border-left: 3px solid var(--error);
    border-radius: var(--radius-md);
    padding: 0.55rem 0.7rem;
  }
  .dd-diag.ok {
    border-left-color: #3fb950;
  }
  .dd-diag-summary {
    margin: 0 0 0.45rem;
    font-size: var(--fs-md);
  }
  .dd-diag-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .dd-diag-step {
    display: grid;
    grid-template-columns: 1rem auto 1fr;
    gap: 0.45rem;
    align-items: baseline;
    font-size: var(--fs-sm);
  }
  .dd-diag-mark {
    color: #3fb950;
    font-weight: 700;
  }
  .dd-diag-mark.bad {
    color: var(--error-text, var(--error));
  }
  .dd-diag-label {
    color: var(--text-3);
  }
  .dd-diag-detail {
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
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
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  /* Close stays on the left; the two destructive actions group on the right. */
  .dd-cancel {
    margin-right: auto;
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
  /* Uninstall touches the box — danger, but outlined (an extra, deliberate
     step) so it reads distinct from the local-only Remove. */
  .dd-uninstall {
    border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
    background: transparent;
    color: var(--error-text, var(--error));
  }
  .dd-uninstall:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 14%, transparent);
  }
</style>
