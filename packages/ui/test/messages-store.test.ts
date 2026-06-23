/**
 * Tests for the header Messages inbox store. The reactive surface that
 * matters here is the unread-badge math: `totalCount` / `unreadCount`
 * are what App.svelte feeds the badge, and the rules ("outbound never
 * counts", "muted senders are silent", "no baseline → everything is
 * unread") are subtle enough to regress silently. The fetch wrappers
 * (refreshMessages/sendMessage/…) are thin ceremony over the daemon and
 * aren't exercised here — the counting logic and the lastRead
 * persistence are the bug-prone parts.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { get } from "svelte/store";
import {
  messages,
  refreshMessages,
  totalCount,
  unreadCount,
  recallLastRead,
  markInboxRead,
  type InboxSnapshot,
} from "../src/messages-store";

/** Build a snapshot from a compact spec so the tests read as data. */
function snap(
  rows: Array<{
    peer: string;
    muted?: boolean;
    msgs: Array<{ at: string; dir?: "in" | "out" }>;
  }>,
): InboxSnapshot {
  const mutes: Record<string, string> = {};
  const inbox = rows.map((r) => {
    if (r.muted) mutes[r.peer] = "2999-01-01T00:00:00.000Z";
    return {
      peer: { id: r.peer, label: r.peer },
      messages: r.msgs.map((m, i) => ({
        id: `${r.peer}-${i}`,
        body: "x",
        sentAt: m.at,
        receivedAt: m.at,
        direction: m.dir,
      })),
    };
  });
  return { inbox, mutes };
}

describe("totalCount", () => {
  test("is zero for an empty inbox", () => {
    expect(totalCount({ inbox: [], mutes: {} })).toBe(0);
  });

  test("counts every inbound message across senders", () => {
    const s = snap([
      {
        peer: "alice",
        msgs: [{ at: "2026-01-01T00:00:00Z" }, { at: "2026-01-02T00:00:00Z" }],
      },
      { peer: "bob", msgs: [{ at: "2026-01-03T00:00:00Z" }] },
    ]);
    expect(totalCount(s)).toBe(3);
  });

  test("excludes outbound ('out') messages — those are ours", () => {
    const s = snap([
      {
        peer: "alice",
        msgs: [
          { at: "2026-01-01T00:00:00Z", dir: "in" },
          { at: "2026-01-02T00:00:00Z", dir: "out" },
          { at: "2026-01-03T00:00:00Z", dir: "out" },
        ],
      },
    ]);
    expect(totalCount(s)).toBe(1);
  });

  test("treats messages with no direction field as inbound (back-compat)", () => {
    // Older stored messages predate the direction field; they must still
    // count toward the badge or old conversations silently stop alerting.
    const s = snap([{ peer: "alice", msgs: [{ at: "2026-01-01T00:00:00Z" }] }]);
    expect(totalCount(s)).toBe(1);
  });

  test("a muted sender contributes nothing", () => {
    const s = snap([
      {
        peer: "alice",
        muted: true,
        msgs: [{ at: "2026-01-01T00:00:00Z" }, { at: "2026-01-02T00:00:00Z" }],
      },
      { peer: "bob", msgs: [{ at: "2026-01-03T00:00:00Z" }] },
    ]);
    expect(totalCount(s)).toBe(1);
  });
});

