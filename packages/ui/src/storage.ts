/**
 * Persisted set of "expanded" UI items (e.g. worktree paths whose commit
 * history is shown).
 *
 * The storage is injected (a tiny KVStore interface) so this class is
 * testable without a real browser. Production calls `new ExpandedStore(
 * window.localStorage, "supergit:commitsExpanded")`; tests pass an in-
 * memory map.
 */

export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class ExpandedStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  /** Returns the set of currently-expanded paths. Tolerant of corrupt storage. */
  load(): Set<string> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return new Set();
    }
    if (raw === null) return new Set();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Set();
    }
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  }

  /** Persists the given paths. Errors (quota, private-mode, etc.) are swallowed. */
  save(paths: Iterable<string>): void {
    try {
      this.storage.setItem(this.key, JSON.stringify([...paths]));
    } catch {
      // ignore — persistence is best-effort
    }
  }
}

/**
 * Persisted set of "starred" (favorite) session sources. Starred
 * sessions float to the top of the session picker (when not filtered
 * by a search query). Same shape / corruption-tolerance as
 * DismissedSessionsStore — keyed on the session's stable `source` string.
 */
export class StarredSessionsStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  load(): Set<string> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return new Set();
    }
    if (raw === null) return new Set();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Set();
    }
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  }

  save(sources: Iterable<string>): void {
    try {
      this.storage.setItem(this.key, JSON.stringify([...sources]));
    } catch {
      // ignore — persistence is best-effort
    }
  }
}

/**
 * Persisted set of "dismissed" session sources. Sessions in this set
 * are pushed into a separate "Dismissed" group at the bottom of the
 * session picker so the active list stays clean. Restoring removes
 * the source from the set. Same shape / corruption-tolerance as
 * ExpandedStore — keyed on the session's stable `source` string.
 */
export class DismissedSessionsStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  load(): Set<string> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return new Set();
    }
    if (raw === null) return new Set();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Set();
    }
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  }

  save(sources: Iterable<string>): void {
    try {
      this.storage.setItem(this.key, JSON.stringify([...sources]));
    } catch {
      // ignore — persistence is best-effort
    }
  }
}

/**
 * Persisted map of "which sessions were open under which worktree". Survives
 * page reloads so the user lands back where they were. Same KVStore-injection
 * pattern as ExpandedStore so it's testable without a real browser.
 */
export type PersistedAgent =
  | "claude"
  | "codex"
  | "copilot"
  | "ollama"
  | "shell"
  | "files"
  | "history";

/** Model tier aliases offered for Claude sessions. We deliberately stick
 *  to the CLI's stable aliases rather than pinned versions so the menu
 *  keeps mapping to the latest model of each tier without code changes. */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/** Effort levels the Claude CLI accepts via `--effort`. */
export const CLAUDE_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** Collapse a model id — either a bare alias ("opus") or a full id
 *  ("claude-opus-4-8") — down to its tier alias for display in the agent
 *  pill. Returns undefined when the input is empty or doesn't match a
 *  known tier, so callers can fall back to the generic "claude" label
 *  rather than showing a fabricated tier. */
export function claudeModelAlias(
  model: string | undefined,
): ClaudeModelAlias | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return undefined;
}

