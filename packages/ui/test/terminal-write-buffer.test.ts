/**
 * TerminalWriteBuffer holds raw PTY bytes for a terminal whose column is
 * off-screen, so we skip xterm's parse + DOM-render work until it's
 * visible again. It must preserve byte order and never discard bytes; the
 * cap only tells callers when to flush the complete backlog.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { get } from "svelte/store";
import {
  TerminalRepaintTracker,
  TerminalWriteBuffer,
  TerminalIoByteAccounting,
  TerminalInputTiming,
  splitTerminalWrite,
  createTerminalWriteQueue,
  TERMINAL_ACTIVITY_RECENT_MS,
  formatTerminalIoRate,
  isTerminalRecentlyActive,
  terminalIoStats,
  terminalIoStatsByKey,
  setTerminalIoStats,
  removeTerminalIoStats,
  _resetTerminalIoStatsForTests,
} from "../src/terminal-write-buffer";

test("replay waits for parser completion and yields between chunks without losing bytes", () => {
  const frames: (()=>void)[] = [], completions: (()=>void)[] = [], written: number[] = [];
  const queue = createTerminalWriteQueue({chunkBytes:4,
    schedule: callback => {frames.push(callback);return callback;}, cancel:()=>{},
    write: (bytes,done)=>{written.push(...bytes);completions.push(done);},
  });
  queue.push(new Uint8Array([1,2,3,4,5,6,7,8,9]));
  expect(written).toEqual([1,2,3,4]);
  expect(frames).toHaveLength(0);
  queue.push(new Uint8Array([10]));
  expect(written).toHaveLength(4);
  completions.shift()!();
  expect(frames).toHaveLength(1);
  expect(written).toHaveLength(4);
  while (frames.length) {frames.shift()!();completions.shift()!();}
  expect(written).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(queue.queuedBytes()).toBe(0);
});

test("small terminal echo starts immediately and old parser callbacks cannot revive a cleared queue", () => {
  const frames: (()=>void)[] = [], done: (()=>void)[] = [];
  const written: number[] = [];
  const queue = createTerminalWriteQueue({chunkBytes:4,schedule:fn=>{frames.push(fn);return fn;},cancel:()=>{},
    write:(bytes,complete)=>{written.push(...bytes);done.push(complete);}});
  queue.push(new Uint8Array([1]));
  expect(written).toEqual([1]);
  queue.push(new Uint8Array([2,3,4,5]));
  queue.clear();
  done.shift()!();
  expect(frames).toHaveLength(0);
  queue.push(new Uint8Array([6]));
  expect(written).toEqual([1,6]);
  queue.dispose();
  done.shift()!();
  queue.push(new Uint8Array([7]));
  expect(written).toEqual([1,6]);
});

const bytes = (...n: number[]) => new Uint8Array(n);

test("input timing measures the earliest pending input once and expires unrelated output", () => {
  const timing = new TerminalInputTiming();
  expect(timing.output(5)).toBeNull();
  timing.input(10);
  timing.input(20);
  expect(timing.output(40)).toBe(30);
  expect(timing.output(50)).toBeNull();
  timing.input(60);
  expect(timing.output(20_000)).toBeNull();
  timing.input(21_000);
  timing.reset();
  expect(timing.output(21_010)).toBeNull();
});

beforeEach(() => {
  _resetTerminalIoStatsForTests();
});

describe("TerminalWriteBuffer", () => {
  test("starts empty; flush returns null", () => {
    const b = new TerminalWriteBuffer();
    expect(b.isEmpty).toBe(true);
    expect(b.pendingBytes).toBe(0);
    expect(b.flush()).toBe(null);
  });

  test("accumulates and flushes concatenated bytes in order", () => {
    const b = new TerminalWriteBuffer();
    b.push(bytes(1, 2));
    b.push(bytes(3));
    b.push(bytes(4, 5, 6));
    expect(b.isEmpty).toBe(false);
    expect(b.pendingBytes).toBe(6);
    expect(Array.from(b.flush()!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("flush resets the buffer so it can be reused", () => {
    const b = new TerminalWriteBuffer();
    b.push(bytes(1, 2, 3));
    b.flush();
    expect(b.isEmpty).toBe(true);
    expect(b.pendingBytes).toBe(0);
    expect(b.flush()).toBe(null);
    b.push(bytes(9));
    expect(Array.from(b.flush()!)).toEqual([9]);
  });

  test("push returns true when the buffer reaches the flush cap", () => {
    const b = new TerminalWriteBuffer(4);
    expect(b.push(bytes(1, 2))).toBe(false); // size 2 < cap 4
    expect(b.push(bytes(3, 4))).toBe(true); // size 4 == cap 4
    expect(Array.from(b.flush()!)).toEqual([1, 2, 3, 4]);
  });

  test("flush cap preserves every byte instead of trimming output", () => {
    const b = new TerminalWriteBuffer(4);
    b.push(bytes(1, 2));
    expect(b.push(bytes(5, 6))).toBe(true);
    expect(b.pendingBytes).toBe(4);
    expect(Array.from(b.flush()!)).toEqual([1, 2, 5, 6]);
    expect(b.push(bytes(6))).toBe(false);
    expect(Array.from(b.flush()!)).toEqual([6]);
  });

  test("a single oversized chunk is preserved whole", () => {
    const b = new TerminalWriteBuffer(4);
    expect(b.push(bytes(1, 2, 3, 4, 5, 6))).toBe(true);
    expect(b.pendingBytes).toBe(6);
    expect(Array.from(b.flush()!)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("splitTerminalWrite", () => {
  test("returns small writes unchanged", () => {
    const input = bytes(1, 2, 3);
    expect(splitTerminalWrite(input, 4)).toEqual([input]);
  });

  test("splits large writes into ordered subarrays", () => {
    const chunks = splitTerminalWrite(bytes(1, 2, 3, 4, 5), 2);
    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });
});

describe("terminalIoStats", () => {
  test("exposes mounted terminal throughput by stable key", () => {
    setTerminalIoStats("session-source-a", {
      visible: false,
      rxBytesPerSec: 1536,
      txBytesPerSec: 8,
      rxBytesTotal: 4096,
      txBytesTotal: 40,
      lastActivityAt: 1000,
      hiddenBufferedBytes: 2048,
      hiddenFlushes: 1,
    });

    expect(get(terminalIoStatsByKey)).toEqual({
      "session-source-a": {
        visible: false,
        rxBytesPerSec: 1536,
        txBytesPerSec: 8,
        rxBytesTotal: 4096,
        txBytesTotal: 40,
        lastActivityAt: 1000,
        hiddenBufferedBytes: 2048,
        hiddenFlushes: 1,
      },
    });
  });

  test("formats compact inbound rate labels for the dock", () => {
    expect(formatTerminalIoRate(987)).toBe("987/s");
    expect(formatTerminalIoRate(1536)).toBe("1.5k/s");
    expect(formatTerminalIoRate(1024 * 1024 * 2.25)).toBe("2.3m/s");
  });

  test("aggregates mounted terminal throughput and visibility", () => {
    setTerminalIoStats("a", {
      visible: true,
      rxBytesPerSec: 120,
      txBytesPerSec: 8,
      rxBytesTotal: 1000,
      txBytesTotal: 40,
      lastActivityAt: 1000,
      hiddenBufferedBytes: 0,
      hiddenFlushes: 1,
    });
    setTerminalIoStats("b", {
      visible: false,
      rxBytesPerSec: 30,
      txBytesPerSec: 2,
      rxBytesTotal: 2000,
      txBytesTotal: 10,
      lastActivityAt: 2000,
      hiddenBufferedBytes: 512,
      hiddenFlushes: 3,
    });

    expect(get(terminalIoStats)).toEqual({
      terminals: 2,
      visible: 1,
      paused: 1,
      rxBytesPerSec: 150,
      txBytesPerSec: 10,
      rxBytesTotal: 3000,
      txBytesTotal: 50,
      lastActivityAt: 2000,
      hiddenBufferedBytes: 512,
      hiddenFlushes: 4,
    });
  });

  test("drops a terminal when its view unmounts", () => {
    setTerminalIoStats("a", {
      visible: true,
      rxBytesPerSec: 120,
      txBytesPerSec: 8,
      rxBytesTotal: 1000,
      txBytesTotal: 40,
      lastActivityAt: 1000,
      hiddenBufferedBytes: 0,
      hiddenFlushes: 1,
    });
    removeTerminalIoStats("a");

    expect(get(terminalIoStats).terminals).toBe(0);
  });

  test("classifies terminals active for a short window after I/O", () => {
    expect(TERMINAL_ACTIVITY_RECENT_MS).toBe(4_000);
    expect(
      isTerminalRecentlyActive(
        {
          visible: true,
          rxBytesPerSec: 0,
          txBytesPerSec: 0,
          rxBytesTotal: 0,
          txBytesTotal: 0,
          lastActivityAt: 10_000,
          hiddenBufferedBytes: 0,
          hiddenFlushes: 0,
        },
        13_999,
      ),
    ).toBe(true);
    expect(
      isTerminalRecentlyActive(
        {
          visible: true,
          rxBytesPerSec: 0,
          txBytesPerSec: 0,
          rxBytesTotal: 0,
          txBytesTotal: 0,
          lastActivityAt: 10_000,
          hiddenBufferedBytes: 0,
          hiddenFlushes: 0,
        },
        14_001,
      ),
    ).toBe(false);
    expect(
      isTerminalRecentlyActive(
        {
          visible: true,
          rxBytesPerSec: 0,
          txBytesPerSec: 0,
          rxBytesTotal: 0,
          txBytesTotal: 0,
          lastActivityAt: null,
          hiddenBufferedBytes: 0,
          hiddenFlushes: 0,
        },
        10_000,
      ),
    ).toBe(false);
  });
});

describe("TerminalIoByteAccounting", () => {
  test("counts hidden daemon-observed bytes as inbound activity", () => {
    const accounting = new TerminalIoByteAccounting();

    expect(accounting.observeHiddenBytes(5)).toBe(5);
    expect(accounting.pendingHiddenBytes).toBe(5);
  });

  test("does not double-count hidden bytes when their raw backlog later flushes", () => {
    const accounting = new TerminalIoByteAccounting();

    accounting.observeHiddenBytes(5);
    expect(accounting.countRawBytes(3)).toBe(0);
    expect(accounting.pendingHiddenBytes).toBe(2);
    expect(accounting.countRawBytes(4)).toBe(2);
    expect(accounting.pendingHiddenBytes).toBe(0);
  });
});

describe("TerminalRepaintTracker", () => {
  function grid(rows: string[]): (row: number, col: number) => any {
    return (row, col) => ({
      chars: rows[row]?.[col] ?? "",
      width: 1,
      code: rows[row]?.charCodeAt(col) ?? 0,
      fgColorMode: 0,
      bgColorMode: 0,
      fgColor: 0,
      bgColor: 0,
      attrs: 0,
    });
  }

  test("baselines the first rendered rows without flashing the whole terminal", () => {
    const tracker = new TerminalRepaintTracker();

    expect(
      tracker.captureRenderedRows({
        start: 0,
        end: 1,
        cols: 3,
        readCell: grid(["abc", "def"]),
      }),
    ).toEqual([]);
  });

  test("returns only cells whose rendered content or attributes changed", () => {
    const tracker = new TerminalRepaintTracker();
    tracker.captureRenderedRows({
      start: 0,
      end: 1,
      cols: 3,
      readCell: grid(["abc", "def"]),
    });

    expect(
      tracker.captureRenderedRows({
        start: 0,
        end: 1,
        cols: 3,
        readCell: grid(["aXc", "deZ"]),
      }),
    ).toEqual([
      { row: 0, col: 1, width: 1, chars: "X" },
      { row: 1, col: 2, width: 1, chars: "Z" },
    ]);
  });

  test("ignores continuation cells for wide characters", () => {
    const tracker = new TerminalRepaintTracker();
    tracker.captureRenderedRows({
      start: 0,
      end: 0,
      cols: 3,
      readCell: (row, col) => ({
        chars: col === 0 ? "界" : "",
        width: col === 0 ? 2 : col === 1 ? 0 : 1,
        code: col === 0 ? 30028 : 0,
        fgColorMode: 0,
        bgColorMode: 0,
        fgColor: 0,
        bgColor: 0,
        attrs: 0,
      }),
    });

    expect(
      tracker.captureRenderedRows({
        start: 0,
        end: 0,
        cols: 3,
        readCell: (row, col) => ({
          chars: col === 0 ? "語" : "",
          width: col === 0 ? 2 : col === 1 ? 0 : 1,
          code: col === 0 ? 35486 : 0,
          fgColorMode: 0,
          bgColorMode: 0,
          fgColor: 0,
          bgColor: 0,
          attrs: 0,
        }),
      }),
    ).toEqual([{ row: 0, col: 0, width: 2, chars: "語" }]);
  });

  test("reset clears the baseline so re-enabling starts quiet", () => {
    const tracker = new TerminalRepaintTracker();
    tracker.captureRenderedRows({
      start: 0,
      end: 0,
      cols: 2,
      readCell: grid(["ab"]),
    });
    tracker.reset();

    expect(
      tracker.captureRenderedRows({
        start: 0,
        end: 0,
        cols: 2,
        readCell: grid(["zz"]),
      }),
    ).toEqual([]);
  });

  test("caps reported cells without losing the new baseline", () => {
    const tracker = new TerminalRepaintTracker();
    tracker.captureRenderedRows({
      start: 0,
      end: 0,
      cols: 4,
      readCell: grid(["abcd"]),
    });

    expect(
      tracker.captureRenderedRows({
        start: 0,
        end: 0,
        cols: 4,
        maxCells: 2,
        readCell: grid(["WXYZ"]),
      }),
    ).toEqual([
      { row: 0, col: 0, width: 1, chars: "W" },
      { row: 0, col: 1, width: 1, chars: "X" },
    ]);
    expect(
      tracker.captureRenderedRows({
        start: 0,
        end: 0,
        cols: 4,
        maxCells: 2,
        readCell: grid(["WXYZ"]),
      }),
    ).toEqual([]);
  });
});
