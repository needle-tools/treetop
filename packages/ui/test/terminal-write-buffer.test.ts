/**
 * TerminalWriteBuffer holds raw PTY bytes for a terminal whose column is
 * off-screen, so we skip xterm's parse + DOM-render work until it's
 * visible again. It must (a) preserve byte order exactly — terminal
 * output is a stream and a reorder corrupts ANSI escapes — and (b) stay
 * bounded: a chatty hidden terminal can't be allowed to grow the buffer
 * without limit, so push() signals when the cap is hit and the caller
 * should flush the batch through to xterm.
 */

import { test, expect, describe } from "bun:test";
import { TerminalWriteBuffer } from "../src/terminal-write-buffer";

const bytes = (...n: number[]) => new Uint8Array(n);

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

  test("push returns true once the cap is reached, false before", () => {
    const b = new TerminalWriteBuffer(4);
    expect(b.push(bytes(1, 2))).toBe(false); // size 2 < cap 4
    expect(b.push(bytes(3, 4))).toBe(true); // size 4 >= cap 4
  });

  test("after a cap-driven flush, buffering resumes from empty", () => {
    const b = new TerminalWriteBuffer(4);
    b.push(bytes(1, 2));
    const full = b.push(bytes(3, 4, 5)); // size 5 >= cap → caller flushes
    expect(full).toBe(true);
    // Caller's flush writes the whole ordered batch through.
    expect(Array.from(b.flush()!)).toEqual([1, 2, 3, 4, 5]);
    // Next chunk starts a fresh batch, still in order.
    expect(b.push(bytes(6))).toBe(false);
    expect(Array.from(b.flush()!)).toEqual([6]);
  });
});
