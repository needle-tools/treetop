// Per-socket terminal output backlog guard.
//
// When WebKit stops draining a terminal websocket the daemon buffers PTY
// output in `pendingOutput` (see server.ts) so OS/WebKit send queues don't
// absorb unbounded data. For visible sockets that stop draining, this module
// caps the daemon-side queue. For hidden sockets, upstream PTY pause keeps the
// queue from becoming the pressure-relief valve in the first place.
//
// Hidden terminal output is not trimmed here. A terminal byte stream is
// stateful: dropping an older chunk can split cursor / SGR control sequences
// from the text they apply to, and replaying that orphaned tail corrupts the
// screen. Hidden memory pressure is handled upstream by pausing PTY output
// delivery when no visible socket needs it.
//
// VISIBLE gets a generous hard ceiling. The common case is a momentary
// backpressure blip that self-corrects when the socket drains. A visible socket
// whose renderer has stopped draining entirely (an occluded / backgrounded
// Treetop window, where the IntersectionObserver never fires `false`) would
// otherwise buffer without limit.
export const TERMINAL_VISIBLE_BACKLOG_CAP_BYTES = 8 * 1024 * 1024; // 8 MB

// Drop oldest visible chunks until the backlog fits its cap. Mutates `chunks`
// in place (shift from the front, preserving order and the newest chunk) and
// returns the corrected byte total. Never drops the last remaining chunk, so a
// single chunk larger than the cap is still delivered.
export function trimTerminalBacklog(
  chunks: Uint8Array[],
  bytes: number,
  visible: boolean,
): number {
  if (!visible) return bytes;
  const cap = TERMINAL_VISIBLE_BACKLOG_CAP_BYTES;
  while (bytes > cap && chunks.length > 1) {
    const dropped = chunks.shift();
    bytes -= dropped?.byteLength ?? 0;
  }
  return bytes;
}
