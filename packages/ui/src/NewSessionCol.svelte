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
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import TerminalView from "./TerminalView.svelte";
  import { type SessionMenuItem } from "./SessionMenu.svelte";
  import SessionHeader from "./SessionHeader.svelte";
  import { saveSessionAsLink } from "./save-session-as-link";
  import { claudeModelAlias } from "./storage";
  import {
    claudeSessionMenuItems,
    claudeAgentSettings,
    effortIcon,
  } from "./claude-session-menu";
  import type { SshSessionInfo } from "./file-browser-utils";
  import { elementNearViewport } from "./col-visibility";
  import { apiWsUrl } from "./api";
  import {
    shouldHoldOffscreenAttachedTerminal,
    shouldMountNewSessionTerminal,
  } from "./session-source-routing";

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
  export let prefillCmd: string | undefined = undefined;
  /** The saved manual title for this column (lives in App.svelte's
   *  `newSessionTitles` map, persisted server-side via `/api/session/title`).
   *  Empty / undefined → render the "Name this session…" placeholder. */
  export let manualTitle: string | undefined = undefined;
  /** AI-generated title for this session (from the cached Ollama
   *  summary, surfaced on the detected agent via `/api/repos`). Shown as
   *  the rename input's placeholder when there's no manual title. */
  export let aiTitle: string | undefined = undefined;
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
   *  the "starting…" / "no messages yet" placeholder instead. */
  export let totalMessageCount: number | undefined = undefined;
  export let contextTokens: number | undefined = undefined;
  export let contextTokensExact: boolean | undefined = undefined;
  export let contextWindow: number | undefined = undefined;
  export let model: string | undefined = undefined;
  /** Claude model/effort overrides for this session (persisted in
   *  App.svelte's openSessionsByWt). Drive the agent-pill label and the
   *  ✓ in the header's Model/Effort menus. claude-only. */
  export let claudeModel: string | undefined = undefined;
  export let claudeEffort: string | undefined = undefined;
  export let lastActivityIso: string | undefined = undefined;
  /** Text of the user's most recent message in this session — fed
   *  through to SessionHeader so the "last activity" chip's hover
   *  tooltip can show it. App.svelte derives this from the daemon's
   *  AgentSession index (same source as `lastActivityIso`). */
  export let lastUserMessage: string | undefined = undefined;
  /** When set, terminal spawn and io WS are routed to this remote daemon. */
  export let daemonId: string | undefined = undefined;
  /** Forwarded to SessionHeader so dragging the live-TUI column's
   *  header registers a drag source with the parent strip — without
   *  this the drop handler in App.svelte never sees a source and the
   *  column snaps back instead of reordering. */
  export let onDragStart: (e: DragEvent) => void = () => {};
  /** Context text to seed into the PTY on first awaiting signal.
   *  Forwarded straight to TerminalView's initialPrompt. */
  export let initialPrompt: string | undefined = undefined;
  export let starred: boolean = false;
  export let onToggleStar: () => void = () => {};

  const dispatch = createEventDispatcher<{
    close: void;
    dispose: void;
    restart: void;
    setModel: { model: string };
    setEffort: { effort: string };
    spawn: { id: string };
    awaitingChange: { awaiting: boolean };
    workingChange: { working: boolean };
    exit: void;
    titleSave: { title: string };
    titleEditingChange: { editing: boolean };
    sshBrowse: { user: string | undefined; host: string; port: number };
    sshCwd: { cwd: string };
  }>();

  /** Mirrors the Stop Session UX from SessionView's resume-in-terminal
   *  mode (commit 290cef3): clicking End Session enters a 1-second
   *  cancellable grace window — the button shows a "Stopping…" spinner
   *  via SessionHeader's `disposing` prop, and a second click during
   *  the window aborts without touching the PTY. If the window elapses,
   *  the actual `dispose` event fires and the parent issues the SIGTERM.
   *
   *  Without this, brand-new agent columns (Claude, Codex, Ollama)
   *  killed the PTY synchronously with no visible feedback — the user
   *  couldn't tell whether their click registered. */
  const DISPOSE_GRACE_MS = 1000;
  let disposing = false;
  let disposeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  function handleEndSession(): void {
    if (disposeGraceTimer !== null) {
      // Second click inside the grace window → cancel.
      clearTimeout(disposeGraceTimer);
      disposeGraceTimer = null;
      disposing = false;
      return;
    }
    if (disposing) return;
    disposing = true;
    disposeGraceTimer = setTimeout(() => {
      disposeGraceTimer = null;
      // Fire the dispose event; the parent will DELETE the terminal.
      // Leave `disposing` true so the spinner stays visible until the
      // column either flips to a transcript view (which unmounts this
      // component) or the user × closes it.
      dispatch("dispose");
    }, DISPOSE_GRACE_MS);
  }

  /** Burger-menu items. Hosts the Restart action (was the inline ↻
   *  button), a Copy command-line option (handy when grabbing the
   *  exact `claude --resume <id>` line for an external terminal),
   *  and Save-as-link for the active TUI — same chip the chat-
   *  session menu produces, so a running shell / Claude TUI can be
   *  pinned to the row before any JSONL exists. The chip's title
   *  picks up the real session name once the agent writes to disk
   *  (StickyNote resolves the label live from repos[].worktrees[].
   *  agents on every render). */
  /** The agent-pill label. For Claude, show the model tier alias the
   *  session is actually running on (the persisted override wins, else
   *  the tier of the detected model) so the user reads "opus" rather
   *  than a generic "claude". Falls back to undefined (⇒ "claude") when
   *  unknown, and stays undefined for non-claude agents. */
  $: pillLabel =
    agent === "claude" ? claudeModelAlias(claudeModel ?? model) : undefined;

  /** Colour-coded effort glyph shown in the pill after the model name.
   *  Only when an effort override is set (the default is unknown). */
  $: agentEffortIcon = (() => {
    if (agent !== "claude") return undefined;
    const ic = effortIcon(claudeEffort);
    return ic ? { ...ic, title: `effort: ${claudeEffort}` } : undefined;
  })();

  $: claudeMenuItems =
    agent === "claude"
      ? claudeSessionMenuItems({
          currentModel: claudeModel,
          detectedModel: model,
          currentEffort: claudeEffort,
          onPickModel: (m) => dispatch("setModel", { model: m }),
          onPickEffort: (e) => dispatch("setEffort", { effort: e }),
        })
      : [];

  /** Pill settings popover — mirrors the menu's model/effort selection. */
  $: agentSettings =
    agent === "claude"
      ? claudeAgentSettings({
          currentModel: claudeModel,
          detectedModel: model,
          currentEffort: claudeEffort,
          onPickModel: (m) => dispatch("setModel", { model: m }),
          onPickEffort: (e) => dispatch("setEffort", { effort: e }),
        })
      : [];

  $: menuItems = [
    ...claudeMenuItems,
    {
      kind: "copy",
      label: "Copy command + cwd",
      icon: "⧉",
      title: "Copy the spawn command and cwd to the clipboard",
      getText: () => `${cmd.join(" ")}\n${cwd}`,
    },
    {
      kind: "action",
      label: "Create a link note",
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

  let sshSession: SshSessionInfo | null = null;
  let colEl: HTMLElement | null = null;
  let nearViewport = false;
  let visibilityObs: IntersectionObserver | null = null;
  let ancestorVisibilityObs: MutationObserver | null = null;
  let mounted = false;
  let holdWs: WebSocket | null = null;
  let holdTermId: string | undefined;

  $: terminalMounted = shouldMountNewSessionTerminal({
    hasCwd: !!cwd,
    nearViewport,
  });

  $: syncTerminalHold(
    mounted &&
      shouldHoldOffscreenAttachedTerminal({ attachTermId, terminalMounted })
      ? attachTermId
      : undefined,
  );

  function ancestorsNearViewport(): boolean {
    if (!colEl) return true;
    const col = colEl.closest(".session-col");
    const row = colEl.closest(".row");
    return (
      !col?.classList.contains("col-offscreen") &&
      !row?.classList.contains("row-offscreen")
    );
  }

  function syncViewportState(): void {
    const next =
      !!colEl && ancestorsNearViewport() && elementNearViewport(colEl);
    if (nearViewport !== next) nearViewport = next;
  }

  function closeTerminalHold(): void {
    const ws = holdWs;
    holdWs = null;
    holdTermId = undefined;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (
      ws.readyState === WebSocket.CONNECTING ||
      ws.readyState === WebSocket.OPEN
    ) {
      ws.close(1000, "terminal view mounted");
    }
  }

  function syncTerminalHold(termId: string | undefined): void {
    if (!termId) {
      closeTerminalHold();
      return;
    }
    if (
      holdWs &&
      holdTermId === termId &&
      holdWs.readyState !== WebSocket.CLOSING &&
      holdWs.readyState !== WebSocket.CLOSED
    ) {
      return;
    }
    closeTerminalHold();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      apiWsUrl(
        `/api/terminals/${encodeURIComponent(termId)}/io`,
        location.host,
        proto,
        daemonId,
      ),
    );
    holdWs = ws;
    holdTermId = termId;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: "visibility", visible: false, drain: false }),
      );
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data);
        if (
          parsed?.type === "state" &&
          typeof parsed.awaitingInput === "boolean"
        ) {
          dispatch("awaitingChange", { awaiting: parsed.awaitingInput });
        }
      } catch {
        // Ignore output/accounting frames; this socket only prevents grace-reap
        // while the expensive terminal renderer is deferred offscreen.
      }
    };
    ws.onclose = () => {
      if (holdWs !== ws) return;
      holdWs = null;
      holdTermId = undefined;
    };
  }

  onMount(() => {
    mounted = true;
    if (!colEl || typeof IntersectionObserver === "undefined") {
      nearViewport = true;
      return;
    }
    visibilityObs = new IntersectionObserver(() => syncViewportState(), {
      root: null,
      rootMargin: "300px",
      threshold: 0,
    });
    visibilityObs.observe(colEl);
    if (typeof MutationObserver !== "undefined") {
      ancestorVisibilityObs = new MutationObserver(syncViewportState);
      const col = colEl.closest(".session-col");
      const row = colEl.closest(".row");
      col &&
        ancestorVisibilityObs.observe(col, {
          attributes: true,
          attributeFilter: ["class"],
        });
      row &&
        ancestorVisibilityObs.observe(row, {
          attributes: true,
          attributeFilter: ["class"],
        });
    }
    syncViewportState();
    requestAnimationFrame(syncViewportState);
  });

  onDestroy(() => {
    mounted = false;
    closeTerminalHold();
    visibilityObs?.disconnect();
    visibilityObs = null;
    ancestorVisibilityObs?.disconnect();
    ancestorVisibilityObs = null;
  });

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
  bind:this={colEl}
