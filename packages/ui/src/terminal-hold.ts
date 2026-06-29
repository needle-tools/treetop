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
 * RESILIENCE (the bug this revision fixes): the hold socket is the only thing
 * keeping an offscreen PTY alive, but WebView2 aggressively suspends and drops
 * background WebSockets when the app is minimized / the screen is locked, and
 * an idle socket can be idle-closed by the server. The first version did not
 * reconnect — once the socket dropped, nothing revived it and the daemon's
 * grace timer reaped the PTY (the user returned to a silently-stopped terminal,
 * no info). So now:
 *   - an *unexpected* close (while we still intend to hold the id) schedules a
 *     reconnect with capped exponential backoff;
 *   - `refresh()` (wired to visibilitychange) reconnects a dropped socket
 *     immediately, so coming back from a lock recovers promptly; and
 *   - an optional heartbeat re-sends the visibility frame on an interval to
 *     keep an otherwise-silent hold from being idle-closed in the first place.
 * A deliberate release (`sync(undefined)` / `close()` / switching id) never
 * reconnects.
 *
 * The socket protocol is the terminal `/api/terminals/:id/io` WS, same as
 * TerminalView. DOM-free by construction (a `connect` factory, a `shouldDrain`
 * predicate, and the timer functions are injected) so it is unit-testable.
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
  /** Surfaced when the daemon reports a working edge (it computes `working`
   *  from PTY output activity and broadcasts it precisely so the dock can
   *  animate the activity spinner for off-screen / backgrounded sessions —
   *  see node-pty-backend.ts). Fired only when the frame carries `working`,
   *  so an awaiting-only edge frame doesn't spuriously clear the spinner. */
  onWorking?: (working: boolean) => void;
  /** Should the daemon keep draining the PTY (i.e. keep the agent running)?
   *  Re-read on every send. Defaults to always-true: a held agent keeps
   *  working while off-screen. The host wires this to `!document.hidden` so a
   *  backgrounded tab still mutes. */
  shouldDrain?: () => boolean;
  /** Schedule a one-shot timer (reconnect backoff + heartbeat). Injected for
   *  tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Cancel a scheduled timer. Defaults to clearTimeout. */
  unschedule?: (handle: unknown) => void;
  /** Base delay for reconnect backoff (ms); doubles per consecutive failure,
   *  capped at 30s. Defaults to 1000. */
  reconnectBaseMs?: number;
  /** If set (> 0), re-send the visibility frame every `heartbeatMs` while the
   *  socket is open, so an otherwise-silent hold isn't idle-closed. Off by
   *  default; the host (SessionView) opts in. */
  heartbeatMs?: number;
}

export interface TerminalHold {
  /** Hold `termId`, or pass `undefined` to release. Idempotent for an id that
   *  is already held over a live socket. */
  sync(termId: string | undefined): void;
  /** Re-send the visibility frame (call after a `visibilitychange` so a
   *  drain flip reaches the daemon without reconnecting). If the socket has
   *  dropped while we still intend to hold the id, reconnects immediately. */
  refresh(): void;
  /** Release the hold and tear the socket down. */
  close(): void;
  /** The id currently held, or undefined. */
  heldTermId(): string | undefined;
}

const RECONNECT_CAP_MS = 30_000;

