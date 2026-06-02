<script lang="ts">
  /**
   * "Add a folder on a remote daemon" dialog (#3 in
   * plans/PLAN-REMOTE-DAEMON.md). Pick a connected remote daemon and type a
   * path that already exists on THAT box; on submit the parent POSTs
   * `apiUrl("/api/repos", daemonId)` so the local daemon proxies the add to
   * the remote, which registers the repo against its own filesystem and
   * answers 409 with a clear message if the path is missing / not a git repo.
   *
   * Validation/normalization is the pure, unit-tested `remote-folder-form.ts`
   * — this component is just the form shell + inline error display. There is
   * no remote clone/init yet: the repo must already be on the box.
   */
  import {
    emptyRemoteFolderForm,
    validateRemoteFolderForm,
    type RemoteFolderFields,
    type RemoteFolderPayload,
  } from "./remote-folder-form";

  export let open = false;
  /** The connected remote daemons to choose a target from. */
  export let daemons: Array<{ id: string; label: string; host: string; port: number }> = [];
  /** Which daemon to preselect when the dialog opens (e.g. the row the user
   *  clicked "Add folder" on). Falls back to the first daemon. */
  export let preselectDaemonId = "";
  /** Called with the normalized payload on a valid submit. May be async (the
   *  parent POSTs /api/repos to the daemon); should throw on failure so the
   *  dialog surfaces the error and stays open. */
  export let onAdd: (payload: RemoteFolderPayload) => void | Promise<void>;
  export let onClose: () => void = () => {};

  let fields: RemoteFolderFields = emptyRemoteFolderForm();
  let errors: Partial<Record<keyof RemoteFolderFields, string>> = {};
  let submitError = "";
  let busy = false;

  // Reset on the open edge so a prior attempt's values/errors don't linger.
  let wasOpen = false;
  $: if (open && !wasOpen) {
    fields = emptyRemoteFolderForm(preselectDaemonId || daemons[0]?.id || "");
    errors = {};
    submitError = "";
    busy = false;
    wasOpen = true;
  } else if (!open && wasOpen) {
    wasOpen = false;
  }

  $: selectedLabel =
    daemons.find((d) => d.id === fields.daemonId)?.label ?? "the remote machine";

  function close(): void {
    if (busy) return;
    open = false;
    onClose();
  }

  async function submit(): Promise<void> {
    if (busy) return;
    submitError = "";
    const result = validateRemoteFolderForm(
      fields,
      daemons.map((d) => d.id),
    );
    if (result.payload === undefined) {
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
  <div class="add-folder-overlay" on:click={close}>
    <div
      class="add-folder-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Add a folder on a remote daemon"
      on:click|stopPropagation
      on:keydown={onKeydown}
    >
      <h2 class="add-folder-title">Add a folder on a remote daemon</h2>
      <p class="add-folder-blurb">
        Register a git repo that already exists on
        <strong>{selectedLabel}</strong>. It runs on the box and appears as a
        folder row beside your local ones. (No clone/init yet — the repo must
        already be there.)
      </p>

      {#if daemons.length > 1}
        <label class="add-folder-field">
          <span>Daemon</span>
          <select bind:value={fields.daemonId} class:invalid={!!errors.daemonId}>
            {#each daemons as d (d.id)}
              <option value={d.id}>{d.label} ({d.host}:{d.port})</option>
            {/each}
          </select>
          {#if errors.daemonId}<small class="err">{errors.daemonId}</small>{/if}
        </label>
      {/if}

      <label class="add-folder-field">
        <span>Path on {selectedLabel} <span class="req">*</span></span>
        <input
          type="text"
          bind:value={fields.path}
          placeholder="/home/supergit/my-repo"
          autocomplete="off"
          spellcheck="false"
          class:invalid={!!errors.path}
        />
        {#if errors.path}<small class="err">{errors.path}</small>{/if}
        <small class="add-folder-hint">
          Absolute path on the remote machine — the daemon there checks it
          exists and is a git repo.
        </small>
      </label>

      {#if submitError}
        <p class="add-folder-submit-error">{submitError}</p>
      {/if}

      <div class="add-folder-actions">
        <button class="btn-secondary" on:click={close} disabled={busy}>
          Cancel
        </button>
        <button class="btn-primary" on:click={submit} disabled={busy}>
          {busy ? "Adding…" : "Add folder"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .add-folder-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .add-folder-modal {
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
  .add-folder-title {
    margin: 0 0 0.25rem;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .add-folder-blurb {
    margin: 0 0 1rem;
    font-size: 0.82rem;
    line-height: 1.4;
    opacity: 0.7;
  }
  .add-folder-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: 0.8rem;
  }
  .add-folder-field > span {
    opacity: 0.85;
  }
  .add-folder-field .req {
    color: var(--danger, #e5604d);
    opacity: 1;
  }
  .add-folder-field input,
  .add-folder-field select {
    background: var(--input-bg, #131316);
    color: inherit;
    border: 1px solid var(--border, #34343a);
    border-radius: 6px;
    padding: 0.4rem 0.55rem;
    font-size: 0.85rem;
    font-family: inherit;
  }
  .add-folder-field input.invalid,
  .add-folder-field select.invalid {
    border-color: var(--danger, #e5604d);
  }
  .add-folder-field .err {
    color: var(--danger, #e5604d);
    font-size: 0.72rem;
  }
  .add-folder-hint {
    opacity: 0.55;
    font-size: 0.72rem;
    line-height: 1.35;
  }
  .add-folder-submit-error {
    color: var(--danger, #e5604d);
    font-size: 0.8rem;
    margin: 0 0 0.75rem;
    white-space: pre-wrap;
  }
  .add-folder-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .add-folder-actions button {
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.85rem;
    cursor: pointer;
    border: 1px solid var(--border, #34343a);
  }
  .add-folder-actions .btn-secondary {
    background: transparent;
    color: inherit;
  }
  .add-folder-actions .btn-primary {
    background: var(--accent, #4f7cff);
    color: #fff;
    border-color: transparent;
  }
  .add-folder-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
