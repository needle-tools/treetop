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
  import { type SessionMenuItem } from "./SessionMenu.svelte";
  import SessionHeader from "./SessionHeader.svelte";
  import { saveSessionAsLink } from "./save-session-as-link";

  type AgentKind = "claude" | "codex" | "copilot" | "ollama" | "shell";

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
  /** When this shell column is a Resume of a past shell, the prior
   *  termId. Forwarded to TerminalView, which sends it in the spawn
   *  POST so the daemon pre-seeds the new shell's JSONL with the prior
   *  cmd history. Shell-only — agent restarts mint fresh transcripts. */
  export let resumeFromTermId: string | undefined = undefined;
  /** The saved manual title for this column (lives in App.svelte's
   *  `newSessionTitles` map, persisted server-side via `/api/session/title`).
   *  Empty / undefined → render the "Name this session…" placeholder. */
  export let manualTitle: string | undefined = undefined;
  /** Whether the inline TUI is currently paused waiting for user input.
   *  Drives the amber pulse border + "needs input" pill in the header.
   *  Lives in App.svelte (it's also read for poll-cadence tuning), so
   *  we read it as a prop and bubble changes via on:awaitingChange. */
  export let awaiting = false;
  /** Live "PTY is emitting output" flag. Drives the rotating-gradient
   *  border on the agent pill (working) vs the slow pulsate (idle).
   *  Same shape as `awaiting`: held in App.svelte and bubbled up via
   *  on:workingChange. */
  export let working = false;
  /** Once the agent's JSONL is detected (App.svelte matches by
   *  resumeSessionId), these mirror the equivalent SessionView props
   *  so the header's ctx chip / activity / message count light up
   *  while the user is still in the TUI. Undefined ⇒ the header shows
   *  the "new session" placeholders instead. */
  export let totalMessageCount: number | undefined = undefined;
  export let contextTokens: number | undefined = undefined;
  export let contextTokensExact: boolean | undefined = undefined;
  export let contextWindow: number | undefined = undefined;
  export let model: string | undefined = undefined;
  export let lastActivityIso: string | undefined = undefined;
  /** Text of the user's most recent message in this session — fed
   *  through to SessionHeader so the "last activity" chip's hover
   *  tooltip can show it. App.svelte derives this from the daemon's
   *  AgentSession index (same source as `lastActivityIso`). */
  export let lastUserMessage: string | undefined = undefined;
  /** Forwarded to SessionHeader so dragging the live-TUI column's
   *  header registers a drag source with the parent strip — without
   *  this the drop handler in App.svelte never sees a source and the
   *  column snaps back instead of reordering. */
  export let onDragStart: (e: DragEvent) => void = () => {};
  /** For Ollama columns: the model tag chosen at spawn time (e.g.
   *  `qwen3-coder:30b`). Forwarded to SessionHeader as `agentLabel`
   *  so the pill shows the model the user picked instead of the
   *  generic "ollama" — every Ollama column would otherwise carry
   *  the same label. */
  export let ollamaModel: string | undefined = undefined;

  const dispatch = createEventDispatcher<{
    close: void;
    dispose: void;
    restart: void;
    spawn: { id: string };
    awaitingChange: { awaiting: boolean };
    workingChange: { working: boolean };
    exit: void;
    titleSave: { title: string };
  }>();

  /** Burger-menu items. Hosts the Restart action (was the inline ↻
   *  button), a Copy command-line option (handy when grabbing the
   *  exact `claude --resume <id>` line for an external terminal),
   *  and Save-as-link for the active TUI — same chip the chat-
   *  session menu produces, so a running shell / Claude TUI can be
   *  pinned to the row before any JSONL exists. The chip's title
   *  picks up the real session name once the agent writes to disk
   *  (StickyNote resolves the label live from repos[].worktrees[].
   *  agents on every render). */
  $: menuItems = [
    {
      kind: "copy",
      label: "Copy command + cwd",
      icon: "⧉",
      title: "Copy the spawn command and cwd to the clipboard",
      getText: () => `${cmd.join(" ")}\n${cwd}`,
    },
    {
      kind: "action",
      label: "Save as link",
      icon: "⤴",
      disabled: !wtPath,
      title: wtPath
        ? "Pin this TUI as a sticky-link on the row (auto-updates when the session names itself)"
        : "No worktree to pin to",
      onSelect: (triggerRect: DOMRect) => void saveAsLink(triggerRect),
    },
    {
      kind: "action",
      label: `Restart ${agent}`,
      icon: "↻",
      title: `Re-run \`${agent}\` in this column (use after a self-update)`,
      onSelect: () => dispatch("restart"),
    },
  ] satisfies SessionMenuItem[];

  async function saveAsLink(triggerRect: DOMRect): Promise<void> {
    if (!wtPath) return;
    try {
      await saveSessionAsLink({
        wtPath,
        source,
        fallbackAgent: agent,
        fallbackLabel: manualTitle,
        triggerRect,
      });
    } catch {
      // Best-effort — no error slot on this column. The
      // saveSessionAsLink helper itself only throws on a truly
      // unexpected failure (e.g. a runtime bug); 4xx/5xx are
      // already swallowed at the fetch boundary.
    }
  }
</script>

<div
  class="session new-session-col"
  class:awaiting-input={awaiting}
>
  <SessionHeader
    {agent}
    agentLabel={agent === "ollama" ? ollamaModel : undefined}
    {source}
    manualTitle={manualTitle ?? ""}
    mode="terminal"
    canResume={false}
    canEnd
    awaitingInput={awaiting}
    {working}
    {totalMessageCount}
    {contextTokens}
    {contextTokensExact}
    {contextWindow}
    {model}
    {lastActivityIso}
    {lastUserMessage}
    lastActivityFallback="new session"
    messageCountFallback={agent === "shell" ? "starting…" : "no messages yet"}
    {menuItems}
    {onDragStart}
    onTitleSaved={(next) => dispatch("titleSave", { title: next })}
    onEndSession={() => dispatch("dispose")}
    onClose={() => dispatch("close")}
    endSessionTitle={agent === "shell"
      ? "Dispose the PTY and keep this column in past-shell view (Resume reopens it later)"
      : "SIGTERM the PTY — the column stays open showing the final output until you click × to close."}
    closeTitle={agent === "shell"
      ? "Close this column and dispose the terminal.\nThe transcript is kept on disk and can be reopened from the worktree's session picker."
      : "Close this column and stop the agent.\nOnce the agent has written its first message you can also reopen the session later from the worktree's picker."}
  />

  <TerminalView
    {cmd}
    {cwd}
    {procName}
    {attachTermId}
    {resumeFromTermId}
    onSpawn={(id) => dispatch("spawn", { id })}
    onAwaitingChange={(next) => dispatch("awaitingChange", { awaiting: next })}
    onWorkingChange={(next) => dispatch("workingChange", { working: next })}
    onExit={() => {
      /* Deliberately NOT closing the column on PTY exit. Some agents
         (notably `codex`) restart themselves after an in-place update —
         they exit, then a fresh process spawns. If we auto-disposed
         here, the user would lose the new process and the update
         notice. Instead we leave the column open showing the final
         output; the user dismisses via the × in the header. We do
         bubble an exit event up so the side dock can shrink the
         row's dot to mark the session as ended. */
      dispatch("exit");
    }}
  />
</div>

<!-- All styling lives in packages/ui/src/styles/new-session.css. -->
