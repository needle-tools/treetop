import { test, expect, describe, beforeEach } from "bun:test";
import {
  sessionsProvider,
  commitsProvider,
  clearFetchCache,
} from "../src/mention-providers";

/**
 * Integration tests for the picker's providers — verifies that the
 * /api/agents and /api/commits → PickItem mapping actually surfaces
 * results to the picker. Earlier unit tests only covered the pure
 * fuzzy/recents math; this file is the one that would catch "the
 * picker shows nothing" regressions.
 *
 * We monkey-patch globalThis.fetch with a route-aware fake so the
 * providers can be exercised without a running daemon. The fake's
 * `setRouteJson` API also lets tests assert on the URL the provider
 * built (e.g. confirming the worktree path is passed correctly).
 */

type Route = (url: string) => unknown | null;
let installedRoutes: Route[] = [];
const realFetch = globalThis.fetch;

function setRouteJson(matcher: (url: string) => boolean, data: unknown): void {
  installedRoutes.push((url) => (matcher(url) ? data : null));
}

function setRouteError(matcher: (url: string) => boolean, status = 500): void {
  installedRoutes.push((url) => {
    if (!matcher(url)) return null;
    throw new Error(`HTTP ${status}`);
  });
}

beforeEach(() => {
  installedRoutes = [];
  clearFetchCache();
  // @ts-expect-error — we knowingly replace fetch for the test run.
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of installedRoutes) {
      const data = route(url);
      if (data !== null) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("not mocked", { status: 404 });
  };
  return () => {
    globalThis.fetch = realFetch;
  };
});

