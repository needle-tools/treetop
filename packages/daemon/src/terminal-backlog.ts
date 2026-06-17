// Per-socket terminal output backlog guard.
//
// When WebKit stops draining a terminal websocket the daemon buffers PTY
// output in `pendingOutput` (see server.ts) so OS/WebKit send queues don't
// absorb unbounded data. For drainable sockets that still backpressure, this
// module caps the daemon-side queue. For non-drainable sockets, upstream PTY
// pause keeps the queue from becoming the pressure-relief valve in the first
// place.
//
// Non-drainable terminal output is not trimmed here. A terminal byte stream is
// stateful: dropping an older chunk can split cursor / SGR control sequences
// from the text they apply to, and replaying that orphaned tail corrupts the
// screen. Suspended-window memory pressure is handled upstream by pausing PTY
// output delivery when no browser socket can drain bytes.
//
// DRAINABLE gets a generous hard ceiling. The common case is a momentary
// backpressure blip that self-corrects when the socket drains. A socket the
// browser reports drainable but that still stops consuming frames would
// otherwise buffer without limit.
export const TERMINAL_DRAINABLE_BACKLOG_CAP_BYTES = 8 * 1024 * 1024; // 8 MB

// Drop oldest drainable chunks until the backlog fits its cap. Mutates
// `chunks` in place (shift from the front, preserving order and the newest
// chunk) and returns the corrected byte total. Never drops the last remaining
// chunk, so a single chunk larger than the cap is still delivered.
export function trimTerminalBacklog(
  chunks: Uint8Array[],
  bytes: number,
  drainable: boolean,
): number {
  if (!drainable) return bytes;
  const cap = TERMINAL_DRAINABLE_BACKLOG_CAP_BYTES;
  while (bytes > cap && chunks.length > 1) {
    const dropped = chunks.shift();
    bytes -= dropped?.byteLength ?? 0;
  }
  return bytes;
}
