import { test, expect, describe } from "bun:test";
import { fuzzyScore, relativeAge } from "../src/mention-providers";

describe("fuzzyScore", () => {
  test("exact whole-string match scores top", () => {
    expect(fuzzyScore("Fix", "fix")).toBe(100);
  });

  test("prefix substring beats elsewhere substring", () => {
    expect(fuzzyScore("Fix the bug", "fix")).toBeGreaterThan(
      fuzzyScore("Postfix routing", "fix"),
    );
  });

  test("word-boundary substring beats inside-a-word substring", () => {
    // After space → boundary; inside "autofix" → mid-word.
    expect(fuzzyScore("post fix routing", "fix")).toBeGreaterThan(
      fuzzyScore("autofix routing", "fix"),
    );
  });

  test("subsequence falls through when no substring matches", () => {
    // "a-u-t-h" appears in order, scattered through the string.
    expect(fuzzyScore("Add Updates To Hubs", "auth")).toBeGreaterThan(0);
  });

  test("tighter subsequence scores higher than stretched", () => {
    expect(fuzzyScore("auth handler", "auh")).toBeGreaterThan(
      fuzzyScore("a______u______h__________________dler", "auh"),
    );
  });

  test("missing chars return 0", () => {
    expect(fuzzyScore("nothing relevant", "xyz")).toBe(0);
  });

  test("empty query returns 1 (everything matches, sort by other criteria)", () => {
    expect(fuzzyScore("anything", "")).toBe(1);
  });

  test("whitespace in query is collapsed", () => {
    // "fix bug" with whitespace collapsed → "fixbug" → looks for
    // the chars f-i-x-b-u-g as a substring or in-order subsequence.
    expect(fuzzyScore("fixbug now", "fix bug")).toBeGreaterThan(0);
  });

  test("case-insensitive", () => {
    expect(fuzzyScore("FIX", "fix")).toBe(100);
    expect(fuzzyScore("fix", "FIX")).toBe(100);
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-05-16T12:00:00.000Z");

  test("formats sub-minute as seconds", () => {
    const iso = new Date(now - 30 * 1000).toISOString();
    expect(relativeAge(iso, now)).toBe("30s");
  });

  test("formats minutes", () => {
    const iso = new Date(now - 5 * 60 * 1000).toISOString();
    expect(relativeAge(iso, now)).toBe("5m");
  });

  test("formats hours", () => {
    const iso = new Date(now - 2 * 3600 * 1000).toISOString();
    expect(relativeAge(iso, now)).toBe("2h");
  });

  test("formats days under a month", () => {
    const iso = new Date(now - 5 * 86400 * 1000).toISOString();
    expect(relativeAge(iso, now)).toBe("5d");
  });

  test("falls back to yyyy-mm beyond a month", () => {
    const iso = "2025-12-04T10:00:00.000Z";
    // Anything ≥ 30 days ago should yield the year-month stamp from
    // the original timestamp (not "now"), so the user can read it.
    expect(relativeAge(iso, now)).toBe("2025-12");
  });

  test("returns empty string on a parse miss", () => {
    expect(relativeAge("not a date", now)).toBe("");
  });
});