describe("sessionsProvider.search", () => {
  test("returns top items by lastActive when query is empty", async () => {
    setRouteJson((u) => u === "/api/agents", [
      { agent: "claude", cwd: "/repo/a", lastActive: "2026-05-15T10:00:00Z", source: "s1", title: "Old session" },
      { agent: "claude", cwd: "/repo/a", lastActive: "2026-05-16T10:00:00Z", source: "s2", title: "New session" },
      { agent: "codex", cwd: "/repo/a", lastActive: "2026-05-14T10:00:00Z", source: "s3", title: "Older session" },
    ]);
    const out = await sessionsProvider.search("", {}, 5);
    // Most recent first.
    expect(out.map((it) => it.label)).toEqual([
      "New session",
      "Old session",
      "Older session",
    ]);
    // All map to targetType "session" + the source as value.
    expect(out[0]!.targetType).toBe("session");
    expect(out[0]!.value).toBe("s2");
  });

  test("fuzzy-matches across title, firstUserMessage, agent, cwd", async () => {
    setRouteJson((u) => u === "/api/agents", [
      {
        agent: "claude",
        cwd: "/Users/m/git/supergit/packages/ui",
        lastActive: "2026-05-16T10:00:00Z",
        source: "s1",
        title: "Refactor the dock",
        firstUserMessage: "help me with the auth refactor",
      },
      {
        agent: "codex",
        cwd: "/Users/m/git/supergit/packages/daemon",
        lastActive: "2026-05-16T11:00:00Z",
        source: "s2",
        title: "Unrelated work on the parser",
      },
    ]);
    // "auth" hits the firstUserMessage on s1 but nothing on s2.
    const out = await sessionsProvider.search("auth", {}, 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe("s1");
  });

  test("filters by currentRepoPath, falls back to all when scope is empty", async () => {
    setRouteJson((u) => u === "/api/agents", [
      { agent: "claude", cwd: "/wrong/path", lastActive: "2026-05-16T10:00:00Z", source: "s1", title: "Wrong repo" },
      { agent: "claude", cwd: "/repo/main", lastActive: "2026-05-16T11:00:00Z", source: "s2", title: "Right repo" },
    ]);
    const inScope = await sessionsProvider.search("", { currentRepoPath: "/repo/main" }, 5);
    expect(inScope.map((it) => it.value)).toEqual(["s2"]);
    // Cache makes the second call return the cached body, so we don't
    // need to re-set the route. With no scope, both items come back.
    const noScope = await sessionsProvider.search("", {}, 5);
    expect(noScope.map((it) => it.value).sort()).toEqual(["s1", "s2"]);
  });

  test("falls back to all sessions when in-scope filter would return empty", async () => {
    setRouteJson((u) => u === "/api/agents", [
      { agent: "claude", cwd: "/elsewhere", lastActive: "2026-05-16T10:00:00Z", source: "s1", title: "Elsewhere" },
    ]);
    const out = await sessionsProvider.search("", { currentRepoPath: "/repo/no-sessions" }, 5);
    // Better to show the user a cross-repo session than nothing.
    expect(out.map((it) => it.value)).toEqual(["s1"]);
  });

  test("returns [] when the endpoint errors", async () => {
    setRouteError((u) => u === "/api/agents");
    const out = await sessionsProvider.search("", {}, 5);
    expect(out).toEqual([]);
  });
});

describe("commitsProvider.search", () => {
  test("returns commits sorted by time when query is empty", async () => {
    setRouteJson(
      (u) => u.startsWith("/api/commits?"),
      [
        { sha: "aaaaaa1", shortSha: "aaaaaa1", subject: "first", author: "alice", time: "2026-05-10T10:00:00Z" },
        { sha: "bbbbbb2", shortSha: "bbbbbb2", subject: "second", author: "bob", time: "2026-05-16T10:00:00Z" },
      ],
    );
    const out = await commitsProvider.search(
      "",
      { currentWorktreePath: "/wt" },
      5,
    );
    // Newer-first by time.
    expect(out.map((it) => it.id)).toEqual(["bbbbbb2", "aaaaaa1"]);
    // The chip display fields the user asked for: message + author + time.
    expect(out[0]!.targetType).toBe("commit");
    expect(out[0]!.label).toBe("second");
    expect(out[0]!.subtitle).toBe("bob");
    expect(typeof out[0]!.meta).toBe("string");
  });

  test("session PickItem splits agent / name / msgCount / age across dedicated fields", async () => {
    setRouteJson((u) => u === "/api/agents", [
      {
        agent: "claude",
        cwd: "/x",
        lastActive: "2026-05-16T10:00:00Z",
        source: "s1",
        title: "Refactor the dock",
        messageCount: 42,
      },
    ]);
    const out = await sessionsProvider.search("", {}, 5);
    expect(out).toHaveLength(1);
    // Per current layout: icon is driven by `agent`, label is the
    // title, subtitle is "{N} msg", meta is the time-since stamp.
    expect(out[0]!.agent).toBe("claude");
    expect(out[0]!.label).toBe("Refactor the dock");
    expect(out[0]!.subtitle).toBe("42 msg");
    expect(typeof out[0]!.meta).toBe("string");
    expect(out[0]!.meta!.length).toBeGreaterThan(0);
  });

  test("session without messageCount emits empty subtitle, still shows age in meta", async () => {
    setRouteJson((u) => u === "/api/agents", [
      {
        agent: "codex",
        cwd: "/x",
        lastActive: new Date(Date.now() - 3600 * 1000).toISOString(),
        source: "s1",
        title: "no-count session",
      },
    ]);
    const out = await sessionsProvider.search("", {}, 5);
    expect(out[0]!.agent).toBe("codex");
    expect(out[0]!.subtitle).toBe("");
    // Time-since stamp like "1h" / "59m" — the exact value depends
    // on clock drift between setup and assertion, so just match the
    // canonical compact-age shape.
    expect(out[0]!.meta).toMatch(/^\d+[smhd]$|^\d{4}-\d{2}$/);
  });

  test("commit PickItem carries scope.currentRepoProvider for icon rendering", async () => {
    setRouteJson(
      (u) => u.startsWith("/api/commits?"),
      [
        { sha: "a1", shortSha: "a1", subject: "Add auth", author: "alice", time: "2026-05-16T10:00:00Z" },
      ],
    );
    const out = await commitsProvider.search(
      "",
      { currentWorktreePath: "/wt", currentRepoProvider: "github" },
      5,
    );
    expect(out[0]!.provider).toBe("github");
  });

  test("fuzzy-matches subject + author", async () => {
    setRouteJson(
      (u) => u.startsWith("/api/commits?"),
      [
        { sha: "a1", shortSha: "a1", subject: "Fix auth flow", author: "alice", time: "2026-05-16T10:00:00Z" },
        { sha: "b2", shortSha: "b2", subject: "Refactor renderer", author: "bob", time: "2026-05-16T11:00:00Z" },
      ],
    );
    // Author "bob" should pull the second commit even though the
    // subject doesn't contain "bob".
    const out = await commitsProvider.search(
      "bob",
      { currentWorktreePath: "/wt" },
      5,
    );
    expect(out.map((it) => it.id)).toEqual(["b2"]);
  });

  test("encodes the worktree path in the URL", async () => {
    let seen = "";
    setRouteJson((u) => {
      if (u.startsWith("/api/commits?")) {
        seen = u;
        return [];
      }
      return null;
    }, []);
    await commitsProvider.search(
      "",
      { currentWorktreePath: "/path with space" },
      5,
    );
    expect(seen).toContain("path%20with%20space");
  });

  test("returns [] when scope.currentWorktreePath is missing", async () => {
    // No fetch route at all — provider should bail before any network.
    const out = await commitsProvider.search("anything", {}, 5);
    expect(out).toEqual([]);
  });
});

describe("fetchJsonCached (via providers)", () => {
  test("hits the network once across rapid repeat calls", async () => {
    let hits = 0;
    setRouteJson((u) => {
      if (u === "/api/agents") {
        hits++;
        return [
          {
            agent: "claude",
            cwd: "/x",
            lastActive: "2026-05-16T10:00:00Z",
            source: "s1",
            title: "only one",
          },
        ];
      }
      return null;
    }, null);
    await Promise.all([
      sessionsProvider.search("", {}, 5),
      sessionsProvider.search("", {}, 5),
      sessionsProvider.search("only", {}, 5),
    ]);
    // Three searches, one fetch — the dedup + TTL cache absorbs the
    // two repeats. Without the cache the popover would re-hit the
    // daemon on every reactive scope/recents flicker.
    expect(hits).toBe(1);
  });
});
