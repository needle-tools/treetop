/**
 * Holds raw PTY bytes for a terminal whose column is currently off-screen
 * so the UI can skip xterm's per-chunk parse + DOM-render work until the
 * column is visible again. The WebSocket stays open and we keep noting
 * activity (the dock pulse still moves), we just don't paint what nobody
 * can see.
 *
 * Two invariants:
 *  - Byte order is preserved exactly. Terminal output is a stream;
 *    reordering or trimming mid-escape-sequence would corrupt the
 *    rendered colours/cursor. So we only ever concatenate, never slice.
 *  - Memory is bounded. A hidden terminal that keeps streaming can't grow
 *    the buffer forever, so `push()` reports when the accumulated size
 *    has reached `capBytes`; the caller then flushes the batch straight
 *    to xterm (whose own scrollback is bounded) and buffering restarts.
 *    Hidden-but-chatty therefore degrades to coarse batched writes
 *    rather than per-chunk writes — still far cheaper, and correct.
 */
export class TerminalWriteBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  /** 1 MiB default — a few screenfuls of dense output; small enough that
   *  the catch-up flush on reveal is a single cheap write. */
  constructor(private readonly capBytes: number = 1_048_576) {}

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  get pendingBytes(): number {
    return this.size;
  }

  /** Append a chunk. Returns true when the buffer has reached `capBytes`
   *  and the caller should flush() now to bound memory; false to keep
   *  buffering. */
  push(bytes: Uint8Array): boolean {
    this.chunks.push(bytes);
    this.size += bytes.length;
    return this.size >= this.capBytes;
  }

  /** Concatenate everything buffered, in order, and reset. Returns null
   *  when empty so callers can skip a no-op xterm.write(). */
  flush(): Uint8Array | null {
    if (this.chunks.length === 0) return null;
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.size = 0;
    return out;
  }
}
