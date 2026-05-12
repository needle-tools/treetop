import { test, expect, describe } from "bun:test";
import {
  ExpandedStore,
  OpenSessionsStore,
  VisibleWorktreesStore,
  effectiveVisibleWorktrees,
  filterToExistingSessions,
  type KVStore,
  type PersistedSession,
} from "../src/storage";

class MemStore implements KVStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

class ThrowingStore implements KVStore {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }
  setItem(): void {
    throw new Error("quota exceeded");
  }
}

const KEY = "supergit:commitsExpanded";

describe("ExpandedStore", () => {
  test("returns empty set when nothing is stored", () => {
    const s = new ExpandedStore(new MemStore(), KEY);
    expect([...s.load()]).toEqual([]);
  });

  test("save then load round-trips paths in order", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a", "/b/c", "/d e"]);
    expect([...s.load()]).toEqual(["/a", "/b/c", "/d e"]);
  });

  test("save replaces, not merges", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a", "/b"]);
    s.save(["/c"]);
    expect([...s.load()]).toEqual(["/c"]);
  });

  test("save with empty input clears the set", () => {
    const m = new MemStore();
    const s = new ExpandedStore(m, KEY);
    s.save(["/a"]);
    s.save([]);
    expect([...s.load()]).toEqual([]);
  });

  test("survives across instances pointing at the same storage", () => {
    const m = new MemStore();
    new ExpandedStore(m, KEY).save(["/a", "/b"]);
    const second = new ExpandedStore(m, KEY);
    expect([...second.load()]).toEqual(["/a", "/b"]);
  });

  test("returns empty set when stored value is not JSON", () => {
    const m = new MemStore();
    m.setItem(KEY, "{not json");
    expect([...new ExpandedStore(m, KEY).load()]).toEqual([]);
  });

  test("returns empty set when stored value is not an array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify({ a: 1 }));
    expect([...new ExpandedStore(m, KEY).load()]).toEqual([]);
  });

  test("filters out non-string entries from the stored array", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["a", 1, null, "b", { x: 1 }]));
    expect([...new ExpandedStore(m, KEY).load()]).toEqual(["a", "b"]);
  });

  test("swallows storage errors on save", () => {
    const s = new ExpandedStore(new ThrowingStore(), KEY);
    // Should not throw.
    s.save(["/anything"]);
  });

  test("returns empty set when storage throws on read", () => {
    const s = new ExpandedStore(new ThrowingStore(), KEY);
    expect([...s.load()]).toEqual([]);
  });
});

