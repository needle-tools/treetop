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
  lastActivityAt: number | null;
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
  lastActivityAt: number | null;
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
  lastActivityAt: null,
  hiddenBufferedBytes: 0,
  hiddenFlushes: 0,
};

export const TERMINAL_ACTIVITY_RECENT_MS = 4_000;

const terminalIoStatsById = writable<Record<string, TerminalIoStatsSample>>({});

export const terminalIoStatsByKey: Readable<
  Record<string, TerminalIoStatsSample>
> = {
  subscribe: terminalIoStatsById.subscribe,
};

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
      if (
        sample.lastActivityAt !== null &&
        (total.lastActivityAt === null ||
          sample.lastActivityAt > total.lastActivityAt)
      ) {
        total.lastActivityAt = sample.lastActivityAt;
      }
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

export function formatTerminalIoRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)}m/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)}k/s`;
  }
  return `${Math.max(0, Math.round(bytesPerSec))}/s`;
}

export function isTerminalRecentlyActive(
  sample: TerminalIoStatsSample | undefined,
  now: number,
  windowMs: number = TERMINAL_ACTIVITY_RECENT_MS,
): boolean {
  if (!sample || sample.lastActivityAt === null) return false;
  return now - sample.lastActivityAt <= windowMs;
}

export class TerminalIoByteAccounting {
  private hiddenBytesAlreadyObserved = 0;

  get pendingHiddenBytes(): number {
    return this.hiddenBytesAlreadyObserved;
  }

  observeHiddenBytes(bytes: number): number {
    const normalized = Math.max(0, Math.floor(bytes));
    this.hiddenBytesAlreadyObserved += normalized;
    return normalized;
  }

  countRawBytes(bytes: number): number {
    const normalized = Math.max(0, Math.floor(bytes));
    const alreadyObserved = Math.min(
      normalized,
      this.hiddenBytesAlreadyObserved,
    );
    this.hiddenBytesAlreadyObserved -= alreadyObserved;
    return normalized - alreadyObserved;
  }
}

export interface TerminalRepaintCellSnapshot {
  chars: string;
  width: number;
  code: number;
  fgColorMode: number;
  bgColorMode: number;
  fgColor: number;
  bgColor: number;
  attrs: number;
}

export interface TerminalRepaintCell {
  row: number;
  col: number;
  width: number;
  chars: string;
}

function repaintSignature(cell: TerminalRepaintCellSnapshot): string {
  return [
    cell.chars,
    cell.width,
    cell.code,
    cell.fgColorMode,
    cell.bgColorMode,
    cell.fgColor,
    cell.bgColor,
    cell.attrs,
  ].join("\u0000");
}

/** Tracks the last visible xterm cell snapshot so debug paint effects can
 *  highlight only cells that changed, instead of flashing the whole viewport
 *  on first enable or during a row-level render event. */
export class TerminalRepaintTracker {
  private previous = new Map<string, string>();
  private initialized = false;

  reset(): void {
    this.previous.clear();
    this.initialized = false;
  }

  captureRenderedRows(args: {
    start: number;
    end: number;
    cols: number;
    maxCells?: number;
    readCell: (
      row: number,
      col: number,
    ) => TerminalRepaintCellSnapshot | null | undefined;
  }): TerminalRepaintCell[] {
    const changed: TerminalRepaintCell[] = [];
    const next = new Map(this.previous);
    const maxCells =
      typeof args.maxCells === "number" && args.maxCells >= 0
        ? args.maxCells
        : Number.POSITIVE_INFINITY;
    for (let row = args.start; row <= args.end; row++) {
      for (let col = 0; col < args.cols; col++) {
        const cell = args.readCell(row, col);
        if (!cell) continue;
        const key = `${row}:${col}`;
        const signature = repaintSignature(cell);
        if (this.initialized && this.previous.get(key) !== signature) {
          const width = Math.max(1, cell.width);
          if (cell.width !== 0 && changed.length < maxCells) {
            changed.push({ row, col, width, chars: cell.chars });
          }
        }
        next.set(key, signature);
      }
    }
    this.previous = next;
    this.initialized = true;
    return changed;
  }
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
