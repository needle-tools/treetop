/**
 * Per-peer message inbox: small ring buffer (last 5 per sender),
 * plus a mute store. Both are file-backed under the workspace so
 * they survive daemon restarts.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addIncomingMessage,
  getMessages,
  mutePeer,
  unmutePeer,
  isPeerMuted,
  MAX_PER_PEER,
} from "../src/messages";

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-messages-"));
}

describe("addIncomingMessage + getMessages", () => {
  test("empty workspace returns empty inbox", async () => {
    const w = await ws();
    expect(await getMessages(w)).toEqual([]);
  });

  test("a single message round-trips", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "hello",
      sentAt: "2026-05-22T10:00:00Z",
    });
    const got = await getMessages(w);
    expect(got).toHaveLength(1);
    expect(got[0]?.peer.id).toBe("peer-a");
    expect(got[0]?.peer.label).toBe("Alice");
    expect(got[0]?.messages).toHaveLength(1);
    expect(got[0]?.messages[0]?.body).toBe("hello");
    expect(got[0]?.messages[0]?.sentAt).toBe("2026-05-22T10:00:00Z");
  });

  test("rings cap at MAX_PER_PEER messages (newest first)", async () => {
    const w = await ws();
    for (let i = 0; i < MAX_PER_PEER + 3; i++) {
      await addIncomingMessage(w, {
        from: { id: "peer-a", label: "Alice" },
        body: `msg ${i}`,
        sentAt: `2026-05-22T10:${String(i).padStart(2, "0")}:00Z`,
      });
    }
    const got = await getMessages(w);
    expect(got[0]?.messages).toHaveLength(MAX_PER_PEER);
    // Newest first — last pushed message should be at index 0
    expect(got[0]?.messages[0]?.body).toBe(`msg ${MAX_PER_PEER + 2}`);
    // Oldest of the surviving five should be index 4
    expect(got[0]?.messages[MAX_PER_PEER - 1]?.body).toBe("msg 3");
  });

  test("multiple peers each keep their own ring", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "from A",
      sentAt: "2026-05-22T10:00:00Z",
    });
    await addIncomingMessage(w, {
      from: { id: "peer-b", label: "Bob" },
      body: "from B",
      sentAt: "2026-05-22T10:00:01Z",
    });
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "from A again",
      sentAt: "2026-05-22T10:00:02Z",
    });
    const got = await getMessages(w);
    expect(got).toHaveLength(2);
    const a = got.find((g) => g.peer.id === "peer-a");
    const b = got.find((g) => g.peer.id === "peer-b");
    expect(a?.messages).toHaveLength(2);
    expect(b?.messages).toHaveLength(1);
  });

  test("label refresh: last-seen peer label wins", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Old name" },
      body: "first",
      sentAt: "2026-05-22T10:00:00Z",
    });
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "New name" },
      body: "second",
      sentAt: "2026-05-22T10:00:01Z",
    });
    const got = await getMessages(w);
    expect(got[0]?.peer.label).toBe("New name");
  });

  test("groups are sorted by most-recent-message desc", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "earlier",
      sentAt: "2026-05-22T10:00:00Z",
    });
    await addIncomingMessage(w, {
      from: { id: "peer-b", label: "Bob" },
      body: "later",
      sentAt: "2026-05-22T10:05:00Z",
    });
    const got = await getMessages(w);
    expect(got[0]?.peer.id).toBe("peer-b");
    expect(got[1]?.peer.id).toBe("peer-a");
  });

  test("persists across calls (file-backed)", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "hi",
      sentAt: "2026-05-22T10:00:00Z",
    });
    // Confirm the file exists with the right shape
    const raw = JSON.parse(await readFile(join(w, "messages.json"), "utf-8"));
    expect(raw.byPeer["peer-a"].messages[0].body).toBe("hi");
  });

  test("malformed messages.json on disk is treated as empty (self-heals on next write)", async () => {
    const w = await ws();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(w, "messages.json"), "not json");
    expect(await getMessages(w)).toEqual([]);
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "ok",
      sentAt: "2026-05-22T10:00:00Z",
    });
    const got = await getMessages(w);
    expect(got).toHaveLength(1);
  });
});

describe("mutePeer / unmutePeer / isPeerMuted", () => {
  test("a fresh workspace has nobody muted", async () => {
    const w = await ws();
    expect(await isPeerMuted(w, "peer-a")).toBe(false);
  });

  test("mutePeer with a positive duration mutes for that many minutes", async () => {
    const w = await ws();
    await mutePeer(w, "peer-a", 60);
    expect(await isPeerMuted(w, "peer-a")).toBe(true);
  });

  test("mute auto-expires past the deadline", async () => {
    const w = await ws();
    const { writeFile } = await import("node:fs/promises");
    // Plant an expiry one minute in the past
    const past = new Date(Date.now() - 60_000).toISOString();
    await writeFile(
      join(w, "peer-mutes.json"),
      JSON.stringify({ "peer-a": past }),
    );
    expect(await isPeerMuted(w, "peer-a")).toBe(false);
  });

  test("unmutePeer clears the entry", async () => {
    const w = await ws();
    await mutePeer(w, "peer-a", 60);
    expect(await isPeerMuted(w, "peer-a")).toBe(true);
    await unmutePeer(w, "peer-a");
    expect(await isPeerMuted(w, "peer-a")).toBe(false);
  });

  test("malformed peer-mutes.json is treated as empty", async () => {
    const w = await ws();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(w, "peer-mutes.json"), "garbage");
    expect(await isPeerMuted(w, "peer-a")).toBe(false);
  });
});