describe("OpenSessionsStore", () => {
  const KEY = "supergit:openSessions";

  test("returns {} when nothing is stored", () => {
    const s = new OpenSessionsStore(new MemStore(), KEY);
    expect(s.load()).toEqual({});
  });

  test("round-trips a multi-worktree map", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/Users/me/git/foo": [
        { agent: "claude", source: "/sess/a.jsonl" },
        { agent: "codex", source: "/sess/b.jsonl" },
      ],
      "/Users/me/git/bar": [{ agent: "claude", source: "/sess/c.jsonl" }],
    });
    expect(s.load()).toEqual({
      "/Users/me/git/foo": [
        { agent: "claude", source: "/sess/a.jsonl" },
        { agent: "codex", source: "/sess/b.jsonl" },
      ],
      "/Users/me/git/bar": [{ agent: "claude", source: "/sess/c.jsonl" }],
    });
  });

  test("save replaces previous data, not merges", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({ "/a": [{ agent: "claude", source: "/x.jsonl" }] });
    s.save({ "/b": [{ agent: "codex", source: "/y.jsonl" }] });
    expect(s.load()).toEqual({
      "/b": [{ agent: "codex", source: "/y.jsonl" }],
    });
  });

  test("returns {} on corrupted JSON", () => {
    const m = new MemStore();
    m.setItem(KEY, "{ not json");
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({});
  });

  test("returns {} when stored value is an array, not an object", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["/a", "/b"]));
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({});
  });

  test("filters entries with invalid agent values", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          { agent: "gpt5", source: "/bad.jsonl" },
          { agent: "claude", source: "/good.jsonl" },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [{ agent: "claude", source: "/good.jsonl" }],
    });
  });

  test("drops items without a source string", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          { agent: "claude" },
          { agent: "claude", source: "" },
          { agent: "claude", source: "/ok.jsonl" },
          "not an object",
          null,
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [{ agent: "claude", source: "/ok.jsonl" }],
    });
  });

  test("drops worktree entries whose list ends up empty", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/has-good": [{ agent: "claude", source: "/ok.jsonl" }],
        "/all-bad": [{ agent: "junk" }, null],
        "/non-array": "wat",
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/has-good": [{ agent: "claude", source: "/ok.jsonl" }],
    });
  });

  test("de-duplicates sessions by source within a worktree", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/a": [
          { agent: "claude", source: "/x.jsonl" },
          { agent: "claude", source: "/x.jsonl" },
          { agent: "claude", source: "/y.jsonl" },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/a": [
        { agent: "claude", source: "/x.jsonl" },
        { agent: "claude", source: "/y.jsonl" },
      ],
    });
  });

  test("survives across instances pointing at the same storage", () => {
    const m = new MemStore();
    new OpenSessionsStore(m, KEY).save({
      "/r": [{ agent: "codex", source: "/s.jsonl" }],
    });
    const next = new OpenSessionsStore(m, KEY);
    expect(next.load()).toEqual({
      "/r": [{ agent: "codex", source: "/s.jsonl" }],
    });
  });

  test("swallows storage errors on save and load", () => {
    const s = new OpenSessionsStore(new ThrowingStore(), KEY);
    s.save({ "/x": [{ agent: "claude", source: "/y.jsonl" }] });
    expect(s.load()).toEqual({});
  });

  test("preserves sessions whose source file is currently missing", () => {
    // The store does not validate paths against disk — it round-trips
    // exactly what callers hand it. This locks in the "don't forget a
    // session just because its file vanished temporarily" contract.
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [
        { agent: "claude", source: "/no/such/file/a.jsonl" },
        { agent: "codex", source: "/no/such/file/b.jsonl" },
      ],
    });
    expect(s.load()).toEqual({
      "/wt": [
        { agent: "claude", source: "/no/such/file/a.jsonl" },
        { agent: "codex", source: "/no/such/file/b.jsonl" },
      ],
    });
  });
});

