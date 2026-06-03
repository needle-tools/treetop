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
  addOutgoingMessage,
  getMessages,
  deleteMessage,
  mutePeer,
  unmutePeer,
  isPeerMuted,
  MAX_PER_PEER,
  MESSAGE_TTL_MS,
} from "../src/messages";

async function ws(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supergit-messages-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "peer-identity.json"),
    JSON.stringify({ id: "test-identity-uuid", label: "Test" }),
  );
  return dir;
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
    // Small delay so the two messages get distinguishable receivedAt
    // timestamps — sort is by receivedAt, not sentAt, and sub-ms
    // resolution makes same-tick ordering unstable.
    await new Promise((r) => setTimeout(r, 5));
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
    const raw = JSON.parse(await readFile(join(w, "messages.json"), "utf-8"));
    expect(raw.byPeer["peer-a"].messages[0].body).toStartWith("enc:v1:");
    const got = await getMessages(w);
    expect(got[0]?.messages[0]?.body).toBe("hi");
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

  test("note messages round-trip with sender and receiver metadata", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "note body",
      sentAt: "2026-05-22T10:00:00Z",
      kind: "note",
      note: {
        body: "note body",
        tags: ["message"],
        sender: { kind: "peer", id: "peer-a", label: "Alice" },
        receiver: { kind: "peer", peerId: "test-identity-uuid", label: "Test" },
        stampId: 42,
      },
    });
    const got = await getMessages(w);
    const msg = got[0]?.messages[0];
    expect(msg?.kind).toBe("note");
    expect(msg?.note?.body).toBe("note body");
    expect(msg?.note?.sender).toEqual({ kind: "peer", id: "peer-a", label: "Alice" });
    expect(msg?.note?.receiver).toEqual({
      kind: "peer",
      peerId: "test-identity-uuid",
      label: "Test",
    });
    expect(msg?.note?.stampId).toBe(42);
  });

  test("outgoing note messages keep receiver metadata", async () => {
    const w = await ws();
    await addOutgoingMessage(
      w,
      { id: "peer-b", label: "Bob" },
      "note body",
      "2026-05-22T10:00:00Z",
      {
        kind: "note",
        note: {
          body: "note body",
          sender: { kind: "peer", id: "test-identity-uuid", label: "Test" },
          receiver: { kind: "peer", peerId: "peer-b", label: "Bob" },
        },
      },
    );
    const got = await getMessages(w);
    const msg = got[0]?.messages[0];
    expect(msg?.direction).toBe("out");
    expect(msg?.kind).toBe("note");
    expect(msg?.note?.receiver).toEqual({ kind: "peer", peerId: "peer-b", label: "Bob" });
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

describe("deleteMessage", () => {
  test("deletes a specific message by id", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "first",
      sentAt: "2026-05-22T10:00:00Z",
    });
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "second",
      sentAt: "2026-05-22T10:00:01Z",
    });
    const before = await getMessages(w);
    expect(before[0]?.messages).toHaveLength(2);
    const targetId = before[0]!.messages[1]!.id; // "first"
    const deleted = await deleteMessage(w, "peer-a", targetId);
    expect(deleted).toBe(true);
    const after = await getMessages(w);
    expect(after[0]?.messages).toHaveLength(1);
    expect(after[0]?.messages[0]?.body).toBe("second");
  });

  test("returns false for non-existent message id", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "hi",
      sentAt: "2026-05-22T10:00:00Z",
    });
    const deleted = await deleteMessage(w, "peer-a", "nonexistent-id");
    expect(deleted).toBe(false);
  });

  test("returns false for non-existent peer", async () => {
    const w = await ws();
    const deleted = await deleteMessage(w, "no-such-peer", "any-id");
    expect(deleted).toBe(false);
  });

  test("removes peer entry when last message is deleted", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "only one",
      sentAt: "2026-05-22T10:00:00Z",
    });
    const before = await getMessages(w);
    const msgId = before[0]!.messages[0]!.id;
    await deleteMessage(w, "peer-a", msgId);
    const after = await getMessages(w);
    expect(after).toHaveLength(0);
  });
});

