<script lang="ts">
  /**
   * "Add remote daemon" dialog (remote-daemon Phase C). Collects the
   * connection fields for a remote supergit daemon and, on submit, hands
   * a normalized payload to `onAdd`. Validation/normalization lives in the
   * pure `remote-daemon-form.ts` (unit-tested) — this component is just the
   * form shell + inline error display. The daemon re-validates server-side,
   * so this is UX, not the trust boundary.
   *
   * Mirrors the repo "Add folder" flow: a remote daemon shows up as a
   * folder row beside local repos once registered. See
   * plans/PLAN-REMOTE-DAEMON.md (UI Phase C).
   */
  import {
    emptyDaemonForm,
    normalizeDaemonForm,
    type DaemonFormFields,
    type DaemonFormPayload,
  } from "./remote-daemon-form";

  export let open = false;
  /** Called with the normalized payload when the user submits a valid
   *  form. May be async (the parent POSTs /api/daemons); while it runs the
   *  dialog shows a busy state and disables submit. Should throw on
   *  failure so the dialog can surface the error and stay open. */
  export let onAdd: (payload: DaemonFormPayload) => void | Promise<void>;
  /** Called with the raw connection string when the user pastes one and
   *  submits. Should POST /api/daemons/connect and throw on failure so the
   *  dialog surfaces the error + stays open. */
  export let onConnect: (connectionString: string) => void | Promise<void> = async () => {};
  export let onClose: () => void = () => {};

  let fields: DaemonFormFields = emptyDaemonForm();
  let errors: Partial<Record<keyof DaemonFormFields, string>> = {};
  let submitError = "";
  let busy = false;
  let connectionString = "";
  let showAdvanced = false;

  // Reset the form each time the dialog opens so a previous attempt's
  // values / errors don't linger.
  $: if (open) {
    // only reset on the open edge — guard with a sentinel
  }
  let wasOpen = false;
  $: if (open && !wasOpen) {
    fields = emptyDaemonForm();
    errors = {};
    submitError = "";
    busy = false;
    connectionString = "";
    showAdvanced = false;
    wasOpen = true;
  } else if (!open && wasOpen) {
    wasOpen = false;
  }

  function close(): void {
    if (busy) return;
    open = false;
    onClose();
  }

  async function submit(): Promise<void> {
    if (busy) return;
    submitError = "";
    busy = true;
    try {
      if (connectionString.trim()) {
        await onConnect(connectionString.trim());
        open = false;
        onClose();
      } else {
        const result = normalizeDaemonForm(fields);
        if (!result.ok) {
          errors = result.errors;
          busy = false;
          return;
        }
        errors = {};
        await onAdd(result.payload);
        open = false;
        onClose();
      }
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="add-daemon-overlay" on:click={close}>
    <div
      class="add-daemon-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Add remote daemon"
      on:click|stopPropagation
      on:keydown={onKeydown}
    >
      <h2 class="add-daemon-title">Add remote daemon</h2>
      <p class="add-daemon-blurb">
        Connect a supergit daemon running on another machine over an SSH
        tunnel. Its repos appear as folder rows beside your local ones.
      </p>

      <label class="add-daemon-field">
        <span>Connection string</span>
        <textarea
          bind:value={connectionString}
          placeholder="paste the supergit1:… string from the installer"
          autocomplete="off"
          spellcheck="false"
          rows="3"
          class="add-daemon-connstr"
        ></textarea>
        <small class="add-daemon-hint">Paste the string the installer printed — it fills in everything below.</small>
      </label>

      <details class="add-daemon-advanced" bind:open={showAdvanced}>
        <summary class="add-daemon-advanced-summary">Advanced — enter connection details manually</summary>

        <label class="add-daemon-field">
          <span>Host <span class="req">*</span></span>
          <input
            type="text"
            bind:value={fields.host}
            placeholder="hetzner.example.com or 1.2.3.4"
            autocomplete="off"
            spellcheck="false"
            class:invalid={!!errors.host}
          />
          {#if errors.host}<small class="err">{errors.host}</small>{/if}
        </label>

        <label class="add-daemon-field">
          <span>Label</span>
          <input
            type="text"
            bind:value={fields.label}
            placeholder="defaults to the host"
            autocomplete="off"
          />
        </label>

        <div class="add-daemon-row">
          <label class="add-daemon-field">
            <span>SSH user</span>
            <input
              type="text"
              bind:value={fields.user}
              placeholder="ssh default"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="add-daemon-field narrow">
            <span>SSH port</span>
            <input
              type="text"
              bind:value={fields.sshPort}
              placeholder="22"
              inputmode="numeric"
              class:invalid={!!errors.sshPort}
            />
            {#if errors.sshPort}<small class="err">{errors.sshPort}</small>{/if}
          </label>
          <label class="add-daemon-field narrow">
            <span>Daemon port</span>
            <input
              type="text"
              bind:value={fields.port}
              placeholder="7777"
              inputmode="numeric"
              class:invalid={!!errors.port}
            />
            {#if errors.port}<small class="err">{errors.port}</small>{/if}
          </label>
        </div>

        <label class="add-daemon-field">
          <span>Identity file (private key)</span>
          <input
            type="text"
            bind:value={fields.identityPath}
            placeholder="ssh agent / default key"
            autocomplete="off"
            spellcheck="false"
          />
        </label>

        <label class="add-daemon-field">
          <span>Row colour</span>
          <input
            type="text"
            bind:value={fields.color}
            placeholder="#rrggbb (optional)"
            autocomplete="off"
            spellcheck="false"
            class:invalid={!!errors.color}
          />
          {#if errors.color}<small class="err">{errors.color}</small>{/if}
        </label>
      </details>

      {#if submitError}
        <p class="add-daemon-submit-error">{submitError}</p>
      {/if}

      <div class="add-daemon-actions">
        <button class="btn-secondary" on:click={close} disabled={busy}>
          Cancel
        </button>
        <button class="btn-primary" on:click={submit} disabled={busy}>
          {busy ? "Connecting…" : "Add daemon"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Chrome + buttons mirror ConfirmDialog.svelte (and AddRemoteFolderDialog)
     so the app's dialogs read as one family. Colors come from
     styles/tokens.css — no literals / invented var names. */
  .add-daemon-overlay {
    position: fixed;
    inset: 0;
    background: var(--shadow-overlay);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .add-daemon-modal {
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
  .add-daemon-title {
    margin: 0 0 0.3rem;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .add-daemon-blurb {
    margin: 0 0 0.9rem;
    font-size: var(--fs-lg);
    line-height: 1.4;
    color: var(--text-muted);
  }
  .add-daemon-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: var(--fs-md);
  }
  .add-daemon-field > span {
    color: var(--text-3);
  }
  .add-daemon-field .req {
    color: var(--error);
  }
  .add-daemon-field input,
  .add-daemon-connstr {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    background: var(--surface-1);
    color: inherit;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.45rem 0.55rem;
    font-size: var(--fs-lg);
    font-family: inherit;
  }
  .add-daemon-connstr {
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .add-daemon-field input:focus,
  .add-daemon-connstr:focus {
    outline: none;
    border-color: var(--brand);
  }
  .add-daemon-field input.invalid {
    border-color: var(--error);
  }
  .add-daemon-hint {
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }
  .add-daemon-advanced {
    margin-bottom: 0.75rem;
  }
  /* Custom chevron (flex-aligned CSS triangle) instead of the default
     ::marker, which sits at an inconsistent baseline across browsers. */
  .add-daemon-advanced-summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-md);
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
    margin-bottom: 0.6rem;
    list-style: none;
  }
  .add-daemon-advanced-summary::-webkit-details-marker {
    display: none;
  }
  .add-daemon-advanced-summary::before {
    content: "";
    flex: 0 0 auto;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0.3rem 0 0.3rem 0.42rem;
    border-color: transparent transparent transparent currentColor;
    transition: transform 0.12s ease;
  }
  .add-daemon-advanced[open] > .add-daemon-advanced-summary {
    margin-bottom: 0.75rem;
  }
  .add-daemon-advanced[open] > .add-daemon-advanced-summary::before {
    transform: rotate(90deg);
  }
  .add-daemon-row {
    display: flex;
    gap: 0.6rem;
  }
  .add-daemon-row .add-daemon-field {
    flex: 1;
    min-width: 0;
  }
  .add-daemon-row .add-daemon-field.narrow {
    flex: 0 1 6.5rem;
  }
  .err {
    color: var(--error-text);
    font-size: var(--fs-sm);
  }
  .add-daemon-submit-error {
    margin: 0 0 0.75rem;
    color: var(--error-text);
    font-size: var(--fs-lg);
    white-space: pre-wrap;
  }
  .add-daemon-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  /* Match ConfirmDialog's .confirm-btn / .confirm-cancel / .confirm-ok. */
  .add-daemon-actions button {
    font: inherit;
    font-size: var(--fs-lg);
    padding: 0.35rem 0.8rem;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .add-daemon-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
  }
  .btn-primary {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 30%, transparent);
  }
</style>