describe("filterToExistingSessions", () => {
  const mkSess = (source: string): PersistedSession => ({
    agent: "claude",
    source,
  });

  test("returns only sessions whose source is in the existing set", () => {
    const persisted = [mkSess("/a.jsonl"), mkSess("/b.jsonl"), mkSess("/c.jsonl")];
    const existing = new Set(["/a.jsonl", "/c.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([
      mkSess("/a.jsonl"),
      mkSess("/c.jsonl"),
    ]);
  });

  test("returns empty when the existing set has none of the persisted sources", () => {
    const persisted = [mkSess("/a.jsonl"), mkSess("/b.jsonl")];
    const existing = new Set<string>(["/other.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([]);
  });

  test("returns empty when nothing is persisted", () => {
    expect(filterToExistingSessions([], new Set(["/a"]))).toEqual([]);
  });

  test("returns empty when existing set is empty even if persisted is not", () => {
    expect(
      filterToExistingSessions([mkSess("/a.jsonl")], new Set<string>()),
    ).toEqual([]);
  });

  test("does NOT mutate the persisted array (callers persist the full thing)", () => {
    // The whole point: if a file is missing the UI hides it, but the
    // store still keeps the entry. Verifying we don't accidentally
    // remove items from the input.
    const persisted = [mkSess("/keep.jsonl"), mkSess("/missing.jsonl")];
    const beforeJson = JSON.stringify(persisted);
    filterToExistingSessions(persisted, new Set(["/keep.jsonl"]));
    expect(JSON.stringify(persisted)).toBe(beforeJson);
  });

  // Regression: the "Terminal" column flow uses three synthetic source
  // prefixes that don't exist in /api/agents — they're supergit-internal
  // markers. The render-time filter must not drop them even when the
  // existing-sources set is empty (which it always is for shells, since
  // agentsForWorktree() only returns Claude/Codex/Copilot sessions).
  test("keeps __new__: synthetic sources even when existing is empty (brand-new TUI)", () => {
    const persisted = [mkSess("__new__:claude:abc")];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("keeps __attached__:shell: synthetic sources (reattached live shell after reload)", () => {
    // Without this, restoreLiveShells() in App.svelte would add the
    // column to openSessionsByWt but the render-time filter would
    // silently drop it because shells aren't in wt.agents.
    const persisted = [mkSess("__attached__:shell:t_abc_1")];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("keeps __transcript__:shell: synthetic sources (past-shell read-mode view)", () => {
    const persisted = [mkSess("__transcript__:shell:t_abc_1")];
    expect(filterToExistingSessions(persisted, new Set<string>())).toEqual(
      persisted,
    );
  });

  test("keeps synthetic sources mixed with file-backed ones", () => {
    const persisted = [
      mkSess("__attached__:shell:t_1"),
      mkSess("/agents/claude.jsonl"),
      mkSess("__transcript__:shell:t_2"),
      mkSess("/agents/missing.jsonl"),
    ];
    const existing = new Set(["/agents/claude.jsonl"]);
    expect(filterToExistingSessions(persisted, existing)).toEqual([
      mkSess("__attached__:shell:t_1"),
      mkSess("/agents/claude.jsonl"),
      mkSess("__transcript__:shell:t_2"),
    ]);
  });
});

describe("VisibleWorktreesStore", () => {
  const KEY = "supergit:visibleWorktrees";

  test("returns empty map when nothing stored", () => {
    const s = new VisibleWorktreesStore(new MemStore(), KEY);
    expect(s.load()).toEqual({});
  });

  test("round-trips a map of repoId -> paths", () => {
    const store = new MemStore();
    const s = new VisibleWorktreesStore(store, KEY);
    s.save({ rA: ["/path/a", "/path/b"], rB: ["/path/c"] });
    const reloaded = new VisibleWorktreesStore(store, KEY).load();
    expect(reloaded).toEqual({ rA: ["/path/a", "/path/b"], rB: ["/path/c"] });
  });

  test("save drops empty arrays and non-string entries on the way out", () => {
    const store = new MemStore();
    const s = new VisibleWorktreesStore(store, KEY);
    s.save({
      rA: ["/keep"],
      rEmpty: [],
      rGarbage: ["/ok", 42 as unknown as string, ""],
    });
    const reloaded = new VisibleWorktreesStore(store, KEY).load();
    expect(reloaded).toEqual({ rA: ["/keep"], rGarbage: ["/ok"] });
  });

  test("tolerates corrupt JSON without throwing", () => {
    const store = new MemStore();
    store.setItem(KEY, "{not json}");
    const s = new VisibleWorktreesStore(store, KEY);
    expect(s.load()).toEqual({});
  });

  test("tolerates a non-object root (array, string, null)", () => {
    const store = new MemStore();
    store.setItem(KEY, '["nope"]');
    expect(new VisibleWorktreesStore(store, KEY).load()).toEqual({});
    store.setItem(KEY, '"hello"');
    expect(new VisibleWorktreesStore(store, KEY).load()).toEqual({});
  });

  test("save swallows storage errors", () => {
    const s = new VisibleWorktreesStore(new ThrowingStore(), KEY);
    expect(() => s.save({ rA: ["/path"] })).not.toThrow();
  });

  test("load swallows storage errors", () => {
    const s = new VisibleWorktreesStore(new ThrowingStore(), KEY);
    expect(s.load()).toEqual({});
  });
});

describe("effectiveVisibleWorktrees", () => {
  test("returns [] when the repo has no worktrees on disk", () => {
    expect(effectiveVisibleWorktrees("rA", [], { rA: ["/anything"] })).toEqual([]);
  });

  test("with no stored entry, defaults to the first worktree on disk only", () => {
    // This is THE rule for new repos: adding a repo to supergit shows
    // only its main worktree by default; further worktrees must be
    // explicitly enabled via the picker.
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A", "/wt/A/feature", "/wt/A/other"],
        {},
      ),
    ).toEqual(["/repos/A"]);
  });

  test("respects an explicit stored list", () => {
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A", "/wt/A/feature", "/wt/A/other"],
        { rA: ["/wt/A/feature"] },
      ),
    ).toEqual(["/wt/A/feature"]);
  });

  test("an explicit empty list keeps the repo hidden — does NOT fall back to first wt", () => {
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A", "/wt/A/feature"],
        { rA: [] },
      ),
    ).toEqual([]);
  });

  test("filters out stored paths whose worktree no longer exists on disk", () => {
    expect(
      effectiveVisibleWorktrees(
        "rA",
        ["/repos/A"],
        { rA: ["/wt/A/feature-deleted", "/repos/A"] },
      ),
    ).toEqual(["/repos/A"]);
  });
});