describe("unreadCount", () => {
  test("with no baseline, falls back to totalCount (every inbound is unread)", () => {
    const s = snap([
      {
        peer: "alice",
        msgs: [{ at: "2026-01-01T00:00:00Z" }, { at: "2026-01-02T00:00:00Z" }],
      },
    ]);
    expect(unreadCount(s, null)).toBe(2);
  });

  test("counts only inbound messages received strictly after the baseline", () => {
    const s = snap([
      {
        peer: "alice",
        msgs: [
          { at: "2026-01-01T00:00:00Z" },
          { at: "2026-01-03T00:00:00Z" },
          { at: "2026-01-04T00:00:00Z" },
        ],
      },
    ]);
    // baseline at Jan 2 → the Jan 1 message is read, Jan 3 + Jan 4 unread.
    expect(unreadCount(s, "2026-01-02T00:00:00Z")).toBe(2);
  });

  test("a message exactly at the baseline is considered read (strict >)", () => {
    const s = snap([
      { peer: "alice", msgs: [{ at: "2026-01-02T00:00:00.000Z" }] },
    ]);
    expect(unreadCount(s, "2026-01-02T00:00:00.000Z")).toBe(0);
  });

  test("an unparseable baseline degrades to totalCount rather than zero", () => {
    // Better to over-alert than to silently hide messages because a
    // corrupt timestamp made the cutoff NaN.
    const s = snap([{ peer: "alice", msgs: [{ at: "2026-01-01T00:00:00Z" }] }]);
    expect(unreadCount(s, "not-a-date")).toBe(1);
  });

  test("ignores outbound messages even when newer than the baseline", () => {
    const s = snap([
      {
        peer: "alice",
        msgs: [
          { at: "2026-01-03T00:00:00Z", dir: "out" },
          { at: "2026-01-03T00:00:00Z", dir: "in" },
        ],
      },
    ]);
    expect(unreadCount(s, "2026-01-02T00:00:00Z")).toBe(1);
  });

  test("ignores muted senders even when their messages are newer", () => {
    const s = snap([
      { peer: "alice", muted: true, msgs: [{ at: "2026-01-05T00:00:00Z" }] },
      { peer: "bob", msgs: [{ at: "2026-01-05T00:00:00Z" }] },
    ]);
    expect(unreadCount(s, "2026-01-01T00:00:00Z")).toBe(1);
  });

  test("skips inbound messages whose receivedAt is unparseable", () => {
    const s = snap([
      {
        peer: "alice",
        msgs: [{ at: "garbage" }, { at: "2026-01-05T00:00:00Z" }],
      },
    ]);
    expect(unreadCount(s, "2026-01-01T00:00:00Z")).toBe(1);
  });
});

describe("messages store", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    messages.set({ inbox: [], mutes: {} });
    globalThis.fetch = originalFetch;
  });

  test("starts empty", () => {
    expect(get(messages)).toEqual({ inbox: [], mutes: {} });
  });

  test("set notifies subscribers (reactivity)", () => {
    const seen: InboxSnapshot[] = [];
    const unsub = messages.subscribe((v) => seen.push(v));
    messages.set(
      snap([{ peer: "alice", msgs: [{ at: "2026-01-01T00:00:00Z" }] }]),
    );
    unsub();
    // Initial emission + the set = two values.
    expect(seen.length).toBe(2);
    expect(totalCount(seen[1]!)).toBe(1);
  });

  test("serializes overlapping refreshes into one in-flight request and one follow-up", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) {
        await firstGate;
        return Response.json(
          snap([{ peer: "first", msgs: [{ at: "2026-01-01T00:00:00Z" }] }]),
        );
      }
      return Response.json(
        snap([{ peer: "second", msgs: [{ at: "2026-01-02T00:00:00Z" }] }]),
      );
    }) as typeof fetch;

    const first = refreshMessages();
    const second = refreshMessages();
    await Promise.resolve();

    expect(calls).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(2);
    expect(get(messages).inbox[0]?.peer.id).toBe("second");
  });
});

describe("lastRead persistence", () => {
  // The module reads/writes the bare global `localStorage`. Under Bun
  // that's undefined, so we inject one to drive the round-trip and
  // restore afterwards so we don't leak a global into sibling files.
  const KEY = "supergit.inbox.lastReadAt";

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test("recallLastRead returns null when storage is unavailable (Bun default)", () => {
    expect(recallLastRead()).toBeNull();
  });

  test("markInboxRead returns an ISO timestamp even when storage is unavailable", () => {
    const ts = markInboxRead();
    expect(Number.isFinite(Date.parse(ts))).toBe(true);
  });

  test("markInboxRead → recallLastRead round-trips through localStorage", () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const stamped = markInboxRead();
    expect(mem.get(KEY)).toBe(stamped);
    expect(recallLastRead()).toBe(stamped);
  });
});
