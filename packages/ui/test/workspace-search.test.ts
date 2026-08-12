import { describe, expect, test } from "bun:test";
import {
  buildNoteSearchItems,
  buildProjectActionSearchItems,
  buildProjectSearchItems,
  buildReadmeSearchItems,
  buildSessionSearchItems,
  nextSearchKindsSelection,
  parseAgeQuery,
  searchItems,
  type SearchItem,
} from "../src/workspace-search";

const NOW = Date.parse("2026-07-30T12:00:00+02:00");

function item(
  partial: Partial<SearchItem> & Pick<SearchItem, "id" | "kind" | "title">,
): SearchItem {
  return {
    subtitle: "",
    text: "",
    keywords: [],
    ...partial,
  };
}

describe("workspace fuzzy search", () => {
  test("kind chips start off so selecting one filters to that kind", () => {
    expect(nextSearchKindsSelection(null, "project")).toEqual(["project"]);
    expect(nextSearchKindsSelection(["project"], "project")).toBeNull();
    expect(nextSearchKindsSelection(["project"], "session")).toEqual([
      "project",
      "session",
    ]);
  });

  test("ranks title matches ahead of weaker text matches", () => {
    const results = searchItems(
      [
        item({
          id: "snippet",
          kind: "snippet",
          title: "Recent message",
          text: "please fix the authentication flow",
          timestamp: new Date(NOW - 60_000).toISOString(),
        }),
        item({
          id: "title",
          kind: "session",
          title: "Authentication Flow",
          text: "misc notes",
          timestamp: new Date(NOW - 120_000).toISOString(),
        }),
      ],
      "auth flow",
      { now: NOW },
    );

    expect(results.map((r) => r.item.id)).toEqual(["title", "snippet"]);
  });

  test("filters by requested kinds", () => {
    const results = searchItems(
      [
        item({ id: "repo", kind: "project", title: "supergit" }),
        item({ id: "chat", kind: "session", title: "supergit visual UI" }),
      ],
      "supergit",
      { kinds: new Set(["project"]), now: NOW },
    );

    expect(results.map((r) => r.item.id)).toEqual(["repo"]);
  });

  test("matches English and German age phrases against timestamps", () => {
    const items = [
      item({
        id: "today",
        kind: "session",
        title: "today session",
        timestamp: "2026-07-30T08:00:00+02:00",
      }),
      item({
        id: "yesterday",
        kind: "session",
        title: "old session",
        timestamp: "2026-07-29T18:00:00+02:00",
      }),
      item({
        id: "week",
        kind: "session",
        title: "week session",
        timestamp: "2026-07-25T10:00:00+02:00",
      }),
    ];

    expect(
      searchItems(items, "yesterday", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["yesterday"]);
    expect(
      searchItems(items, "gestern", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["yesterday"]);
    expect(
      searchItems(items, "heute", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["today"]);
    expect(
      searchItems(items, "last week", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["today", "yesterday", "week"]);
  });

  test("combines age phrases with fuzzy text", () => {
    const results = searchItems(
      [
        item({
          id: "matching-old",
          kind: "session",
          title: "Performance testing",
          timestamp: "2026-07-29T18:00:00+02:00",
        }),
        item({
          id: "wrong-age",
          kind: "session",
          title: "Performance testing",
          timestamp: "2026-07-30T08:00:00+02:00",
        }),
        item({
          id: "wrong-text",
          kind: "session",
          title: "Website polish",
          timestamp: "2026-07-29T10:00:00+02:00",
        }),
      ],
      "performance yesterday",
      { now: NOW },
    );

    expect(results.map((r) => r.item.id)).toEqual(["matching-old"]);
  });

  test("builds project records from repo names, folder names, and worktree folders", () => {
    const items = buildProjectSearchItems([
      {
        id: "r1",
        name: "needle-engine",
        path: "/Users/herbst/git/needle-engine",
        color: "#9acd32",
        addedAt: "2026-07-01T00:00:00Z",
        worktrees: [
          {
            path: "/Users/herbst/wt/needle-engine-canary",
            branch: "canary",
            head: "abc",
            bare: false,
            detached: false,
            fileStatus: {},
            branchStatus: null,
            lastCommit: null,
          },
        ],
      },
    ]);

    expect(
      searchItems(items, "canary", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["project:r1"]);
    expect(
      searchItems(items, "needle-engine", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["project:r1"]);
  });

  test("prefers direct project title matches over weaker folder matches", () => {
    const items = buildProjectSearchItems([
      {
        id: "stable",
        name: "stable-fast-3d",
        path: "/Users/herbst/git/stable-fast-3d",
      },
      {
        id: "fastvid",
        name: "fastvid",
        path: "/Users/herbst/git/temp/fastvid",
      },
    ]);

    expect(
      searchItems(items, "fast", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["project:fastvid", "project:stable"]);
  });

  test("builds searchable project action records with common aliases", () => {
    const items = buildProjectActionSearchItems();

    expect(
      searchItems(items, "new project", { now: NOW }).map((r) => r.item.id),
    ).toEqual(["action:add-folder"]);
    expect(
      searchItems(items, "load folder", { now: NOW }).map((r) => r.item.id),
    ).toEqual(expect.arrayContaining(["action:add-folder"]));
    expect(
      searchItems(items, "load folder", { now: NOW })[0]?.item.id,
    ).toEqual("action:add-folder");
    expect(
      searchItems(items, "open from sessions", { now: NOW }).map(
        (r) => r.item.id,
      ),
    ).toEqual(["action:open-from-sessions"]);
  });

  test("builds session title and snippet records from visible sidebar fields", () => {
    const items = buildSessionSearchItems(
      [
        {
          agent: "codex",
          cwd: "/Users/herbst/git/supergit",
          source: "/tmp/session.jsonl",
          lastActive: "2026-07-29T12:00:00+02:00",
          manualTitle: "Performance Testing",
          lastUserMessage: "make history shorter",
          lastUserMessages: ["queue polish", "make history shorter"],
          messageCount: 40,
        },
      ],
      [
        {
          id: "repo1",
          name: "supergit",
          path: "/Users/herbst/git/supergit",
          color: "#7fad3a",
        },
      ],
    );

    expect(
      searchItems(items, "performance", {
        kinds: new Set(["session"]),
        now: NOW,
      }).map((r) => r.item.kind),
    ).toEqual(["session"]);
    expect(
      searchItems(items, "queue", { now: NOW }).map((r) => r.item.kind),
    ).toEqual(["snippet"]);
    expect(
      searchItems(items, "supergit", { now: NOW }).map((r) => r.item.kind),
    ).toContain("session");
    expect(
      searchItems(items, "supergit", { now: NOW }).map((r) => r.item.kind),
    ).not.toContain("folder");
    const sessionItem = items.find((entry) => entry.kind === "session");
    expect(sessionItem?.subtitle).toBe("supergit · supergit · codex");
    expect(sessionItem?.color).toBe("#7fad3a");
  });

  test("builds searchable note and readme records", () => {
    const noteItems = buildNoteSearchItems([
      {
        id: "n1",
        body: "Fix QR import\nCheck the media sidebar.",
        updatedAt: "2026-07-30T09:00:00+02:00",
        anchors: ["worktree:/Users/herbst/git/supergit"],
      },
    ]);
    const items = [
      ...noteItems,
      ...buildReadmeSearchItems([
        {
          id: "r1",
          repoId: "repo1",
          repoName: "Dashboard",
          path: "/Users/herbst/git/dashboard/README.md",
          text: "The project uses an image pipeline and live preview.",
        },
      ]),
    ];

    expect(
      searchItems(items, "media sidebar", { now: NOW }).map((r) => r.item.kind),
    ).toEqual(["note"]);
    expect(
      searchItems(items, "image pipeline", { now: NOW }).map(
        (r) => r.item.kind,
      ),
    ).toEqual(["readme"]);
    expect(noteItems[0]?.data).toMatchObject({
      id: "n1",
      anchors: ["worktree:/Users/herbst/git/supergit"],
    });
  });

  test("parseAgeQuery strips recognized age words and leaves the text query", () => {
    expect(parseAgeQuery("performance gestern", NOW)).toMatchObject({
      text: "performance",
    });
    expect(parseAgeQuery("last week supergit", NOW)).toMatchObject({
      text: "supergit",
    });
  });
});