>
  <SessionHeader
    {agent}
    agentLabel={pillLabel}
    agentIcon={agentEffortIcon}
    {agentSettings}
    {source}
    manualTitle={manualTitle ?? ""}
    aiTitle={aiTitle ?? ""}
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
    messageCountFallback={agent === "shell" ? "starting…" : "no messages yet"}
    {menuItems}
    {onDragStart}
    {starred}
    {onToggleStar}
    onTitleSaved={(next) => dispatch("titleSave", { title: next })}
    onTitleEditingChange={(e) => dispatch("titleEditingChange", { editing: e })}
    onEndSession={handleEndSession}
    {disposing}
    onClose={() => dispatch("close")}
    endSessionTitle={agent === "shell"
      ? "Dispose the PTY and keep this column in past-shell view (Resume reopens it later)"
      : "SIGTERM the PTY — the column stays open showing the final output until you click × to close."}
    closeTitle={agent === "shell"
      ? "Close this column and dispose the terminal.\nThe transcript is kept on disk and can be reopened from the worktree's session picker."
      : "Close this column and stop the agent.\nOnce the agent has written its first message you can also reopen the session later from the worktree's picker."}
    sshConnected={!!sshSession}
    onSshBrowse={() => {
      console.debug(
        "[NewSessionCol] onSshBrowse → dispatching sshBrowse, sshSession=",
        sshSession,
      );
      dispatch("sshBrowse", sshSession);
    }}
  />

  {#if terminalMounted}
    <TerminalView
      {cmd}
      {cwd}
      {agent}
      {procName}
      {attachTermId}
      {resumeFromTermId}
      sessionSource={source}
      {initialPrompt}
      {prefillCmd}
      {daemonId}
      onSpawn={(id) => dispatch("spawn", { id })}
      onAwaitingChange={(next) =>
        dispatch("awaitingChange", { awaiting: next })}
      onWorkingChange={(next) => dispatch("workingChange", { working: next })}
      onSshChange={(ssh) => {
        sshSession = ssh;
        if (ssh?.cwd) dispatch("sshCwd", { cwd: ssh.cwd });
      }}
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
  {:else}
    <div class="session-body-deferred" aria-hidden="true"></div>
  {/if}
</div>

<!-- All styling lives in packages/ui/src/styles/new-session.css. -->
