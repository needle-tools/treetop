/**
 * Cross-component channel for "show this session in the row strip".
 *
 * Writers: anywhere that knows a session source path the user wants
 * to navigate to — currently the saved sticky-link chip's click
 * handler when its target is kind="session".
 *
 * Reader: App.svelte. It reacts by ensuring the session is in
 * `openSessionsByWt[wt.path]`, scrolling its column into view, and
 * applying a brief outline highlight (`.session-col-focused`) so the
 * user can spot where the link landed.
 *
 * The store value carries a timestamp so the same session can be
 * focused twice in a row (re-clicking the chip) and App's reactivity
 * still fires — comparing only `source` would short-circuit on a
 * duplicate value.
 */

import { writable } from "svelte/store";

export interface SessionFocusRequest {
  /** Session source path (matches AgentSession.source). */
  source: string;
  /** Monotonic ts so identical requests re-fire reactivity. */
  ts: number;
}

export const sessionFocusRequest = writable<SessionFocusRequest | null>(null);

export function requestSessionFocus(source: string): void {
  sessionFocusRequest.set({ source, ts: Date.now() });
}