export function createTerminalHold(deps: TerminalHoldDeps): TerminalHold {
  const schedule =
    deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule =
    deps.unschedule ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const reconnectBaseMs = deps.reconnectBaseMs ?? 1000;
  const heartbeatMs = deps.heartbeatMs ?? 0;

  let ws: HoldSocket | null = null;
  /** The id we currently *intend* to hold. Survives socket drops (that's how a
   *  reconnect knows to re-establish); cleared only on a deliberate release. */
  let intendedId: string | undefined;
  let reconnectHandle: unknown = null;
  let heartbeatHandle: unknown = null;
  let attempts = 0;

  function clearReconnect(): void {
    if (reconnectHandle !== null) {
      unschedule(reconnectHandle);
      reconnectHandle = null;
    }
  }

  function clearHeartbeat(): void {
    if (heartbeatHandle !== null) {
      unschedule(heartbeatHandle);
      heartbeatHandle = null;
    }
  }

  function sendVisibility(): void {
    if (!ws || ws.readyState !== HOLD_WS.OPEN) return;
    const drain = deps.shouldDrain ? deps.shouldDrain() : true;
    ws.send(JSON.stringify({ type: "visibility", visible: false, drain }));
  }

  function scheduleHeartbeat(): void {
    if (!heartbeatMs) return;
    clearHeartbeat();
    heartbeatHandle = schedule(() => {
      heartbeatHandle = null;
      if (!ws || ws.readyState !== HOLD_WS.OPEN) return;
      sendVisibility();
      scheduleHeartbeat();
    }, heartbeatMs);
  }

  function scheduleReconnect(): void {
    if (intendedId === undefined) return;
    if (reconnectHandle !== null) return;
    const delay = Math.min(reconnectBaseMs * 2 ** attempts, RECONNECT_CAP_MS);
    attempts += 1;
    reconnectHandle = schedule(() => {
      reconnectHandle = null;
      if (intendedId === undefined) return;
      connect(intendedId);
    }, delay);
  }

  /** Detach a socket's handlers and close it without triggering our own
   *  reconnect (handlers are nulled first, so its `onclose` never fires). */
  function teardownSocket(s: HoldSocket | null): void {
    if (!s) return;
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
    if (s.readyState === HOLD_WS.CONNECTING || s.readyState === HOLD_WS.OPEN) {
      s.close(1000, "terminal hold released");
    }
  }

  function connect(id: string): void {
    clearReconnect();
    const s = deps.connect(id);
    ws = s;
    s.onopen = () => {
      if (ws !== s) return;
      attempts = 0; // a successful connection resets backoff
      sendVisibility();
      scheduleHeartbeat();
    };
    s.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as {
          type?: unknown;
          awaitingInput?: unknown;
          working?: unknown;
        };
        if (parsed?.type !== "state") return;
        if (typeof parsed.awaitingInput === "boolean") {
          deps.onAwaiting?.(parsed.awaitingInput);
        }
        if (typeof parsed.working === "boolean") {
          deps.onWorking?.(parsed.working);
        }
      } catch {
        // Output / accounting frames aren't JSON state; this socket only
        // exists to keep the PTY alive, so anything else is safely ignored.
      }
    };
    s.onclose = () => {
      if (ws !== s) return;
      ws = null;
      clearHeartbeat();
      // Unexpected drop while we still intend to hold this id → reconnect.
      // A deliberate release nulls intendedId (and this handler) first, so
      // this only fires for genuine drops.
      if (intendedId === id) scheduleReconnect();
    };
  }

  function close(): void {
    clearReconnect();
    clearHeartbeat();
    attempts = 0;
    const s = ws;
    ws = null;
    intendedId = undefined;
    teardownSocket(s);
  }

  function sync(next: string | undefined): void {
    if (!next) {
      close();
      return;
    }
    // Already held over a live socket → nothing to do.
    if (
      ws &&
      intendedId === next &&
      ws.readyState !== HOLD_WS.CLOSING &&
      ws.readyState !== HOLD_WS.CLOSED
    ) {
      return;
    }
    // Switching to a different id: tear down the old socket and reset backoff.
    // (Reviving the *same* id after a drop falls through with the old socket
    // already null, so there's nothing to tear down.)
    if (intendedId !== next) {
      clearReconnect();
      clearHeartbeat();
      attempts = 0;
      const old = ws;
      ws = null;
      teardownSocket(old);
    }
    intendedId = next;
    connect(next);
  }

  function refresh(): void {
    if (intendedId === undefined) return;
    // Socket dropped while we were away (lock/minimize): reconnect now rather
    // than waiting out the backoff, so reveal recovers promptly.
    if (
      !ws ||
      ws.readyState === HOLD_WS.CLOSED ||
      ws.readyState === HOLD_WS.CLOSING
    ) {
      clearReconnect();
      attempts = 0;
      connect(intendedId);
      return;
    }
    sendVisibility();
  }

  return {
    sync,
    refresh,
    close,
    heldTermId: () => intendedId,
  };
}
