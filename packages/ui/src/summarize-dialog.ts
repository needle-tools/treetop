/**
 * Tiny store that drives the app-wide `SummarizeDialog`. SessionView
 * calls `openSummarize(source)` from its burger menu; the mounted
 * dialog component subscribes to this store and renders on demand.
 *
 * Single-slot: opening a second summarize on top of an existing one
 * replaces the prior request. The dialog itself owns the lifecycle
 * (probe → cached / install / run) so the caller doesn't have to.
 */

import { writable } from "svelte/store";

export interface SummarizeRequest {
  /** Absolute path of the session source file (`/api/session?source=…`). */
  source: string;
}

export const activeSummarize = writable<SummarizeRequest | null>(null);

export function openSummarize(source: string): void {
  activeSummarize.set({ source });
}
