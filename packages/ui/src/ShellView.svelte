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
  }

  let transcript: Transcript | null = null;
  let loading = false;
  let error = "";

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
      title="Spawn a new shell here at the last known cwd"
    >Resume ▶</button>
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
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--surface-2);
  }
  .resume-btn {
    margin-left: auto;
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
    background: var(--surface-2);
    border: 0;
    color: var(--text-1);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .resume-btn:hover:not(:disabled) {
    background: var(--surface-3);
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
    font-size: 0.95rem;
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
    font-size: 0.8rem;
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
</style>
