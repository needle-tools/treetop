/**
 * WebSocket bridge for the remote-daemon reverse proxy (Phase 4b).
 *
 * The live terminal is the only WebSocket in supergit. To make it work
 * against a remote daemon WITHOUT exposing the remote's WS, the local
 * daemon bridges two sockets:
 *
 *   browser ──WS──> LOCAL daemon ──client WS over ssh tunnel──> REMOTE (loopback)
 *
 * Bun has no built-in WS reverse-proxy, so RemoteWsBridge opens a client
 * WebSocket to the remote (at `ws://127.0.0.1:<localPort>/api/...`, the
 * tunnel's local end) and pipes frames both directions, tearing both ends
 * down together. The remote socket is reached only through the
 * authenticated tunnel on the remote's loopback — same trust path as the
 * HTTP proxy. See plans/PLAN-REMOTE-DAEMON.md.
 *
 * The bridge is unit-tested against a real in-process remote WS (Tier 2 —
 * daemon-ws-proxy.test.ts). The WebSocket constructor is injectable so the
 * default (global WebSocket) can be swapped in tests if needed.
 */

/** The browser-facing side of the bridge — satisfied by Bun's server
 *  `ServerWebSocket` (it has send + close). Kept minimal so a test fake
 *  also satisfies it. */
export interface BridgePeer {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Minimal client-WebSocket surface the bridge uses — a subset of the web
 *  standard WebSocket, so the global and a fake both fit. */
export interface ClientWebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

export type WsFactory = (url: string) => ClientWebSocketLike;

/** Normalize a WebSocket message payload to the string/bytes the peer
 *  expects. Binary may arrive as ArrayBuffer or a typed-array view. */
function toFrame(data: unknown): string | Uint8Array {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new Uint8Array(0);
}

export class RemoteWsBridge {
  private remote: ClientWebSocketLike;
  private open = false;
  private closed = false;
  private outbox: Array<string | Uint8Array> = [];

  constructor(
    remoteUrl: string,
    private browser: BridgePeer,
    wsFactory: WsFactory = (u) =>
      new WebSocket(u) as unknown as ClientWebSocketLike,
  ) {
    this.remote = wsFactory(remoteUrl);
    this.remote.addEventListener("open", () => {
      this.open = true;
      for (const m of this.outbox) this.remote.send(m);
      this.outbox = [];
    });
    this.remote.addEventListener("message", (ev) => {
      const data = (ev as { data?: unknown }).data;
      this.browser.send(toFrame(data));
    });
    this.remote.addEventListener("close", (ev) => {
      if (this.closed) return;
      this.closed = true;
      const e = ev as { code?: number; reason?: string };
      this.browser.close(e.code, e.reason);
    });
    this.remote.addEventListener("error", () => {
      // A connect failure or transport error: tear the browser side down.
      if (this.closed) return;
      this.closed = true;
      this.browser.close(1011, "remote ws error");
    });
  }

  /** Forward a browser frame to the remote. Frames sent before the remote
   *  socket is OPEN are buffered and flushed on open (keeps early
   *  keystrokes / the initial resize from being dropped). */
  sendToRemote(data: string | Uint8Array): void {
    if (this.closed) return;
    if (this.open) this.remote.send(data);
    else this.outbox.push(data);
  }

  /** Browser closed (or the route is tearing down): close the remote too. */
  closeRemote(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.remote.close(code, reason);
    } catch {
      // already closing / closed
    }
  }
}