export interface PersistedSession {
  agent: PersistedAgent;
  source: string;
  /** Optional. For `agent === "ollama"` sessions, the model tag to run
   *  (e.g. `"llama3.2:3b"`). Persisted so a reload re-spawns
   *  `ollama run <model>` instead of a bare `ollama` prompt. */
  ollamaModel?: string;
  /** Optional. For `agent === "claude"` sessions, the model tier alias
   *  (`opus` / `sonnet` / `haiku`) the user picked from the session
   *  header menu. Passed as `claude --model <alias>` on spawn/resume.
   *  Absence ⇒ no `--model` flag, i.e. claude's configured default. */
  claudeModel?: ClaudeModelAlias;
  /** Optional. For `agent === "claude"` sessions, the effort level
   *  (`low`/`medium`/`high`/`xhigh`/`max`) picked from the header menu.
   *  Passed as `claude --effort <level>`. Absence ⇒ claude's default. */
  claudeEffort?: ClaudeEffort;
  /** Optional. Stamped onto `__new__:claude:` / `__new__:codex:` entries
   *  the first time the daemon's activity-tail surfaces a real agent-side
   *  session id for that (cwd, agent). On a subsequent mount (notably
   *  after a hard reload that outlives the daemon's PTY-grace window) we
   *  spawn `claude --resume <sid>` instead of bare `claude`, so the
   *  conversation continues instead of starting over. */
  resumeSessionId?: string;
  /** Optional. UUID generated by `openNewAgentSession` for brand-new
   *  Claude columns and passed as `claude --session-id <uuid>` on spawn.
   *  Forces a fresh conversation even when Claude CLI would otherwise
   *  auto-load the cwd's most-recent session. Persisted so that a
   *  reload before the JSONL appears re-spawns with the same id (the
   *  daemon's PTY-grace window keeps the original PTY alive in most
   *  cases, but if the daemon was restarted the next mount must still
   *  land on the same session file). Once `resumeSessionId` is stamped,
   *  this becomes ignored — the resume path takes over. */
  preassignedSessionId?: string;
  /** Optional. When `"terminal"`, the SessionView column for this source
   *  was last seen with "Resume in terminal" mode active (i.e. the user
   *  flipped from the markdown chat view to a live `claude --resume`
   *  PTY). On remount, the column should re-enter terminal mode so a
   *  page reload doesn't drop the user back to the read-only history.
   *  Absence implies the default `"read"` mode. */
  mode?: "terminal";
  /** Optional. The daemon terminal id of the live PTY this column is
   *  currently attached to, stamped on spawn so a remount/reopen in the
   *  same page reattaches to the running TUI instead of re-spawning. NOT
   *  round-tripped through `sanitizeSession` (deliberately dropped on load):
   *  it's only valid within the daemon run that minted it, and a stale one
   *  after a daemon restart now self-heals via TerminalView's spawn
   *  fallback. */
  attachTermId?: string;
}

const VALID_AGENTS: ReadonlySet<PersistedAgent> = new Set([
  "claude",
  "codex",
  "copilot",
  "ollama",
  // Terminal columns (plain `$SHELL` PTYs) live in `openSessionsByWt`
  // alongside agents. Without "shell" here, `sanitizeSession` strips
  // every persisted shell entry on `OpenSessionsStore.load()` — the
  // disposed-terminal-column-disappears-after-reload bug.
  "shell",
  "files",
  "history",
]);

function sanitizeSession(item: unknown): PersistedSession | null {
  if (typeof item !== "object" || item === null) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.source !== "string" || o.source.length === 0) return null;
  if (typeof o.agent !== "string") return null;
  if (!VALID_AGENTS.has(o.agent as PersistedAgent)) return null;
  const out: PersistedSession = {
    agent: o.agent as PersistedAgent,
    source: o.source,
  };
  if (typeof o.resumeSessionId === "string" && o.resumeSessionId.length > 0) {
    out.resumeSessionId = o.resumeSessionId;
  }
  if (
    typeof o.preassignedSessionId === "string" &&
    o.preassignedSessionId.length > 0
  ) {
    out.preassignedSessionId = o.preassignedSessionId;
  }
  if (o.mode === "terminal") {
    out.mode = "terminal";
  }
  if (typeof o.ollamaModel === "string" && o.ollamaModel.length > 0) {
    out.ollamaModel = o.ollamaModel;
  }
  if (
    typeof o.claudeModel === "string" &&
    (CLAUDE_MODEL_ALIASES as readonly string[]).includes(o.claudeModel)
  ) {
    out.claudeModel = o.claudeModel as ClaudeModelAlias;
  }
  if (
    typeof o.claudeEffort === "string" &&
    (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(o.claudeEffort)
  ) {
    out.claudeEffort = o.claudeEffort as ClaudeEffort;
  }
  return out;
}

