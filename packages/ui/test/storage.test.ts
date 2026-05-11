import { test, expect, describe } from "bun:test";
import {
  ExpandedStore,
  OpenSessionsStore,
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
});
