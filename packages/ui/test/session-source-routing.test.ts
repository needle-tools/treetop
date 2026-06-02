/**
 * CHARACTERIZATION TESTS — session source routing logic from App.svelte
 *
 * These tests pin the CURRENT behaviour of five routing functions that live
 * inside the <script> of App.svelte.  They are faithful local shims — the
 * logic is copied VERBATIM from App.svelte, with closed-over reactive state
 * turned into explicit parameters where needed.
 *
 * Step 2 (extraction) will:
 *   1. Move the real implementations to packages/ui/src/session-source-routing.ts
 *   2. Replace the shims in this file with real imports
 *
 * If behaviour matches after that swap, the extraction is proven safe.
 *
 * Shims match App.svelte as of commit 500dc78 (ui: extract toast system from
 * App.svelte into testable toast-manager.ts).
 */

import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// Inline type mirrors (matching App.svelte's local interfaces)
// ---------------------------------------------------------------------------

interface AgentSession {
  agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
  cwd: string;
  lastActive: string;
  sessionId?: string;
  source: string;
  title?: string;
  lastUserMessage?: string;
  manualTitle?: string;
  firstUserMessage?: string;
  lastUserMessages?: string[];
  userMessageCount?: number;
  messageCount?: number;
  recentMessageCount?: number;
  lastMessageTs?: string;
  contextTokens?: number;
  contextTokensExact?: boolean;
  contextWindow?: number;
  model?: string;
}

interface ShellRecord {
  termId: string;
  wt: string;
  spawnCwd: string;
  currentCwd?: string;
  createdAt: string;
  alive: boolean;
  cmdCount?: number;
  lastCmd?: string;
  lastCmdTs?: string;
  manualTitle?: string;
}

interface OpenSession {
  agent: AgentSession["agent"] | "shell" | "files" | "history";
  source: string;
  resumeSessionId?: string;
  preassignedSessionId?: string;
  mode?: "terminal";
  ollamaModel?: string;
  contextFilePath?: string;
  attachTermId?: string;
}

interface Worktree {
  path: string;
  agents?: AgentSession[];
  // other fields omitted — only what the routing functions inspect
}

interface Repo {
  worktrees?: Worktree[];
  // other fields omitted
}

// ---------------------------------------------------------------------------
// Shim 1 — resolveTermId
//
// Pure transform. Extracts the daemon termId from synthetic source strings.
// Closed-over state: `newTermIds` (Record<string, string>). Made explicit.
// ---------------------------------------------------------------------------

/**
 * Resolve the daemon termId for a `__new__:` or `__attached__:` column.
 * `__attached__:` sources carry it directly in the suffix;
 * `__new__:` sources are looked up in `newTermIds`.
 *
 * Faithful copy of App.svelte `resolveTermId` (line ~970).
 */
function resolveTermId(
  s: { source: string },
  newTermIds: Record<string, string>,
): string | undefined {
  if (s.source.startsWith("__attached__:")) return s.source.split(":").pop();
  if (s.source.startsWith("__new__:")) return newTermIds[s.source];
  return undefined;
}

// ---------------------------------------------------------------------------
// Shim 2 — isOpenInWt
//
// Pure predicate. Checks membership in the open-session list for a worktree.
// Closed-over state: `openSessionsByWt`. Made explicit.
// ---------------------------------------------------------------------------

/**
 * Returns true when `source` appears in the open-session list for `wtPath`.
 *
 * Faithful copy of App.svelte `isOpenInWt` (line ~2568).
 */
function isOpenInWt(
  wtPath: string,
  source: string,
  openSessionsByWt: Record<string, OpenSession[]>,
): boolean {
  return (openSessionsByWt[wtPath] ?? []).some((s) => s.source === source);
}

// ---------------------------------------------------------------------------
// Shim 3 — normalizeSessionForOpen
//
// Pure transform. Translates Ollama raw-JSONL sources to the synthetic
// `__transcript__:ollama:<termId>` form that OllamaTranscriptView mounts on.
// Closed-over state: `repos`. Made explicit.
// ---------------------------------------------------------------------------

/**
 * Rewrite a picker-supplied OpenSession when needed.
 *
 * Faithful copy of App.svelte `normalizeSessionForOpen` (line ~2580).
 * `repos` replaces the closed-over reactive variable.
 */
function normalizeSessionForOpen(
  wtPath: string,
  s: OpenSession,
  repos: Repo[],
): OpenSession {
  if (
    s.agent !== "ollama" ||
    s.source.startsWith("__transcript__:") ||
    s.source.startsWith("__new__:") ||
    s.source.startsWith("__attached__:")
  ) {
    return s;
  }
  // Header path is `<workspace>/ollama/<termId>.jsonl`. The termId is
  // the basename without the extension.
  const base = s.source.split(/[\\/]/).pop() ?? "";
  const termId = base.endsWith(".jsonl")
    ? base.slice(0, -".jsonl".length)
    : base;
  if (!termId) return s;
  const wt = repos
    .flatMap((r) => r.worktrees ?? [])
    .find((w) => w.path === wtPath);
  const agents = wt?.agents ?? [];
  const match = agents.find(
    (a) =>
      a.agent === "ollama" &&
      (a.sessionId === termId || a.source === s.source),
  );
  return {
    agent: "ollama",
    source: `__transcript__:ollama:${termId}`,
    ollamaModel: match?.model ?? match?.title,
  };
}

