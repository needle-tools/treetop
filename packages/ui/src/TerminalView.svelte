<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import "@xterm/xterm/css/xterm.css";

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
  export let onExit: (info: { code: number; signal?: string }) => void = () => {};
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

  let containerEl: HTMLDivElement | null = null;
  let xterm: Terminal | null = null;
  let fit: FitAddon | null = null;
  let ws: WebSocket | null = null;
  let resizeObs: ResizeObserver | null = null;
  let terminalId = "";
  let phase: "starting" | "live" | "exited" | "error" = "starting";
  let error = "";
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

  function clearStartupGuard() {
    if (startupTimer !== null) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    startupAbort = null;
  }

  async function spawnPtyAndConnect() {
    startupAbort = new AbortController();
    startupTimer = setTimeout(() => {
      if (phase !== "starting") return;
      // Force the in-flight POST (if any) to bail out so the loading
      // overlay can clear and onError handlers see something concrete.
      startupAbort?.abort();
      try { ws?.close(4000, "startup-timeout"); } catch {}
      error = `Terminal didn't start within ${STARTUP_TIMEOUT_MS / 1000}s. Close the column and try again — the daemon may be busy or the PTY backend stalled.`;
      phase = "error";
    }, STARTUP_TIMEOUT_MS);
    try {
      let id: string;
      if (attachTermId) {
        // Reattach path — daemon already has this PTY alive (see GET
        // /api/shells). Skip the spawn POST and go straight to WS.
        id = attachTermId;
      } else {
        const cols = xterm?.cols ?? 80;
        const rows = xterm?.rows ?? 24;
        const res = await fetch("/api/terminals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd, cwd, cols, rows, ownerId, procName }),
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
      // Build WS URL relative to current origin so it works behind the
      // Vite proxy or directly against the daemon.
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/terminals/${encodeURIComponent(id)}/io`;
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
            try { fit.fit(); } catch { /* pre-layout race; ignore */ }
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
              onExit(exitInfo);
            } else if (obj?.type === "state") {
              onAwaitingChange(obj.awaitingInput === true);
            }
          } catch {
            // ignore
          }
          return;
        }
        // Binary frame = raw PTY output.
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        xterm?.write(bytes);
        noteActivity();
      };
      ws.onerror = () => {
        if (phase !== "exited") {
          error = "WebSocket error";
          phase = "error";
          clearStartupGuard();
        }
      };
      ws.onclose = () => {
        if (phase !== "exited" && phase !== "error") {
          // Daemon closed us (e.g. PTY died without an exit frame, or
          // grace timer fired). Treat as exited so the UI can flip back.
          phase = "exited";
          if (!exitInfo) exitInfo = { code: 0 };
          onExit(exitInfo);
          clearStartupGuard();
        }
      };
    } catch (e) {
      // If the startup timer already flipped us to error, keep its
      // specific "didn't start within Xs" message rather than overwriting
      // it with a generic AbortError.
      if (phase !== "error") {
        error = e instanceof Error ? e.message : String(e);
        phase = "error";
      }
      clearStartupGuard();
    }
  }

  function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !xterm) return;
    ws.send(JSON.stringify({ type: "resize", cols: xterm.cols, rows: xterm.rows }));
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
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    fit = new FitAddon();
    xterm.loadAddon(fit);
    // Cmd/Ctrl-click on URLs in terminal output opens them in the
    // user's default browser, the same as in a real terminal. The
    // addon's default handler calls `window.open(url, "_blank")`,
    // which the browser routes to the OS default. No callback needed.
    xterm.loadAddon(new WebLinksAddon());
    xterm.open(containerEl);
    fit.fit();

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
    resizeObs = new ResizeObserver(() => {
      if (!fit || !xterm || phase === "exited") return;
      if (!containerEl || containerEl.clientWidth === 0 || containerEl.clientHeight === 0) return;
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
    });
    resizeObs.observe(containerEl);

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

  onDestroy(() => {
    clearStartupGuard();
    if (workingTicker !== null) {
      clearInterval(workingTicker);
      workingTicker = null;
    }
    resizeObs?.disconnect();
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try { ws.close(1000, "unmount"); } catch {}
    }
    xterm?.dispose();
    xterm = null;
  });

  function focusTerminal() {
    xterm?.focus();
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
      const form = new FormData();
      form.append(
        "file",
        filename ? new File([blob], filename, { type: blob.type }) : blob,
      );
      const res = await fetch("/api/attach", { method: "POST", body: form });
      if (!res.ok) return;
      const { path } = (await res.json()) as { path: string };
      ws.send(new TextEncoder().encode(path + " "));
    } catch {
      // Silent — paste failures shouldn't surface a noisy error in the
      // terminal panel; the user will notice nothing was inserted and
      // can try again.
    }
  }

  function onPaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          void uploadAndInsert(blob);
          // Only handle the first image item; otherwise multiple PNGs
          // in the same clipboard event would race to land in the PTY.
          return;
        }
      }
    }
    // No image → let xterm's normal text-paste handling run.
  }

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

<div class="terminal-wrap" class:focused>
  {#if phase === "starting"}
    <div class="overlay">
      <span class="spinner" aria-hidden="true"></span> starting terminal…
    </div>
  {/if}
  {#if phase === "error"}
    <div class="overlay error">{error || "terminal error"}</div>
  {/if}

  <div
    class="xterm-host"
    bind:this={containerEl}
    on:click={focusTerminal}
    on:paste={onPaste}
    on:dragover={onDragOver}
    on:drop={onDrop}
    on:focusin={() => (focused = true)}
    on:focusout={() => (focused = false)}
    role="presentation"
  ></div>

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
    transition: border-color 120ms ease, box-shadow 120ms ease;
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
  .overlay {
    position: absolute;
    top: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
    background: var(--surface-2);
    color: var(--text-1);
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .overlay.error {
    background: var(--error-bg);
    color: var(--error-text);
  }
  .spinner {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: t-spin 0.6s linear infinite;
  }
  @keyframes t-spin {
    to { transform: rotate(360deg); }
  }
</style>
