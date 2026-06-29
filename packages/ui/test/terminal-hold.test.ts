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

interface FakeTimer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function harness(
  shouldDrain?: () => boolean,
  onAwaiting?: (a: boolean) => void,
  opts?: { heartbeatMs?: number },
) {
  const sockets: FakeSocket[] = [];
  const timers: FakeTimer[] = [];
  const hold = createTerminalHold({
    connect: (termId) => {
      const s = new FakeSocket();
      (s as FakeSocket & { termId: string }).termId = termId;
      sockets.push(s);
      return s;
    },
    shouldDrain,
    onAwaiting,
    schedule: (fn, ms) => {
      const t: FakeTimer = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    unschedule: (h) => {
      (h as FakeTimer).cancelled = true;
    },
    reconnectBaseMs: 1000,
    heartbeatMs: opts?.heartbeatMs,
  });
  // Fire all currently-pending (non-cancelled) timers, FIFO. New timers
  // scheduled during firing stay pending for the next call.
  function fireTimers(): void {
    const pending = timers.splice(0).filter((t) => !t.cancelled);
    for (const t of pending) t.fn();
  }
  return { hold, sockets, timers, fireTimers };
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

  test("a working state frame is surfaced via onWorking (dock activity spinner)", () => {
    const seenWorking: boolean[] = [];
    const sockets: FakeSocket[] = [];
    const hold = createTerminalHold({
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onWorking: (w) => seenWorking.push(w),
    });
    hold.sync("term-1");
    sockets[0]!.open();
    sockets[0]!.message(JSON.stringify({ type: "state", working: true }));
    sockets[0]!.message(JSON.stringify({ type: "state", working: false }));
    expect(seenWorking).toEqual([true, false]);
  });

  test("an awaiting-only edge frame does not clear the working spinner", () => {
    const seenAwaiting: boolean[] = [];
    const seenWorking: boolean[] = [];
    const sockets: FakeSocket[] = [];
    const hold = createTerminalHold({
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onAwaiting: (a) => seenAwaiting.push(a),
      onWorking: (w) => seenWorking.push(w),
    });
    hold.sync("term-1");
    sockets[0]!.open();
    // The daemon emits awaiting-clear frames with no `working` field — those
    // must not be read as "working: false".
    sockets[0]!.message(JSON.stringify({ type: "state", awaitingInput: false }));
    expect(seenAwaiting).toEqual([false]);
    expect(seenWorking).toEqual([]);
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

  test("an unexpected server close auto-reconnects (the PTY must not be reaped)", () => {
    const { hold, sockets, fireTimers } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    sockets[0]!.serverClose();
    // The hold is still intended — losing the socket must not release it.
    expect(hold.heldTermId()).toBe("term-1");
    // A reconnect is scheduled; firing it opens a fresh socket to the same id.
    fireTimers();
    expect(sockets).toHaveLength(2);
    expect((sockets[1] as FakeSocket & { termId: string }).termId).toBe(
      "term-1",
    );
    // And the new socket resumes the muted subscription on open.
    sockets[1]!.open();
    expect(lastVisibility(sockets[1]!).visible).toBe(false);
  });

  test("a deliberate close() does not reconnect", () => {
    const { hold, sockets, fireTimers } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.close();
    fireTimers();
    expect(sockets).toHaveLength(1);
    expect(hold.heldTermId()).toBeUndefined();
  });

  test("releasing via sync(undefined) does not reconnect on the trailing close", () => {
    const { hold, sockets, fireTimers } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.sync(undefined);
    // A real WebSocket fires onclose after .close(); that must not revive it.
    sockets[0]!.serverClose();
    fireTimers();
    expect(sockets).toHaveLength(1);
    expect(hold.heldTermId()).toBeUndefined();
  });

  test("switching id does not reconnect the old socket when it later closes", () => {
    const { hold, sockets, fireTimers } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    hold.sync("term-2");
    // The old socket's delayed onclose must not schedule a reconnect to term-1.
    sockets[0]!.serverClose();
    fireTimers();
    const ids = sockets.map(
      (s) => (s as FakeSocket & { termId: string }).termId,
    );
    expect(ids).toEqual(["term-1", "term-2"]);
    expect(hold.heldTermId()).toBe("term-2");
  });

  test("refresh() reconnects immediately when the socket has dropped (resume from lock)", () => {
    const { hold, sockets } = harness();
    hold.sync("term-1");
    sockets[0]!.open();
    sockets[0]!.serverClose();
    // Coming back into view: refresh must reconnect right away, without
    // waiting for the backoff timer to fire.
    hold.refresh();
    expect(sockets).toHaveLength(2);
    expect(hold.heldTermId()).toBe("term-1");
  });

  test("reconnect backoff grows on consecutive drops, resets after a success", () => {
    const { hold, sockets, timers, fireTimers } = harness();
    hold.sync("term-1");
    sockets[0]!.open();

    sockets[0]!.serverClose();
    const firstDelay = timers.filter((t) => !t.cancelled).at(-1)!.ms;
    fireTimers(); // reconnect attempt #2 created (still CONNECTING, never opened)
    sockets[1]!.serverClose();
    const secondDelay = timers.filter((t) => !t.cancelled).at(-1)!.ms;
    expect(secondDelay).toBeGreaterThan(firstDelay);

    // A successful open resets the backoff for the next drop.
    fireTimers();
    sockets[2]!.open();
    sockets[2]!.serverClose();
    const afterSuccessDelay = timers.filter((t) => !t.cancelled).at(-1)!.ms;
    expect(afterSuccessDelay).toBe(firstDelay);
  });

  test("heartbeat re-sends the visibility frame to keep an idle hold warm", () => {
    const { hold, sockets, fireTimers } = harness(undefined, undefined, {
      heartbeatMs: 25_000,
    });
    hold.sync("term-1");
    sockets[0]!.open();
    const before = sockets[0]!.sent.length;
    fireTimers(); // fire the heartbeat
    expect(sockets[0]!.sent.length).toBeGreaterThan(before);
    expect(lastVisibility(sockets[0]!).visible).toBe(false);
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
