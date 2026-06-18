import { describe, expect, it } from "bun:test";
import type { FrontendErrorEntry } from "../src/errors";
import {
  anchorLabel,
  errorKindLabel,
  eventLabel,
  eventToText,
  type Event,
  type Repo,
} from "../src/event-format";

function entry(overrides: Partial<FrontendErrorEntry> = {}): FrontendErrorEntry {
  return {
    id: "e1",
    timestamp: "2026-06-02T12:00:00.000Z",
    kind: "uncaught",
    source: "browser",
    message: "boom",
    ...overrides,
  };
}

function ev(overrides: Partial<Event> = {}): Event {
  return {
    id: "v1",
    timestamp: "2026-06-02T12:00:00.000Z",
    type: "noop",
    actor: "user",
    payload: {},
    undone: false,
    reversible: true,
    redoable: false,
    ...overrides,
  };
}

describe("errorKindLabel", () => {
  it("maps server", () => {
    expect(errorKindLabel(entry({ kind: "server" }))).toBe("server");
  });
  it("maps fetch", () => {
    expect(errorKindLabel(entry({ kind: "fetch" }))).toBe("fetch");
  });
  it("maps diagnostic", () => {
    expect(errorKindLabel(entry({ kind: "diagnostic" }))).toBe("diag");
  });
  it("maps rejection to unhandled", () => {
    expect(errorKindLabel(entry({ kind: "rejection" }))).toBe("unhandled");
  });
  it("maps uncaught (the fallthrough)", () => {
    expect(errorKindLabel(entry({ kind: "uncaught" }))).toBe("uncaught");
  });
});

describe("eventToText", () => {
  it("renders header + message only when no extras present", () => {
    const e = entry({
      timestamp: "T",
      kind: "fetch",
      source: "daemon",
      message: "msg",
    });
    expect(eventToText(e)).toBe("T FETCH daemon\nmsg");
  });

  it("renders request line with status, count, stack and JSON extra", () => {
    const e = entry({
      timestamp: "T",
      kind: "server",
      source: "daemon",
      method: "GET",
      route: "/api/repos",
      status: 500,
      message: "Internal Error",
      count: 3,
      stack: "at foo\nat bar",
      extra: { a: 1 },
    });
    expect(eventToText(e)).toBe(
      [
        "T SERVER daemon",
        "GET /api/repos → 500",
        "Internal Error",
        "(×3 occurrences)",
        "",
        "at foo\nat bar",
        "",
        JSON.stringify({ a: 1 }, null, 2),
      ].join("\n"),
    );
  });

  it("renders request line without status when status is undefined", () => {
    const e = entry({
      timestamp: "T",
      kind: "fetch",
      source: "browser",
      method: "POST",
      route: "/api/x",
      message: "failed",
    });
    expect(eventToText(e)).toBe("T FETCH browser\nPOST /api/x\nfailed");
  });

  it("omits count line when count is 1", () => {
    const e = entry({ timestamp: "T", message: "m", count: 1 });
    expect(eventToText(e)).toBe("T UNCAUGHT browser\nm");
  });

  it("omits JSON extra block when extra is empty", () => {
    const e = entry({ timestamp: "T", message: "m", extra: {} });
    expect(eventToText(e)).toBe("T UNCAUGHT browser\nm");
  });
});

const repos: Repo[] = [
  {
    name: "alpha",
    path: "/repos/alpha",
    worktrees: [
      { path: "/repos/alpha/main", branch: "main" },
      { path: "/repos/alpha/feat", branch: "feature/x" },
    ],
  },
  {
    name: "beta",
    path: "/repos/beta",
    worktrees: [{ path: "/repos/beta/wt", branch: "dev" }],
  },
];

describe("anchorLabel", () => {
  it("returns empty string for undefined anchor", () => {
    expect(anchorLabel(undefined, repos)).toBe("");
  });
  it("resolves a worktree anchor to repo · branch", () => {
    expect(anchorLabel("worktree:/repos/alpha/feat", repos)).toBe(
      "alpha · feature/x",
    );
  });
  it("falls back to basename when worktree path has no match", () => {
    expect(anchorLabel("worktree:/gone/some/wt-dir", repos)).toBe("wt-dir");
  });
  it("resolves a repo anchor to the repo name", () => {
    expect(anchorLabel("repo:/repos/beta", repos)).toBe("beta");
  });
  it("falls back to basename when repo path has no match", () => {
    expect(anchorLabel("repo:/gone/proj", repos)).toBe("proj");
  });
  it("renders a commit anchor truncated to 8 chars", () => {
    expect(anchorLabel("commit:0123456789abcdef", repos)).toBe(
      "commit 01234567",
    );
  });
  it("returns the raw string for an unrecognized anchor", () => {
    expect(anchorLabel("weird:thing", repos)).toBe("weird:thing");
  });
});

describe("eventLabel", () => {
  it("add_repo uses inverse repo name", () => {
    expect(
      eventLabel(ev({ type: "add_repo", inverse: { repo: { name: "alpha" } } }), repos),
    ).toBe("Added alpha");
  });
  it("add_repo falls back to payload path basename", () => {
    expect(
      eventLabel(ev({ type: "add_repo", payload: { path: "/x/y/gamma/" } }), repos),
    ).toBe("Added gamma");
  });
  it("add_repo unknown when nothing resolves", () => {
    expect(eventLabel(ev({ type: "add_repo", payload: {} }), repos)).toBe(
      "Added (unknown)",
    );
  });
  it("remove_repo uses inverse name then path", () => {
    expect(
      eventLabel(ev({ type: "remove_repo", inverse: { repo: { path: "/p/beta" } } }), repos),
    ).toBe("Removed /p/beta");
  });
  it("remove_repo unknown when nothing resolves", () => {
    expect(eventLabel(ev({ type: "remove_repo", inverse: {} }), repos)).toBe(
      "Removed (unknown)",
    );
  });
  it("rename_repo shows old → new", () => {
    expect(
      eventLabel(
        ev({ type: "rename_repo", payload: { newName: "neo" }, inverse: { oldName: "old" } }),
        repos,
      ),
    ).toBe("Renamed old → neo");
  });
  it("create_note with excerpt and resolved anchor", () => {
    expect(
      eventLabel(
        ev({
          type: "create_note",
          inverse: { note: { body: "hello world", anchors: ["repo:/repos/beta"] } },
        }),
        repos,
      ),
    ).toBe("Created note “hello world” · beta");
  });
  it("remove_note with excerpt and worktree anchor", () => {
    expect(
      eventLabel(
        ev({
          type: "remove_note",
          inverse: { note: { body: "todo", anchors: ["worktree:/repos/alpha/main"] } },
        }),
        repos,
      ),
    ).toBe("Deleted note “todo” · alpha · main");
  });
  it("create_note with no body and no anchor is just the verb", () => {
    expect(
      eventLabel(ev({ type: "create_note", inverse: { note: {} } }), repos),
    ).toBe("Created note");
  });
  it("session_imported renders enriched fields", () => {
    expect(
      eventLabel(
        ev({
          type: "session_imported",
          payload: {
            title: "My Session",
            originMachineLabel: "laptop",
            repoName: "alpha",
          },
        }),
        repos,
      ),
    ).toBe("Imported “My Session” from laptop → alpha");
  });
  it("session_imported falls back when fields are missing", () => {
    expect(
      eventLabel(ev({ type: "session_imported", payload: {} }), repos),
    ).toBe("Imported session from another machine → repo");
  });
  it("returns the raw type for unhandled events", () => {
    expect(eventLabel(ev({ type: "custom_thing" }), repos)).toBe("custom_thing");
  });
});
