/**
 * Heartbeat for `/api/stream`. Without a periodic ping the only way an
 * EventSource learns its connection is dead is via TCP error — which on
 * Windows after a sleep/wake (or behind a proxy that drops idle conns)
 * can take *minutes*, during which the dashboard shows stale data and
 * the "● connected" pill is silently lying.
 *
 * Mitigation: emit a `: ping\n\n` SSE comment to every subscriber on a
 * fixed interval. SSE comments are ignored by EventSource — no client
 * change needed — but they exercise the socket so a half-open TCP
 * connection errors fast and the client can reconnect.
 *
 * This test pins the helper's behavior: payload format and the
 * self-pruning semantics on broken controllers (same pattern as
 * broadcast() in server.ts).
 */

import { test, expect, describe } from "bun:test";
import { pingSubscribers } from "../src/sse-heartbeat";

function fakeController(): {
  ctrl: ReadableStreamDefaultController<Uint8Array>;
  enqueued: Uint8Array[];
} {
  const enqueued: Uint8Array[] = [];
  const ctrl = {
    enqueue: (chunk: Uint8Array) => {
      enqueued.push(chunk);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { ctrl, enqueued };
}

function brokenController(): ReadableStreamDefaultController<Uint8Array> {
  return {
    enqueue: () => {
      throw new Error("controller closed");
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
}

describe("pingSubscribers", () => {
  test("writes an SSE comment frame to every subscriber", () => {
    const a = fakeController();
    const b = fakeController();
    const subs = new Set([a.ctrl, b.ctrl]);

    pingSubscribers(subs);

    expect(a.enqueued.length).toBe(1);
    expect(b.enqueued.length).toBe(1);

    // SSE comment frame: starts with ':' and terminated by blank line.
    // EventSource silently discards these, so the format must stay
    // exactly `: ping\n\n` (any deviation and a strict parser could
    // surface it as an unknown event).
    const decoded = new TextDecoder().decode(a.enqueued[0]);
    expect(decoded).toBe(": ping\n\n");
  });

  test("prunes controllers whose enqueue throws (closed stream)", () => {
    const live = fakeController();
    const dead = brokenController();
    const subs = new Set([live.ctrl, dead]);

    pingSubscribers(subs);

    expect(subs.has(dead)).toBe(false);
    expect(subs.has(live.ctrl)).toBe(true);
    expect(live.enqueued.length).toBe(1);
  });

  test("no-ops on empty subscriber set", () => {
    const subs = new Set<ReadableStreamDefaultController<Uint8Array>>();
    expect(() => pingSubscribers(subs)).not.toThrow();
    expect(subs.size).toBe(0);
  });
});
