// Per-socket terminal output backlog bounds.
//
// When WebKit stops draining a terminal websocket the daemon buffers PTY
// output in `pendingOutput` (see server.ts) so OS/WebKit send queues can't
// grow without bound. That buffer must itself be bounded, or a noisy terminal
// behind a stalled socket grows daemon memory until OOM.
//
// Two caps, by visibility:
//   - HIDDEN (delivery-muted, the UI scrolled this column far off-screen):
//     tight 1 MB buffer. On un-hide the socket gets the recent tail, the same
//     guarantee a reconnect's replay gives.
//   - VISIBLE: a generous hard ceiling. The common case is a momentary
//     backpressure blip that self-corrects when the socket drains — but a
//     VISIBLE socket whose renderer has stopped draining entirely (an occluded
//     / backgrounded Treetop window, where the IntersectionObserver never fires
//     `false`) would otherwise buffer without limit. The ceiling caps that case
//     while leaving normal backpressure plenty of headroom.
export const TERMINAL_HIDDEN_BACKLOG_CAP_BYTES = 1024 * 1024; // 1 MB
export const TERMINAL_VISIBLE_BACKLOG_CAP_BYTES = 8 * 1024 * 1024; // 8 MB

// Drop oldest chunks until the backlog fits its cap. Mutates `chunks` in place
// (shift from the front, preserving order and the newest chunk) and returns the
// corrected byte total. Never drops the last remaining chunk, so a single chunk
// larger than the cap is still delivered.
export function trimTerminalBacklog(
  chunks: Uint8Array[],
  bytes: number,
  visible: boolean,
): number {
  const cap = visible
    ? TERMINAL_VISIBLE_BACKLOG_CAP_BYTES
    : TERMINAL_HIDDEN_BACKLOG_CAP_BYTES;
  while (bytes > cap && chunks.length > 1) {
    const dropped = chunks.shift();
    bytes -= dropped?.byteLength ?? 0;
  }
  return bytes;
}
