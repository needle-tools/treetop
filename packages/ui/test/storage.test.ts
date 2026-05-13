import { test, expect, describe } from "bun:test";
import {
  ExpandedStore,
  OpenSessionsStore,
  VisibleWorktreesStore,
  cmdForOpenSession,
  effectiveVisibleWorktrees,
  filterToExistingSessions,
  stampDiscoveredSessionId,
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

describe("cmdForOpenSession", () => {
  test("shell always uses the user's default login shell, ignoring resumeSessionId", () => {
    expect(cmdForOpenSession({ agent: "shell" }, "/bin/zsh")).toEqual([
      "/bin/zsh",
    ]);
    // Even with a sid stamped (shouldn't happen for shells, but the
    // helper must be defensive): still defaultShell, not anything else.
    expect(
      cmdForOpenSession({ agent: "shell", resumeSessionId: "sid" }, "/bin/fish"),
    ).toEqual(["/bin/fish"]);
  });

  test("brand-new claude column (no sid) spawns bare `claude`", () => {
    // Mirrors the existing v0 behaviour for fresh TUIs — claude generates
    // its own session id on first spawn.
    expect(cmdForOpenSession({ agent: "claude" }, "/bin/zsh")).toEqual([
      "claude",
    ]);
  });

  test("claude with a stamped resumeSessionId uses `--resume` + dangerously-skip flag", () => {
    // This is the regression guard for the reload bug: once the activity
    // tail has surfaced the real claude session id, the next mount must
    // resume rather than spawn fresh. The --allow-dangerously-skip-
    // permissions flag matches the read-mode Resume path in SessionView.
    expect(
      cmdForOpenSession(
        { agent: "claude", resumeSessionId: "abc-123" },
        "/bin/zsh",
      ),
    ).toEqual([
      "claude",
      "--resume",
      "abc-123",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("brand-new codex column (no sid) spawns bare `codex`", () => {
    expect(cmdForOpenSession({ agent: "codex" }, "/bin/zsh")).toEqual(["codex"]);
  });

  test("codex with a stamped resumeSessionId uses `codex resume <sid>`", () => {
    // codex takes the session id as a positional after `resume`, matching
    // the read-mode Resume path in SessionView.svelte.
    expect(
      cmdForOpenSession(
        { agent: "codex", resumeSessionId: "ses_42" },
        "/bin/zsh",
      ),
    ).toEqual(["codex", "resume", "ses_42"]);
  });

  test("copilot ignores resumeSessionId in v0 (no resume semantics)", () => {
    expect(
      cmdForOpenSession(
        { agent: "copilot", resumeSessionId: "ignored" },
        "/bin/zsh",
      ),
    ).toEqual(["copilot"]);
  });
});

describe("stampDiscoveredSessionId", () => {
  const SID = "discovered-session-id";

  test("stamps the first matching __new__: column without a sid", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toEqual({
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: SID,
        },
      ],
    });
    // Doesn't mutate the input map.
    expect(before["/wt"]![0]!.resumeSessionId).toBeUndefined();
  });

  test("returns the same reference when nothing matched (no churn)", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "/agents/already-on-disk.jsonl" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    // Same reference — so reactive consumers can short-circuit.
    expect(after).toBe(before);
  });

  test("returns same reference when the cwd has no open sessions at all", () => {
    const before: Record<string, PersistedSession[]> = {
      "/other-wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toBe(before);
  });

  test("does NOT overwrite an already-stamped sid (first match wins)", () => {
    // Two columns: first already has a sid (stamped earlier), second is
    // unstamped. A second activity event should attach to the second one.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_1",
          resumeSessionId: "first-sid",
        },
        { agent: "claude", source: "__new__:claude:t_2" },
      ],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after["/wt"]).toEqual([
      {
        agent: "claude",
        source: "__new__:claude:t_1",
        resumeSessionId: "first-sid",
      },
      {
        agent: "claude",
        source: "__new__:claude:t_2",
        resumeSessionId: SID,
      },
    ]);
  });

  test("only matches the same agent — codex events don't stamp claude columns", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "codex",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toBe(before);
  });

  test("skips non-`__new__:` sources (existing JSONL columns already have their sid in the source)", () => {
    // A file-backed source's sessionId is the JSONL filename, so we
    // shouldn't stamp anything onto it from a drive-by activity event.
    const before: Record<string, PersistedSession[]> = {
      "/wt": [
        {
          agent: "claude",
          source:
            "/Users/me/.claude/projects/-Users-me-wt/abc-123.jsonl",
        },
      ],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: SID,
    });
    expect(after).toBe(before);
  });

  test("ignores empty sessionId (defensive)", () => {
    const before: Record<string, PersistedSession[]> = {
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    };
    const after = stampDiscoveredSessionId(before, {
      agent: "claude",
      cwd: "/wt",
      sessionId: "",
    });
    expect(after).toBe(before);
  });
});

