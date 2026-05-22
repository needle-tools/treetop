/**
 * Periodic SSE comment ping for `/api/stream` subscribers.
 *
 * server.ts holds the live `sseSubscribers` set and a `broadcast()`
 * helper that emits real `event:` frames on mutation. This module is
 * just the keep-alive path: a single SSE comment frame written to every
 * subscriber on a fixed interval so a half-open TCP connection errors
 * fast instead of leaving the dashboard's "● connected" pill stuck
 * lying for minutes after a sleep/wake or a proxy idle drop.
 *
 * Kept in its own file so the helper is unit-testable without spinning
 * up Bun.serve (importing server.ts has side effects — it boots the
 * listener).
 */

const enc = new TextEncoder();
const PING = enc.encode(`: ping\n\n`);

export function pingSubscribers(
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>,
): void {
  for (const ctrl of subscribers) {
    try {
      ctrl.enqueue(PING);
    } catch {
      subscribers.delete(ctrl);
    }
  }
}
