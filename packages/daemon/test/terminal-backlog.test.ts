// Bounded terminal output backlog.
//
// Regression context (2026-06-13): f8e7ee3 moved terminal output muting from
// the PTY (helper pause) to delivery-level buffering in the daemon, but only
// capped the backlog for sockets the UI had marked HIDDEN. A socket marked
// VISIBLE whose WebKit renderer stops draining — an occluded / backgrounded
// Treetop window, where the IntersectionObserver never fires `false` — kept
// buffering PTY bytes without bound, so the daemon (inside Treetop.app) grew
// to multiple GB until the machine OOM'd.
//
// The fix: cap the VISIBLE path and pause PTY output upstream when there are
// no visible sockets. Hidden output must stay byte-exact while it is buffered:
// trimming a terminal stream can split cursor / SGR control sequences from the
// text they apply to, leaving xterm to render an orphaned tail in the wrong
// state when the column is revealed.

import { test, expect, describe } from "bun:test";
import {
  trimTerminalBacklog,
  TERMINAL_VISIBLE_BACKLOG_CAP_BYTES,
} from "../src/terminal-backlog";

const OLD_HIDDEN_CAP_BYTES = 1024 * 1024;

// Simulate the server's per-socket backlog: push a chunk, then trim.
function feed(
  chunks: Uint8Array[],
  bytes: number,
  chunk: Uint8Array,
  visible: boolean,
): number {
  chunks.push(chunk);
  bytes += chunk.byteLength;
  return trimTerminalBacklog(chunks, bytes, visible);
}

function sumBytes(chunks: Uint8Array[]): number {
  return chunks.reduce((n, c) => n + c.byteLength, 0);
}

describe("trimTerminalBacklog", () => {
  test("keeps the visible OOM guard finite", () => {
    expect(TERMINAL_VISIBLE_BACKLOG_CAP_BYTES).toBeGreaterThan(0);
  });

  test("under the hidden cap, nothing is dropped", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (let i = 0; i < 4; i++) {
      bytes = feed(chunks, bytes, new Uint8Array(64 * 1024), false);
    }
    expect(chunks.length).toBe(4);
    expect(bytes).toBe(256 * 1024);
    expect(bytes).toBe(sumBytes(chunks));
  });

  test("a HIDDEN socket preserves every byte instead of trimming to a tail", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const prefix = new TextEncoder().encode("\x1b[2K\x1b[31m");
    bytes = feed(chunks, bytes, prefix, false);
    bytes = feed(
      chunks,
      bytes,
      new Uint8Array(OLD_HIDDEN_CAP_BYTES + 1),
      false,
    );
    expect(bytes).toBe(sumBytes(chunks));
    expect(chunks[0]!.byteLength).toBe(prefix.byteLength);
    expect(Array.from(chunks[0]!)).toEqual(Array.from(prefix));
  });

  // The actual OOM regression: a VISIBLE socket that never drains.
  test("a VISIBLE socket is also bounded (occluded-window OOM guard)", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const chunk = 256 * 1024; // 256 KB
    // Push 100 MB through a visible-but-undrainable socket.
    for (let i = 0; i < 400; i++) {
      bytes = feed(chunks, bytes, new Uint8Array(chunk), true);
      expect(bytes).toBeLessThanOrEqual(
        TERMINAL_VISIBLE_BACKLOG_CAP_BYTES + chunk,
      );
    }
    expect(bytes).toBe(sumBytes(chunks));
  });

  test("VISIBLE trimming keeps the most recent chunk", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const chunk = 256 * 1024;
    for (let i = 0; i < 40; i++) {
      const c = new Uint8Array(chunk);
      c[0] = i & 0xff; // tag each chunk so we can identify it
      bytes = feed(chunks, bytes, c, true);
    }
    // The newest chunk (tag 39) must still be present and last.
    expect(chunks[chunks.length - 1]![0]).toBe(39);
  });

  test("never drops the only remaining chunk, even if it exceeds the cap", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // A single visible chunk larger than the cap.
    bytes = feed(
      chunks,
      bytes,
      new Uint8Array(TERMINAL_VISIBLE_BACKLOG_CAP_BYTES + 512 * 1024),
      true,
    );
    expect(chunks.length).toBe(1);
    expect(bytes).toBe(sumBytes(chunks));
  });
});
