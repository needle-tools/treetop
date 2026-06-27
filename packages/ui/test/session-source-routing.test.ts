/**
 * CHARACTERIZATION TESTS — session source routing logic from App.svelte
 *
 * Extraction landed (step 2): the real implementations live in
 * packages/ui/src/session-source-routing.ts. These tests now exercise
 * the real module directly — the shims have been replaced with imports.
 *
 * If all assertions pass, the extraction is proven behaviour-preserving.
 *
 * Shims were written against App.svelte as of commit 500dc78 (ui: extract
 * toast system from App.svelte into testable toast-manager.ts).
 */

import { test, expect, describe } from "bun:test";
import {
  resolveTermId,
  isOpenInWt,
  normalizeSessionForOpen,
  shellToSession,
  shellSourceToDismiss,
  moveSessionStateKey,
  canResumeVisualSurface,
  openSessionHasDockActivity,
  openSessionHasLiveTerminal,
  reconcileLiveAgentTerminals,
  selectSessionsForBackgroundSpawn,
  shouldHoldOffscreenAttachedTerminal,
  shouldMountNewSessionTerminal,
  shouldMountTerminalView,
  type AgentSession,
  type ShellRecord,
  type OpenSession,
  type Repo,
} from "../src/session-source-routing";

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// resolveTermId
// ---------------------------------------------------------------------------

describe("resolveTermId", () => {
  test("__attached__:shell:<termId> → returns termId from suffix", () => {
    expect(resolveTermId({ source: "__attached__:shell:abc123" }, {})).toBe(
      "abc123",
    );
  });

  test("__attached__:claude:<termId> → returns termId (any agent suffix)", () => {
    expect(resolveTermId({ source: "__attached__:claude:xyz789" }, {})).toBe(
      "xyz789",
    );
  });

  test("__new__:<key> in newTermIds → returns the mapped termId", () => {
    const newTermIds = { "__new__:shell:1": "term-42" };
    expect(resolveTermId({ source: "__new__:shell:1" }, newTermIds)).toBe(
      "term-42",
    );
  });

  test("__new__:<key> NOT in newTermIds → returns undefined", () => {
    expect(
      resolveTermId({ source: "__new__:shell:missing" }, {}),
    ).toBeUndefined();
  });

  test("real JSONL path source → returns undefined (no termId to extract)", () => {
    expect(
      resolveTermId({ source: "/workspace/.claude/sessions/abc.jsonl" }, {}),
    ).toBeUndefined();
  });

  test("__transcript__:shell:termId → returns undefined (not an attached/new source)", () => {
    expect(
      resolveTermId({ source: "__transcript__:shell:tid99" }, {}),
    ).toBeUndefined();
  });

  test("__new__: prefix but empty newTermIds map → undefined", () => {
    expect(resolveTermId({ source: "__new__:claude:" }, {})).toBeUndefined();
  });

  // Edge: .split(":").pop() on a source with many colons returns last segment
  test("__attached__: with colons in the termId-like segment → last split wins", () => {
    // This matches the real code: s.source.split(":").pop()
    // So "__attached__:shell:foo:bar" would give "bar"
    expect(resolveTermId({ source: "__attached__:shell:foo:bar" }, {})).toBe(
      "bar",
    );
  });
});

// ---------------------------------------------------------------------------
// isOpenInWt
// ---------------------------------------------------------------------------