export class OpenSessionsStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  /** Returns the persisted map. Tolerates garbage at any level. */
  load(): Record<string, PersistedSession[]> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return {};
    }
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Record<string, PersistedSession[]> = {};
    for (const [wtPath, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof wtPath !== "string" || wtPath.length === 0) continue;
      if (!Array.isArray(value)) continue;
      const list: PersistedSession[] = [];
      const seen = new Set<string>();
      for (const item of value) {
        const s = sanitizeSession(item);
        if (!s) continue;
        if (seen.has(s.source)) continue; // de-dupe by source
        seen.add(s.source);
        list.push(s);
      }
      if (list.length > 0) out[wtPath] = list;
    }
    return out;
  }

  /** Persists the map. Errors (quota / privacy mode) are swallowed. */
  save(data: Record<string, PersistedSession[]>): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(data));
    } catch {
      // best-effort
    }
  }
}

/** Source prefixes the daemon doesn't list in `/api/agents` but the UI
 *  still wants to render: brand-new agent sessions before their JSONL
 *  has appeared on disk, plus Terminal-column shells (which are entirely
 *  workspace-owned and never show up in the agent snapshot). Centralised
 *  so the render-time filter and the persistence layer agree on what
 *  counts as a "synthetic" source. */
export const SYNTHETIC_SOURCE_PREFIXES = [
  // Brand-new agent or shell session — TUI is up, JSONL not yet on disk
  // (or, for shells, never indexed by agentsForWorktree at all).
  "__new__:",
  // Reattached shell after a UI reload — TerminalView skips spawn and
  // connects to an existing live PTY via WS.
  "__attached__:",
  // Past-shell read-mode column — ShellView renders the transcript and
  // a Resume button.
  "__transcript__:",
  // File browser panel — entirely UI-owned, no daemon-side session.
  "__files__:",
  // Remote SSH file browser — UI-owned, backed by /api/ssh/* routes.
  "__remote__:",
  // Persisted terminal awaiting user resume after daemon restart.
  "__restore__:",
  // Git history panel — commit list + diff viewer, entirely UI-owned.
  "__history__:",
] as const;

/**
 * Filter a persisted list to sessions whose source file is still detected
 * by the daemon (i.e. present in the current `/api/agents` snapshot) OR
 * whose source is a known supergit-internal synthetic prefix (new TUI
 * spawns, live shell reattaches, past-shell read-mode columns).
 *
 * IMPORTANT: this is a *render-time* filter. Callers must keep the
 * unfiltered list in persistence — if a session file vanishes
 * temporarily (file moved, tool not running) we hide it from the UI but
 * do NOT drop it from saved state. When the source reappears the row
 * shows up again on the next load.
 */
export function filterToExistingSessions(
  persisted: PersistedSession[],
  existingSources: ReadonlySet<string>,
): PersistedSession[] {
  // Dedupe by source as a last line of defense for the strip's
  // `{#each ... as s (s.source)}` block. Promotion paths
  // (executePromotion, promoteTransientSessions) rewrite a `__new__:`
  // source to a real one, and can collide with an entry that already
  // has that real source — which would crash Svelte with
  // `each_key_duplicate`. Keep the first occurrence to preserve
  // drag-reorder.
  const seen = new Set<string>();
  return persisted.filter((s) => {
    if (seen.has(s.source)) return false;
    const keep =
      SYNTHETIC_SOURCE_PREFIXES.some((p) => s.source.startsWith(p)) ||
      existingSources.has(s.source);
    if (keep) seen.add(s.source);
    return keep;
  });
}

/**
 * Whether a real (file-backed) open-session source is "foreign" to a
 * worktree — i.e. the daemon's per-worktree agent/shell snapshot does NOT
 * list it. Synthetic columns (brand-new TUIs, attached/restored shells,
 * browse panels — see `SYNTHETIC_SOURCE_PREFIXES`) are never foreign: they
 * are supergit-internal and never appear in `/api/agents`.
 *
 * The activity dock uses this to skip cross-worktree-contaminated or stale
 * entries. If a session whose JSONL belongs to another repo gets filed
 * under this worktree's `openSessionsByWt` list, the dock would otherwise
 * render it as a phantom dot labelled with this worktree's branch (e.g. a
 * needle-logs-view session showing up as "supergit main"). The dashboard
 * sessions-strip already drops these via `filterToExistingSessions`; this
 * is the same per-worktree existence gate for the dock, where it was
 * missing.
 */
