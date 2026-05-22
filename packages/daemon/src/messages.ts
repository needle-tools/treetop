/**
 * Tiny peer-to-peer message inbox. Last 5 messages per sender,
 * file-backed under `<workspace>/messages.json`. Used by the
 * `/api/messages/{send,receive,...}` routes — see plans/PLAN-SESSION-SHARE.md
 * (same discovery + offer plumbing, much simpler payload).
 *
 * Mutes live in `<workspace>/peer-mutes.json` as `{ peerId: expiryIso }`.
 * Expired entries are pruned lazily on read.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MESSAGES_FILE = "messages.json";
const MUTES_FILE = "peer-mutes.json";

export const MAX_PER_PEER = 5;
/** Hard cap on a single message body. The UI shows everything in
 *  monospace so anything bigger is almost certainly an attached-file
 *  attempt — which this feature explicitly doesn't support. */
export const MAX_BODY_BYTES = 2048;

export interface IncomingMessage {
  from: { id: string; label: string };
  body: string;
  sentAt: string;
}

export type MessageDirection = "in" | "out";
export interface StoredMessage {
  id: string;
  body: string;
  sentAt: string;
  receivedAt: string;
  /** "in" = received from this peer; "out" = we sent it to this peer.
   *  Optional in older data — backward-compat code defaults absent
   *  entries to "in". */
  direction: MessageDirection;
}

export interface PeerInbox {
  peer: { id: string; label: string };
  messages: StoredMessage[];
}

interface OnDisk {
  version: 1;
  byPeer: Record<
    string,
    { label: string; messages: StoredMessage[] }
  >;
}

async function loadStore(workspaceDir: string): Promise<OnDisk> {
  try {
    const raw = await readFile(join(workspaceDir, MESSAGES_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<OnDisk>;
    if (parsed && typeof parsed === "object" && parsed.byPeer) {
      // Backward-compat: messages stored before the direction field
      // existed should be treated as inbound (the only kind we
      // tracked at the time).
      for (const entry of Object.values(parsed.byPeer)) {
        for (const m of entry.messages) {
          if (!m.direction) m.direction = "in";
        }
      }
      return { version: 1, byPeer: parsed.byPeer };
    }
  } catch {
    // file missing or unreadable — fall through to empty
  }
  return { version: 1, byPeer: {} };
}

async function saveStore(workspaceDir: string, store: OnDisk): Promise<void> {
  await writeFile(
    join(workspaceDir, MESSAGES_FILE),
    JSON.stringify(store, null, 2),
  );
}

export async function addIncomingMessage(
  workspaceDir: string,
  msg: IncomingMessage,
): Promise<void> {
  await pushMessage(workspaceDir, msg.from.id, msg.from.label, {
    id: crypto.randomUUID(),
    body: msg.body,
    sentAt: msg.sentAt,
    receivedAt: new Date().toISOString(),
    direction: "in",
  });
}

/** Stamp a message WE just sent into the same per-peer buffer so the
 *  UI can show outbound history alongside inbound. Called from
 *  /api/messages/send after the peer's /api/messages/receive
 *  returned 202. The "receivedAt" field on outbound messages records
 *  when the peer ACKed delivery, which is fine to treat as the
 *  ordering key alongside inbound receivedAt. */
export async function addOutgoingMessage(
  workspaceDir: string,
  to: { id: string; label: string },
  body: string,
  sentAt: string,
): Promise<void> {
  await pushMessage(workspaceDir, to.id, to.label, {
    id: crypto.randomUUID(),
    body,
    sentAt,
    receivedAt: new Date().toISOString(),
    direction: "out",
  });
}

async function pushMessage(
  workspaceDir: string,
  peerId: string,
  peerLabel: string,
  msg: StoredMessage,
): Promise<void> {
  const store = await loadStore(workspaceDir);
  let entry = store.byPeer[peerId];
  if (!entry) {
    entry = { label: peerLabel, messages: [] };
    store.byPeer[peerId] = entry;
  }
  entry.label = peerLabel; // refresh the human label
  entry.messages.unshift(msg);
  // Per-direction cap so a chatty sender can't push the received
  // history off the end, and a chatty receiver can't push out the
  // sent history. Trim each direction independently.
  for (const dir of ["in", "out"] as const) {
    let kept = 0;
    entry.messages = entry.messages.filter((m) => {
      if (m.direction !== dir) return true;
      if (kept < MAX_PER_PEER) {
        kept++;
        return true;
      }
      return false;
    });
  }
  await saveStore(workspaceDir, store);
}

/** Read the inbox, grouped by sender, newest-conversation first. */
export async function getMessages(workspaceDir: string): Promise<PeerInbox[]> {
  const store = await loadStore(workspaceDir);
  const out: PeerInbox[] = [];
  for (const [id, entry] of Object.entries(store.byPeer)) {
    out.push({ peer: { id, label: entry.label }, messages: entry.messages });
  }
  out.sort((a, b) => {
    const ta = a.messages[0]?.receivedAt ?? "";
    const tb = b.messages[0]?.receivedAt ?? "";
    return tb.localeCompare(ta);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Mute store                                                         */
/* ------------------------------------------------------------------ */

async function loadMutes(
  workspaceDir: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(workspaceDir, MUTES_FILE), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Filter to string→string entries.
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // empty
  }
  return {};
}

async function saveMutes(
  workspaceDir: string,
  mutes: Record<string, string>,
): Promise<void> {
  await writeFile(
    join(workspaceDir, MUTES_FILE),
    JSON.stringify(mutes, null, 2),
  );
}

export async function mutePeer(
  workspaceDir: string,
  peerId: string,
  durationMinutes: number,
): Promise<void> {
  const mutes = await loadMutes(workspaceDir);
  const expires = new Date(Date.now() + durationMinutes * 60_000).toISOString();
  mutes[peerId] = expires;
  await saveMutes(workspaceDir, mutes);
}

export async function unmutePeer(
  workspaceDir: string,
  peerId: string,
): Promise<void> {
  const mutes = await loadMutes(workspaceDir);
  if (peerId in mutes) {
    delete mutes[peerId];
    await saveMutes(workspaceDir, mutes);
  }
}

export async function isPeerMuted(
  workspaceDir: string,
  peerId: string,
): Promise<boolean> {
  const mutes = await loadMutes(workspaceDir);
  const expires = mutes[peerId];
  if (!expires) return false;
  const ts = Date.parse(expires);
  if (!Number.isFinite(ts)) return false;
  if (ts <= Date.now()) {
    // Expired — prune lazily so the file doesn't grow forever.
    delete mutes[peerId];
    await saveMutes(workspaceDir, mutes);
    return false;
  }
  return true;
}

/** Return the full mute map for the UI to render expiry timestamps. */
export async function listMutes(
  workspaceDir: string,
): Promise<Record<string, string>> {
  const mutes = await loadMutes(workspaceDir);
  // Prune expired entries while we're here.
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(mutes)) {
    const ts = Date.parse(v);
    if (!Number.isFinite(ts) || ts <= now) {
      delete mutes[k];
      changed = true;
    }
  }
  if (changed) await saveMutes(workspaceDir, mutes);
  return mutes;
}
