<script lang="ts" context="module">
  import type { ProvisionFormPayload } from "./remote-daemon-form";

  /** Live progress callbacks for a provision job's SSE stream. */
  export interface ProvisionStreamHandlers {
    onOutput: (chunk: string) => void;
    onStatus: (
      status: string,
      info: { daemonId?: string; error?: string },
    ) => void;
    onEnd: () => void;
  }
  /** Transport for auto-provisioning, injected by the parent (App.svelte
   *  owns the apiUrl routing + side effects). Keeps this component
   *  transport-agnostic. */
  export interface ProvisionApi {
    /** POST /api/daemons/provision → resolves the jobId. Throws on failure. */
    start: (payload: ProvisionFormPayload) => Promise<string>;
    /** Open the job's SSE stream; returns an unsubscribe. */
    stream: (jobId: string, handlers: ProvisionStreamHandlers) => () => void;
    /** POST …/abort — kill the in-flight install. */
    abort: (jobId: string) => void | Promise<void>;
  }
</script>

<script lang="ts">
  /**
   * "Add remote daemon" dialog. Provision-first (remote-daemon Phase 2b):
   * the headline flow points supergit at a fresh box over SSH, ships the
   * bundled source, runs the installer with LIVE progress, and registers the
   * daemon when the installer prints its connection token — zero manual
   * steps. The older paths (paste a `supergit1:` string, or enter details
   * manually) live under an "already provisioned?" disclosure.
   *
   * Validation/normalization is pure + unit-tested in `remote-daemon-form.ts`
   * (`normalizeProvisionForm` / `normalizeDaemonForm`); this component is the
   * form shell, the install-log view, and the provision state machine. The
   * daemon re-validates server-side, so this is UX, not the trust boundary.
   */
  import { tick } from "svelte";
  import {
    emptyDaemonForm,
    normalizeDaemonForm,
    emptyProvisionForm,
    normalizeProvisionForm,
    stripHostPort,
    type DaemonFormFields,
    type DaemonFormPayload,
    type ProvisionFormFields,
  } from "./remote-daemon-form";
  import { play } from "./sound";

  export let open = false;
  /** Manual add (Advanced form) → POST /api/daemons. Throws on failure. */
  export let onAdd: (payload: DaemonFormPayload) => void | Promise<void>;
  /** Paste flow → POST /api/daemons/connect. Throws on failure. */
  export let onConnect: (
    connectionString: string,
  ) => void | Promise<void> = async () => {};
  export let onClose: () => void = () => {};
  /** Auto-provision transport. When null (this build can't provision, or the
   *  parent hasn't wired it), the dialog falls back to paste-first. */
  export let provision: ProvisionApi | null = null;
  /** Whether this build can auto-provision (capability probe). When false the
   *  provision section is hidden and paste/manual become primary. */
  export let canProvision = true;

  // Manual / paste form (under the disclosure).
  let fields: DaemonFormFields = emptyDaemonForm();
  let errors: Partial<Record<keyof DaemonFormFields, string>> = {};
  let submitError = "";
  let busy = false;
  let connectionString = "";
  let showAdvanced = false;
  let showOther = false;

  // Provision form + run state.
  let pfields: ProvisionFormFields = emptyProvisionForm();
  let perrors: Partial<Record<keyof ProvisionFormFields, string>> = {};
  let provError = "";
  /** "form" = collecting input; "provisioning" = streaming the install log. */
  let phase: "form" | "provisioning" = "form";
  let provStatus = "running"; // running | registering | done | error | aborted
  let provLog = "";
  let provJobId = "";
  let aborting = false;
  let provUnsub: (() => void) | null = null;
  let logEl: HTMLDivElement | null = null;

  $: provisionEnabled = canProvision && provision != null;
  $: provRunning = provStatus === "running" || provStatus === "registering";

  // Reset on the open edge so a previous attempt doesn't linger.
  let wasOpen = false;
  $: if (open && !wasOpen) {
    fields = emptyDaemonForm();
    errors = {};
    submitError = "";
    busy = false;
    connectionString = "";
    showAdvanced = false;
    // If the build can't provision, lead with the paste/manual options.
    showOther = !provisionEnabled;
    pfields = emptyProvisionForm();
    perrors = {};
    provError = "";
    phase = "form";
    provStatus = "running";
    provLog = "";
    provJobId = "";
    aborting = false;
    provUnsub?.();
    provUnsub = null;
    wasOpen = true;
  } else if (!open && wasOpen) {
    wasOpen = false;
  }

  function close(): void {
    // Block while a manual add is in flight or an install is running — the
    // latter must be explicitly Cancelled (abort) so we don't orphan it.
    if (busy || (phase === "provisioning" && provRunning)) return;
    provUnsub?.();
    provUnsub = null;
    open = false;
    onClose();
  }

  async function appendLog(chunk: string): Promise<void> {
    provLog += chunk;
    await tick();
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }

  /** Start auto-provisioning: validate, POST, then stream the install log. */
  async function provisionSubmit(): Promise<void> {
    if (!provision) return;
    submitError = "";
    perrors = {};
    const result = normalizeProvisionForm(pfields);
    if (!result.ok) {
      perrors = result.errors;
      return;
    }
    phase = "provisioning";
    provStatus = "running";
    provError = "";
    provLog = "";
    aborting = false;
    try {
      provJobId = await provision.start(result.payload);
    } catch (e) {
      provStatus = "error";
      provError = e instanceof Error ? e.message : String(e);
      play("daemon-connect-fail");
      // A "no payload bundled" failure → reveal the paste option as the path.
      if (/payload|unavailable|paste/i.test(provError)) showOther = true;
      return;
    }
    // Job accepted — start the mysterious waiting cue. The success
    // / fail chime overlays on top and fades this out via fadeOutMs.
    play("daemon-connect-waiting");
    provUnsub = provision.stream(provJobId, {
      onOutput: (chunk) => void appendLog(chunk),
      onStatus: (status, info) => {
        provStatus = status;
        if (info.error) provError = info.error;
        if (status === "error") play("daemon-connect-fail");
        else if (status === "done") play("daemon-connect-ok");
      },
      onEnd: () => {
        provUnsub?.();
        provUnsub = null;
      },
    });
  }

  async function cancelProvision(): Promise<void> {
    if (!provision || !provJobId || aborting) return;
    aborting = true;
    await provision.abort(provJobId);
    // The daemon emits the final "aborted" status over the stream; reflect it
    // promptly even if the stream lags.
    provStatus = "aborted";
  }

  /** After an error / abort, return to the form to fix + retry. */
  function backToForm(): void {
    provUnsub?.();
    provUnsub = null;
    phase = "form";
    provError = "";
    provLog = "";
    provStatus = "running";
    aborting = false;
  }

  /** Paste / manual add (the disclosure's own submit). */
  async function submit(): Promise<void> {
    if (busy) return;
    submitError = "";
    busy = true;
    try {
      if (connectionString.trim()) {
        await onConnect(connectionString.trim());
        play("daemon-connect-ok");
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
        play("daemon-connect-ok");
        open = false;
        onClose();
      }
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
      play("daemon-connect-fail");
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
      if (phase === "provisioning") return;
      if (provisionEnabled && !showOther) void provisionSubmit();
      else void submit();
    }
  }

  function statusLine(status: string): string {
    switch (status) {
      case "running":
        return "Installing on the box…";
      case "registering":
        return "Installer finished — registering daemon…";
      case "done":
        return "Connected ✓";
      case "aborted":
        return "Cancelled.";
      case "error":
        return "Provisioning failed.";
      default:
        return status;
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
      {#if phase === "provisioning"}
        <!-- ── Live install log ──────────────────────────────────────── -->
        <h2 class="add-daemon-title">
          Provisioning {pfields.host || "remote box"}…
        </h2>
        <p
          class="add-daemon-status"
          class:ok={provStatus === "done"}
          class:bad={provStatus === "error" || provStatus === "aborted"}
        >
          {statusLine(provStatus)}
        </p>

        <div
          class="provision-log"
          class:running={provRunning}
          bind:this={logEl}
          aria-label="install log"
        >
          {#if provLog}{provLog}{:else}<span class="provision-log-empty"
              >waiting for the installer…</span
            >{/if}
        </div>

        {#if provError}
          <p class="add-daemon-submit-error">{provError}</p>
        {/if}

        <div class="add-daemon-actions">
          {#if provRunning}
            <button
              class="btn-secondary"
              on:click={cancelProvision}
              disabled={aborting}
            >
              {aborting ? "Cancelling…" : "Cancel"}
            </button>
          {:else}
            {#if provStatus !== "done"}
              <button class="btn-secondary" on:click={backToForm}>Back</button>
            {/if}
            <button class="btn-primary" on:click={close}>Close</button>
          {/if}
        </div>
      {:else}
        <!-- ── Form ──────────────────────────────────────────────────── -->
        <h2 class="add-daemon-title">Add remote daemon</h2>
        <p class="add-daemon-blurb">
          Connect a supergit daemon on another machine over an SSH tunnel. Its
          repos appear as folder rows beside your local ones.
        </p>

        {#if provisionEnabled}
          <div class="provision-section">
            <p class="provision-heading">Provision a fresh box over SSH</p>
            <p class="add-daemon-hint provision-sub">
              Point supergit at a machine you can already <code>ssh</code> into
              (key/agent — no password is stored). It installs the daemon there
              and connects itself.
            </p>

            <label class="add-daemon-field">
              <span>Host <span class="req">*</span></span>
              <input
                type="text"
                bind:value={pfields.host}
                on:blur={() => (pfields.host = stripHostPort(pfields.host))}
                placeholder="hetzner.example.com or 1.2.3.4"
                autocomplete="off"
                spellcheck="false"
                class:invalid={!!perrors.host}
              />
              {#if perrors.host}<small class="err">{perrors.host}</small>{/if}
            </label>

            <div class="add-daemon-row">
              <label class="add-daemon-field">
                <span>SSH user</span>
                <input
                  type="text"
                  bind:value={pfields.user}
                  placeholder="root"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
              <label class="add-daemon-field narrow">
                <span>SSH port</span>
                <input
                  type="text"
                  bind:value={pfields.sshPort}
                  placeholder="22"
                  inputmode="numeric"
                  class:invalid={!!perrors.sshPort}
                />
                {#if perrors.sshPort}<small class="err">{perrors.sshPort}</small
                  >{/if}
              </label>
            </div>

            <label class="add-daemon-field">
              <span>Operating system</span>
              <select bind:value={pfields.os} class="add-daemon-os">
                <option value="">Linux / macOS</option>
                <option value="windows">Windows</option>
              </select>
              {#if pfields.os === "windows"}
                <small class="add-daemon-hint"
                  >Windows needs the OpenSSH Server feature enabled. Support is
                  new — if provisioning stalls, check the box has
                  <code>tar.exe</code> + PowerShell and report the install log.</small
                >
              {/if}
            </label>

            {#if pfields.os !== "windows"}
              <label class="add-daemon-check">
                <input type="checkbox" bind:checked={pfields.runAsRoot} />
                <span
                  >Run as <code>root</code> — full access to every folder on the
                  box</span
                >
              </label>
              {#if pfields.runAsRoot}
                <small class="add-daemon-hint add-daemon-check-hint">
                  The daemon runs privileged. Fine for a box only you reach over
                  the tunnel; leave it off (sandboxed user) for shared machines.
                </small>
              {/if}
            {/if}

            <label class="add-daemon-field">
              <span>Label</span>
              <input
                type="text"
                bind:value={pfields.label}
                placeholder="defaults to the host"
                autocomplete="off"
              />
            </label>
          </div>
        {/if}

        <details class="add-daemon-advanced" bind:open={showOther}>
          <summary class="add-daemon-advanced-summary">
            {provisionEnabled
              ? "Already provisioned? Paste a connection string / enter details"
              : "Connect an existing daemon"}
          </summary>

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
            <small class="add-daemon-hint"
              >Paste the string the installer printed — it fills in everything
              below.</small
            >
          </label>

          <details class="add-daemon-advanced nested" bind:open={showAdvanced}>
            <summary class="add-daemon-advanced-summary"
              >Advanced — enter connection details manually</summary
            >

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
                {#if errors.sshPort}<small class="err">{errors.sshPort}</small
                  >{/if}
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

          <div class="add-daemon-actions disclosure-actions">
            <button class="btn-primary" on:click={submit} disabled={busy}>
              {busy ? "Connecting…" : "Add daemon"}
            </button>
          </div>
        </details>

        {#if submitError}
          <p class="add-daemon-submit-error">{submitError}</p>
        {/if}

        <div class="add-daemon-actions">
          <button class="btn-secondary" on:click={close} disabled={busy}>
            Cancel
          </button>
          {#if provisionEnabled}
            <button class="btn-primary" on:click={provisionSubmit} disabled={busy}>
              Provision &amp; connect
            </button>
          {/if}
        </div>
      {/if}
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
  /* Run-as-root checkbox row. */
  .add-daemon-check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-bottom: 0.6rem;
    font-size: var(--fs-md);
    color: var(--text-3);
    cursor: pointer;
    user-select: none;
  }
  .add-daemon-check input {
    flex: 0 0 auto;
    margin: 0;
  }
  .add-daemon-check code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .add-daemon-check-hint {
    display: block;
    margin: -0.35rem 0 0.7rem;
  }

  /* Provision-first section — the headline flow. */
  .provision-section {
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.75rem 0.8rem 0.1rem;
    margin-bottom: 0.85rem;
    background: color-mix(in srgb, var(--surface-2) 22%, transparent);
  }
  .provision-heading {
    margin: 0 0 0.3rem;
    font-size: var(--fs-md);
    font-weight: 600;
  }
  .provision-sub {
    margin: 0 0 0.7rem;
    line-height: 1.4;
  }
  .provision-sub code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  /* Install-log view. */
  .add-daemon-status {
    margin: 0 0 0.6rem;
    font-size: var(--fs-md);
    color: var(--text-muted);
  }
  .add-daemon-status.ok {
    color: var(--success, var(--brand));
  }
  .add-daemon-status.bad {
    color: var(--error-text);
  }
  .provision-log {
    box-sizing: border-box;
    width: 100%;
    height: 16rem;
    overflow-y: auto;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    /* Transparent — just an outline; no surface fill. */
    background: transparent;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.5rem 0.6rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-2, inherit);
  }
  /* While the install is working, sweep a soft gradient THROUGH the text —
     a skeleton-style shimmer, but magical: a brand-tinted band drifting over
     muted glyphs. Seamless loop (the 200% gradient tiles, so a -200% shift
     lands exactly one tile over). Once done/errored the class drops and the
     text settles to a solid, readable colour. */
  .provision-log.running {
    background-image: linear-gradient(
      90deg,
      var(--text-faint) 0%,
      var(--text-2) 25%,
      var(--brand) 50%,
      var(--text-2) 75%,
      var(--text-faint) 100%
    );
    background-size: 200% auto;
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation: provision-shimmer 3s linear infinite;
  }
  @keyframes provision-shimmer {
    to {
      background-position: -200% center;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .provision-log.running {
      animation: none;
      -webkit-text-fill-color: var(--text-2);
      color: var(--text-2);
    }
  }
  .provision-log-empty {
    color: var(--text-faint);
    font-style: italic;
  }

  .add-daemon-advanced {
    margin-bottom: 0.75rem;
  }
  .add-daemon-advanced.nested {
    margin-top: 0.25rem;
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
  .disclosure-actions {
    margin-top: 0.25rem;
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
