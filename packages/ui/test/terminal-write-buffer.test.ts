/**
 * TerminalWriteBuffer holds raw PTY bytes for a terminal whose column is
 * off-screen, so we skip xterm's parse + DOM-render work until it's
 * visible again. It must preserve byte order and never discard bytes; the
 * cap only tells callers when to flush the complete backlog.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { get } from "svelte/store";
import {
  TerminalWriteBuffer,
  terminalIoStats,
  setTerminalIoStats,
  removeTerminalIoStats,
  _resetTerminalIoStatsForTests,
} from "../src/terminal-write-buffer";

const bytes = (...n: number[]) => new Uint8Array(n);

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

describe("terminalIoStats", () => {
  test("aggregates mounted terminal throughput and visibility", () => {
    setTerminalIoStats("a", {
      visible: true,
      rxBytesPerSec: 120,
      txBytesPerSec: 8,
      rxBytesTotal: 1000,
      txBytesTotal: 40,
      hiddenBufferedBytes: 0,
      hiddenFlushes: 1,
    });
    setTerminalIoStats("b", {
      visible: false,
      rxBytesPerSec: 30,
      txBytesPerSec: 2,
      rxBytesTotal: 2000,
      txBytesTotal: 10,
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
      hiddenBufferedBytes: 0,
      hiddenFlushes: 1,
    });
    removeTerminalIoStats("a");

    expect(get(terminalIoStats).terminals).toBe(0);
  });
});
