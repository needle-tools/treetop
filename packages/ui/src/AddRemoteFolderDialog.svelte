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
    fetchDir,
    type FileEntry,
  } from "./file-browser-utils";
  import FileTreeNode from "./FileTreeNode.svelte";
  import FilePathBar from "./FilePathBar.svelte";
  import { getDaemonKV } from "./daemon-kv";

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

  // --- Remote directory browser. Reuses the file tree's own building blocks
  //     (FileTreeNode + FilePathBar), driven against the chosen daemon via the
  //     proxy: GET /api/home for the start dir, fetchDir() (GET /api/files) to
  //     list. We only ever feed it DIRECTORIES — it's a folder picker. ---
  let browseDir = ""; // the root the tree shows
  /** Top-level subdirectories of `browseDir` (the tree's roots). */
  let rootDirs: FileEntry[] = [];
  /** Lazily-loaded children for expanded folders, keyed by absolute path. */
  let expanded: Record<string, FileEntry[]> = {};
  /** The folder that will be added (also the highlighted row). */
  let selected: Set<string> = new Set();
  let browseLoading = false;
  let browseError = "";
  // FileTreeNode needs these but the picker has no git/stars/copy state.
  const noGit: Record<string, Map<string, string>> = {};
  const noSet: Set<string> = new Set();
  /** Token to ignore the response of a superseded load (daemon switch /
   *  rapid navigation) so a slow earlier request can't clobber a newer view. */
  let browseSeq = 0;
  /** The box's filesystem roots (drive letters on Windows, "/" on POSIX). */
  let drives: string[] = [];
  /** Showing the "This PC" drive list (vs a directory's contents). */
  let atDrives = false;

  // Per-daemon "last browsed folder" — so re-opening "Add folder" on a daemon
  // returns to where you were (rule 11: daemon prefs, not raw localStorage).
  // One KV key holds a { daemonId: path } map.
  const LAST_PATH_KEY = "supergit:addFolder:lastPath";
  function lastPathMap(): Record<string, string> {
    try {
      return JSON.parse(getDaemonKV().getItem(LAST_PATH_KEY) ?? "{}") as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  }
  function saveLastPath(daemonId: string, path: string): void {
    if (!daemonId) return;
    const map = lastPathMap();
    map[daemonId] = path;
    try {
      getDaemonKV().setItem(LAST_PATH_KEY, JSON.stringify(map));
    } catch {
      /* best-effort */
    }
  }

  /** A filesystem root (drive letter or "/") — going "up" from here returns to
   *  the This PC view rather than a nonexistent parent. */
  function isRoot(p: string): boolean {
    return p === "/" || /^[A-Za-z]:[\\/]?$/.test(p);
  }

  function onlyDirs(entries: FileEntry[]): FileEntry[] {
    return entries.filter((e) => e.type === "directory");
  }

  /** Load `dir` as the tree root: list its subfolders + select it. Returns
   *  whether it loaded (so a restore of a stale saved path can fall back). */
  async function loadDir(dir: string): Promise<boolean> {
    const seq = ++browseSeq;
    browseLoading = true;
    browseError = "";
    try {
      const entries = await fetchDir(dir, fields.daemonId);
      if (seq !== browseSeq) return false; // superseded
      atDrives = false;
      browseDir = dir;
      fields.path = dir; // navigating into a directory selects it
      selected = new Set([dir]);
      expanded = {};
      rootDirs = onlyDirs(entries);
      saveLastPath(fields.daemonId, dir); // remember per daemon
      return true;
    } catch {
      if (seq !== browseSeq) return false;
      browseError = `Couldn't read ${dir}`;
      rootDirs = [];
      return false;
    } finally {
      if (seq === browseSeq) browseLoading = false;
    }
  }

  /** Show the box's drives ("This PC"). A single root (POSIX "/" or a lone
   *  drive) is entered directly rather than shown as a one-item picker. */
  async function loadDrives(): Promise<void> {
    if (!fields.daemonId) return;
    browseError = "";
    let list: string[] = [];
    try {
      const res = await fetch(apiUrl("/api/drives", fields.daemonId));
      if (res.ok) {
        list = ((await res.json()) as { drives?: string[] }).drives ?? [];
      }
    } catch {
      browseError = "Couldn't reach the daemon to list drives.";
      return;
    }
    drives = list;
    if (list.length === 1) {
      await loadDir(list[0]!);
      return;
    }
    atDrives = true;
    browseDir = "";
    rootDirs = [];
    expanded = {};
    selected = new Set();
    fields.path = "";
    saveLastPath(fields.daemonId, ""); // "" = the This PC view
  }

  /** Expand / collapse a folder in place (FileTreeNode's onToggleExpand). */
  async function toggleExpand(name: string, parentDir?: string): Promise<void> {
    const full = joinPath(parentDir ?? browseDir, name);
    if (expanded[full]) {
      const next = { ...expanded };
      delete next[full];
      expanded = next;
      return;
    }
    try {
      const children = onlyDirs(await fetchDir(full, fields.daemonId));
      expanded = { ...expanded, [full]: children };
    } catch {
      // leave collapsed
    }
  }

  /** Single-click a folder → choose it as the path to add. */
  function selectPath(path: string): void {
    fields.path = path;
    selected = new Set([path]);
  }

  /** Double-click a folder → drill into it as the new tree root. */
  function onDirDblClick(path: string, type: string): void {
    if (type === "directory") void loadDir(path);
  }

  /** Start at the box's home, else the parent of an existing repo on this
   *  daemon (works even on a remote that predates /api/home), else let the
   *  user type a path. */
  async function startBrowse(): Promise<void> {
    if (!fields.daemonId) return;
    // Clear stale state up front so a failed restore/listing can never leave
    // the PREVIOUS daemon's path showing (the bug this fixes).
    browseError = "";
    atDrives = false;
    browseDir = "";
    rootDirs = [];
    expanded = {};
    selected = new Set();
    fields.path = "";
    // Restore where we last browsed on THIS daemon, if any. "" means the user
    // was at the This PC view; a stale/unreadable path falls back to drives.
    const saved = lastPathMap()[fields.daemonId];
    if (saved) {
      if (await loadDir(saved)) return;
    }
    await loadDrives();
  }

  function goUp(): void {
    if (atDrives) return;
    // From a filesystem root, "up" is the This PC drive list.
    if (isRoot(browseDir)) {
      void loadDrives();
      return;
    }
    const { dir } = splitParent(browseDir);
    if (dir && dir !== browseDir) void loadDir(dir);
    else void loadDrives();
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
    rootDirs = [];
    expanded = {};
    selected = new Set();
    browseError = "";
    atDrives = false;
    drives = [];
    wasOpen = true;
    prevDaemonId = fields.daemonId;
    void startBrowse();
  } else if (!open && wasOpen) {
    wasOpen = false;
  }

  // Re-browse when the user switches the target daemon. Driven by a REACTIVE
  // (runs AFTER bind:value updates fields.daemonId) rather than the select's
  // on:change, which could fire with the OLD id and load the wrong daemon's
  // path. Saves the leaving daemon's selected path first, then restores the
  // target's.
  let prevDaemonId = "";
  $: if (open && fields.daemonId && fields.daemonId !== prevDaemonId) {
    // fields.daemonId already changed; fields.path is still the OLD daemon's.
    if (prevDaemonId) saveLastPath(prevDaemonId, fields.path);
    prevDaemonId = fields.daemonId;
    void startBrowse();
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

      <!-- Remote directory browser. Reuses the file tree's own components:
           FilePathBar (clickable breadcrumb) + FileTreeNode (folder rows). -->
      <div class="add-folder-browser">
        <div class="add-folder-browser-head">
          <button
            type="button"
            class="add-folder-up"
            on:click={goUp}
            disabled={browseLoading || atDrives}
            title="Up one level"
            aria-label="Up one level"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            class="add-folder-thispc"
            class:active={atDrives}
            on:click={() => void loadDrives()}
            disabled={browseLoading}
            title="This PC — all drives"
          >This PC</button>
          {#if atDrives}
            <span class="add-folder-cwd add-folder-cwd-empty">This PC</span>
          {:else if browseDir}
            <span class="add-folder-cwd">
              <FilePathBar path={browseDir} onCrumb={(p) => void loadDir(p)} />
            </span>
          {:else}
            <span class="add-folder-cwd add-folder-cwd-empty">—</span>
          {/if}
        </div>
        <div class="add-folder-browser-list">
          {#if browseLoading}
            <div class="add-folder-browser-msg">Loading…</div>
          {:else if browseError}
            <div class="add-folder-browser-msg">{browseError}</div>
          {:else if atDrives}
            <ul class="fb-list">
              {#each drives as d (d)}
                <li>
                  <button
                    type="button"
                    class="add-folder-drive"
                    on:click={() => void loadDir(d)}
                    title={d}
                  >
                    <svg
                      class="add-folder-drive-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="2" y="6" width="20" height="12" rx="2" />
                      <circle cx="17.5" cy="12" r="1" />
                    </svg>
                    <span>{d}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else if rootDirs.length === 0}
            <div class="add-folder-browser-msg">No subfolders here.</div>
          {:else}
            <ul class="fb-list">
              {#each rootDirs as e (e.name)}
                <FileTreeNode
                  entry={e}
                  parentDir={browseDir}
                  {expanded}
                  {selected}
                  copiedPaths={noSet}
                  gitStatusByDir={noGit}
                  showDotfiles={false}
                  wtPath={browseDir}
                  onSelect={(p) => selectPath(p)}
                  onDblClick={onDirDblClick}
                  onToggleExpand={(name, parent) => void toggleExpand(name, parent)}
                  onNavigateToFile={() => {}}
                  starred={noSet}
                  hideActions
                />
              {/each}
            </ul>
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
  /* Borderless icon button, sized to the breadcrumb text so it reads as part
     of the path row (matches .fb-crumb's colour + hover). */
  .add-folder-up {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .add-folder-up svg {
    width: 0.85rem;
    height: 0.85rem;
    display: block;
  }
  .add-folder-up:hover:not(:disabled) {
    color: var(--text-1);
  }
  .add-folder-up:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* "This PC" jump-to-drives button. */
  .add-folder-thispc {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    padding: 0.1rem 0.4rem;
    line-height: 1.3;
  }
  .add-folder-thispc:hover:not(:disabled) {
    color: var(--text-1);
    border-color: var(--text-muted);
  }
  .add-folder-thispc.active {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .add-folder-thispc:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Drive rows in the This PC view. */
  .add-folder-drive {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
    padding: 0.3rem 0.4rem;
    border-radius: var(--radius-sm);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .add-folder-drive:hover {
    background: color-mix(in srgb, var(--text-muted) 14%, transparent);
  }
  .add-folder-drive-icon {
    flex: 0 0 auto;
    width: 1rem;
    height: 1rem;
    color: var(--text-muted);
  }
  /* Holds the FilePathBar breadcrumb; scroll horizontally on long paths
     instead of wrapping or clipping. */
  .add-folder-cwd {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    overflow-x: auto;
    white-space: nowrap;
  }
  .add-folder-cwd-empty {
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }
  .add-folder-browser-list {
    min-height: 20vh;
    max-height: 40vh;
    overflow-y: auto;
    /* Keep wheel/touch scroll inside the tree — don't chain to the dialog
       or page when hitting the top/bottom. */
    overscroll-behavior: contain;
    /* ~2 rows of breathing room at the bottom so the last folder can scroll
       clear of the edge instead of sitting flush against it. */
    padding: 0.15rem 0.25rem 2.6rem;
  }
  .add-folder-browser-msg {
    padding: 0.6rem 0.55rem;
    font-size: var(--fs-md);
    color: var(--text-faint);
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
