<script lang="ts">
  /**
   * Read-mode column for a *past* shell session. Mirrors SessionView's
   * role for Claude/Codex transcripts: we fetch the JSONL through the
   * daemon, render the captured command history, and expose a "Resume"
   * button that spawns a fresh shell at the last known cwd.
   *
   * Live shells use TerminalView with `attachTermId` instead — this
   * component is only mounted for `__transcript__:shell:<id>` sources.
   */
  import { onMount } from "svelte";

  /** termId from the synthetic source. Stable identifier of the shell on
   *  disk (`<workspace>/shells/<termId>.jsonl`). */
  export let termId: string;
  /** Worktree the past shell belonged to. Used as the spawn cwd if the
   *  transcript hasn't loaded yet when the user clicks Resume. */
  export let wt: string;
  /** Called by the parent when the user clicks Resume — parent replaces
   *  the `__transcript__:` synthetic source with a `__new__:shell:` one
   *  pointing at the resolved last-known cwd. */
  export let onResume: (lastCwd: string) => void = () => {};
  /** Called when the user clicks ×. Parent removes the column. */
  export let onClose: () => void = () => {};

  interface CmdEntry {
    kind: "cmd";
    ts: string;
    line: string;
    cwd: string;
  }
  interface ExitEntry {
    kind: "exit";
    ts: string;
    code: number | null;
    signal?: string;
  }
  interface Transcript {
    header: {
      termId: string;
      wt: string;
      spawnCwd: string;
      createdAt: string;
    };
    cmds: CmdEntry[];
    exit: ExitEntry | null;
    lastCwd: string;
    alive: boolean;
    currentCwd: string;
    manualTitle?: string;
  }

  let transcript: Transcript | null = null;
  let loading = false;
  let error = "";
  /** Editable title for this past shell. Persisted via the workspace's
   *  session-titles store under the key `shell:<termId>` so it survives
   *  daemon restarts and shows up in the worktree session picker. */
  let manualTitleEditing = false;
  let manualTitleDraft = "";
  let manualTitleSaving = false;
  let manualTitleInputEl: HTMLInputElement | null = null;
  $: manualTitle = transcript?.manualTitle ?? "";

  function startManualTitleEdit() {
    manualTitleDraft = manualTitle;
    manualTitleEditing = true;
    requestAnimationFrame(() => {
      manualTitleInputEl?.focus();
      manualTitleInputEl?.select();
    });
  }

  async function saveManualTitle() {
    const next = manualTitleDraft;
    if (next === manualTitle) {
      manualTitleEditing = false;
      return;
    }
    manualTitleSaving = true;
    try {
      const res = await fetch("/api/session/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: `shell:${termId}`, title: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      if (transcript) {
        transcript = { ...transcript, manualTitle: next.trim() || undefined };
      }
    } catch {
      // best-effort — drop back to view-only so the user can retry
    } finally {
      manualTitleSaving = false;
      manualTitleEditing = false;
    }
  }

  function cancelManualTitleEdit() {
    manualTitleEditing = false;
    manualTitleDraft = "";
  }

  function onManualTitleKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveManualTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelManualTitleEdit();
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(
        `/api/shell-transcript?termId=${encodeURIComponent(termId)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      transcript = (await res.json()) as Transcript;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function resume() {
    const cwd = transcript?.lastCwd ?? wt;
    onResume(cwd);
  }

  function relTime(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    const diff = Date.now() - t;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }

  onMount(load);
</script>

<div class="session shell-session">
  <header>
    <span class="agent-pill agent-shell">shell</span>
    {#if manualTitleEditing}
      <input
        class="manual-title-input"
        bind:this={manualTitleInputEl}
        bind:value={manualTitleDraft}
        on:keydown={onManualTitleKey}
        on:blur={() => void saveManualTitle()}
        placeholder="Name this terminal…"
        maxlength="120"
        disabled={manualTitleSaving}
      />
    {:else}
      <button
        type="button"
        class="manual-title"
        class:placeholder={!manualTitle}
        title={manualTitle
          ? "Click to rename this past terminal"
          : "Click to name this past terminal"}
        on:click={startManualTitleEdit}
      >
        {manualTitle || "Name this terminal…"}
      </button>
    {/if}
    <span class="muted small">past terminal</span>
    {#if transcript}
      <span class="cwd-pill muted small" title={transcript.lastCwd}>
        {transcript.lastCwd.split("/").slice(-2).join("/") || "/"}
      </span>
      <span class="muted small">· {relTime(transcript.header.createdAt)}</span>
    {/if}
    <button
      class="resume-btn"
      on:click={resume}
      disabled={!transcript}
      title="Spawn a fresh shell at this past terminal's last known cwd"
    >Resume in terminal</button>
    <button
      class="close"
      on:click={onClose}
      title="Close this column"
    >×</button>
  </header>

  {#if loading && !transcript}
    <p class="muted small loading">Loading transcript…</p>
  {:else if error}
    <p class="error small">{error}</p>
  {:else if transcript}
    {#if transcript.cmds.length === 0}
      <p class="muted small empty">No commands were captured in this shell.</p>
    {:else}
      <ul class="cmds">
        {#each transcript.cmds as c (c.ts + c.line)}
          <li class="cmd-row">
            <span class="cwd muted" title={c.cwd || ""}>
              {(c.cwd || "").split("/").pop() || "~"}
            </span>
            <code class="line">{c.line}</code>
            <span class="ts muted small" title={c.ts}>{relTime(c.ts)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if transcript.exit}
      <p class="exit muted small">
        exited
        {transcript.exit.signal ? `(${transcript.exit.signal})` : ""}
        with code {transcript.exit.code ?? "?"} · {relTime(transcript.exit.ts)}
      </p>
    {/if}
  {/if}
</div>

<style>
  .session {
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* Single font scale for the header strip + the empty/loading/error
       blurbs below it. .muted + .small / .agent-pill / cwd-pill / Resume
       button / × all match. */
    font-size: 0.7rem;
  }
  /* Local equivalents of the App.svelte muted/small tokens — Svelte
     scopes styles per-component so we re-declare here. */
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.7rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--surface-2);
  }
  /* Mirror SessionView's `.resume-btn` so the Resume affordance reads
     identically between AI session columns and past-shell columns:
     transparent surface, thin border, small muted text. */
  .resume-btn {
    margin-left: auto;
    flex: 0 0 auto;
    align-self: center;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--surface-3);
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .resume-btn:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .resume-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .close {
    padding: 0.1rem 0.4rem;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
  }
  .close:hover {
    color: var(--error-text, #ffb4ad);
  }
  .cmds {
    list-style: none;
    margin: 0;
    padding: 0.3rem 0.5rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .cmd-row {
    display: grid;
    grid-template-columns: 6rem 1fr auto;
    gap: 0.5rem;
    padding: 0.15rem 0;
    border-bottom: 1px dotted color-mix(in srgb, var(--surface-2) 60%, transparent);
    align-items: baseline;
  }
  .cmd-row:last-child {
    border-bottom: 0;
  }
  .cwd {
    font-size: 0.7rem;
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .line {
    font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    font-size: 0.7rem;
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ts {
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .empty,
  .loading,
  .error {
    margin: 1rem 0.6rem;
  }
  .cwd-pill {
    font-family: "SF Mono", "JetBrains Mono", Menlo, monospace;
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .exit {
    padding: 0.4rem 0.6rem;
    border-top: 1px solid var(--surface-2);
  }
  .agent-pill {
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
  }
  /* Editable past-terminal title. Same visual language as SessionView's
     manualTitle widget: muted placeholder when unset, plain inline button
     when set, becomes a slim input on click. */
  .manual-title {
    background: transparent;
    border: 0;
    padding: 0.1rem 0.3rem;
    color: var(--text-1);
    font-size: 0.7rem;
    font-family: inherit;
    cursor: text;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .manual-title:hover {
    background: var(--surface-2);
  }
  .manual-title.placeholder {
    color: var(--text-faint);
    font-style: italic;
  }
  .manual-title-input {
    background: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    color: var(--text-1);
    padding: 0.1rem 0.35rem;
    font-size: 0.7rem;
    font-family: inherit;
    min-width: 12rem;
  }
  .manual-title-input:focus {
    outline: none;
    border-color: var(--brand);
  }
</style>
