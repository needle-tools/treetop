import { describe, expect, test } from "bun:test";
import { findRangesInText, isContextFindShortcut } from "../src/context-find";

function keyEventLike(
  overrides: Partial<KeyboardEvent>,
): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: "",
    ...overrides,
  } as KeyboardEvent;
}

describe("context find", () => {
  test("uses Cmd/Ctrl+F without hijacking shifted or alt shortcuts", () => {
    expect(
      isContextFindShortcut(
        keyEventLike({ metaKey: true, code: "KeyF" }),
      ),
    ).toBe(true);
    expect(
      isContextFindShortcut(
        keyEventLike({ ctrlKey: true, code: "KeyF" }),
      ),
    ).toBe(true);
    expect(
      isContextFindShortcut(
        keyEventLike({ ctrlKey: true, shiftKey: true, code: "KeyF" }),
      ),
    ).toBe(false);
    expect(
      isContextFindShortcut(
        keyEventLike({ ctrlKey: true, altKey: true, code: "KeyF" }),
      ),
    ).toBe(false);
  });

  test("finds case-insensitive ranges without overlapping duplicates", () => {
    expect(findRangesInText("Codex codex CODEX", "codex")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
    expect(findRangesInText("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});
