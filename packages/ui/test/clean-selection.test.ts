import { test, expect, describe } from "bun:test";
import { cleanSelection } from "../src/clean-selection";

describe("cleanSelection", () => {
  test("returns single-line text unchanged", () => {
    expect(cleanSelection("hello world", () => false)).toBe("hello world");
  });

  test("preserves real newlines", () => {
    const raw = "line 1\nline 2\nline 3";
    expect(cleanSelection(raw, () => false)).toBe("line 1\nline 2\nline 3");
  });

  test("strips soft-wrap newlines", () => {
    // Simulates a long command that wrapped at column 40:
    // "sed -i '/<haystack_readonly>/,/<\\/has" + wrap + "tack>/...'
    const raw =
      "sed -i 'some very long command that wr\naps at the column boundary'";
    // Line 1 (index 1) is a continuation of line 0
    expect(cleanSelection(raw, (i) => i === 1)).toBe(
      "sed -i 'some very long command that wraps at the column boundary'",
    );
  });

  test("handles mix of real and soft-wrap newlines", () => {
    const raw = [
      "first line that is very long and wra", // real line start
      "ps to the next row", // soft wrap (index 1)
      "second real line", // real newline (index 2)
      "third line also wraps at the col bo", // real newline (index 3)
      "undary here", // soft wrap (index 4)
    ].join("\n");

    const wrapped = new Set([1, 4]);
    const result = cleanSelection(raw, (i) => wrapped.has(i));

    expect(result).toBe(
      "first line that is very long and wraps to the next row\n" +
        "second real line\n" +
        "third line also wraps at the col boundary here",
    );
  });

  test("handles multiple consecutive soft wraps", () => {
    const raw = "aaaa\nbbbb\ncccc\ndddd";
    // All lines after the first are soft wraps
    const result = cleanSelection(raw, (i) => i > 0);
    expect(result).toBe("aaaabbbbccccdddd");
  });

  test("handles empty string", () => {
    expect(cleanSelection("", () => false)).toBe("");
  });

  test("preserves trailing newline when not wrapped", () => {
    const raw = "command\n";
    expect(cleanSelection(raw, () => false)).toBe("command\n");
  });

  test("strips trailing newline at soft-wrap boundary", () => {
    const raw = "long command\n";
    expect(cleanSelection(raw, (i) => i === 1)).toBe("long command");
  });
});
