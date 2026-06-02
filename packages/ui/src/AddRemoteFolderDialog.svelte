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
  import { apiUrl } from "./api";
  import {
    joinPath,
    splitParent,
    type FileEntry,
  } from "./file-browser-utils";

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
  /** Existing repos (the merged local+remote list). Used only as a
   *  browse-start fallback: if the chosen daemon predates `/api/home`, anchor
   *  the picker at the parent of one of its repos so it still works. */
  export let repos: Array<{ daemonId?: string; path: string }> = [];

  let fields: RemoteFolderFields = emptyRemoteFolderForm();
  let errors: Partial<Record<keyof RemoteFolderFields, string>> = {};
  let submitError = "";
  let busy = false;

  // --- Remote directory browser (so the user can navigate instead of
  //     typing the path). All reads go through the proxy to the chosen
  //     daemon: GET /api/home for the start dir, GET /api/files to list. ---
  let browseDir = "";
  let browseSubdirs: FileEntry[] = [];
  let browseLoading = false;
  let browseError = "";
  /** Token to ignore the response of a superseded load (daemon switch /
   *  rapid navigation) so a slow earlier request can't clobber a newer view. */
  let browseSeq = 0;

  async function loadDir(dir: string): Promise<void> {
    const seq = ++browseSeq;
    browseLoading = true;
    browseError = "";
    try {
      const res = await fetch(
        apiUrl(`/api/files?path=${encodeURIComponent(dir)}`, fields.daemonId),
      );
      if (seq !== browseSeq) return; // superseded
      if (!res.ok) {
        browseError = `Couldn't read ${dir}`;
        browseSubdirs = [];
        return;
      }
      const data = (await res.json()) as {
        path?: string;
        entries?: FileEntry[];
      };
      if (seq !== browseSeq) return;
      browseDir = data.path ?? dir;
      // Navigating into a directory selects it as the folder to add.
      fields.path = browseDir;
      browseSubdirs = (data.entries ?? []).filter((e) => e.type === "directory");
    } catch {
      if (seq !== browseSeq) return;
      browseError = `Couldn't read ${dir}`;
      browseSubdirs = [];
    } finally {
      if (seq === browseSeq) browseLoading = false;
    }
  }

  /** Start the browser at the remote's home dir, falling back to the parent
   *  of an existing repo on this daemon (works even on a remote that predates
   *  /api/home), and finally to "type a path" if there's nothing to anchor. */
  async function startBrowse(): Promise<void> {
    if (!fields.daemonId) return;
    browseError = "";
    // 1) the box's home (new endpoint; may be absent on older remotes)
    try {
      const res = await fetch(apiUrl("/api/home", fields.daemonId));
      if (res.ok) {
        const home = (await res.json()) as { home?: string };
        if (home.home) {
          await loadDir(home.home);
          return;
        }
      }
    } catch {
      // fall through
    }
    // 2) parent of an existing repo on this daemon — no new endpoint needed
    const sibling = repos.find((r) => r.daemonId === fields.daemonId && r.path);
    if (sibling) {
      const parent = splitParent(sibling.path).dir;
      if (parent) {
        await loadDir(parent);
        return;
      }
    }
    // 3) nothing to anchor on — let the user type a path.
    browseSubdirs = [];
    browseDir = "";
    browseError = "Type a path above and press Enter to browse.";
  }

  function enterDir(name: string): void {
    void loadDir(joinPath(browseDir, name));
  }

  function goUp(): void {
    const { dir } = splitParent(browseDir);
    if (dir && dir !== browseDir) void loadDir(dir);
  }

  function onPathKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      if (fields.path.trim()) void loadDir(fields.path.trim());
    }
  }

  // Reset on the open edge so a prior attempt's values/errors don't linger.
  let wasOpen = false;
  $: if (open && !wasOpen) {
    fields = emptyRemoteFolderForm(preselectDaemonId || daemons[0]?.id || "");
    errors = {};
    submitError = "";
    busy = false;
    browseDir = "";
    browseSubdirs = [];
    browseError = "";
    wasOpen = true;
    void startBrowse();
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
          <select
            bind:value={fields.daemonId}
            class:invalid={!!errors.daemonId}
            on:change={() => void startBrowse()}
          >
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
          on:keydown={onPathKeydown}
          placeholder="/home/supergit/my-repo"
          autocomplete="off"
          spellcheck="false"
          class:invalid={!!errors.path}
        />
        {#if errors.path}<small class="err">{errors.path}</small>{/if}
        <small class="add-folder-hint">
          Pick a folder below, or type/paste an absolute path and press Enter to
          browse there. The daemon checks it exists and is a git repo.
        </small>
      </label>

      <!-- Remote directory browser: navigating selects that folder. -->
      <div class="add-folder-browser">
        <div class="add-folder-browser-head">
          <button
            type="button"
            class="add-folder-up"
            on:click={goUp}
            disabled={browseLoading || !browseDir}
            title="Up one level"
          >↑</button>
          <span class="add-folder-cwd" title={browseDir}>{browseDir || "—"}</span>
        </div>
        <div class="add-folder-browser-list">
          {#if browseLoading}
            <div class="add-folder-browser-msg">Loading…</div>
          {:else if browseError}
            <div class="add-folder-browser-msg">{browseError}</div>
          {:else if browseSubdirs.length === 0}
            <div class="add-folder-browser-msg">No subfolders here.</div>
          {:else}
            {#each browseSubdirs as e (e.name)}
              <button
                type="button"
                class="add-folder-dir"
                on:click={() => enterDir(e.name)}
                disabled={browseLoading}
              >
                <span class="add-folder-dir-icon">📁</span>
                <span class="add-folder-dir-name">{e.name}</span>
              </button>
            {/each}
          {/if}
        </div>
      </div>

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
  /* Chrome + buttons mirror ConfirmDialog.svelte so the app's dialogs read
     as one family. Colors come from styles/tokens.css — no literals. */
  .add-folder-overlay {
    position: fixed;
    inset: 0;
    background: var(--shadow-overlay);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .add-folder-modal {
    background: var(--surface-1);
    color: inherit;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 1rem 1.1rem 1.1rem;
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100vh - 4rem);
    overflow-y: auto;
    box-shadow: 0 12px 32px var(--shadow-overlay);
  }
  .add-folder-title {
    margin: 0 0 0.3rem;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .add-folder-blurb {
    margin: 0 0 0.9rem;
    font-size: var(--fs-lg);
    line-height: 1.4;
    color: var(--text-muted);
  }
  .add-folder-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.75rem;
    font-size: var(--fs-md);
  }
  .add-folder-field > span {
    color: var(--text-3);
  }
  .add-folder-field .req {
    color: var(--error);
  }
  .add-folder-field input,
  .add-folder-field select {
    background: var(--surface-1);
    color: inherit;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.4rem 0.55rem;
    font-size: var(--fs-lg);
    font-family: inherit;
  }
  .add-folder-field input:focus,
  .add-folder-field select:focus {
    outline: none;
    border-color: var(--brand);
  }
  .add-folder-field input.invalid,
  .add-folder-field select.invalid {
    border-color: var(--error);
  }
  .add-folder-field .err {
    color: var(--error-text);
    font-size: var(--fs-sm);
  }
  .add-folder-hint {
    color: var(--text-faint);
    font-size: var(--fs-sm);
    line-height: 1.35;
  }
  .add-folder-browser {
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    margin-bottom: 0.75rem;
    overflow: hidden;
  }
  .add-folder-browser-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.45rem;
    border-bottom: 1px solid var(--surface-2);
    background: var(--surface-0);
  }
  .add-folder-up {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--border-muted);
    color: inherit;
    border-radius: var(--radius-sm);
    cursor: pointer;
    padding: 0.05rem 0.4rem;
    line-height: 1.2;
  }
  .add-folder-up:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .add-folder-up:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .add-folder-cwd {
    font-size: var(--fs-sm);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl; /* keep the tail (the folder you're in) visible */
    text-align: left;
  }
  .add-folder-browser-list {
    max-height: 11rem;
    overflow-y: auto;
  }
  .add-folder-browser-msg {
    padding: 0.6rem 0.55rem;
    font-size: var(--fs-md);
    color: var(--text-faint);
  }
  .add-folder-dir {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0.3rem 0.55rem;
    font-size: var(--fs-md);
  }
  .add-folder-dir:hover {
    background: color-mix(in srgb, var(--brand) 14%, transparent);
  }
  .add-folder-dir-icon {
    flex: 0 0 auto;
    font-size: var(--fs-lg);
  }
  .add-folder-dir-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-folder-submit-error {
    color: var(--error-text);
    font-size: var(--fs-lg);
    margin: 0 0 0.75rem;
    white-space: pre-wrap;
  }
  .add-folder-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  /* Match ConfirmDialog's .confirm-btn / .confirm-cancel / .confirm-ok. */
  .add-folder-actions button {
    font: inherit;
    font-size: var(--fs-lg);
    padding: 0.35rem 0.8rem;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .add-folder-actions .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
  }
  .add-folder-actions .btn-primary {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .add-folder-actions .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 30%, transparent);
  }
  .add-folder-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
