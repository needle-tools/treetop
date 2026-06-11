/**
 * Holds raw PTY bytes for a terminal whose column is currently off-screen
 * so the UI can skip xterm's per-chunk parse + DOM-render work until the
 * column is visible again. The WebSocket stays open and we keep noting
 * activity (the dock pulse still moves), we just don't paint what nobody
 * can see.
 *
 * Two invariants:
 *  - Byte order is preserved. Hidden output may be deferred, but never
 *    discarded.
 *  - Memory is bounded by asking the caller to flush when the cap is
 *    reached. The daemon-side visibility pause prevents far-off-screen
 *    terminals from continuously forcing those hidden flushes.
 */

import { derived, writable, type Readable } from "svelte/store";

export interface TerminalIoStatsSample {
  visible: boolean;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxBytesTotal: number;
  txBytesTotal: number;
  hiddenBufferedBytes: number;
  hiddenFlushes: number;
}

export interface TerminalIoStatsTotals {
  terminals: number;
  visible: number;
  paused: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  rxBytesTotal: number;
  txBytesTotal: number;
  hiddenBufferedBytes: number;
  hiddenFlushes: number;
}

const emptyTerminalIoStats: TerminalIoStatsTotals = {
  terminals: 0,
  visible: 0,
  paused: 0,
  rxBytesPerSec: 0,
  txBytesPerSec: 0,
  rxBytesTotal: 0,
  txBytesTotal: 0,
  hiddenBufferedBytes: 0,
  hiddenFlushes: 0,
};

const terminalIoStatsById = writable<Record<string, TerminalIoStatsSample>>({});

export const terminalIoStats: Readable<TerminalIoStatsTotals> = derived(
  terminalIoStatsById,
  ($byId) => {
    const total = { ...emptyTerminalIoStats };
    for (const sample of Object.values($byId)) {
      total.terminals += 1;
      if (sample.visible) total.visible += 1;
      else total.paused += 1;
      total.rxBytesPerSec += sample.rxBytesPerSec;
      total.txBytesPerSec += sample.txBytesPerSec;
      total.rxBytesTotal += sample.rxBytesTotal;
      total.txBytesTotal += sample.txBytesTotal;
      total.hiddenBufferedBytes += sample.hiddenBufferedBytes;
      total.hiddenFlushes += sample.hiddenFlushes;
    }
    return total;
  },
);

export function setTerminalIoStats(
  id: string,
  sample: TerminalIoStatsSample,
): void {
  terminalIoStatsById.update((byId) => ({ ...byId, [id]: sample }));
}

export function removeTerminalIoStats(id: string): void {
  terminalIoStatsById.update((byId) => {
    if (!(id in byId)) return byId;
    const next = { ...byId };
    delete next[id];
    return next;
  });
}

export function _resetTerminalIoStatsForTests(): void {
  terminalIoStatsById.set({});
}

export class TerminalWriteBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  /** 1 MiB default — a few screenfuls of dense output; small enough that
   *  the catch-up flush on reveal is a single coarse write. */
  constructor(private readonly capBytes: number = 1_048_576) {}

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  get pendingBytes(): number {
    return this.size;
  }

  /** Append a chunk. Returns true when the caller should flush now to keep
   *  this in-memory buffer bounded. The flush preserves every byte. */
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
