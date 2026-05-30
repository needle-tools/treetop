import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { RemoteWsBridge, type BridgePeer } from "../src/daemon-ws-proxy";
import { buildProxyWsUrl } from "../src/daemon-proxy";

/**
 * TIER 2 — in-process WebSocket bridge test.
 *
 * The live terminal (the ONLY WebSocket in supergit) must work against a
 * remote daemon. The browser opens a WS to the LOCAL daemon; the local
 * daemon opens its OWN client WS to the remote daemon's loopback through
 * the ssh tunnel and bridges bytes both ways. The remote WS is never
 * exposed — it rides the same authenticated tunnel as the HTTP proxy.
 *
 * This spins up a SECOND Bun.serve in-process with a WS echo endpoint
 * (stand-in remote daemon) and drives RemoteWsBridge at its real port —
 * no child process, no ssh. It proves the bridge pipes browser→remote and
 * remote→browser, buffers pre-open sends, and propagates close.
 *
 * TIER 3 (LATER, opt-in): the gated `test:two-daemon` runner does this
 * against the REAL daemon over a real `ssh -L`. See PLAN-REMOTE-DAEMON.md.
 */

let remote: ReturnType<typeof Bun.serve>;
let remotePort: number;

beforeAll(() => {
  remote = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      if (/^\/api\/terminals\/[^/]+\/io$/.test(u.pathname)) {
        if (srv.upgrade(req, { data: {} }))
          return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("nope", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send("hello"); // remote → browser, unprompted (like PTY banner)
      },
      message(ws, msg) {
        // A sentinel lets a test trigger a REMOTE-initiated close (the
        // remote daemon's PTY exiting), distinct from the browser closing.
        if (msg === "__close__") {
          ws.close(1000, "done");
          return;
        }
        // Echo so the test can observe browser → remote round trips.
        if (typeof msg === "string") ws.send(`echo:${msg}`);
        else ws.send(msg); // binary echoed verbatim (keystrokes path)
      },
    },
  });
  remotePort = remote.port!;
});

afterAll(() => {
  remote.stop(true);
});

/** Poll until `cond()` is true or time runs out. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Bun.nanoseconds();
  while (!cond()) {
    if ((Bun.nanoseconds() - start) / 1e6 > ms) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(5);
  }
}

function recordingPeer() {
  const frames: Array<string | Uint8Array> = [];
  let closed = false;
  let closeCode: number | undefined;
  const peer: BridgePeer = {
    send: (d) => frames.push(d),
    close: (code) => {
      closed = true;
      closeCode = code;
    },
  };
  return {
    peer,
    frames,
    get closed() {
      return closed;
    },
    get closeCode() {
      return closeCode;
    },
  };
}

describe("buildProxyWsUrl", () => {
  test("builds a ws:// loopback URL with the /api prefix + query", () => {
    expect(buildProxyWsUrl(7801, "/terminals/t9/io", "")).toBe(
      "ws://127.0.0.1:7801/api/terminals/t9/io",
    );
    expect(buildProxyWsUrl(7801, "/terminals/t9/io", "?x=1")).toBe(
      "ws://127.0.0.1:7801/api/terminals/t9/io?x=1",
    );
  });
});

describe("RemoteWsBridge (Tier 2: real in-process remote WS)", () => {
  test("forwards remote → browser frames (incl. the unprompted banner)", async () => {
    const b = recordingPeer();
    const bridge = new RemoteWsBridge(
      `ws://127.0.0.1:${remotePort}/api/terminals/t1/io`,
      b.peer,
    );
    await waitFor(() => b.frames.includes("hello"));
    expect(b.frames).toContain("hello");
    bridge.closeRemote();
  });

  test("forwards browser → remote frames and relays the echo back", async () => {
    const b = recordingPeer();
    const bridge = new RemoteWsBridge(
      `ws://127.0.0.1:${remotePort}/api/terminals/t1/io`,
      b.peer,
    );
    await waitFor(() => b.frames.includes("hello"));
    bridge.sendToRemote("ping");
    await waitFor(() => b.frames.includes("echo:ping"));
    expect(b.frames).toContain("echo:ping");
    bridge.closeRemote();
  });

  test("buffers a browser frame sent before the remote socket opens", async () => {
    const b = recordingPeer();
    const bridge = new RemoteWsBridge(
      `ws://127.0.0.1:${remotePort}/api/terminals/t1/io`,
      b.peer,
    );
    // Send immediately — the remote WS almost certainly isn't OPEN yet.
    bridge.sendToRemote("early");
    await waitFor(() => b.frames.includes("echo:early"));
    expect(b.frames).toContain("echo:early");
    bridge.closeRemote();
  });

  test("round-trips a binary frame (keystrokes path)", async () => {
    const b = recordingPeer();
    const bridge = new RemoteWsBridge(
      `ws://127.0.0.1:${remotePort}/api/terminals/t1/io`,
      b.peer,
    );
    await waitFor(() => b.frames.includes("hello"));
    bridge.sendToRemote(new Uint8Array([1, 2, 3]));
    await waitFor(() =>
      b.frames.some(
        (f) =>
          f instanceof Uint8Array &&
          f.length === 3 &&
          f[0] === 1 &&
          f[2] === 3,
      ),
    );
    bridge.closeRemote();
  });

  test("propagates a remote-initiated close to the browser peer", async () => {
    const b = recordingPeer();
    const bridge = new RemoteWsBridge(
      `ws://127.0.0.1:${remotePort}/api/terminals/t1/io`,
      b.peer,
    );
    await waitFor(() => b.frames.includes("hello"));
    // Ask the remote to close (stands in for the remote PTY exiting). The
    // bridge must relay that close down to the browser peer.
    bridge.sendToRemote("__close__");
    await waitFor(() => b.closed);
    expect(b.closed).toBe(true);
    void bridge;
  });

  test("a failed remote connection closes the browser peer", async () => {
    const b = recordingPeer();
    // Nothing listening here → the client WS errors.
    new RemoteWsBridge(`ws://127.0.0.1:1/api/terminals/t1/io`, b.peer);
    await waitFor(() => b.closed);
    expect(b.closed).toBe(true);
  });
});
