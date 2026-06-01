/**
 * Tests for the fuzzy session matcher behind the session search popover.
 * The matcher operates on the AgentSession shape the daemon already emits
 * (title/firstUserMessage/lastUserMessage[s]) — no transcript reads.
 */

import { test, expect, describe } from "bun:test";
import {
  filterSessions,
  scoreSession,
  activityRank,
  orderByOpenActivity,
  recentlyActiveSources,
  orderNoQuery,
  RECENT_ACTIVITY_MS,
} from "../src/sessionSearch";
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

describe("activityRank", () => {
  test("ranks most-recently-active first", () => {
    const rank = activityRank([
      mk({ source: "old", lastActive: "2026-05-10T00:00:00Z" }),
      mk({ source: "new", lastActive: "2026-05-12T00:00:00Z" }),
      mk({ source: "mid", lastActive: "2026-05-11T00:00:00Z" }),
    ]);
    expect(rank.get("new")).toBe(0);
    expect(rank.get("mid")).toBe(1);
    expect(rank.get("old")).toBe(2);
  });

  test("does not mutate the input order", () => {
    const sessions = [
      mk({ source: "old", lastActive: "2026-05-10T00:00:00Z" }),
      mk({ source: "new", lastActive: "2026-05-12T00:00:00Z" }),
    ];
    activityRank(sessions);
    expect(sessions.map((s) => s.source)).toEqual(["old", "new"]);
  });
});

describe("orderByOpenActivity", () => {
  test("reproduces the open-time order regardless of input order", () => {
    const openRank = activityRank([
      mk({ source: "new", lastActive: "2026-05-12T00:00:00Z" }),
      mk({ source: "old", lastActive: "2026-05-10T00:00:00Z" }),
    ]);
    // Same sessions arrive in a different order on a later poll.
    const reshuffled = [
      mk({ source: "old", lastActive: "2026-05-10T00:00:00Z" }),
      mk({ source: "new", lastActive: "2026-05-12T00:00:00Z" }),
    ];
    expect(
      orderByOpenActivity(reshuffled, openRank).map((s) => s.source),
    ).toEqual(["new", "old"]);
  });

  test("holds open-time order even when lastActive changes after open", () => {
    const openRank = activityRank([
      mk({ source: "a", lastActive: "2026-05-12T00:00:00Z" }),
      mk({ source: "b", lastActive: "2026-05-11T00:00:00Z" }),
    ]);
    // 'b' just became the most recent, but the cursor is hovering — the
    // frozen rank must keep 'a' on top so the row doesn't jump.
    const updated = [
      mk({ source: "a", lastActive: "2026-05-12T00:00:00Z" }),
      mk({ source: "b", lastActive: "2026-05-13T00:00:00Z" }),
    ];
    expect(orderByOpenActivity(updated, openRank).map((s) => s.source)).toEqual(
      ["a", "b"],
    );
  });

  test("sessions absent from the rank sort after known ones, newest first", () => {
    const openRank = activityRank([
      mk({ source: "known", lastActive: "2026-05-12T00:00:00Z" }),
    ]);
    const list = [
      mk({ source: "newer-after-open", lastActive: "2026-05-14T00:00:00Z" }),
      mk({ source: "known", lastActive: "2026-05-12T00:00:00Z" }),
      mk({ source: "older-after-open", lastActive: "2026-05-13T00:00:00Z" }),
    ];
    expect(orderByOpenActivity(list, openRank).map((s) => s.source)).toEqual([
      "known",
      "newer-after-open",
      "older-after-open",
    ]);
  });

  test("does not mutate the input", () => {
    const openRank = activityRank([mk({ source: "a" }), mk({ source: "b" })]);
    const list = [mk({ source: "b" }), mk({ source: "a" })];
    orderByOpenActivity(list, openRank);
    expect(list.map((s) => s.source)).toEqual(["b", "a"]);
  });
});

describe("recentlyActiveSources", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");

  test("includes sessions within the window, excludes older ones", () => {
    const set = recentlyActiveSources(
      [
        mk({ source: "fresh", lastActive: "2026-06-01T11:50:00Z" }), // 10m
        mk({ source: "edge", lastActive: "2026-06-01T11:30:00Z" }), // 30m exactly
        mk({ source: "stale", lastActive: "2026-06-01T11:00:00Z" }), // 60m
      ],
      now,
    );
    expect(set.has("fresh")).toBe(true);
    expect(set.has("edge")).toBe(true); // boundary is inclusive
    expect(set.has("stale")).toBe(false);
  });

  test("defaults to a 30-minute window", () => {
    expect(RECENT_ACTIVITY_MS).toBe(30 * 60 * 1000);
  });

  test("ignores unparseable timestamps", () => {
    const set = recentlyActiveSources(
      [mk({ source: "bad", lastActive: "not-a-date" })],
      now,
    );
    expect(set.has("bad")).toBe(false);
  });
});

describe("orderNoQuery", () => {
  function rankOf(...sessions: AgentSession[]) {
    return activityRank(sessions);
  }

  test("recent tier floats above starred, then the rest", () => {
    const sessions = [
      mk({ source: "starred-old", lastActive: "2026-05-30T00:00:00Z" }),
      mk({ source: "recent", lastActive: "2026-06-01T11:55:00Z" }),
      mk({ source: "plain-old", lastActive: "2026-05-29T00:00:00Z" }),
    ];
    const openRank = rankOf(...sessions);
    const recent = new Set(["recent"]);
    const starred = new Set(["starred-old"]);
    expect(
      orderNoQuery(sessions, openRank, recent, starred).map((s) => s.source),
    ).toEqual(["recent", "starred-old", "plain-old"]);
  });

  test("a session both recent and starred lands in the recent tier", () => {
    const sessions = [
      mk({ source: "starred-only", lastActive: "2026-05-30T00:00:00Z" }),
      mk({ source: "recent-starred", lastActive: "2026-06-01T11:55:00Z" }),
    ];
    const openRank = rankOf(...sessions);
    const recent = new Set(["recent-starred"]);
    const starred = new Set(["recent-starred", "starred-only"]);
    expect(
      orderNoQuery(sessions, openRank, recent, starred).map((s) => s.source),
    ).toEqual(["recent-starred", "starred-only"]);
  });

  test("within each tier, open-time activity order holds", () => {
    const sessions = [
      mk({ source: "r1", lastActive: "2026-06-01T11:59:00Z" }),
      mk({ source: "r2", lastActive: "2026-06-01T11:58:00Z" }),
      mk({ source: "s1", lastActive: "2026-05-30T00:00:00Z" }),
      mk({ source: "x1", lastActive: "2026-05-20T00:00:00Z" }),
    ];
    const openRank = rankOf(...sessions);
    const out = orderNoQuery(
      sessions,
      openRank,
      new Set(["r1", "r2"]),
      new Set(["s1"]),
    );
    expect(out.map((s) => s.source)).toEqual(["r1", "r2", "s1", "x1"]);
  });

  test("no recent and no starred → plain activity order", () => {
    const sessions = [
      mk({ source: "a", lastActive: "2026-05-30T00:00:00Z" }),
      mk({ source: "b", lastActive: "2026-05-31T00:00:00Z" }),
    ];
    const openRank = rankOf(...sessions);
    expect(
      orderNoQuery(sessions, openRank, new Set(), new Set()).map(
        (s) => s.source,
      ),
    ).toEqual(["b", "a"]);
  });
});
