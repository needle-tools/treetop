/**
 * Tests for the fuzzy session matcher behind the session search popover.
 * The matcher operates on the AgentSession shape the daemon already emits
 * (title/firstUserMessage/lastUserMessage[s]) — no transcript reads.
 */

import { test, expect, describe } from "bun:test";
import { filterSessions, scoreSession } from "../src/sessionSearch";
import type { AgentSession } from "../src/sessionSearch";

function mk(partial: Partial<AgentSession>): AgentSession {
  return {
    agent: "claude",
    cwd: "/r",
    lastActive: "2026-05-12T00:00:00Z",
    source: partial.source ?? Math.random().toString(),
    ...partial,
  };
}

describe("scoreSession", () => {
  test("title hit beats firstUserMessage hit", () => {
    const a = mk({ title: "fix auth bug" });
    const b = mk({ firstUserMessage: "fix auth bug", title: "unrelated" });
    expect(scoreSession(a, "auth")).toBeGreaterThan(scoreSession(b, "auth"));
  });

  test("firstUserMessage hit beats lastUserMessage hit", () => {
    const a = mk({ firstUserMessage: "implement caching" });
    const b = mk({ lastUserMessage: "implement caching" });
    expect(scoreSession(a, "caching")).toBeGreaterThan(
      scoreSession(b, "caching"),
    );
  });

  test("manualTitle scores like title", () => {
    const a = mk({ manualTitle: "fix auth bug" });
    const b = mk({ firstUserMessage: "fix auth bug" });
    expect(scoreSession(a, "auth")).toBeGreaterThan(scoreSession(b, "auth"));
  });

  test("case-insensitive", () => {
    const s = mk({ title: "Fix Auth Bug" });
    expect(scoreSession(s, "auth")).toBeGreaterThan(0);
    expect(scoreSession(s, "AUTH")).toBeGreaterThan(0);
  });

  test("substring scores higher than subsequence", () => {
    const sub = mk({ title: "abcde" });
    const subseq = mk({ title: "axbxcxdxe" });
    expect(scoreSession(sub, "abc")).toBeGreaterThan(
      scoreSession(subseq, "abc"),
    );
    // both still match
    expect(scoreSession(subseq, "abc")).toBeGreaterThan(0);
  });

  test("returns 0 when no field contains the query", () => {
    const s = mk({ title: "fix auth bug", firstUserMessage: "do the thing" });
    expect(scoreSession(s, "kubernetes")).toBe(0);
  });
});

describe("filterSessions", () => {
  test("returns all sessions in original order when query is empty", () => {
    const sessions = [mk({ source: "a" }), mk({ source: "b" })];
    expect(filterSessions(sessions, "").map((s) => s.source)).toEqual([
      "a",
      "b",
    ]);
  });

  test("returns all sessions when query is whitespace", () => {
    const sessions = [mk({ source: "a" }), mk({ source: "b" })];
    expect(filterSessions(sessions, "   ").map((s) => s.source)).toEqual([
      "a",
      "b",
    ]);
  });

  test("drops non-matching sessions", () => {
    const sessions = [
      mk({ source: "a", title: "fix auth bug" }),
      mk({ source: "b", title: "kube migration" }),
    ];
    expect(filterSessions(sessions, "auth").map((s) => s.source)).toEqual([
      "a",
    ]);
  });

  test("sorts matches by score desc", () => {
    const sessions = [
      mk({ source: "weak", lastUserMessage: "do auth thing later" }),
      mk({ source: "strong", title: "fix auth bug" }),
    ];
    expect(filterSessions(sessions, "auth").map((s) => s.source)).toEqual([
      "strong",
      "weak",
    ]);
  });

  test("breaks score ties by lastActive desc", () => {
    const sessions = [
      mk({
        source: "old",
        title: "fix auth bug",
        lastActive: "2026-05-10T00:00:00Z",
      }),
      mk({
        source: "new",
        title: "fix auth bug",
        lastActive: "2026-05-12T00:00:00Z",
      }),
    ];
    expect(filterSessions(sessions, "auth").map((s) => s.source)).toEqual([
      "new",
      "old",
    ]);
  });

  test("matches across lastUserMessages array", () => {
    const sessions = [
      mk({
        source: "a",
        lastUserMessages: ["unrelated", "kubernetes deploy", "more"],
      }),
    ];
    expect(filterSessions(sessions, "kubernetes").map((s) => s.source)).toEqual(
      ["a"],
    );
  });
});