describe("isOpenInWt", () => {
  const sessions: OpenSession[] = [
    { agent: "claude", source: "/ws/.claude/sessions/abc.jsonl" },
    { agent: "shell", source: "__attached__:shell:term1" },
    { agent: "ollama", source: "__transcript__:ollama:olm1" },
  ];
  const openSessionsByWt: Record<string, OpenSession[]> = {
    "/home/user/project": sessions,
    "/home/user/project2": [],
  };

  test("source present in the worktree → true", () => {
    expect(
      isOpenInWt(
        "/home/user/project",
        "/ws/.claude/sessions/abc.jsonl",
        openSessionsByWt,
      ),
    ).toBe(true);
  });

  test("shell source present → true", () => {
    expect(
      isOpenInWt(
        "/home/user/project",
        "__attached__:shell:term1",
        openSessionsByWt,
      ),
    ).toBe(true);
  });

  test("ollama transcript source present → true", () => {
    expect(
      isOpenInWt(
        "/home/user/project",
        "__transcript__:ollama:olm1",
        openSessionsByWt,
      ),
    ).toBe(true);
  });

  test("source not in the worktree → false", () => {
    expect(
      isOpenInWt(
        "/home/user/project",
        "__attached__:shell:term999",
        openSessionsByWt,
      ),
    ).toBe(false);
  });

  test("correct source but wrong worktree path → false", () => {
    expect(
      isOpenInWt(
        "/home/user/project2",
        "/ws/.claude/sessions/abc.jsonl",
        openSessionsByWt,
      ),
    ).toBe(false);
  });

  test("worktree path absent from map → false (treated as empty list)", () => {
    expect(
      isOpenInWt(
        "/nonexistent/wt",
        "__attached__:shell:term1",
        openSessionsByWt,
      ),
    ).toBe(false);
  });

  test("empty session list for worktree → false", () => {
    expect(
      isOpenInWt(
        "/home/user/project2",
        "/ws/.claude/sessions/abc.jsonl",
        openSessionsByWt,
      ),
    ).toBe(false);
  });
});

describe("moveSessionStateKey", () => {
  test("moves a transient state value from synthetic source to canonical source", () => {
    const before = { "__new__:claude:abc": true, other: false };
    expect(
      moveSessionStateKey(before, "__new__:claude:abc", "/real.jsonl"),
    ).toEqual({
      "/real.jsonl": true,
      other: false,
    });
  });

  test("deletes the old key without clobbering an existing canonical value", () => {
    const before = {
      "__new__:claude:abc": true,
      "/real.jsonl": false,
    };
    expect(
      moveSessionStateKey(before, "__new__:claude:abc", "/real.jsonl"),
    ).toEqual({
      "/real.jsonl": false,
    });
  });

  test("returns the same object when there is no old key to move", () => {
    const before = { "/real.jsonl": true };
    expect(
      moveSessionStateKey(before, "__new__:claude:abc", "/real.jsonl"),
    ).toBe(before);
  });

  test("no-ops when source and destination are identical", () => {
    const before = { "/real.jsonl": true };
    expect(moveSessionStateKey(before, "/real.jsonl", "/real.jsonl")).toBe(
      before,
    );
  });
});

describe("reconcileLiveAgentTerminals", () => {
  const wtPath = "/repo/fastvid";
  const source = "/Users/me/.codex/sessions/rollout-019e975e.jsonl";
  const repos: Repo[] = [
    {
      worktrees: [
        {
          path: wtPath,
          agents: [
            {
              agent: "codex",
              cwd: wtPath,
              lastActive: "2026-06-17T09:59:15.736Z",
              sessionId: "019e975e-33cc-7773-98fc-dc3d13033869",
              source,
              manualTitle: "Correctness of outputs",
            },
          ],
        },
      ],
    },
  ];

  test("attaches an open JSONL session to its live terminal by session owner", () => {
    const before: Record<string, OpenSession[]> = {
      [wtPath]: [{ agent: "codex", source }],
    };
    const after = reconcileLiveAgentTerminals(before, repos, [
      {
        id: "t_live_fastvid",
        ownerId: "019e975e-33cc-7773-98fc-dc3d13033869",
        cwd: wtPath,
        agent: "codex",
      },
    ]);

    expect(after[wtPath]?.[0]).toMatchObject({
      agent: "codex",
      source,
      mode: "terminal",
      attachTermId: "t_live_fastvid",
    });
  });

  test("replaces a stale attachTermId with the currently live terminal", () => {
    const before: Record<string, OpenSession[]> = {
      [wtPath]: [
        {
          agent: "codex",
          source,
          mode: "terminal",
          attachTermId: "t_old_dead",
        },
      ],
    };
    const after = reconcileLiveAgentTerminals(before, repos, [
      {
        id: "t_live_fastvid",
        ownerId: "019e975e-33cc-7773-98fc-dc3d13033869",
        cwd: wtPath,
        agent: "codex",
      },
    ]);

    expect(after[wtPath]?.[0]?.attachTermId).toBe("t_live_fastvid");
  });

  test("does not attach a terminal from another worktree", () => {
    const before: Record<string, OpenSession[]> = {
      [wtPath]: [{ agent: "codex", source }],
    };

    expect(
      reconcileLiveAgentTerminals(before, repos, [
        {
          id: "t_other",
          ownerId: "019e975e-33cc-7773-98fc-dc3d13033869",
          cwd: "/repo/other",
          agent: "codex",
        },
      ]),
    ).toBe(before);
  });

  test("ignores shell terminals", () => {
    const before: Record<string, OpenSession[]> = {
      [wtPath]: [{ agent: "codex", source }],
    };

    expect(
      reconcileLiveAgentTerminals(before, repos, [
        {
          id: "t_shell",
          ownerId: "019e975e-33cc-7773-98fc-dc3d13033869",
          cwd: wtPath,
          agent: "shell",
        },
      ]),
    ).toBe(before);
  });
});

