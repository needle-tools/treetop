<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import {
    claudeAgentSettings,
    claudeSessionMenuItems,
    effortIcon,
  } from "./claude-session-menu";
  import SessionHeader from "./SessionHeader.svelte";
  import type { SessionMenuItem } from "./SessionMenu.svelte";
  import VisualTranscript from "./VisualTranscript.svelte";
  import {
    buildVisualTranscriptItems,
    lastUserMessageBurst,
    type VisualTranscriptItem,
  } from "./last-user-message";
  import type {
    WorkspacePreviewBlock,
    WorkspacePreviewMessage,
    WorkspacePreviewSession,
  } from "./repo-types";

  export let session: WorkspacePreviewSession;
  export let selected = false;

  const dispatch = createEventDispatcher<{
    close: WorkspacePreviewSession;
  }>();
  const previewLoadedAt = Date.now();

  const mode = "read";
  let transcriptSurface: "read" | "terminal" = "terminal";
  let stopping = false;
  let resumed = false;
  let claudeModel = session.claudeModel;
  let claudeEffort = session.claudeEffort;

  $: transcriptItems = session.transcript
    ? buildVisualTranscriptItems<WorkspacePreviewBlock, WorkspacePreviewMessage>(
        session.transcript,
        { active: session.state === "working" },
      )
    : ([] as VisualTranscriptItem<
        WorkspacePreviewBlock,
        WorkspacePreviewMessage
      >[]);
  $: lastUserMessage = lastUserMessageBurst(session.transcript ?? []);
  $: transcriptAgent =
    session.agent === "shell"
      ? "claude"
      : (session.agent as "claude" | "codex" | "copilot" | "ollama");
  $: canStop = session.state === "working" || session.state === "awaiting";
  $: canResume = !canStop || resumed;
  $: agentEffortIcon =
    session.agent === "claude"
      ? (() => {
          const icon = effortIcon(claudeEffort);
          return icon ? { ...icon, title: `effort: ${claudeEffort}` } : undefined;
        })()
      : undefined;
  $: agentSettings =
    session.agent === "claude"
      ? claudeAgentSettings({
          currentModel: claudeModel,
          detectedModel: session.model,
          currentEffort: claudeEffort,
          onPickModel: (model) => (claudeModel = model),
          onPickEffort: (effort) => (claudeEffort = effort),
        })
      : [];

  function menuAction(label: string): () => void {
    return () => {
      void label;
    };
  }

  $: menuItems = ((): SessionMenuItem[] => {
    const sid = session.sessionId;
    const claudeItems: SessionMenuItem[] =
      session.agent === "claude"
        ? claudeSessionMenuItems({
            currentModel: claudeModel,
            detectedModel: session.model,
            currentEffort: claudeEffort,
            onPickModel: (model) => (claudeModel = model),
            onPickEffort: (effort) => (claudeEffort = effort),
          })
        : [];
    return [
      ...claudeItems,
      {
        kind: "action",
        label: "Resume in external terminal",
        iconSvg: [
          "M5 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7",
          "M15 3h6v6",
          "M10 14 21 3",
        ],
        disabled: !sid,
        title: sid
          ? `Open your OS terminal and resume ${sid.slice(0, 8)}...`
          : "No session id yet",
        onSelect: () => {
          resumed = true;
        },
      },
      {
        kind: "copy",
        label: "Copy session ID + path",
        icon: "⧉",
        disabled: !sid,
        title: sid ? "Copy session id and transcript path" : "No session id yet",
        getText: () => `${sid ?? ""}\n${session.source}`,
      },
      {
        kind: "action",
        label: "Open session directory",
        iconSvg: [
          "M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
        ],
        title: "Open the folder containing this session log",
        onSelect: menuAction("open directory"),
      },
      {
        kind: "action",
        label: "Summarize with Ollama",
        icon: "✦",
        title: "Summarize this session with a local Ollama model",
        onSelect: menuAction("summarize"),
      },
      {
        kind: "action",
        label: "Copy to",
        iconSvg: [
          "M20 16V7a2 2 0 0 0-2-2H6",
          "M14 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z",
        ],
        title: "Copy this session to another workspace",
        onSelect: menuAction("copy to"),
      },
      {
        kind: "action",
        label: "Share session in local network",
        iconSvg: ["M22 2 11 13", "m22 2-7 20-4-9-9-4 20-7z"],
        title: "Send this session to another supergit on the LAN",
        onSelect: menuAction("share"),
      },
      {
        kind: "action",
        label: "Create a link note",
        icon: "⤴",
        title: "Pin this session as a sticky-link on the row",
        onSelect: menuAction("link note"),
      },
      {
        kind: "action",
        label: "Repair session",
        iconSvg: [
          "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        ],
        disabled: session.agent !== "claude",
        title:
          session.agent === "claude"
            ? "Diagnose and repair broken parent chains"
            : "Repair is only supported for Claude sessions",
        onSelect: menuAction("repair"),
      },
      {
        kind: "submenu",
        label: "Continue with...",
        iconSvg: ["m16 3 4 4-4 4", "M20 7H4", "m8 21-4-4 4-4", "M4 17h16"],
        title: "Start a new session with another agent",
        children: [
          {
            kind: "action",
            label: "Claude",
            disabled: session.agent === "claude",
            onSelect: menuAction("continue claude"),
          },
          {
            kind: "action",
            label: "Codex",
            disabled: session.agent === "codex",
            onSelect: menuAction("continue codex"),
          },
          {
            kind: "action",
            label: "Ollama",
            onSelect: menuAction("continue ollama"),
          },
        ],
      },
      {
        kind: "submenu",
        label: "View as",
        iconSvg: [
          "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z",
          "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
        ],
        title: "Switch display style without resuming the session",
        children: [
          {
            kind: "action",
            label: "Visual",
            selected: transcriptSurface === "read",
            onSelect: () => (transcriptSurface = "read"),
          },
          {
            kind: "action",
            label: "Terminal",
            iconSvg: ["m4 17 6-6-6-6", "M12 19h8"],
            selected: transcriptSurface === "terminal",
            onSelect: () => (transcriptSurface = "terminal"),
          },
        ],
      },
    ];
  })();
</script>

<div
  class="session workspace-session-preview"
  class:read-mode={true}
  class:workspace-session-selected={selected}
  class:selected
>
  <div class="session-head-stack">
    <SessionHeader
      agent={session.agent}
      source={session.source}
      manualTitle={session.manualTitle ?? ""}
      aiTitle={session.aiTitle ?? session.title ?? ""}
      {mode}
      agentLabel={session.agent === "claude" ? claudeModel : undefined}
      agentIcon={agentEffortIcon}
      {agentSettings}
      settingsPlaceholder={session.agent === "codex"
        ? "Codex model and effort controls appear here in the app."
        : undefined}
      canResume={canResume}
      canEnd={canStop}
      showEndInRead={canStop}
      disposing={stopping}
      awaitingInput={session.state === "awaiting"}
      working={session.state === "working"}
      loadedMessageCount={session.transcript?.length}
      totalMessageCount={session.messageCount}
      contextTokens={session.contextTokens}
      contextTokensExact={session.contextTokensExact}
      contextWindow={session.contextWindow}
      model={session.model}
      lastActivityIso={session.lastMessageTs ?? session.lastActive}
      lastUserMessage={lastUserMessage}
      pollCount={0}
      lastLoadedAt={previewLoadedAt}
      inflight={[]}
      {menuItems}
      closeTitle="Close this preview column"
      resumeTitle="Resume this session"
      endSessionTitle="Stop the running session"
      endSessionLabel="Stop"
      onResume={() => (resumed = true)}
      onEndSession={() => (stopping = !stopping)}
      onClose={() => dispatch("close", session)}
      onTitleSaved={() => {}}
    />
  </div>

  {#if transcriptItems.length > 0}
    <VisualTranscript
      agent={transcriptAgent}
      items={transcriptItems}
      active={session.state === "working"}
      {transcriptSurface}
    />
  {:else}
    <p class="muted small">No transcript loaded for this session.</p>
  {/if}
</div>
