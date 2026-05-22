/**
 * Receiver-side invite dialog. SSE handler in App.svelte calls
 * `openInvite(offerId)` when a `session_invite_received` event arrives
 * (or when the user clicks a persistent invite toast).
 *
 * Single-slot, same shape as the sender-side share dialog.
 */

import { writable } from "svelte/store";

export interface ReceiveInviteRequest {
  /** The receiver-side offerId. Dialog fetches the full manifest from
   *  `GET /api/sessions/invites`. */
  offerId: string;
}

export const activeInvite = writable<ReceiveInviteRequest | null>(null);

export function openInvite(offerId: string): void {
  activeInvite.set({ offerId });
}

export function closeInvite(): void {
  activeInvite.set(null);
}
