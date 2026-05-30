/**
 * Tiny pub/sub so non-App components can surface toasts without
 * prop-drilling addToast through the tree. App.svelte subscribes
 * once on mount and forwards each request into its internal toast
 * stack. If no subscriber is attached yet (race during initial
 * mount), the request is buffered and replayed on the first
 * subscribe.
 */

export type ToastKind = "error" | "info" | "success" | "invite" | "warning";

export interface ToastRequest {
  kind: ToastKind;
  message: string;
  title?: string;
  /** When set, the toast renders an agent brand mark instead of the
   *  default emoji glyph. Same string the rest of the app uses
   *  ("claude" / "codex" / "ollama" / "copilot"). */
  agent?: string;
  messageItalic?: boolean;
  ttlMs?: number;
  persist?: boolean;
  /** Skip the kind-default chime (error / invite / warning).
   *  Use when the caller already plays its own dedicated sound for
   *  the event — e.g. the "pace above 100%" usage warning has its
   *  own piano-arpeggio cue, so the toast shouldn't double up with
   *  the ukulele warning chime. */
  silent?: boolean;
}

type Listener = (req: ToastRequest) => void;

const listeners = new Set<Listener>();
const pending: ToastRequest[] = [];

export function pushToast(req: ToastRequest): void {
  if (listeners.size === 0) {
    pending.push(req);
    return;
  }
  for (const l of listeners) l(req);
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  while (pending.length > 0) {
    const req = pending.shift()!;
    l(req);
  }
  return () => {
    listeners.delete(l);
  };
}
