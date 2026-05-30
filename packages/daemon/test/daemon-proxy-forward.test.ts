import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { forwardToRemote, parseDaemonProxyPath } from "../src/daemon-proxy";

/**
 * TIER 2 — in-process two-"daemon" proxy test.
 *
 * Spins up a SECOND `Bun.serve` in THIS process as a stand-in remote
 * daemon, then drives forwardToRemote() at its real port. No child
 * process, no ssh, no temp workspace — just two in-process servers, so
 * it's fast and safe enough to run in the default suite. It exercises the
 * real proxy code path (fetch → stream response back, header/status/body
 * passthrough, error handling) which the pure parse/url unit tests can't.
 *
 * The tunnel's job is "make the remote reachable at 127.0.0.1:<port>" —
 * here the fake remote already IS on 127.0.0.1:<port>, so pointing the
 * proxy straight at it tests everything except the ssh hop itself.
 *
 * TIER 3 (LATER, opt-in, NOT in the default suite): a `bun run
 * test:two-daemon` runner that Bun.spawns the REAL daemon entrypoint on a
 * dedicated TEST port + temp workspace, optionally over a real `ssh -L`
 * to localhost, and asserts the genuine /api/repos shape + live SSE
 * stream. Env-guarded (SUPERGIT_TWO_DAEMON_TESTS=1) so a stray `bun test`
 * skips it; never touches prod (:27787); guaranteed teardown. See
 * plans/PLAN-REMOTE-DAEMON.md → "Two-daemon integration tests".
 */

const NO_CORS: Record<string, string> = {};

// A minimal fake remote daemon: answers a few /api/* routes the way the
// real one would, including a streamed NDJSON body and an echo of the
// request method/headers/body so the test can assert passthrough.
// Inferred from Bun.serve — annotating as `Server` needs a type arg under
// this tsconfig, and the inferred type is exactly right here.
let remote: ReturnType<typeof Bun.serve>;
let remotePort: number;

beforeAll(() => {
  remote = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/health") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.pathname === "/api/echo") {
        // Reflect what we received so the proxy's forwarding is observable.
        const body = req.method === "GET" ? "" : await req.text();
        return new Response(
          JSON.stringify({
            method: req.method,
            xTest: req.headers.get("x-test"),
            hadHost: req.headers.has("host"),
            query: u.search,
            body,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.pathname === "/api/repos") {
        // Streamed NDJSON, like the real repo list — proves the proxy
        // streams the body instead of buffering/altering it.
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`{"id":"a"}\n`));
            c.enqueue(enc.encode(`{"id":"b"}\n`));
            c.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }
      return new Response("nope", { status: 404 });
    },
  });
  remotePort = remote.port;
});

afterAll(() => {
  remote.stop(true);
});

describe("forwardToRemote (Tier 2: real in-process remote)", () => {
  test("proxies a GET and passes status + JSON body through", async () => {
    const proxied = parseDaemonProxyPath("/api/daemons/d1/health")!;
    const req = new Request("http://local/api/daemons/d1/health");
    const res = await forwardToRemote(remotePort, proxied, req, "", NO_CORS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("forwards method, custom headers, query, and body; strips Host", async () => {
    const proxied = parseDaemonProxyPath("/api/daemons/d1/echo")!;
    const req = new Request("http://local/api/daemons/d1/echo?x=1", {
      method: "POST",
      headers: { "x-test": "hello", host: "local" },
      body: "payload",
    });
    const res = await forwardToRemote(
      remotePort,
      proxied,
      req,
      "?x=1",
      NO_CORS,
    );
    expect(res.status).toBe(201);
    const got = await res.json();
    expect(got.method).toBe("POST");
    expect(got.xTest).toBe("hello");
    expect(got.query).toBe("?x=1");
    expect(got.body).toBe("payload");
  });

  test("streams an NDJSON body through unaltered", async () => {
    const proxied = parseDaemonProxyPath("/api/daemons/d1/repos")!;
    const req = new Request("http://local/api/daemons/d1/repos");
    const res = await forwardToRemote(remotePort, proxied, req, "", NO_CORS);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(await res.text()).toBe(`{"id":"a"}\n{"id":"b"}\n`);
  });

  test("passes the remote's 404 through (not rewritten to 502)", async () => {
    const proxied = parseDaemonProxyPath("/api/daemons/d1/missing")!;
    const req = new Request("http://local/api/daemons/d1/missing");
    const res = await forwardToRemote(remotePort, proxied, req, "", NO_CORS);
    expect(res.status).toBe(404);
  });

  test("applies the provided CORS headers to the proxied response", async () => {
    const proxied = parseDaemonProxyPath("/api/daemons/d1/health")!;
    const req = new Request("http://local/api/daemons/d1/health");
    const res = await forwardToRemote(remotePort, proxied, req, "", {
      "Access-Control-Allow-Origin": "http://example",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://example",
    );
  });

  test("returns 502 when the remote is unreachable", async () => {
    // Nothing is listening on this port — the tunnel/remote is down.
    const deadPort = 1; // privileged + nothing there → connection fails fast
    const proxied = parseDaemonProxyPath("/api/daemons/d1/health")!;
    const req = new Request("http://local/api/daemons/d1/health");
    const res = await forwardToRemote(deadPort, proxied, req, "", NO_CORS);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/unreachable/);
  });
});
