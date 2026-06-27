import { test, expect, describe } from "bun:test";
import {
  resolveImagePasteBehavior,
  shouldThrottlePaste,
  chunkPasteBody,
  PASTE_THROTTLE_THRESHOLD_CODEPOINTS,
} from "../src/terminal-image-paste";

describe("resolveImagePasteBehavior", () => {
  test("auto: codex reads clipboard bytes → direct", () => {
    expect(resolveImagePasteBehavior("auto", "codex")).toBe("direct");
  });

  test("auto: claude does not → attachment (the regression we are fixing)", () => {
    expect(resolveImagePasteBehavior("auto", "claude")).toBe("attachment");
  });

  test("auto: copilot / ollama / shell / unknown all fall back to attachment", () => {
    for (const agent of ["copilot", "ollama", "shell", "what", undefined]) {
      expect(resolveImagePasteBehavior("auto", agent)).toBe("attachment");
    }
  });

  test("explicit overrides win regardless of agent", () => {
    // A user who set 'direct' globally gets direct even on claude...
    expect(resolveImagePasteBehavior("direct", "claude")).toBe("direct");
    // ...and 'attachment' forces the path flow even on codex.
    expect(resolveImagePasteBehavior("attachment", "codex")).toBe("attachment");
  });

  test("missing / unknown setting is treated as auto", () => {
    expect(resolveImagePasteBehavior(undefined, "codex")).toBe("direct");
    expect(resolveImagePasteBehavior("", "claude")).toBe("attachment");
  });
});

describe("shouldThrottlePaste", () => {
  test("small pastes stay on the single-shot fast path", () => {
    expect(shouldThrottlePaste("hello", 10)).toBe(false);
    expect(shouldThrottlePaste("", 10)).toBe(false);
  });

  test("a paste at exactly the threshold is not throttled", () => {
    expect(shouldThrottlePaste("a".repeat(10), 10)).toBe(false);
  });

  test("a paste one past the threshold is throttled", () => {
    expect(shouldThrottlePaste("a".repeat(11), 10)).toBe(true);
  });

  test("counts code points, not UTF-16 units (emoji aren't double counted)", () => {
    // 5 emoji = 5 code points but 10 UTF-16 units. With a threshold of 5 it
    // must NOT throttle — otherwise emoji-heavy text trips the cap too early.
    expect(shouldThrottlePaste("😀".repeat(5), 5)).toBe(false);
    expect(shouldThrottlePaste("😀".repeat(6), 5)).toBe(true);
  });

  test("defaults to the exported threshold", () => {
    expect(
      shouldThrottlePaste("a".repeat(PASTE_THROTTLE_THRESHOLD_CODEPOINTS)),
    ).toBe(false);
    expect(
      shouldThrottlePaste("a".repeat(PASTE_THROTTLE_THRESHOLD_CODEPOINTS + 1)),
    ).toBe(true);
  });
});

describe("chunkPasteBody", () => {
  test("empty text yields no chunks", () => {
    expect(chunkPasteBody("", 4)).toEqual([]);
  });

  test("text at or under the chunk size is a single chunk", () => {
    expect(chunkPasteBody("abcd", 4)).toEqual(["abcd"]);
    expect(chunkPasteBody("ab", 4)).toEqual(["ab"]);
  });

  test("splits into chunks of at most chunkSize code points", () => {
    expect(chunkPasteBody("abcdefg", 3)).toEqual(["abc", "def", "g"]);
  });

  test("exact multiples split evenly with no trailing empty chunk", () => {
    expect(chunkPasteBody("abcdef", 3)).toEqual(["abc", "def"]);
  });

  test("never splits a surrogate pair — each chunk round-trips", () => {
    const text = "😀😁😂🤣😃"; // 5 code points, 10 UTF-16 units
    const chunks = chunkPasteBody(text, 2);
    expect(chunks).toEqual(["😀😁", "😂🤣", "😃"]);
    // No chunk contains a lone surrogate (which would encode to U+FFFD).
    for (const c of chunks) expect(c).not.toContain("�");
    expect(chunks.join("")).toBe(text);
  });

  test("reassembly is lossless across mixed content and sizes", () => {
    const text = "line1\nline2 with 🚀 and ünïcödé\t\ttabs" + "x".repeat(50);
    for (const size of [1, 2, 3, 7, 13, 64]) {
      expect(chunkPasteBody(text, size).join("")).toBe(text);
    }
  });

  test("non-positive chunk size degrades to a single chunk (no infinite loop)", () => {
    expect(chunkPasteBody("abc", 0)).toEqual(["abc"]);
  });
});