describe("selectSessionsForBackgroundSpawn", () => {
  const wtPath = "/repo/needle-cloud";
  const otherWt = "/repo/fastvid";
  const restorable = (
    source: string,
    extra: Partial<OpenSession> = {},
  ): OpenSession => ({
    agent: "claude",
    source,
    mode: "terminal",
    resumeSessionId: source,
    ...extra,
  });

  test("picks a terminal-mode session with a resumeSessionId and no live PTY", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-a")],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(),
        newTermIds: {},
      }),
    ).toEqual([
      {
        wtPath,
        source: "sid-a",
        agent: "claude",
        resumeSessionId: "sid-a",
      },
    ]);
  });

  test("forwards claude model/effort overrides", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [
        restorable("sid-a", { claudeModel: "opus", claudeEffort: "high" }),
      ],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(),
        newTermIds: {},
      })[0],
    ).toMatchObject({ claudeModel: "opus", claudeEffort: "high" });
  });

  test("resumes codex sessions too", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-cx", { agent: "codex" })],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(),
        newTermIds: {},
      })[0]?.agent,
    ).toBe("codex");
  });

  test("skips sessions already attached to a live PTY", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-a", { attachTermId: "t_live" })],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(["t_live"]),
        inFlight: new Set(),
        newTermIds: {},
      }),
    ).toEqual([]);
  });

  test("re-spawns a session whose persisted attachTermId is dead", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-a", { attachTermId: "t_dead" })],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(["t_other"]),
        inFlight: new Set(),
        newTermIds: {},
      }),
    ).toHaveLength(1);
  });

  test("skips a source whose column already spawned its own PTY", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-a")],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(),
        newTermIds: { "sid-a": "t_col_spawned" },
      }),
    ).toEqual([]);
  });

  test("skips sources already in flight (no double spawn)", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-a")],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(["sid-a"]),
        newTermIds: {},
      }),
    ).toEqual([]);
  });

  test("ignores read-mode sessions, shells, and sessions without a resume id", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [
        { agent: "claude", source: "read-a", resumeSessionId: "read-a" }, // no mode
        restorable("noresume", { resumeSessionId: undefined }),
        { agent: "shell", source: "shell-a", mode: "terminal" },
        { agent: "files", source: "files-a", mode: "terminal" },
      ],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(),
        newTermIds: {},
      }),
    ).toEqual([]);
  });

  test("collects restorable sessions across worktrees in iteration order", () => {
    const byWt: Record<string, OpenSession[]> = {
      [wtPath]: [restorable("sid-a"), restorable("sid-b")],
      [otherWt]: [restorable("sid-c")],
    };
    expect(
      selectSessionsForBackgroundSpawn(byWt, {
        liveTerminalIds: new Set(),
        inFlight: new Set(),
        newTermIds: {},
      }).map((c) => c.source),
    ).toEqual(["sid-a", "sid-b", "sid-c"]);
  });
});