describe("encryption at rest", () => {
  test("messages.json stores encrypted bodies, not plaintext", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "secret message",
      sentAt: "2026-05-22T10:00:00Z",
    });
    const raw = await readFile(join(w, "messages.json"), "utf-8");
    expect(raw).not.toContain("secret message");
    expect(raw).toContain("enc:v1:");
  });

  test("encrypted bodies are decrypted on read", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "secret message",
      sentAt: "2026-05-22T10:00:00Z",
    });
    const got = await getMessages(w);
    expect(got[0]?.messages[0]?.body).toBe("secret message");
  });

  test("note message bodies are encrypted at rest", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "secret note",
      sentAt: "2026-05-22T10:00:00Z",
      kind: "note",
      note: { body: "secret note" },
    });
    const raw = await readFile(join(w, "messages.json"), "utf-8");
    expect(raw).not.toContain("secret note");
    const got = await getMessages(w);
    expect(got[0]?.messages[0]?.body).toBe("secret note");
    expect(got[0]?.messages[0]?.note?.body).toBe("secret note");
  });

  test("plaintext legacy bodies are still readable (migration)", async () => {
    const w = await ws();
    const { writeFile } = await import("node:fs/promises");
    const now = new Date().toISOString();
    await writeFile(
      join(w, "messages.json"),
      JSON.stringify({
        version: 1,
        byPeer: {
          "peer-a": {
            label: "Alice",
            messages: [
              {
                id: "old-msg",
                body: "legacy plaintext",
                sentAt: now,
                receivedAt: now,
                direction: "in",
              },
            ],
          },
        },
      }),
    );
    const got = await getMessages(w);
    expect(got[0]?.messages[0]?.body).toBe("legacy plaintext");
  });

  test("each encryption uses a unique IV (no two ciphertexts match for same plaintext)", async () => {
    const w = await ws();
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "same text",
      sentAt: "2026-05-22T10:00:00Z",
    });
    await addIncomingMessage(w, {
      from: { id: "peer-a", label: "Alice" },
      body: "same text",
      sentAt: "2026-05-22T10:00:01Z",
    });
    const raw = JSON.parse(await readFile(join(w, "messages.json"), "utf-8"));
    const bodies = raw.byPeer["peer-a"].messages.map(
      (m: { body: string }) => m.body,
    );
    expect(bodies[0]).not.toBe(bodies[1]);
  });
});

describe("auto-expire messages older than MESSAGE_TTL_MS", () => {
  test("messages older than 4 hours are pruned on read", async () => {
    const w = await ws();
    const { writeFile } = await import("node:fs/promises");
    const oldTime = new Date(
      Date.now() - MESSAGE_TTL_MS - 60_000,
    ).toISOString();
    const freshTime = new Date().toISOString();
    await writeFile(
      join(w, "messages.json"),
      JSON.stringify({
        version: 1,
        byPeer: {
          "peer-a": {
            label: "Alice",
            messages: [
              {
                id: "fresh",
                body: "new",
                sentAt: freshTime,
                receivedAt: freshTime,
                direction: "in",
              },
              {
                id: "old",
                body: "expired",
                sentAt: oldTime,
                receivedAt: oldTime,
                direction: "in",
              },
            ],
          },
        },
      }),
    );
    const got = await getMessages(w);
    expect(got[0]?.messages).toHaveLength(1);
    expect(got[0]?.messages[0]?.id).toBe("fresh");
  });

  test("peer entry is removed when all messages expire", async () => {
    const w = await ws();
    const { writeFile } = await import("node:fs/promises");
    const oldTime = new Date(
      Date.now() - MESSAGE_TTL_MS - 60_000,
    ).toISOString();
    await writeFile(
      join(w, "messages.json"),
      JSON.stringify({
        version: 1,
        byPeer: {
          "peer-a": {
            label: "Alice",
            messages: [
              {
                id: "old",
                body: "expired",
                sentAt: oldTime,
                receivedAt: oldTime,
                direction: "in",
              },
            ],
          },
        },
      }),
    );
    const got = await getMessages(w);
    expect(got).toHaveLength(0);
  });
});
