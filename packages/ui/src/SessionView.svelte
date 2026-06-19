<script lang="ts">
  import { apiUrl } from "./api";
  import { play } from "./sound";
  import { onMount, onDestroy } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import ToolIcon from "./ToolIcon.svelte";
  import TerminalView from "./TerminalView.svelte";
  import LoadingOverlay from "./LoadingOverlay.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import { type SessionMenuItem } from "./SessionMenu.svelte";
  import SessionHeader from "./SessionHeader.svelte";
  import { saveSessionAsLink } from "./save-session-as-link";
  import {
    claudeModelAlias,
    isLiveCodexAppSource,
    shouldPollSessionSource,
  } from "./storage";
  import {
    claudeSessionMenuItems,
    claudeAgentSettings,
    codexAgentSettings,
    effortIcon,
    type CodexModelInfo,
  } from "./claude-session-menu";
  import { getDaemonKV } from "./daemon-kv";
  import { openSummarize, activeSummarize } from "./summarize-dialog";
  import { shouldAutoSummarizeTui } from "./tui-auto-summary";
  import { openRepair } from "./repair-session-dialog";
  import { openShare } from "./share-session-dialog";
  import { openCopy } from "./copy-session-dialog";
  import { ICONS } from "./icons";
  import {
    buildVisualWorkDisplayEntries,
    buildVisualTranscriptItems,
    cleanVisualUserText,
    cleanVisualToolResultText,
    lastUserMessageBurst,
    lastUserMessageWithContext as buildLastUserMessageWithContext,
    visualFileEditSummaryForBlock,
    type VisualFileEditSummary,
    type VisualMarkerKind,
    type VisualWorkEntry,
    type VisualTranscriptItem,
  } from "./last-user-message";
  import { registerSessionPoll } from "./session-poll";
  import {
    codexEventThreadIdForSession,
    subscribeCodexEvents,
    type CodexAppEvent,
    type CodexEventStreamState,
  } from "./codex-event-stream";
  import { splitParent } from "./file-browser-utils";
  import { imageBlobHasAlpha, shrinkImageBlob } from "./image-shrink";
  import {
    codexAppInputFromComposer,
    inlineAttachmentLabel,
    type ImageInlineAttachment,
  } from "./note-inline-attachments";
  import { randomUUID } from "./random-id";
  import {
    canSaveCodexQueueEdit,
    enqueueCodexQueue,
    parseCodexQueue,
    removeCodexQueuedAttachment,
    removeCodexQueuedMessage as removeCodexQueueItem,
    updateCodexQueuedMessage,
    type CodexQueuedMessage,
  } from "./codex-queue";
  import { markdownCodeBlockHtml } from "./markdown-code";

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
      code(token: { text?: string; lang?: string | null }) {
        return markdownCodeBlockHtml(token.text ?? "", token.lang);
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
        const url = apiUrl(
          `/api/image?path=${encodeURIComponent(filePath.trim())}`,
          daemonId,
        );
        return `![pasted image](${url})`;
      },
    );
    return DOMPurify.sanitize(
      marked.parse(processed, { async: false }) as string,
    );
  }

  export let agent: "claude" | "codex" | "copilot" | "ollama" = "claude";
  export let source: string;
  /** Provider session/thread id for live native app sessions whose
   *  supergit source is synthetic rather than an on-disk transcript path. */
  export let resumeSessionId: string | undefined = undefined;
  /** Provider transcript path for stopped/history views and file-oriented
   *  menu actions. Live Codex App rendering does not poll this path. */
  export let transcriptSource: string | undefined = undefined;
  /** Owning daemon for this session's worktree. Undefined ⇒ local daemon
   *  (byte-identical behaviour). Set for remote daemon folder rows. */
  export let daemonId: string | undefined = undefined;
  /** Worktree this session column lives in. Used by the "Save as
   *  link" menu item to anchor the resulting sticky-link chip.
   *  Empty when the column is rendered outside a worktree context
   *  (orphan view, future surfaces) — the menu item is disabled
   *  then. */
  export let wtPath: string = "";
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};
  /** Overrides the header's Resume button behavior. By default the
   *  Resume action flips this column to terminal mode (which then
   *  spawns `claude --resume <sid>` / `codex resume <sid>`). Some
   *  agents (Ollama) don't have a CLI resume — the parent supplies a
   *  callback that spawns a fresh column elsewhere. When supplied
   *  this also forces `canResume = true` in the header so the button
   *  shows even though the default gate (which requires Claude or
   *  Codex + a sessionId) would have hidden it. */
  export let onCustomResume: (() => void) | undefined = undefined;
  /** Called when the column is in visual display mode and the user clicks
   *  Resume. For Codex App, the parent swaps a stopped transcript source
   *  to the live app-server source while preserving the transcript path. */
  export let onVisualResume: (() => void) | undefined = undefined;
  /** Optional extra menu items appended after the built-in ones in
   *  the header's burger menu. Used by Ollama to inject "Resume with
   *  context" alongside the default Resume action. */
  export let extraMenuItems: SessionMenuItem[] = [];
  /** Called when the user picks "Continue with <agent>" from the burger
   *  menu. The parent fetches /api/session/context, opens a new column
   *  for `targetAgent`, and seeds it with the conversation context.
   *  When undefined the menu items are hidden (e.g. copilot sessions
   *  where continuation isn't supported). */
  export let onContinueWith:
    | ((
        targetAgent: "claude" | "codex" | "ollama",
        ollamaModel?: string,
      ) => void)
    | undefined = undefined;
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
  /** Presentation style for the saved transcript when this column is not
   *  running a live PTY. "read" is the visual chat layout; "terminal"
   *  keeps the same parsed transcript but renders it as square-edged,
   *  monospace terminal history. */
  export let initialTranscriptSurface: "read" | "terminal" = "read";
  /** True only when the parent knows the user explicitly picked the
   *  experimental visual app-server surface for this session. Default
   *  read/transcript views must not grow the Codex composer. */
  export let visualAppEnabled: boolean = false;
  /** Fired whenever the user flips between read and terminal mode (or
   *  the PTY exits and we flip back). The parent persists this so a
   *  page reload restores the same view. */
  export let onModeChange: (mode: "read" | "terminal") => void = () => {};
  /** Fired when the user picks "View as…" from the overflow menu. Unlike
   *  onModeChange, this must never spawn or stop a PTY. */
  export let onTranscriptSurfaceChange: (
    surface: "read" | "terminal",
  ) => void = () => {};
  /** Bubble PTY state up to App so the session-dock dot can render
     the same working/awaiting animations as the agent pill. Same
     shape as NewSessionCol's on:workingChange / on:awaitingChange. */
  export let onWorkingChange: (working: boolean) => void = () => {};
  export let onAwaitingChange: (awaiting: boolean) => void = () => {};
  /** Bubble the daemon terminal id up to App when this column spawns (or
   *  re-spawns, e.g. after a stale-attach fallback) a PTY, so the parent
   *  can keep the session's `attachTermId` pointed at the live terminal. */
  export let onSpawn: (id: string) => void = () => {};
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
  /** When set, skip spawning a new PTY and reattach to this existing
   *  daemon-side terminal. Used when a transient `__new__:` column
   *  migrates to SessionView while the PTY is still alive. */
  export let attachTermId: string | undefined = undefined;
  /** Resting-state line cap for the read-mode summary snippet pill.
   *  The pill hover-expands to 50vh same as the TUI pin; this prop
   *  controls the at-rest cap. Default 6 so a ~300-char one-paragraph
   *  summary fits without truncation. */
  export let summaryMaxLines: number = 6;
  export let starred: boolean = false;
  export let onToggleStar: () => void = () => {};
  /** Claude model/effort overrides for this session (persisted by the
   *  parent in openSessionsByWt). Drive the agent-pill label, the ✓ in
   *  the header's Model/Effort menus, and the `--model`/`--effort` flags
   *  on the resume PTY. claude-only — undefined for other agents. */
  export let claudeModel: string | undefined = undefined;
  export let claudeEffort: string | undefined = undefined;
  /** Called when the user picks a model/effort from the header menu.
   *  The parent persists the choice and re-keys the column so the resume
   *  PTY respawns with the new flag ("restart via resume"). */
  export let onSetClaudeModel: (model: string) => void = () => {};
  export let onSetClaudeEffort: (effort: string) => void = () => {};

  interface NormalizedBlock {
    type:
      | "text"
      | "thinking"
      | "tool_use"
      | "tool_result"
      | "media"
      | "ide_context"
      | "system_reminder"
      | "command"
      | "marker";
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    toolUseId?: string;
    tagName?: string;
    mediaKind?: "image" | "file" | "artifact";
    mimeType?: string;
    path?: string;
    url?: string;
    title?: string;
    alt?: string;
  }
  interface NormalizedMessage {
    role: "user" | "assistant" | "system" | "tool";
    blocks: NormalizedBlock[];
    timestamp?: string;
    id?: string;
    /** Optional per-turn assistant label override. Set by the
     *  daemon's Ollama parser to the model that produced the turn
     *  (e.g. `gemma4:latest`). */
    author?: string;
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
  interface CodexUserInputOption {
    label: string;
    description: string | undefined;
  }
  interface CodexUserInputQuestion {
    id: string;
    header: string | undefined;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: CodexUserInputOption[] | null;
  }
  let session: NormalizedSession | null = null;
  let liveCodexApp = false;
  let sessionFileSource = "";
  let sessionPollSource = "";
  let shouldPollTranscript = true;
  let loading = false;
  let error = "";
  /** Outer column wrapper — used by the Save-as-link action so the
   *  fly animation can launch from the session column's bounding
   *  rect (visually anchors the chip to the source the user clicked
   *  from) before flying into the row's pin slot. */
  let sessionEl: HTMLDivElement | null = null;
  let messagesEl: HTMLElement | null = null;
  /** True while the cursor sits in the top 60% of the session column.
   *  Drives the pinned-last-message reveal: at rest the pin is hidden
   *  (out of the way of the TUI); a hover anywhere in the upper area
   *  fades it in so the user can glance back at their last prompt
   *  without scrolling the column. */
  /** Debug switch: `?debugPin` (any value) forces the summary /
   *  last-message overlay to stay revealed so its layout, pointer-events,
   *  and scroll behavior can be inspected without chasing the hover. */
  const FORCE_PIN =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("debugPin");
  let pinnedRevealed = FORCE_PIN;
  /** Vertical fraction of the session column below which the pin
   *  retracts. Generous threshold so the pin shows whenever the user
   *  is reading the top of the chat, not just brushing the title. */
  const PIN_REVEAL_RATIO = 0.5;
  /** Hide-only debounce. The pin shows instantly when the cursor
   *  enters the top zone, but lingers for 300ms after leaving so
   *  small excursions (or micro-movements past the threshold while
   *  reading) don't flicker it off. */
  const PIN_HIDE_DELAY_MS = 300;
  let pinHideTimer: ReturnType<typeof setTimeout> | null = null;
  let pinOverlayHovered = false;
  function cancelPinHide(): void {
    if (pinHideTimer) {
      clearTimeout(pinHideTimer);
      pinHideTimer = null;
    }
  }
  function setPinRevealed(target: boolean): void {
    if (FORCE_PIN) {
      pinnedRevealed = true;
      return;
    }
    if (target) {
      cancelPinHide();
      if (!pinnedRevealed) pinnedRevealed = true;
      return;
    }
    if (pinOverlayHovered) return;
    if (!pinnedRevealed || pinHideTimer) return;
    pinHideTimer = setTimeout(() => {
      pinnedRevealed = false;
      pinHideTimer = null;
    }, PIN_HIDE_DELAY_MS);
  }
  function onSessionMouseMove(ev: MouseEvent): void {
    if (!sessionEl) return;
    const r = sessionEl.getBoundingClientRect();
    if (r.height <= 0) return;
    const yFrac = (ev.clientY - r.top) / r.height;
    setPinRevealed(yFrac >= 0 && yFrac <= PIN_REVEAL_RATIO);
  }
  function onSessionMouseLeave(): void {
    setPinRevealed(false);
  }
  function onOverlayEnter(): void {
    pinOverlayHovered = true;
    cancelPinHide();
  }
  function onOverlayLeave(): void {
    pinOverlayHovered = false;
    setPinRevealed(false);
  }

  /** Settle-debounce for the chat scroll container. The user's
   *  complaint: when scrolling the page, drifting the cursor over
   *  the chat by accident hands the wheel to the chat and the page
   *  stops scrolling. Fix: only let `.messages` capture the wheel
   *  after the cursor has been parked inside for ≥ 300ms. Until
   *  then, wheel events are forwarded to the window so the page
   *  keeps scrolling. Combined with `overscroll-behavior: contain`
   *  on `.messages` this means: the chat is a true "scroll island"
   *  — needs intent to enter, and once entered won't bleed scroll
   *  back into the page. */
  const MSG_SETTLE_MS = 300;
  let msgCursorSettled = false;
  let msgSettleTimer: ReturnType<typeof setTimeout> | null = null;
  function onMessagesEnter(): void {
    msgCursorSettled = false;
    if (msgSettleTimer) clearTimeout(msgSettleTimer);
    msgSettleTimer = setTimeout(() => {
      msgCursorSettled = true;
      msgSettleTimer = null;
    }, MSG_SETTLE_MS);
  }
  function onMessagesLeave(): void {
    msgCursorSettled = false;
    if (msgSettleTimer) {
      clearTimeout(msgSettleTimer);
      msgSettleTimer = null;
    }
  }
  function onMessagesWheel(ev: WheelEvent): void {
    if (msgCursorSettled) return;
    // Horizontal-dominant wheels (trackpad swipes across the sessions
    // strip) must pass through so the parent strip can pan — don't
    // intercept those.
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    // Cursor hasn't been parked long enough — treat this wheel tick
    // as still part of a page-scroll session and forward it.
    ev.preventDefault();
    window.scrollBy({ top: ev.deltaY, behavior: "auto" });
  }
  let lastLoadedAt = 0;
  let pollCount = 0;
  let inputText = "";
  let sending = false;
  let sendError = "";
  /** Cached summary body for this session, fetched lazily from
   *  `<workspace>/summaries/<key>.md` via /api/sessions/summarize.
   *  Empty string when none exists. Drives both the always-visible
   *  Summarize / Refresh button (in read mode) and the hover-reveal
   *  snippet pill that mirrors the TUI's last-user-message pin. */
  let summarySnippet: string = "";
  let summaryModel: string = "";
  /** AI-generated title from the cached summary. Fed to SessionHeader as
   *  the rename input's placeholder when the user hasn't named the
   *  session. Empty when there's no summary or it predates titles. */
  let summaryTitle: string = "";
  let summarySource: string = "";
  /** Total user+assistant text turns at the moment the cached
   *  summary was generated. The Refresh chip is hidden when the
   *  current count is within 2 of this — a fresh summary stays
   *  useful for a few more turns, so we don't badger the user. */
  let summaryTotalMessages: number = 0;
  /** "Show Refresh" gate: hide the chip when a summary exists and
   *  fewer than 2 messages have been added since. Counts only
   *  user/assistant turns with non-empty text (same shape the
   *  sampler stores under `totalMessages`). */
  $: currentSampledCount = ((): number => {
    const msgs = session?.messages;
    if (!msgs) return 0;
    let n = 0;
    for (const m of msgs) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = (m.blocks ?? [])
        .filter((b) => b?.type === "text" || b?.type === "marker")
        .map((b) => b?.text ?? "")
        .join("")
        .trim();
      if (text) n++;
    }
    return n;
  })();
  $: messagesSinceSummary = summarySnippet
    ? Math.max(0, currentSampledCount - summaryTotalMessages)
    : 0;
  $: shouldShowRefresh = !!summarySnippet && messagesSinceSummary >= 2;
  /** True while a Refresh summary stream is running in-place
   *  (chip-driven, no dialog). Drives the chip label/disabled
   *  state and the snippet's live-update mode. */
  let summaryRefreshing = false;
  async function refreshSummary(): Promise<void> {
    if (!sessionFileSource) {
      summarySnippet = "";
      summaryModel = "";
      summaryTitle = "";
      summaryTotalMessages = 0;
      summarySource = "";
      return;
    }
    const targetSource = sessionFileSource;
    try {
      const qs = new URLSearchParams({ source: targetSource });
      const res = await fetch(
        apiUrl(`/api/sessions/summarize?${qs.toString()}`),
      );
      if (!res.ok) {
        // Race: `source` could have changed while in flight.
        if (targetSource === sessionFileSource) {
          summarySnippet = "";
          summaryModel = "";
          summaryTitle = "";
          summaryTotalMessages = 0;
        }
        return;
      }
      const body = (await res.json()) as {
        summary?: {
          body?: string;
          frontmatter?: {
            model?: string;
            totalMessages?: number;
            title?: string;
          };
        } | null;
      };
      if (targetSource !== sessionFileSource) return;
      summarySnippet = body.summary?.body?.trim() ?? "";
      summaryModel = body.summary?.frontmatter?.model ?? "";
      summaryTitle = body.summary?.frontmatter?.title ?? "";
      summaryTotalMessages = body.summary?.frontmatter?.totalMessages ?? 0;
      summarySource = targetSource;
    } catch {
      if (targetSource === sessionFileSource) {
        summarySnippet = "";
        summaryModel = "";
        summaryTitle = "";
        summaryTotalMessages = 0;
      }
    }
  }
  /** Tiny ephemeral notice that floats next to the Summarize chip.
   *  Used to tell the user "install a model first" without popping
   *  the full dialog — the chip is supposed to stay one-click. */
  let summarizeNotice: string = "";
  let noticeAction: "install" | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function showSummarizeNotice(
    msg: string,
    action: "install" | null = null,
  ): void {
    summarizeNotice = msg;
    noticeAction = action;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      summarizeNotice = "";
      noticeAction = null;
      noticeTimer = null;
    }, 6000);
  }
  function dismissSummarizeNotice(): void {
    summarizeNotice = "";
    noticeAction = null;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
  }

  /** Chip-triggered entry point. Picks the best model on the user's
   *  behalf (last-used → llama3.2:3b → smallest non-embed) and
   *  kicks off an in-place summary stream. The dialog never opens
   *  from here — when no model is installed, we surface a small
   *  notice with a click path into the dialog's install flow. */
  async function summarizeFromChip(): Promise<void> {
    if (summaryRefreshing) return;
    if (!sessionFileSource) {
      showSummarizeNotice("No session source available.");
      return;
    }
    dismissSummarizeNotice();
    // Refresh path: reuse the cached summary's model unless it's a
    // cloud model (older summaries may have been generated before the
    // local-only filter existed). Fall through to the first-run picker
    // so a local model gets chosen instead.
    const isCloud = (n: string) =>
      /(^|[-:/])[a-z0-9.]*cloud(\b|$|:)/.test(n.toLowerCase());
    if (summaryModel && !isCloud(summaryModel)) {
      void runSummaryStream(summaryModel);
      return;
    }
    // First-run path: probe installed models.
    let list: { name: string; size?: number }[] = [];
    try {
      const res = await fetch(apiUrl("/api/ollama/models"));
      if (!res.ok) {
        showSummarizeNotice(
          "Couldn't reach Ollama — try the menu's Summarize for details.",
        );
        return;
      }
      const body = (await res.json()) as { models?: typeof list };
      list = body.models ?? [];
    } catch {
      showSummarizeNotice(
        "Couldn't reach Ollama — try the menu's Summarize for details.",
      );
      return;
    }
    if (list.length === 0) {
      showSummarizeNotice(
        "No Ollama model installed — click to install one.",
        "install",
      );
      return;
    }
    const remembered = localStorage.getItem("supergit:summarize:lastModel");
    let pick = "";
    if (
      remembered &&
      !isCloud(remembered) &&
      list.some((m) => m.name === remembered)
    ) {
      pick = remembered;
    } else if (list.some((m) => m.name === "llama3.2:3b")) {
      pick = "llama3.2:3b";
    } else {
      const usable = list.filter((m) => {
        const n = m.name.toLowerCase();
        if (n.endsWith("-embed") || n.endsWith(":embed")) return false;
        if (isCloud(m.name)) return false;
        return true;
      });
      usable.sort(
        (a, b) =>
          (a.size ?? Number.MAX_SAFE_INTEGER) -
          (b.size ?? Number.MAX_SAFE_INTEGER),
      );
      pick = usable[0]?.name ?? list[0].name;
    }
    if (!pick) {
      showSummarizeNotice("No suitable Ollama model found.");
      return;
    }
    localStorage.setItem("supergit:summarize:lastModel", pick);
    void runSummaryStream(pick);
  }

  /** Stream a summary against `targetModel` and persist it. Shared
   *  by the Refresh chip (model = cached frontmatter's model) and
   *  the first-run chip flow (model auto-picked). `summarySnippet`
   *  only updates after the daemon writes the final body to disk —
   *  during the stream the chip spins, the old snippet stays. */
  async function runSummaryStream(targetModel: string): Promise<void> {
    if (summaryRefreshing) return;
    if (!sessionFileSource || !targetModel) {
      showSummarizeNotice("No session source to summarise.");
      return;
    }
    summaryRefreshing = true;
    const targetSource = sessionFileSource;
    let collected = "";
    try {
      const res = await fetch(apiUrl("/api/sessions/summarize"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: targetSource, model: targetModel }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        showSummarizeNotice(
          errBody?.error ?? `Summarise failed (HTTP ${res.status})`,
        );
        return;
      }
      if (!res.body) {
        showSummarizeNotice("No response from summarise endpoint.");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const payload = JSON.parse(data) as {
              delta?: string;
              message?: string;
              kind?: string;
            };
            if (event === "chunk") {
              collected += payload.delta ?? "";
            } else if (event === "error") {
              const label =
                payload.kind === "ollama_unreachable"
                  ? "Ollama unreachable"
                  : payload.kind === "ollama_model_missing"
                    ? "Model not installed"
                    : payload.kind === "empty"
                      ? "Nothing to summarise"
                      : "Summarise failed";
              showSummarizeNotice(
                `${label}: ${payload.message ?? "unknown error"}`,
              );
              await refreshSummary();
              return;
            }
          } catch {
            // ignore malformed SSE frame
          }
        }
      }
      await refreshSummary();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showSummarizeNotice(`Summarise failed: ${msg}`);
      await refreshSummary();
    } finally {
      summaryRefreshing = false;
    }
  }
  // Re-fetch on mount + whenever the transcript source changes.
  $: {
    void sessionFileSource;
    void refreshSummary();
  }
  // Re-fetch whenever the global summarize dialog *closes* against
  // this source — picks up newly-generated or just-deleted summaries
  // without polling.
  let prevDialogSource: string | null = null;
  $: {
    const cur = $activeSummarize;
    if (!cur && prevDialogSource === sessionFileSource) {
      void refreshSummary();
    }
    prevDialogSource = cur?.source ?? null;
  }
  /** Render mode for this column. "read" is the markdown-rendered chat
   *  view (default). "terminal" flips the panel to an xterm.js TUI
   *  running `claude --resume <sid>` against the same session id. The
   *  Resume button toggles this; closing the terminal flips back.
   *  Initial value comes from `initialMode` so the parent can hydrate
   *  it from persisted state on remount. */
  let mode: "read" | "terminal" = initialMode;
  let transcriptSurface: "read" | "terminal" = initialTranscriptSurface;
  // Notify the parent on every user-initiated mode flip so it can
  // persist the preference. We compare against `prevMode` so the initial
  // assignment doesn't fire a callback before any interaction (the
  // parent already knows the initial value — it set it).
  let prevMode: "read" | "terminal" = initialMode;
  $: if (mode !== prevMode) {
    prevMode = mode;
    onModeChange(mode);
  }
  let prevTranscriptSurface: "read" | "terminal" = initialTranscriptSurface;
  $: if (transcriptSurface !== prevTranscriptSurface) {
    prevTranscriptSurface = transcriptSurface;
    onTranscriptSurfaceChange(transcriptSurface);
  }

  /** Auto-refresh the session summary every 5 minutes while the TUI
   *  is active. Re-fires `summarizeFromChip()` (which picks the same
   *  model as the last run) so the summary stays roughly in sync with
   *  the live conversation. The interval is cleared when the TUI
   *  exits or the component unmounts. */
  const TUI_SUMMARY_INTERVAL_MS = 5 * 60_000;
  let tuiSummaryTimer: ReturnType<typeof setInterval> | null = null;
  /** `currentSampledCount` at the last auto-summary attempt (-1 = never).
   *  Gates the first-summary seed so a TUI with no installed model (or a
   *  failing generation) doesn't retry every interval on unchanged
   *  content. See tui-auto-summary.ts. */
  let lastAutoSummaryAttemptCount = -1;
  $: {
    if (mode === "terminal") {
      if (!tuiSummaryTimer) {
        tuiSummaryTimer = setInterval(() => {
          // Fire when a never-summarised TUI has enough conversation to
          // seed a first summary, OR when an existing summary has drifted
          // (`shouldShowRefresh`). The seed path is guarded on the turn
          // count growing since the last attempt so idle / model-less TUIs
          // don't pile up Ollama calls.
          if (
            shouldAutoSummarizeTui({
              refreshing: summaryRefreshing,
              hasSummary: !!summarySnippet,
              sampledCount: currentSampledCount,
              lastAttemptCount: lastAutoSummaryAttemptCount,
              summaryDrifted: shouldShowRefresh,
            })
          ) {
            lastAutoSummaryAttemptCount = currentSampledCount;
            void summarizeFromChip();
          }
        }, TUI_SUMMARY_INTERVAL_MS);
      }
    } else {
      if (tuiSummaryTimer) {
        clearInterval(tuiSummaryTimer);
        tuiSummaryTimer = null;
      }
    }
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
   *  request shouldn't strand the user with a "Stopping…" button. */
  const DISPOSE_TIMEOUT_MS = 5_000;
  /** Minimum visible "Stopping…" feedback window. The fetch itself is
   *  typically <10ms (the daemon just sends SIGTERM and returns) so
   *  without this floor the spinner would flicker by too fast to read.
   *  Doubles as a cancel-window: a second click on the button during
   *  this gap aborts the dispose, keeping the TUI alive. */
  const DISPOSE_MIN_FEEDBACK_MS = 1000;
  /** Timer for the cancellable grace window. Non-null ⇒ we're in the
   *  1s "click again to cancel" phase; the SIGTERM hasn't fired yet. */
  let disposeGraceTimer: ReturnType<typeof setTimeout> | null = null;
  function disposeTerminal() {
    if (disposeGraceTimer !== null) {
      // Second click inside the grace window — abort. The PTY is
      // untouched; we just clear the visible "Stopping…" state and
      // stay in TUI mode.
      clearTimeout(disposeGraceTimer);
      disposeGraceTimer = null;
      disposing = false;
      return;
    }
    if (disposing) return; // SIGTERM already in flight, ignore
    disposing = true;
    disposeGraceTimer = setTimeout(() => {
      disposeGraceTimer = null;
      void runActualDispose();
    }, DISPOSE_MIN_FEEDBACK_MS);
  }
  async function runActualDispose() {
    // Session-end sound — mirrors App's disposeNewSessionColumn so
    // "Stop Session" chimes whether the column is a fresh NewSessionCol
    // or a resumed SessionView in terminal mode. Fires here (post grace
    // window) so a cancelled stop stays silent.
    play("session-stop");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPOSE_TIMEOUT_MS);
    let timedOut = false;
    try {
      if (terminalId) {
        await fetch(
          apiUrl(`/api/terminals/${encodeURIComponent(terminalId)}`, daemonId),
          {
            method: "DELETE",
            signal: controller.signal,
          },
        ).catch((e) => {
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

  function handleMarkdownCodeCopy(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>(".md-code-copy");
    if (!button) return;
    const frame = button.closest(".md-code-frame");
    const code = frame?.querySelector("pre code")?.textContent ?? "";
    if (!code) return;
    void copyToClipboard(code);
  }

  function codeCopy(node: HTMLElement): { destroy: () => void } {
    node.addEventListener("click", handleMarkdownCodeCopy);
    return {
      destroy() {
        node.removeEventListener("click", handleMarkdownCodeCopy);
      },
    };
  }

  /** Walk the normalized message tree from the tail and return the
   *  text content of the most recent user-typed message(s) — used by
   *  the header's "last activity" tooltip + the pinned overlay so
   *  the user can glance back at what they just asked without
   *  scrolling the column. Skips user messages whose only blocks are
   *  tool_result payloads (Claude routes those under role: "user"
   *  but they aren't user-typed).
   *
   *  If multiple user messages were sent in a short burst — each
   *  within `BURST_GAP_MS` of the next — they're combined into a
   *  single newline-joined preview in chronological order, so a
   *  rapid-fire "5 quick messages" sequence shows the whole thread
   *  of intent rather than only the last fragment. */
  $: lastUserMessage = lastUserMessageBurst(session?.messages ?? []);
  $: lastUserMessageWithContext = buildLastUserMessageWithContext(
    session?.messages ?? [],
    lastUserMessage,
  );
  let visualTranscriptItems: VisualTranscriptItem<
    NormalizedBlock,
    NormalizedMessage
  >[] = [];
  $: visualTranscriptItems = buildVisualTranscriptItems(session?.messages ?? []);

  /** Build the shell command we'd hand to an external terminal to
   *  resume this session. Mirrors the argv the inline TerminalView
   *  uses (so a "Resume in external terminal" lands the user in the
   *  same place a click on Resume would), but as a single quoted
   *  string that survives an AppleScript `do script` round-trip. */
  function resumeShellCommand(sid: string): string {
    if (agent === "codex") {
      return `codex resume ${sid}`;
    }
    return `claude --resume ${sid} --allow-dangerously-skip-permissions`;
  }

  /** POST /api/open with `command` set so the daemon spawns the user's
   *  OS terminal in `session.cwd` AND runs `<resume cmd>` in the new
   *  window. The /api/open extension is honoured only for app=terminal;
   *  other apps ignore `command`. */
  async function resumeInExternalTerminal(): Promise<void> {
    const sid = effectiveSessionId;
    const cwd = effectiveSessionCwd;
    if (!sid || !cwd) return;
    try {
      const res = await fetch(apiUrl("/api/open"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: cwd,
          app: "terminal",
          command: resumeShellCommand(sid),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function canResumeInTerminalSurface(): boolean {
    return (
      !!onCustomResume ||
      (!!effectiveSessionId && (agent === "claude" || agent === "codex"))
    );
  }

  function canResumeInVisualSurface(): boolean {
    return (
      codexVisualAppSurface ||
      (agent === "codex" && !!effectiveSessionId && !!onVisualResume)
    );
  }

  function canResumeCurrentSurface(): boolean {
    return transcriptSurface === "terminal"
      ? canResumeInTerminalSurface()
      : canResumeInVisualSurface();
  }

  function resumeTitleForAgent(): string {
    if (transcriptSurface !== "terminal") {
      return agent === "codex"
        ? "Resume this Codex session in the visual chat surface"
        : "Resume this session in the visual chat surface";
    }
    return agent === "codex"
      ? "Spawn a live `codex resume <id>` PTY in this session's cwd"
      : "Spawn a live `claude --resume <id>` PTY in this session's cwd";
  }

  function showVisualSurface(): void {
    transcriptSurface = "read";
    if (mode === "terminal") {
      terminalId = null;
      hasRenderedOnce = false;
      mode = "read";
      void load();
    }
  }

  function showTerminalTranscriptSurface(): void {
    transcriptSurface = "terminal";
  }

  function resumeInTerminalSurface(): void {
    if (onCustomResume) onCustomResume();
    else {
      transcriptSurface = "terminal";
      mode = "terminal";
    }
  }

  function resumeInVisualSurface(): void {
    transcriptSurface = "read";
    onVisualResume?.();
  }

  function resumeCurrentSurface(): void {
    if (transcriptSurface === "terminal") resumeInTerminalSurface();
    else resumeInVisualSurface();
  }

  /** Open the on-disk directory that holds this session's transcript
   *  (`~/.claude/projects/<encoded>/…` or codex's session store) in the
   *  OS file manager (Explorer / Finder / xdg). `sessionFileSource` is the
   *  absolute path to the session file itself, so open its parent directory.
   *  This is the actual session-log folder — NOT the repo/cwd the TUI runs in. */
  async function openSessionDirectory(): Promise<void> {
    const dir = sessionFileSource ? splitParent(sessionFileSource).dir : "";
    if (!dir) return;
    try {
      const res = await fetch(apiUrl("/api/open"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dir, app: "files" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Burger-menu items for the per-session header. SessionMenu owns the
   *  popover, click-outside handling, and "Copied to clipboard" flash
   *  for `kind: "copy"` items. */
  $: menuItems = ((): SessionMenuItem[] => {
    const sid = effectiveSessionId;
    const claudeItems: SessionMenuItem[] =
      agent === "claude"
        ? claudeSessionMenuItems({
            currentModel: claudeModel,
            detectedModel: model,
            currentEffort: claudeEffort,
            onPickModel: (m) => onSetClaudeModel(m),
            onPickEffort: (e) => onSetClaudeEffort(e),
          })
        : [];
    const base: SessionMenuItem[] = [
      ...claudeItems,
      {
        kind: "action",
        label: "Resume in external terminal",
        iconSvg: [
          // Lucide "external-link": a window with an arrow leaving its
          // top-right corner. Reads as "open elsewhere" universally —
          // matches how the OpenIn chips style their open-in icons.
          "M5 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7",
          "M15 3h6v6",
          "M10 14 21 3",
        ],
        disabled: !sid,
        title: sid
          ? `Open your OS terminal at the session's cwd and run \`${agent === "codex" ? `codex resume ${sid.slice(0, 8)}…` : `claude --resume ${sid.slice(0, 8)}…`}\``
          : "No session id yet",
        onSelect: () => void resumeInExternalTerminal(),
      },
      {
        kind: "copy",
        label: "Copy session ID + path",
        icon: "⧉",
        disabled: !sid,
        title: sid
          ? "Copy session id and transcript path to clipboard"
          : "No session id yet",
        getText: () => `${sid}\n${sessionFileSource}`,
      },
      {
        kind: "action",
        label: "Open session directory",
        iconSvg: [
          // Lucide "folder-open" — an open folder, reads as "reveal in
          // the file manager".
          "M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
        ],
        disabled: !sessionFileSource,
        title: sessionFileSource
          ? "Open the folder containing this session's on-disk log file"
          : "No session file for this session yet",
        onSelect: () => void openSessionDirectory(),
      },
      {
        kind: "action",
        label: "Summarize with Ollama",
        icon: "✦",
        disabled: !(
          session &&
          session.messages.length > 0 &&
          sessionFileSource
        ),
        title:
          session && session.messages.length > 0
            ? "Summarize this session with a local Ollama model"
            : "Session is empty — nothing to summarize",
        onSelect: () => openSummarize(sessionFileSource),
      },
      {
        kind: "action",
        label: "Copy to",
        iconSvg: [
          "M20 16V7a2 2 0 0 0-2-2H6",
          "M14 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z",
        ],
        disabled: !sessionFileSource,
        title: "Copy this session to another workspace for resuming there",
        onSelect: () => openCopy(sessionFileSource),
      },
      {
        kind: "action",
        label: "Share session in local network",
        // Lucide "send"-ish: paper-plane silhouette. Reads as "ship
        // this somewhere" without confusing with "open in external".
        iconSvg: ["M22 2 11 13", "m22 2-7 20-4-9-9-4 20-7z"],
        disabled: !sessionFileSource,
        title: "Send this session to another supergit on the LAN",
        onSelect: () => openShare(sessionFileSource),
      },
      {
        kind: "action",
        label: "Create a link note",
        icon: "⤴",
        // Anchor is the current worktree — same data the saved-link
        // chip uses for its commit-provider / move-to picker. No
        // worktree → no anchor → disable.
        disabled: !wtPath,
        title: wtPath
          ? "Pin this session as a sticky-link on the row"
          : "No worktree to pin to",
        // SessionMenu passes the burger-button's bounding rect so
        // the fly animation launches from where the user actually
        // clicked, not from the whole session column.
        onSelect: (triggerRect: DOMRect) => void saveAsLink(triggerRect),
      },
      {
        kind: "action",
        label: "Repair session",
        iconSvg: [
          "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        ],
        disabled: agent !== "claude" || !sessionFileSource,
        title:
          agent === "claude"
            ? "Diagnose and repair broken parent chains in the JSONL file"
            : "Repair is only supported for Claude sessions",
        onSelect: () => void openRepair(sessionFileSource),
      },
    ];
    if (onContinueWith && session && session.messages.length > 0) {
      const others: Array<{
        agent: "claude" | "codex" | "ollama";
        label: string;
      }> = [
        { agent: "claude", label: "Claude" },
        { agent: "codex", label: "Codex" },
        { agent: "ollama", label: "Ollama" },
      ].filter((o) => o.agent !== agent) as Array<{
        agent: "claude" | "codex" | "ollama";
        label: string;
      }>;
      base.push({
        kind: "submenu",
        label: "Continue with…",
        iconSvg: ["m16 3 4 4-4 4", "M20 7H4", "m8 21-4-4 4-4", "M4 17h16"],
        title:
          "Start a new session with another agent, seeded with this conversation's context",
        children: others.map((o) => ({
          kind: "action" as const,
          label: o.label,
          title: `Continue with ${o.label}`,
          onSelect: () => onContinueWith!(o.agent),
        })),
      });
    }
    const effectiveSurface = mode === "terminal" ? "terminal" : transcriptSurface;
    const surfaceItems: SessionMenuItem[] = [
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
            iconSvg: [
              "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z",
              "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
            ],
            selected: effectiveSurface === "read",
            title: liveCodexApp
              ? "Use the app-server visual chat surface for this Codex App session"
              : mode === "terminal"
                ? "Detach the live terminal view and show this session in visual chat style"
                : "Show the transcript in visual chat style",
            onSelect: showVisualSurface,
          },
          {
            kind: "action",
            label: "Terminal",
            iconSvg: ["m4 17 6-6-6-6", "M12 19h8"],
            selected: effectiveSurface === "terminal",
            title: "Show the transcript in terminal style",
            onSelect: showTerminalTranscriptSurface,
          },
        ],
      },
    ];
    return [...base, ...extraMenuItems, ...surfaceItems];
  })();

  /** Colour-coded effort glyph shown in the agent pill after the model
   *  name. Only when an effort override is set (default is unknown). */
  $: agentEffortIcon = (() => {
    if (agent !== "claude") return undefined;
    const ic = effortIcon(claudeEffort);
    return ic ? { ...ic, title: `effort: ${claudeEffort}` } : undefined;
  })();

  /** Pill settings popover — mirrors the menu's model/effort selection. */
  $: agentSettings =
    agent === "claude"
      ? claudeAgentSettings({
          currentModel: claudeModel,
          detectedModel: model,
          currentEffort: claudeEffort,
          onPickModel: (m) => onSetClaudeModel(m),
          onPickEffort: (e) => onSetClaudeEffort(e),
        })
      : agent === "codex"
        ? codexSettings
        : [];

  $: codexAgentLabel =
    agent === "codex" ? codexModel || model || "Codex App" : undefined;

  /** Pin this session as a sticky-link chip on the current
   *  worktree's row. Thin wrapper over the shared
   *  `saveSessionAsLink` util so chat-session and active-TUI
   *  surfaces stay in sync — bug fixes / display-shape changes
   *  land in one place. */
  async function saveAsLink(triggerRect?: DOMRect): Promise<void> {
    if (!wtPath) return;
    const origin =
      triggerRect ??
      sessionEl?.getBoundingClientRect() ??
      new DOMRect(
        window.innerWidth / 2 - 100,
        window.innerHeight / 2 - 50,
        200,
        100,
      );
    try {
      await saveSessionAsLink({
        wtPath,
        source,
        fallbackAgent: agent,
        triggerRect: origin,
      });
    } catch (e) {
      error = `save-as-link failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  function formatWorkedDuration(startedAt?: string, endedAt?: string): string {
    if (!startedAt || !endedAt) return "Worked";
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      return "Worked";
    }
    const totalSeconds = Math.max(1, Math.round((end - start) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `Worked for ${seconds}s`;
    if (seconds === 0) return `Worked for ${minutes}m`;
    return `Worked for ${minutes}m ${seconds}s`;
  }

  function formatToolWallTime(seconds: number | undefined): string | undefined {
    if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
    if (seconds <= 0) return undefined;
    if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
  }

  function visualTextForBlock(
    text: string | undefined,
    role: string,
  ): string {
    return role === "user" ? cleanVisualUserText(text) : (text ?? "");
  }

  function displayBlocksForMessage(
    blocks: NormalizedBlock[],
    role: string,
  ): NormalizedBlock[] {
    if (role !== "user") return blocks;
    return [
      ...blocks.filter((block) => block.type === "media"),
      ...blocks.filter((block) => block.type !== "media"),
    ];
  }

  function workEntryBlocksText(blocks: NormalizedBlock[]): string {
    return blocks
      .map((block) =>
        block.type === "tool_use"
          ? `${block.toolName ?? "tool"} ${inputPreview(block.toolInput)}`
          : block.type === "tool_result"
            ? cleanVisualToolResultText(block.text).body
          : (block.text ?? ""),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPlainAssistantWorkText(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): boolean {
    return (
      entry.message.role === "assistant" &&
      entry.blocks.length > 0 &&
      entry.blocks.every((block) => block.type === "text")
    );
  }

  function workEntryTitle(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): string {
    const first = entry.blocks[0];
    if (!first) return roleLabel(entry.message.role, entry.message.author);
    if (first.type === "thinking") return "Thinking";
    if (first.type === "tool_use") {
      return first.toolName ?? "Used a tool";
    }
    if (first.type === "tool_result") {
      const cleaned = cleanVisualToolResultText(first.text);
      return cleaned.wrappedCodexChunk
        ? cleaned.title
        : workEntryBlocksText(entry.blocks) || cleaned.title;
    }
    if (first.type === "media") return mediaLabel(first);
    if (first.type === "ide_context") return first.tagName ?? "IDE context";
    if (first.type === "system_reminder") return "System reminder";
    if (first.type === "command") return first.tagName ?? "Command";
    const preview = workEntryBlocksText(entry.blocks);
    return preview || roleLabel(entry.message.role, entry.message.author);
  }

  function thinkingDisplay(text: string | undefined): {
    title: string;
    body: string;
  } {
    const raw = (text ?? "").replace(/\r\n/g, "\n").trim();
    const cleaned = raw
      .replace(/^thinking(?:\s*[:—–-]\s*|\s+)/i, "")
      .trim();
    if (!cleaned) return { title: "", body: "" };
    const [firstLine = "", ...rest] = cleaned.split("\n");
    const title = firstLine.trim();
    const body = rest.join("\n").trim();
    if (title && body && title.length <= 96) {
      return { title, body };
    }
    return { title: "", body: cleaned };
  }

  function workEntryToolUseBlock(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): NormalizedBlock | undefined {
    return entry.blocks.find((block) => block.type === "tool_use");
  }

  function workEntryFileEditSummary(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage>,
  ): VisualFileEditSummary | undefined {
    return visualFileEditSummaryForBlock(workEntryToolUseBlock(entry));
  }

  function fileEditBasename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  }

  function fileEditActionLabel(action: string): string {
    if (action === "added") return "Added";
    if (action === "deleted") return "Deleted";
    return "Edited";
  }

  function workEntryToolPreview(block: NormalizedBlock): string {
    const text =
      block.toolName === "exec_command"
        ? toolInputCode(block)
        : inputPreview(block.toolInput);
    return text.replace(/\s+/g, " ").trim();
  }

  function toolUsesInlineCommandLabel(block: NormalizedBlock): boolean {
    if (!workEntryToolPreview(block)) return false;
    const name = (block.toolName ?? "").toLowerCase();
    return name.includes("bash") || name.includes("shell") || name.includes("exec");
  }

  function workEntryToolResult(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage> | undefined,
  ): ReturnType<typeof cleanVisualToolResultText> | undefined {
    const block = entry?.blocks.find((b) => b.type === "tool_result");
    if (!block) return undefined;
    return cleanVisualToolResultText(block.text);
  }

  function toolResultLabel(
    result: ReturnType<typeof cleanVisualToolResultText>,
  ): string {
    const parts = [result.title];
    const duration = formatToolWallTime(result.wallTimeSeconds);
    if (duration) parts.push(duration);
    return parts.join(" · ");
  }

  function toolResultMeta(
    entry: VisualWorkEntry<NormalizedBlock, NormalizedMessage> | undefined,
  ): string {
    const result = workEntryToolResult(entry);
    if (!result?.wrappedCodexChunk) return "";
    const parts: string[] = [];
    const duration = formatToolWallTime(result.wallTimeSeconds);
    if (duration) parts.push(duration);
    if (!result.body) parts.push("no output");
    return parts.join(" · ");
  }

  function workMarkerIcon(kind: VisualMarkerKind | undefined): string {
    if (kind === "complete") return "✓";
    if (kind === "compacted") return "⇥";
    if (kind === "aborted") return "!";
    return "•";
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
  let composerAttachments: ImageInlineAttachment[] = [];
  let composerUploadingImages = 0;
  let composerAttachmentError = "";
  let openComposerAttachmentIndex: number | null = null;
  $: openComposerAttachment =
    openComposerAttachmentIndex === null
      ? null
      : (composerAttachments[openComposerAttachmentIndex] ?? null);
  $: composerCanSend =
    !!inputText.trim() || (agent === "codex" && composerAttachments.length > 0);
  // Track whether we've already shown a session at least once. First render
  // = scroll to bottom. Subsequent renders = only auto-scroll if the user
  // was already near the bottom (so polling can't snatch them away when
  // they've scrolled up to read history).
  let hasRenderedOnce = false;
  /** ETag from the last /api/session response. Sent as If-None-Match on
   *  subsequent polls so the daemon can return 304 when the session file
   *  hasn't changed — skips body transfer, JSON.parse, and all downstream
   *  markdown/reactivity churn. */
  let lastEtag: string | null = null;
  let lastResponseBody: string | null = null;

  /** Apply a freshly-parsed session payload. Forces a new identity for the
   *  messages array so Svelte's reactivity always re-renders, and clears the
   *  composer once a pending send has landed in the JSONL. Shared by load()
   *  (event-driven immediate refresh) and the shared poller (periodic). */
  function applyParsedSession(next: NormalizedSession) {
    session = { ...next, messages: [...next.messages] };
    lastLoadedAt = Date.now();
    pollCount += 1;
    // If a send is in flight, watch for the message count to grow — that
    // means the agent has written at least the user-turn into the JSONL.
    if (pendingSinceLen !== null && session.messages.length > pendingSinceLen) {
      inputText = "";
      sending = false;
      pendingSinceLen = null;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }
  }

  async function load() {
    if (!shouldPollTranscript || !sessionPollSource) return;
    if (loading) return;
    if (ollamaStreamingIdx !== null) return;
    loading = true;
    error = "";
    try {
      const qs = new URLSearchParams({ source: sessionPollSource });
      const headers: Record<string, string> = {};
      if (lastEtag) headers["If-None-Match"] = lastEtag;
      const res = await fetch(
        apiUrl(`/api/session?${qs.toString()}`, daemonId),
        { headers },
      );
      if (res.status === 304) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const etag = res.headers.get("ETag");
      if (etag) lastEtag = etag;
      const bodyText = await res.text();
      if (bodyText === lastResponseBody) return;
      lastResponseBody = bodyText;
      const next = JSON.parse(bodyText) as NormalizedSession;
      applyParsedSession(next);
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
      await fetch(
        apiUrl(`/api/active-sends/${encodeURIComponent(id)}`, daemonId),
        {
          method: "DELETE",
        },
      );
    } finally {
      void refreshInflight();
    }
  }

  async function cancelAllInflight() {
    const ids = inflight.map((r) => r.id);
    await Promise.allSettled(
      ids.map((id) =>
        fetch(apiUrl(`/api/active-sends/${encodeURIComponent(id)}`, daemonId), {
          method: "DELETE",
        }),
      ),
    );
    void refreshInflight();
  }

  /** Active AbortController for an in-flight /api/ollama/chat stream.
   *  Set in sendOllamaMessage on POST start, cleared on completion or
   *  abort. The Stop button calls `.abort()`. */
  let ollamaAbort: AbortController | null = null;
  /** Streaming assistant bubble's index in session.messages while a
   *  response is arriving. Lets each SSE chunk append to the right
   *  bubble. Cleared on `done` or abort. */
  let ollamaStreamingIdx: number | null = null;
  let unsubscribeCodexEvents: (() => void) | null = null;
  let codexEventsThreadId: string | null = null;
  let codexEventStreamState: CodexEventStreamState | "closed" = "closed";
  let codexActiveTurnId: string | null = null;
  let codexRequests: CodexAppEvent[] = [];
  let codexRequestDrafts: Record<string, Record<string, string>> = {};
  let codexQueuedMessages: CodexQueuedMessage<ImageInlineAttachment>[] = [];
  let codexQueueDraining = false;
  let codexQueueBlocked = false;
  let editingCodexQueueId: string | null = null;
  let editingCodexQueueText = "";
  let editingCodexQueueAttachments: ImageInlineAttachment[] = [];
  let codexLiveLastActivityIso: string | undefined = undefined;
  let codexQueueHydratedKey = "";
  let codexModels: CodexModelInfo[] = [];
  let codexModelsKey = "";
  let codexModelsLoading = false;
  let codexModelsError = "";
  const CODEX_SETTINGS_KEY = "supergit:codexApp:turnSettings";
  const CODEX_QUEUE_KEY_PREFIX = "supergit:codexApp:queue:";
  const codexSavedSettings = readCodexSettings();
  let codexModel = codexSavedSettings.model ?? "";
  let codexSandbox = codexSavedSettings.sandbox ?? "workspaceWrite";
  let codexApproval = codexSavedSettings.approval ?? "on-request";
  let codexEffort = codexSavedSettings.effort ?? "";
  let codexSummary = codexSavedSettings.summary ?? "auto";
  const codexSeenEvents = new Set<string>();
  const codexUnhandledEventMethods = new Set<string>();

  $: liveCodexApp = agent === "codex" && isLiveCodexAppSource(source);
  $: codexVisualAppSurface =
    liveCodexApp && visualAppEnabled && transcriptSurface === "read";
  $: sessionFileSource = liveCodexApp ? (transcriptSource ?? "") : source;
  $: sessionPollSource = sessionFileSource || source;
  $: shouldPollTranscript = shouldPollSessionSource({
    agent,
    source: sessionPollSource,
  });
  $: effectiveSessionId = resumeSessionId ?? session?.sessionId;
  $: effectiveSessionCwd = session?.cwd || wtPath;
  $: codexRunning = liveCodexApp && (sending || !!codexActiveTurnId);
  $: codexLastMessageActivityIso = session?.messages
    .map((m) => m.timestamp)
    .filter((ts): ts is string => !!ts)
    .at(-1);
  $: effectiveLastActivityIso = liveCodexApp
    ? (codexLiveLastActivityIso ??
      codexLastMessageActivityIso ??
      session?.endedAt)
    : session?.endedAt;

  let reportedWorking: boolean | undefined;
  let reportedAwaiting: boolean | undefined;
  $: {
    const nextWorking =
      mode === "terminal"
        ? working
        : liveCodexApp
          ? codexRunning
          : inflight.length > 0;
    const nextAwaiting = awaitingInput;
    if (reportedWorking !== nextWorking) {
      reportedWorking = nextWorking;
      onWorkingChange(nextWorking);
    }
    if (reportedAwaiting !== nextAwaiting) {
      reportedAwaiting = nextAwaiting;
      onAwaitingChange(nextAwaiting);
    }
  }

  $: if (
    liveCodexApp &&
    resumeSessionId &&
    (!session || session.sessionId !== resumeSessionId)
  ) {
    session = {
      agent,
      cwd: wtPath,
      sessionId: resumeSessionId,
      startedAt: new Date().toISOString(),
      messages: [],
    };
  }

  $: if (liveCodexApp) {
    const key = codexQueueStorageKey();
    if (key) restoreCodexQueue(key);
  }

  $: if (liveCodexApp && codexQueueHydratedKey) {
    codexQueuedMessages;
    persistCodexQueue();
  }

  function readCodexSettings(): {
    model?: string;
    sandbox?: string;
    approval?: string;
    effort?: string;
    summary?: string;
  } {
    try {
      const raw = getDaemonKV().getItem(CODEX_SETTINGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        sandbox:
          typeof parsed.sandbox === "string" ? parsed.sandbox : undefined,
        approval:
          typeof parsed.approval === "string" ? parsed.approval : undefined,
        effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
        summary:
          typeof parsed.summary === "string" ? parsed.summary : undefined,
      };
    } catch {
      return {};
    }
  }

  function persistCodexSettings(): void {
    getDaemonKV().setItem(
      CODEX_SETTINGS_KEY,
      JSON.stringify({
        model: codexModel,
        sandbox: codexSandbox,
        approval: codexApproval,
        effort: codexEffort,
        summary: codexSummary,
      }),
    );
  }

  function codexQueueStorageKey(): string | undefined {
    const id = effectiveSessionId;
    return id ? `${CODEX_QUEUE_KEY_PREFIX}${id}` : undefined;
  }

  function readCodexQueue(
    key: string,
  ): CodexQueuedMessage<ImageInlineAttachment>[] {
    try {
      return parseCodexQueue<ImageInlineAttachment>(getDaemonKV().getItem(key));
    } catch {
      return [];
    }
  }

  function restoreCodexQueue(key: string): void {
    if (codexQueueHydratedKey === key) return;
    codexQueueHydratedKey = key;
    codexQueuedMessages = readCodexQueue(key);
    codexQueueBlocked = false;
    cancelEditCodexQueuedMessage();
  }

  function persistCodexQueue(): void {
    const key = codexQueueStorageKey();
    if (!key || codexQueueHydratedKey !== key) return;
    getDaemonKV().setItem(key, JSON.stringify(codexQueuedMessages));
  }

  function pickCodexModel(value: string): void {
    codexModel = value;
    persistCodexSettings();
  }
  function pickCodexSandbox(value: string): void {
    codexSandbox = value;
    persistCodexSettings();
  }
  function pickCodexApproval(value: string): void {
    codexApproval = value;
    persistCodexSettings();
  }
  function pickCodexEffort(value: string): void {
    codexEffort = value;
    persistCodexSettings();
  }
  function pickCodexSummary(value: string): void {
    codexSummary = value;
    persistCodexSettings();
  }

  $: codexSettings = codexAgentSettings({
    models: codexModels,
    detectedModel: model,
    currentModel: codexModel,
    modelsLoading: codexModelsLoading,
    modelsError: codexModelsError,
    currentEffort: codexEffort,
    currentSummary: codexSummary,
    currentSandbox: codexSandbox,
    currentApproval: codexApproval,
    onPickModel: pickCodexModel,
    onPickEffort: pickCodexEffort,
    onPickSummary: pickCodexSummary,
    onPickSandbox: pickCodexSandbox,
    onPickApproval: pickCodexApproval,
  });
  async function loadCodexModels(cwd: string): Promise<void> {
    if (!cwd || codexModelsLoading || codexModelsKey === cwd) return;
    codexModelsLoading = true;
    codexModelsError = "";
    try {
      const qs = new URLSearchParams({ cwd });
      const res = await fetch(
        apiUrl(`/api/codex-app/models?${qs.toString()}`, daemonId),
      );
      const body = (await res.json().catch(() => null)) as {
        models?: CodexModelInfo[];
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      codexModels = Array.isArray(body?.models) ? body.models : [];
      codexModelsKey = cwd;
    } catch (e) {
      codexModelsError = e instanceof Error ? e.message : String(e);
    } finally {
      codexModelsLoading = false;
    }
  }

  async function sendOllamaMessage(): Promise<void> {
    const text = inputText.trim();
    if (!text || sending || !session?.sessionId) return;
    sending = true;
    sendError = "";
    // Optimistic local update: drop the user turn + an empty
    // assistant bubble into the rendered list immediately so the
    // chat feels responsive while the daemon's first byte is still
    // in flight.
    const optimisticUser: NormalizedMessage = {
      role: "user",
      blocks: [{ type: "text", text }],
      timestamp: new Date().toISOString(),
    };
    const optimisticAssistant: NormalizedMessage = {
      role: "assistant",
      blocks: [{ type: "text", text: "" }],
      timestamp: new Date().toISOString(),
      author: model,
    };
    if (session) {
      session.messages = [
        ...session.messages,
        optimisticUser,
        optimisticAssistant,
      ];
      ollamaStreamingIdx = session.messages.length - 1;
    }
    inputText = "";
    const ac = new AbortController();
    ollamaAbort = ac;
    try {
      const res = await fetch(apiUrl("/api/ollama/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termId: session.sessionId, content: text }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // SSE-frame parser: events look like
      //   event: chunk\ndata: {...}\n\n
      // Frames are delimited by a blank line. We buffer until we have
      // a complete frame, parse, then continue.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let frameEnd: number;
        while ((frameEnd = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, frameEnd);
          buf = buf.slice(frameEnd + 2);
          let event = "message";
          let dataLine = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === "chunk" && typeof payload.delta === "string") {
            applyOllamaChunk(payload.delta);
          } else if (event === "error") {
            const msg =
              typeof payload.message === "string"
                ? payload.message
                : "stream error";
            sendError = msg;
          } else if (event === "done") {
            // Stream finished cleanly. Stop here; the outer reader
            // loop sees `done` on the next read.
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        // Stopped by user — leave the partial bubble in place; the
        // daemon will have persisted it with `partial: true`.
      } else {
        sendError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      sending = false;
      ollamaAbort = null;
      ollamaStreamingIdx = null;
      // Re-sync from disk so timestamps and any daemon-side
      // normalization replace the optimistic local entries.
      void load();
    }
  }

  function applyOllamaChunk(delta: string): void {
    if (ollamaStreamingIdx === null || !session) return;
    const idx = ollamaStreamingIdx;
    const msg = session.messages[idx];
    if (!msg) return;
    const block = msg.blocks[0];
    if (!block || block.type !== "text") return;
    block.text = (block.text ?? "") + delta;
    // Force reactivity — Svelte 4 needs a new identity for the
    // messages array to re-render the bubble.
    session = { ...session, messages: [...session.messages] };
  }

  function stopOllamaStream(): void {
    ollamaAbort?.abort();
  }

  function codexEventKey(event: CodexAppEvent): string {
    const id = event.id ?? "";
    const delta =
      typeof event.params?.delta === "string" ? event.params.delta : "";
    return `${event.kind}:${event.method}:${id}:${event.seq ?? event.receivedAt}:${delta}`;
  }

  function codexStringParam(
    obj: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = obj?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  function codexObjectParam(
    obj: Record<string, unknown> | undefined,
    key: string,
  ): Record<string, unknown> | undefined {
    const value = obj?.[key];
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  }

  function mediaKindFromEvidence(
    type: string | undefined,
    mimeType: string | undefined,
    source: string | undefined,
  ): "image" | "file" | "artifact" {
    const t = type?.toLowerCase() ?? "";
    const mime = mimeType?.toLowerCase() ?? "";
    const src = source?.toLowerCase() ?? "";
    if (
      t.includes("image") ||
      mime.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:$|[?#])/i.test(src)
    ) {
      return "image";
    }
    return src || mime ? "file" : "artifact";
  }

  function codexMediaBlockFromParams(
    method: string,
    params: Record<string, unknown>,
  ): NormalizedBlock | null {
    const source =
      codexObjectParam(params, "source") ??
      codexObjectParam(params, "image_url") ??
      codexObjectParam(params, "output_image") ??
      codexObjectParam(params, "file");
    const container = source ?? params;
    const type =
      codexStringParam(params, "type") ??
      codexStringParam(container, "type") ??
      method;
    const path =
      codexStringParam(params, "path") ??
      codexStringParam(params, "file_path") ??
      codexStringParam(params, "filePath") ??
      codexStringParam(container, "path") ??
      codexStringParam(container, "file_path") ??
      codexStringParam(container, "filePath");
    const url =
      codexStringParam(params, "url") ??
      codexStringParam(params, "image_url") ??
      codexStringParam(container, "url") ??
      codexStringParam(container, "image_url");
    const mimeType =
      codexStringParam(params, "mime_type") ??
      codexStringParam(params, "mimeType") ??
      codexStringParam(params, "media_type") ??
      codexStringParam(container, "mime_type") ??
      codexStringParam(container, "mimeType") ??
      codexStringParam(container, "media_type");
    const sourceRef = path ?? url;
    const kind = mediaKindFromEvidence(type, mimeType, sourceRef);
    const methodLooksRelevant = /(?:image|media|artifact|file)$/i.test(
      method,
    );
    const hasImageEvidence =
      kind === "image" ||
      type.toLowerCase().includes("image") ||
      (mimeType?.toLowerCase().startsWith("image/") ?? false);
    if (!hasImageEvidence && !methodLooksRelevant) return null;
    if (!sourceRef && !mimeType) return null;

    const title =
      codexStringParam(params, "title") ??
      codexStringParam(params, "name") ??
      codexStringParam(params, "filename") ??
      codexStringParam(container, "title") ??
      codexStringParam(container, "name") ??
      codexStringParam(container, "filename") ??
      (kind === "image" ? "Image" : "Artifact");
    const alt =
      codexStringParam(params, "alt") ??
      codexStringParam(params, "alt_text") ??
      codexStringParam(container, "alt") ??
      codexStringParam(container, "alt_text") ??
      title;
    return {
      type: "media",
      mediaKind: kind,
      mimeType,
      path,
      url,
      title,
      alt,
    };
  }

  function logUnhandledCodexEvent(event: CodexAppEvent): void {
    if (codexUnhandledEventMethods.has(event.method)) return;
    codexUnhandledEventMethods.add(event.method);
    console.warn("supergit: unhandled Codex app-server event", {
      method: event.method,
      kind: event.kind,
      paramKeys: Object.keys(event.params ?? {}),
    });
  }

  function openCodexEventStream(threadId: string): void {
    if (unsubscribeCodexEvents && codexEventsThreadId === threadId) return;
    closeCodexEventStream();
    codexEventsThreadId = threadId;
    codexEventStreamState = "connecting";
    unsubscribeCodexEvents = subscribeCodexEvents(daemonId, {
      onState: (state) => {
        codexEventStreamState = state;
      },
      onEvent: (event) => {
        if (event.threadId && event.threadId !== threadId) return;
        codexEventStreamState = "live";
        applyCodexEvent(event);
      },
    });
  }

  function closeCodexEventStream(): void {
    unsubscribeCodexEvents?.();
    unsubscribeCodexEvents = null;
    codexEventsThreadId = null;
    codexEventStreamState = "closed";
  }

  function applyCodexEvent(event: CodexAppEvent): void {
    codexLiveLastActivityIso = event.receivedAt || new Date().toISOString();
    const key = codexEventKey(event);
    if (codexSeenEvents.has(key)) return;
    codexSeenEvents.add(key);
    if (codexSeenEvents.size > 1000) {
      const first = codexSeenEvents.values().next().value;
      if (first) codexSeenEvents.delete(first);
    }

    if (event.kind === "request") {
      codexRequests = [
        ...codexRequests.filter((r) => r.id !== event.id),
        event,
      ];
      awaitingInput = true;
      return;
    }

    if (event.method === "turn/started") {
      codexActiveTurnId = event.turnId ?? codexActiveTurnId;
      sending = true;
      sendError = "";
      return;
    }
    if (event.method === "turn/status") {
      const active = event.params?.active === true;
      codexActiveTurnId = active
        ? (event.turnId ??
          (typeof event.params?.turnId === "string"
            ? event.params.turnId
            : codexActiveTurnId))
        : null;
      sending = active;
      return;
    }
    if (event.method === "turn/completed") {
      codexActiveTurnId = null;
      sending = false;
      awaitingInput = codexRequests.length > 0;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      void load();
      void drainCodexQueue();
      return;
    }
    if (event.method === "serverRequest/resolved") {
      const id = (event.params?.requestId ?? event.params?.id) as
        | string
        | number
        | undefined;
      if (id !== undefined) {
        codexRequests = codexRequests.filter((r) => r.id !== id);
      }
      awaitingInput = codexRequests.length > 0;
      return;
    }
    if (event.method === "item/agentMessage/delta") {
      appendCodexBlock(
        `codex-agent-${event.params.itemId ?? event.turnId ?? "message"}`,
        "assistant",
        "text",
        String(event.params.delta ?? ""),
      );
      return;
    }
    if (
      event.method === "item/plan/delta" ||
      event.method === "item/reasoning/summaryTextDelta" ||
      event.method === "item/reasoning/textDelta"
    ) {
      appendCodexBlock(
        `codex-plan-${event.params.itemId ?? event.turnId ?? "plan"}`,
        "assistant",
        "thinking",
        String(event.params.delta ?? ""),
      );
      return;
    }
    if (
      event.method === "command/exec/outputDelta" ||
      event.method === "process/outputDelta" ||
      event.method === "item/commandExecution/outputDelta" ||
      event.method === "item/fileChange/outputDelta"
    ) {
      appendCodexBlock(
        `codex-output-${event.params.itemId ?? event.turnId ?? "output"}`,
        "tool",
        "tool_result",
        String(event.params.delta ?? ""),
      );
      return;
    }
    if (event.method === "item/fileChange/patchUpdated") {
      upsertCodexToolUse(
        `codex-file-${event.params.itemId ?? event.turnId ?? "file"}`,
        "file change",
        event.params.changes ?? event.params,
      );
      return;
    }
    if (event.method === "turn/plan/updated") {
      upsertCodexToolUse(
        `codex-turn-plan-${event.turnId ?? "plan"}`,
        "plan",
        event.params,
      );
      return;
    }
    if (event.method === "error" || event.method === "warning") {
      const message =
        typeof event.params.message === "string"
          ? event.params.message
          : JSON.stringify(event.params);
      sendError = message;
      return;
    }
    const media = codexMediaBlockFromParams(event.method, event.params);
    if (media) {
      upsertCodexMedia(
        `codex-media-${event.params.itemId ?? event.turnId ?? event.seq ?? "media"}`,
        media,
      );
      return;
    }
    logUnhandledCodexEvent(event);
  }

  function appendCodexBlock(
    id: string,
    role: NormalizedMessage["role"],
    type: NormalizedBlock["type"],
    delta: string,
  ): void {
    if (!delta || !session) return;
    const messages = [...session.messages];
    let msg = messages.find((m) => m.id === id);
    if (!msg) {
      msg = {
        id,
        role,
        timestamp: new Date().toISOString(),
        blocks: [{ type, text: "" }],
      };
      messages.push(msg);
    }
    let block = msg.blocks[0];
    if (!block || block.type !== type) {
      block = { type, text: "" };
      msg.blocks = [block];
    }
    block.text = (block.text ?? "") + delta;
    session = { ...session, messages };
  }

  function upsertCodexMedia(id: string, block: NormalizedBlock): void {
    if (!session) return;
    const messages = [...session.messages];
    let msg = messages.find((m) => m.id === id);
    if (!msg) {
      msg = {
        id,
        role: "assistant",
        timestamp: new Date().toISOString(),
        blocks: [block],
      };
      messages.push(msg);
    } else {
      msg.blocks = [block];
    }
    session = { ...session, messages };
  }

  function upsertCodexToolUse(
    id: string,
    toolName: string,
    toolInput: unknown,
  ): void {
    if (!session) return;
    const messages = [...session.messages];
    const existing = messages.find((m) => m.id === id);
    const block: NormalizedBlock = { type: "tool_use", toolName, toolInput };
    if (existing) existing.blocks = [block];
    else {
      messages.push({
        id,
        role: "assistant",
        timestamp: new Date().toISOString(),
        blocks: [block],
      });
    }
    session = { ...session, messages };
  }

  function optimisticCodexUser(text: string): string | null {
    if (!session) return null;
    const id = `codex-optimistic-user-${randomUUID()}`;
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id,
          role: "user",
          timestamp: new Date().toISOString(),
          blocks: [{ type: "text", text }],
        },
      ],
    };
    return id;
  }

  function removeOptimisticCodexUser(id: string | null): void {
    if (!session || !id) return;
    const messages = session.messages.filter((m) => m.id !== id);
    if (messages.length === session.messages.length) return;
    session = { ...session, messages };
  }

  function codexOptimisticText(
    text: string,
    attachments: readonly ImageInlineAttachment[],
  ): string {
    const imageMarkers = attachments.map(
      (attachment) => `[Image: source: ${attachment.path}]`,
    );
    return [text, ...imageMarkers].filter(Boolean).join("\n");
  }

  function composerImageUrl(attachment: ImageInlineAttachment): string {
    return apiUrl(
      `/api/image?path=${encodeURIComponent(attachment.path)}`,
      daemonId,
    );
  }

  function mediaSourceUrl(block: NormalizedBlock): string | undefined {
    if (block.path && block.mediaKind === "image") {
      return apiUrl(
        `/api/image?path=${encodeURIComponent(block.path)}`,
        daemonId,
      );
    }
    return block.url;
  }

  function mediaLabel(block: NormalizedBlock): string {
    return (
      block.title ??
      block.alt ??
      block.path?.split("/").pop() ??
      block.url ??
      block.mimeType ??
      "Artifact"
    );
  }

  function logComposerAttach(
    id: string,
    phase: string,
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): void {
    console.info("supergit: codex visual image attach", {
      id,
      phase,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...extra,
    });
  }

  function composerTransferImages(dt: DataTransfer | null): File[] {
    if (!dt) return [];
    const byFile = Array.from(dt.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (byFile.length) return byFile;
    return Array.from(dt.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
  }

  function composerHasImageTransfer(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return (
      Array.from(dt.files ?? []).some((file) =>
        file.type.startsWith("image/"),
      ) ||
      Array.from(dt.items ?? []).some(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      )
    );
  }

  async function addComposerImageAttachment(
    blob: Blob,
    opts: { filename?: string; source: "clipboard" | "drop"; types: string[] },
  ): Promise<void> {
    const debugId = `cv_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const startedAt = performance.now();
    composerUploadingImages += 1;
    composerAttachmentError = "";
    try {
      logComposerAttach(debugId, "start", startedAt, {
        source: opts.source,
        filename: opts.filename ?? null,
        inputBytes: blob.size,
        inputType: blob.type || null,
        types: opts.types,
      });
      const shrinkStarted = performance.now();
      const shrunk = await shrinkImageBlob(blob);
      const shrinkMs = Math.round(performance.now() - shrinkStarted);
      logComposerAttach(debugId, "shrink-complete", startedAt, {
        outputBytes: shrunk.size,
        outputType: shrunk.type || null,
        changed: shrunk !== blob,
        shrinkMs,
      });
      const alphaStarted = performance.now();
      const hasAlpha = await imageBlobHasAlpha(shrunk);
      const alphaMs = Math.round(performance.now() - alphaStarted);
      logComposerAttach(debugId, "alpha-complete", startedAt, {
        hasAlpha,
        alphaMs,
      });
      const filename =
        opts.filename && opts.filename !== "blob" ? opts.filename : undefined;
      const form = new FormData();
      form.append(
        "file",
        filename ? new File([shrunk], filename, { type: shrunk.type }) : shrunk,
      );
      form.append("source", "codex-visual-image-paste");
      form.append("pasteDebugId", debugId);
      form.append("clientSource", opts.source);
      form.append("clientInputBytes", String(blob.size));
      form.append("clientOutputBytes", String(shrunk.size));
      if (blob.type) form.append("clientInputType", blob.type);
      if (shrunk.type) form.append("clientOutputType", shrunk.type);
      form.append("clientShrinkMs", String(shrinkMs));
      form.append("clientAlphaMs", String(alphaMs));
      form.append(
        "clientBeforeUploadMs",
        String(Math.round(performance.now() - startedAt)),
      );
      logComposerAttach(debugId, "upload-start", startedAt, {
        uploadBytes: shrunk.size,
      });
      const res = await fetch(apiUrl("/api/attach", daemonId), {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`attach failed: ${res.status}`);
      const { path } = (await res.json()) as { path: string };
      logComposerAttach(debugId, "upload-complete", startedAt, {
        path,
        status: res.status,
      });
      composerAttachments = [
        ...composerAttachments,
        {
          kind: "image",
          path,
          ...(filename ? { filename } : {}),
          mimeType: shrunk.type || blob.type || undefined,
          size: shrunk.size,
          ...(hasAlpha ? { hasAlpha } : {}),
          source: {
            kind: opts.source,
            types: opts.types,
            ...(filename ? { filename } : {}),
          },
        },
      ];
      logComposerAttach(debugId, "visible", startedAt, {
        attachmentCount: composerAttachments.length,
      });
    } catch (e) {
      composerAttachmentError =
        e instanceof Error ? e.message : "Could not attach image";
      logComposerAttach(debugId, "failed", startedAt, {
        error: composerAttachmentError,
      });
    } finally {
      composerUploadingImages = Math.max(0, composerUploadingImages - 1);
      logComposerAttach(debugId, "finished", startedAt, {
        remainingUploads: composerUploadingImages,
      });
    }
  }

  function onComposerPaste(e: ClipboardEvent): void {
    if (agent !== "codex") return;
    const cd = e.clipboardData;
    const images = composerTransferImages(cd);
    if (!images.length) return;
    if (!cd?.getData("text/plain")) e.preventDefault();
    const types = Array.from(cd?.types ?? []);
    for (const image of images) {
      void addComposerImageAttachment(image, {
        filename: image.name,
        source: "clipboard",
        types,
      });
    }
  }

  function onComposerDragOver(e: DragEvent): void {
    if (agent !== "codex" || !composerHasImageTransfer(e.dataTransfer)) return;
    e.preventDefault();
  }

  function onComposerDrop(e: DragEvent): void {
    if (agent !== "codex") return;
    const images = composerTransferImages(e.dataTransfer);
    if (!images.length) return;
    e.preventDefault();
    const types = Array.from(e.dataTransfer?.types ?? []);
    for (const image of images) {
      void addComposerImageAttachment(image, {
        filename: image.name,
        source: "drop",
        types,
      });
    }
  }

  function removeComposerAttachment(index: number): void {
    composerAttachments = composerAttachments.filter((_, i) => i !== index);
    if (openComposerAttachmentIndex === null) return;
    if (composerAttachments.length === 0) {
      openComposerAttachmentIndex = null;
    } else if (index < openComposerAttachmentIndex) {
      openComposerAttachmentIndex -= 1;
    } else if (index === openComposerAttachmentIndex) {
      openComposerAttachmentIndex = Math.min(
        openComposerAttachmentIndex,
        composerAttachments.length - 1,
      );
    }
  }

  function removeOpenComposerAttachment(): void {
    if (openComposerAttachmentIndex === null) return;
    removeComposerAttachment(openComposerAttachmentIndex);
  }

  function openComposerAttachmentAt(index: number): void {
    if (!composerAttachments[index]) return;
    openComposerAttachmentIndex = index;
  }

  function closeComposerAttachment(): void {
    openComposerAttachmentIndex = null;
  }

  function stepComposerAttachment(delta: number): void {
    if (openComposerAttachmentIndex === null || composerAttachments.length < 2)
      return;
    openComposerAttachmentIndex =
      (openComposerAttachmentIndex + delta + composerAttachments.length) %
      composerAttachments.length;
  }

  function onComposerAttachmentKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeComposerAttachment();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepComposerAttachment(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepComposerAttachment(1);
    }
  }

  function currentCodexPayload(): {
    text: string;
    attachments: ImageInlineAttachment[];
  } | null {
    const text = inputText.trim();
    const attachments = [...composerAttachments];
    if (
      (!text && attachments.length === 0) ||
      !session?.sessionId ||
      !session.cwd
    )
      return null;
    return { text, attachments };
  }

  function clearCodexComposer(): void {
    inputText = "";
    composerAttachments = [];
    openComposerAttachmentIndex = null;
  }

  function enqueueCodexPayload(payload: {
    text: string;
    attachments: ImageInlineAttachment[];
  }): void {
    codexQueuedMessages = enqueueCodexQueue(
      codexQueuedMessages,
      payload,
      randomUUID(),
      new Date().toISOString(),
    );
    codexLiveLastActivityIso = new Date().toISOString();
    codexQueueBlocked = false;
    sendError = "";
  }

  function queueCodexMessage(): void {
    const payload = currentCodexPayload();
    if (!payload) return;
    enqueueCodexPayload(payload);
    clearCodexComposer();
  }

  async function startCodexTurn(
    payload: { text: string; attachments: ImageInlineAttachment[] },
    opts: {
      steer: boolean;
      fromQueue?: CodexQueuedMessage<ImageInlineAttachment>;
    } = { steer: false },
  ): Promise<boolean> {
    if (!session?.sessionId || !session.cwd) return false;
    if (!opts.steer && sending) return false;
    sending = true;
    sendError = "";
    codexLiveLastActivityIso = new Date().toISOString();
    const optimisticId = optimisticCodexUser(
      codexOptimisticText(payload.text, payload.attachments),
    );
    try {
      const res = await fetch(apiUrl("/api/codex-app/turns", daemonId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: session.sessionId,
          cwd: session.cwd,
          text: payload.text,
          input: codexAppInputFromComposer(payload.text, payload.attachments),
          steer: opts.steer,
          expectedTurnId: opts.steer ? codexActiveTurnId : undefined,
          model: codexModel || undefined,
          effort: codexEffort || undefined,
          summary: codexSummary || undefined,
          sandboxPolicy: codexSandbox,
          approvalPolicy: codexApproval,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (typeof body?.turnId === "string") codexActiveTurnId = body.turnId;
      return true;
    } catch (e) {
      removeOptimisticCodexUser(optimisticId);
      sendError = e instanceof Error ? e.message : String(e);
      sending = opts.steer ? true : false;
      if (opts.fromQueue) {
        codexQueuedMessages = [opts.fromQueue, ...codexQueuedMessages];
      } else if (!inputText.trim() && composerAttachments.length === 0) {
        inputText = payload.text;
        composerAttachments = payload.attachments;
      }
      return false;
    }
  }

  async function sendCodexMessage(): Promise<void> {
    const payload = currentCodexPayload();
    if (!payload) return;
    if (codexRunning) {
      queueCodexMessage();
      return;
    }
    clearCodexComposer();
    await startCodexTurn(payload, { steer: false });
  }

  async function steerCodexMessage(): Promise<void> {
    const payload = currentCodexPayload();
    if (!payload || !codexActiveTurnId) return;
    clearCodexComposer();
    await startCodexTurn(payload, { steer: true });
  }

  async function drainCodexQueue(): Promise<void> {
    if (codexQueueDraining || codexRunning || codexQueuedMessages.length === 0)
      return;
    const [next, ...rest] = codexQueuedMessages;
    if (!next) return;
    codexQueueDraining = true;
    codexQueuedMessages = rest;
    try {
      const ok = await startCodexTurn(next, { steer: false, fromQueue: next });
      if (!ok) codexQueueBlocked = true;
    } finally {
      codexQueueDraining = false;
    }
  }

  function beginEditCodexQueuedMessage(
    item: CodexQueuedMessage<ImageInlineAttachment>,
  ): void {
    editingCodexQueueId = item.id;
    editingCodexQueueText = item.text;
    editingCodexQueueAttachments = [...item.attachments];
  }

  function cancelEditCodexQueuedMessage(): void {
    editingCodexQueueId = null;
    editingCodexQueueText = "";
    editingCodexQueueAttachments = [];
  }

  function saveCodexQueuedMessage(id: string): void {
    if (
      !canSaveCodexQueueEdit(
        editingCodexQueueText,
        editingCodexQueueAttachments,
      )
    )
      return;
    codexQueuedMessages = updateCodexQueuedMessage(
      codexQueuedMessages,
      id,
      {
        text: editingCodexQueueText,
        attachments: editingCodexQueueAttachments,
      },
    );
    codexQueueBlocked = false;
    cancelEditCodexQueuedMessage();
  }

  function removeCodexQueuedMessage(id: string): void {
    codexQueuedMessages = removeCodexQueueItem(codexQueuedMessages, id);
    codexQueueBlocked = false;
    if (editingCodexQueueId === id) cancelEditCodexQueuedMessage();
  }

  function removeEditingCodexQueueAttachment(index: number): void {
    editingCodexQueueAttachments = removeCodexQueuedAttachment(
      editingCodexQueueAttachments,
      index,
    );
  }

  async function runCodexQueuedMessage(
    item: CodexQueuedMessage<ImageInlineAttachment>,
  ): Promise<void> {
    if (codexRunning) return;
    codexQueueBlocked = false;
    codexQueuedMessages = codexQueuedMessages.filter((q) => q.id !== item.id);
    if (editingCodexQueueId === item.id) cancelEditCodexQueuedMessage();
    await startCodexTurn(
      { text: item.text, attachments: item.attachments },
      { steer: false, fromQueue: item },
    );
  }

  async function steerCodexQueuedMessage(
    item: CodexQueuedMessage<ImageInlineAttachment>,
  ): Promise<void> {
    if (!codexActiveTurnId) return;
    codexQueueBlocked = false;
    codexQueuedMessages = codexQueuedMessages.filter((q) => q.id !== item.id);
    if (editingCodexQueueId === item.id) cancelEditCodexQueuedMessage();
    await startCodexTurn(
      { text: item.text, attachments: item.attachments },
      { steer: true },
    );
  }

  async function stopCodexTurn(): Promise<void> {
    if (!session?.sessionId) return;
    try {
      await fetch(apiUrl("/api/codex-app/turns/interrupt", daemonId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: session.sessionId,
          turnId: codexActiveTurnId,
        }),
      });
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    }
  }

  function codexRequestTitle(req: CodexAppEvent): string {
    if (req.method.includes("commandExecution")) return "Command approval";
    if (req.method.includes("fileChange")) return "File-change approval";
    if (req.method.includes("permissions")) return "Permission request";
    if (req.method.includes("requestUserInput")) return "Input requested";
    return "Codex request";
  }

  function codexRequestPreview(req: CodexAppEvent): string {
    const p = req.params ?? {};
    const direct =
      p.command ??
      p.reason ??
      p.cwd ??
      p.grantRoot ??
      p.itemId ??
      p.permission ??
      undefined;
    if (Array.isArray(p.commandActions) && p.commandActions.length) {
      return inputPreview(p.commandActions);
    }
    if (typeof direct === "string") return direct;
    if (Array.isArray(direct)) return direct.join(" ");
    try {
      return JSON.stringify(p);
    } catch {
      return req.method;
    }
  }

  function codexRequestKey(req: CodexAppEvent): string {
    return String(req.id ?? `${req.method}:${req.receivedAt}`);
  }

  function codexRequestQuestions(req: CodexAppEvent): CodexUserInputQuestion[] {
    const questions = req.params.questions;
    if (!Array.isArray(questions)) return [];
    return questions
      .map((q) => (q && typeof q === "object" ? q : null))
      .filter((q): q is Record<string, unknown> => !!q)
      .map((q, idx) => {
        const options: CodexUserInputOption[] | null = Array.isArray(q.options)
          ? q.options.flatMap((opt) => {
              if (!opt || typeof opt !== "object") return [];
              const obj = opt as Record<string, unknown>;
              const label = typeof obj.label === "string" ? obj.label : "";
              if (!label) return [];
              return [
                {
                  label,
                  description:
                    typeof obj.description === "string"
                      ? obj.description
                      : undefined,
                },
              ];
            })
          : null;
        return {
          id: typeof q.id === "string" && q.id ? q.id : `q${idx}`,
          header: typeof q.header === "string" ? q.header : undefined,
          question: typeof q.question === "string" ? q.question : "",
          isOther: q.isOther === true,
          isSecret: q.isSecret === true,
          options,
        };
      });
  }

  function codexQuestionDraft(
    req: CodexAppEvent,
    q: CodexUserInputQuestion,
  ): string {
    return codexRequestDrafts[codexRequestKey(req)]?.[q.id] ?? "";
  }

  function setCodexQuestionDraft(
    req: CodexAppEvent,
    q: CodexUserInputQuestion,
    value: string,
  ): void {
    const key = codexRequestKey(req);
    codexRequestDrafts = {
      ...codexRequestDrafts,
      [key]: { ...(codexRequestDrafts[key] ?? {}), [q.id]: value },
    };
  }

  function codexApprovalDecision(
    req: CodexAppEvent,
    action: "accept" | "acceptForSession" | "decline" | "cancel",
  ): string {
    if (
      req.method === "execCommandApproval" ||
      req.method === "applyPatchApproval"
    ) {
      if (action === "accept") return "approved";
      if (action === "acceptForSession") return "approved_for_session";
      if (action === "decline") return "denied";
      return "abort";
    }
    return action;
  }

  function codexCanAcceptForSession(req: CodexAppEvent): boolean {
    return (
      req.method.includes("commandExecution") ||
      req.method.includes("fileChange") ||
      req.method === "execCommandApproval" ||
      req.method === "applyPatchApproval"
    );
  }

  function codexIsUserInputRequest(req: CodexAppEvent): boolean {
    return req.method.includes("requestUserInput");
  }

  async function answerCodexRequest(
    req: CodexAppEvent,
    action: "accept" | "acceptForSession" | "decline" | "cancel",
  ): Promise<void> {
    if (req.id === undefined) return;
    let result: Record<string, unknown>;
    if (
      req.method === "execCommandApproval" ||
      req.method === "applyPatchApproval"
    ) {
      result = { decision: codexApprovalDecision(req, action) };
    } else if (req.method.includes("permissions")) {
      result =
        action === "accept"
          ? {
              permissions: req.params.permissions ?? {},
              scope: "turn",
            }
          : { permissions: {}, scope: "turn" };
    } else if (codexIsUserInputRequest(req)) {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of codexRequestQuestions(req)) {
        const value = codexQuestionDraft(req, q).trim();
        if (value) answers[q.id] = { answers: [value] };
      }
      result = { answers };
    } else {
      result = { decision: codexApprovalDecision(req, action) };
    }
    try {
      const res = await fetch(
        apiUrl(
          `/api/codex-app/requests/${encodeURIComponent(String(req.id))}/respond`,
          daemonId,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      codexRequests = codexRequests.filter((r) => r.id !== req.id);
      const key = codexRequestKey(req);
      const { [key]: _removed, ...rest } = codexRequestDrafts;
      codexRequestDrafts = rest;
      awaitingInput = codexRequests.length > 0;
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    }
  }

  async function sendMessage() {
    if (agent === "ollama") {
      await sendOllamaMessage();
      return;
    }
    if (agent === "codex") {
      await sendCodexMessage();
      return;
    }
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
        sendError = `${agentDisplayName()} didn't respond in 90s — try again or check agent logs`;
        pendingSinceLen = null;
        sending = false;
      }
    }, 90_000);
    try {
      const res = await fetch(apiUrl("/api/session/send", daemonId), {
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

  $: showChatComposer =
    mode === "read" &&
    (agent === "ollama" || (agent === "codex" && codexVisualAppSurface));
  $: showComposerTray =
    codexVisualAppSurface &&
    (codexRequests.length > 0 ||
      codexQueuedMessages.length > 0 ||
      composerAttachments.length > 0 ||
      composerUploadingImages > 0 ||
      !!composerAttachmentError);

  $: composerPlaceholder =
    agent === "codex" ? "Message Codex…" : `Message ${model || "Ollama"}…`;
  function onComposerKey(e: KeyboardEvent) {
    // Enter sends. Shift+Enter inserts a newline. IME composition keeps
    // its own use of Enter and must not trigger a send.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendMessage();
    }
  }

  function agentDisplayName(): string {
    if (agent === "claude") return "Claude";
    if (agent === "codex") return "Codex";
    if (agent === "copilot") return "Copilot";
    if (agent === "ollama") return model || "Ollama";
    return "Agent";
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

  function roleLabel(role: string, author?: string): string {
    if (role !== "assistant") return role;
    // Per-turn author wins when present — used by Ollama to label
    // each assistant bubble with the model that produced it. Future
    // multi-model sessions will attribute each turn correctly via
    // the same field.
    if (author) return author;
    if (agent === "claude") return "Claude";
    if (agent === "codex") return "Codex";
    if (agent === "copilot") return "Copilot";
    if (agent === "ollama") return "Ollama";
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

  function toolInputCode(block: NormalizedBlock): string {
    const input = block.toolInput;
    if (
      block.toolName === "exec_command" &&
      input &&
      typeof input === "object" &&
      "cmd" in input
    ) {
      const cmd = (input as { cmd?: unknown }).cmd;
      if (typeof cmd === "string") return cmd;
      if (Array.isArray(cmd)) return cmd.map(String).join(" ");
    }
    if (input === undefined) return "";
    if (typeof input === "string") return input;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  function toolInputLanguage(block: NormalizedBlock): string {
    return block.toolName === "exec_command" ? "sh" : "json";
  }

  $: if (sessionPollSource && shouldPollTranscript) {
    void load();
  }

  $: {
    const threadId = codexEventThreadIdForSession({
      agent,
      mode,
      sessionId: session?.sessionId,
      liveCodexApp,
    });
    if (threadId) openCodexEventStream(threadId);
    else closeCodexEventStream();
  }

  $: if (agent === "codex" && session?.cwd) {
    void loadCodexModels(session.cwd);
  }

  $: if (
    liveCodexApp &&
    !codexRunning &&
    codexQueuedMessages.length > 0 &&
    !codexQueueDraining &&
    !codexQueueBlocked
  ) {
    void drainCodexQueue();
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

  // Live sync. Registers with the SHARED session poller instead of running a
  // per-column setInterval: one timer + one batched request per daemon for the
  // whole dashboard, instead of ~50 req/s when 30+ columns are open (see
  // plans/performance.md "per-column session-poll storm"). The poller is
  // idle-gated and resume-aware centrally; it dispatches a changed body via
  // onSession and this column's active-sends slice via onInflight. load() /
  // refreshInflight() remain for event-driven immediate refresh (post-send).
  // `source` is keyed in App.svelte's {#each}, so it's stable for this mount.

  let unregisterPoll: (() => void) | null = null;

  onMount(() => {
    if (shouldPollTranscript) {
      unregisterPoll = registerSessionPoll({
        source: sessionPollSource,
        daemonId,
        getSessionId: () => session?.sessionId,
        onSession: (bodyText, etag) => {
          // Don't clobber a live API stream mid-flight.
          if (ollamaStreamingIdx !== null || codexActiveTurnId !== null) return;
          if (bodyText === lastResponseBody) return;
          lastEtag = etag;
          lastResponseBody = bodyText;
          try {
            applyParsedSession(JSON.parse(bodyText) as NormalizedSession);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        },
        onInflight: (list) => {
          inflight = list as unknown as InflightRec[];
        },
      });
      // Kick off an immediate inflight refresh so the indicator's accurate
      // from the first render, not up to 2s later.
      void refreshInflight();
    }
  });

  onDestroy(() => {
    if (unregisterPoll) unregisterPoll();
    if (pendingTimer) clearTimeout(pendingTimer);
    closeCodexEventStream();
    if (disposeGraceTimer) clearTimeout(disposeGraceTimer);
    if (tuiSummaryTimer) clearInterval(tuiSummaryTimer);
    cancelPinHide();
    if (msgSettleTimer) clearTimeout(msgSettleTimer);
  });
</script>

<div
  class="session"
  class:awaiting-input={(mode === "terminal" || codexVisualAppSurface) &&
    awaitingInput}
  class:read-mode={mode === "read"}
  class:terminal-transcript-surface={mode === "read" &&
    transcriptSurface === "terminal"}
  class:empty-chat-composer={showChatComposer &&
    (session?.messages.length ?? 0) === 0}
  class:has-composer-error={!!sendError}
  bind:this={sessionEl}
  on:mousemove={onSessionMouseMove}
  on:mouseleave={onSessionMouseLeave}
  role="presentation"
>
  <!-- Header + the pinned "last message" reminder live in the same
       relative box so the pin can hang below the header without
       pushing the TUI down. The pin floats over the top of the TUI
       (no layout impact); hover reveals the full text. -->
  <div class="session-head-stack">
    <SessionHeader
      {agent}
      agentLabel={agent === "ollama"
        ? model || undefined
        : agent === "claude"
          ? claudeModelAlias(claudeModel ?? model)
          : codexAgentLabel}
      agentIcon={agentEffortIcon}
      {agentSettings}
      {source}
      {manualTitle}
      aiTitle={summaryTitle}
      {mode}
      canResume={canResumeCurrentSurface()}
      canEnd={!!effectiveSessionId && (agent === "claude" || agent === "codex")}
      {disposing}
      {awaitingInput}
      working={mode === "terminal" ? working : codexVisualAppSurface && codexRunning}
      loadedMessageCount={session?.messages.length}
      {totalMessageCount}
      {contextTokens}
      {contextTokensExact}
      {contextWindow}
      {model}
      lastActivityIso={effectiveLastActivityIso}
      lastUserMessage={lastUserMessageWithContext}
      {pollCount}
      {lastLoadedAt}
      {inflight}
      {menuItems}
      titleTooltipExtra={summarySnippet || undefined}
      {starred}
      {onToggleStar}
      onTitleSaved={(next) => onManualTitleSaved(next)}
      onResume={resumeCurrentSurface}
      onEndSession={disposeTerminal}
      onCancelInflight={cancelAllInflight}
      {onClose}
      {onDragStart}
      resumeTitle={resumeTitleForAgent()}
    />
    {#if mode === "terminal" && ((session && session.messages.length > 0) || (lastUserMessage && lastUserMessage.trim().length > 0))}
      <div
        class="pinned-last-msg-wrap tui-overlay-stack"
        class:revealed={pinnedRevealed}
      >
        {#if summarySnippet || summaryRefreshing || (session && session.messages.length > 0)}
          <div
            class="tui-summary-box"
            on:mouseenter={onOverlayEnter}
            on:mouseleave={onOverlayLeave}
          >
            <svg
              class="tui-overlay-icon"
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              {#each ICONS.ai.paths ?? [] as d}<path {d} />{/each}
            </svg>
            <div class="tui-summary-body">
              {#if summaryRefreshing}
                <span class="tui-summary-refreshing">
                  <LoadingSpinner
                    size="0.65rem"
                    thickness="2px"
                    label="Refreshing summary"
                  />
                  <span class="dim"
                    >refreshing{summaryModel
                      ? ` with ${summaryModel}`
                      : ""}…</span
                  >
                </span>
              {:else if summarySnippet}
                {summarySnippet}
                {#if summaryModel}
                  <span class="tui-summary-model">{summaryModel}</span>
                {/if}
              {:else}
                <button
                  type="button"
                  class="tui-summary-cta"
                  on:click={() => void summarizeFromChip()}
                  title="Summarize this session with a local Ollama model"
                  >Summarize</button
                >
              {/if}
            </div>
            {#if !summaryRefreshing}
              <button
                type="button"
                class="tui-summary-refresh"
                title={summaryModel
                  ? `Refresh summary with ${summaryModel}`
                  : "Refresh summary"}
                on:click={() => void summarizeFromChip()}
                aria-label="Refresh summary"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                  <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
                </svg>
              </button>
            {/if}
          </div>
        {/if}
        {#if lastUserMessage && lastUserMessage.trim().length > 0}
          <div
            class="pinned-last-msg"
            on:mouseenter={onOverlayEnter}
            on:mouseleave={onOverlayLeave}
          >
            <svg
              class="tui-overlay-icon"
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              {#each ICONS.speech.paths ?? [] as d}<path {d} />{/each}
            </svg>
            <span class="pinned-last-msg-text"
              >{lastUserMessageWithContext}</span
            >
          </div>
        {/if}
      </div>
    {/if}
    {#if mode === "read" && session && session.messages.length > 0}
      <!-- Unified overlay: one box that holds the Summarize CTA, the
           snippet, or the refreshing spinner — whichever applies.
           Stacks above the pinned-last-user-message just like TUI
           mode so we don't overlap with it. -->
      <div
        class="pinned-last-msg-wrap tui-overlay-stack"
        class:revealed={pinnedRevealed}
      >
        <div
          class="tui-summary-box"
          on:mouseenter={onOverlayEnter}
          on:mouseleave={onOverlayLeave}
        >
          <svg
            class="tui-overlay-icon"
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="currentColor"
            aria-hidden="true"
          >
            {#each ICONS.ai.paths ?? [] as d}<path {d} />{/each}
          </svg>
          <div class="tui-summary-body">
            {#if summaryRefreshing}
              <span class="tui-summary-refreshing">
                <LoadingSpinner
                  size="0.65rem"
                  thickness="2px"
                  label="Refreshing summary"
                />
                <span class="dim"
                  >refreshing{summaryModel
                    ? ` with ${summaryModel}`
                    : ""}…</span
                >
              </span>
            {:else if summarySnippet}
              {summarySnippet}
              {#if summaryModel}
                <span class="tui-summary-model">{summaryModel}</span>
              {/if}
            {:else}
              <button
                type="button"
                class="tui-summary-cta"
                on:click={() => void summarizeFromChip()}
                title="Summarize this session with a local Ollama model"
                >Summarize</button
              >
              {#if summarizeNotice}
                <button
                  type="button"
                  class="tui-summary-notice"
                  class:clickable={noticeAction === "install"}
                  on:click={() => {
                    if (noticeAction === "install") {
                      dismissSummarizeNotice();
                      openSummarize(sessionFileSource);
                    } else {
                      dismissSummarizeNotice();
                    }
                  }}
                  title={noticeAction === "install"
                    ? "Open the install dialog"
                    : "Dismiss"}>{summarizeNotice}</button
                >
              {/if}
            {/if}
          </div>
          {#if summarySnippet && !summaryRefreshing}
            <button
              type="button"
              class="tui-summary-refresh"
              title={summaryModel
                ? `Refresh summary (${messagesSinceSummary} new messages since last) with ${summaryModel}`
                : "Refresh summary"}
              on:click={() => void summarizeFromChip()}
              aria-label="Refresh summary"
            >
              <svg
                viewBox="0 0 24 24"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
              </svg>
            </button>
          {/if}
        </div>
        {#if lastUserMessage && lastUserMessage.trim().length > 0}
          <div
            class="pinned-last-msg"
            on:mouseenter={onOverlayEnter}
            on:mouseleave={onOverlayLeave}
          >
            <svg
              class="tui-overlay-icon"
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              {#each ICONS.speech.paths ?? [] as d}<path {d} />{/each}
            </svg>
            <span class="pinned-last-msg-text"
              >{lastUserMessageWithContext}</span
            >
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if mode === "terminal" && effectiveSessionId && effectiveSessionCwd}
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
            effectiveSessionId,
          ]
        : [
            "claude",
            "--resume",
            effectiveSessionId,
            // Unlocks the in-TUI option to switch to dangerously-skip-permissions
            // (without enabling it by default). This is the flag from
            // `claude --help` whose description is exactly "Enable bypassing all
            // permission checks as an option, without it being enabled by default".
            // Without it, the slash-command toggle inside the TUI is unavailable.
            "--allow-dangerously-skip-permissions",
            // Model/effort overrides picked from the header menu. Switching
            // mid-thread is the "restart via resume" UX: the column remounts
            // (see App's {#key}) so this PTY respawns with the new flag.
            ...(claudeModel ? ["--model", claudeModel] : []),
            ...(claudeEffort ? ["--effort", claudeEffort] : []),
          ]}
      cwd={effectiveSessionCwd}
      ownerId={effectiveSessionId}
      {agent}
      sessionSource={source}
      {attachTermId}
      procName={`supergit-tui-${effectiveSessionId.slice(0, 8)}-${agent}`}
      {daemonId}
      onSpawn={(id) => {
        terminalId = id;
        onSpawn(id);
      }}
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
        onModeChange(mode);
        void load();
      }}
    />
  {:else if error}
    <p class="error">{error}</p>
  {:else if loading && !session}
    <LoadingOverlay text="loading session…" />
  {:else if session && session.messages.length === 0 && !showChatComposer}
    <p class="muted small">
      {liveCodexApp
        ? "No messages yet."
        : "No messages parsed from this session."}
    </p>
  {:else if session}
    {#snippet renderMessageBlocks(
      blocks: NormalizedBlock[],
      m: NormalizedMessage,
      messageIndex: number,
    )}
      {#each blocks as b}
        {#if b.type === "text"}
          {@const displayText = visualTextForBlock(b.text, m.role)}
          {#if messageIndex === ollamaStreamingIdx && !(b.text ?? "").length}
            <!-- Streaming bubble with no chunks yet — Ollama is
                 still loading the model / generating its first
                 token. Show a spinner inside the bubble so the
                 user knows the request is alive, not stuck. -->
            <div class="block text md ollama-waiting">
              <LoadingSpinner size="0.9rem" label="Waiting for response" />
            </div>
          {:else if displayText}
            <div class="block text md">{@html md(displayText)}</div>
          {/if}
        {:else if b.type === "thinking"}
          {@const thought = thinkingDisplay(b.text)}
          <div class="block thinking">
            <span class="thinking-icon" aria-hidden="true">🧠</span>
            <div class="thinking-copy">
              {#if thought.title}
                <div class="thinking-title">{thought.title}</div>
              {/if}
              {#if thought.body}
                <div class="tag-body md">{@html md(thought.body)}</div>
              {/if}
            </div>
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
          {@const cleaned = cleanVisualToolResultText(b.text)}
          {#if cleaned.body || cleaned.wrappedCodexChunk}
            <div class="block tool-result md" class:tool-result-empty={!cleaned.body}>
              <span class="muted small">{toolResultLabel(cleaned)}</span>
              {#if cleaned.body}
              {@html markdownCodeBlockHtml(cleaned.body, "text")}
              {:else}
                <span class="tool-result-empty-text">no output</span>
              {/if}
            </div>
          {/if}
        {:else if b.type === "media"}
          {@const src = mediaSourceUrl(b)}
          <figure
            class="block media-block"
            class:media-image={b.mediaKind === "image"}
          >
            {#if b.mediaKind === "image" && src}
              <a href={src} target="_blank" rel="noopener noreferrer">
                <span class="sticky-photo-frame media-photo-frame">
                  <img src={src} alt={b.alt ?? mediaLabel(b)} />
                </span>
              </a>
              <figcaption>{mediaLabel(b)}</figcaption>
            {:else}
              <div class="media-artifact">
                <span class="tag-label">{b.mediaKind ?? "artifact"}</span>
                {#if src}
                  <a href={src} target="_blank" rel="noopener noreferrer">
                    {mediaLabel(b)}
                  </a>
                {:else}
                  <span>{mediaLabel(b)}</span>
                {/if}
                {#if b.mimeType}
                  <span class="muted small">{b.mimeType}</span>
                {/if}
              </div>
              {#if b.text}
                <div class="media-note">{b.text}</div>
              {/if}
            {/if}
          </figure>
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
    {/snippet}

    {#snippet renderFileEditSummary(summary: VisualFileEditSummary)}
      <div class="work-file-edits">
        <div class="work-file-edits-title">
          <span class="work-file-edits-icon" aria-hidden="true">✎</span>
          <span>{summary.title}</span>
        </div>
        <div class="work-file-edit-list">
          {#each summary.files as file}
            {#if file.raw}
              <details class="work-file-edit-detail">
                <summary class="work-file-edit-row">
                  <span class="work-file-action">{fileEditActionLabel(file.action)}</span>
                  <span class="work-file-path" title={file.path}>
                    {fileEditBasename(file.path)}
                  </span>
                  {#if file.additions !== undefined}
                    <span class="work-file-add">+{file.additions}</span>
                  {/if}
                  {#if file.deletions !== undefined}
                    <span class="work-file-del">-{file.deletions}</span>
                  {/if}
                </summary>
                <div class="md work-file-raw">
                  {@html markdownCodeBlockHtml(file.raw, "diff")}
                </div>
              </details>
            {:else}
              <div class="work-file-edit-row">
                <span class="work-file-action">{fileEditActionLabel(file.action)}</span>
                <span class="work-file-path" title={file.path}>
                  {fileEditBasename(file.path)}
                </span>
                {#if file.additions !== undefined}
                  <span class="work-file-add">+{file.additions}</span>
                {/if}
                {#if file.deletions !== undefined}
                  <span class="work-file-del">-{file.deletions}</span>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/snippet}

    {#snippet renderWorkEntryBlocks(blocks: NormalizedBlock[])}
      {#each blocks as b}
        {#if b.type === "text"}
          {#if b.text}
            <div class="work-step-text md">{@html md(b.text)}</div>
          {/if}
        {:else if b.type === "thinking"}
          {@const thought = thinkingDisplay(b.text)}
          <div class="work-step-detail">
            <span class="thinking-icon" aria-hidden="true">🧠</span>
            <div class="thinking-copy">
              {#if thought.title}
                <div class="thinking-title">{thought.title}</div>
              {/if}
              {#if thought.body}
                <div class="tag-body md">{@html md(thought.body)}</div>
              {/if}
            </div>
          </div>
        {:else if b.type === "tool_use"}
          {@const inputCode = toolInputCode(b)}
          {#if inputCode}
            <div class="md work-tool-code">
              {@html markdownCodeBlockHtml(inputCode, toolInputLanguage(b))}
            </div>
          {/if}
        {:else if b.type === "tool_result"}
          {@const cleaned = cleanVisualToolResultText(b.text)}
          {#if cleaned.body || cleaned.wrappedCodexChunk}
            <div class="md work-tool-output" class:work-tool-output-empty={!cleaned.body}>
              <div class="work-tool-output-label">{toolResultLabel(cleaned)}</div>
              {#if cleaned.body}
              {@html markdownCodeBlockHtml(cleaned.body, "text")}
              {:else}
                <span class="work-tool-empty-text">no output</span>
              {/if}
            </div>
          {/if}
        {:else if b.type === "media"}
          {@const src = mediaSourceUrl(b)}
          <div class="work-step-detail">
            <span class="tag-label">{b.mediaKind ?? "artifact"}</span>
            {#if src}
              <a href={src} target="_blank" rel="noopener noreferrer">
                {mediaLabel(b)}
              </a>
            {:else}
              <span>{mediaLabel(b)}</span>
            {/if}
          </div>
        {:else if b.type === "ide_context"}
          <div class="work-step-detail">
            <span class="tag-label">IDE · {b.tagName ?? "context"}</span>
            <span class="tag-body">{b.text}</span>
          </div>
        {:else if b.type === "system_reminder"}
          <div class="work-step-detail">
            <span class="tag-label">system reminder</span>
            <span class="tag-body">{b.text}</span>
          </div>
        {:else if b.type === "command"}
          <div class="work-step-detail">
            <span class="tag-label">{b.tagName ?? "command"}</span>
            <span class="tag-body">{b.text}</span>
          </div>
        {:else if b.type === "marker"}
          <div class="work-step-detail">{b.text}</div>
        {/if}
      {/each}
    {/snippet}

    <ul
      class="messages"
      class:terminal-transcript={transcriptSurface === "terminal"}
      bind:this={messagesEl}
      on:mouseenter={onMessagesEnter}
      on:mouseleave={onMessagesLeave}
      on:wheel={onMessagesWheel}
      use:codeCopy
    >
      {#each visualTranscriptItems as item}
        {#if item.kind === "work"}
          <li class="work-row">
            <details class="work-foldout">
              <summary>
                <span>{formatWorkedDuration(item.startedAt, item.endedAt)}</span>
                <span class="work-count">
                  {item.entries.length}
                  {item.entries.length === 1 ? "step" : "steps"}
                </span>
              </summary>
              <div class="work-foldout-body">
                {#each buildVisualWorkDisplayEntries(item.entries) as displayEntry}
                  {@const entry = displayEntry.entry}
                  {#if isPlainAssistantWorkText(entry)}
                    <div class="work-entry-inline">
                      {@render renderWorkEntryBlocks(entry.blocks)}
                      {#if displayEntry.pairedResult}
                        {@render renderWorkEntryBlocks(displayEntry.pairedResult.blocks)}
                      {/if}
                    </div>
                  {:else if displayEntry.kind === "marker" && displayEntry.markerBlock}
                    {@const markerBlock = displayEntry.markerBlock}
                    <div
                      class="work-marker-pill"
                      class:complete={displayEntry.markerKind === "complete"}
                      class:started={displayEntry.markerKind === "started"}
                      class:compacted={displayEntry.markerKind === "compacted"}
                      class:aborted={displayEntry.markerKind === "aborted"}
                      title={markerBlock.text}
                    >
                      <span class="work-marker-icon" aria-hidden="true">
                        {workMarkerIcon(displayEntry.markerKind)}
                      </span>
                      <span>{displayEntry.markerLabel}</span>
                      {#if entry.message.timestamp}
                        <span
                          class="muted small"
                          title={new Date(entry.message.timestamp).toLocaleString()}
                        >
                          {relTimeFromIso(entry.message.timestamp)}
                        </span>
                      {/if}
                    </div>
                  {:else}
                    {@const toolBlock = workEntryToolUseBlock(entry)}
                    {@const editSummary = workEntryFileEditSummary(entry)}
                    {@const resultMeta = toolResultMeta(displayEntry.pairedResult)}
                    {@const toolPreview = toolBlock ? workEntryToolPreview(toolBlock) : ""}
                    <details class="work-entry">
                      <summary>
                        {#if toolBlock}
                          {#if editSummary}
                            <span class="work-tool-chip icon-only file-edit">
                              <span class="work-file-edits-icon" aria-hidden="true">✎</span>
                            </span>
                          {:else}
                            <span
                              class="work-tool-chip"
                              class:icon-only={toolUsesInlineCommandLabel(toolBlock)}
                            >
                              <ToolIcon name={toolBlock.toolName} />
                              {#if !toolUsesInlineCommandLabel(toolBlock)}
                              <span>{toolBlock.toolName ?? "tool"}</span>
                              {/if}
                            </span>
                          {/if}
                          {#if editSummary}
                            <span
                              class="work-tool-preview work-file-edit-preview"
                              title={editSummary.files.map((file) => file.path).join("\n")}
                            >
                              {editSummary.title}
                            </span>
                          {:else if toolPreview}
                            <span class="work-tool-preview" title={toolPreview}>
                              {toolPreview}
                            </span>
                          {/if}
                          {#if resultMeta}
                            <span class="work-tool-meta">{resultMeta}</span>
                          {/if}
                        {:else}
                          <span>{workEntryTitle(entry)}</span>
                        {/if}
                        {#if entry.message.timestamp}
                          <span
                            class="muted small work-entry-time"
                            title={new Date(entry.message.timestamp).toLocaleString()}
                          >
                            {relTimeFromIso(entry.message.timestamp)}
                          </span>
                        {/if}
                      </summary>
                      <div class="work-entry-body">
                        {#if editSummary}
                          {@render renderFileEditSummary(editSummary)}
                          <details class="work-raw-tool-details">
                            <summary>Raw tool input/output</summary>
                            {@render renderWorkEntryBlocks(entry.blocks)}
                            {#if displayEntry.pairedResult}
                              {@render renderWorkEntryBlocks(displayEntry.pairedResult.blocks)}
                            {/if}
                          </details>
                        {:else}
                          {@render renderWorkEntryBlocks(entry.blocks)}
                          {#if displayEntry.pairedResult}
                            {@render renderWorkEntryBlocks(displayEntry.pairedResult.blocks)}
                          {/if}
                        {/if}
                      </div>
                    </details>
                  {/if}
                {/each}
              </div>
            </details>
          </li>
        {:else}
          {@const m = item.message}
          <li
            class="msg role-{m.role}"
            class:user-message={m.role === "user"}
            class:assistant-response={m.role === "assistant"}
          >
            <div class="msg-head">
              <span
                class="role"
                class:assistant={m.role === "assistant"}
                class:brand-claude={m.role === "assistant" && agent === "claude"}
                class:brand-codex={m.role === "assistant" && agent === "codex"}
                class:brand-ollama={m.role === "assistant" &&
                  agent === "ollama"}
                class:brand-copilot={m.role === "assistant" &&
                  agent === "copilot"}
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
                    <path
                      d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
                    />
                  </svg>
                {:else if m.role === "assistant" && agent === "ollama"}
                  <img class="agent-icon" src="/agents/ollama.svg" alt="" />
                {/if}
                {roleLabel(m.role, m.author)}
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
            {@render renderMessageBlocks(
              displayBlocksForMessage(item.blocks, m.role),
              m,
              item.messageIndex,
            )}
          </li>
        {/if}
      {/each}
    </ul>
  {/if}

  {#if showChatComposer}
    <!-- API-driven chat composer. Ollama streams through /api/ollama/chat;
         Codex App streams through its app-server event channel. -->
    <div class="composer">
      {#if showComposerTray}
        <div class="composer-tray">
          {#if agent === "codex" && codexRequests.length}
            <div class="codex-requests">
              {#each codexRequests as req (req.id)}
                <div class="codex-request">
                  <div class="codex-request-main">
                    <span class="codex-request-title"
                      >{codexRequestTitle(req)}</span
                    >
                    <code
                      class="codex-request-preview"
                      title={codexRequestPreview(req)}
                      >{codexRequestPreview(req)}</code
                    >
                    {#if codexIsUserInputRequest(req)}
                      <div class="codex-request-questions">
                        {#each codexRequestQuestions(req) as q (q.id)}
                          <label class="codex-request-question">
                            <span>{q.header || q.question || "Answer"}</span>
                            {#if q.question && q.header}
                              <small>{q.question}</small>
                            {/if}
                            {#if q.options && q.options.length}
                              <select
                                value={codexQuestionDraft(req, q)}
                                on:change={(e) =>
                                  setCodexQuestionDraft(
                                    req,
                                    q,
                                    (e.currentTarget as HTMLSelectElement)
                                      .value,
                                  )}
                              >
                                <option value="">Choose…</option>
                                {#each q.options as opt (opt.label)}
                                  <option value={opt.label}>
                                    {opt.label}{opt.description
                                      ? ` — ${opt.description}`
                                      : ""}
                                  </option>
                                {/each}
                              </select>
                            {:else}
                              <input
                                type={q.isSecret ? "password" : "text"}
                                value={codexQuestionDraft(req, q)}
                                on:input={(e) =>
                                  setCodexQuestionDraft(
                                    req,
                                    q,
                                    (e.currentTarget as HTMLInputElement).value,
                                  )}
                              />
                            {/if}
                          </label>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  <div class="codex-request-actions">
                    {#if codexIsUserInputRequest(req)}
                      <button
                        type="button"
                        on:click={() => void answerCodexRequest(req, "accept")}
                        title="Send these answers to Codex">Send</button
                      >
                      <button
                        type="button"
                        on:click={() => void answerCodexRequest(req, "cancel")}
                        title="Cancel this input request">Cancel</button
                      >
                    {:else}
                      <button
                        type="button"
                        on:click={() => void answerCodexRequest(req, "accept")}
                        title="Approve this Codex request">Accept</button
                      >
                      {#if codexCanAcceptForSession(req)}
                        <button
                          type="button"
                          on:click={() =>
                            void answerCodexRequest(req, "acceptForSession")}
                          title="Approve similar Codex requests for this session"
                          >Session</button
                        >
                      {/if}
                      <button
                        type="button"
                        on:click={() => void answerCodexRequest(req, "decline")}
                        title="Decline this Codex request">Decline</button
                      >
                      <button
                        type="button"
                        on:click={() => void answerCodexRequest(req, "cancel")}
                        title="Cancel this Codex request">Cancel</button
                      >
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {#if agent === "codex" && codexQueuedMessages.length}
            <div class="codex-queue" aria-label="Queued Codex messages">
              {#each codexQueuedMessages as item, i (item.id)}
                {@const queueAttachments =
                  editingCodexQueueId === item.id
                    ? editingCodexQueueAttachments
                    : item.attachments}
                <div class="codex-queue-item">
                  <div class="codex-queue-main">
                    <span class="codex-queue-label">queued {i + 1}</span>
                    {#if editingCodexQueueId === item.id}
                      <textarea
                        class="codex-queue-edit"
                        bind:value={editingCodexQueueText}
                        rows="2"
                      ></textarea>
                    {:else}
                      <div class="codex-queue-preview" title={item.text}>
                        {item.text || "(attachments only)"}
                      </div>
                    {/if}
                    {#if queueAttachments.length}
                      <div class="codex-queue-attachments">
                        {#each queueAttachments as attachment, attachmentIndex (`${item.id}:${attachment.path}:${attachmentIndex}`)}
                          <div class="composer-attachment codex-queue-attachment">
                            <span
                              class="sticky-photo-frame composer-photo-frame codex-queue-photo"
                              class:sticky-photo-frame-transparent={attachment.hasAlpha}
                              title={inlineAttachmentLabel(attachment)}
                            >
                              <img
                                src={composerImageUrl(attachment)}
                                alt={inlineAttachmentLabel(attachment)}
                                draggable="false"
                              />
                            </span>
                            {#if editingCodexQueueId === item.id}
                              <button
                                type="button"
                                class="composer-attachment-remove"
                                on:click={() =>
                                  removeEditingCodexQueueAttachment(
                                    attachmentIndex,
                                  )}
                                title={`Remove ${inlineAttachmentLabel(attachment)}`}
                                aria-label={`Remove ${inlineAttachmentLabel(attachment)}`}
                              >
                                ×
                              </button>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  <div class="codex-queue-actions">
                    {#if editingCodexQueueId === item.id}
                      <button
                        type="button"
                        on:click={() => saveCodexQueuedMessage(item.id)}
                        disabled={!canSaveCodexQueueEdit(
                          editingCodexQueueText,
                          editingCodexQueueAttachments,
                        )}
                        title="Save queued message">Save</button
                      >
                      <button
                        type="button"
                        on:click={cancelEditCodexQueuedMessage}
                        title="Cancel edit">Cancel</button
                      >
                    {:else}
                      <button
                        type="button"
                        on:click={() => beginEditCodexQueuedMessage(item)}
                        title="Edit queued message">Edit</button
                      >
                      {#if codexActiveTurnId}
                        <button
                          type="button"
                          on:click={() => void steerCodexQueuedMessage(item)}
                          title="Send this queued message as steering now"
                          >Steer</button
                        >
                      {:else}
                        <button
                          type="button"
                          on:click={() => void runCodexQueuedMessage(item)}
                          title="Run this queued message now">Run</button
                        >
                      {/if}
                      <button
                        type="button"
                        on:click={() => removeCodexQueuedMessage(item.id)}
                        title="Remove queued message">Remove</button
                      >
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {#if agent === "codex" && (composerAttachments.length || composerUploadingImages || composerAttachmentError)}
            <div class="composer-attachments" aria-label="Message attachments">
              {#each composerAttachments as attachment, i (`${attachment.path}:${i}`)}
                <div class="composer-attachment">
                  <button
                    type="button"
                    class="composer-attachment-open"
                    on:click={() => openComposerAttachmentAt(i)}
                    title={`Open ${inlineAttachmentLabel(attachment)}`}
                    aria-label={`Open ${inlineAttachmentLabel(attachment)}`}
                  >
                    <span
                      class="sticky-photo-frame composer-photo-frame"
                      class:sticky-photo-frame-transparent={attachment.hasAlpha}
                    >
                      <img
                        src={composerImageUrl(attachment)}
                        alt={inlineAttachmentLabel(attachment)}
                        draggable="false"
                      />
                    </span>
                  </button>
                  <button
                    type="button"
                    class="composer-attachment-remove"
                    on:click={() => removeComposerAttachment(i)}
                    title={`Remove ${inlineAttachmentLabel(attachment)}`}
                    aria-label={`Remove ${inlineAttachmentLabel(attachment)}`}
                  >
                    ×
                  </button>
                </div>
              {/each}
              {#if composerUploadingImages}
                {#each Array.from({ length: composerUploadingImages }) as _, i}
                  <div
                    class="composer-attachment"
                    aria-label="Attaching image"
                    title="Attaching image"
                  >
                    <span
                      class="sticky-photo-frame composer-photo-frame composer-photo-frame-uploading"
                    >
                      <span
                        class="composer-photo-frame-uploading-mark"
                        aria-hidden="true"
                      ></span>
                    </span>
                  </div>
                {/each}
              {/if}
              {#if composerAttachmentError}
                <span
                  class="composer-attachment-error"
                  title={composerAttachmentError}
                >
                  {composerAttachmentError}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <div class="composer-box">
        <textarea
          class="composer-input"
          bind:value={inputText}
          placeholder={composerPlaceholder}
          rows="2"
          on:keydown={onComposerKey}
          on:paste={onComposerPaste}
          on:dragover={onComposerDragOver}
          on:drop={onComposerDrop}
          disabled={sending && agent !== "codex" && !ollamaAbort}
        ></textarea>
      </div>
      <div class="composer-footer">
        <div class="composer-send-wrap">
          {#if sending && agent === "ollama"}
            <button
              type="button"
              class="composer-send is-sending"
              on:click={stopOllamaStream}
              title="Stop generating"
              aria-label="Stop"
            >
              ◼
            </button>
          {:else if codexRunning && agent === "codex"}
            {#if codexActiveTurnId && composerCanSend}
              <button
                type="button"
                class="composer-send composer-steer"
                on:click={() => void steerCodexMessage()}
                disabled={composerUploadingImages > 0}
                title="Steer the running Codex turn"
                aria-label="Steer Codex"
              >
                ↩
              </button>
            {/if}
            <button
              type="button"
              class="composer-send"
              on:click={() => void sendMessage()}
              disabled={!composerCanSend || composerUploadingImages > 0}
              title="Queue for the next Codex turn"
              aria-label="Queue Codex message"
            >
              ↑
            </button>
            <button
              type="button"
              class="composer-send is-sending"
              on:click={() => void stopCodexTurn()}
              title="Stop Codex"
              aria-label="Stop Codex"
            >
              ◼
            </button>
          {:else}
            <button
              type="button"
              class="composer-send"
              on:click={() => void sendMessage()}
              disabled={!composerCanSend ||
                composerUploadingImages > 0 ||
                (sending && agent !== "codex")}
              title={agent === "codex" && codexActiveTurnId
                ? "Steer the running Codex turn"
                : "Send (Enter). Shift+Enter for newline."}
              aria-label="Send"
            >
              {sending ? "…" : "↑"}
            </button>
          {/if}
        </div>
      </div>
    </div>
    {#if sendError}
      <div class="composer-error" title={sendError}>{sendError}</div>
    {/if}
  {/if}
  {#if openComposerAttachment && openComposerAttachmentIndex !== null}
    <div
      class="attachment-media-scrim composer-media-scrim"
      role="presentation"
      tabindex="-1"
      on:click={closeComposerAttachment}
      on:keydown={onComposerAttachmentKeydown}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="attachment-media-modal attachment-media-modal-image"
        role="dialog"
        aria-modal="true"
        aria-label="Attachment"
        tabindex="-1"
        on:click|stopPropagation
        on:dblclick|stopPropagation
      >
        <header class="attachment-media-head">
          <span class="attachment-media-title">
            {inlineAttachmentLabel(openComposerAttachment)}
          </span>
          <span
            class="attachment-media-actions"
            role="toolbar"
            aria-label="Attachment actions"
          >
            <button
              type="button"
              class="composer-media-btn danger"
              title="Remove attachment"
              aria-label="Remove attachment"
              on:click={removeOpenComposerAttachment}
            >
              ×
            </button>
          </span>
          {#if composerAttachments.length > 1}
            <button
              type="button"
              class="attachment-media-nav"
              aria-label="Previous attachment"
              title="Previous attachment"
              on:click={() => stepComposerAttachment(-1)}>‹</button
            >
            <button
              type="button"
              class="attachment-media-nav"
              aria-label="Next attachment"
              title="Next attachment"
              on:click={() => stepComposerAttachment(1)}>›</button
            >
          {/if}
          <span class="attachment-media-count">
            {openComposerAttachmentIndex + 1} / {composerAttachments.length}
          </span>
          <button
            type="button"
            class="composer-media-btn"
            title="Close"
            aria-label="Close attachment"
            on:click={closeComposerAttachment}>×</button
          >
        </header>
        <div class="attachment-media-shell attachment-media-shell-image">
          <div class="attachment-media-body">
            <span
              class="sticky-photo-frame sticky-photo-frame-media"
              class:sticky-photo-frame-transparent={openComposerAttachment.hasAlpha}
            >
              <img
                src={composerImageUrl(openComposerAttachment)}
                alt={inlineAttachmentLabel(openComposerAttachment)}
                draggable="true"
              />
            </span>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .session {
    --session-head-height: 3.25rem;
    --session-body-min-height: 28rem;
    --session-body-max-height: 60vh;
    --composer-tray-max-height: min(13rem, 34vh);
    /* Relative so the LoadingOverlay (and any other absolutely
       positioned in-column callout) anchors against the column box. */
    position: relative;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
    /* Fill the column so the row's height (which is set by the tallest
       sibling via the strip's default flex stretch) reaches the body —
       header takes its natural height, the body (TerminalView or
       .messages) grows to fill what's left via flex:1.
       No margin-top here: the parent .sessions-strip already provides
       its own spacing from the row above. Let the panel's min/max drive
       the row height just like TerminalView's .terminal-wrap does. */
    flex: 1 1 calc(
      var(--session-body-min-height) + var(--session-head-height)
    );
    height: 100%;
    max-height: calc(var(--session-body-max-height) + var(--session-head-height));
    min-height: calc(var(--session-body-min-height) + var(--session-head-height));
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
  }
  .session.terminal-transcript-surface {
    border-radius: 0;
  }
  .session.terminal-transcript-surface :global(header),
  .session.terminal-transcript-surface :global(button),
  .session.terminal-transcript-surface :global(input),
  .session.terminal-transcript-surface :global(select),
  .session.terminal-transcript-surface :global(textarea) {
    border-radius: 0 !important;
  }
  /* Composited attention pulse. The old version animated box-shadow with
     an interpolated color-mix(var()), which WebKit re-resolves EVERY frame
     as a style recalc over the whole column subtree (~1.9ms each, ~2/frame
     across awaiting columns — see plans/performance.md). Here we animate
     only the OPACITY of a pseudo-element holding a STATIC inset glow
     (color-mix resolved once): opacity is GPU-composited, so no per-frame
     recalc/layout/paint. Inset (not an outer ring) because .session is
     overflow:hidden and would clip an outer ::after. */
  .session.awaiting-input::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 8px 2px
      color-mix(in srgb, var(--status-dirty) 45%, transparent);
    animation: session-awaiting-pulse 1.8s ease-in-out infinite;
  }
  @keyframes session-awaiting-pulse {
    0%,
    100% {
      opacity: 0;
    }
    50% {
      opacity: 1;
    }
  }
  /* When this column goes fullscreen, drop the rounded border + fill
     the viewport. TerminalView's ResizeObserver re-fits xterm for us. */
  .session:fullscreen {
    width: 100vw;
    height: 100vh;
    max-height: none;
    border-radius: 0;
    border: 0;
    background: var(--surface-1);
  }
  :global(.row.row-zen) .session {
    max-height: none;
  }
  /* TerminalView caps itself at 60vh so a TUI never dominates the
     normal dashboard. In fullscreen that cap leaves dead space below
     the terminal — lift it so the TUI fills the viewport, same as zen
     does (zen-row.css). FitAddon re-fits via TerminalView's
     ResizeObserver. */
  .session:fullscreen :global(.terminal-wrap) {
    max-height: none;
    min-height: 0;
    flex: 1 1 0;
  }
  /* The head-stack hosts the header + the absolutely-positioned pin.
     `z-index: 2` lifts its entire compositing layer above the TUI
     (which has implicit auto stacking from flex document order), so
     the pin — painted within head-stack's layer — can overlay the
     top of the TUI when revealed. Without this, the TUI would paint
     on top of the revealed pin and visually swallow it. */
  .session-head-stack {
    position: relative;
    flex: 0 0 auto;
    z-index: 2;
  }
  /* The pin hangs just below the header. Fast opacity transition so
     the appear/disappear feels snappy rather than gradual — short
     enough that the backdrop-blur "growing in" effect is too brief
     to register. */
  .pinned-last-msg-wrap {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    display: flex;
    /* Right-aligned so the pill hugs the column's right edge —
       leaves the left/centre of the TUI uncovered when the pin is
       revealed. Right padding keeps the pill clear of the column's
       vertical scrollbar so the overlay never sits on top of it. */
    justify-content: flex-end;
    padding: 0.3rem 2rem 0 0.5rem;
    pointer-events: none;
    opacity: 0;
    transition: opacity 80ms ease;
  }
  .pinned-last-msg-wrap.revealed {
    opacity: 1;
    /* The wrap stays pointer-events:none even when revealed — it spans
       the full column width (left:0/right:0), so making it interactive
       would swallow wheel/clicks meant for the TUI and its scrollbar
       underneath. Only the visible pills (gated below) take events. */
  }
  /* Always-visible Summarize / Refresh chip in read mode — sits in
     the same below-header zone as the pinned-last-msg pill, so the
     read view picks up the TUI's pin affordance. Reset button
     styles so it reads as a small ghost chip, not a form button. */
  /* Inline "Summarize" CTA shown inside the read-mode summary
     overlay when no snippet exists yet. Compact button styled to
     match the surrounding overlay; clicking fires summarizeFromChip
     and the box flips to the spinner / snippet states. */
  .tui-summary-cta {
    font: inherit;
    font-size: 0.72rem;
    line-height: 1.2;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    text-align: left;
  }
  .tui-summary-cta:hover {
    color: var(--text-1);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  /* Ephemeral notice inside the read-mode summary overlay — e.g.
     "No Ollama model installed". Sits below the Summarize CTA when
     present. */
  .tui-summary-notice {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.65rem;
    line-height: 1.3;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    border: 1px solid color-mix(in srgb, #d9822b 35%, transparent);
    background: color-mix(in srgb, #d9822b 18%, transparent);
    color: var(--text-1);
    cursor: default;
    text-align: left;
  }
  .tui-summary-notice.clickable {
    cursor: pointer;
  }
  .tui-summary-notice.clickable:hover {
    background: color-mix(in srgb, #d9822b 28%, transparent);
  }
  .pinned-last-msg {
    /* Intrinsic text width, capped so a long message stays compact
       and doesn't crowd the TUI underneath. */
    max-width: 50%;
    box-sizing: border-box;
    padding: 0.25rem 0.6rem;
    background: rgb(26, 26, 27);
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    line-height: 1.35;
    text-align: left;
    /* Resting state: hard 3-line cut via max-height + overflow:
       hidden. On hover the pill expands to show up to ~50vh of
       content so the user can read a longer burst in full without
       jumping into the chat. Both heights animate so the expand
       feels intentional rather than snapping. */
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    overflow: hidden;
    word-break: break-word;
    max-height: calc(3lh + 0.5rem);
    transition: max-height 180ms ease;
  }
  .pinned-last-msg:hover {
    /* Tall enough for a long burst of quick messages but capped so
       the pill never grows beyond the visible column. Overflow stays
       hidden, switching to auto only when the natural content is
       taller than the cap — so the user can scroll within the
       expanded pill if they really need to. */
    max-height: 50vh;
    overflow: auto;
  }
  /* Only re-enable pointer events on the pill once it's revealed —
     otherwise the invisible pill at rest would still swallow clicks
     meant for the TUI underneath. */
  .pinned-last-msg-wrap.revealed .pinned-last-msg {
    pointer-events: auto;
  }
  /* Burger menu UI + .session-menu-popover sizing now live in
     SessionMenu.svelte / styles/popover.css respectively. */
  .error {
    color: var(--error-text);
    padding: 0.5rem 0.75rem;
    margin: 0;
  }
  /* One rounded chat control: the textarea is the surface, and the send
     actions sit inside it rather than in a second footer panel. */
  .composer {
    position: relative;
    z-index: 3;
    align-self: center;
    width: min(calc(100% - 1.6rem), 56rem);
    min-height: 6.4rem;
    margin: 0.45rem auto 0.6rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 72%, transparent);
    border-radius: 1.25rem;
    background: color-mix(in srgb, var(--surface-2) 82%, var(--surface-1));
    padding: 0.72rem 3.75rem 0.72rem 0.95rem;
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    gap: 0.15rem;
    box-sizing: border-box;
    overflow: visible;
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 4%, transparent);
  }
  .composer:has(.composer-send-wrap button + button) {
    padding-right: 8rem;
  }
  .session.empty-chat-composer:not(.has-composer-error) .composer {
    margin-top: auto;
    margin-bottom: auto;
  }
  .session.empty-chat-composer.has-composer-error .composer {
    margin-top: auto;
    margin-bottom: 0.35rem;
  }
  .composer-tray {
    position: absolute;
    left: 0.6rem;
    right: 0.6rem;
    bottom: calc(100% + 0.35rem);
    z-index: 4;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-height: 0;
    min-width: 0;
    max-height: var(--composer-tray-max-height);
    padding: 0.35rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 80%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-2) 94%, transparent);
    box-shadow: 0 10px 26px -20px rgba(0, 0, 0, 0.9);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .composer-box,
  .composer-footer {
    flex: 0 0 auto;
  }
  .composer-box {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
  }
  .codex-requests {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .codex-request {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: start;
    padding: 0.45rem 0.5rem;
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
  }
  .codex-request-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
  }
  .codex-request-title {
    color: var(--text-1);
    font-size: 0.75rem;
    font-weight: 650;
  }
  .codex-request-preview {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    background: transparent;
    font-size: 0.72rem;
  }
  .codex-request-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    justify-content: flex-end;
  }
  .codex-request-actions button {
    border: 1px solid var(--surface-3);
    background: var(--surface-0);
    color: var(--text-1);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 0.72rem;
    padding: 0.25rem 0.42rem;
    cursor: pointer;
  }
  .codex-request-actions button:hover {
    border-color: var(--text-faint);
  }
  .codex-queue {
    display: grid;
    gap: 0.35rem;
  }
  .codex-queue-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.45rem;
    align-items: start;
    padding: 0.4rem 0.45rem;
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-1) 82%, transparent);
  }
  .codex-queue-main {
    min-width: 0;
    display: grid;
    gap: 0.22rem;
  }
  .codex-queue-label {
    color: var(--text-faint);
    font-size: 0.64rem;
    line-height: 1;
    text-transform: uppercase;
  }
  .codex-queue-preview {
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    font-size: 0.76rem;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .codex-queue-edit {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 2.4rem;
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-1);
    font: inherit;
    font-size: 0.76rem;
    line-height: 1.3;
    padding: 0.35rem 0.42rem;
  }
  .codex-queue-attachments {
    display: flex;
    gap: 0.3rem;
    overflow-x: auto;
  }
  .codex-queue-attachment {
    width: 3.5rem;
  }
  .codex-queue-photo {
    width: 3.5rem;
    padding: 4px 4px 10px;
  }
  .codex-queue-photo img {
    max-height: 2rem;
  }
  .codex-queue-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.28rem;
  }
  .codex-queue-actions button {
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-1);
    font: inherit;
    font-size: 0.7rem;
    line-height: 1;
    padding: 0.26rem 0.38rem;
    cursor: pointer;
  }
  .codex-queue-actions button:hover:not(:disabled) {
    border-color: var(--text-faint);
  }
  .codex-queue-actions button:disabled {
    color: var(--text-faint);
    cursor: not-allowed;
  }
  .codex-request-questions {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.35rem;
  }
  .codex-request-question {
    display: grid;
    gap: 0.18rem;
    color: var(--text-1);
    font-size: 0.75rem;
  }
  .codex-request-question small {
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .codex-request-question input,
  .codex-request-question select {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-1);
    font: inherit;
    font-size: 0.75rem;
    padding: 0.3rem 0.38rem;
  }
  .composer-input {
    width: 100%;
    box-sizing: border-box;
    flex: 1 1 auto;
    resize: none;
    min-height: 4.9rem;
    background: transparent;
    color: var(--text-1);
    border: 0;
    border-radius: 0;
    padding: 0.15rem 0 0;
    font: inherit;
    font-size: 0.85rem;
    line-height: 1.35;
  }
  .composer-input:focus {
    outline: none;
  }
  .composer-input::placeholder {
    color: var(--text-muted);
  }
  .composer-attachments {
    display: flex;
    align-items: flex-start;
    gap: 0.45rem;
    min-width: 0;
    overflow-x: auto;
    padding: 0.25rem 0.15rem 0.15rem;
  }
  .composer-attachment {
    position: relative;
    flex: 0 0 auto;
    width: 4.8rem;
  }
  .composer-attachment-open {
    display: block;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .composer-attachment-open:hover .composer-photo-frame {
    border-color: rgba(42, 37, 22, 0.3);
  }
  .composer-photo-frame {
    box-sizing: border-box;
    width: 100%;
    padding: 5px 5px 14px;
  }
  .composer-photo-frame img {
    max-height: 3.1rem;
  }
  .composer-photo-frame-uploading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 4.25rem;
  }
  .composer-photo-frame-uploading-mark {
    width: 1.4rem;
    height: 1.4rem;
    border: 2px solid rgba(42, 37, 22, 0.18);
    border-top-color: rgba(42, 37, 22, 0.52);
    border-radius: 999px;
    animation: composer-upload-spin 850ms linear infinite;
  }
  @keyframes composer-upload-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .composer-attachment-remove {
    position: absolute;
    top: -4px;
    right: -4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid var(--surface-3);
    border-radius: 999px;
    background: var(--surface-0);
    color: var(--text-muted);
    font: inherit;
    font-size: 0.82rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    box-shadow: 0 4px 12px -8px rgba(0, 0, 0, 0.65);
    transition:
      color 120ms ease,
      background 120ms ease,
      border-color 120ms ease,
      opacity 120ms ease;
  }
  .composer-attachment:hover .composer-attachment-remove,
  .composer-attachment:focus-within .composer-attachment-remove {
    opacity: 1;
  }
  .composer-attachment-remove:hover {
    border-color: var(--text-faint);
    background: var(--surface-1);
    color: var(--error-text);
  }
  .composer-media-btn:hover {
    border-color: var(--text-faint);
  }
  .composer-attachment-status,
  .composer-attachment-error {
    flex: 0 0 auto;
    align-self: center;
    max-width: 12rem;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-attachment-error {
    color: var(--error-text);
  }
  .composer-media-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.45rem;
    height: 1.35rem;
    padding: 0 0.35rem;
    border: 1px solid rgba(42, 37, 22, 0.18);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.45);
    color: #2a2516;
    font: inherit;
    font-size: 0.78rem;
    line-height: 1;
    cursor: pointer;
  }
  .composer-media-btn.danger {
    color: #9b2c2c;
  }
  /* Empty assistant bubble while waiting for the first SSE chunk.
     Muted color so the spinner reads as "thinking" rather than as
     a primary UI element; min-height so the bubble doesn't snap
     from spinner-sized to multi-line when the first chunk lands. */
  .ollama-waiting {
    color: var(--text-muted);
    min-height: 1.2rem;
    display: flex;
    align-items: center;
  }
  .composer-error {
    align-self: center;
    width: min(calc(100% - 1.6rem), 56rem);
    flex: 0 0 auto;
    margin: -0.35rem auto 0.45rem;
    box-sizing: border-box;
    color: var(--error-text);
    font-size: 0.68rem;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session.empty-chat-composer.has-composer-error .composer-error {
    margin-top: auto;
  }
  .composer-footer {
    position: absolute;
    right: 0.7rem;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .composer-send-wrap {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
  }
  .composer-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.15rem;
    height: 2.15rem;
    background: var(--text-1);
    color: var(--surface-0);
    border: 1px solid var(--text-1);
    border-radius: 0.55rem;
    cursor: pointer;
    transition:
      background 0.1s ease,
      border-color 0.1s ease,
      color 0.1s ease;
    font-weight: 700;
  }
  .composer-send:hover:not(:disabled) {
    background: var(--text-2);
    border-color: var(--text-2);
  }
  .composer-steer {
    background: transparent;
    color: var(--text-1);
    border-color: var(--surface-3);
  }
  .composer-steer:hover:not(:disabled) {
    background: var(--surface-3);
    border-color: var(--surface-3);
  }
  .composer-send:disabled {
    cursor: not-allowed;
  }
  /* In-flight send: keep the spinner readable (slightly muted text)
     instead of fading the button to near-invisible. */
  .composer-send.is-sending:disabled {
    color: var(--surface-0);
  }
  .composer-send:disabled:not(.is-sending) {
    color: var(--text-faint);
    background: var(--surface-1);
    border-color: var(--surface-3);
  }
  @media (max-width: 720px) {
    .composer {
      width: calc(100% - 0.9rem);
      min-height: 5.8rem;
      margin-inline: auto;
      padding-right: 3.35rem;
    }
    .composer:has(.composer-send-wrap button + button) {
      padding-right: 7.25rem;
    }
    .composer-input {
      min-height: 4.4rem;
    }
  }
  /* `.loading-overlay` + `.spinner` retired — the shared
     LoadingOverlay component now renders both the chat read-mode
     load state and the TUI starting state, in matching chrome-free
     style. */
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.75rem;
  }
  .messages {
    list-style: none;
    padding: 1.6rem 0.5rem 0.4rem;
    margin: 0;
    flex: 1 1 0;
    min-height: 0;
    max-height: none;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    /* Contain VERTICAL scroll chaining only — once the user is
       intentionally scrolling this column, hitting top/bottom won't
       scroll the page. Horizontal stays `auto` so a trackpad swipe
       over the chat still reaches the parent `.sessions-strip` and
       pans the row of columns. (Order is `<x> <y>` in the
       shorthand.) */
    overscroll-behavior: auto contain;
  }
  .messages.terminal-transcript {
    gap: 0.18rem;
    padding: 1.1rem 0.45rem 0.35rem;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .messages.terminal-transcript :global(*) {
    border-radius: 0 !important;
  }
  .messages.terminal-transcript .msg,
  .messages.terminal-transcript .msg.user-message,
  .messages.terminal-transcript .msg.assistant-response {
    align-self: stretch;
    width: auto;
    max-width: none;
    padding: 0.2rem 0.25rem;
    border: 0;
    background: transparent;
    font: inherit;
  }
  .messages.terminal-transcript .msg-head {
    display: flex;
    margin-bottom: 0.12rem;
  }
  .messages.terminal-transcript .msg.user-message {
    align-items: stretch;
  }
  .messages.terminal-transcript .msg.user-message .block.text {
    padding: 0;
    border: 0;
    background: transparent;
  }
  .messages.terminal-transcript .block,
  .messages.terminal-transcript .md,
  .messages.terminal-transcript .md :global(*) {
    font-family: inherit;
  }
  .messages.terminal-transcript .role,
  .messages.terminal-transcript .role.assistant {
    font-family: inherit;
    font-size: 0.72rem;
    letter-spacing: 0;
    text-transform: none;
  }
  .messages.terminal-transcript .work-foldout > summary {
    border: 0;
    background: transparent;
    padding-inline: 0;
  }
  .messages.terminal-transcript .work-foldout-body,
  .messages.terminal-transcript .work-entry-body {
    border-left-color: color-mix(
      in srgb,
      var(--text-muted) 28%,
      transparent
    );
  }
  .messages.terminal-transcript .work-tool-chip,
  .messages.terminal-transcript .work-marker-pill,
  .messages.terminal-transcript .md :global(code),
  .messages.terminal-transcript .md :global(.md-code-frame) {
    background: color-mix(in srgb, var(--surface-2) 64%, transparent);
  }
  .msg {
    align-self: stretch;
    padding: 0.45rem 0.6rem;
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    border: 1px solid var(--surface-2);
    font-size: 0.82rem;
  }
  .msg.user-message {
    align-self: flex-end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
    width: fit-content;
    max-width: 80%;
    padding: 0;
    background: transparent;
    border-color: transparent;
  }
  .msg.user-message .msg-head {
    display: none;
  }
  .msg.user-message .block.text {
    padding: 0.45rem 0.7rem;
    border-radius: 1rem;
    background: color-mix(in srgb, var(--surface-3) 62%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--surface-3) 80%, transparent);
    text-align: left;
  }
  .msg.user-message .media-block {
    margin: 0;
    max-width: min(16rem, 100%);
  }
  .msg.user-message .media-block.media-image a {
    width: min(12rem, 100%);
  }
  .msg.user-message .media-photo-frame img {
    max-height: 7.2rem;
  }
  .msg.user-message .media-block figcaption {
    display: none;
  }
  .msg.assistant-response {
    background: transparent;
    border-color: transparent;
    padding-inline: 0.25rem;
  }
  .msg.assistant-response .msg-head {
    margin-bottom: 0.15rem;
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
  .role.brand-ollama {
    color: var(--chip-ollama-text);
  }
  .role.brand-copilot {
    color: var(--chip-default-text);
  }
  .block.text {
    word-break: break-word;
  }
  .work-row {
    align-self: stretch;
    list-style: none;
    padding: 0;
    margin: 0.15rem 0;
    min-width: 0;
  }
  .work-foldout,
  .work-entry {
    border-radius: var(--radius-sm);
    min-width: 0;
  }
  .work-foldout > summary,
  .work-entry > summary {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    list-style: none;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }
  .work-foldout > summary {
    width: fit-content;
    max-width: 100%;
    padding: 0.25rem 0.5rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 65%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-1) 75%, transparent);
    font-size: 0.72rem;
    line-height: 1.2;
  }
  .work-foldout > summary:hover {
    color: var(--text-1);
    border-color: var(--surface-3);
  }
  .work-foldout[open] > summary {
    color: var(--text-1);
  }
  .work-foldout > summary::-webkit-details-marker,
  .work-entry > summary::-webkit-details-marker {
    display: none;
  }
  .work-foldout > summary::before,
  .work-entry > summary::before {
    content: "▸";
    display: inline-block;
    line-height: 1;
    color: var(--text-faint);
    font-size: 0.7rem;
    transition: transform 0.15s ease-out;
  }
  .work-foldout[open] > summary::before,
  .work-entry[open] > summary::before {
    transform: rotate(90deg);
  }
  .work-count {
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
  }
  .work-foldout-body {
    display: grid;
    gap: 0.38rem;
    margin: 0.55rem 0 0.15rem 1.05rem;
    padding-left: 0.65rem;
    border-left: 1px solid color-mix(in srgb, var(--surface-3) 45%, transparent);
    min-width: 0;
    max-width: calc(100% - 1.7rem);
  }
  .work-entry {
    padding: 0;
    background: transparent;
    border: 0;
    min-width: 0;
  }
  .work-entry-inline {
    color: var(--text-2);
    font-size: 0.78rem;
    line-height: 1.45;
    min-width: 0;
    max-width: 100%;
  }
  .work-marker-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    width: fit-content;
    max-width: 100%;
    padding: 0.16rem 0.46rem 0.18rem;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--surface-3) 48%, transparent);
    background: color-mix(in srgb, var(--surface-2) 48%, transparent);
    color: var(--text-muted);
    font-size: 0.74rem;
    line-height: 1.2;
  }
  .work-marker-pill.complete {
    border-color: color-mix(in srgb, var(--ok) 38%, var(--surface-3));
    background: color-mix(in srgb, var(--ok) 13%, transparent);
    color: color-mix(in srgb, var(--ok) 78%, var(--text-1));
  }
  .work-marker-pill.started {
    color: var(--text-faint);
  }
  .work-marker-pill.compacted {
    border-color: color-mix(in srgb, var(--accent, #6aa9ff) 28%, var(--surface-3));
    background: color-mix(in srgb, var(--accent, #6aa9ff) 9%, transparent);
    color: color-mix(in srgb, var(--accent, #6aa9ff) 62%, var(--text-1));
  }
  .work-marker-pill.aborted {
    border-color: color-mix(in srgb, var(--danger, #e5707a) 34%, var(--surface-3));
    background: color-mix(in srgb, var(--danger, #e5707a) 10%, transparent);
    color: color-mix(in srgb, var(--danger, #e5707a) 72%, var(--text-1));
  }
  .work-marker-icon {
    display: inline-grid;
    place-items: center;
    width: 0.95rem;
    height: 0.95rem;
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 16%, transparent);
    font-size: 0.68rem;
    line-height: 1;
  }
  .work-entry > summary {
    justify-content: flex-start;
    min-height: 1.7rem;
    padding: 0.15rem 0.2rem;
    border-radius: 0.45rem;
    font-size: 0.76rem;
    line-height: 1.25;
  }
  .work-entry > summary:hover {
    background: color-mix(in srgb, var(--surface-1) 48%, transparent);
    color: var(--text-1);
  }
  .work-entry > summary > span:not(.work-tool-chip):first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .work-tool-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex: 0 0 auto;
    padding: 0.1rem 0.38rem 0.12rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 55%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-2) 64%, transparent);
    color: var(--text-2);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.74rem;
    line-height: 1.15;
  }
  .work-tool-chip.icon-only {
    padding: 0.14rem 0.32rem;
  }
  .work-tool-chip.file-edit {
    color: var(--text-muted);
  }
  .work-tool-chip span {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .work-tool-preview {
    flex: 1 1 auto;
    min-width: 4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.7rem;
  }
  .work-entry[open] > summary .work-tool-preview {
    display: none;
  }
  .work-file-edit-preview {
    color: var(--text-muted);
  }
  .work-tool-meta {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
    font-size: 0.7rem;
  }
  .work-entry-time {
    display: none;
    flex: 0 0 auto;
  }
  .work-entry[open] > summary .work-entry-time {
    display: inline;
  }
  .work-entry-body {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    max-width: 100%;
    margin: 0.25rem 0 0.45rem 0.9rem;
    padding-left: 0.55rem;
    border-left: 1px solid color-mix(in srgb, var(--surface-3) 35%, transparent);
    color: var(--text-2);
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .work-file-edits {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
    color: var(--text-2);
  }
  .work-file-edits-title,
  .work-file-edit-row {
    display: flex;
    align-items: baseline;
    gap: 0.42rem;
    min-width: 0;
  }
  .work-file-edits-title {
    color: var(--text-muted);
    font-size: 0.78rem;
  }
  .work-file-edits-icon {
    color: var(--text-faint);
    font-family: ui-monospace, monospace;
    line-height: 1;
  }
  .work-file-edit-list {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .work-file-edit-detail {
    min-width: 0;
  }
  .work-file-edit-detail > summary,
  .work-raw-tool-details > summary {
    list-style: none;
    cursor: pointer;
  }
  .work-file-edit-detail > summary::-webkit-details-marker,
  .work-raw-tool-details > summary::-webkit-details-marker {
    display: none;
  }
  .work-file-edit-detail > summary::before,
  .work-raw-tool-details > summary::before {
    content: "▸";
    display: inline-block;
    flex: 0 0 auto;
    color: var(--text-faint);
    line-height: 1;
    transition: transform 0.15s ease-out;
  }
  .work-file-edit-detail[open] > summary::before,
  .work-raw-tool-details[open] > summary::before {
    transform: rotate(90deg);
  }
  .work-file-action {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .work-file-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--accent, #6aa9ff);
  }
  .work-file-add,
  .work-file-del {
    flex: 0 0 auto;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .work-file-add {
    color: var(--ok, #31d078);
  }
  .work-file-del {
    color: var(--bad, #ff5a5a);
  }
  .work-file-raw {
    margin: 0.24rem 0 0.42rem 1.1rem;
    min-width: 0;
  }
  .work-raw-tool-details {
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    margin-top: 0.15rem;
  }
  .work-raw-tool-details > summary {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    width: fit-content;
    color: var(--text-faint);
    font-size: 0.72rem;
  }
  .work-raw-tool-details > summary:hover {
    color: var(--text-muted);
  }
  .work-step-text,
  .work-step-detail,
  .work-tool-code,
  .work-tool-output {
    min-width: 0;
    max-width: 100%;
  }
  .work-step-detail {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    color: var(--text-muted);
  }
  .work-step-detail .tag-body {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--text-2);
  }
  .work-tool-code,
  .work-tool-output {
    display: grid;
    gap: 0.22rem;
  }
  .work-tool-output-label {
    color: var(--text-muted);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.7rem;
    line-height: 1.2;
  }
  .work-tool-empty-text,
  .tool-result-empty-text {
    color: var(--text-faint);
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.74rem;
  }
  .work-foldout-body .md :global(.md-code-frame),
  .work-entry-body .md :global(.md-code-frame) {
    max-width: 100%;
    margin: 0.08rem 0;
  }
  .work-tool-code :global(.md-code-frame),
  .work-tool-output :global(.md-code-frame),
  .block.tool-result :global(.md-code-frame) {
    display: flex;
    flex-direction: column;
    max-height: min(26rem, 46vh);
  }
  .work-foldout-body .md :global(pre),
  .work-entry-body .md :global(pre) {
    max-width: 100%;
    font-size: 0.78rem;
  }
  .work-tool-code :global(pre),
  .work-tool-output :global(pre),
  .block.tool-result :global(pre) {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 22rem;
    overflow: auto;
  }
  .work-foldout-body .md :global(p),
  .work-entry-body .md :global(p) {
    margin: 0.2em 0;
  }

  /* Markdown rendering. Keep elements quiet enough for a chat density
     (small margins, subtle code chips). */
  .md :global(p) {
    margin: 0.35em 0 0.55em;
  }
  .md :global(p:first-child) {
    margin-top: 0;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(code) {
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
    border: 1px solid color-mix(in srgb, var(--surface-3) 72%, transparent);
    padding: 0.08em 0.35em;
    border-radius: 0.32rem;
    font-family: ui-monospace, monospace;
    font-size: 0.86em;
    color: var(--text-1);
  }
  .md :global(.md-code-frame) {
    margin: 0.65em 0;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--surface-3) 72%, transparent);
    border-radius: 0.7rem;
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  }
  .md :global(.md-code-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 1.45rem;
    padding: 0.22rem 0.5rem 0.02rem;
    color: var(--text-muted);
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
  }
  .md :global(.md-code-lang) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .md :global(.md-code-copy) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.32rem;
    height: 1.16rem;
    min-width: 1.32rem;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0;
    cursor: pointer;
  }
  .md :global(.md-code-copy::before),
  .md :global(.md-code-copy::after) {
    content: "";
    position: absolute;
    width: 0.42rem;
    height: 0.52rem;
    border: 1.25px solid currentColor;
    border-radius: 0.11rem;
  }
  .md :global(.md-code-copy::before) {
    transform: translate(-0.08rem, 0.06rem);
  }
  .md :global(.md-code-copy::after) {
    transform: translate(0.09rem, -0.08rem);
    background: color-mix(in srgb, var(--surface-2) 86%, transparent);
  }
  .md :global(.md-code-copy:hover) {
    border-color: var(--surface-3);
    background: color-mix(in srgb, var(--surface-1) 80%, transparent);
    color: var(--text-1);
  }
  .md :global(pre) {
    margin: 0;
    padding: 0.22rem 0.65rem 0.62rem;
    overflow-x: auto;
    background: transparent;
    font-family: ui-monospace, monospace;
    font-size: 0.86em;
    line-height: 1.5;
  }
  .md :global(pre code) {
    display: block;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0;
    color: var(--text-1);
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
  .block.tool-result .muted {
    display: block;
    margin-bottom: 0.2rem;
  }
  .media-block {
    margin: 0.35rem 0 0;
    max-width: min(100%, 34rem);
  }
  .media-block a {
    color: var(--brand);
    text-decoration: none;
  }
  .media-block.media-image a {
    display: block;
    width: min(18rem, 100%);
    color: inherit;
  }
  .media-block a:hover {
    text-decoration: underline;
  }
  .media-photo-frame {
    box-sizing: border-box;
  }
  .media-photo-frame img {
    max-height: 9rem;
  }
  .media-block figcaption {
    margin-top: 0.2rem;
    font-size: 0.72rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .media-artifact {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    background: rgba(160, 160, 160, 0.06);
    color: var(--text-muted);
    font-size: 0.76rem;
  }
  .media-artifact > a,
  .media-artifact > span:not(.tag-label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .media-note {
    margin-top: 0.2rem;
    color: var(--text-faint);
    font-size: 0.72rem;
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
    align-items: flex-start;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    background: rgba(160, 160, 160, 0.06);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .thinking-icon {
    flex: 0 0 auto;
    width: 1.1em;
    line-height: 1.35;
    opacity: 0.82;
    font-size: 0.92em;
  }
  .thinking-copy {
    min-width: 0;
    display: grid;
    gap: 0.18rem;
  }
  .thinking-title {
    color: var(--text-2);
    font-weight: 650;
    font-style: normal;
  }
  .block.thinking .tag-body {
    color: var(--text-muted);
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    flex: 1;
  }
  .thinking-copy .tag-body {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    overflow-wrap: anywhere;
    font-style: normal;
  }
  .thinking-copy .tag-body :global(p) {
    margin: 0 0 0.45rem;
  }
  .thinking-copy .tag-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .work-step-detail .thinking-copy .tag-body {
    color: var(--text-muted);
  }
  .block.marker {
    margin-top: 0.2rem;
    font-style: italic;
    font-size: 0.75rem;
    color: var(--text-faint);
  }

  /* ── TUI summary overlay ────────────────────────────────────── */
  /* The summary wrap reuses `.pinned-last-msg-wrap` for the base
     absolute-positioned overlay behavior (top:100%, opacity
     transition, pointer-events:none). Override justify-content to
     left-align the summary box (the last-user-message is right-
     aligned). */
  .tui-overlay-stack {
    flex-direction: column;
    align-items: flex-end;
    gap: 0.35rem;
  }
  /* Pills are interactive only once revealed (and the wrap itself never
     is), so the at-rest overlay can't swallow events over the TUI either. */
  .pinned-last-msg-wrap.revealed.tui-overlay-stack > * {
    pointer-events: auto;
  }
  .tui-overlay-icon {
    flex-shrink: 0;
    margin-top: 0.15rem;
    opacity: 0.5;
  }
  .tui-summary-box {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    max-width: 50%;
    box-sizing: border-box;
    padding: 0.3rem 2rem 0.3rem 0.6rem;
    background: rgb(26, 26, 27);
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    border-radius: var(--radius-sm);
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--text-2);
    max-height: calc(4 * 1.5em + 0.6rem);
    overflow: hidden;
    transition:
      max-height 300ms 300ms ease,
      opacity 100ms ease;
  }
  .tui-summary-box:hover {
    max-height: 50vh;
    overflow: auto;
    transition:
      max-height 150ms ease,
      opacity 100ms ease;
  }
  .tui-summary-body {
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
  }
  .tui-summary-box:hover .tui-summary-body {
    -webkit-line-clamp: unset;
    display: block;
  }
  .tui-summary-refreshing {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .tui-summary-refresh {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 0.15rem;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    opacity: 0.4;
    transition: opacity 120ms ease;
  }
  .tui-summary-box:hover .tui-summary-refresh {
    opacity: 1;
  }
  .tui-summary-refresh:hover {
    background: var(--surface-3, var(--surface-2));
    color: var(--text-1);
    opacity: 1;
  }
  .tui-summary-model {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    color: var(--text-faint);
  }
  .pinned-last-msg-text {
    min-width: 0;
  }
</style>
