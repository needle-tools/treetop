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
   *  button) plus a Copy command-line option that's handy when
   *  grabbing the exact `claude --resume <id>` line for an external
   *  terminal. SessionMenu owns the copy-flash + close behaviour. */
  $: menuItems = [
    {
      kind: "copy",
      label: "Copy command + cwd",
      title: "Copy the spawn command and cwd to the clipboard",
      getText: () => `${cmd.join(" ")}\n${cwd}`,
    },
    {
      kind: "action",
      label: `Restart ${agent}`,
      title: `Re-run \`${agent}\` in this column (use after a self-update)`,
      onSelect: () => dispatch("restart"),
    },
  ] satisfies SessionMenuItem[];
</script>

<div
  class="session new-session-col"
  class:awaiting-input={awaiting}
>
  <SessionHeader
    {agent}
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
    lastActivityFallback="new session"
    messageCountFallback={agent === "shell" ? "starting…" : "no messages yet"}
    {menuItems}
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