describe("OpenSessionsStore + resumeSessionId round-trip", () => {
  const KEY = "supergit:openSessions-resume";

  test("persists resumeSessionId alongside agent/source", () => {
    // The core of the reload fix: after we stamp a sid on a __new__:
    // column, it must survive a page reload. Otherwise the next mount
    // is back to bare `claude` and the live conversation is lost.
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: "real-claude-sid-123",
        },
      ],
    });
    expect(s.load()).toEqual({
      "/wt": [
        {
          agent: "claude",
          source: "__new__:claude:t_abc",
          resumeSessionId: "real-claude-sid-123",
        },
      ],
    });
  });

  test("treats a missing resumeSessionId as plain optional (no field on output)", () => {
    const m = new MemStore();
    const s = new OpenSessionsStore(m, KEY);
    s.save({
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    });
    const loaded = s.load();
    expect(loaded).toEqual({
      "/wt": [{ agent: "claude", source: "__new__:claude:t_abc" }],
    });
    expect(loaded["/wt"]![0]!.resumeSessionId).toBeUndefined();
  });

  test("ignores garbage resumeSessionId values (must be a non-empty string)", () => {
    const m = new MemStore();
    m.setItem(
      KEY,
      JSON.stringify({
        "/wt": [
          {
            agent: "claude",
            source: "__new__:claude:t_a",
            resumeSessionId: "",
          },
          {
            agent: "claude",
            source: "__new__:claude:t_b",
            resumeSessionId: 42,
          },
          {
            agent: "claude",
            source: "__new__:claude:t_c",
            resumeSessionId: "valid",
          },
        ],
      }),
    );
    expect(new OpenSessionsStore(m, KEY).load()).toEqual({
      "/wt": [
        { agent: "claude", source: "__new__:claude:t_a" },
        { agent: "claude", source: "__new__:claude:t_b" },
        {
          agent: "claude",
          source: "__new__:claude:t_c",
          resumeSessionId: "valid",
        },
      ],
    });
  });
});

describe("reload-resume round-trip (stamp → persist → load → cmd)", () => {
  // Integration-shaped: walks the full lifecycle the App.svelte handler
  // will drive. Locks in the actual user-visible behaviour: after a
  // fake hard-reload, the cmd for the column resumes the conversation
  // instead of starting fresh.
  test("activity → stamp → save → load → cmdForOpenSession resumes", () => {
    const m = new MemStore();
    const KEY = "supergit:openSessions-reload";
    const store = new OpenSessionsStore(m, KEY);

    // 1. User opens a brand-new claude TUI. Inline `agent: "claude"`
    //    source is the synthetic `__new__:` (mirrors openNewAgentSession
    //    in App.svelte).
    let byWt: Record<string, PersistedSession[]> = {
      "/Users/me/wt/feature": [
        { agent: "claude", source: "__new__:claude:t_xyz" },
      ],
    };
    store.save(byWt);

    // 2. Activity tail emits the first JSONL line — that's our cue that
    //    claude has minted a session id for this column.
    byWt = stampDiscoveredSessionId(byWt, {
      agent: "claude",
      cwd: "/Users/me/wt/feature",
      sessionId: "claude-sid-abcdef",
    });
    store.save(byWt);

    // 3. Hard reload: new browser tab, fresh OpenSessionsStore instance
    //    reads from the same localStorage.
    const reloaded = new OpenSessionsStore(m, KEY).load();
    const restoredCol = reloaded["/Users/me/wt/feature"]![0]!;
    expect(restoredCol.resumeSessionId).toBe("claude-sid-abcdef");

    // 4. The cmd handed to TerminalView on remount resumes the conversation.
    expect(cmdForOpenSession(restoredCol, "/bin/zsh")).toEqual([
      "claude",
      "--resume",
      "claude-sid-abcdef",
      "--allow-dangerously-skip-permissions",
    ]);
  });

  test("without the stamp step (reload before any activity), cmd falls back to bare `claude`", () => {
    // Locks in the no-regression: if the activity tail never got a
    // chance to fire (very fast reload), we still spawn bare claude
    // and the user sees the same behaviour as today — not worse.
    const m = new MemStore();
    const KEY = "supergit:openSessions-reload-fast";
    new OpenSessionsStore(m, KEY).save({
      "/Users/me/wt/feature": [
        { agent: "claude", source: "__new__:claude:t_xyz" },
      ],
    });
    const reloaded = new OpenSessionsStore(m, KEY).load();
    expect(
      cmdForOpenSession(reloaded["/Users/me/wt/feature"]![0]!, "/bin/zsh"),
    ).toEqual(["claude"]);
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
