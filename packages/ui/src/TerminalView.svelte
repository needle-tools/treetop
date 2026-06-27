<script lang="ts">
  import { apiUrl, apiWsUrl } from "./api";
  import { onMount, onDestroy } from "svelte";
  import { fetchSshSessions, type SshSessionInfo } from "./file-browser-utils";
  import {
    Terminal,
    type IBufferCell,
    type IDisposable,
    type IMarker,
  } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { webglPool, type WebglHandle } from "./terminal-webgl";
  import "@xterm/xterm/css/xterm.css";
  import LoadingOverlay from "./LoadingOverlay.svelte";
  import { shrinkImageBlob } from "./image-shrink";
  import {
    resolveImagePasteBehavior,
    shouldThrottlePaste,
    chunkPasteBody,
    PASTE_CHUNK_DELAY_MS,
  } from "./terminal-image-paste";
  import { writeClipboard } from "./clipboard-write";
  import {
    isTerminalMouseReport,
    joinSelectionRows,
    type SelectionRow,
  } from "./clean-selection";
  import {
    TerminalIoByteAccounting,
    TerminalRepaintTracker,
    TerminalWriteBuffer,
    splitTerminalWrite,
    setTerminalIoStats,
    removeTerminalIoStats,
    type TerminalRepaintCell,
    type TerminalRepaintCellSnapshot,
  } from "./terminal-write-buffer";
  import {
    createResizeCoalescer,
    type ResizeCoalescer,
  } from "./terminal-resize";
  import { openUrl } from "./open-url";
  import {
    expandNoteBodyForTerminalPasteChunks,
    extractNoteClipboardPayloadFromHtml,
    fetchTextAttachment,
    STAGE_PROMPT_EVENT,
  } from "./note-inline-attachments";
  import {
    startConfigAction,
    settleConfigAction,
    configButtonView,
    type ConfigActionKind,
    type ConfigActionState,
  } from "./config-error-action";
  import {
    describeWsClose,
    recordBrowserDiagnostic,
    terminalWsCloseRepresentsExit,
  } from "./errors";
  import { settingValue, getSetting, setSetting } from "./settings-registry";
  import { msSinceScroll, SCROLL_QUIET_MS } from "./scroll-activity";

  type PasteDebugExtra = Record<string, string | number | boolean | null>;

  const REPAINT_DEBUG_MAX_CELLS = 120;
  const REPAINT_DEBUG_TTL_MS = 520;
  const REPAINT_DEBUG_BACKGROUND = "#7ee787";
  const REPAINT_DEBUG_FOREGROUND = "#07130a";
  const TERMINAL_THEME_BACKGROUND = "#1a1a1b";
  const TERMINAL_THEME_FOREGROUND = "#e8e8e8";
  const TERMINAL_WRITE_CHUNK_BYTES = 64 * 1024;
  const TERMINAL_WRITE_BUDGET_MS = 4;

  /** Read the current selection and collapse soft-wrap newlines so a
   *  command that wrapped across visual rows pastes as one runnable line.
   *  We rebuild the text from the buffer (one row per buffer line, never
   *  pre-collapsed) rather than post-processing `getSelection()`, whose
   *  output xterm has already half-collapsed on Unix and not at all on a
   *  Windows ConPTY (which never sets `isWrapped`). See clean-selection.ts. */
  function getCleanedSelection(term: Terminal): string {
    const raw = term.getSelection();
    if (!raw) return "";
    const sel = term.getSelectionPosition();
    if (!sel) return raw;
    const buf = term.buffer.active;
    const cols = term.cols;
    const rows: SelectionRow[] = [];
    for (let y = sel.start.y; y <= sel.end.y; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const startCol = y === sel.start.y ? sel.start.x : 0;
      const endCol = y === sel.end.y ? sel.end.x : undefined;
      // Last column non-whitespace = the row reached the edge → ConPTY
      // wrap signature (only consulted as a fallback in joinSelectionRows).
      const lastCell = line.getCell(cols - 1);
      const lastChars = lastCell?.getChars() ?? "";
      rows.push({
        text: line.translateToString(true, startCol, endCol),
        isWrapped: line.isWrapped,
        fillsWidth: lastChars !== "" && lastChars !== " ",
      });
    }
    return joinSelectionRows(rows) || raw;
  }

  /** Robust clipboard-write. The async Clipboard API is the modern path
   *  but it gets silently rejected in WebView2 / strict-Permissions
   *  contexts even when the keydown is a trusted user gesture — observed
   *  in the electrobun native app on Windows where Ctrl+C-with-selection
   *  felt like it "did nothing." The legacy `execCommand("copy")` via a
   *  transient offscreen textarea is the route the WebView actually
   *  honors, but `execCommand` only works synchronously inside the
   *  gesture call stack — so it must be tried FIRST, not deferred to the
   *  async write's `.catch` (which runs after the gesture has unwound and
   *  is denied too). The sync-first ordering and fallback decision live in
   *  `writeClipboard` so they can be unit-tested; see clipboard-write.ts. */
  function copyToClipboard(text: string): void {
    const writeText = navigator.clipboard?.writeText;
    writeClipboard(text, {
      syncCopy: (t) => {
        try {
          const ta = document.createElement("textarea");
          ta.value = t;
          ta.setAttribute("readonly", "");
          ta.style.cssText =
            "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
          document.body.appendChild(ta);
          const prev = document.activeElement as HTMLElement | null;
          ta.focus();
          ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          try {
            prev?.focus();
          } catch {
            /* best-effort restore */
          }
          return ok;
        } catch {
          return false;
        }
      },
      asyncWrite: writeText
        ? (t) => writeText.call(navigator.clipboard, t)
        : null,
      warn: (m) => console.warn(m),
    });
  }

  /** Command + args to spawn. e.g. ["claude", "--resume", "<sid>"]. */
  export let cmd: string[];
  /** Working directory for the PTY. */
  export let cwd: string;
  /** Optional tag (we pass the sessionId so /api/terminals?ownerId=sid
   *  later lets us reconnect). */
  export let ownerId: string | undefined = undefined;
  /** Optional argv[0] override the daemon applies via `exec -a` so this
   *  PTY is findable in Activity Monitor / htop / ps as e.g.
   *  "supergit-tui-abc12345-claude". */
  export let procName: string | undefined = undefined;
  /** Called when the underlying PTY exits. Parent flips column back to
   *  the read-only view. */
  export let onExit: (info: {
    code: number;
    signal?: string;
  }) => void = () => {};
  /** Fires once the daemon hands us back the terminal id. Lets the parent
   *  drive dispose via DELETE /api/terminals/:id from its own header. */
  export let onSpawn: (id: string) => void = () => {};
  /** Fires whenever the daemon detects the PTY is paused waiting for
   *  user input (Claude permission prompts, Codex update notices, y/n
   *  shell confirms, …). Parent uses it to outline the column so the
   *  user notices the agent's blocked. */
  export let onAwaitingChange: (awaiting: boolean) => void = () => {};
  /** Fires when the PTY transitions between "currently emitting output"
   *  and "quiet". Driven locally off the WS binary frames — no daemon
   *  round-trip — so the header animation tracks the byte stream with
   *  no extra latency. Parent uses it to flip the agent pill between
   *  the working/idle border styles. */
  export let onWorkingChange: (working: boolean) => void = () => {};
  /** A PTY that hasn't emitted a byte in this many ms is treated as
   *  "idle" (waiting for input or done with the current turn). Short
   *  enough that "done" feels responsive, long enough that a typical
   *  Claude/Codex pause for a tool call doesn't flicker the border. */
  const WORKING_IDLE_MS = 1500;
  /** Treat nearby off-screen terminal columns as visible so output keeps
   *  flowing before the user scrolls them into view. Far-off-screen noisy
   *  columns are the ones we pause to protect paste and app actions. */
  const OUTPUT_VISIBILITY_ROOT_MARGIN = "600px 1600px 600px 1600px";
  /** When set, skip spawning a new PTY and attach to this existing one
   *  via WS. Used to reattach to live shells after a page reload (the
   *  daemon's GET /api/shells returns the live termIds + their worktrees).
   *  `cmd` and `cwd` are ignored when this is set. */
  export let attachTermId: string | undefined = undefined;
  /** When this PTY is a Resume of a past shell, the prior termId. Sent
   *  to the daemon so the new shell's JSONL is pre-seeded with the
   *  prior cmd history (visible in ShellView next time the column is
   *  closed and reopened in read mode). */
  export let resumeFromTermId: string | undefined = undefined;
  /** Open-session source for drag-staging note text into this TUI. */
  export let sessionSource: string | undefined = undefined;
  /** @deprecated — kept as a no-op prop so existing callers don't
   *  break. Context injection now goes through the cmd array
   *  (--append-system-prompt-file for Claude, positional prompt for
   *  Codex). */
  export let initialPrompt: string | undefined = undefined;
  /** Command to prefill at the shell prompt (written to PTY without Enter). */
  export let prefillCmd: string | undefined = undefined;
  /** Fires when an SSH session is detected (or lost) for this terminal.
   *  Parent can use this to open a remote file browser panel. */
  export let onSshChange: ((ssh: SshSessionInfo | null) => void) | undefined =
    undefined;
  /** When set, terminal spawn and io WS are routed to this remote daemon
   *  instead of the local one. Undefined keeps local behavior unchanged. */
  export let daemonId: string | undefined = undefined;
  /** The session's agent kind ("claude" | "codex" | "copilot" | "ollama" |
   *  "shell"). Authoritative — set when the column is created, not parsed
   *  from `cmd`. Drives the "auto" image-paste behavior: codex reads image
   *  bytes off the OS clipboard on a paste keystroke, so it gets "direct";
   *  everything else gets the save-and-insert-path "attachment" flow. */
  export let agent: string | undefined = undefined;

  let containerEl: HTMLDivElement | null = null;
  let xterm: Terminal | null = null;
  let sshSession: SshSessionInfo | null = null;
  let sshPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastParsedCwd = "";
  let cwdParseBuffer = "";
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  const showTerminalIoDebug = settingValue("terminal.showIoDebug");
  const flashTermRepaints = settingValue("terminal.flashRepaints");
  const scaleTermRepaints = settingValue("terminal.scaleRepaints");
  let repaintFlashEnabled = false;
  let repaintScaleEnabled = false;
  let hoveredTerminalLink = false;
  $: repaintFlashEnabled =
    $showTerminalIoDebug === true && $flashTermRepaints === true;
  $: repaintScaleEnabled =
    $showTerminalIoDebug === true && $scaleTermRepaints === true;
  const fallbackIoStatsId = `terminal-view-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  let currentIoStatsId = fallbackIoStatsId;
  $: {
    const nextIoStatsId = sessionSource ?? fallbackIoStatsId;
    if (nextIoStatsId !== currentIoStatsId) {
      removeTerminalIoStats(currentIoStatsId);
      currentIoStatsId = nextIoStatsId;
      publishTerminalIoStats();
    }
  }
  const ioAccounting = new TerminalIoByteAccounting();
  let ioTicker: ReturnType<typeof setInterval> | null = null;
  let rxWindowBytes = 0;
  let txWindowBytes = 0;
  let rxBytesPerSec = 0;
  let txBytesPerSec = 0;
  let rxBytesTotal = 0;
  let txBytesTotal = 0;
  let lastIoActivityAt: number | null = null;

  function noteIoActivity(bytes: number): void {
    if (bytes <= 0) return;
    lastIoActivityAt = Date.now();
  }

  function recordRx(bytes: number): void {
    noteIoActivity(bytes);
    rxWindowBytes += bytes;
    rxBytesTotal += bytes;
  }

  function recordHiddenRx(bytes: number): void {
    const observed = ioAccounting.observeHiddenBytes(bytes);
    if (observed > 0) recordRx(observed);
  }

  function recordTx(bytes: number): void {
    noteIoActivity(bytes);
    txWindowBytes += bytes;
    txBytesTotal += bytes;
  }

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return String(bytes);
  }

  function makePasteDebugId(): string {
    return `p_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function roundMs(ms: number): number {
    return Math.round(ms);
  }

  function clipboardTypesLabel(types: string[]): string {
    return types.slice(0, 16).join(",");
  }

  function writeDebugToggle(key: string, checked: boolean): void {
    setSetting(key, checked);
  }

  function sendTerminalInput(data: Uint8Array | string): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
    recordTx(bytes.byteLength);
    ws.send(bytes);
    return true;
  }

  function sendPasteDebug(
    id: string,
    phase: string,
    extra: PasteDebugExtra = {},
  ): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(
        JSON.stringify({
          type: "paste-debug",
          id,
          phase,
          termId: terminalId || null,
          ...extra,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function shouldUseNativeImagePaste(): boolean {
    const behavior = getSetting("terminal.imagePasteBehavior");
    return (
      resolveImagePasteBehavior(
        typeof behavior === "string" ? behavior : undefined,
        agent,
      ) === "direct"
    );
  }

  function sendNativeImagePaste(
    source: string,
    extra: PasteDebugExtra = {},
  ): void {
    const pasteDebugId = makePasteDebugId();
    const sent = sendTerminalInput(new Uint8Array([0x16]));
    sendPasteDebug(
      pasteDebugId,
      sent ? "native-paste-sent" : "native-paste-closed",
      {
        mode: "direct",
        source,
        ...extra,
      },
    );
    if (!sent) {
      console.warn(
        "supergit: native image paste ignored; websocket is not open",
      );
    }
  }

  // Windows cmd:  needle@HOST C:\Users\needle\Music>
  //          or:  C:\Users\needle\Music>
  // PowerShell:   PS C:\Users\needle>
  // Unix bash:    user@host:/path$  or  user@host:~/path$
  const WIN_PROMPT_RE = /(?:^|\n)(?:.*\s)?(?:PS )?([A-Za-z]:\\[^\r\n>]*?)>\s*$/;
  const UNIX_PROMPT_RE = /(?:^|\n)\S+?:([/~][^\r\n$#]*?)[#$%]\s*$/;

  function extractCwdFromOutput(chunk: string): void {
    if (!sshSession) return;
    cwdParseBuffer = (cwdParseBuffer + chunk).slice(-1024);
    const stripped = cwdParseBuffer
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
    const winMatch = stripped.match(WIN_PROMPT_RE);
    const unixMatch = stripped.match(UNIX_PROMPT_RE);
    const raw = winMatch?.[1] ?? unixMatch?.[1];
    if (!raw) return;
    let cwd = raw.replace(/\\/g, "/");
    // SFTP doesn't resolve ~; leave it for the UI to handle via the
    // home dir it already fetched. Mark with a prefix so the consumer
    // knows it's relative to home.
    if (cwd === "~") cwd = "~";
    else if (cwd.startsWith("~/")) cwd = "~/" + cwd.slice(2);
    if (cwd !== lastParsedCwd) {
      lastParsedCwd = cwd;
      onSshChange?.({ ...sshSession, cwd } as any);
    }
  }

  /** Settle-debounce for wheel hijacking — same idea as the chat
   *  scroll-island in SessionView. While the cursor hasn't been
   *  parked over the terminal for ≥ 300ms, we capture wheel events
   *  at the wrapper (before xterm's internal handler sees them) and
   *  forward the delta to the window so a page-scroll session
   *  continues even when the cursor drifts across the TUI. */
  const TUI_WHEEL_SETTLE_MS = 300;
  let tuiCursorSettled = false;
  let tuiSettleTimer: ReturnType<typeof setTimeout> | null = null;
  function onTuiWrapEnter(): void {
    tuiCursorSettled = false;
    if (tuiSettleTimer) clearTimeout(tuiSettleTimer);
    tuiSettleTimer = setTimeout(() => {
      tuiCursorSettled = true;
      tuiSettleTimer = null;
    }, TUI_WHEEL_SETTLE_MS);
  }
  function onTuiWrapLeave(): void {
    tuiCursorSettled = false;
    if (tuiSettleTimer) {
      clearTimeout(tuiSettleTimer);
      tuiSettleTimer = null;
    }
  }
  /** Capture-phase wheel handler on `.terminal-wrap`. Capture fires
   *  before xterm's listener on its internal viewport. We do three
   *  things here, in order:
   *
   *   1. Horizontal-dominant wheel (trackpad swipe across the
   *      sessions strip): always stopPropagation so xterm doesn't
   *      preventDefault it and kill the strip's pan, but do NOT
   *      preventDefault — the browser then handles the default
   *      scroll on the strip's overflow-x: auto container. Skipping
   *      stopPropagation here was breaking horizontal scroll because
   *      xterm grabs every wheel and preventDefault's it internally.
   *
   *   2. If the cursor hasn't settled yet (< 300ms parked in the
   *      TUI), treat the wheel as part of a page-scroll session:
   *      preventDefault, stopPropagation, forward vertical delta to
   *      the window.
   *
   *   3. Otherwise the user is intentionally in the TUI — let xterm
   *      handle the scroll natively. */
  function onTuiWrapWheel(ev: WheelEvent): void {
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      ev.stopPropagation();
      return;
    }
    if (tuiCursorSettled) return;
    ev.preventDefault();
    ev.stopPropagation();
    window.scrollBy({ top: ev.deltaY, behavior: "auto" });
  }
  let fit: FitAddon | null = null;
  let ws: WebSocket | null = null;
  let resizeObs: ResizeObserver | null = null;
  let onWindowResize: (() => void) | null = null;
  let onDocVisibility: (() => void) | null = null;
  let resizeCoalescer: ResizeCoalescer | null = null;
  // Wait this long after the last resize trigger before refitting the PTY.
  // Long enough to outlast a zen/fullscreen animation's per-frame resize
  // burst (so we refit once, at the settled size) without feeling laggy on
  // a deliberate pane-divider drag. See terminal-resize.ts.
  const RESIZE_SETTLE_MS = 120;
  // Off-screen render skip: while this terminal's column isn't visible we
  // buffer raw PTY bytes instead of calling xterm.write() (which parses
  // ANSI + mutates the DOM every chunk), then flush once on reveal. The
  // WS stays open and noteActivity() still fires, so the dock activity
  // pulse and working-ring keep reflecting the agent — we only skip the
  // paint nobody can see. If the hidden buffer reaches its cap we flush the
  // complete backlog to xterm to preserve bytes; daemon-side visibility
  // pausing should make that rare for distant columns. Starts true so output
  // is never withheld before the observer's first callback.
  let isTerminalVisible = true;
  let visibilityObs: IntersectionObserver | null = null;
  // WebGL renderer slot (terminal-webgl.ts). Owned by the visibility
  // observer: on-screen columns hold one of the pooled contexts (typing
  // re-rasters a canvas — no DOM churn, no per-keystroke Layerize),
  // off-screen columns give theirs back. Null/inactive = DOM renderer.
  let webgl: WebglHandle | null = null;
  const repaintTracker = new TerminalRepaintTracker();
  let repaintRenderDisposable: IDisposable | null = null;
  let repaintCellProbe: IBufferCell | null = null;
  let repaintDecorations: IMarker[] = [];
  let repaintClearTimer: ReturnType<typeof setTimeout> | null = null;
  let repaintDebugWasEnabled = false;
  function attachWebgl() {
    if (webgl?.active || !xterm) return;
    webgl = webglPool.tryAttach(xterm);
  }
  function detachWebgl() {
    webgl?.dispose();
    webgl = null;
  }
  // Revealing/hiding a terminal column triggers EXPENSIVE layout work: a WebGL
  // renderer switch (attach/detach re-measures + re-renders every row), and on
  // reveal a refit whose size-check reads `offsetWidth` — a forced synchronous
  // reflow — even when the size is unchanged and the fit no-ops. Doing this per
  // column-crossing during a scroll is a reflow/renderRows storm, so we defer
  // the layout reconcile until the page has been scroll-quiet for
  // SCROLL_QUIET_MS. Output paint is deliberately not part of this gate: once a
  // terminal is visible, buffered bytes must reach xterm immediately instead of
  // waiting for the page to become "idle."
  let revealReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let revealReconcileTarget = false;
  function scheduleRevealReconcile(visible: boolean) {
    revealReconcileTarget = visible;
    if (revealReconcileTimer) clearTimeout(revealReconcileTimer);
    const reconcile = () => {
      revealReconcileTimer = null;
      if (!revealReconcileTarget) {
        detachWebgl();
        return;
      }
      attachWebgl();
      if (xterm) {
        // Size may have changed while we weren't laying out; coalesce the
        // refit so a reveal that coincides with a resize doesn't double-fit.
        resizeCoalescer?.trigger();
      }
    };
    const tick = () => {
      const wait = SCROLL_QUIET_MS - msSinceScroll();
      if (wait > 0) {
        // Still scrolling — re-check after the remaining quiet window.
        revealReconcileTimer = setTimeout(tick, wait + 20);
        return;
      }
      reconcile();
    };
    if (msSinceScroll() >= SCROLL_QUIET_MS) reconcile();
    else
      revealReconcileTimer = setTimeout(
        tick,
        SCROLL_QUIET_MS - msSinceScroll() + 20,
      );
  }
  const writeBuffer = new TerminalWriteBuffer();
  let visibleWriteQueue: Uint8Array[] = [];
  let visibleWriteRaf: number | null = null;
  let hiddenFlushes = 0;
  let terminalId = "";
  let phase: "starting" | "live" | "exited" | "error" = "starting";
  let error = "";
  const startupTraceId = `term_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const startupStartedAt = performance.now();
  let startupLastLogAt = startupStartedAt;
  let firstControlFrameLogged = false;
  let firstOutputFrameLogged = false;
  let startupLastFlushedCount = 0;
  let startupEvents: Array<{
    event: string;
    elapsedMs: number;
    sincePrevMs: number;
    extra: Record<string, unknown>;
  }> = [];
  /** Set when the WS fires `onerror` (which carries no detail). Lets the
   *  `onclose` that always follows compose the real message from the close
   *  code + reason instead of a bare "WebSocket error". */
  let wsErrored = false;
  let configError: { file: string } | null = null;
  /** In-flight / settled state for the config-error pill's action so the
   *  pill stays visible with a spinner + confirmation instead of just
   *  vanishing on click. Reset whenever the underlying error clears. */
  let configAction: ConfigActionState | null = null;
  let exitInfo: { code: number; signal?: string } | null = null;
  let sawExitFrame = false;
  let focused = false;
  /** When the column is asked to RE-ATTACH to a pre-existing PTY
   *  (`attachTermId`) but that PTY is gone — most often because the daemon
   *  restarted, so every prior terminal id is dead and the WS upgrade 404s
   *  before we ever go live — fall back to a fresh spawn exactly once
   *  instead of dead-ending on "terminal not found". `attachedThisAttempt`
   *  records that the current attempt skipped the spawn POST;
   *  `triedAttachFallback` makes the fallback one-shot. */
  let attachedThisAttempt = false;
  let triedAttachFallback = false;

  // Working-state plumbing. `lastActivityTs` is a plain mutable held
  // outside Svelte's reactive graph (never referenced from the
  // template / `$:`) so the per-frame writes don't trigger a re-render
  // — only the transitions emitted via onWorkingChange touch the
  // parent's reactive state.
  let lastActivityTs = 0;
  let currentWorking = false;
  let workingTicker: ReturnType<typeof setInterval> | null = null;
  /** Many TUIs (Claude, Codex) opt into focus-reporting (xterm sends
   *  `\e[I` / `\e[O` on focus/blur) and redraw their status bar in
   *  response — a short burst of PTY output that has nothing to do
   *  with the agent actually working. Suppress noteActivity for a
   *  brief window around focus transitions so a plain click on the
   *  terminal doesn't flip the idle ring to working. */
  let suppressActivityUntilTs = 0;
  const SUPPRESS_AROUND_FOCUS_MS = 500;
  function setCurrentWorking(next: boolean) {
    if (currentWorking === next) return;
    currentWorking = next;
    onWorkingChange(next);
  }
  function noteActivity() {
    if (Date.now() < suppressActivityUntilTs) return;
    lastActivityTs = Date.now();
    setCurrentWorking(true);
  }

  /** Drop a socket's event handlers before closing it deliberately. Otherwise
   *  the socket's onclose path can misreport a user/interface teardown as a
   *  terminal exit. (Param is `s`, not `ws`, on purpose: a source-scanning
   *  regression test keys off the first literal `ws.onopen` being the real
   *  open handler below.) */
  function detachSocket(s: WebSocket): void {
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
  }

  function sendVisibilityState(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // `visible` means "paint directly"; `drain` means "the browser is awake
    // enough to receive hidden bytes". Offscreen agent TUIs keep streaming to
    // the client buffer (so output is not stranded in the daemon), while a
    // backgrounded / occluded window still lets the daemon avoid flooding a
    // suspended WebKit socket.
    const visible = isTerminalVisible && !document.hidden;
    const drain = !document.hidden;
    ws.send(JSON.stringify({ type: "visibility", visible, drain }));
  }

  function logTerminalStartup(
    event: string,
    extra: Record<string, unknown> = {},
  ): void {
    const now = performance.now();
    const elapsedMs = roundMs(now - startupStartedAt);
    const sincePrevMs = roundMs(now - startupLastLogAt);
    startupLastLogAt = now;
    startupEvents = [
      ...startupEvents,
      { event, elapsedMs, sincePrevMs, extra },
    ].slice(-64);
  }

  function flushTerminalStartupLog(
    reason: string,
    extra: Record<string, unknown> = {},
  ): void {
    if (startupEvents.length === 0) return;
    const eventsSinceLastFlush = startupEvents.length - startupLastFlushedCount;
    startupLastFlushedCount = startupEvents.length;
    recordBrowserDiagnostic(`terminal-startup trace=${startupTraceId}`, {
      reason,
      traceId: startupTraceId,
      elapsedMs: roundMs(performance.now() - startupStartedAt),
      eventsSinceLastFlush,
      ownerId: ownerId ?? null,
      termId: terminalId || null,
      attachTermId: attachTermId ?? null,
      daemonId: daemonId ?? null,
      agent: agent ?? null,
      phase,
      attachedThisAttempt,
      triedAttachFallback,
      documentHidden: typeof document === "undefined" ? null : document.hidden,
      isTerminalVisible,
      containerWidth: containerEl?.clientWidth ?? null,
      containerHeight: containerEl?.clientHeight ?? null,
      xtermCols: xterm?.cols ?? null,
      xtermRows: xterm?.rows ?? null,
      wsReadyState: ws?.readyState ?? null,
      cmd0: cmd[0] ?? null,
      cmdLen: cmd.length,
      cwd,
      events: startupEvents,
      ...extra,
    });
  }

  function publishTerminalIoStats(): void {
    setTerminalIoStats(currentIoStatsId, {
      visible: isTerminalVisible,
      rxBytesPerSec,
      txBytesPerSec,
      rxBytesTotal,
      txBytesTotal,
      lastActivityAt: lastIoActivityAt,
      hiddenBufferedBytes: writeBuffer.pendingBytes,
      hiddenFlushes,
    });
  }

  function readRepaintCell(
    row: number,
    col: number,
  ): TerminalRepaintCellSnapshot | null {
    if (!xterm) return null;
    const buffer = xterm.buffer.active;
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) return null;
    repaintCellProbe ??= buffer.getNullCell();
    const cell = line.getCell(col, repaintCellProbe);
    if (!cell) return null;
    return {
      chars: cell.getChars(),
      width: cell.getWidth(),
      code: cell.getCode(),
      fgColorMode: cell.getFgColorMode(),
      bgColorMode: cell.getBgColorMode(),
      fgColor: cell.getFgColor(),
      bgColor: cell.getBgColor(),
      attrs:
        (cell.isBold() ? 1 : 0) |
        (cell.isItalic() ? 2 : 0) |
        (cell.isDim() ? 4 : 0) |
        (cell.isUnderline() ? 8 : 0) |
        (cell.isBlink() ? 16 : 0) |
        (cell.isInverse() ? 32 : 0) |
        (cell.isInvisible() ? 64 : 0) |
        (cell.isStrikethrough() ? 128 : 0) |
        (cell.isOverline() ? 256 : 0),
    };
  }

  function clearRepaintDecorations(): void {
    if (repaintClearTimer !== null) {
      clearTimeout(repaintClearTimer);
      repaintClearTimer = null;
    }
    for (const marker of repaintDecorations.splice(0)) {
      try {
        marker.dispose();
      } catch {
        // Stale debug paint must not interfere with the terminal lifecycle.
      }
    }
  }

  function drawRepaintDecorations(cells: TerminalRepaintCell[]): void {
    if (!xterm || cells.length === 0) return;
    clearRepaintDecorations();
    const buffer = xterm.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    for (const cell of cells) {
      const absoluteLine = buffer.viewportY + cell.row;
      const marker = xterm.registerMarker(absoluteLine - cursorLine);
      if (!marker) continue;
      const decoration = xterm.registerDecoration({
        marker,
        x: cell.col,
        width: cell.width,
        height: 1,
        layer: "top",
        ...(repaintFlashEnabled || repaintScaleEnabled
          ? {
              backgroundColor: repaintFlashEnabled
                ? REPAINT_DEBUG_BACKGROUND
                : TERMINAL_THEME_BACKGROUND,
              foregroundColor: repaintFlashEnabled
                ? REPAINT_DEBUG_FOREGROUND
                : TERMINAL_THEME_BACKGROUND,
            }
          : {}),
      });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      const classes = [
        "term-repaint-decoration",
        repaintFlashEnabled ? "flash" : "",
        repaintScaleEnabled ? "scale" : "",
      ].filter(Boolean);
      const chars = cell.chars || "\u00a0";
      decoration.onRender((element) => {
        element.classList.add(...classes);
        if (repaintScaleEnabled) {
          const glyph =
            element.firstElementChild instanceof HTMLSpanElement
              ? element.firstElementChild
              : document.createElement("span");
          glyph.className = "term-repaint-glyph";
          glyph.textContent = chars;
          element.replaceChildren(glyph);
        } else {
          element.replaceChildren();
        }
        if (repaintScaleEnabled && !repaintFlashEnabled) {
          element.style.color = TERMINAL_THEME_FOREGROUND;
          element.style.background = TERMINAL_THEME_BACKGROUND;
        } else {
          element.style.removeProperty("color");
          element.style.removeProperty("background");
        }
        element.setAttribute("aria-hidden", "true");
      });
      repaintDecorations.push(marker);
    }
    if (repaintDecorations.length > 0) {
      repaintClearTimer = setTimeout(
        clearRepaintDecorations,
        REPAINT_DEBUG_TTL_MS,
      );
    }
  }

  function handleTerminalRender(ev: { start: number; end: number }): void {
    const enabled = repaintFlashEnabled || repaintScaleEnabled;
    if (!enabled) {
      if (repaintDebugWasEnabled) {
        repaintTracker.reset();
        clearRepaintDecorations();
      }
      repaintDebugWasEnabled = false;
      return;
    }
    repaintDebugWasEnabled = true;
    if (!xterm) return;
    const cells = repaintTracker.captureRenderedRows({
      start: ev.start,
      end: ev.end,
      cols: xterm.cols,
      maxCells: REPAINT_DEBUG_MAX_CELLS,
      readCell: readRepaintCell,
    });
    drawRepaintDecorations(cells);
  }

  function flushBufferedTerminalOutput(): Uint8Array | null {
    const batch = writeBuffer.flush();
    if (batch) {
      hiddenFlushes += 1;
      publishTerminalIoStats();
    }
    return batch;
  }

  function scheduleVisibleTerminalWrites(): void {
    if (visibleWriteRaf !== null) return;
    visibleWriteRaf = requestAnimationFrame(() => {
      visibleWriteRaf = null;
      if (!xterm) {
        visibleWriteQueue = [];
        return;
      }
      const startedAt = performance.now();
      while (visibleWriteQueue.length > 0) {
        const chunk = visibleWriteQueue.shift()!;
        xterm.write(chunk);
        if (performance.now() - startedAt >= TERMINAL_WRITE_BUDGET_MS) break;
      }
      if (visibleWriteQueue.length > 0) scheduleVisibleTerminalWrites();
    });
  }

  function writeTerminalOutput(bytes: Uint8Array): void {
    if (!xterm) return;
    if (
      visibleWriteQueue.length === 0 &&
      bytes.byteLength <= TERMINAL_WRITE_CHUNK_BYTES
    ) {
      xterm.write(bytes);
      return;
    }
    visibleWriteQueue.push(
      ...splitTerminalWrite(bytes, TERMINAL_WRITE_CHUNK_BYTES),
    );
    scheduleVisibleTerminalWrites();
  }

  function paintBufferedTerminalOutput(): void {
    if (!xterm) return;
    const batch = flushBufferedTerminalOutput();
    if (batch) writeTerminalOutput(batch);
  }

  /** Retry after a failed spawn. Tears down whatever half-state the
   *  failed attempt left behind (ws, startup guard, error text) and
   *  re-enters the spawn flow from scratch. The xterm instance itself
   *  stays — it's just a renderer; clearing it gives the user a clean
   *  buffer rather than the previous attempt's garbage scrollback. */
  function retry() {
    if (phase !== "error") return;
    if (ws) {
      try {
        ws.close(1000, "retry");
      } catch {}
      ws = null;
    }
    error = "";
    wsErrored = false;
    exitInfo = null;
    terminalId = "";
    xterm?.clear();
    phase = "starting";
    void spawnPtyAndConnect();
  }

  async function spawnPtyAndConnect() {
    attachedThisAttempt = false;
    sawExitFrame = false;
    firstControlFrameLogged = false;
    firstOutputFrameLogged = false;
    logTerminalStartup("spawn-flow-start", {
      attachRequested: Boolean(attachTermId),
      resumeFromTermId: resumeFromTermId ?? null,
    });
    flushTerminalStartupLog("spawn-flow-start");
    try {
      let id: string;
      if (attachTermId && !triedAttachFallback) {
        // Reattach path — daemon already has this PTY alive (see GET
        // /api/shells). Skip the spawn POST and go straight to WS. If the
        // PTY is actually gone (e.g. the daemon restarted since this
        // attachTermId was persisted), the WS upgrade 404s and onclose
        // falls back to a fresh spawn below.
        attachedThisAttempt = true;
        id = attachTermId;
        logTerminalStartup("attach-existing-start", { attachTermId: id });
      } else {
        // xterm.cols/rows can be near-zero when the container hasn't
        // laid out yet (Svelte onMount races flex-parent settle). If we
        // POST cols: 2 the PTY spawns 2-wide and zsh wraps the prompt
        // onto itself — visible bug: "input clears the row" + dquote>.
        // Floor to 80x24; the rAF re-fit in ws.onopen will send the
        // real size before the user can type anything.
        const cols = Math.max(xterm?.cols ?? 80, 80);
        const rows = Math.max(xterm?.rows ?? 24, 24);
        const postStartedAt = performance.now();
        logTerminalStartup("post-start", { cols, rows });
        flushTerminalStartupLog("post-start");
        const res = await fetch(apiUrl("/api/terminals", daemonId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cmd,
            cwd,
            cols,
            rows,
            ownerId,
            procName,
            previousTermId: resumeFromTermId,
            prefillCmd,
          }),
        });
        const body = await res.json().catch(() => null);
        logTerminalStartup("post-response", {
          status: res.status,
          ok: res.ok,
          fetchMs: roundMs(performance.now() - postStartedAt),
        });
        flushTerminalStartupLog("post-response");
        if (!res.ok) {
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const spawned = body as { id: string; pid: number };
        id = spawned.id;
        logTerminalStartup("post-json", { id, pid: spawned.pid });
      }
      terminalId = id;
      onSpawn(id);
      startSshPolling(id);
      // Build WS URL relative to current origin so it works behind the
      // Vite proxy or directly against the daemon.
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = apiWsUrl(
        `/api/terminals/${encodeURIComponent(id)}/io`,
        location.host,
        proto,
        daemonId,
      );
      const wsCreatedAt = performance.now();
      logTerminalStartup("ws-create", {
        wsPath: `/api/terminals/${id}/io`,
      });
      flushTerminalStartupLog("ws-create");
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        phase = "live";
        logTerminalStartup("ws-open", {
          wsOpenMs: roundMs(performance.now() - wsCreatedAt),
        });
        flushTerminalStartupLog("ws-open");
        sendVisibilityState();
        // Resume + autofocus contract: when a Terminal column mounts
        // (either fresh or via Resume) we want two things, both keyed
        // off the WS opening:
        //
        //  1. Send a fresh resize. The spawn POST went out with whatever
        //     xterm.cols/rows were at onMount time — but on the second
        //     "Resume" specifically, the column re-mounts while neighbor
        //     columns are still in mid-layout, so fit.fit() inside
        //     onMount returns stale dimensions. zsh then renders its
        //     prompt at one width while xterm's viewport has another →
        //     classic "cursor on empty line below the prompt, only last
        //     letter visible" line-editor miscount. Re-fitting after
        //     layout has settled (rAF) and re-sending the size pins
        //     the two together before the user types.
        //
        //  2. Autofocus. Without this, a resumed column shows up but
        //     keystrokes go to the page chrome instead of the PTY,
        //     forcing a manual click. Brand-new columns happen to focus
        //     correctly via the user's "Add terminal" click chain, but
        //     resume has no click → we have to focus explicitly.
        requestAnimationFrame(() => {
          const rafStartedAt = performance.now();
          let fitAttempted = false;
          if (fit && xterm && containerEl && containerEl.clientWidth > 0) {
            try {
              fitAttempted = true;
              fit.fit();
            } catch {
              /* pre-layout race; ignore */
            }
            sendResize();
          }
          focusTerminal();
          logTerminalStartup("ws-open-raf", {
            rafMs: roundMs(performance.now() - rafStartedAt),
            fitAttempted,
          });
        });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          if (!firstControlFrameLogged) {
            firstControlFrameLogged = true;
            logTerminalStartup("first-control-frame", {
              bytes: ev.data.length,
            });
          }
          // Control frame from the daemon. Currently: exit, state, and hidden
          // IO byte observations while raw terminal output is buffered.
          try {
            const obj = JSON.parse(ev.data);
            if (obj?.type === "exit") {
              sawExitFrame = true;
              exitInfo = { code: obj.code, signal: obj.signal };
              phase = "exited";
              setCurrentWorking(false);
              onAwaitingChange(false);
              // The config dialog is gone once the PTY exits (the user
              // chose an option, or it's respawning with a fixed config) —
              // drop the pill so it doesn't linger on the exited view.
              configError = null;
              configAction = null;
              onExit(exitInfo);
            } else if (obj?.type === "state") {
              onAwaitingChange(obj.awaitingInput === true);
              // `working` rides the daemon state channel too, so hidden and
              // newly reattached terminals get the current activity snapshot.
              // The local byte-silence ticker below is a defensive fallback
              // for missed false-edges.
              if (typeof obj.working === "boolean") {
                if (obj.working) lastActivityTs = Date.now();
                setCurrentWorking(obj.working);
              }
              configError = obj.configError ?? null;
              // Error gone (or replaced) → drop any stale action feedback.
              if (!configError) configAction = null;
            } else if (obj?.type === "io" && typeof obj.rxBytes === "number") {
              recordHiddenRx(obj.rxBytes);
            }
          } catch {
            // ignore
          }
          return;
        }
        // Binary frame = raw PTY output.
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (!firstOutputFrameLogged) {
          firstOutputFrameLogged = true;
          logTerminalStartup("first-output-frame", {
            bytes: bytes.byteLength,
            visible: isTerminalVisible,
          });
          flushTerminalStartupLog("first-output-frame");
        }
        const newlyObservedBytes = ioAccounting.countRawBytes(bytes.byteLength);
        if (newlyObservedBytes > 0) recordRx(newlyObservedBytes);
        if (isTerminalVisible) {
          writeTerminalOutput(bytes);
        } else if (writeBuffer.push(bytes)) {
          const batch = flushBufferedTerminalOutput();
          if (batch) writeTerminalOutput(batch);
        }
        noteActivity();
        if (sshSession)
          extractCwdFromOutput(textDecoder.decode(bytes, { stream: true }));
      };
      ws.onerror = () => {
        // The browser deliberately hides WS error detail. Just flag it —
        // the `onclose` that always follows carries the daemon's close code
        // + reason, which is what we actually surface to the user.
        wsErrored = true;
        logTerminalStartup("ws-error");
        flushTerminalStartupLog("ws-error");
      };
      ws.onclose = (ev) => {
        logTerminalStartup("ws-close", {
          code: ev.code,
          reason: ev.reason || null,
          wasClean: ev.wasClean,
          wsErrored,
        });
        flushTerminalStartupLog("ws-close");
        if (phase === "exited" || phase === "error") return;
        if (
          ev.code === 1000 &&
          !wsErrored &&
          terminalWsCloseRepresentsExit({ sawExitFrame })
        ) {
          phase = "exited";
          if (!exitInfo) exitInfo = { code: 0 };
          onExit(exitInfo);
          return;
        }
        // Re-attach target is gone: we tried to attach to a pre-existing
        // PTY (attachTermId) but the daemon 404'd the WS upgrade before we
        // ever went live — the canonical case is a daemon restart, which
        // kills every prior terminal id while the persisted attachTermId
        // lives on. Don't dead-end the column; fall back to spawning a
        // fresh PTY (e.g. `claude --resume <sid>`) exactly once.
        if (
          attachedThisAttempt &&
          !triedAttachFallback &&
          phase === "starting"
        ) {
          triedAttachFallback = true;
          logTerminalStartup("attach-fallback-start", {
            code: ev.code,
            reason: ev.reason || null,
          });
          if (ws) detachSocket(ws);
          ws = null;
          void spawnPtyAndConnect();
          return;
        }
        if (ev.code === 1000 && !wsErrored) {
          error =
            "Terminal connection closed before the daemon reported a process exit. Close and reopen the session, or press Retry to reconnect.";
          phase = "error";
          return;
        }
        // Abnormal close (or onerror fired first): surface *why* from the
        // daemon-supplied code + reason instead of a bare "WebSocket error"
        // — e.g. "terminal not found" (PTY died before we attached, which
        // is what a failed `--resume` looks like) or "tunnel failed: …".
        error = describeWsClose(ev.code, ev.reason);
        phase = "error";
      };
    } catch (e) {
      logTerminalStartup("spawn-flow-error", {
        message: e instanceof Error ? e.message : String(e),
      });
      flushTerminalStartupLog("spawn-flow-error");
      if (phase !== "error") {
        error = e instanceof Error ? e.message : String(e);
        phase = "error";
      }
    }
  }

  function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !xterm) return;
    ws.send(
      JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }),
    );
  }

  /** Refit xterm to the container and tell the PTY the new size — but only
   *  when the dimensions *actually* changed and the container is laid out.
   *  Routed through `resizeCoalescer` so a zen/fullscreen animation's
   *  per-frame resize burst collapses into one settled refit instead of a
   *  SIGWINCH storm that makes the TUI repaint mid-transition (duplicated /
   *  clipped output). The dimension gate also drops the sub-pixel reflows
   *  that adjacent worktree rows trigger on every JSONL line, and the
   *  clientWidth/Height guard skips the hidden-container path that crashed
   *  xterm's renderer ("Cannot read properties of undefined (dimensions)")
   *  while a column was unmounting. */
  function applyResize() {
    if (!fit || !xterm || phase === "exited") return;
    if (
      !containerEl ||
      containerEl.clientWidth === 0 ||
      containerEl.clientHeight === 0
    )
      return;
    const before = { cols: xterm.cols, rows: xterm.rows };
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fit.proposeDimensions();
    } catch {
      // pre-mount sizing race; ignored
    }
    if (!proposed) return;
    if (proposed.cols === before.cols && proposed.rows === before.rows) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    sendResize();
  }

  // terminal.fontSize is an enum whose values are pixel sizes as
  // strings ("12" etc.); parse to a number, fall back to 12.
  function fontSizePx(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 12;
  }

  // Live font-size: when the user changes terminal.fontSize in Settings,
  // apply it to this running terminal and refit (applyResize gates on a
  // real dimension change, so a no-op store tick costs nothing).
  const termFontSize = settingValue("terminal.fontSize");
  $: if (xterm && xterm.options.fontSize !== fontSizePx($termFontSize)) {
    xterm.options.fontSize = fontSizePx($termFontSize);
    applyResize();
  }

  onMount(() => {
    if (!containerEl) return;
    logTerminalStartup("mount-start");
    xterm = new Terminal({
      fontFamily:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: fontSizePx(getSetting("terminal.fontSize")),
      lineHeight: 1.15,
      cursorBlink: true,
      // Mid-dark theme that matches our surface tokens.
      theme: {
        background: "#1a1a1b",
        foreground: "#e8e8e8",
        cursor: "#e8e8e8",
        cursorAccent: "#1a1a1b",
        selectionBackground: "#2a4a6a",
        black: "#1a1a1b",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#6272a4",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#e8e8e8",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    fit = new FitAddon();
    xterm.loadAddon(fit);
    // Open URLs via the daemon so it works in both browser and native
    // app (WKWebView doesn't route window.open to the OS browser).
    xterm.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          event.preventDefault();
          event.stopPropagation();
          openUrl(uri);
        },
        {
          hover: () => {
            hoveredTerminalLink = true;
          },
          leave: () => {
            hoveredTerminalLink = false;
          },
        },
      ),
    );
    xterm.open(containerEl);
    logTerminalStartup("xterm-opened");
    repaintRenderDisposable = xterm.onRender(handleTerminalRender);
    // Defer the initial fit to rAF so the flex parent has settled its
    // layout. A synchronous fit.fit() here races the browser's layout
    // pass when the column is freshly mounted (e.g. after a source-key
    // promotion) and can measure containerEl at near-zero width, giving
    // xterm cols=2 and producing a 2-char-wide terminal.
    requestAnimationFrame(() => {
      const rafStartedAt = performance.now();
      let fitAttempted = false;
      if (fit && containerEl && containerEl.clientWidth > 0) {
        try {
          fitAttempted = true;
          fit.fit();
        } catch {
          /* layout race; ResizeObserver will retry */
        }
      }
      logTerminalStartup("initial-fit-raf", {
        rafMs: roundMs(performance.now() - rafStartedAt),
        fitAttempted,
      });
    });

    // Capture-phase listener on the xterm container intercepts
    // Cmd/Ctrl shortcuts BEFORE the native Edit menu can claim them.
    // When xterm is focused we handle copy/paste/interrupt ourselves;
    // outside xterm (e.g. text inputs) the Edit menu works normally.
    containerEl.addEventListener(
      "keydown",
      (ev) => {
        const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

        // Ctrl+F toggles this column's native fullscreen. We claim it in
        // capture phase and return before xterm sees it, so the keystroke
        // never reaches the PTY — otherwise readline/TUIs would treat
        // Ctrl+F as forward-char. Same target + toggle logic as the
        // header burger's "Toggle fullscreen". Esc still exits via the
        // browser's own fullscreen-exit handling. Ctrl+F (not Cmd+F) on
        // every platform: Cmd+F is the browser's find and we leave it be.
        if (
          ev.ctrlKey &&
          !ev.metaKey &&
          !ev.altKey &&
          !ev.shiftKey &&
          ev.code === "KeyF"
        ) {
          ev.preventDefault();
          ev.stopPropagation();
          const sessionEl = containerEl?.closest(
            ".session",
          ) as HTMLElement | null;
          if (sessionEl) {
            if (document.fullscreenElement === sessionEl) {
              void document.exitFullscreen().catch(() => {});
            } else {
              void sessionEl.requestFullscreen().catch(() => {});
            }
          }
          return;
        }

        if (isMac && ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
          if (ev.code === "KeyC" && !xterm?.hasSelection()) {
            ev.preventDefault();
            ev.stopPropagation();
            sendTerminalInput(new Uint8Array([0x03]));
            return;
          }
          if (ev.code === "KeyA") {
            ev.preventDefault();
            ev.stopPropagation();
            sendTerminalInput(new Uint8Array([0x01]));
            return;
          }
        }

        if (isMac && ev.metaKey && !ev.ctrlKey) {
          if (ev.code === "KeyV") {
            // Block xterm's handler (which calls navigator.clipboard.read
            // and triggers the macOS "Paste" popup). Instead we listen for
            // the native `paste` event below, which carries clipboardData
            // inline without any popup.
            ev.stopPropagation();
            return;
          }
          if (ev.code === "KeyC" && xterm?.hasSelection()) {
            ev.preventDefault();
            ev.stopPropagation();
            const sel = getCleanedSelection(xterm);
            if (sel) copyToClipboard(sel);
            return;
          }
          if (ev.code === "KeyA") {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
        }

        // Windows/Linux: Ctrl+C with a TUI selection copies. We mirror the
        // mac Cmd+C branch in capture phase rather than relying solely on
        // attachCustomKeyEventHandler because xterm's own keydown handler
        // can clear / mutate selection state between the raw keydown and
        // the custom-key callback firing (observed under cmd.exe and
        // PowerShell PTYs on Windows: selection visibly highlights, plain
        // Ctrl+C feels like it "did nothing"). Reading + writing in
        // capture phase pins the selection read and clipboard write to
        // the earliest possible moment so the convention works the same
        // way Cmd+C does on macOS. The interrupt path (Ctrl+C with no
        // selection → 0x03) is left to xterm's default — falling through
        // is correct and keeps SIGINT working in TUIs.
        if (!isMac && ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
          if (ev.code === "KeyC" && xterm?.hasSelection()) {
            ev.preventDefault();
            ev.stopPropagation();
            const sel = getCleanedSelection(xterm);
            if (sel) copyToClipboard(sel);
            return;
          }
        }
      },
      true,
    );

    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || ev.altKey) return true;
      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      // Windows console copy/paste conventions: Shift+Insert pastes,
      // Ctrl+Insert copies the current selection. cmd.exe and the
      // legacy Win32 console treat these as the canonical clipboard
      // shortcuts (Ctrl+C is interrupt by default there), and they're
      // routed through the same async Clipboard API + xterm.paste path
      // as Ctrl+V / Ctrl+C-with-selection so behavior stays consistent.
      // We check Insert before the `modOnly` gate because Shift+Insert
      // has no Ctrl/Cmd, which would otherwise be filtered out.
      if (ev.code === "Insert") {
        if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
          ev.preventDefault();
          void doClipboardPaste();
          return false;
        }
        if (
          ev.ctrlKey &&
          !ev.metaKey &&
          !ev.shiftKey &&
          xterm?.hasSelection()
        ) {
          ev.preventDefault();
          const sel = getCleanedSelection(xterm);
          if (sel) copyToClipboard(sel);
          return false;
        }
      }
      const modOnly = isMac
        ? ev.metaKey && !ev.ctrlKey
        : ev.ctrlKey && !ev.metaKey;
      if (!modOnly) return true;
      if (ev.code === "KeyV") {
        if (isMac) {
          // On Mac, the capture-phase keydown handler already
          // stopPropagation'd, so this shouldn't fire. But if it
          // does, just let native paste handle it — don't call the
          // Clipboard API (triggers macOS paste popup).
          return false;
        }
        ev.preventDefault();
        void doClipboardPaste();
        return false;
      }
      if (ev.code === "KeyC" && xterm?.hasSelection()) {
        ev.preventDefault();
        const sel = getCleanedSelection(xterm);
        if (sel) {
          void navigator.clipboard?.writeText(sel).catch(() => {});
        }
        return false;
      }
      return true;
    });

    xterm.onData((data) => {
      if (hoveredTerminalLink && isTerminalMouseReport(data)) return;
      sendTerminalInput(data);
    });

    // Resize gate: only `fit.fit()` when dimensions *actually* changed.
    // Activity events in adjacent worktree rows reflow our flex
    // parent by a sub-pixel amount on every JSONL line, which used to
    // fire `fit.fit()` → xterm refit → terminal scrolls to bottom on
    // every keypress in another agent. Comparing the proposed cols/rows
    // against what xterm already has cuts those reflows down to the
    // ones that matter. Also skips fit when the container is hidden
    // (clientWidth === 0) — that's the path that triggered xterm's
    // "Cannot read properties of undefined (reading 'dimensions')"
    // crash when the column was unmounting.
    resizeCoalescer = createResizeCoalescer(applyResize, RESIZE_SETTLE_MS);
    resizeObs = new ResizeObserver(() => resizeCoalescer?.trigger());
    resizeObs.observe(containerEl);

    // Skip rendering while this column is far off-screen (scrolled well out
    // of the horizontal session strip, or inside a display:none panel). The
    // expanded viewport margin keeps nearby columns hot before the user
    // scrolls them into view; only distant hidden columns get paused.
    // On reveal we flush the backlog in one write and re-fit, since the size
    // may have changed while we weren't laying out.
    visibilityObs = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        // The expensive reveal/hide work — the WebGL renderer switch and refit
        // whose size-check forces a reflow — is deferred until scrolling settles
        // (see scheduleRevealReconcile), so a scroll that drags columns across
        // the viewport doesn't storm. Output paint and daemon visibility below
        // stay immediate.
        scheduleRevealReconcile(visible);
        if (visible === isTerminalVisible) return;
        isTerminalVisible = visible;
        sendVisibilityState();
        publishTerminalIoStats();
        if (visible) paintBufferedTerminalOutput();
      },
      { rootMargin: OUTPUT_VISIBILITY_ROOT_MARGIN, threshold: 0 },
    );
    visibilityObs.observe(containerEl);

    // WKWebView doesn't always fire ResizeObserver during fullscreen
    // transitions. A window resize listener catches those, routed through
    // the same coalescer so the fullscreen animation's per-frame resize
    // burst collapses into one settled refit (otherwise the TUI repaints
    // mid-transition and duplicates / clips output).
    onWindowResize = () => resizeCoalescer?.trigger();
    window.addEventListener("resize", onWindowResize);
    window.addEventListener(STAGE_PROMPT_EVENT, onStagePrompt);

    // Re-report visibility when the window is backgrounded / restored. The
    // IntersectionObserver only tracks in-viewport geometry, so without this a
    // backgrounded (undrained) socket stays "visible" to the daemon and its
    // output buffer grows unbounded — see sendVisibilityState.
    onDocVisibility = () => sendVisibilityState();
    document.addEventListener("visibilitychange", onDocVisibility);

    // Focus/blur on the xterm container (the inner textarea bubbles
    // focusin/focusout up) arms the activity suppressor so the
    // resulting status-bar redraw burst from a focus-reporting TUI
    // doesn't briefly flip the working ring on. `pointerdown` covers
    // clicks that don't move focus but still trigger a TUI redraw via
    // mouse-tracking escape sequences.
    const armSuppress = () => {
      suppressActivityUntilTs = Date.now() + SUPPRESS_AROUND_FOCUS_MS;
    };
    containerEl.addEventListener("focusin", armSuppress);
    containerEl.addEventListener("focusout", armSuppress);
    containerEl.addEventListener("pointerdown", armSuppress);

    logTerminalStartup("mount-ready");
    flushTerminalStartupLog("mount-ready");
    void spawnPtyAndConnect();
    publishTerminalIoStats();

    ioTicker = setInterval(() => {
      rxBytesPerSec = rxWindowBytes;
      txBytesPerSec = txWindowBytes;
      rxWindowBytes = 0;
      txWindowBytes = 0;
      publishTerminalIoStats();
    }, 1000);

    // Drive the working → idle edge. Raw byte observations and daemon state
    // frames raise the flag; this ticker defensively lowers it after local
    // silence. It intentionally runs even while the column is offscreen so a
    // missed daemon false-edge cannot leave the dock stuck in "working" while
    // the terminal I/O chip has already dropped to 0/s.
    workingTicker = setInterval(() => {
      if (currentWorking && Date.now() - lastActivityTs > WORKING_IDLE_MS) {
        setCurrentWorking(false);
      }
    }, 500);
  });

  function startSshPolling(id: string) {
    if (sshPollTimer) clearInterval(sshPollTimer);
    let pollCount = 0;
    const poll = async () => {
      try {
        const sessions = await fetchSshSessions(daemonId);
        const s = sessions[id];
        if (s && !sshSession) {
          sshSession = s;
          onSshChange?.(s);
        } else if (!s && sshSession) {
          sshSession = null;
          onSshChange?.(null);
        }
      } catch {}
      pollCount++;
      // After the fast initial burst, switch to slower polling.
      if (pollCount === 10 && sshPollTimer) {
        clearInterval(sshPollTimer);
        sshPollTimer = setInterval(poll, 5000);
      }
    };
    // Poll fast for the first 10s (every 1s), then every 5s. The fetch helper
    // is single-flight cached, so N terminals share one endpoint request.
    void poll();
    sshPollTimer = setInterval(poll, 1000);
  }

  onDestroy(() => {
    if (workingTicker !== null) {
      clearInterval(workingTicker);
      workingTicker = null;
    }
    if (ioTicker !== null) {
      clearInterval(ioTicker);
      ioTicker = null;
    }
    setCurrentWorking(false);
    onAwaitingChange(false);
    removeTerminalIoStats(currentIoStatsId);
    if (sshPollTimer) {
      clearInterval(sshPollTimer);
      sshPollTimer = null;
    }
    if (tuiSettleTimer) clearTimeout(tuiSettleTimer);
    if (revealReconcileTimer) clearTimeout(revealReconcileTimer);
    if (visibleWriteRaf !== null) {
      cancelAnimationFrame(visibleWriteRaf);
      visibleWriteRaf = null;
    }
    visibleWriteQueue = [];
    resizeObs?.disconnect();
    resizeCoalescer?.cancel();
    visibilityObs?.disconnect();
    if (onWindowResize) window.removeEventListener("resize", onWindowResize);
    if (onDocVisibility)
      document.removeEventListener("visibilitychange", onDocVisibility);
    window.removeEventListener(STAGE_PROMPT_EVENT, onStagePrompt);
    repaintRenderDisposable?.dispose();
    repaintRenderDisposable = null;
    clearRepaintDecorations();
    if (ws && ws.readyState <= WebSocket.OPEN) {
      // Drop the socket's handlers BEFORE closing. This is a deliberate
      // unmount, not a PTY exit — the PTY stays alive on the daemon
      // (grace-reaped, or reattached by the instance that replaces us).
      // Without detaching, ws.onclose fires with code 1000 and its
      // code-1000 branch calls onExit(), which makes the parent flip the
      // column from terminal mode back to read mode. When the column is
      // merely remounting (a {#key} bump from a model/effort switch, a
      // settings-store tick, or a poll re-render), that phantom exit
      // tears down the freshly-mounted replacement → the TUI "opens and
      // closes immediately," orphaning a live PTY each time. Same guard
      // the retry / attach-fallback paths already use.
      detachSocket(ws);
      try {
        ws.close(1000, "unmount");
      } catch {}
    }
    detachWebgl();
    xterm?.dispose();
    xterm = null;
  });

  function focusTerminal() {
    xterm?.focus();
  }

  function onStagePrompt(e: Event): void {
    const detail = (
      e as CustomEvent<{ source?: string; text?: string; chunks?: string[] }>
    ).detail;
    if (!detail || detail.source !== sessionSource || !xterm) return;
    const chunks = detail.chunks ?? (detail.text ? [detail.text] : []);
    if (chunks.length === 0) return;
    xterm.focus();
    void pasteChunks(chunks);
  }

  async function pasteChunks(chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk) continue;
      pasteChunkAsBracketedPaste(chunk);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  function pasteChunkAsBracketedPaste(chunk: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      xterm?.paste(chunk);
      return;
    }
    sendTerminalInput(`\x1b[200~${chunk}\x1b[201~`);
  }

  /** Upload a Blob/File to /api/attach and write the returned absolute
   *  path into the PTY's stdin. This is the same dance VSCode terminal-
   *  paste-image extensions do (save → insert path) — the difference is
   *  the upload goes through the daemon instead of an extension host.
   *  We append a trailing space so consecutive drops/pastes don't
   *  concatenate into one unreadable line. */
  async function uploadAndInsert(
    blob: Blob,
    filename?: string,
    debugExtra: PasteDebugExtra = {},
  ): Promise<void> {
    const pasteDebugId = makePasteDebugId();
    const startedAt = performance.now();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn(
        "supergit: terminal image paste ignored; websocket is not open",
      );
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      sendPasteDebug(pasteDebugId, "client-attach-start", {
        mode: "attachment",
        inputBytes: blob.size,
        inputType: blob.type || null,
        filename: filename ?? null,
        ...debugExtra,
      });
      // Downscale oversized screenshots before upload so the receiving
      // agent doesn't waste vision tokens on pixels Claude would have
      // resized away internally. Non-images, SVGs, GIFs and already-
      // small images pass through untouched.
      const shrinkStarted = performance.now();
      const shrunk = await shrinkImageBlob(blob);
      const shrinkMs = roundMs(performance.now() - shrinkStarted);
      sendPasteDebug(pasteDebugId, "client-shrink-done", {
        mode: "attachment",
        inputBytes: blob.size,
        outputBytes: shrunk.size,
        inputType: blob.type || null,
        outputType: shrunk.type || null,
        changed: shrunk !== blob,
        shrinkMs,
        totalMs: roundMs(performance.now() - startedAt),
      });
      const form = new FormData();
      form.append(
        "file",
        filename ? new File([shrunk], filename, { type: shrunk.type }) : shrunk,
      );
      form.append("pasteDebugId", pasteDebugId);
      if (terminalId) form.append("termId", terminalId);
      form.append("source", "terminal-image-paste");
      form.append("clientSource", String(debugExtra.source ?? "terminal"));
      form.append("clientInputBytes", String(blob.size));
      form.append("clientOutputBytes", String(shrunk.size));
      if (blob.type) form.append("clientInputType", blob.type);
      if (shrunk.type) form.append("clientOutputType", shrunk.type);
      if (typeof debugExtra.readMs === "number") {
        form.append("clientReadMs", String(debugExtra.readMs));
      }
      if (typeof debugExtra.blobMs === "number") {
        form.append("clientBlobMs", String(debugExtra.blobMs));
      }
      form.append("clientShrinkMs", String(shrinkMs));
      form.append(
        "clientBeforeUploadMs",
        String(roundMs(performance.now() - startedAt)),
      );
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 30_000);
      const fetchStarted = performance.now();
      const res = await fetch(apiUrl("/api/attach", daemonId), {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const fetchMs = roundMs(performance.now() - fetchStarted);
      sendPasteDebug(pasteDebugId, "client-attach-response", {
        mode: "attachment",
        status: res.status,
        ok: res.ok,
        fetchMs,
        totalMs: roundMs(performance.now() - startedAt),
      });
      if (!res.ok) {
        console.warn(
          `supergit: terminal image paste attach failed: ${res.status}`,
        );
        return;
      }
      const { path } = (await res.json()) as { path: string };
      const basename = path.split(/[\\/]/).pop() ?? "";
      sendPasteDebug(pasteDebugId, "insert-attempt", {
        file: basename,
        bytes: shrunk.size,
      });
      if (!sendTerminalInput(path + " ")) {
        console.warn(
          "supergit: terminal image paste saved but terminal websocket closed before insert",
        );
        return;
      }
      sendPasteDebug(pasteDebugId, "insert-sent", {
        file: basename,
        bytes: shrunk.size,
        chars: path.length + 1,
      });
    } catch (err) {
      console.warn("supergit: terminal image paste failed", err);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /** Read the clipboard via the async Clipboard API and paste into the
   *  PTY. Images use the native/direct paste path by default so terminal
   *  apps that understand image clipboard paste can read the bytes
   *  themselves. The attachment setting keeps the old resize/save/path
   *  flow. Plain text goes through `xterm.paste()` which picks up
   *  bracketed-paste mode + line-ending normalization. Driven
   *  by the custom keydown handler so paste reliably fires on Windows,
   *  where xterm.js's default Ctrl+V keydown calls preventDefault and
   *  the browser then never dispatches a `paste` event for our capture-
   *  phase listener to catch. */
  async function doClipboardPaste(): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pasteStarted = performance.now();
    // Prefer clipboard.read() — yields ClipboardItem[] with both image
    // and text payloads in a single round-trip. Falls back to readText()
    // if unsupported or denied (Firefox without permission, older
    // browsers without ClipboardItem).
    if (navigator.clipboard?.read) {
      try {
        const readStarted = performance.now();
        const items = await navigator.clipboard.read();
        const readMs = roundMs(performance.now() - readStarted);
        const itemTypes = clipboardTypesLabel(
          items.flatMap((item) => item.types),
        );
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith("image/")) {
              if (shouldUseNativeImagePaste()) {
                sendNativeImagePaste("clipboard-read", {
                  readMs,
                  itemCount: items.length,
                  imageType: type,
                  types: itemTypes,
                  totalMs: roundMs(performance.now() - pasteStarted),
                });
                return;
              }
              const blobStarted = performance.now();
              const blob = await item.getType(type);
              const blobMs = roundMs(performance.now() - blobStarted);
              await uploadAndInsert(blob, undefined, {
                source: "clipboard-read",
                readMs,
                blobMs,
                itemCount: items.length,
                imageType: type,
                types: itemTypes,
                totalMs: roundMs(performance.now() - pasteStarted),
              });
              return;
            }
          }
        }
        // No image — preserve Supergit note attachments when the rich
        // HTML flavor is present, then fall back to plain text from
        // the same clipboard read.
        for (const item of items) {
          if (item.types.includes("text/html")) {
            const blob = await item.getType("text/html");
            const payload = extractNoteClipboardPayloadFromHtml(
              await blob.text(),
            );
            if (payload) {
              try {
                await pasteChunks(
                  await expandNoteBodyForTerminalPasteChunks(
                    payload.body,
                    // A pasted note's text attachment lives on the note's
                    // owning daemon, which the clipboard payload doesn't carry;
                    // fall back to this terminal's daemon (the common same-row
                    // copy→paste case).
                    (p) => fetchTextAttachment(p, daemonId),
                  ),
                );
              } catch (err) {
                console.warn("Could not read note attachments for paste", err);
              }
              return;
            }
          }
        }
        for (const item of items) {
          if (item.types.includes("text/plain")) {
            const blob = await item.getType("text/plain");
            const text = await blob.text();
            if (text) xterm?.paste(text);
            return;
          }
        }
      } catch {
        // Permission denied / unsupported — fall through to readText.
      }
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) xterm?.paste(text);
    } catch {
      // Older browser / no permission. Silent — nothing we can do here.
    }
  }

  // Runs in CAPTURE phase on `.xterm-host` so we see the event before
  // xterm.js's own paste listener fires on its helper textarea / inner
  // element. xterm calls `ev.stopPropagation()` in handlePasteEvent,
  // which used to swallow image pastes entirely (the bubble-phase
  // handler we registered here never ran), and on Windows it also
  // appears to drop normal text pastes when focus isn't where xterm
  // expects. So we own paste end-to-end:
  //   - image clipboard item → ask the terminal app to read the native
  //     image clipboard directly (default) or upload to /api/attach and write
  //     the absolute path into the PTY when the attachment mode is set.
  //   - text/plain → hand off to xterm.paste(), the public API that
  //     applies bracketed-paste wrapping and triggers the onData event
  //     we already pipe to the daemon via ws.send. This bypasses
  //     xterm's internal `paste` event listener so the Windows focus
  //     quirk can't matter.
  function onPaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;
    const itemCount = cd.items.length;
    const itemTypes = clipboardTypesLabel(
      Array.from(cd.items, (item) => item.type || item.kind),
    );
    const payload = extractNoteClipboardPayloadFromHtml(
      cd.getData("text/html"),
    );
    if (payload && xterm) {
      e.preventDefault();
      e.stopPropagation();
      void expandNoteBodyForTerminalPasteChunks(
        payload.body,
        // See note above: best-effort to this terminal's daemon.
        (p) => fetchTextAttachment(p, daemonId),
        { omitTargetSessionSource: sessionSource },
      )
        .then((chunks) => pasteChunks(chunks))
        .catch((err) =>
          console.warn("Could not read note attachments for paste", err),
        );
      return;
    }
    for (const it of cd.items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        e.preventDefault();
        e.stopPropagation();
        if (shouldUseNativeImagePaste()) {
          sendNativeImagePaste("paste-event", {
            itemCount,
            imageType: it.type,
            types: itemTypes,
          });
          return;
        }
        const blob = it.getAsFile();
        if (blob) {
          void uploadAndInsert(blob, blob.name || undefined, {
            source: "paste-event",
            itemCount,
            imageType: it.type,
            types: itemTypes,
          });
          // Only handle the first image item; otherwise multiple PNGs
          // in the same clipboard event would race to land in the PTY.
          return;
        }
      }
    }
    const text = cd.getData("text/plain");
    if (text && xterm) {
      e.preventDefault();
      e.stopPropagation();
      // A big paste written in one shot can outrun the TUI's input drain and
      // overflow the pty buffer → the paste lands truncated. Chunk + throttle
      // large text so the receiver keeps up; small pastes keep the untouched
      // single-shot path. Falls back to xterm.paste when the socket isn't open
      // (xterm buffers it until the WS reconnects).
      if (ws?.readyState === WebSocket.OPEN && shouldThrottlePaste(text)) {
        void sendThrottledTextPaste(text);
      } else {
        xterm.paste(text);
      }
    }
  }

  /** Deliver a large text paste as one bracketed paste whose body is streamed
   *  in throttled chunks (see terminal-image-paste.ts). Bracketing is only
   *  applied when the app has bracketed-paste mode on (DECSET 2004) — sending
   *  the `\x1b[200~` wrapper into a shell that hasn't enabled it would insert
   *  a literal `200~`. */
  async function sendThrottledTextPaste(text: string): Promise<void> {
    const bracketed =
      (xterm as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes
        ?.bracketedPasteMode === true;
    const chunks = chunkPasteBody(text);
    if (bracketed) sendTerminalInput("\x1b[200~");
    for (let i = 0; i < chunks.length; i++) {
      // Socket dropped mid-paste (unmount / reconnect) — stop rather than
      // silently lose the remainder into a closed WS.
      if (!sendTerminalInput(chunks[i]!)) return;
      if (i < chunks.length - 1)
        await new Promise((r) => setTimeout(r, PASTE_CHUNK_DELAY_MS));
    }
    if (bracketed) sendTerminalInput("\x1b[201~");
  }

  /** Press "1" + Enter to choose Claude's "Exit and fix manually", so the
   *  parent's onExit can respawn with the (now valid) config. */
  function sendConfigExitChoice(): void {
    if (!terminalId) return;
    const handle = ws;
    if (handle && handle.readyState === WebSocket.OPEN) {
      sendTerminalInput("1\r");
    }
  }

  async function configErrorOpen(): Promise<void> {
    if (!configError || configAction?.phase === "pending") return;
    configAction = startConfigAction("open");
    const res = await fetch(apiUrl("/api/open-default"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: configError.file }),
    }).catch(() => null);
    const ok = !!res && res.ok;
    const via = ok
      ? ((await res!.json().catch(() => null))?.via ?? null)
      : null;
    configAction = settleConfigAction(
      configAction,
      ok,
      ok && via ? `Opened (${via})` : undefined,
    );
  }

  async function configErrorRepair(): Promise<void> {
    if (!configError || configAction?.phase === "pending") return;
    configAction = startConfigAction("repair");
    const res = await fetch(apiUrl("/api/config-fix"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: configError.file }),
    }).catch(() => null);
    const ok = !!res && res.ok;
    configAction = settleConfigAction(configAction, ok);
    // Repaired on disk — exit so Claude restarts with the fixed config.
    if (ok) sendConfigExitChoice();
  }

  async function configErrorDismiss(): Promise<void> {
    if (!configError || configAction?.phase === "pending") return;
    configAction = startConfigAction("dismiss");
    sendConfigExitChoice();
    configAction = settleConfigAction(configAction, true);
  }

  const CONFIG_BUTTONS: {
    kind: ConfigActionKind;
    label: string;
    handler: () => void;
  }[] = [
    { kind: "open", label: "Open", handler: configErrorOpen },
    { kind: "repair", label: "Repair", handler: configErrorRepair },
    { kind: "dismiss", label: "Dismiss", handler: configErrorDismiss },
  ];

  function onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function onDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    // Upload sequentially so the inserted path order matches drop order.
    // After the drop completes we focus the xterm so the user can
    // immediately keep typing — without this, the click on the file
    // (in Finder, the IDE etc.) left focus outside the PTY and the
    // next keystroke landed on the page chrome.
    void (async () => {
      for (const f of Array.from(files)) {
        await uploadAndInsert(f, f.name);
      }
      focusTerminal();
    })();
  }
</script>

<div
  class="terminal-wrap"
  class:focused
  class:repaint-debug-active={repaintFlashEnabled || repaintScaleEnabled}
  class:repaint-debug-flash={repaintFlashEnabled}
  class:repaint-debug-scale={repaintScaleEnabled}
  on:mouseenter={onTuiWrapEnter}
  on:mouseleave={onTuiWrapLeave}
  on:wheel|capture={onTuiWrapWheel}
  role="presentation"
>
  {#if phase === "starting"}
    <LoadingOverlay text="starting terminal…" />
  {/if}
  {#if phase === "error"}
    <div class="overlay error">
      <span class="error-msg">{error || "terminal error"}</span>
      <button type="button" class="retry-btn" on:click={retry}>Retry</button>
    </div>
  {/if}
  {#if $showTerminalIoDebug}
    <div
      class="term-io-debug io-debug-chip"
      title="Terminal payload throughput: inbound, outbound, total inbound, total outbound, visibility state"
    >
      <span class="term-io-readout"
        >in {formatBytes(rxBytesPerSec)}/s <span aria-hidden="true">·</span> out
        {formatBytes(txBytesPerSec)}/s <span aria-hidden="true">·</span> total
        in {formatBytes(rxBytesTotal)} <span aria-hidden="true">·</span> total
        out {formatBytes(txBytesTotal)} <span aria-hidden="true">·</span>
        {isTerminalVisible ? "visible" : "paused"}</span
      >
      <label
        class="term-debug-toggle"
        title="Flash cells as terminal content changes"
      >
        <input
          type="checkbox"
          checked={$flashTermRepaints === true}
          on:change={(ev) =>
            writeDebugToggle(
              "terminal.flashRepaints",
              ev.currentTarget.checked,
            )}
        />
        flash
      </label>
      <label
        class="term-debug-toggle"
        title="Pop cells as terminal content changes"
      >
        <input
          type="checkbox"
          checked={$scaleTermRepaints === true}
          on:change={(ev) =>
            writeDebugToggle(
              "terminal.scaleRepaints",
              ev.currentTarget.checked,
            )}
        />
        scale
      </label>
    </div>
  {/if}

  <div
    class="xterm-host"
    bind:this={containerEl}
    on:click={focusTerminal}
    on:paste|capture={onPaste}
    on:dragover={onDragOver}
    on:drop={onDrop}
    on:focusin={() => (focused = true)}
    on:focusout={() => (focused = false)}
    role="presentation"
  ></div>

  {#if configError}
    <div class="config-error-pill" class:busy={configAction !== null}>
      <span class="config-error-label"
        >Config error: {configError.file.split(/[\\/]/).pop()}</span
      >
      {#each CONFIG_BUTTONS as b (b.kind)}
        {@const v = configButtonView(b.kind, configAction)}
        <button
          type="button"
          class="pill-btn"
          class:active={v.active}
          class:done={v.phase === "done"}
          class:error={v.phase === "error"}
          disabled={v.disabled}
          on:click={b.handler}
        >
          {#if v.spinner}<span class="pill-spinner" aria-hidden="true"
            ></span>{:else if v.phase === "done"}<span class="pill-glyph"
              >✓</span
            >{:else if v.phase === "error"}<span class="pill-glyph">✕</span
            >{/if}{v.active && configAction ? configAction.message : b.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .terminal-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    /* As a flex child of .session (column-flex), claim whatever space
       the row gives us. min-height is the usable floor; max-height
       caps growth on tall displays so the TUI never dominates. */
    flex: 1 1 28rem;
    min-height: 28rem;
    max-height: 60vh;
    min-width: 0;
    background: #1a1a1b;
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid var(--surface-2);
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
    /* Contain VERTICAL scroll chaining only — hitting top/bottom of
       the TUI scrollback shouldn't bleed into the page. Horizontal
       stays `auto` so a trackpad swipe over the TUI passes through
       to the parent `.sessions-strip` and pans the row. (Order is
       `<x> <y>` in the shorthand.) */
    overscroll-behavior: auto contain;
  }
  .terminal-wrap.focused {
    border-color: var(--brand);
    box-shadow: 0 0 0 1px var(--brand);
  }
  .xterm-host {
    flex: 1;
    padding: 0.4rem 0.5rem;
    overflow: hidden;
    /* EXPERIMENT (perf.md "Layerize storm during typing"): xterm's DOM
       renderer adds/removes <span>+#text nodes every keystroke, which
       invalidates layout and dirties compositing → a ~29ms Layerize over the
       whole layer tree per keystroke. `contain` makes this subtree an
       independent layout + paint/stacking root so that churn can't ripple
       outward. NOTE: this scopes LAYOUT; it is not expected to remove the
       Layerize itself (the paint-artifact structure still changes as spans
       come and go, and layerization is a document-global O(layers) pass) —
       re-record a typing trace to confirm. If it doesn't move Layerize, the
       real fix is swapping xterm to the canvas renderer. `size` deliberately
       omitted (the box is flex-sized, but size-containment risks collapse). */
    contain: layout paint;
  }
  .term-io-debug {
    position: absolute;
    top: 0.2rem;
    right: 0.35rem;
    z-index: 3;
    max-width: calc(100% - 0.7rem);
    gap: 0.35rem;
    white-space: nowrap;
    pointer-events: auto;
    user-select: none;
  }
  .term-io-readout {
    pointer-events: none;
  }
  .term-debug-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.16rem;
    color: rgba(255, 255, 255, 0.78);
    cursor: pointer;
  }
  .term-debug-toggle input {
    width: 10px;
    height: 10px;
    margin: 0;
    accent-color: var(--brand);
  }
  :global(.terminal-wrap .xterm-decoration.term-repaint-decoration) {
    display: block;
    box-sizing: border-box;
    overflow: hidden;
    color: inherit;
    background: transparent;
    text-align: left;
    white-space: pre;
    font: inherit;
    line-height: 1.15;
    pointer-events: none;
    transform-origin: center center;
    will-change: transform, background-color, opacity;
  }
  :global(.terminal-wrap .xterm-decoration.term-repaint-decoration.scale) {
    overflow: visible;
  }
  :global(
    .terminal-wrap
      .xterm-decoration.term-repaint-decoration.scale
      .term-repaint-glyph
  ) {
    display: block;
    width: 100%;
    height: 100%;
    font: inherit;
    line-height: 1.15;
    text-align: left;
    white-space: pre;
    transform-origin: center center;
    will-change: transform;
    animation: term-repaint-decoration-scale 520ms
      cubic-bezier(0.18, 0.9, 0.18, 1) forwards;
  }
  :global(
    .terminal-wrap.repaint-debug-active .xterm-rows span.xterm-decoration-top
  ) {
    transform-origin: center center;
    will-change: transform, background-color, opacity;
  }
  :global(.terminal-wrap .xterm-decoration.term-repaint-decoration.flash) {
    animation: term-repaint-decoration-flash 520ms ease-out forwards;
  }
  :global(
    .terminal-wrap.repaint-debug-flash .xterm-rows span.xterm-decoration-top
  ) {
    animation: term-repaint-decoration-flash 520ms ease-out forwards;
  }
  :global(
    .terminal-wrap .xterm-decoration.term-repaint-decoration.flash.scale
  ) {
    animation: term-repaint-decoration-flash 520ms ease-out forwards;
  }
  @keyframes -global-term-repaint-decoration-flash {
    0% {
      background: #7ee787;
      color: #07130a;
      opacity: 1;
    }
    20% {
      background: #ffd666;
      color: #07130a;
      opacity: 1;
    }
    62% {
      background: rgba(126, 231, 135, 0.72);
      color: #07130a;
      opacity: 1;
    }
    100% {
      background: rgba(126, 231, 135, 0);
      color: inherit;
      opacity: 0;
    }
  }
  @keyframes -global-term-repaint-decoration-scale {
    0% {
      transform: scale(1);
    }
    12% {
      transform: scale(1.32);
    }
    36% {
      transform: scale(1.08);
    }
    82% {
      transform: scale(1);
    }
    100% {
      transform: scale(1);
    }
  }
  /* Error callout — same anchor as the LoadingOverlay (centred,
     nudged up one line) but with its own background so the warning
     reads as a chip rather than inline text. The loading-state pill
     lives in `./LoadingOverlay.svelte`. */
  .overlay.error {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, calc(-50% - 1lh));
    z-index: 2;
    background: var(--error-bg);
    color: var(--error-text);
    border-radius: var(--radius-sm);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.55rem;
    max-width: min(90%, 32rem);
    text-align: center;
    padding: 0.55rem 0.9rem 0.6rem;
  }
  .error-msg {
    line-height: 1.35;
  }
  .retry-btn {
    appearance: none;
    cursor: pointer;
    font: inherit;
    color: inherit;
    background: color-mix(in srgb, currentColor 14%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
    padding: 0.2rem 0.75rem;
    border-radius: var(--radius-sm);
    transition:
      background 120ms ease,
      border-color 120ms ease;
  }
  .retry-btn:hover {
    background: color-mix(in srgb, currentColor 22%, transparent);
    border-color: color-mix(in srgb, currentColor 65%, transparent);
  }
  .retry-btn:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 1px;
  }
  .config-error-pill {
    position: absolute;
    bottom: 0.75rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface-1, #2a2a2b);
    border: 1px solid var(--warning, #e8a735);
    border-radius: 999px;
    padding: 0.25rem 0.55rem 0.25rem 0.75rem;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
    font-size: 0.78rem;
    color: var(--text-1, #e8e8e8);
    white-space: nowrap;
  }
  .config-error-label {
    opacity: 0.85;
    margin-right: 0.15rem;
  }
  .pill-btn {
    appearance: none;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
    color: var(--text-1, #e8e8e8);
    background: color-mix(in srgb, currentColor 10%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    transition:
      background 100ms ease,
      border-color 100ms ease;
  }
  .pill-btn:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor 20%, transparent);
    border-color: color-mix(in srgb, currentColor 55%, transparent);
  }
  .pill-btn:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 1px;
  }
  .pill-btn:disabled {
    cursor: default;
  }
  /* Non-chosen buttons fade back while an action runs / has settled, so
     the chosen one with its spinner/confirmation reads as the focus. */
  .config-error-pill.busy .pill-btn:not(.active) {
    opacity: 0.4;
  }
  .pill-btn.active {
    color: var(--brand, #6ea8fe);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .pill-btn.active.done {
    color: var(--success, #5bd28b);
  }
  .pill-btn.active.error {
    color: var(--danger, #e5707a);
  }
  .pill-glyph {
    font-size: 0.8rem;
    line-height: 1;
  }
  .pill-spinner {
    width: 0.7rem;
    height: 0.7rem;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: pill-spin 0.6s linear infinite;
  }
  @keyframes pill-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
