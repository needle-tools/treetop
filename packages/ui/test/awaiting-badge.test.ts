/**
 * The favicon-painting side of awaitingBadge.ts needs a browser canvas
 * we don't have in `bun test`, so we just unit-test the pure title and
 * description helpers. The canvas path is exercised manually in the
 * browser.
 */

import { test, expect, describe } from "bun:test";
import {
  titleForCount,
  titleForState,
  descriptionForState,
  titleForSessions,
  descriptionForSessions,
  type TabSession,
} from "../src/awaitingBadge";

describe("titleForCount", () => {
  test("returns the base title when no sessions are waiting", () => {
    expect(titleForCount("supergit", 0)).toBe("supergit");
  });

  test("treats negative counts as zero (defensive)", () => {
    expect(titleForCount("supergit", -1)).toBe("supergit");
  });

  test("prefixes the count when at least one session waits", () => {
    expect(titleForCount("supergit", 1)).toBe("(1) supergit");
    expect(titleForCount("supergit", 7)).toBe("(7) supergit");
  });

  test("preserves the base title verbatim (no trimming surprises)", () => {
    expect(titleForCount("custom — name", 2)).toBe("(2) custom — name");
  });
});

describe("titleForState", () => {
  test("returns the base title when nothing is active", () => {
    expect(titleForState("supergit", { awaiting: 0, working: 0, idle: 0 })).toBe(
      "supergit",
    );
  });

  test("keeps the awaiting-count prefix so the tab strip still flags attention", () => {
    expect(titleForState("supergit", { awaiting: 2, working: 0, idle: 0 })).toBe(
      "(2) supergit — 2 waiting",
    );
  });

  test("appends a tooltip-friendly breakdown after the base title", () => {
    expect(titleForState("supergit", { awaiting: 1, working: 2, idle: 3 })).toBe(
      "(1) supergit — 1 waiting, 2 working, 3 idle",
    );
  });

  test("omits the prefix when only working/idle are active", () => {
    expect(titleForState("supergit", { awaiting: 0, working: 2, idle: 1 })).toBe(
      "supergit — 2 working, 1 idle",
    );
  });
});

describe("descriptionForState", () => {
  test("describes an empty state plainly", () => {
    expect(descriptionForState({ awaiting: 0, working: 0, idle: 0 })).toBe(
      "No active TUIs",
    );
  });

  test("phrases waiting first since that's what the user cares about", () => {
    expect(descriptionForState({ awaiting: 2, working: 1, idle: 0 })).toBe(
      "2 waiting for input, 1 working",
    );
  });

  test("singularizes the waiting label when it's exactly one", () => {
    expect(descriptionForState({ awaiting: 1, working: 0, idle: 0 })).toBe(
      "1 waiting for input",
    );
  });

  test("includes idle counts so og previews show the full picture", () => {
    expect(descriptionForState({ awaiting: 0, working: 0, idle: 3 })).toBe(
      "3 idle",
    );
  });
});

describe("titleForSessions", () => {
  const s = (
    state: TabSession["state"],
    name: string,
    agent = "claude",
  ): TabSession => ({ state, name, agent });

  test("returns the base title when there are no live sessions", () => {
    expect(titleForSessions("supergit", [])).toBe("supergit");
  });

  test("keeps the awaiting-count prefix even when listing names", () => {
    const sessions = [s("awaiting", "auth-fix"), s("awaiting", "profile")];
    expect(titleForSessions("supergit", sessions)).toBe(
      "(2) supergit — waiting: auth-fix (claude), profile (claude)",
    );
  });

  test("groups by state and shows agent in parens after each name", () => {
    const sessions = [
      s("awaiting", "auth-fix", "claude"),
      s("working", "refactor", "codex"),
      s("working", "perf-fix", "claude"),
    ];
    expect(titleForSessions("supergit", sessions)).toBe(
      "(1) supergit — waiting: auth-fix (claude) · working: refactor (codex), perf-fix (claude)",
    );
  });

  test("collapses idle sessions to a count (names aren't actionable when idle)", () => {
    const sessions = [
      s("working", "refactor"),
      s("idle", "a"),
      s("idle", "b"),
      s("idle", "c"),
    ];
    expect(titleForSessions("supergit", sessions)).toBe(
      "supergit — working: refactor (claude) · 3 idle",
    );
  });

  test("truncates long lists with a `+N more` suffix per category", () => {
    const sessions: TabSession[] = [
      s("working", "a"),
      s("working", "b"),
      s("working", "c"),
      s("working", "d"),
      s("working", "e"),
    ];
    expect(titleForSessions("supergit", sessions)).toBe(
      "supergit — working: a (claude), b (claude), c (claude) +2",
    );
  });

  test("falls back to the agent name when the session has no name yet", () => {
    expect(
      titleForSessions("supergit", [{ state: "working", name: "", agent: "codex" }]),
    ).toBe("supergit — working: codex");
  });
});

describe("descriptionForSessions", () => {
  test("plain string when nothing is live", () => {
    expect(descriptionForSessions([])).toBe("No active TUIs");
  });

  test("lists every session with its state — meta description has more room", () => {
    const sessions: TabSession[] = [
      { state: "awaiting", name: "auth-fix", agent: "claude" },
      { state: "working", name: "refactor", agent: "codex" },
      { state: "idle", name: "profile", agent: "claude" },
    ];
    expect(descriptionForSessions(sessions)).toBe(
      "1 waiting for input, 1 working, 1 idle · auth-fix (claude) waiting, refactor (codex) working, profile (claude) idle",
    );
  });
});
