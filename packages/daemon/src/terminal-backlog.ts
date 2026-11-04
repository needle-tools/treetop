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

/** Explicit sharing lasts until revoked; snapshot freshness is reported separately. */
export class SharedTerminalOutput {
  constructor(private now: () => number = Date.now, private changed?: (id: string, listChanged: boolean) => void) {}
  private snapshots = new Map<string, {
    text: string; updatedAt: number; lastActivityAt: number;
    pending: boolean; freshSnapshot: boolean;
  }>();
  /** Raw PTY output resets the quiet period without retaining its bytes. */
  activity(id: string) {
    const value = this.snapshots.get(id);
    if (!value) return;
    value.lastActivityAt = this.now();
    value.pending = true;
    value.freshSnapshot = false;
  }
  /** Called by the daemon timer; initial sharing and revocation stay immediate. */
  flush() {
    this.list();
    for (const [id, value] of this.snapshots) {
      if (value.pending && value.freshSnapshot && this.now() - value.lastActivityAt >= 1500) {
        value.pending = false;
        this.changed?.(id, false);
      }
    }
  }
  update(id: string, text: string, allowGrant = true): boolean {
    this.list();
    const previous = this.snapshots.get(id);
    if (!previous && !allowGrant) return false;
    const bounded = text.slice(-32000);
    if (!previous) {
      this.snapshots.set(id, { text: bounded, updatedAt: this.now(), lastActivityAt: this.now(), pending: false, freshSnapshot: true });
      this.changed?.(id, true);
      return true;
    }
    if (previous.text !== bounded && (!previous.pending || previous.freshSnapshot)) {
      previous.pending = true;
      previous.lastActivityAt = this.now();
    }
    previous.text = bounded;
    previous.updatedAt = this.now();
    previous.freshSnapshot = true;
    return true;
  }
  revoke(id: string) { if (this.snapshots.delete(id)) this.changed?.(id, true); }
  list() {
    return [...this.snapshots].map(([terminal_id, value]) => ({ terminal_id, updated_at: value.updatedAt }));
  }
  prune(isAlive: (id: string) => boolean) {
    for (const id of this.snapshots.keys()) if (!isAlive(id)) this.revoke(id);
  }
  read(id: string, maxChars: number) {
    this.list();
    const value = this.snapshots.get(id);
    return value ? { terminal_id: id, text: value.text.slice(-maxChars), updated_at: value.updatedAt, snapshot_age_ms: Math.max(0, this.now() - value.updatedAt), snapshot_stale: this.now() - value.updatedAt > 15000, read_only: true } : undefined;
  }
}