export function isForeignToWorktree(
  source: string,
  knownSources: ReadonlySet<string>,
): boolean {
  if (SYNTHETIC_SOURCE_PREFIXES.some((p) => source.startsWith(p))) return false;
  return !knownSources.has(source);
}

/** Build the cmd[] supergit should hand to a `TerminalView` mounted in
 *  a transient (`__new__:` / `__attached__:`) column.
 *
 *  For shells, it's the user's default login shell — agent doesn't matter.
 *
 *  For agent TUIs the rule is:
 *  - **no `resumeSessionId`** (the brand-new spawn, JSONL not yet on
 *    disk): the bare agent CLI. Claude/Codex will mint their own
 *    session id and start writing it.
 *  - **`resumeSessionId` stamped** (the activity tail has surfaced the
 *    real session id, either earlier in this tab or persisted from a
 *    prior tab/before-reload): `claude --resume <sid>
 *    --allow-dangerously-skip-permissions` / `codex resume <sid>`. This
 *    is the path that makes hard reloads non-destructive — without it,
 *    every reload of a live agent column starts a fresh conversation. */
export function cmdForOpenSession(
  s: {
    agent: PersistedAgent | "shell";
    resumeSessionId?: string;
    preassignedSessionId?: string;
    contextFilePath?: string;
    claudeModel?: string;
    claudeEffort?: string;
    shellCmd?: string[];
  },
  defaultShell: string,
  defaultShellArgs: string[] = ["-l"],
): string[] {
  // Shell path + flags come from the daemon via /api/shell-default
  // (defaultLoginShell()). The daemon resolves $SHELL / COMSPEC with
  // platform-appropriate flags so the UI doesn't duplicate that logic.
  // A `shellCmd` override wins when the picker offered >1 shell (Windows:
  // PowerShell vs CMD) and the user clicked a specific one.
  if (s.agent === "shell") {
    if (s.shellCmd && s.shellCmd.length > 0) return [...s.shellCmd];
    return [defaultShell, ...defaultShellArgs];
  }
  const sid = s.resumeSessionId;
  if (s.agent === "claude") {
    // Model/effort flags apply to both the fresh-spawn and resume paths
    // (switching model mid-thread is the "restart via resume" UX). They
    // must land before any trailing positional prompt (the contextFile
    // "Pick up where…" line) or claude reads the prompt as a flag value.
    const modelFlags: string[] = [];
    if (s.claudeModel) modelFlags.push("--model", s.claudeModel);
    if (s.claudeEffort) modelFlags.push("--effort", s.claudeEffort);
    if (sid) {
      return [
        "claude",
        "--resume",
        sid,
        "--allow-dangerously-skip-permissions",
        ...modelFlags,
      ];
    }
    const cmd = ["claude"];
    if (s.preassignedSessionId) {
      cmd.push("--session-id", s.preassignedSessionId);
    }
    cmd.push(...modelFlags);
    if (s.contextFilePath) {
      cmd.push("--append-system-prompt-file", s.contextFilePath);
      cmd.push("--allow-dangerously-skip-permissions");
      cmd.push("Pick up where the previous conversation left off.");
    }
    return cmd;
  }
  if (s.agent === "codex") {
    if (sid) return ["codex", "resume", sid];
    if (s.contextFilePath) {
      return [
        "codex",
        `Continue this conversation. Read the prior context from ${s.contextFilePath}`,
      ];
    }
    return ["codex"];
  }
  // copilot has no resume semantics in v0; ollama no longer spawns a
  // PTY (chat goes through /api/ollama/chat — see plans/ollama.md).
  return [s.agent];
}

