import { test, expect, describe } from "bun:test";
import { DecPrivateModeTracker } from "../src/dec-private-modes";

const enc = new TextEncoder();
const dec = new TextDecoder();
const feed = (t: DecPrivateModeTracker, s: string) => t.observe(enc.encode(s));
const reassert = (t: DecPrivateModeTracker) => dec.decode(t.reassertBytes());

describe("DecPrivateModeTracker", () => {
  test("nothing seen → empty re-assert", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "plain output with no escapes");
    expect(reassert(t)).toBe("");
  });

  test("tracks bracketed paste enable and re-asserts it (issue #10)", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "claude prompt\x1b[?2004hready");
    expect(t.snapshot()).toEqual({ 2004: true });
    expect(reassert(t)).toBe("\x1b[?2004h");
  });

  test("last write wins for a mode (enable then disable)", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[?2004h");
    feed(t, "\x1b[?2004l");
    expect(reassert(t)).toBe("\x1b[?2004l");
  });

  test("handles multiple modes in one CSI (semicolon list)", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[?1000;1006h");
    expect(t.snapshot()).toEqual({ 1000: true, 1006: true });
  });

  test("ignores untracked / risky modes (alt-screen 1049)", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[?1049h\x1b[?2004h");
    expect(t.snapshot()).toEqual({ 2004: true });
    expect(reassert(t)).toBe("\x1b[?2004h");
  });

  test("reassembles a sequence split across two chunks", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "out\x1b[?20");
    feed(t, "04hmore");
    expect(t.snapshot()).toEqual({ 2004: true });
  });

  test("reassembles when the split lands right after ESC", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "out\x1b");
    feed(t, "[?2004h");
    expect(t.snapshot()).toEqual({ 2004: true });
  });

  test("reassembles when the split lands between [ and ?", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "out\x1b[");
    feed(t, "?2004h");
    expect(t.snapshot()).toEqual({ 2004: true });
  });

  test("does not treat a DEC mode query (?2004$p) as a set/reset", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[?2004$p");
    expect(t.snapshot()).toEqual({});
    expect(reassert(t)).toBe("");
  });

  test("non-private CSI (SGR colour) does not register a mode", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[1;31mred\x1b[0m");
    expect(t.snapshot()).toEqual({});
  });

  test("re-asserts several tracked modes (cursor keys + paste + mouse)", () => {
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[?1h\x1b[?2004h\x1b[?1000h");
    const out = reassert(t);
    expect(out).toContain("\x1b[?1h");
    expect(out).toContain("\x1b[?2004h");
    expect(out).toContain("\x1b[?1000h");
  });

  test("an oversized unterminated partial is dropped, not carried forever", () => {
    const t = new DecPrivateModeTracker();
    // ESC [ ? then 200 digits with no final byte — must not blow up or hang.
    feed(t, "\x1b[?" + "1".repeat(200));
    feed(t, "h");
    // The runaway partial was dropped; the lone trailing "h" registers nothing.
    expect(t.snapshot()).toEqual({});
  });

  test("real-world: enable lands early, only the tail is replayed later", () => {
    // Models the bug: enable happens, then lots of output; the tracker still
    // knows the mode is on regardless of what the replay window contains.
    const t = new DecPrivateModeTracker();
    feed(t, "\x1b[?2004h");
    feed(t, "x".repeat(5000));
    expect(reassert(t)).toBe("\x1b[?2004h");
  });
});