describe("openSessionHasLiveTerminal", () => {
  test("real JSONL terminal mode is not live without a live attachTermId", () => {
    expect(
      openSessionHasLiveTerminal(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          mode: "terminal",
          attachTermId: "t_dead",
        },
        { liveTerminalIds: new Set(["t_other"]), newTermIds: {} },
      ),
    ).toBe(false);
  });

  test("real JSONL terminal mode is live when its attached PTY is live", () => {
    expect(
      openSessionHasLiveTerminal(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          mode: "terminal",
          attachTermId: "t_live",
        },
        { liveTerminalIds: new Set(["t_live"]), newTermIds: {} },
      ),
    ).toBe(true);
  });

  test("read-mode JSONL is not a live terminal even if a stale attach id remains", () => {
    expect(
      openSessionHasLiveTerminal(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          attachTermId: "t_live",
        },
        { liveTerminalIds: new Set(["t_live"]), newTermIds: {} },
      ),
    ).toBe(false);
  });

  test("attached synthetic sessions require the referenced PTY to be live", () => {
    expect(
      openSessionHasLiveTerminal(
        { agent: "shell", source: "__attached__:shell:t_live" },
        { liveTerminalIds: new Set(["t_live"]), newTermIds: {} },
      ),
    ).toBe(true);
    expect(
      openSessionHasLiveTerminal(
        { agent: "shell", source: "__attached__:shell:t_dead" },
        { liveTerminalIds: new Set(["t_live"]), newTermIds: {} },
      ),
    ).toBe(false);
  });

  test("__new__ sessions count as starting until a term id is known", () => {
    expect(
      openSessionHasLiveTerminal(
        { agent: "codex", source: "__new__:codex:abc" },
        { liveTerminalIds: new Set(), newTermIds: {} },
      ),
    ).toBe(true);
  });

  test("__new__ sessions with a known term id follow the live terminal set", () => {
    expect(
      openSessionHasLiveTerminal(
        { agent: "codex", source: "__new__:codex:abc" },
        {
          liveTerminalIds: new Set(["t_live"]),
          newTermIds: { "__new__:codex:abc": "t_live" },
        },
      ),
    ).toBe(true);
    expect(
      openSessionHasLiveTerminal(
        { agent: "codex", source: "__new__:codex:abc" },
        {
          liveTerminalIds: new Set(["t_other"]),
          newTermIds: { "__new__:codex:abc": "t_dead" },
        },
      ),
    ).toBe(false);
  });

  test("transient exited state wins over otherwise-live terminal evidence", () => {
    expect(
      openSessionHasLiveTerminal(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
          mode: "terminal",
          attachTermId: "t_live",
        },
        {
          liveTerminalIds: new Set(["t_live"]),
          newTermIds: {},
          transientExited: { "/agents/codex.jsonl": true },
        },
      ),
    ).toBe(false);
  });
});

