/**
 * Reactive store backing the header Messages inbox. The daemon
 * exposes `/api/messages` (read), `/api/messages/send`, `/api/messages/mute`,
 * `/api/messages/unmute`; this module hides the fetch ceremony and
 * the polling/SSE-driven refresh from the components that render the
 * popover.
 */

import { writable } from "svelte/store";

export interface StoredMessage {
  id: string;
  body: string;
  sentAt: string;
  receivedAt: string;
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
    const res = await fetch("/api/messages");
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

/** Total unread count for the header pill — currently just the sum
 *  of every peer's stored messages from peers that aren't muted.
 *  v1 has no per-message "read" flag; the pill clears on popover open
 *  by snapshotting the count at that moment (handled by the
 *  component). */
export function totalCount(snap: InboxSnapshot): number {
  let n = 0;
  for (const row of snap.inbox) {
    if (snap.mutes[row.peer.id]) continue;
    n += row.messages.length;
  }
  return n;
}

export async function sendMessage(
  peerHost: string,
  peerPort: number,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerHost, peerPort, body }),
    });
    if (res.status === 202) return { ok: true };
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: err?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function mutePeer(peerId: string, minutes: number): Promise<void> {
  await fetch("/api/messages/mute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peerId, durationMinutes: minutes }),
  });
  await refreshMessages();
}

export async function unmutePeer(peerId: string): Promise<void> {
  await fetch("/api/messages/unmute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ peerId }),
  });
  await refreshMessages();
}