/** Attach the real agent-side session id to the first matching
 *  `__new__:<agent>:` column in the given worktree that doesn't have one
 *  yet. The match key is `(cwd, agent)`. Returns a new map only when
 *  something actually changed — same reference otherwise, so reactive
 *  consumers can `if (next !== prev)` to skip work.
 *
 *  Why "first unstamped wins": if the user has two simultaneous
 *  `__new__:claude:` columns in the same worktree (opened sequentially),
 *  the activity tail will surface each new sessionId as its JSONL
 *  appears. Each event lands on the next column that hasn't been
 *  stamped yet. Concurrent opens (rare) may attribute incorrectly;
 *  acceptable until we plumb the sessionId back from the spawning side. */
/** Update the persisted `mode` for one (wtPath, source) entry without
 *  disturbing anything else. `"terminal"` adds the field; `"read"` drops
 *  it (absence is the default and we don't want to leave dead state
 *  behind once the user disposes a TUI). Returns the same map reference
 *  when nothing changed — same short-circuit contract as
 *  `stampDiscoveredSessionId`. */
export function setSessionMode(
  byWt: Record<string, PersistedSession[]>,
  wtPath: string,
  source: string,
  mode: "read" | "terminal",
): Record<string, PersistedSession[]> {
  const list = byWt[wtPath];
  if (!list) return byWt;
  const idx = list.findIndex((s) => s.source === source);
  if (idx === -1) return byWt;
  const current = list[idx]!;
  const currentMode = current.mode === "terminal" ? "terminal" : "read";
  if (currentMode === mode) return byWt;
  const updated: PersistedSession = { ...current };
  if (mode === "terminal") updated.mode = "terminal";
  else delete updated.mode;
  const next = list.slice();
  next[idx] = updated;
  return { ...byWt, [wtPath]: next };
}

/** Point a session's `attachTermId` at a freshly-spawned PTY so a remount
 *  or reopen in the same page reattaches to the live terminal instead of a
 *  stale id (which 404s the WS and — post spawn-fallback — forces another
 *  spawn). No-op when the source isn't present or the id is unchanged;
 *  returns the same reference in that case so reactive `$:` consumers can
 *  skip work. */
export function setSessionAttachTermId(
  byWt: Record<string, PersistedSession[]>,
  wtPath: string,
  source: string,
  termId: string,
): Record<string, PersistedSession[]> {
  const list = byWt[wtPath];
  if (!list) return byWt;
  const idx = list.findIndex((s) => s.source === source);
  if (idx === -1) return byWt;
  if (list[idx]!.attachTermId === termId) return byWt;
  const next = list.slice();
  next[idx] = { ...list[idx]!, attachTermId: termId };
  return { ...byWt, [wtPath]: next };
}

export function stampDiscoveredSessionId(
  byWt: Record<string, PersistedSession[]>,
  ev: {
    agent: PersistedAgent;
    cwd: string;
    sessionId: string;
    source?: string;
  },
): Record<string, PersistedSession[]> {
  const res = stampDiscoveredSessionIdWithDetail(byWt, ev);
  return res.byWt;
}

/** Same as `stampDiscoveredSessionId` but also returns the synthetic
 *  source of the column that was just stamped (if any). The caller can
 *  use it to migrate a server-side title from the synthetic key to the
 *  real JSONL path (`ev.source` at the call site) — see
 *  [[feedback-titles-linked-to-real-session-ids]] for the bug this
 *  fixes (titles staying on disposable synthetic keys after the agent's
 *  JSONL takes over).
 *
 *  `stampedSource` is `null` when nothing matched (no churn), so the
 *  caller can short-circuit the migrate POST.
 *
 *  Skips stamping when the sid is already claimed by another column in
 *  the same worktree — either as a sibling's `resumeSessionId` or as
 *  the JSONL path (`ev.source`) of an already-listed entry. Without
 *  that guard, an activity event from an existing live conversation
 *  greedily mis-stamps a newly opened `__new__:` column, causing two
 *  columns to point at the same JSONL (shared title, shared resume
 *  cmdline). See the "does NOT stamp a __new__: column with a sid
 *  already claimed by a sibling column" test for the scenario. */
