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
  export let onClose: () => void = () => {};

  let fields: DaemonFormFields = emptyDaemonForm();
  let errors: Partial<Record<keyof DaemonFormFields, string>> = {};
  let submitError = "";
  let busy = false;

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
    const result = normalizeDaemonForm(fields);
    if (!result.ok) {
      errors = result.errors;
      return;
    }
    errors = {};
    busy = true;
    try {
      await onAdd(result.payload);
      open = false;
      onClose();
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
  .add-daemon-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .add-daemon-modal {
    background: var(--bg, #1b1b1f);
    color: var(--fg, #e8e8ea);
    border: 1px solid var(--border, #34343a);
    border-radius: 10px;
    padding: 1.25rem 1.5rem 1.5rem;
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    overflow-y: auto;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  }
  .add-daemon-title {
    margin: 0 0 0.25rem;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .add-daemon-blurb {
    margin: 0 0 1rem;
    font-size: 0.82rem;
    line-height: 1.4;
    opacity: 0.7;
  }
  .add-daemon-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: 0.8rem;
  }
  .add-daemon-field > span {
    opacity: 0.85;
  }
  .add-daemon-field .req {
    color: var(--danger, #e5604d);
    opacity: 1;
  }
  .add-daemon-field input {
    background: var(--bg-input, #111114);
    color: inherit;
    border: 1px solid var(--border, #34343a);
    border-radius: 6px;
    padding: 0.45rem 0.55rem;
    font-size: 0.85rem;
    font-family: inherit;
  }
  .add-daemon-field input:focus {
    outline: none;
    border-color: var(--accent, #5b8def);
  }
  .add-daemon-field input.invalid {
    border-color: var(--danger, #e5604d);
  }
  .add-daemon-row {
    display: flex;
    gap: 0.6rem;
  }
  .add-daemon-row .add-daemon-field {
    flex: 1;
  }
  .add-daemon-row .add-daemon-field.narrow {
    flex: 0 0 6.5rem;
  }
  .err {
    color: var(--danger, #e5604d);
    font-size: 0.72rem;
  }
  .add-daemon-submit-error {
    margin: 0 0 0.75rem;
    color: var(--danger, #e5604d);
    font-size: 0.8rem;
  }
  .add-daemon-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .add-daemon-actions button {
    padding: 0.45rem 0.9rem;
    border-radius: 6px;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
    border: 1px solid var(--border, #34343a);
  }
  .add-daemon-actions button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .btn-secondary {
    background: transparent;
    color: inherit;
  }
  .btn-primary {
    background: var(--accent, #5b8def);
    color: #fff;
    border-color: var(--accent, #5b8def);
  }
</style>
