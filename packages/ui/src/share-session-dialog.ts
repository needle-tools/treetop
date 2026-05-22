/**
 * Small store that drives the app-wide `ShareSessionDialog`. SessionView's
 * burger menu calls `openShare(source)`; the dialog (mounted once in
 * App.svelte) subscribes and renders on demand.
 *
 * Single-slot: opening a second share on top of an existing one replaces
 * the prior request. Matches the SummarizeDialog pattern.
 */

import { writable } from "svelte/store";

export interface ShareSessionRequest {
  /** Absolute path of the session source file. The dialog passes this
   *  through to `POST /api/sessions/send` as `body.source`. */
  source: string;
}

export const activeShare = writable<ShareSessionRequest | null>(null);

export function openShare(source: string): void {
  activeShare.set({ source });
}

export function closeShare(): void {
  activeShare.set(null);
}

/** Persisted last-used peer (`host:port`). Stored in localStorage so the
 *  "Send to peer" dialog pre-fills the entry that worked last time —
 *  important during v1 when mDNS doesn't exist yet and the user is
 *  typing the address by hand. */
const LAST_PEER_KEY = "supergit.share.lastPeer";

export function rememberPeer(hostPort: string): void {
  try {
    localStorage.setItem(LAST_PEER_KEY, hostPort);
  } catch {
    // Storage quota / private mode — non-fatal.
  }
}

export function recallPeer(): string {
  try {
    return localStorage.getItem(LAST_PEER_KEY) ?? "";
  } catch {
    return "";
  }
}