export function stampDiscoveredSessionIdWithDetail(
  byWt: Record<string, PersistedSession[]>,
  ev: {
    agent: PersistedAgent;
    cwd: string;
    sessionId: string;
    source?: string;
  },
): { byWt: Record<string, PersistedSession[]>; stampedSource: string | null } {
  if (!ev.sessionId) return { byWt, stampedSource: null };
  const list = byWt[ev.cwd];
  if (!list || list.length === 0) return { byWt, stampedSource: null };
  const alreadyClaimed = list.some(
    (s) =>
      s.agent === ev.agent &&
      (s.resumeSessionId === ev.sessionId ||
        (ev.source !== undefined && s.source === ev.source)),
  );
  if (alreadyClaimed) return { byWt, stampedSource: null };
  const prefix = `__new__:${ev.agent}:`;
  const idx = list.findIndex(
    (s) =>
      s.agent === ev.agent && s.source.startsWith(prefix) && !s.resumeSessionId,
  );
  if (idx === -1) return { byWt, stampedSource: null };
  const target = list[idx]!;
  const next = list.slice();
  next[idx] = { ...target, resumeSessionId: ev.sessionId };
  return {
    byWt: { ...byWt, [ev.cwd]: next },
    stampedSource: target.source,
  };
}

/** Where should the manual title for a still-transient (`__new__:<agent>:…`)
 *  column be stored? Once the activity tail has surfaced a real agent
 *  session id and we can match it back to its JSONL path, the title
 *  belongs there — that way a hard reload (which re-mints synthetic ids
 *  on the *next* spawn) still surfaces the user's named title against
 *  whatever conversation the agent is actually resuming. Before that,
 *  fall back to the synthetic source so an unfinished name doesn't get
 *  silently dropped. */
export function resolveTitleSource(
  session: {
    source: string;
    resumeSessionId?: string;
    agent: PersistedAgent | "shell";
  },
  agents: ReadonlyArray<{ agent: string; sessionId?: string; source: string }>,
): string {
  if (!session.source.startsWith("__new__:")) return session.source;
  const sid = session.resumeSessionId;
  if (!sid) return session.source;
  const match = agents.find(
    (a) => a.agent === session.agent && a.sessionId === sid,
  );
  return match?.source ?? session.source;
}

/**
 * Persisted "which worktrees of each repo should appear as rows in the
 * dashboard". Storage shape: { [repoId]: string[] } where strings are
 * worktree paths.
 *
 * The dashboard used to flat-list every worktree of every registered
 * repo. That gets noisy fast on repos with many branches, so the user
 * controls visibility explicitly: adding a repo defaults to showing
 * only the main worktree; the worktree picker toggles others in / out.
 *
 * Persistence is per-browser (localStorage). Daemon doesn't see this —
 * which is fine; it's a presentation concern, not workspace state.
 */
export class VisibleWorktreesStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  load(): Record<string, string[]> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return {};
    }
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [repoId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!Array.isArray(value)) continue;
      out[repoId] = value.filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
    }
    return out;
  }

  save(map: Record<string, string[]>): void {
    try {
      // Strip empty arrays + non-string entries on the way out so we
      // don't accumulate garbage.
      const sanitized: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(map)) {
        const paths = (v ?? []).filter(
          (p) => typeof p === "string" && p.length > 0,
        );
        if (paths.length > 0) sanitized[k] = paths;
      }
      this.storage.setItem(this.key, JSON.stringify(sanitized));
    } catch {
      // ignore — best-effort
    }
  }
}

/**
 * Compute the effective list of worktree paths to render for a given
 * repo, applying defaults for repos with no stored visibility yet.
 *
 * Default behaviour: when no entry exists for the repo, fall back to
 * showing **the first worktree only**. (The first one from `git
 * worktree list` is the original / main worktree of the repo.)
 *
 * Caller is responsible for passing the *current* set of on-disk
 * worktrees — any path in the stored list that no longer exists on
 * disk is silently dropped so removed worktrees don't haunt the UI.
 */
