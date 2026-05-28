import { test, expect, describe } from "bun:test";
import { feedShellInput, clearShellInputBuffer } from "../src/shell-input";

describe("shell-input arrow key handling", () => {
  const id = "arrow-test";

  test("arrow up/down escape sequences are skipped (not captured as text)", () => {
    clearShellInputBuffer(id);
    // Arrow Up = ESC [ A  (0x1b 0x5b 0x41)
    const arrowUp = new Uint8Array([0x1b, 0x5b, 0x41]);
    const lines = feedShellInput(id, arrowUp);
    expect(lines).toEqual([]);
    clearShellInputBuffer(id);
  });

  test("arrow keys between typed text don't corrupt the buffer", () => {
    clearShellInputBuffer(id);
    // Type "ls", then arrow up, then Enter
    const input = new Uint8Array([
      0x6c,
      0x73, // "ls"
      0x1b,
      0x5b,
      0x41, // arrow up (skipped)
      0x0d, // Enter
    ]);
    const lines = feedShellInput(id, input);
    expect(lines).toEqual(["ls"]);
    clearShellInputBuffer(id);
  });

  test("multiple commands captured across Enter keystrokes", () => {
    clearShellInputBuffer(id);
    // "cd /tmp" Enter "ls -la" Enter
    const text = "cd /tmp\rls -la\r";
    const bytes = new Uint8Array(text.split("").map((c) => c.charCodeAt(0)));
    const lines = feedShellInput(id, bytes);
    expect(lines).toEqual(["cd /tmp", "ls -la"]);
    clearShellInputBuffer(id);
  });

  test("backspace removes last character", () => {
    clearShellInputBuffer(id);
    // "lss" backspace "Enter"
    const bytes = new Uint8Array([0x6c, 0x73, 0x73, 0x7f, 0x0d]);
    const lines = feedShellInput(id, bytes);
    expect(lines).toEqual(["ls"]);
    clearShellInputBuffer(id);
  });

  test("Ctrl-C clears current line", () => {
    clearShellInputBuffer(id);
    // "partial" Ctrl-C "real\r"
    const partial = new Uint8Array([
      ...Array.from("partial").map((c) => c.charCodeAt(0)),
      0x03, // Ctrl-C
      ...Array.from("real").map((c) => c.charCodeAt(0)),
      0x0d, // Enter
    ]);
    const lines = feedShellInput(id, partial);
    expect(lines).toEqual(["real"]);
    clearShellInputBuffer(id);
  });

  test("empty line after Enter is not captured", () => {
    clearShellInputBuffer(id);
    // Just Enter twice
    const bytes = new Uint8Array([0x0d, 0x0d]);
    const lines = feedShellInput(id, bytes);
    expect(lines).toEqual([]);
    clearShellInputBuffer(id);
  });
});
