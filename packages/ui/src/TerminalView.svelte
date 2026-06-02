<script lang="ts">
  import { apiUrl, apiWsUrl } from "./api";
  import { onMount, onDestroy } from "svelte";
  import { fetchSshSessions, type SshSessionInfo } from "./file-browser-utils";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import "@xterm/xterm/css/xterm.css";
  import LoadingOverlay from "./LoadingOverlay.svelte";
  import { shrinkImageBlob } from "./image-shrink";
  import { joinSelectionRows, type SelectionRow } from "./clean-selection";
  import { TerminalWriteBuffer } from "./terminal-write-buffer";
  import { createResizeCoalescer, type ResizeCoalescer } from "./terminal-resize";
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
  import { describeWsClose } from "./errors";

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

  /** Robust clipboard-write. The async Clipboard API is the modern
   *  path but it gets silently rejected in WebView2 / strict-Permissions
   *  contexts even when the keydown is a trusted user gesture — observed
   *  on Windows where Ctrl+C-with-selection felt like it "did nothing"
   *  because the write rejected and the `.catch` swallowed it. We fall
   *  back to the legacy `execCommand("copy")` via a transient offscreen
   *  textarea, which honors the same trusted-gesture rule but uses the
   *  selection-based clipboard path the WebView allows. If BOTH fail
   *  we surface a console warning so the user can see this isn't a
   *  silent dropped keystroke. */
  function copyToClipboard(text: string): void {
    if (!text) return;
    const tryLegacy = (): boolean => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
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
    };
    const writeText = navigator.clipboard?.writeText;
    if (writeText) {
      writeText.call(navigator.clipboard, text).catch(() => {
        if (!tryLegacy()) {
          console.warn(
            "supergit: clipboard write failed via both async Clipboard API and execCommand",
          );
        }
      });
      return;
    }
    if (!tryLegacy()) {
      console.warn(
        "supergit: clipboard write failed (no async API, execCommand denied)",
      );
    }
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

  let containerEl: HTMLDivElement | null = null;
  let xterm: Terminal | null = null;
  let sshSession: SshSessionInfo | null = null;
  let sshPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastParsedCwd = "";
  let cwdParseBuffer = "";
  const textDecoder = new TextDecoder();

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
  // paint nobody can see. Starts true so output is never withheld before
  // the observer's first callback.
  let isTerminalVisible = true;
  let visibilityObs: IntersectionObserver | null = null;
  const writeBuffer = new TerminalWriteBuffer();
  let terminalId = "";
  let phase: "starting" | "live" | "exited" | "error" = "starting";
  let error = "";
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
  let focused = false;
  /** Hard ceiling on how long we sit in `phase === "starting"`. POST
   *  /api/terminals + WS handshake should take well under a second in
   *  the happy path; 10s covers a slow machine + cold module init.
   *  Beyond that the user is staring at a spinner with no signal — we
   *  flip to error so they can close + retry instead of waiting forever. */
  const STARTUP_TIMEOUT_MS = 10_000;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let startupAbort: AbortController | null = null;
  /** On a cold daemon restart, every column respawns its PTY at once
   *  while /api/repos enrich is scanning the workspace — the single
   *  daemon event loop can stall a POST /api/terminals past the guard
   *  above. That's transient, so rather than dropping the column to an
   *  error on the first miss, auto-retry the spawn a couple of times
   *  with a short backoff; only give up after MAX_SPAWN_ATTEMPTS. */
  const MAX_SPAWN_ATTEMPTS = 3;
  const SPAWN_RETRY_BACKOFF_MS = 750;
  let spawnAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
  function noteActivity() {
    if (Date.now() < suppressActivityUntilTs) return;
    lastActivityTs = Date.now();
    if (!currentWorking) {
      currentWorking = true;
      onWorkingChange(true);
    }
  }

  /** Drop a socket's event handlers before closing it mid-startup (during
   *  a retry). Otherwise its onclose fires while we're still
   *  `phase === "starting"` and wrongly flips the column to "exited",
   *  killing the retry. (Param is `s`, not `ws`, on purpose: a
   *  source-scanning regression test keys off the first literal
   *  `ws.onopen` being the real open handler below.) */
  function detachSocket(s: WebSocket): void {
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
  }

  function clearStartupGuard() {
    if (startupTimer !== null) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    startupAbort = null;
  }

  /** Retry after a failed spawn. Tears down whatever half-state the
   *  failed attempt left behind (ws, startup guard, error text) and
   *  re-enters the spawn flow from scratch. The xterm instance itself
   *  stays — it's just a renderer; clearing it gives the user a clean
   *  buffer rather than the previous attempt's garbage scrollback. */
  function retry() {
    if (phase !== "error") return;
    clearStartupGuard();
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
    spawnAttempts = 0;
    void spawnPtyAndConnect();
  }

  async function spawnPtyAndConnect() {
    spawnAttempts++;
    startupAbort = new AbortController();
    startupTimer = setTimeout(() => {
      if (phase !== "starting") return;
      // Force the in-flight POST (if any) to bail out so we can either
      // retry cleanly or surface a concrete error. Detach the socket's
      // handlers before closing: otherwise its onclose fires while we're
      // still `phase === "starting"` and wrongly flips the column to
      // "exited", killing the retry.
      startupAbort?.abort();
      if (ws) {
        detachSocket(ws);
        try {
          ws.close(4000, "startup-timeout");
        } catch {}
        ws = null;
      }
      if (spawnAttempts < MAX_SPAWN_ATTEMPTS) {
        // Daemon was likely slammed (cold-start enrich storm). Back off
        // briefly, then try again — the spawn usually lands once the
        // event loop frees up. Stays in `phase === "starting"` so the
        // loading overlay keeps showing instead of flashing an error.
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (phase === "starting") void spawnPtyAndConnect();
        }, SPAWN_RETRY_BACKOFF_MS);
        return;
      }
      error = `Terminal didn't start within ${STARTUP_TIMEOUT_MS / 1000}s (after ${MAX_SPAWN_ATTEMPTS} tries). Close the column and try again — the daemon may be busy or the PTY backend stalled.`;
      phase = "error";
    }, STARTUP_TIMEOUT_MS);
    try {
      let id: string;
      if (attachTermId) {
        // Reattach path — daemon already has this PTY alive (see GET
        // /api/shells). Skip the spawn POST and go straight to WS.
        id = attachTermId;
      } else {
        // xterm.cols/rows can be near-zero when the container hasn't
        // laid out yet (Svelte onMount races flex-parent settle). If we
        // POST cols: 2 the PTY spawns 2-wide and zsh wraps the prompt
        // onto itself — visible bug: "input clears the row" + dquote>.
        // Floor to 80x24; the rAF re-fit in ws.onopen will send the
        // real size before the user can type anything.
        const cols = Math.max(xterm?.cols ?? 80, 80);
        const rows = Math.max(xterm?.rows ?? 24, 24);
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
          signal: startupAbort.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        ({ id } = (await res.json()) as { id: string; pid: number });
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
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        phase = "live";
        clearStartupGuard();
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
          if (fit && xterm && containerEl && containerEl.clientWidth > 0) {
            try {
              fit.fit();
            } catch {
              /* pre-layout race; ignore */
            }
            sendResize();
          }
          focusTerminal();
        });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Control frame from the daemon. Currently: exit + state.
          try {
            const obj = JSON.parse(ev.data);
            if (obj?.type === "exit") {
              exitInfo = { code: obj.code, signal: obj.signal };
              phase = "exited";
              // The config dialog is gone once the PTY exits (the user
              // chose an option, or it's respawning with a fixed config) —
              // drop the pill so it doesn't linger on the exited view.
              configError = null;
              configAction = null;
              onExit(exitInfo);
            } else if (obj?.type === "state") {
              onAwaitingChange(obj.awaitingInput === true);
              configError = obj.configError ?? null;
              // Error gone (or replaced) → drop any stale action feedback.
              if (!configError) configAction = null;
            }
          } catch {
            // ignore
          }
          return;
        }
        // Binary frame = raw PTY output.
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        if (isTerminalVisible) {
          xterm?.write(bytes);
        } else if (writeBuffer.push(bytes)) {
          // Hidden but chatty enough to hit the buffer cap — flush the
          // batch through so memory stays bounded (one coarse write is
          // still far cheaper than a parse+paint per chunk).
          const batch = writeBuffer.flush();
          if (batch) xterm?.write(batch);
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
        clearStartupGuard();
      };
      ws.onclose = (ev) => {
        if (phase === "exited" || phase === "error") return;
        clearStartupGuard();
        // A clean close with no preceding error = the daemon tore the PTY
        // down (grace timer fired, or a normal exit we didn't get an
        // explicit frame for). Flip back to "exited" so the UI recovers.
        if (ev.code === 1000 && !wsErrored) {
          phase = "exited";
          if (!exitInfo) exitInfo = { code: 0 };
          onExit(exitInfo);
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
      // AbortError = the startup timer bailed this POST so it could
      // retry (or give up after MAX_SPAWN_ATTEMPTS). The timer owns that
      // decision — bailing here would clobber a pending retry, so leave
      // it be.
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (phase !== "error") {
        error = e instanceof Error ? e.message : String(e);
        phase = "error";
      }
      clearStartupGuard();
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

  onMount(() => {
    if (!containerEl) return;
    xterm = new Terminal({
      fontFamily:
        '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
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
      new WebLinksAddon((_event, uri) => {
        fetch(apiUrl("/api/open-default"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: uri }),
        }).catch(() => {
          window.open(uri, "_blank");
        });
      }),
    );
    xterm.open(containerEl);
    // Defer the initial fit to rAF so the flex parent has settled its
    // layout. A synchronous fit.fit() here races the browser's layout
    // pass when the column is freshly mounted (e.g. after a source-key
    // promotion) and can measure containerEl at near-zero width, giving
    // xterm cols=2 and producing a 2-char-wide terminal.
    requestAnimationFrame(() => {
      if (fit && containerEl && containerEl.clientWidth > 0) {
        try {
          fit.fit();
        } catch {
          /* layout race; ResizeObserver will retry */
        }
      }
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
          const sessionEl = containerEl?.closest(".session") as HTMLElement | null;
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
            ws?.send(new Uint8Array([0x03]));
            return;
          }
          if (ev.code === "KeyA") {
            ev.preventDefault();
            ev.stopPropagation();
            ws?.send(new Uint8Array([0x01]));
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
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
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

    // Skip rendering while this column is off-screen (scrolled out of the
    // horizontal session strip, or inside a display:none panel). The
    // viewport is the implicit root; when the container stops
    // intersecting it, ws.onmessage buffers writes instead of painting.
    // On reveal we flush the backlog in one write and re-fit, since the
    // size may have changed while we weren't laying out.
    visibilityObs = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible === isTerminalVisible) return;
        isTerminalVisible = visible;
        if (visible && xterm) {
          const batch = writeBuffer.flush();
          if (batch) xterm.write(batch);
          // Size may have changed while we weren't laying out; coalesce the
          // refit (same path as the observers) so a reveal that coincides
          // with a resize doesn't double-fit.
          resizeCoalescer?.trigger();
        }
      },
      { threshold: 0 },
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

    void spawnPtyAndConnect();

    // Drive the working → idle edge. The frame handler raises the flag
    // on every chunk; this ticker is the only thing that lowers it,
    // after WORKING_IDLE_MS of silence.
    workingTicker = setInterval(() => {
      if (currentWorking && Date.now() - lastActivityTs > WORKING_IDLE_MS) {
        currentWorking = false;
        onWorkingChange(false);
      }
    }, 500);
  });

  function startSshPolling(id: string) {
    if (sshPollTimer) clearInterval(sshPollTimer);
    let pollCount = 0;
    const poll = async () => {
      try {
        const sessions = await fetchSshSessions();
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
      // After the fast initial burst, switch to slower polling
      if (pollCount === 10 && sshPollTimer) {
        clearInterval(sshPollTimer);
        sshPollTimer = setInterval(poll, 5000);
      }
    };
    // Poll fast for the first 10s (every 1s), then every 5s
    void poll();
    sshPollTimer = setInterval(poll, 1000);
  }

  onDestroy(() => {
    clearStartupGuard();
    if (workingTicker !== null) {
      clearInterval(workingTicker);
      workingTicker = null;
    }
    if (sshPollTimer) {
      clearInterval(sshPollTimer);
      sshPollTimer = null;
    }
    if (tuiSettleTimer) clearTimeout(tuiSettleTimer);
    resizeObs?.disconnect();
    resizeCoalescer?.cancel();
    visibilityObs?.disconnect();
    if (onWindowResize) window.removeEventListener("resize", onWindowResize);
    window.removeEventListener(STAGE_PROMPT_EVENT, onStagePrompt);
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, "unmount");
      } catch {}
    }
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
    ws.send(new TextEncoder().encode(`\x1b[200~${chunk}\x1b[201~`));
  }

  /** Upload a Blob/File to /api/attach and write the returned absolute
   *  path into the PTY's stdin. This is the same dance VSCode terminal-
   *  paste-image extensions do (save → insert path) — the difference is
   *  the upload goes through the daemon instead of an extension host.
   *  We append a trailing space so consecutive drops/pastes don't
   *  concatenate into one unreadable line, and so an agent's prompt
   *  ends up with `prompt @path1 @path2 ` shape if the user pastes
   *  several in a row. */
  async function uploadAndInsert(blob: Blob, filename?: string): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      // Downscale oversized screenshots before upload so the receiving
      // agent doesn't waste vision tokens on pixels Claude would have
      // resized away internally. Non-images, SVGs, GIFs and already-
      // small images pass through untouched.
      const shrunk = await shrinkImageBlob(blob);
      const form = new FormData();
      form.append(
        "file",
        filename ? new File([shrunk], filename, { type: shrunk.type }) : shrunk,
      );
      const res = await fetch(apiUrl("/api/attach"), { method: "POST", body: form });
      if (!res.ok) return;
      const { path } = (await res.json()) as { path: string };
      ws.send(new TextEncoder().encode(path + " "));
    } catch {
      // Silent — paste failures shouldn't surface a noisy error in the
      // terminal panel; the user will notice nothing was inserted and
      // can try again.
    }
  }

  /** Read the clipboard via the async Clipboard API and paste into the
   *  PTY. Images route through /api/attach + path insertion (the same
   *  shape as drag-drop); plain text goes through `xterm.paste()` which
   *  picks up bracketed-paste mode + line-ending normalization. Driven
   *  by the custom keydown handler so paste reliably fires on Windows,
   *  where xterm.js's default Ctrl+V keydown calls preventDefault and
   *  the browser then never dispatches a `paste` event for our capture-
   *  phase listener to catch. */
  async function doClipboardPaste(): Promise<void> {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Prefer clipboard.read() — yields ClipboardItem[] with both image
    // and text payloads in a single round-trip. Falls back to readText()
    // if unsupported or denied (Firefox without permission, older
    // browsers without ClipboardItem).
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith("image/")) {
              const blob = await item.getType(type);
              await uploadAndInsert(blob);
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
                    fetchTextAttachment,
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
  //   - image clipboard item → upload to /api/attach and write the
  //     absolute path into the PTY (same dance as drag-and-drop).
  //   - text/plain → hand off to xterm.paste(), the public API that
  //     applies bracketed-paste wrapping and triggers the onData event
  //     we already pipe to the daemon via ws.send. This bypasses
  //     xterm's internal `paste` event listener so the Windows focus
  //     quirk can't matter.
  function onPaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;
    const payload = extractNoteClipboardPayloadFromHtml(
      cd.getData("text/html"),
    );
    if (payload && xterm) {
      e.preventDefault();
      e.stopPropagation();
      void expandNoteBodyForTerminalPasteChunks(
        payload.body,
        fetchTextAttachment,
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
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          e.stopPropagation();
          void uploadAndInsert(blob);
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
      xterm.paste(text);
    }
  }

  /** Press "1" + Enter to choose Claude's "Exit and fix manually", so the
   *  parent's onExit can respawn with the (now valid) config. */
  function sendConfigExitChoice(): void {
    if (!terminalId) return;
    const handle = ws;
    if (handle && handle.readyState === WebSocket.OPEN) {
      handle.send(new TextEncoder().encode("1\r"));
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
    const via = ok ? ((await res!.json().catch(() => null))?.via ?? null) : null;
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
          {#if v.spinner}<span class="pill-spinner" aria-hidden="true"></span
            >{:else if v.phase === "done"}<span class="pill-glyph">✓</span
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