export function effectiveVisibleWorktrees(
  repoId: string,
  diskWorktreePaths: string[],
  stored: Record<string, string[]>,
): string[] {
  if (diskWorktreePaths.length === 0) return [];
  const entry = stored[repoId];
  if (entry === undefined) {
    return [diskWorktreePaths[0]!];
  }
  const onDisk = new Set(diskWorktreePaths);
  return entry.filter((p) => onDisk.has(p));
}

/**
 * Persisted map of "which detected URL the user pinned to a command
 * link's open button", keyed by the custom-link's stable id. A command
 * link can surface several URLs while it runs (dev server, preview,
 * tunnel, …); clicking one in the dropdown both opens it and assigns it
 * to the open button. That choice belongs in daemon prefs (`getDaemonKV`),
 * not in-memory component state: the URLs are re-detected every time the
 * command runs, but the *pick* must outlive the terminal session that
 * surfaced them and the daemon run itself, so re-running the command
 * later keeps the open button pointing at the user's chosen URL.
 *
 * Same KVStore-injection + corruption tolerance as the other stores.
 */
export class CommandUrlPickStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  /** Returns the linkId → pinned-URL map. Tolerates garbage at any level. */
  load(): Record<string, string> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return {};
    }
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [linkId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        typeof linkId === "string" &&
        linkId.length > 0 &&
        typeof value === "string"
      ) {
        out[linkId] = value;
      }
    }
    return out;
  }

  /** Pins `url` to `linkId`'s open button, leaving every other pick
   *  untouched (read-modify-write so concurrent component instances
   *  sharing the same storage don't clobber each other's entries). */
  set(linkId: string, url: string): void {
    const map = this.load();
    if (map[linkId] === url) return;
    map[linkId] = url;
    try {
      this.storage.setItem(this.key, JSON.stringify(map));
    } catch {
      // ignore — best-effort; the pick just won't carry over next time
    }
  }
}

/**
 * Persisted map of `linkId → { wtPath, source }` recording which
 * `__attached__:shell:<termId>` column was spawned by which custom-
 * link command. Lets the click handler reuse an existing internal-
 * mode command terminal (focus + scroll) instead of spawning a fresh
 * PTY each time — and survives page reloads so the reuse logic still
 * works after the in-memory state is gone.
 */
export interface CommandTermEntry {
  wtPath: string;
  source: string;
}

export class CommandTermStore {
  constructor(
    private readonly storage: KVStore,
    private readonly key: string,
  ) {}

  load(): Record<string, CommandTermEntry> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return {};
    }
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Record<string, CommandTermEntry> = {};
    for (const [linkId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof linkId !== "string" || linkId.length === 0) continue;
      if (typeof value !== "object" || value === null) continue;
      const v = value as { wtPath?: unknown; source?: unknown };
      if (
        typeof v.wtPath === "string" &&
        v.wtPath.length > 0 &&
        typeof v.source === "string" &&
        v.source.length > 0
      ) {
        out[linkId] = { wtPath: v.wtPath, source: v.source };
      }
    }
    return out;
  }

  save(map: Record<string, CommandTermEntry>): void {
    try {
      const sanitized: Record<string, CommandTermEntry> = {};
      for (const [k, v] of Object.entries(map)) {
        if (
          typeof k === "string" &&
          k.length > 0 &&
          v &&
          typeof v.wtPath === "string" &&
          typeof v.source === "string"
        ) {
          sanitized[k] = { wtPath: v.wtPath, source: v.source };
        }
      }
      this.storage.setItem(this.key, JSON.stringify(sanitized));
    } catch {
      // best-effort
    }
  }

  set(linkId: string, entry: CommandTermEntry): void {
    const map = this.load();
    map[linkId] = entry;
    this.save(map);
  }

  delete(linkId: string): void {
    const map = this.load();
    if (!(linkId in map)) return;
    delete map[linkId];
    this.save(map);
  }
}
