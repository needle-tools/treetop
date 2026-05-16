<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { marked } from "marked";
  import ToolIcon from "./ToolIcon.svelte";
  import TerminalView from "./TerminalView.svelte";
  import { type SessionMenuItem } from "./SessionMenu.svelte";
  import SessionHeader from "./SessionHeader.svelte";
  import { relativeAge } from "./mention-providers";

  marked.setOptions({ breaks: true, gfm: true });

  // Make every link open in a new tab. We're a desktop-style dashboard —
  // following a link inside the chat panel would replace the whole UI.
  // Applies to both [text](url) and bare-URL autolinks (gfm enables those).
  //
  // Also: disable setext heading parsing (text + line-of-dashes →
  // <h2>). Agents constantly emit raw diffs and bash outputs that
  // contain `---` / `===` separator lines; setext turns the line above
  // those into an oversized heading, which reads as random font-size
  // jitter inside a chat message. ATX headings (`# Title`) still work
  // and keep their size hierarchy. Side effect: a bare `---` becomes
  // an <hr> instead of styling the prior line — that's fine for our
  // chat use case, and arguably more correct.
  marked.use({
    tokenizer: {
      lheading() {
        return undefined;
      },
    },
    renderer: {
      link(token: { href: string; title?: string | null; text: string }) {
        const href = token.href ?? "";
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        return `<a href="${escapeAttr(href)}"${title} target="_blank" rel="noopener noreferrer">${token.text}</a>`;
      },
    },
  });

  function escapeAttr(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function md(text: string | undefined): string {
    if (!text) return "";
    // Claude wraps pasted/screenshotted attachments as
    //   [Image: source: /abs/path/to/file.png]
    // Convert those to markdown images pointing at /api/image so they
    // render inline in the chat (with our 30vh height cap).
    const processed = text.replace(
      /\[Image:\s*source:\s*([^\]]+?\.(?:png|jpe?g|gif|webp|svg|bmp))\s*\]/gi,
      (_match, filePath) => {
        const url = `/api/image?path=${encodeURIComponent(filePath.trim())}`;
        return `![pasted image](${url})`;
      },
    );
    return marked.parse(processed, { async: false }) as string;
  }

  export let agent: "claude" | "codex" | "copilot" = "claude";
  export let source: string;
  /** Worktree this session column lives in. Used by the "Save as
   *  link" menu item to anchor the resulting sticky-link chip.
   *  Empty when the column is rendered outside a worktree context
   *  (orphan view, future surfaces) — the menu item is disabled
   *  then. */
  export let wtPath: string = "";
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};
  /** Called when the user successfully renames this session. Lets the
   *  parent refresh its `/api/repos` snapshot so the worktree row and
   *  the "+N sessions" popover reflect the new title immediately,
   *  without waiting on SSE / a poll cycle. */
  export let onTitleChange: () => void = () => {};
  /** Which view this column should mount in. `"read"` shows the markdown
   *  chat history; `"terminal"` immediately spawns a `claude --resume
   *  <sid>` PTY (the same thing the "Resume in terminal" button does at
   *  runtime). The parent persists this across reload so a hard refresh
   *  doesn't drop a user out of an active TUI back to history view. */
  export let initialMode: "read" | "terminal" = "read";
  /** Fired whenever the user flips between read and terminal mode (or
   *  the PTY exits and we flip back). The parent persists this so a
   *  page reload restores the same view. */
  export let onModeChange: (mode: "read" | "terminal") => void = () => {};
  /** Bubble PTY state up to App so the session-dock dot can render
     the same working/awaiting animations as the agent pill. Same
     shape as NewSessionCol's on:workingChange / on:awaitingChange. */
  export let onWorkingChange: (working: boolean) => void = () => {};
  export let onAwaitingChange: (awaiting: boolean) => void = () => {};
  /** Whole-file message count for this session, supplied by the parent
   *  from `/api/repos`'s pre-scanned agent metadata. `/api/session`
   *  only ships the trimmed tail (last MAX_CACHED_MESSAGES = 100), so
   *  the header reads "{loaded} of {total} messages" whenever total
   *  exceeds the loaded slice. undefined → fall back to just the
   *  loaded count. */
  export let totalMessageCount: number | undefined = undefined;
  /** Estimated context size, sourced from /api/repos' agent metadata.
   *  For Claude this is exact (last assistant turn's `usage.input +
   *  cache_read + cache_creation`); for Codex it's a chars/4 estimate.
   *  Rendered as a small chip in the header next to the message count. */
  export let contextTokens: number | undefined = undefined;
  /** True when `contextTokens` came from an authoritative usage block
   *  (Claude), false when it's a Codex chars/4 estimate. Drives the
   *  leading `~` in the chip. */
  export let contextTokensExact: boolean | undefined = undefined;
  /** Authoritative context-window cap shipped by the agent's JSONL
   *  itself (Codex 0.130+). When set, the chip uses it instead of the
   *  model-id heuristic. */
  export let contextWindow: number | undefined = undefined;
  /** Model id so the chip can pick a context-window cap (200k vs 1M). */
  export let model: string | undefined = undefined;

  interface NormalizedBlock {
    type:
      | "text"
      | "thinking"
      | "tool_use"
      | "tool_result"
      | "ide_context"
      | "system_reminder"
      | "command"
      | "marker";
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    toolUseId?: string;
    tagName?: string;
  }
  interface NormalizedMessage {
    role: "user" | "assistant" | "system" | "tool";
    blocks: NormalizedBlock[];
    timestamp?: string;
    id?: string;
  }
  interface NormalizedSession {
    agent: string;
    cwd: string;
    sessionId: string;
    startedAt?: string;
    endedAt?: string;
    messages: NormalizedMessage[];
    manualTitle?: string;
  }

  let session: NormalizedSession | null = null;
  let loading = false;
  let error = "";
  let messagesEl: HTMLElement | null = null;
  let lastLoadedAt = 0;
  let pollCount = 0;
  let inputText = "";
  let sending = false;
  let sendError = "";
  /** Render mode for this column. "read" is the markdown-rendered chat
   *  view (default). "terminal" flips the panel to an xterm.js TUI
   *  running `claude --resume <sid>` against the same session id. The
   *  Resume button toggles this; closing the terminal flips back.
   *  Initial value comes from `initialMode` so the parent can hydrate
   *  it from persisted state on remount. */
  let mode: "read" | "terminal" = initialMode;
  // Notify the parent on every user-initiated mode flip so it can
  // persist the preference. We compare against `prevMode` so the initial
  // assignment doesn't fire a callback before any interaction (the
  // parent already knows the initial value — it set it).
  let prevMode: "read" | "terminal" = initialMode;
  $: if (mode !== prevMode) {
    prevMode = mode;
    onModeChange(mode);
  }
  /** The daemon-assigned terminal id once TerminalView spawns the PTY.
   *  The Dispose button DELETEs against this. */
  let terminalId: string | null = null;
  let disposing = false;
  /** Daemon-detected "agent is paused on a prompt" flag. Drives the
   *  amber outline on the column + a "needs input" pill in the
   *  header. Cleared automatically when the agent prints non-prompt
   *  output or the user types. */
  let awaitingInput = false;
  /** Live "agent is emitting output right now" flag — TerminalView
   *  raises it on each PTY frame and lowers it after ~1.5s of silence.
   *  Drives the rotating-gradient border on the agent pill. */
  let working = false;

  /** Hard ceiling on how long we wait for `DELETE /api/terminals/:id` to
   *  return before flipping the column back to read mode anyway. The
   *  daemon's grace timer will reap the PTY regardless, so a hung
   *  request shouldn't strand the user with a "Disposing…" button. */
  const DISPOSE_TIMEOUT_MS = 5_000;
  async function disposeTerminal() {
    if (disposing) return;
    disposing = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPOSE_TIMEOUT_MS);
    let timedOut = false;
    try {
      if (terminalId) {
        await fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
          method: "DELETE",
          signal: controller.signal,
        }).catch((e) => {
          // AbortError = we timed out; anything else = network blip.
          // Either way the daemon's grace timer will clean up the PTY,
          // so we still flip back to read mode below.
          if (e?.name === "AbortError") timedOut = true;
        });
      }
    } finally {
      clearTimeout(timeout);
      if (timedOut) {
        sendError =
          "Dispose timed out after 5s — the daemon will reap the PTY on its own; flipping back to read view.";
      }
      // Flip back to read mode and force a scroll-to-bottom on the next
      // render — the user expects to land at the newest messages, not
      // wherever they last scrolled to before opening the terminal.
      // Persist the mode flip too, otherwise App.svelte's openSessionsByWt
      // still carries `mode: "terminal"` and the next load() / page reload
      // tries to respawn the PTY we just killed — which races the daemon's
      // grace-timer cleanup and can look like the column disappeared.
      terminalId = null;
      disposing = false;
      hasRenderedOnce = false;
      mode = "read";
      onModeChange(mode);
      void load();
    }
  }
  /** Live count of claude subprocesses the daemon is still running for
   *  THIS session — set from /api/active-sends polling. Renders an
   *  in-header indicator with a cancel-all button. */
  interface InflightRec {
    id: string;
    agent: string;
    sessionId: string;
    pid: number;
    textPreview: string;
    startedAt: string;
  }
  let inflight: InflightRec[] = [];
  $: manualTitle = session?.manualTitle ?? "";

  function onManualTitleSaved(next: string) {
    // Optimistic local mirror so the header reads the new title
    // immediately, without waiting on the 2s /api/session poll. The
    // next load() reconfirms it (the daemon injects manualTitle into
    // the /api/session response from its own title store).
    if (session) {
      session = { ...session, manualTitle: next || undefined };
    }
    // Nudge the parent to re-fetch /api/repos so the worktree row's
    // agent badge and the "+N sessions" popover pick the new title
    // up right away (defense in depth — the daemon also broadcasts a
    // change event over SSE).
    onTitleChange();
  }

  /** Copy a string to the clipboard. Best-effort: silent on failure
   *  (browser refused permissions, document not focused, etc.). Used
   *  by the tool-result Copy button — the inline preview is
   *  substring-clamped + whitespace-collapsed, so the full original
   *  text only lives behind this click. */
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore — most likely permissions or unfocused document.
    }
  }

  /** Burger-menu items for the per-session header. SessionMenu owns the
   *  popover, click-outside handling, and "Copied to clipboard" flash
   *  for `kind: "copy"` items. */
  $: menuItems = ((): SessionMenuItem[] => {
    const sid = session?.sessionId;
    return [
      {
        kind: "copy",
        label: "Copy session ID + path",
        disabled: !sid,
        title: sid ? "Copy session id and file path to clipboard" : "No session id yet",
        getText: () => `${sid}\n${source}`,
      },
      {
        kind: "action",
        label: "Save as link",
        // Anchor is the current worktree — same data the saved-link
        // chip uses for its commit-provider / move-to picker. No
        // worktree → no anchor → disable.
        disabled: !wtPath,
        title: wtPath
          ? "Pin this session as a sticky-link on the row"
          : "No worktree to pin to",
        onSelect: () => void saveAsLink(),
      },
    ];
  })();

  /** POST a kind="link" sticky note anchored to the current worktree,
   *  targeting this session. The display snapshot (label/agent/
   *  msgCount/age) is read from /api/agents so the chip renders
   *  instantly without a follow-up lookup — same data shape the
   *  picker would produce if the user had searched for this session
   *  via the 🔗 button. SSE notifies the notes layer which appends
   *  the new chip into its row strip. */
  async function saveAsLink(): Promise<void> {
    if (!wtPath) return;
    type AgentRow = {
      source: string;
      agent: string;
      title?: string;
      manualTitle?: string;
      firstUserMessage?: string;
      sessionId?: string;
      messageCount?: number;
      lastActive: string;
    };
    let label = "(session)";
    let agentName: string = agent;
    let msgCount = 0;
    let lastActive = new Date().toISOString();
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const all = (await res.json()) as AgentRow[];
        const found = all.find((s) => s.source === source);
        if (found) {
          agentName = found.agent;
          label =
            (found.manualTitle && found.manualTitle.trim()) ||
            (found.title && found.title.trim()) ||
            (found.firstUserMessage && found.firstUserMessage.trim()) ||
            (found.sessionId ? `session ${found.sessionId.slice(0, 8)}` : "(untitled)");
          msgCount = found.messageCount ?? 0;
          lastActive = found.lastActive;
        }
      }
    } catch {
      // Snapshot is best-effort — falling through with defaults still
      // produces a valid (less-rich) link chip.
    }
    const target = {
      type: "session" as const,
      value: source,
      label,
      agent: agentName,
      subtitle: msgCount > 0 ? `${msgCount} msg` : "",
      meta: relativeAge(lastActive),
    };
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "",
          anchors: [`worktree:${wtPath}`],
          kind: "link",
          target,
        }),
      });
      if (!res.ok) {
        // Bubble the daemon's error reason up to the chat header
        // so a 4xx (validation, ID conflict) doesn't fail silently
        // — the user just sees "menu item did nothing" otherwise.
        const errBody = await res.json().catch(() => ({}));
        error = `save-as-link failed: ${errBody.error ?? `HTTP ${res.status}`}`;
        return;
      }
      // The daemon broadcasts a `change` SSE on success; the notes
      // layer picks it up via changeKey++ → refresh() and renders
      // the new chip in the row strip. No imperative client state
      // change needed here.
    } catch (e) {
      error = `save-as-link failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Squash a tool-result blob into a single one-line preview for the
   *  chat. Newlines and consecutive whitespace collapse to a single
   *  space; leading/trailing whitespace is trimmed; everything past
   *  `max` chars becomes "…". The Copy button still exposes the raw
   *  text — this is purely a render-time clamp. */
  const TOOL_RESULT_PREVIEW_MAX = 200;
  function toolResultPreview(text: string): string {
    if (!text) return "";
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > TOOL_RESULT_PREVIEW_MAX
      ? flat.slice(0, TOOL_RESULT_PREVIEW_MAX) + "…"
      : flat;
  }

  /** When non-null we have a prompt in flight. The numeric value is the
   *  session.messages.length at the moment we hit Send; once load() sees
   *  a higher count we know claude wrote something back and can clear
   *  the composer + the in-flight flag. */
  let pendingSinceLen: number | null = null;
  /** Hard timeout for in-flight prompts. If claude never produces an
   *  answer (crashed, hung, no API key, ...), we surface an error
   *  instead of leaving the spinner up indefinitely. */
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Track whether we've already shown a session at least once. First render
  // = scroll to bottom. Subsequent renders = only auto-scroll if the user
  // was already near the bottom (so polling can't snatch them away when
  // they've scrolled up to read history).
  let hasRenderedOnce = false;
  /** Body of the previous /api/session response (raw text). The daemon's
   *  `jsonNoTitle` cache returns byte-identical bodies while the session
   *  file is idle, so we can skip JSON.parse, the messages-array
   *  rebuild, and the downstream `{@html md(...)}` churn on every block.
   *  This is the single biggest source of "the page is doing something
   *  twitchy every 2s" feel — markdown re-renders, scroll-to-bottom
   *  reactives, and (transitively) xterm refits in adjacent columns. */
  let lastResponseBody: string | null = null;

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const qs = new URLSearchParams({ source });
      const res = await fetch(`/api/session?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const bodyText = await res.text();
      // Idle short-circuit: identical response → no work. The daemon
      // already caches its stringified response (see sessions.ts
      // `jsonNoTitle`) so this is the natural matching half on the
      // client. pendingTimer still gets cleared below when relevant
      // because we only short-circuit when *nothing* changed.
      if (bodyText === lastResponseBody) return;
      lastResponseBody = bodyText;
      const next = JSON.parse(bodyText) as NormalizedSession;
      // Force a new identity for the messages array so Svelte's
      // reactivity definitely picks it up.
      session = { ...next, messages: [...next.messages] };
      lastLoadedAt = Date.now();
      pollCount += 1;
      console.debug(
        `[SessionView] poll #${pollCount}: ${session.messages.length} messages`,
      );
      // If a send is in flight, watch for the message count to grow —
      // that means claude has written at least the user-turn (and likely
      // the assistant turn too) into the JSONL. At that point we clear
      // the composer.
      if (pendingSinceLen !== null && session.messages.length > pendingSinceLen) {
        inputText = "";
        sending = false;
        pendingSinceLen = null;
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function refreshInflight() {
    if (!session?.sessionId) return;
    try {
      const res = await fetch(
        `/api/active-sends?sessionId=${encodeURIComponent(session.sessionId)}`,
      );
      if (!res.ok) return;
      inflight = (await res.json()) as InflightRec[];
    } catch {
      // best-effort indicator; ignore network blips
    }
  }

  async function cancelInflight(id: string) {
    try {
      await fetch(`/api/active-sends/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } finally {
      void refreshInflight();
    }
  }

  async function cancelAllInflight() {
    const ids = inflight.map((r) => r.id);
    await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/active-sends/${encodeURIComponent(id)}`, { method: "DELETE" }),
      ),
    );
    void refreshInflight();
  }

  async function sendMessage() {
    const text = inputText.trim();
    if (!text || sending || !session?.sessionId || !session.cwd) return;
    sending = true;
    sendError = "";
    // Capture the message count at send time. We clear the composer only
    // once a *new* message lands in the JSONL — see load() below.
    pendingSinceLen = session.messages.length;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (pendingSinceLen !== null) {
        sendError = "Claude didn't respond in 90s — try again or check claude logs";
        pendingSinceLen = null;
        sending = false;
      }
    }, 90_000);
    try {
      const res = await fetch("/api/session/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent,
          sessionId: session.sessionId,
          cwd: session.cwd,
          text,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
      pendingSinceLen = null;
      sending = false;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }
    // Note: we don't clear inputText or set sending=false here on success —
    // load() does it once it observes the new message(s) on disk.
  }

  function onComposerKey(e: KeyboardEvent) {
    // Enter sends. Shift+Enter inserts a newline. IME composition keeps
    // its own use of Enter and must not trigger a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendMessage();
    }
  }

  function relTimeFromNow(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 2) return "just now";
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }

  function relTimeFromIso(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)} days ago`;
  }

  function roleLabel(role: string): string {
    if (role !== "assistant") return role;
    if (agent === "claude") return "Claude";
    if (agent === "codex") return "Codex";
    if (agent === "copilot") return "Copilot";
    return "assistant";
  }

  function inputPreview(input: unknown): string {
    if (input === undefined) return "";
    let s: string;
    if (typeof input === "string") s = input;
    else {
      try {
        s = JSON.stringify(input);
      } catch {
        s = String(input);
      }
    }
    // Collapse all whitespace so multiline Bash heredocs fit on one line.
    s = s.replace(/\s+/g, " ").trim();
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  }

  $: if (source) {
    void load();
  }

  // Scroll-to-bottom policy:
  //   - First render (right after open or after switching sessions): jump
  //     to the newest message so you see "now".
  //   - Subsequent renders (the 2-second poll): only scroll if the user is
  //     already pinned near the bottom. If they've scrolled up to read
  //     history, we must not yank them back down.
  $: if (session && messagesEl) {
    const el = messagesEl;
    const NEAR = 64;
    const wasNearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    const shouldStick = !hasRenderedOnce || wasNearBottom;
    if (shouldStick) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    hasRenderedOnce = true;
  }

  // Live sync: dead-simple polling. Every 2s, refetch /api/session.
  // load() guards against overlapping calls and forces a new identity for
  // the messages array so Svelte's reactivity always re-renders. SSE was
  // proving fragile through Vite's proxy; this path is boring and works.

  let pollTimer: number | null = null;

  onMount(() => {
    pollTimer = window.setInterval(() => {
      void load();
      void refreshInflight();
    }, 2_000);
    // Kick off an immediate inflight refresh so the indicator's accurate
    // from the first render, not 2s later.
    void refreshInflight();
  });

  onDestroy(() => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    if (pendingTimer) clearTimeout(pendingTimer);
  });
</script>

<div class="session" class:awaiting-input={mode === "terminal" && awaitingInput}>
  <SessionHeader
    {agent}
    {source}
    {manualTitle}
    {mode}
    canResume={!!session?.sessionId && (agent === "claude" || agent === "codex")}
    canEnd={!!session?.sessionId && (agent === "claude" || agent === "codex")}
    {disposing}
    {awaitingInput}
    working={mode === "terminal" && working}
    loadedMessageCount={session?.messages.length}
    {totalMessageCount}
    {contextTokens}
    {contextTokensExact}
    {contextWindow}
    {model}
    lastActivityIso={session?.endedAt}
    {pollCount}
    {lastLoadedAt}
    {inflight}
    {menuItems}
    onTitleSaved={(next) => onManualTitleSaved(next)}
    onResume={() => (mode = "terminal")}
    onEndSession={disposeTerminal}
    onCancelInflight={cancelAllInflight}
    {onClose}
    {onDragStart}
    resumeTitle={agent === "codex"
      ? "Spawn a live `codex resume <id>` PTY in this session's cwd"
      : "Spawn a live `claude --resume <id>` PTY in this session's cwd"}
  />

  {#if mode === "terminal" && session?.sessionId && session.cwd}
    <TerminalView
      cmd={agent === "codex"
        ? [
            // codex's `resume` subcommand takes a session id as a
            // positional arg (per `codex resume --help`: picker by
            // default, --last for most recent, or pass an id). We
            // don't pass `--dangerously-bypass-approvals-and-sandbox`
            // — that's the analog of claude's
            // `--allow-dangerously-skip-permissions` and we leave
            // approval policy to the user's codex config.
            "codex",
            "resume",
            session.sessionId,
          ]
        : [
            "claude",
            "--resume",
            session.sessionId,
            // Unlocks the in-TUI option to switch to dangerously-skip-permissions
            // (without enabling it by default). This is the flag from
            // `claude --help` whose description is exactly "Enable bypassing all
            // permission checks as an option, without it being enabled by default".
            // Without it, the slash-command toggle inside the TUI is unavailable.
            "--allow-dangerously-skip-permissions",
          ]}
      cwd={session.cwd}
      ownerId={session.sessionId}
      procName={`supergit-tui-${session.sessionId.slice(0, 8)}-${agent}`}
      onSpawn={(id) => (terminalId = id)}
      onAwaitingChange={(a) => {
        awaitingInput = a;
        onAwaitingChange(a);
      }}
      onWorkingChange={(w) => {
        working = w;
        onWorkingChange(w);
      }}
      onExit={() => {
        // PTY finished by itself (user typed `exit`, agent crashed, ...).
        // Same effect as Dispose: flip to read, scroll to the newest
        // messages on the next render.
        terminalId = null;
        hasRenderedOnce = false;
        mode = "read";
        void load();
      }}
    />
  {:else if error}
    <p class="error">{error}</p>
  {:else if loading && !session}
    <div class="loading-overlay">
      <span class="spinner" aria-hidden="true"></span> loading session…
    </div>
  {:else if session && session.messages.length === 0}
    <p class="muted small">No messages parsed from this session.</p>
  {:else if session}
    <ul class="messages" bind:this={messagesEl}>
      {#each session.messages as m}
        <li class="msg role-{m.role}">
          <div class="msg-head">
            <span
              class="role"
              class:assistant={m.role === "assistant"}
              class:brand-claude={m.role === "assistant" && agent === "claude"}
              class:brand-codex={m.role === "assistant" && agent === "codex"}
              class:brand-copilot={m.role === "assistant" && agent === "copilot"}
            >
              {#if m.role === "assistant" && agent === "claude"}
                <img class="agent-icon" src="/agents/claude.svg" alt="" />
              {:else if m.role === "assistant" && agent === "codex"}
                <!-- Inlined so fill="currentColor" inherits the assistant
                     row's brand-green colour. Real vector this time
                     (codex2.svg) — single path. -->
                <svg
                  class="agent-icon agent-svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
                </svg>
              {/if}
              {roleLabel(m.role)}
            </span>
            {#if m.timestamp}
              <span
                class="muted small"
                title={new Date(m.timestamp).toLocaleString()}
              >
                {relTimeFromIso(m.timestamp)}
              </span>
            {/if}
          </div>
          {#each m.blocks as b}
            {#if b.type === "text"}
              <div class="block text md">{@html md(b.text)}</div>
            {:else if b.type === "thinking"}
              <div class="block thinking">
                <span class="tag-label">thinking</span>
                <div class="tag-body md">{@html md(b.text)}</div>
              </div>
            {:else if b.type === "tool_use"}
              <div class="block tool-use">
                <ToolIcon name={b.toolName} />
                <span class="tool-name">{b.toolName ?? "tool"}</span>
                <code class="tool-input" title={inputPreview(b.toolInput)}>
                  {inputPreview(b.toolInput)}
                </code>
              </div>
            {:else if b.type === "tool_result"}
              <div class="block tool-result">
                <span class="muted small">result</span>
                <div class="tool-result-body">
                  <code
                    class="tool-result-preview"
                    title={b.text ?? ""}
                  >{toolResultPreview(b.text ?? "")}</code>
                  <button
                    type="button"
                    class="copy-btn"
                    on:click={() => void copyToClipboard(b.text ?? "")}
                    title="Copy full tool result"
                    aria-label="Copy"
                  >Copy</button>
                </div>
              </div>
            {:else if b.type === "ide_context"}
              <div class="block ide-context" title={b.tagName}>
                <span class="tag-label">IDE · {b.tagName ?? "context"}</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {:else if b.type === "system_reminder"}
              <div class="block sys-reminder" title={b.tagName}>
                <span class="tag-label">system reminder</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {:else if b.type === "command"}
              <div class="block command" title={b.tagName}>
                <span class="tag-label">{b.tagName ?? "command"}</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {:else if b.type === "marker"}
              <div class="block marker">{b.text}</div>
            {/if}
          {/each}
        </li>
      {/each}
    </ul>
  {/if}

</div>

<style>
  .session {
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
    /* Fill the column so the row's height (which is set by the tallest
       sibling via the strip's default flex stretch) reaches the body —
       header takes its natural height, the body (TerminalView or
       .messages) grows to fill what's left via flex:1.
       No margin-top here: the parent .sessions-strip already provides
       its own spacing from the row above, and a margin combined with
       height:100% would push the bottom border under the strip's
       overflow-y:hidden and clip it. */
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    transition: border-color 0.2s ease;
  }
  /* When the daemon detects this column's PTY is paused on a prompt,
     outline the panel in soft amber + a gentle pulse, and surface a
     small "needs input" pill in the header. Matches the visual
     treatment on the App-side new-session-col so the language is
     consistent across read-mode-resumed terminals and brand-new
     transient TUI columns. */
  .session.awaiting-input {
    border-color: var(--status-dirty);
    animation: session-awaiting-pulse 1.8s ease-in-out infinite;
  }
  @keyframes session-awaiting-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-dirty) 0%, transparent); }
    50%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-dirty) 25%, transparent); }
  }
  /* When this column goes fullscreen, drop the rounded border + fill
     the viewport. TerminalView's ResizeObserver re-fits xterm for us. */
  .session:fullscreen {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
    border: 0;
    background: var(--surface-1);
  }
  @keyframes session-awaiting-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-dirty) 0%, transparent); }
    50%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-dirty) 25%, transparent); }
  }
  /* Burger menu UI + .session-menu-popover sizing now live in
     SessionMenu.svelte / styles/popover.css respectively. */
  .error {
    color: var(--error-text);
    padding: 0.5rem 0.75rem;
    margin: 0;
  }
  /* Composer pinned at the bottom of the session column. Borrowed from
     the same surface tokens as the header for visual consistency. */
  .composer {
    border-top: 1px solid var(--surface-3);
    background: var(--surface-2);
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  /* The textarea hosts the Send button absolutely-positioned in its
     bottom-right corner. Padding-right on the input keeps typed text
     from sliding under the button. */
  .composer-box {
    position: relative;
  }
  .composer-input {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    min-height: 2.5rem;
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 0.5rem 2.6rem 0.5rem 0.6rem;
    font: inherit;
    font-size: 0.85rem;
    line-height: 1.35;
  }
  .composer-input:focus {
    outline: none;
    /* Subtle neutral focus state — no brand color so the chat field
       doesn't shout for attention. */
    border-color: var(--text-faint);
  }
  .composer-input::placeholder {
    color: var(--text-muted);
  }
  .composer-error {
    color: var(--error-text);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-send {
    position: absolute;
    right: 0.4rem;
    bottom: 0.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.8rem;
    height: 1.8rem;
    background: transparent;
    color: var(--text-muted);
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.1s ease;
  }
  .composer-send:hover:not(:disabled) {
    color: var(--text-1);
  }
  .composer-send:disabled {
    cursor: not-allowed;
  }
  /* In-flight send: keep the spinner readable (slightly muted text)
     instead of fading the button to near-invisible. */
  .composer-send.is-sending:disabled {
    color: var(--text-4);
  }
  .composer-send:disabled:not(.is-sending) {
    color: var(--text-faint);
  }
  /* Matches the TerminalView "starting terminal…" pill so the
     read-mode load state and the live-TUI load state read identically. */
  .loading-overlay {
    align-self: center;
    margin-top: 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface-2);
    color: var(--text-1);
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .loading-overlay .spinner {
    width: 0.75rem;
    height: 0.75rem;
    border-width: 2px;
  }
  .spinner {
    width: 0.9rem;
    height: 0.9rem;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spinner-spin 0.6s linear infinite;
  }
  @keyframes spinner-spin {
    to { transform: rotate(360deg); }
  }
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.75rem;
  }
  .messages {
    list-style: none;
    padding: 0.4rem 0.5rem;
    margin: 0;
    max-height: 50vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .msg {
    padding: 0.45rem 0.6rem;
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    border: 1px solid var(--surface-2);
    font-size: 0.82rem;
  }
  /* Role differentiation is via the .role label text now; no left bar. */
  .msg-head {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-bottom: 0.3rem;
  }
  .role {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 600;
  }
  /* For assistant rows we render the proper agent name (Claude/Codex/...).
     Keep the typographic shape but ditch uppercase so the brand name reads
     as itself, and colour it by brand. */
  .role.assistant {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.8rem;
  }
  .role.brand-claude {
    color: var(--chip-orange-text);
  }
  .role .agent-icon {
    width: 1em;
    height: 1em;
    vertical-align: -0.12em;
    margin-right: 0.35em;
  }
  .role .agent-icon.agent-svg {
    /* Inline-SVG icon: fill="currentColor" inherits the role's text color. */
    display: inline-block;
  }
  .role.brand-codex {
    color: var(--chip-codex-text);
  }
  .role.brand-copilot {
    color: var(--chip-default-text);
  }
  .block.text {
    word-break: break-word;
  }

  /* Markdown rendering. Keep elements quiet enough for a chat density
     (small margins, subtle code chips). */
  .md :global(p) {
    margin: 0.35em 0;
  }
  .md :global(p:first-child) {
    margin-top: 0;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(code) {
    background: var(--surface-2);
    padding: 0.05em 0.35em;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.92em;
  }
  .md :global(pre) {
    background: var(--surface-0);
    padding: 0.55em 0.75em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.45em 0;
    font-size: 0.82em;
    border: 1px solid var(--surface-2);
  }
  .md :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
    margin: 0.4em 0;
  }
  .md :global(li) {
    margin: 0.15em 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.3;
  }
  .md :global(h1) {
    font-size: 1.15em;
  }
  .md :global(h2) {
    font-size: 1.05em;
  }
  .md :global(h3),
  .md :global(h4) {
    font-size: 1em;
  }
  .md :global(blockquote) {
    border-left: 2px solid var(--surface-3);
    padding-left: 0.65em;
    color: var(--text-muted);
    margin: 0.4em 0;
  }
  .md :global(a) {
    color: var(--brand);
    text-decoration: none;
  }
  .md :global(a:hover) {
    text-decoration: underline;
  }
  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--surface-2);
    margin: 0.5em 0;
  }
  .md :global(img) {
    max-width: 100%;
    max-height: 30vh;
    width: auto;
    height: auto;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    display: block;
    margin: 0.4em 0;
    /* alt-text shown if the image fails to load — keep it compact */
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .md :global(table) {
    border-collapse: collapse;
    margin: 0.4em 0;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--surface-2);
    padding: 0.25em 0.5em;
    text-align: left;
  }
  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
  }
  .block.tool-use {
    margin-top: 0.3rem;
    display: flex;
    gap: 0.45rem;
    align-items: center;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    color: var(--text-3);
    min-width: 0;
  }
  .tool-name {
    color: var(--text-2);
    flex: 0 0 auto;
  }
  .tool-input {
    color: var(--text-muted);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .block.tool-result {
    margin-top: 0.3rem;
  }
  /* Body row: one-line preview grows, copy button pins right. The
     preview is whitespace-collapsed + substring-clamped server-side
     (`toolResultPreview`) so the chat scroll doesn't drown in
     200-line tool outputs. No height clamp — that was cutting glyphs
     vertically. The Copy button exposes the raw multi-line text. */
  .tool-result-body {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .block.tool-result .tool-result-preview {
    flex: 1;
    min-width: 0;
    margin: 0.2rem 0 0;
    padding: 0.3rem 0.6rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .block.tool-result .copy-btn {
    flex: 0 0 auto;
    margin-top: 0.2rem;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 0.15rem 0.5rem;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    line-height: 1;
    cursor: pointer;
  }
  .block.tool-result .copy-btn:hover {
    background: var(--surface-3);
    color: var(--text-1);
  }
  .block.ide-context,
  .block.sys-reminder,
  .block.command {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .tag-label {
    flex: 0 0 auto;
    font-family: ui-monospace, monospace;
    text-transform: lowercase;
    font-weight: 600;
    color: var(--text-muted);
  }
  .tag-body {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .block.ide-context {
    background: rgba(37, 99, 235, 0.08);
  }
  .block.ide-context .tag-label {
    color: var(--chip-default-text);
  }
  .block.sys-reminder {
    background: rgba(217, 119, 6, 0.08);
  }
  .block.sys-reminder .tag-label {
    color: var(--chip-orange-text);
  }
  .block.command {
    background: rgba(22, 163, 74, 0.08);
  }
  .block.command .tag-label {
    color: var(--chip-green-text);
  }
  .block.thinking {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    background: rgba(160, 160, 160, 0.06);
    border-radius: var(--radius-sm);
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .block.thinking .tag-body {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .block.marker {
    margin-top: 0.2rem;
    font-style: italic;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
</style>
