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
    codexAccessOptions,
    codexAgentSettings,
    parseCodexAccessValue,
    effortIcon,
    type AgentSettingGroup,
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
    lastUserMessageBurst,
    lastUserMessageWithContext as buildLastUserMessageWithContext,
  } from "./last-user-message";
  import { registerSessionPoll } from "./session-poll";
  import { splitParent } from "./file-browser-utils";

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
  /** Fired whenever the user flips between read and terminal mode (or
   *  the PTY exits and we flip back). The parent persists this so a
   *  page reload restores the same view. */
  export let onModeChange: (mode: "read" | "terminal") => void = () => {};
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
  interface CodexAppEvent {
    kind: "notification" | "request";
    id?: string | number;
    method: string;
    params: Record<string, unknown>;
    threadId?: string;
    turnId?: string;
    receivedAt: string;
    seq?: number;
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
      const res = await fetch(apiUrl(`/api/sessions/summarize?${qs.toString()}`));
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
  // Notify the parent on every user-initiated mode flip so it can
  // persist the preference. We compare against `prevMode` so the initial
  // assignment doesn't fire a callback before any interaction (the
  // parent already knows the initial value — it set it).
  let prevMode: "read" | "terminal" = initialMode;
  $: if (mode !== prevMode) {
    prevMode = mode;
    onModeChange(mode);
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
        await fetch(apiUrl(`/api/terminals/${encodeURIComponent(terminalId)}`, daemonId), {
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
    const sid = session?.sessionId;
    const cwd = session?.cwd;
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
    const sid = session?.sessionId;
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
        disabled: !(session && session.messages.length > 0 && sessionFileSource),
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
    return [...base, ...extraMenuItems];
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
    if (!shouldPollTranscript) return;
    if (loading) return;
    if (ollamaStreamingIdx !== null) return;
    loading = true;
    error = "";
    try {
      const qs = new URLSearchParams({ source });
      const headers: Record<string, string> = {};
      if (lastEtag) headers["If-None-Match"] = lastEtag;
      const res = await fetch(apiUrl(`/api/session?${qs.toString()}`, daemonId), { headers });
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
      await fetch(apiUrl(`/api/active-sends/${encodeURIComponent(id)}`, daemonId), {
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
  let codexEvents: EventSource | null = null;
  let codexEventsThreadId: string | null = null;
  let codexActiveTurnId: string | null = null;
  let codexRequests: CodexAppEvent[] = [];
  let codexRequestDrafts: Record<string, Record<string, string>> = {};
  let codexModels: CodexModelInfo[] = [];
  let codexModelsKey = "";
  let codexModelsLoading = false;
  let codexModelsError = "";
  const CODEX_SETTINGS_KEY = "supergit:codexApp:turnSettings";
  const codexSavedSettings = readCodexSettings();
  let codexModel = codexSavedSettings.model ?? "";
  let codexSandbox = codexSavedSettings.sandbox ?? "workspaceWrite";
  let codexApproval = codexSavedSettings.approval ?? "on-request";
  let codexEffort = codexSavedSettings.effort ?? "";
  let codexSummary = codexSavedSettings.summary ?? "auto";
  const codexSeenEvents = new Set<string>();

  $: liveCodexApp = agent === "codex" && isLiveCodexAppSource(source);
  $: sessionFileSource = liveCodexApp ? (transcriptSource ?? "") : source;
  $: shouldPollTranscript = shouldPollSessionSource({ agent, source });

  let reportedWorking: boolean | undefined;
  let reportedAwaiting: boolean | undefined;
  $: {
    const nextWorking =
      mode === "terminal"
        ? working
        : liveCodexApp
          ? sending || !!codexActiveTurnId
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
  $: codexModelGroup = codexSettings.find((g) => g.key === "codex-model");
  $: codexEffortGroup = codexSettings.find((g) => g.key === "codex-effort");
  $: codexAccessGroup = {
    key: "codex-access",
    label: "Permissions",
    options: codexAccessOptions({
      currentSandbox: codexSandbox,
      currentApproval: codexApproval,
    }),
    onPick: pickCodexAccess,
  } satisfies AgentSettingGroup;

  function pickCodexAccess(value: string): void {
    const parsed = parseCodexAccessValue(value);
    if (!parsed) return;
    codexSandbox = parsed.sandbox;
    codexApproval = parsed.approval;
    persistCodexSettings();
  }

  function selectedSettingValue(group: AgentSettingGroup | undefined): string {
    return group?.options.find((o) => o.selected)?.value ?? "";
  }

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

  function openCodexEventStream(threadId: string): void {
    if (codexEvents && codexEventsThreadId === threadId) return;
    closeCodexEventStream();
    codexEventsThreadId = threadId;
    const qs = new URLSearchParams({ threadId });
    const es = new EventSource(
      apiUrl(`/api/codex-app/events?${qs.toString()}`, daemonId),
    );
    es.addEventListener("codex", (msg) => {
      try {
        applyCodexEvent(JSON.parse((msg as MessageEvent).data) as CodexAppEvent);
      } catch {
        // Ignore malformed frames; the daemon stream stays alive.
      }
    });
    es.onerror = () => {
      if (sending && agent === "codex") {
        sendError = "Codex event stream disconnected; reconnecting…";
      }
    };
    codexEvents = es;
  }

  function closeCodexEventStream(): void {
    codexEvents?.close();
    codexEvents = null;
    codexEventsThreadId = null;
  }

  function applyCodexEvent(event: CodexAppEvent): void {
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
    if (event.method === "turn/completed") {
      codexActiveTurnId = null;
      sending = false;
      awaitingInput = codexRequests.length > 0;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      void load();
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
    }
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

  function optimisticCodexUser(text: string): void {
    if (!session) return;
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          role: "user",
          timestamp: new Date().toISOString(),
          blocks: [{ type: "text", text }],
        },
      ],
    };
  }

  function codexInputFromText(text: string): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [
      { type: "text", text, text_elements: [] },
    ];
    const imageRe =
      /\[Image:\s*source:\s*([^\]]+?\.(?:png|jpe?g|gif|webp|bmp))\s*\]/gi;
    let match: RegExpExecArray | null;
    while ((match = imageRe.exec(text)) !== null) {
      input.push({ type: "localImage", path: match[1]!.trim() });
    }
    return input;
  }

  async function sendCodexMessage(): Promise<void> {
    const text = inputText.trim();
    if (!text || !session?.sessionId || !session.cwd) return;
    sending = true;
    sendError = "";
    optimisticCodexUser(text);
    inputText = "";
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (sending && agent === "codex") {
        sendError = "Codex is still running; use Stop if you need to interrupt.";
      }
    }, 90_000);
    try {
      const res = await fetch(apiUrl("/api/codex-app/turns", daemonId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: session.sessionId,
          cwd: session.cwd,
          text,
          input: codexInputFromText(text),
          steer: !!codexActiveTurnId,
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
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
      sending = false;
      codexActiveTurnId = null;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }
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
    if (req.method === "execCommandApproval" || req.method === "applyPatchApproval") {
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
    if (req.method === "execCommandApproval" || req.method === "applyPatchApproval") {
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
        sendError =
          `${agentDisplayName()} didn't respond in 90s — try again or check agent logs`;
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
    mode === "read" && (agent === "ollama" || agent === "codex");

  $: composerPlaceholder =
    agent === "codex"
      ? "Message Codex…"
      : `Message ${model || "Ollama"}…`;

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

  $: if (source && shouldPollTranscript) {
    void load();
  }

  $: {
    const threadId =
      agent === "codex" && mode === "read" ? session?.sessionId : undefined;
    if (threadId) openCodexEventStream(threadId);
    else closeCodexEventStream();
  }

  $: if (agent === "codex" && session?.cwd) {
    void loadCodexModels(session.cwd);
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
        source,
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
  class:awaiting-input={mode === "terminal" && awaitingInput}
  class:read-mode={mode === "read"}
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
      canResume={!!onCustomResume ||
        (!!session?.sessionId && (agent === "claude" || agent === "codex"))}
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
      lastUserMessage={lastUserMessageWithContext}
      {pollCount}
      {lastLoadedAt}
      {inflight}
      {menuItems}
      titleTooltipExtra={summarySnippet || undefined}
      {starred}
      {onToggleStar}
      onTitleSaved={(next) => onManualTitleSaved(next)}
      onResume={() => {
        if (onCustomResume) onCustomResume();
        else mode = "terminal";
      }}
      onViewModeChange={(nextMode) => {
        mode = nextMode;
      }}
      onEndSession={disposeTerminal}
      onCancelInflight={cancelAllInflight}
      {onClose}
      {onDragStart}
      resumeTitle={agent === "codex"
        ? "Spawn a live `codex resume <id>` PTY in this session's cwd"
        : "Spawn a live `claude --resume <id>` PTY in this session's cwd"}
    />
    {#if mode === "terminal" && (session && session.messages.length > 0 || (lastUserMessage && lastUserMessage.trim().length > 0))}
      <div class="pinned-last-msg-wrap tui-overlay-stack" class:revealed={pinnedRevealed}>
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
                >Summarize</button>
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
      <div class="pinned-last-msg-wrap tui-overlay-stack" class:revealed={pinnedRevealed}>
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
              >Summarize</button>
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
            // Model/effort overrides picked from the header menu. Switching
            // mid-thread is the "restart via resume" UX: the column remounts
            // (see App's {#key}) so this PTY respawns with the new flag.
            ...(claudeModel ? ["--model", claudeModel] : []),
            ...(claudeEffort ? ["--effort", claudeEffort] : []),
          ]}
      cwd={session.cwd}
      ownerId={session.sessionId}
      {agent}
      sessionSource={source}
      {attachTermId}
      procName={`supergit-tui-${session.sessionId.slice(0, 8)}-${agent}`}
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
  {:else if session && session.messages.length === 0}
    <p class="muted small">{liveCodexApp ? "No messages yet." : "No messages parsed from this session."}</p>
  {:else if session}
    <ul
      class="messages"
      bind:this={messagesEl}
      on:mouseenter={onMessagesEnter}
      on:mouseleave={onMessagesLeave}
      on:wheel={onMessagesWheel}
    >
      {#each session.messages as m, i}
        <li class="msg role-{m.role}">
          <div class="msg-head">
            <span
              class="role"
              class:assistant={m.role === "assistant"}
              class:brand-claude={m.role === "assistant" && agent === "claude"}
              class:brand-codex={m.role === "assistant" && agent === "codex"}
              class:brand-ollama={m.role === "assistant" && agent === "ollama"}
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
          {#each m.blocks as b}
            {#if b.type === "text"}
              {#if i === ollamaStreamingIdx && !(b.text ?? "").length}
                <!-- Streaming bubble with no chunks yet — Ollama is
                     still loading the model / generating its first
                     token. Show a spinner inside the bubble so the
                     user knows the request is alive, not stuck. -->
                <div class="block text md ollama-waiting">
                  <LoadingSpinner size="0.9rem" label="Waiting for response" />
                </div>
              {:else}
                <div class="block text md">{@html md(b.text)}</div>
              {/if}
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
                  <code class="tool-result-preview" title={b.text ?? ""}
                    >{toolResultPreview(b.text ?? "")}</code
                  >
                  <button
                    type="button"
                    class="copy-btn"
                    on:click={() => void copyToClipboard(b.text ?? "")}
                    title="Copy full tool result"
                    aria-label="Copy">Copy</button
                  >
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

  {#if showChatComposer}
    <!-- API-driven chat composer. Ollama streams through /api/ollama/chat;
         Codex App streams through its app-server event channel. -->
    <div class="composer">
      {#if agent === "codex" && codexRequests.length}
        <div class="codex-requests">
          {#each codexRequests as req (req.id)}
            <div class="codex-request">
              <div class="codex-request-main">
                <span class="codex-request-title">{codexRequestTitle(req)}</span>
                <code class="codex-request-preview" title={codexRequestPreview(req)}
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
                                (e.currentTarget as HTMLSelectElement).value,
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
      <div class="composer-box">
        <textarea
          class="composer-input"
          bind:value={inputText}
          placeholder={composerPlaceholder}
          rows="2"
          on:keydown={onComposerKey}
          disabled={sending && agent !== "codex" && !ollamaAbort}
        ></textarea>
      </div>
      <div class="composer-footer">
        {#if agent === "codex"}
          <div class="composer-footer-left">
            <label class="composer-select-wrap composer-access">
              <span>{codexAccessGroup.label}</span>
              <select
                value={selectedSettingValue(codexAccessGroup)}
                on:change={(e) =>
                  codexAccessGroup.onPick(
                    (e.currentTarget as HTMLSelectElement).value,
                  )}
              >
                {#each codexAccessGroup.options as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </label>
          </div>
          <div class="composer-footer-right">
            {#if codexEffortGroup}
              <label class="composer-select-wrap composer-reasoning">
                <span>{codexEffortGroup.label}</span>
                <select
                  value={selectedSettingValue(codexEffortGroup)}
                  on:change={(e) =>
                    codexEffortGroup?.onPick(
                      (e.currentTarget as HTMLSelectElement).value,
                    )}
                >
                  {#each codexEffortGroup.options as opt (opt.value)}
                    <option value={opt.value}>{opt.label}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#if codexModelGroup}
              <label class="composer-select-wrap composer-model">
                <span>{codexModelGroup.label}</span>
                <select
                  value={selectedSettingValue(codexModelGroup)}
                  on:change={(e) =>
                    codexModelGroup?.onPick(
                      (e.currentTarget as HTMLSelectElement).value,
                    )}
                  title={codexModelsError || undefined}
                >
                  {#each codexModelGroup.options as opt (opt.value)}
                    <option value={opt.value} title={opt.title}>{opt.label}</option>
                  {/each}
                </select>
              </label>
            {/if}
          </div>
        {:else}
          <span></span>
        {/if}
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
          {:else if sending && agent === "codex"}
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
              disabled={!inputText.trim() || (sending && agent !== "codex")}
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
      {#if sendError}
        <div class="composer-error" title={sendError}>{sendError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .session {
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
       its own spacing from the row above, and a margin combined with
       height:100% would push the bottom border under the strip's
       overflow-y:hidden and clip it. */
    height: 100%;
    min-height: 12rem;
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
    border-radius: 0;
    border: 0;
    background: var(--surface-1);
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
  /* Composer pinned at the bottom of the session column. Borrowed from
     the same surface tokens as the header for visual consistency. */
  .composer {
    border-top: 1px solid var(--surface-3);
    background: var(--surface-2);
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .codex-requests {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 0.45rem;
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
    resize: none;
    min-height: 2.5rem;
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.6rem;
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
    color: var(--error-text);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: end;
    gap: 0.45rem;
    min-width: 0;
  }
  .composer-footer-left,
  .composer-footer-right {
    display: flex;
    align-items: end;
    gap: 0.35rem;
    min-width: 0;
  }
  .composer-footer-right {
    justify-content: flex-end;
  }
  .composer-select-wrap {
    display: inline-grid;
    gap: 0.12rem;
    min-width: 0;
    color: var(--text-muted);
    font-size: 0.64rem;
    line-height: 1.1;
  }
  .composer-select-wrap span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-select-wrap select {
    height: 1.75rem;
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-1);
    font: inherit;
    font-size: 0.74rem;
    line-height: 1;
    padding: 0 1.45rem 0 0.45rem;
  }
  .composer-select-wrap select:focus {
    outline: none;
    border-color: var(--text-faint);
  }
  .composer-access {
    width: min(13.5rem, 100%);
  }
  .composer-reasoning {
    width: 7.5rem;
  }
  .composer-model {
    width: min(13rem, 38vw);
  }
  .composer-send-wrap {
    display: flex;
    align-items: end;
    justify-content: flex-end;
  }
  .composer-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 1.75rem;
    background: var(--text-1);
    color: var(--surface-0);
    border: 1px solid var(--text-1);
    border-radius: var(--radius-sm);
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
    .composer-footer {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .composer-footer-right {
      grid-column: 1 / -1;
      grid-row: 2;
      justify-content: stretch;
    }
    .composer-footer-right .composer-select-wrap {
      flex: 1 1 0;
      width: auto;
    }
    .composer-send-wrap {
      grid-column: 2;
      grid-row: 1;
    }
    .composer-model {
      max-width: none;
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
    max-height: 50vh;
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
  .role.brand-ollama {
    color: var(--chip-ollama-text);
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
