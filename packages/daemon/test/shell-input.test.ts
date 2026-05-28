/**
 * Unit tests for the per-shell keystroke line-buffer that powers the
 * Terminal-column command-history transcript.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { feedShellInput, clearShellInputBuffer } from "../src/shell-input";

const enc = new TextEncoder();

describe("feedShellInput", () => {
  beforeEach(() => {
    // The buffer map is module-scoped in server.ts. Each test uses a
    // unique termId to avoid bleed between cases.
  });

  test("simple ASCII command flushes on Enter (\\r)", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const lines = feedShellInput(id, enc.encode("ls -la\r"));
    expect(lines).toEqual(["ls -la"]);
  });

  test("\\n is treated the same as \\r as a line terminator", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const lines = feedShellInput(id, enc.encode("echo hi\n"));
    expect(lines).toEqual(["echo hi"]);
  });

  test("two commands in one chunk yield two lines", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const lines = feedShellInput(id, enc.encode("a\rb\r"));
    expect(lines).toEqual(["a", "b"]);
  });

  test("backspace (0x7f) erases the prior character before Enter", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    // type "lsx", backspace, "\r" → should log "ls"
    const chunk = new Uint8Array([0x6c, 0x73, 0x78, 0x7f, 0x0d]);
    const lines = feedShellInput(id, chunk);
    expect(lines).toEqual(["ls"]);
  });

  test("Ctrl-C (0x03) clears the in-flight buffer without logging", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    // type "rm -rf /" then Ctrl-C (no Enter)
    const part1 = feedShellInput(id, enc.encode("rm -rf /"));
    expect(part1).toEqual([]);
    const part2 = feedShellInput(id, new Uint8Array([0x03]));
    expect(part2).toEqual([]);
    // Hit Enter — buffer was cleared by Ctrl-C, nothing logged.
    const part3 = feedShellInput(id, enc.encode("\r"));
    expect(part3).toEqual([]);
  });

  test("arrow-key escape sequences are skipped, not added to the buffer", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    // "ls" + ESC[A (up arrow) + ESC[D (left arrow) + Enter
    const chunk = new Uint8Array([
      0x6c,
      0x73, // "ls"
      0x1b,
      0x5b,
      0x41, // ESC [ A — up
      0x1b,
      0x5b,
      0x44, // ESC [ D — left
      0x0d, // Enter
    ]);
    expect(feedShellInput(id, chunk)).toEqual(["ls"]);
  });

  test("a line split across two chunks still flushes as one", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    expect(feedShellInput(id, enc.encode("git "))).toEqual([]);
    expect(feedShellInput(id, enc.encode("status\r"))).toEqual(["git status"]);
  });

  test("whitespace-only Enter doesn't produce a log entry", () => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    expect(feedShellInput(id, enc.encode("\r"))).toEqual([]);
    expect(feedShellInput(id, enc.encode("   \r"))).toEqual([]);
  });
});
