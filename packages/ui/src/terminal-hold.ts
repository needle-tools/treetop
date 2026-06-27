/**
 * Offscreen "terminal hold" socket.
 *
 * Commit 4d61ab6 ("Defer offscreen layout and terminal work") stopped
 * mounting the (expensive) TerminalView xterm host for session columns that
 * are scrolled off-screen / hidden behind zen mode. That is a real perf win —
 * 48 columns, 1 mounted xterm — but a live agent's PTY only stays alive while
 * *some* WebSocket is subscribed to it: when the last subscriber detaches the
 * daemon arms a 60s grace timer (server.ts `GRACE_MS`) and then reaps the PTY.
 * So an unmounted agent column would lose its terminal after a minute — the
 * session "stops" and disappears from the dock.
 *
 * This manager keeps a lightweight subscriber alive for an attached-but-
 * unmounted terminal. It:
 *   - counts as a subscriber, so the grace timer never fires, and
 *   - reports `drain` from the host (tab visibility), so the daemon keeps the
 *     agent RUNNING while it is merely off-screen and only mutes (helper
 *     `term.pause()`) when the whole tab is backgrounded — mirroring
 *     TerminalView's own `drain = !document.hidden` semantics.
 * It never paints, so `visible` is always false (there is no xterm to draw
 * into); the daemon replays backlog when the real renderer remounts on reveal.
 *
 * The socket protocol is the terminal `/api/terminals/:id/io` WS, same as
 * TerminalView. DOM-free by construction (a `connect` factory and a
 * `shouldDrain` predicate are injected) so it is unit-testable.
 */

/** WebSocket.readyState values, named so this module needs no global. */
export const HOLD_WS = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/** The slice of the WebSocket surface the hold uses. The browser's WebSocket
 *  satisfies this structurally; tests pass a fake. */
export interface HoldSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export interface TerminalHoldDeps {
  /** Open a hold WebSocket for `termId`. */
  connect: (termId: string) => HoldSocket;
  /** Surfaced when the daemon reports an awaiting-input edge over the hold
   *  socket (so the dock keeps its "needs input" badge accurate even while
   *  the renderer is deferred). */
  onAwaiting?: (awaiting: boolean) => void;
  /** Should the daemon keep draining the PTY (i.e. keep the agent running)?
   *  Re-read on every send. Defaults to always-true: a held agent keeps
   *  working while off-screen. The host wires this to `!document.hidden` so a
   *  backgrounded tab still mutes. */
  shouldDrain?: () => boolean;
}

export interface TerminalHold {
  /** Hold `termId`, or pass `undefined` to release. Idempotent for an id that
   *  is already held over a live socket. */
  sync(termId: string | undefined): void;
  /** Re-send the visibility frame (call after a `visibilitychange` so a
   *  drain flip reaches the daemon without reconnecting). No-op when idle. */
  refresh(): void;
  /** Release the hold and tear the socket down. */
  close(): void;
  /** The id currently held, or undefined. */
  heldTermId(): string | undefined;
}

export function createTerminalHold(deps: TerminalHoldDeps): TerminalHold {
  let ws: HoldSocket | null = null;
  let termId: string | undefined;

  function sendVisibility(): void {
    if (!ws || ws.readyState !== HOLD_WS.OPEN) return;
    const drain = deps.shouldDrain ? deps.shouldDrain() : true;
    ws.send(JSON.stringify({ type: "visibility", visible: false, drain }));
  }

  function close(): void {
    const s = ws;
    ws = null;
    termId = undefined;
    if (!s) return;
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
    if (s.readyState === HOLD_WS.CONNECTING || s.readyState === HOLD_WS.OPEN) {
      s.close(1000, "terminal hold released");
    }
  }

  function sync(next: string | undefined): void {
    if (!next) {
      close();
      return;
    }
    if (
      ws &&
      termId === next &&
      ws.readyState !== HOLD_WS.CLOSING &&
      ws.readyState !== HOLD_WS.CLOSED
    ) {
      return;
    }
    close();
    const s = deps.connect(next);
    ws = s;
    termId = next;
    s.onopen = () => sendVisibility();
    s.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as {
          type?: unknown;
          awaitingInput?: unknown;
        };
        if (
          parsed?.type === "state" &&
          typeof parsed.awaitingInput === "boolean"
        ) {
          deps.onAwaiting?.(parsed.awaitingInput);
        }
      } catch {
        // Output / accounting frames aren't JSON state; this socket only
        // exists to keep the PTY alive, so anything else is safely ignored.
      }
    };
    s.onclose = () => {
      if (ws !== s) return;
      ws = null;
      termId = undefined;
    };
  }

  return {
    sync,
    refresh: sendVisibility,
    close,
    heldTermId: () => termId,
  };
}
