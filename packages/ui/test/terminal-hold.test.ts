/**
 * Behaviour tests for the offscreen "terminal hold" socket manager.
 *
 * Background: commit 4d61ab6 ("Defer offscreen layout and terminal work")
 * stopped mounting TerminalView for offscreen session columns. Without any
 * WebSocket subscriber the daemon's 60s grace timer (server.ts GRACE_MS)
 * reaps the PTY — the agent session dies and drops out of the dock. The
 * hold socket keeps a muted subscriber alive so the PTY survives, and (unlike
 * the original inline version) reports drain based on tab visibility so the
 * agent keeps RUNNING while merely scrolled off-screen / in zen mode.
 *
 * These exercise the real createTerminalHold() against a fake socket — no DOM,
 * no real WebSocket.
 */

import { test, expect, describe } from "bun:test";
import {
  createTerminalHold,
  HOLD_WS,
  type HoldSocket,
} from "../src/terminal-hold";

class FakeSocket implements HoldSocket {
  readyState: number = HOLD_WS.CONNECTING;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = HOLD_WS.CLOSED;
  }

  // --- test drivers ---
  open(): void {
    this.readyState = HOLD_WS.OPEN;
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(): void {
    this.readyState = HOLD_WS.CLOSED;
    this.onclose?.();
  }
}

function harness(
  shouldDrain?: () => boolean,
  onAwaiting?: (a: boolean) => void,
) {
  const sockets: FakeSocket[] = [];
  const hold = createTerminalHold({
    connect: (termId) => {
      const s = new FakeSocket();
      (s as FakeSocket & { termId: string }).termId = termId;
      sockets.push(s);
      return s;
    },
    shouldDrain,
    onAwaiting,
  });
  return { hold, sockets };
}

function lastVisibility(s: FakeSocket): { visible: boolean; drain: boolean } {
  const frame = [...s.sent].reverse().find((m) => m.includes('"visibility"'));
  if (!frame) throw new Error("no visibility frame sent");
  return JSON.parse(frame);
}

describe("createTerminalHold", () => {
  test("opening a hold connects once and sends a non-painting visibility frame", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    expect(sockets).toHaveLength(1);
    // Nothing is sent until the socket is actually open.
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.open();
    const frame = lastVisibility(sockets[0]!);
    expect(frame.visible).toBe(false); // no xterm to paint into
    expect(frame.drain).toBe(true); // default: keep the agent running
    expect(hold.heldTermId()).toBe("term-1");
  });

  test("drain follows shouldDrain() so a backgrounded tab mutes the agent", () => {
    let visible = false; // tab is hidden
    const { hold, sockets } = harness(() => visible);
    hold.sync("term-1");
    sockets[0]!.open();
    expect(lastVisibility(sockets[0]!).drain).toBe(false);

    // Tab comes to the foreground — refresh re-sends with drain=true so the
    // daemon stops muting and the agent resumes.
    visible = true;
    hold.refresh();
    expect(lastVisibility(sockets[0]!).drain).toBe(true);
  });

  test("syncing the same id again does not reconnect", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.sync("term-1");
    expect(sockets).toHaveLength(1);
  });

  test("syncing undefined releases the hold (client-initiated close)", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.sync(undefined);
    expect(sockets[0]!.closed).not.toBeNull();
    expect(hold.heldTermId()).toBeUndefined();
  });

  test("switching id closes the old socket and opens a new one", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.sync("term-2");
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.closed).not.toBeNull();
    expect((sockets[1] as FakeSocket & { termId: string }).termId).toBe(
      "term-2",
    );
    expect(hold.heldTermId()).toBe("term-2");
  });

  test("an awaiting-input state frame is surfaced via onAwaiting", () => {
    const seen: boolean[] = [];
    const { hold, sockets } = harness(undefined, (a) => seen.push(a));
    hold.sync("term-1");
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({ type: "state", awaitingInput: true }));
    expect(seen).toEqual([true]);
  });

  test("output / non-JSON / unrelated frames are ignored without throwing", () => {
    const seen: boolean[] = [];
    const { hold, sockets } = harness(undefined, (a) => seen.push(a));
    hold.sync("term-1");
    sockets[0]!.open();
    expect(() => {
      sockets[0]!.message(new Uint8Array([1, 2, 3])); // binary output frame
      sockets[0]!.message("not json");
      sockets[0]!.message(JSON.stringify({ type: "metrics", rx: 10 }));
    }).not.toThrow();
    expect(seen).toEqual([]);
  });

  test("a server-side close clears internal state so a later sync reconnects", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    sockets[0]!.serverClose();
    expect(hold.heldTermId()).toBeUndefined();
    hold.sync("term-1");
    expect(sockets).toHaveLength(2);
  });

  test("close() tears down an open hold", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.close();
    expect(sockets[0]!.closed).not.toBeNull();
    expect(hold.heldTermId()).toBeUndefined();
  });
});
