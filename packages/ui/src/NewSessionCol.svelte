<script lang="ts">
  /**
   * Transient new-session column: the bordered card shown in the
   * sessions strip while a brand-new agent (Claude / Codex) or a plain
   * `$SHELL` terminal is alive, before any JSONL has been written to
   * disk. After the JSONL appears, the parent flips the column to a
   * SessionView (Claude/Codex) or — on dispose — to a ShellView read-
   * mode transcript.
   *
   * This component used to be an inline ~110-line template inside
   * App.svelte's `{#each rows}` loop. Phase 2 of the App.svelte
   * refactor — see plans/PLAN.md "App.svelte refactor
   * (componentization)".
   *
   * All three live-column variants (shell, claude, codex) route through
   * this same component. Per-variant differences:
   *   - the agent-pill text + brand colour come from `agent`
   *   - the subtitle reads "new session — Terminal" for shell,
   *     "— TUI" otherwise
   *   - the Dispose button shows only for shell columns
   */
  import { createEventDispatcher } from "svelte";
  import TerminalView from "./TerminalView.svelte";

  type AgentKind = "claude" | "codex" | "copilot" | "shell";

  export let agent: AgentKind;
  export let source: string;
  /** Worktree path — only used so the parent can attribute the events
   *  to the right row when they fire. */
  export let wtPath: string;
  export let cmd: string[];
  export let cwd: string;
  export let procName: string;
  /** When this column reattached to an existing daemon-side PTY (e.g.
   *  after a UI reload), `attachTermId` carries the existing id and
   *  TerminalView skips the spawn POST. */
  export let attachTermId: string | undefined = undefined;
  /** The saved manual title for this column (lives in App.svelte's
   *  `newSessionTitles` map, persisted server-side via `/api/session/title`).
   *  Empty / undefined → render the "Name this session…" placeholder. */
  export let manualTitle: string | undefined = undefined;
  /** Whether the inline TUI is currently paused waiting for user input.
   *  Drives the amber pulse border + "needs input" pill in the header.
   *  Lives in App.svelte (it's also read for poll-cadence tuning), so
   *  we read it as a prop and bubble changes via on:awaitingChange. */
  export let awaiting = false;

  const dispatch = createEventDispatcher<{
    close: void;
    dispose: void;
    restart: void;
    spawn: { id: string };
    awaitingChange: { awaiting: boolean };
    titleSave: { title: string };
  }>();

  let editing = false;
  let draft = "";

  function startTitleEdit() {
    draft = manualTitle ?? "";
    editing = true;
  }

  function saveTitle() {
    const next = draft.trim();
    editing = false;
    if (next === (manualTitle ?? "")) return;
    dispatch("titleSave", { title: next });
  }

  function onTitleKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveTitle();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editing = false;
    }
  }

  /** Svelte action: focus + select the input on mount. */
  function autoFocusSelect(node: HTMLInputElement) {
    requestAnimationFrame(() => {
      node.focus();
      node.select();
    });
    return {};
  }

  /** Fullscreen the column itself (xterm's FitAddon picks up the
   *  resulting resize via its ResizeObserver, no extra wiring). */
  let rootEl: HTMLDivElement | undefined;
  async function toggleFullscreen() {
    if (!rootEl) return;
    try {
      if (document.fullscreenElement === rootEl) {
        await document.exitFullscreen();
      } else {
        if (document.fullscreenElement) await document.exitFullscreen();
        await rootEl.requestFullscreen();
      }
    } catch {
      // Browser refused (permissions, already exiting, etc.) — silent.
    }
  }
</script>

<div
  class="session new-session-col"
  class:awaiting-input={awaiting}
  bind:this={rootEl}
>
  <header class="new-session-head">
    <span class="agent-pill agent-{agent}">{agent}</span>
    {#if editing}
      <input
        class="manual-title-input"
        bind:value={draft}
        on:keydown={onTitleKey}
        on:blur={saveTitle}
        use:autoFocusSelect
        placeholder="Name this session…"
        maxlength="120"
      />
    {:else}
      <button
        type="button"
        class="manual-title"
        class:placeholder={!manualTitle}
        title={manualTitle
          ? "Click to rename this session"
          : "Click to name this session"}
        on:click={startTitleEdit}
      >
        {manualTitle || "Name this session…"}
      </button>
    {/if}
    <span class="muted small">
      {agent === "shell" ? "new session — Terminal" : "new session — TUI"}
    </span>
    {#if awaiting}
      <span
        class="awaiting-pill"
        title="The agent is paused waiting for input — click the terminal and respond."
      >needs input</span>
    {/if}
    <button
      class="restart-btn"
      on:click={() => dispatch("restart")}
      title={`Re-run \`${agent}\` in this column (use after a self-update)`}
      aria-label="Restart"
    >↻</button>
    <button
      class="fullscreen-btn"
      on:click={() => void toggleFullscreen()}
      title="Fullscreen this terminal (Esc to exit)"
      aria-label="Fullscreen"
    >⛶</button>
    <button
      class="dispose-btn"
      on:click={() => dispatch("dispose")}
      title={agent === "shell"
        ? "Dispose the PTY and keep this column in past-shell view (Resume reopens it later)"
        : "SIGTERM the PTY — the column stays open showing the final output until you click × to close."}
    >Dispose</button>
    <button
      class="close"
      on:click={() => dispatch("close")}
      title="Close + dispose this terminal"
    >×</button>
  </header>

  <TerminalView
    {cmd}
    {cwd}
    {procName}
    {attachTermId}
    onSpawn={(id) => dispatch("spawn", { id })}
    onAwaitingChange={(next) => dispatch("awaitingChange", { awaiting: next })}
    onExit={() => {
      /* Deliberately NOT closing the column on PTY exit. Some agents
         (notably `codex`) restart themselves after an in-place update —
         they exit, then a fresh process spawns. If we auto-disposed
         here, the user would lose the new process and the update
         notice. Instead we leave the column open showing the final
         output; the user dismisses via the × in the header. */
    }}
  />
</div>

<!-- All styling lives in packages/ui/src/styles/new-session.css. -->
