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
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type {
  AttachmentKind,
  LinkTarget,
  MessageReceiver,
  MessageSender,
} from "./notes";

const MESSAGES_FILE = "messages.json";
const MUTES_FILE = "peer-mutes.json";

export const MAX_PER_PEER = 5;
export const MESSAGE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
/** Hard cap on a single message body. The UI shows everything in
 *  monospace so anything bigger is almost certainly an attached-file
 *  attempt — which this feature explicitly doesn't support. */
export const MAX_BODY_BYTES = 2048;

/* ------------------------------------------------------------------ */
/* At-rest encryption — AES-256-GCM keyed from peer identity          */
/* ------------------------------------------------------------------ */

const ENC_PREFIX = "enc:v1:";

async function getEncryptionKey(workspaceDir: string): Promise<Buffer> {
  try {
    const raw = await readFile(
      join(workspaceDir, "peer-identity.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { id?: string };
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      return createHash("sha256").update(`supergit-msg:${parsed.id}`).digest();
    }
  } catch {
    // identity not yet created — fall through
  }
  return createHash("sha256").update("supergit-msg:fallback").digest();
}

function encryptBody(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${Buffer.concat([ct, tag]).toString("hex")}`;
}

function decryptBody(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const rest = stored.slice(ENC_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) return stored;
  const iv = Buffer.from(rest.slice(0, colonIdx), "hex");
  const ctAndTag = Buffer.from(rest.slice(colonIdx + 1), "hex");
  const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
  const tag = ctAndTag.subarray(ctAndTag.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString("utf-8") + decipher.final("utf-8");
}

function decryptMessage(m: StoredMessage, key: Buffer): void {
  if (!m.direction) m.direction = "in";
  m.body = decryptBody(m.body, key);
  if (m.note?.body) m.note = { ...m.note, body: decryptBody(m.note.body, key) };
}

function encryptMessage(m: StoredMessage, key: Buffer): StoredMessage {
  return {
    ...m,
    body: encryptBody(m.body, key),
    ...(m.note ? { note: { ...m.note, body: encryptBody(m.note.body, key) } } : {}),
  };
}

export interface IncomingMessage {
  from: { id: string; label: string };
  body: string;
  sentAt: string;
  /** Optional sender-assigned delivery id. When present, a second
   *  receive with the same id (a sender retry after a dropped ACK) is
   *  ignored instead of duplicated. Absent on older senders, in which
   *  case every receive is stored. */
  id?: string;
  kind?: "text" | "note";
  note?: MessageNotePayload;
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
  kind?: "text" | "note";
  note?: MessageNotePayload;
}

export interface MessageNotePayload {
  body: string;
  anchors?: string[];
  tags?: string[];
  kind?: AttachmentKind;
  target?: LinkTarget;
  receiver?: MessageReceiver;
  sender?: MessageSender;
  stampId?: number;
}

export interface OutgoingMessageOptions {
  kind?: "text" | "note";
  note?: MessageNotePayload;
}

export interface PeerInbox {
  peer: { id: string; label: string };
  messages: StoredMessage[];
}

interface OnDisk {
  version: 1;
  byPeer: Record<string, { label: string; messages: StoredMessage[] }>;
}

async function loadStore(workspaceDir: string): Promise<OnDisk> {
  const key = await getEncryptionKey(workspaceDir);
  try {
    const raw = await readFile(join(workspaceDir, MESSAGES_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<OnDisk>;
    if (parsed && typeof parsed === "object" && parsed.byPeer) {
      const now = Date.now();
      let pruned = false;
      for (const [peerId, entry] of Object.entries(parsed.byPeer)) {
        for (const m of entry.messages) {
          decryptMessage(m, key);
        }
        const before = entry.messages.length;
        entry.messages = entry.messages.filter((m) => {
          const ts = Date.parse(m.receivedAt);
          return Number.isFinite(ts) && now - ts < MESSAGE_TTL_MS;
        });
        if (entry.messages.length !== before) pruned = true;
        if (entry.messages.length === 0) {
          delete parsed.byPeer[peerId];
          pruned = true;
        }
      }
      const store: OnDisk = { version: 1, byPeer: parsed.byPeer };
      if (pruned) await saveStore(workspaceDir, store);
      return store;
    }
  } catch {
    // file missing or unreadable — fall through to empty
  }
  return { version: 1, byPeer: {} };
}

async function saveStore(workspaceDir: string, store: OnDisk): Promise<void> {
  const key = await getEncryptionKey(workspaceDir);
  const encrypted: OnDisk = {
    version: 1,
    byPeer: {},
  };
  for (const [peerId, entry] of Object.entries(store.byPeer)) {
    encrypted.byPeer[peerId] = {
      label: entry.label,
      messages: entry.messages.map((m) => encryptMessage(m, key)),
    };
  }
  await writeFile(
    join(workspaceDir, MESSAGES_FILE),
    JSON.stringify(encrypted, null, 2),
  );
}

export async function addIncomingMessage(
  workspaceDir: string,
  msg: IncomingMessage,
): Promise<void> {
  await pushMessage(
    workspaceDir,
    msg.from.id,
    msg.from.label,
    {
      // Reuse the sender's delivery id as the stored id when provided so
      // dedupe is by the same key the sender retries with; otherwise mint
      // a local one (which can never collide, so it's never deduped).
      id: msg.id ?? crypto.randomUUID(),
      body: msg.body,
      sentAt: msg.sentAt,
      receivedAt: new Date().toISOString(),
      direction: "in",
      ...(msg.kind ? { kind: msg.kind } : {}),
      ...(msg.note ? { note: msg.note } : {}),
    },
    { dedupe: msg.id !== undefined },
  );
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
  opts: OutgoingMessageOptions = {},
): Promise<void> {
  await pushMessage(workspaceDir, to.id, to.label, {
    id: crypto.randomUUID(),
    body,
    sentAt,
    receivedAt: new Date().toISOString(),
    direction: "out",
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  });
}

async function pushMessage(
  workspaceDir: string,
  peerId: string,
  peerLabel: string,
  msg: StoredMessage,
  opts: { dedupe?: boolean } = {},
): Promise<void> {
  const store = await loadStore(workspaceDir);
  let entry = store.byPeer[peerId];
  if (!entry) {
    entry = { label: peerLabel, messages: [] };
    store.byPeer[peerId] = entry;
  }
  entry.label = peerLabel; // refresh the human label
  // Idempotent receive: a sender that retried after a dropped ACK sends
  // the same delivery id, so drop it rather than duplicate the message.
  if (opts.dedupe && entry.messages.some((m) => m.id === msg.id)) {
    // Still persist the refreshed label.
    await saveStore(workspaceDir, store);
    return;
  }
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

/** Delete a single message from a peer's inbox. Returns true if
 *  found and removed, false if the peer or message id didn't exist.
 *  Removes the peer entry entirely when no messages remain. */
export async function deleteMessage(
  workspaceDir: string,
  peerId: string,
  messageId: string,
): Promise<boolean> {
  const store = await loadStore(workspaceDir);
  const entry = store.byPeer[peerId];
  if (!entry) return false;
  const idx = entry.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return false;
  entry.messages.splice(idx, 1);
  if (entry.messages.length === 0) {
    delete store.byPeer[peerId];
  }
  await saveStore(workspaceDir, store);
  return true;
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