describe("openSessionHasDockActivity", () => {
  test("keeps an idle live Codex app-server pane active without pretending it is working", () => {
    expect(
      openSessionHasDockActivity(
        {
          agent: "codex",
          source: "__codex_app__:019ed710",
        },
        {
          liveTerminalIds: new Set(),
          newTermIds: {},
        },
      ),
    ).toBe(true);
  });

  test("keeps a working visual app-server session active without a live PTY", () => {
    expect(
      openSessionHasDockActivity(
        {
          agent: "codex",
          source: "__codex_app__:019ed710",
        },
        {
          liveTerminalIds: new Set(),
          newTermIds: {},
          transientWorking: { "__codex_app__:019ed710": true },
        },
      ),
    ).toBe(true);
  });

  test("keeps an awaiting visual app-server session active without a live PTY", () => {
    expect(
      openSessionHasDockActivity(
        {
          agent: "codex",
          source: "__codex_app__:019ed710",
        },
        {
          liveTerminalIds: new Set(),
          newTermIds: {},
          transientAwaiting: { "__codex_app__:019ed710": true },
        },
      ),
    ).toBe(true);
  });

  test("idle read-mode history remains inactive without visual activity", () => {
    expect(
      openSessionHasDockActivity(
        {
          agent: "codex",
          source: "/agents/codex.jsonl",
        },
        {
          liveTerminalIds: new Set(),
          newTermIds: {},
        },
      ),
    ).toBe(false);
  });

  test("transient exited state wins over visual activity", () => {
    expect(
      openSessionHasDockActivity(
        {
          agent: "codex",
          source: "__codex_app__:019ed710",
        },
        {
          liveTerminalIds: new Set(),
          newTermIds: {},
          transientWorking: { "__codex_app__:019ed710": true },
          transientExited: { "__codex_app__:019ed710": true },
        },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeSessionForOpen
// ---------------------------------------------------------------------------

describe("normalizeSessionForOpen", () => {
  const wtPath = "/home/user/project";

  // Repos fixture: one worktree with one ollama agent whose sessionId
  // matches the JSONL basename and whose model is known.
  const repos: Repo[] = [
    {
      worktrees: [
        {
          path: wtPath,
          agents: [
            {
              agent: "ollama",
              cwd: wtPath,
              lastActive: "2024-01-01T00:00:00Z",
              source: "/workspace/ollama/tid-abc.jsonl",
              sessionId: "tid-abc",
              model: "llama3.2:3b",
              title: "Llama 3.2",
            } as AgentSession,
          ],
        },
      ],
    },
  ];

  // ---- Pass-through cases ----

  test("non-ollama agent with no matching session id → returned unchanged", () => {
    const s: OpenSession = {
      agent: "claude",
      source: "/ws/.claude/sessions/x.jsonl",
    };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  test("claude JSONL source → stamps resumeSessionId from the worktree session index", () => {
    const localRepos: Repo[] = [
      {
        worktrees: [
          {
            path: wtPath,
            agents: [
              {
                agent: "claude",
                cwd: wtPath,
                lastActive: "2026-06-17T10:00:00Z",
                source: "/ws/.claude/sessions/x.jsonl",
                sessionId: "claude-sid-123",
              } as AgentSession,
            ],
          },
        ],
      },
    ];
    const s: OpenSession = {
      agent: "claude",
      source: "/ws/.claude/sessions/x.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, localRepos);
    expect(result).toEqual({
      agent: "claude",
      source: "/ws/.claude/sessions/x.jsonl",
      resumeSessionId: "claude-sid-123",
    });
  });

  test("codex JSONL source keeps an existing resumeSessionId", () => {
    const localRepos: Repo[] = [
      {
        worktrees: [
          {
            path: wtPath,
            agents: [
              {
                agent: "codex",
                cwd: wtPath,
                lastActive: "2026-06-17T10:00:00Z",
                source: "/ws/.codex/sessions/x.jsonl",
                sessionId: "newer-codex-sid",
              } as AgentSession,
            ],
          },
        ],
      },
    ];
    const s: OpenSession = {
      agent: "codex",
      source: "/ws/.codex/sessions/x.jsonl",
      resumeSessionId: "persisted-codex-sid",
    };
    expect(normalizeSessionForOpen(wtPath, s, localRepos)).toBe(s);
  });

  test("ollama but source starts with __transcript__: → returned unchanged", () => {
    const s: OpenSession = {
      agent: "ollama",
      source: "__transcript__:ollama:tid-abc",
    };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  test("ollama but source starts with __new__: → returned unchanged", () => {
    const s: OpenSession = { agent: "ollama", source: "__new__:ollama:1" };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  test("ollama but source starts with __attached__: → returned unchanged", () => {
    const s: OpenSession = {
      agent: "ollama",
      source: "__attached__:ollama:tid-abc",
    };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  // ---- Translation cases ----

  test("ollama JSONL source → translates to __transcript__:ollama:<termId>", () => {
    const s: OpenSession = {
      agent: "ollama",
      source: "/workspace/ollama/tid-abc.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-abc");
    expect(result.agent).toBe("ollama");
  });

  test("ollama JSONL with matching agent → ollamaModel is populated from model field", () => {
    const s: OpenSession = {
      agent: "ollama",
      source: "/workspace/ollama/tid-abc.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.ollamaModel).toBe("llama3.2:3b");
  });

  test("ollama JSONL with no matching agent in agents list → ollamaModel is undefined", () => {
    const s: OpenSession = {
      agent: "ollama",
      source: "/workspace/ollama/tid-unknown.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-unknown");
    expect(result.ollamaModel).toBeUndefined();
  });

  test("ollama JSONL matched by source (not sessionId) → still translates correctly", () => {
    // Agent whose sessionId doesn't match but whose source does
    const localRepos: Repo[] = [
      {
        worktrees: [
          {
            path: wtPath,
            agents: [
              {
                agent: "ollama",
                cwd: wtPath,
                lastActive: "2024-01-01T00:00:00Z",
                source: "/workspace/ollama/tid-src.jsonl",
                sessionId: "something-else",
                model: "qwen3:8b",
              } as AgentSession,
            ],
          },
        ],
      },
    ];
    const s: OpenSession = {
      agent: "ollama",
      source: "/workspace/ollama/tid-src.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, localRepos);
    // termId derived from basename: tid-src
    expect(result.source).toBe("__transcript__:ollama:tid-src");
    expect(result.ollamaModel).toBe("qwen3:8b");
  });

  test("ollama JSONL with agent having no model → falls back to title", () => {
    const localRepos: Repo[] = [
      {
        worktrees: [
          {
            path: wtPath,
            agents: [
              {
                agent: "ollama",
                cwd: wtPath,
                lastActive: "2024-01-01T00:00:00Z",
                source: "/workspace/ollama/tid-xyz.jsonl",
                sessionId: "tid-xyz",
                // no model field
                title: "My Ollama Chat",
              } as AgentSession,
            ],
          },
        ],
      },
    ];
    const s: OpenSession = {
      agent: "ollama",
      source: "/workspace/ollama/tid-xyz.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, localRepos);
    expect(result.ollamaModel).toBe("My Ollama Chat");
  });

  test("empty source basename (edge case) → returned unchanged", () => {
    // source that splits to empty string — the real code returns s early
    const s: OpenSession = { agent: "ollama", source: "" };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    // base.endsWith(".jsonl") is false → termId = "" → early return
    expect(result).toBe(s);
  });

  test("worktree not found in repos → still translates source, ollamaModel undefined", () => {
    const s: OpenSession = {
      agent: "ollama",
      source: "/workspace/ollama/tid-abc.jsonl",
    };
    // wrong worktree path
    const result = normalizeSessionForOpen("/nonexistent/wt", s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-abc");
    expect(result.ollamaModel).toBeUndefined();
  });

  test("Windows-style path separator (backslash) → basename extracted correctly", () => {
    // The real regex is /[\\/]/ so it handles both separators
    const s: OpenSession = {
      agent: "ollama",
      source: "C:\\workspace\\ollama\\tid-win.jsonl",
    };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-win");
  });
});

// ---------------------------------------------------------------------------
// shellSourceToDismiss — decision logic only
//
// The SIDE EFFECT (calling dismissShellSource which writes to daemon KV) is
// NOT tested here — it stays in App.svelte's thin `dismissIfShell` wrapper.
// The pure decision (`shellSourceToDismiss`) lives in session-source-routing.ts
// and is tested below. Non-shell sources don't match any shell prefix → null.
// ---------------------------------------------------------------------------

describe("dismissIfShell — decision logic", () => {
  test("non-shell agent → null (nothing to dismiss)", () => {
    // source "/ws/x.jsonl" doesn't match any shell prefix → null
    expect(shellSourceToDismiss("/ws/x.jsonl", {})).toBeNull();
  });

  test("files agent → null (not a shell)", () => {
    // source "__files__:/some/path" doesn't match any shell prefix → null
    expect(shellSourceToDismiss("__files__:/some/path", {})).toBeNull();
  });

  test("shell + __attached__:shell:<id> → returns the source itself", () => {
    expect(shellSourceToDismiss("__attached__:shell:term1", {})).toBe(
      "__attached__:shell:term1",
    );
  });

  test("shell + __transcript__:shell:<id> → returns the source itself", () => {
    expect(shellSourceToDismiss("__transcript__:shell:term99", {})).toBe(
      "__transcript__:shell:term99",
    );
  });

  test("shell + __new__:shell: with termId in map → returns __attached__:shell:<termId>", () => {
    const newTermIds = { "__new__:shell:1": "term-mapped" };
    expect(shellSourceToDismiss("__new__:shell:1", newTermIds)).toBe(
      "__attached__:shell:term-mapped",
    );
  });

  test("shell + __new__:shell: NOT in map → null (no termId known, nothing to dismiss)", () => {
    expect(shellSourceToDismiss("__new__:shell:missing", {})).toBeNull();
  });

  test("shell + unknown source form → null (real code falls through without action)", () => {
    // A shell source that doesn't start with __attached__:, __transcript__:, or __new__:
    // The real function does nothing in that case → decision is null.
    expect(shellSourceToDismiss("/some/bare/path", {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shellToSession
// ---------------------------------------------------------------------------

describe("shellToSession", () => {
  const baseShell: ShellRecord = {
    termId: "tid-shell-1",
    wt: "/home/user/project",
    spawnCwd: "/home/user/project",
    createdAt: "2024-01-01T10:00:00Z",
    alive: true,
  };

  test("alive shell → source is __attached__:shell:<termId>", () => {
    const result = shellToSession(baseShell);
    expect(result.source).toBe("__attached__:shell:tid-shell-1");
  });

  test("dead shell → source is __transcript__:shell:<termId>", () => {
    const result = shellToSession({ ...baseShell, alive: false });
    expect(result.source).toBe("__transcript__:shell:tid-shell-1");
  });

  test("agent is always 'shell'", () => {
    expect(shellToSession(baseShell).agent).toBe("shell");
  });

  test("cwd maps from sh.wt", () => {
    expect(shellToSession(baseShell).cwd).toBe("/home/user/project");
  });

  test("sessionId maps from sh.termId", () => {
    expect(shellToSession(baseShell).sessionId).toBe("tid-shell-1");
  });

  test("lastActive prefers sh.lastCmdTs over sh.createdAt", () => {
    const sh = { ...baseShell, lastCmdTs: "2024-06-01T12:00:00Z" };
    expect(shellToSession(sh).lastActive).toBe("2024-06-01T12:00:00Z");
  });

  test("lastActive falls back to sh.createdAt when lastCmdTs absent", () => {
    const sh = { ...baseShell, lastCmdTs: undefined };
    expect(shellToSession(sh).lastActive).toBe("2024-01-01T10:00:00Z");
  });

  test("title prefers sh.currentCwd over sh.spawnCwd", () => {
    const sh = { ...baseShell, currentCwd: "/home/user/project/subdir" };
    expect(shellToSession(sh).title).toBe("/home/user/project/subdir");
  });

  test("title falls back to sh.spawnCwd when currentCwd absent", () => {
    const sh = { ...baseShell, currentCwd: undefined };
    expect(shellToSession(sh).title).toBe("/home/user/project");
  });

  test("lastUserMessage maps from sh.lastCmd", () => {
    const sh = { ...baseShell, lastCmd: "bun test" };
    expect(shellToSession(sh).lastUserMessage).toBe("bun test");
  });

  test("lastUserMessage is undefined when sh.lastCmd absent", () => {
    const sh = { ...baseShell, lastCmd: undefined };
    expect(shellToSession(sh).lastUserMessage).toBeUndefined();
  });

  test("messageCount maps from sh.cmdCount", () => {
    const sh = { ...baseShell, cmdCount: 7 };
    expect(shellToSession(sh).messageCount).toBe(7);
  });

  test("messageCount is undefined when sh.cmdCount absent", () => {
    const sh = { ...baseShell, cmdCount: undefined };
    expect(shellToSession(sh).messageCount).toBeUndefined();
  });

  test("manualTitle maps from sh.manualTitle", () => {
    const sh = { ...baseShell, manualTitle: "My custom shell" };
    expect(shellToSession(sh).manualTitle).toBe("My custom shell");
  });

  test("manualTitle is undefined when sh.manualTitle absent", () => {
    expect(shellToSession(baseShell).manualTitle).toBeUndefined();
  });

  test("full dead shell with all optional fields populated", () => {
    const sh: ShellRecord = {
      termId: "t99",
      wt: "/repo/wt",
      spawnCwd: "/repo/wt",
      currentCwd: "/repo/wt/src",
      createdAt: "2024-01-01T00:00:00Z",
      alive: false,
      cmdCount: 3,
      lastCmd: "git status",
      lastCmdTs: "2024-01-02T08:00:00Z",
      manualTitle: "git wt",
    };
    const result = shellToSession(sh);
    expect(result).toEqual({
      agent: "shell",
      cwd: "/repo/wt",
      lastActive: "2024-01-02T08:00:00Z",
      source: "__transcript__:shell:t99",
      title: "/repo/wt/src",
      sessionId: "t99",
      lastUserMessage: "git status",
      messageCount: 3,
      manualTitle: "git wt",
    });
  });
});

describe("canResumeVisualSurface", () => {
  test("offers Resume for a stopped Codex transcript that can become visual", () => {
    expect(
      canResumeVisualSurface({
        agent: "codex",
        liveAppSurface: false,
        sessionId: "thread-1",
        hasVisualResume: true,
      }),
    ).toBe(true);
  });

  test("does not show Resume inside an already live-wired visual Codex pane", () => {
    expect(
      canResumeVisualSurface({
        agent: "codex",
        liveAppSurface: true,
        sessionId: "thread-1",
        hasVisualResume: true,
      }),
    ).toBe(false);
  });

  test("requires a resumable Codex session id and visual resume handler", () => {
    expect(
      canResumeVisualSurface({
        agent: "codex",
        liveAppSurface: false,
        sessionId: undefined,
        hasVisualResume: true,
      }),
    ).toBe(false);
    expect(
      canResumeVisualSurface({
        agent: "codex",
        liveAppSurface: false,
        sessionId: "thread-1",
        hasVisualResume: false,
      }),
    ).toBe(false);
    expect(
      canResumeVisualSurface({
        agent: "claude",
        liveAppSurface: false,
        sessionId: "thread-1",
        hasVisualResume: true,
      }),
    ).toBe(false);
  });
});

describe("shouldMountTerminalView", () => {
  test("mounts live terminal UI only for complete terminal columns near the viewport", () => {
    expect(
      shouldMountTerminalView({
        mode: "terminal",
        hasSessionId: true,
        hasCwd: true,
        nearViewport: true,
      }),
    ).toBe(true);
  });

  test("defers offscreen terminal UI without changing terminal mode", () => {
    expect(
      shouldMountTerminalView({
        mode: "terminal",
        hasSessionId: true,
        hasCwd: true,
        nearViewport: false,
      }),
    ).toBe(false);
  });

  test("does not mount without a resumable session and cwd", () => {
    expect(
      shouldMountTerminalView({
        mode: "terminal",
        hasSessionId: false,
        hasCwd: true,
        nearViewport: true,
      }),
    ).toBe(false);
    expect(
      shouldMountTerminalView({
        mode: "terminal",
        hasSessionId: true,
        hasCwd: false,
        nearViewport: true,
      }),
    ).toBe(false);
  });
});

describe("shouldMountNewSessionTerminal", () => {
  test("mounts transient terminal UI only near the viewport", () => {
    expect(
      shouldMountNewSessionTerminal({ hasCwd: true, nearViewport: true }),
    ).toBe(true);
    expect(
      shouldMountNewSessionTerminal({ hasCwd: true, nearViewport: false }),
    ).toBe(false);
  });

  test("requires a cwd to spawn or attach", () => {
    expect(
      shouldMountNewSessionTerminal({ hasCwd: false, nearViewport: true }),
    ).toBe(false);
  });
});

describe("shouldHoldOffscreenAttachedTerminal", () => {
  test("holds an attached PTY when its terminal renderer is deferred", () => {
    expect(
      shouldHoldOffscreenAttachedTerminal({
        attachTermId: "term-1",
        terminalMounted: false,
      }),
    ).toBe(true);
  });

  test("does not hold once the terminal renderer is mounted", () => {
    expect(
      shouldHoldOffscreenAttachedTerminal({
        attachTermId: "term-1",
        terminalMounted: true,
      }),
    ).toBe(false);
  });

  test("does not hold unspawned synthetic columns", () => {
    expect(
      shouldHoldOffscreenAttachedTerminal({
        attachTermId: undefined,
        terminalMounted: false,
      }),
    ).toBe(false);
  });
});
