/**
 * Pure session-source routing helpers extracted from App.svelte.
 * Behaviour pinned by packages/ui/test/session-source-routing.test.ts.
 *
 * None of the functions here perform side effects. All reactive state that
 * was previously closed over in App.svelte is passed as an explicit parameter.
 */

// ---------------------------------------------------------------------------
// Local type definitions
// (mirrors the inline interfaces declared in App.svelte's <script>)
// ---------------------------------------------------------------------------

export interface AgentSession {
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

export interface ShellRecord {
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

export interface OpenSession {
  agent: AgentSession["agent"] | "shell" | "files" | "history";
  source: string;
  resumeSessionId?: string;
  preassignedSessionId?: string;
  mode?: "terminal";
  ollamaModel?: string;
  contextFilePath?: string;
  attachTermId?: string;
}

export interface Worktree {
  path: string;
  agents?: AgentSession[];
}

export interface Repo {
  worktrees?: Worktree[];
}

// ---------------------------------------------------------------------------
// resolveTermId
//
// Resolve the daemon termId for a `__new__:` or `__attached__:` column.
// `__attached__:` sources carry it directly in the suffix;
// `__new__:` sources are looked up in `newTermIds`.
//
// Faithful copy of App.svelte `resolveTermId` (line ~970).
// Closed-over `newTermIds` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function resolveTermId(
  s: { source: string },
  newTermIds: Record<string, string>,
): string | undefined {
  if (s.source.startsWith("__attached__:")) return s.source.split(":").pop();
  if (s.source.startsWith("__new__:")) return newTermIds[s.source];
  return undefined;
}

// ---------------------------------------------------------------------------
// isOpenInWt
//
// Returns true when `source` appears in the open-session list for `wtPath`.
//
// Faithful copy of App.svelte `isOpenInWt` (line ~2568).
// Closed-over `openSessionsByWt` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function isOpenInWt(
  wtPath: string,
  source: string,
  openSessionsByWt: Record<string, OpenSession[]>,
): boolean {
  return (openSessionsByWt[wtPath] ?? []).some((s) => s.source === source);
}

// ---------------------------------------------------------------------------
// normalizeSessionForOpen
//
// Rewrite a picker-supplied OpenSession when needed. Ollama sessions
// surface from `/api/agents` with `source` set to the JSONL header
// path under `<workspace>/ollama/`; opening one directly would land
// it in the SessionView render branch (which only parses Claude/
// Codex JSONLs and would render blank). Translate to a
// `__transcript__:ollama:<termId>` source — that's the shape
// OllamaTranscriptView mounts on — and stash the model from the
// matching AgentSession so the read-only view knows what to label
// the pill and what to Resume into.
//
// Faithful copy of App.svelte `normalizeSessionForOpen` (line ~2580).
// Closed-over `repos` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function normalizeSessionForOpen(
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
// shellToSession
//
// Map shell records into the same shape as AgentSession so the picker
// can iterate one merged list. The `source` is the synthetic
// attached/transcript token openSessionsByWt expects, so clicking a
// picker row routes through `toggleOpenSessionInWt` unchanged.
//
// Faithful copy of App.svelte `shellToSession` (line ~5310).
// No closed-over state — fully pure.
// ---------------------------------------------------------------------------

export function shellToSession(sh: ShellRecord): AgentSession {
  return {
    agent: "shell",
    cwd: sh.wt,
    // Age by most recent activity, not spawn time, so a shell the
    // user touched five minutes ago ranks above one they spawned an
    // hour ago and abandoned.
    lastActive: sh.lastCmdTs ?? sh.createdAt,
    source: sh.alive
      ? `__attached__:shell:${sh.termId}`
      : `__transcript__:shell:${sh.termId}`,
    title: sh.currentCwd ?? sh.spawnCwd,
    sessionId: sh.termId,
    // Feed the last command through `lastUserMessage` so it both
    // renders inline on the row and participates in fuzzy search
    // ("which shell did I run `bun test` in?").
    lastUserMessage: sh.lastCmd,
    messageCount: sh.cmdCount,
    manualTitle: sh.manualTitle,
  };
}

// ---------------------------------------------------------------------------
// shellSourceToDismiss
//
// Returns the source string that should be passed to `dismissShellSource`,
// or null if this session should NOT be dismissed (non-shell, or unknown form).
//
// This is the PURE DECISION part of App.svelte `dismissIfShell` (line ~2647).
// The side effect (calling dismissShellSource) remains in App.svelte's thin
// wrapper. Closed-over `newTermIds` is now an explicit parameter.
// ---------------------------------------------------------------------------

export function shellSourceToDismiss(
  source: string,
  newTermIds: Record<string, string>,
): string | null {
  if (
    source.startsWith("__attached__:shell:") ||
    source.startsWith("__transcript__:shell:")
  ) {
    return source;
  } else if (source.startsWith("__new__:shell:")) {
    const termId = newTermIds[source];
    if (termId) return `__attached__:shell:${termId}`;
  }
  return null;
}
