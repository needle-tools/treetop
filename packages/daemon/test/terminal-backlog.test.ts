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
// The fix: cap BOTH paths. Hidden keeps the tight 1 MB delivery buffer;
// visible gets a generous hard ceiling so an undrainable socket can never grow
// daemon memory without limit.

import { test, expect, describe } from "bun:test";
import {
  trimTerminalBacklog,
  TERMINAL_HIDDEN_BACKLOG_CAP_BYTES,
  TERMINAL_VISIBLE_BACKLOG_CAP_BYTES,
} from "../src/terminal-backlog";

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
  test("the visible cap is larger than the hidden cap", () => {
    expect(TERMINAL_VISIBLE_BACKLOG_CAP_BYTES).toBeGreaterThan(
      TERMINAL_HIDDEN_BACKLOG_CAP_BYTES,
    );
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

  test("a HIDDEN socket is bounded to ~the hidden cap, dropping oldest", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const chunk = 128 * 1024; // 128 KB
    // Push 10 MB through a 1 MB-capped hidden socket.
    for (let i = 0; i < 80; i++) {
      bytes = feed(chunks, bytes, new Uint8Array(chunk), false);
      expect(bytes).toBeLessThanOrEqual(
        TERMINAL_HIDDEN_BACKLOG_CAP_BYTES + chunk,
      );
    }
    expect(bytes).toBe(sumBytes(chunks));
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

  test("keeps the most recent chunk (drops from the front, in order)", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const chunk = 256 * 1024;
    for (let i = 0; i < 40; i++) {
      const c = new Uint8Array(chunk);
      c[0] = i & 0xff; // tag each chunk so we can identify it
      bytes = feed(chunks, bytes, c, false);
    }
    // The newest chunk (tag 39) must still be present and last.
    expect(chunks[chunks.length - 1]![0]).toBe(39);
  });

  test("never drops the only remaining chunk, even if it exceeds the cap", () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // A single chunk larger than the hidden cap.
    bytes = feed(
      chunks,
      bytes,
      new Uint8Array(TERMINAL_HIDDEN_BACKLOG_CAP_BYTES + 512 * 1024),
      false,
    );
    expect(chunks.length).toBe(1);
    expect(bytes).toBe(sumBytes(chunks));
  });
});
