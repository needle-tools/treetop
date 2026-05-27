/**
 * Reactive store backing the header Messages inbox. The daemon
 * exposes `/api/messages` (read), `/api/messages/send`, `/api/messages/mute`,
 * `/api/messages/unmute`; this module hides the fetch ceremony and
 * the polling/SSE-driven refresh from the components that render the
 * popover.
 */

import { writable } from "svelte/store";
import { apiUrl } from "./api";

export interface StoredMessage {
  id: string;
  body: string;
  sentAt: string;
  receivedAt: string;
  /** "in" = received from this peer; "out" = we sent it to this peer.
   *  Older messages predate this field — backward-compat treats them
   *  as "in" client-side. */
  direction?: "in" | "out";
  kind?: "text" | "note";
  note?: {
    body: string;
    anchors?: string[];
    tags?: string[];
    kind?: "note" | "link" | "emoji";
    target?: unknown;
    receiver?: MessageReceiver;
    sender?: MessageSender;
  };
}

export interface MessageReceiver {
  kind?: "session" | "peer";
  sessionId?: string;
  peerId?: string;
  label?: string;
  agent?: string;
  source?: string;
  terminalId?: string;
  host?: string;
  port?: number;
  delivery?: "draft" | "staged" | "sent";
}

export interface MessageSender {
  kind: "session" | "peer";
  id: string;
  label?: string;
  agent?: string;
  source?: string;
  terminalId?: string;
}

export function messageTitleFromMarkdown(body: string): string {
  const heading = body.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  const source = heading || body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[\s>*+-]*\[[ xX]]\s+/gm, "")
    .replace(/^[\s>*+-]+/gm, "")
    .replace(/[*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) return "Untitled message";
  const sentence = source.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? "";
  const candidate = sentence && sentence.length <= 64 ? sentence : source;
  const words = candidate.split(/\s+/).filter(Boolean);
  const clipped = words.slice(0, 7).join(" ");
  return words.length > 7 ? `${clipped}...` : clipped;
}
export interface PeerInbox {
  peer: { id: string; label: string };
  messages: StoredMessage[];
}
export interface InboxSnapshot {
  inbox: PeerInbox[];
  /** Map of peerId → ISO expiry of an active mute. */
  mutes: Record<string, string>;
}

const empty: InboxSnapshot = { inbox: [], mutes: {} };
export const messages = writable<InboxSnapshot>(empty);

/** Refresh from the daemon. Called on mount, after a successful
 *  send, and from App.svelte's SSE handler when a `message_received`
 *  broadcast arrives. */
export async function refreshMessages(): Promise<void> {
  try {
    const res = await fetch(apiUrl("/api/messages"));
    if (!res.ok) return;
    const body = (await res.json()) as InboxSnapshot;
    messages.set({
      inbox: body.inbox ?? [],
      mutes: body.mutes ?? {},
    });
  } catch {
    // best-effort — empty state on failure is fine
  }
}

/** Total INBOUND messages across all non-muted senders. Used as a
 *  fallback when no unread baseline has been recorded yet. Outbound
 *  ("out") entries are ours — they never contribute to the unread
 *  badge. */
export function totalCount(snap: InboxSnapshot): number {
  let n = 0;
  for (const row of snap.inbox) {
    if (snap.mutes[row.peer.id]) continue;
    for (const m of row.messages) {
      if (m.direction === "out") continue;
      n++;
    }
  }
  return n;
}

/** Unread = inbound messages received after `lastReadAtIso`. When
 *  that baseline isn't set yet (first run, fresh browser) we treat
 *  every inbound message as unread so the user still gets a hint.
 *  Muted senders and outbound entries are ignored. */
export function unreadCount(
  snap: InboxSnapshot,
  lastReadAtIso: string | null,
): number {
  if (!lastReadAtIso) return totalCount(snap);
  const cutoff = Date.parse(lastReadAtIso);
  if (!Number.isFinite(cutoff)) return totalCount(snap);
  let n = 0;
  for (const row of snap.inbox) {
    if (snap.mutes[row.peer.id]) continue;
    for (const m of row.messages) {
      if (m.direction === "out") continue;
      const ts = Date.parse(m.receivedAt);
      if (Number.isFinite(ts) && ts > cutoff) n++;
    }
  }
  return n;
}

const LAST_READ_KEY = "supergit.inbox.lastReadAt";

/** Read the "I've seen the inbox" timestamp. Persisted in
 *  localStorage so reactive badge state survives a page reload. */
export function recallLastRead(): string | null {
  try {
    return localStorage.getItem(LAST_READ_KEY);
  } catch {
    return null;
  }
}

/** Stamp "the inbox was opened just now" so future arrivals count as
 *  unread relative to this moment. */
export function markInboxRead(): string {
  const now = new Date().toISOString();
  try {
    localStorage.setItem(LAST_READ_KEY, now);
  } catch {
    // private mode / storage quota — non-fatal
  }
  return now;
}

export async function sendMessage(
  peerHost: string,
  peerPort: number,
  body: string,
  opts: {
    kind?: "text" | "note";
    note?: StoredMessage["note"];
  } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(apiUrl("/api/messages/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerHost, peerPort, body, ...opts }),
    });
    if (res.status === 202) return { ok: true };
    const err = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: err?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteMsg(
  peerId: string,
  messageId: string,
): Promise<boolean> {
  try {
    const res = await fetch(apiUrl("/api/messages/delete"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId, messageId }),
    });
    if (res.status === 204) {
      await refreshMessages();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function mutePeer(peerId: string, minutes: number): Promise<void> {
  await fetch(apiUrl("/api/messages/mute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peerId, durationMinutes: minutes }),
  });
  await refreshMessages();
}

export async function unmutePeer(peerId: string): Promise<void> {
  await fetch(apiUrl("/api/messages/unmute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peerId }),
  });
  await refreshMessages();
}