// ---------------------------------------------------------------------------
// Shim 4 — dismissIfShell (DECISION LOGIC ONLY)
//
// Side-effecting in App.svelte: calls `dismissShellSource(source)` which
// updates a Set and persists to daemon KV. We cannot replicate that mutation
// here without a heavy harness.
//
// Strategy: extract and test only the *deterministic decision* embedded in
// the function — i.e. "given this OpenSession, WHICH source string (if any)
// should be dismissed?"
//
// The side-effect (calling dismissShellSource) is deferred to the extraction
// step, where the real module will expose a testable dismissedSources helper.
//
// Faithful copy of the DECISION PART of App.svelte `dismissIfShell` (line ~2647).
// ---------------------------------------------------------------------------

/**
 * Returns the source string that should be passed to `dismissShellSource`,
 * or null if this session should NOT be dismissed (non-shell, or unknown form).
 *
 * `newTermIds` replaces the closed-over reactive map used to look up
 * the attached form of `__new__:shell:` sources.
 */
function dismissIfShellDecision(
  s: OpenSession,
  newTermIds: Record<string, string>,
): string | null {
  if (s.agent !== "shell") return null;
  if (
    s.source.startsWith("__attached__:shell:") ||
    s.source.startsWith("__transcript__:shell:")
  ) {
    return s.source;
  } else if (s.source.startsWith("__new__:shell:")) {
    const termId = newTermIds[s.source];
    if (termId) return `__attached__:shell:${termId}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shim 5 — shellToSession
//
// Pure transform. Maps a ShellRecord to an AgentSession-shaped object for
// the picker. No closed-over state.
// ---------------------------------------------------------------------------

/**
 * Map shell records into the same shape as AgentSession.
 *
 * Faithful copy of App.svelte `shellToSession` (line ~5310).
 */
function shellToSession(sh: ShellRecord): AgentSession {
  return {
    agent: "shell",
    cwd: sh.wt,
    lastActive: sh.lastCmdTs ?? sh.createdAt,
    source: sh.alive
      ? `__attached__:shell:${sh.termId}`
      : `__transcript__:shell:${sh.termId}`,
    title: sh.currentCwd ?? sh.spawnCwd,
    sessionId: sh.termId,
    lastUserMessage: sh.lastCmd,
    messageCount: sh.cmdCount,
    manualTitle: sh.manualTitle,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// resolveTermId
// ---------------------------------------------------------------------------

describe("resolveTermId", () => {
  test("__attached__:shell:<termId> → returns termId from suffix", () => {
    expect(
      resolveTermId({ source: "__attached__:shell:abc123" }, {}),
    ).toBe("abc123");
  });

  test("__attached__:claude:<termId> → returns termId (any agent suffix)", () => {
    expect(
      resolveTermId({ source: "__attached__:claude:xyz789" }, {}),
    ).toBe("xyz789");
  });

  test("__new__:<key> in newTermIds → returns the mapped termId", () => {
    const newTermIds = { "__new__:shell:1": "term-42" };
    expect(
      resolveTermId({ source: "__new__:shell:1" }, newTermIds),
    ).toBe("term-42");
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
    expect(
      resolveTermId({ source: "__new__:claude:" }, {}),
    ).toBeUndefined();
  });

  // Edge: .split(":").pop() on a source with many colons returns last segment
  test("__attached__: with colons in the termId-like segment → last split wins", () => {
    // This matches the real code: s.source.split(":").pop()
    // So "__attached__:shell:foo:bar" would give "bar"
    expect(
      resolveTermId({ source: "__attached__:shell:foo:bar" }, {}),
    ).toBe("bar");
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
      isOpenInWt("/home/user/project", "/ws/.claude/sessions/abc.jsonl", openSessionsByWt),
    ).toBe(true);
  });

  test("shell source present → true", () => {
    expect(
      isOpenInWt("/home/user/project", "__attached__:shell:term1", openSessionsByWt),
    ).toBe(true);
  });

  test("ollama transcript source present → true", () => {
    expect(
      isOpenInWt("/home/user/project", "__transcript__:ollama:olm1", openSessionsByWt),
    ).toBe(true);
  });

  test("source not in the worktree → false", () => {
    expect(
      isOpenInWt("/home/user/project", "__attached__:shell:term999", openSessionsByWt),
    ).toBe(false);
  });

  test("correct source but wrong worktree path → false", () => {
    expect(
      isOpenInWt("/home/user/project2", "/ws/.claude/sessions/abc.jsonl", openSessionsByWt),
    ).toBe(false);
  });

  test("worktree path absent from map → false (treated as empty list)", () => {
    expect(
      isOpenInWt("/nonexistent/wt", "__attached__:shell:term1", openSessionsByWt),
    ).toBe(false);
  });

  test("empty session list for worktree → false", () => {
    expect(
      isOpenInWt("/home/user/project2", "/ws/.claude/sessions/abc.jsonl", openSessionsByWt),
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

  test("non-ollama agent → returned unchanged", () => {
    const s: OpenSession = { agent: "claude", source: "/ws/.claude/sessions/x.jsonl" };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  test("ollama but source starts with __transcript__: → returned unchanged", () => {
    const s: OpenSession = { agent: "ollama", source: "__transcript__:ollama:tid-abc" };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  test("ollama but source starts with __new__: → returned unchanged", () => {
    const s: OpenSession = { agent: "ollama", source: "__new__:ollama:1" };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  test("ollama but source starts with __attached__: → returned unchanged", () => {
    const s: OpenSession = { agent: "ollama", source: "__attached__:ollama:tid-abc" };
    expect(normalizeSessionForOpen(wtPath, s, repos)).toBe(s);
  });

  // ---- Translation cases ----

  test("ollama JSONL source → translates to __transcript__:ollama:<termId>", () => {
    const s: OpenSession = { agent: "ollama", source: "/workspace/ollama/tid-abc.jsonl" };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-abc");
    expect(result.agent).toBe("ollama");
  });

  test("ollama JSONL with matching agent → ollamaModel is populated from model field", () => {
    const s: OpenSession = { agent: "ollama", source: "/workspace/ollama/tid-abc.jsonl" };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.ollamaModel).toBe("llama3.2:3b");
  });

  test("ollama JSONL with no matching agent in agents list → ollamaModel is undefined", () => {
    const s: OpenSession = { agent: "ollama", source: "/workspace/ollama/tid-unknown.jsonl" };
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
    const s: OpenSession = { agent: "ollama", source: "/workspace/ollama/tid-src.jsonl" };
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
    const s: OpenSession = { agent: "ollama", source: "/workspace/ollama/tid-xyz.jsonl" };
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
    const s: OpenSession = { agent: "ollama", source: "/workspace/ollama/tid-abc.jsonl" };
    // wrong worktree path
    const result = normalizeSessionForOpen("/nonexistent/wt", s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-abc");
    expect(result.ollamaModel).toBeUndefined();
  });

  test("Windows-style path separator (backslash) → basename extracted correctly", () => {
    // The real regex is /[\\/]/ so it handles both separators
    const s: OpenSession = { agent: "ollama", source: "C:\\workspace\\ollama\\tid-win.jsonl" };
    const result = normalizeSessionForOpen(wtPath, s, repos);
    expect(result.source).toBe("__transcript__:ollama:tid-win");
  });
});

// ---------------------------------------------------------------------------
// dismissIfShell — decision logic only
//
// The SIDE EFFECT (calling dismissShellSource which writes to daemon KV) is
// NOT tested here — it requires a running daemon or a mock KV store.
// Deferred to the extraction step, where the real module will expose a
// `computeDismissTarget(s, newTermIds)` helper or equivalent.
// ---------------------------------------------------------------------------

describe("dismissIfShell — decision logic", () => {
  test("non-shell agent → null (nothing to dismiss)", () => {
    expect(
      dismissIfShellDecision({ agent: "claude", source: "/ws/x.jsonl" }, {}),
    ).toBeNull();
  });

  test("files agent → null (not a shell)", () => {
    expect(
      dismissIfShellDecision({ agent: "files", source: "__files__:/some/path" }, {}),
    ).toBeNull();
  });

  test("shell + __attached__:shell:<id> → returns the source itself", () => {
    expect(
      dismissIfShellDecision(
        { agent: "shell", source: "__attached__:shell:term1" },
        {},
      ),
    ).toBe("__attached__:shell:term1");
  });

  test("shell + __transcript__:shell:<id> → returns the source itself", () => {
    expect(
      dismissIfShellDecision(
        { agent: "shell", source: "__transcript__:shell:term99" },
        {},
      ),
    ).toBe("__transcript__:shell:term99");
  });

  test("shell + __new__:shell: with termId in map → returns __attached__:shell:<termId>", () => {
    const newTermIds = { "__new__:shell:1": "term-mapped" };
    expect(
      dismissIfShellDecision(
        { agent: "shell", source: "__new__:shell:1" },
        newTermIds,
      ),
    ).toBe("__attached__:shell:term-mapped");
  });

  test("shell + __new__:shell: NOT in map → null (no termId known, nothing to dismiss)", () => {
    expect(
      dismissIfShellDecision(
        { agent: "shell", source: "__new__:shell:missing" },
        {},
      ),
    ).toBeNull();
  });

  test("shell + unknown source form → null (real code falls through without action)", () => {
    // A shell source that doesn't start with __attached__:, __transcript__:, or __new__:
    // The real function does nothing in that case → decision is null.
    expect(
      dismissIfShellDecision(
        { agent: "shell", source: "/some/bare/path" },
        {},
      ),
    ).toBeNull();
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
