<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "xterm/css/xterm.css";

  /** Command + args to spawn. e.g. ["claude", "--resume", "<sid>"]. */
  export let cmd: string[];
  /** Working directory for the PTY. */
  export let cwd: string;
  /** Optional tag (we pass the sessionId so /api/terminals?ownerId=sid
   *  later lets us reconnect). */
  export let ownerId: string | undefined = undefined;
  /** Called when the underlying PTY exits. Parent flips column back to
   *  the read-only view. */
  export let onExit: (info: { code: number; signal?: string }) => void = () => {};
  /** Called when the user clicks the close button in the terminal header. */
  export let onClose: () => void = () => {};

  let containerEl: HTMLDivElement | null = null;
  let xterm: Terminal | null = null;
  let fit: FitAddon | null = null;
  let ws: WebSocket | null = null;
  let resizeObs: ResizeObserver | null = null;
  let terminalId = "";
  let phase: "starting" | "live" | "exited" | "error" = "starting";
  let error = "";
  let exitInfo: { code: number; signal?: string } | null = null;

  async function spawnPtyAndConnect() {
    try {
      const cols = xterm?.cols ?? 80;
      const rows = xterm?.rows ?? 24;
      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, cwd, cols, rows, ownerId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const { id } = (await res.json()) as { id: string; pid: number };
      terminalId = id;
      // Build WS URL relative to current origin so it works behind the
      // Vite proxy or directly against the daemon.
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/terminals/${encodeURIComponent(id)}/io`;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        phase = "live";
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Control frame from the daemon — currently only {type:"exit",...}
          try {
            const obj = JSON.parse(ev.data);
            if (obj?.type === "exit") {
              exitInfo = { code: obj.code, signal: obj.signal };
              phase = "exited";
              onExit(exitInfo);
            }
          } catch {
            // ignore
          }
          return;
        }
        // Binary frame = raw PTY output.
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        xterm?.write(bytes);
      };
      ws.onerror = () => {
        if (phase !== "exited") {
          error = "WebSocket error";
          phase = "error";
        }
      };
      ws.onclose = () => {
        if (phase !== "exited" && phase !== "error") {
          // Daemon closed us (e.g. PTY died without an exit frame, or
          // grace timer fired). Treat as exited so the UI can flip back.
          phase = "exited";
          if (!exitInfo) exitInfo = { code: 0 };
          onExit(exitInfo);
        }
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      phase = "error";
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
    xterm.open(containerEl);
    fit.fit();

    xterm.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    resizeObs = new ResizeObserver(() => {
      if (!fit) return;
      try {
        fit.fit();
      } catch {
        // pre-mount sizing race; ignored
      }
      sendResize();
    });
    resizeObs.observe(containerEl);

    void spawnPtyAndConnect();
  });

  onDestroy(() => {
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
</script>

<div class="terminal-wrap">
  <header>
    <span class="muted small">
      {cmd.join(" ")}
      {#if phase === "starting"}<span class="spinner" aria-hidden="true"></span> starting…{/if}
      {#if phase === "live"}<span class="live-dot" aria-hidden="true"></span> live{/if}
      {#if phase === "exited"}exited{exitInfo ? ` (${exitInfo.code})` : ""}{/if}
      {#if phase === "error"}error{/if}
    </span>
    <button class="close" on:click={onClose} title="Close & dispose">×</button>
  </header>

  {#if phase === "error"}
    <p class="error">{error}</p>
  {/if}

  <div
    class="xterm-host"
    bind:this={containerEl}
    on:click={focusTerminal}
    role="presentation"
  ></div>
</div>

<style>
  .terminal-wrap {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 24rem;
    background: #1a1a1b;
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid var(--surface-2);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--surface-3);
    color: var(--text-1);
  }
  header .muted {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .close {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }
  .close:hover {
    color: var(--text-1);
    background: var(--surface-3);
  }
  .live-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--status-clean);
    box-shadow: 0 0 6px var(--status-clean);
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
  .error {
    color: var(--error-text);
    padding: 0.5rem 0.6rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .xterm-host {
    flex: 1;
    padding: 0.4rem 0.5rem;
    min-height: 20rem;
    overflow: hidden;
  }
</style>
