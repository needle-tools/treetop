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
 * Persisted map of "which sessions were open under which worktree". Survives
 * page reloads so the user lands back where they were. Same KVStore-injection
 * pattern as ExpandedStore so it's testable without a real browser.
 */
export type PersistedAgent = "claude" | "codex" | "copilot";

export interface PersistedSession {
  agent: PersistedAgent;
  source: string;
}

const VALID_AGENTS: ReadonlySet<PersistedAgent> = new Set([
  "claude",
  "codex",
  "copilot",
]);

function sanitizeSession(item: unknown): PersistedSession | null {
  if (typeof item !== "object" || item === null) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.source !== "string" || o.source.length === 0) return null;
  if (typeof o.agent !== "string") return null;
  if (!VALID_AGENTS.has(o.agent as PersistedAgent)) return null;
  return { agent: o.agent as PersistedAgent, source: o.source };
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

/**
 * Filter a persisted list to sessions whose source file is still detected
 * by the daemon (i.e. present in the current `/api/agents` snapshot).
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
  return persisted.filter((s) => existingSources.has(s.source));
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [repoId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      out[repoId] = value.filter((x): x is string => typeof x === "string" && x.length > 0);
    }
    return out;
  }

  save(map: Record<string, string[]>): void {
    try {
      // Strip empty arrays + non-string entries on the way out so we
      // don't accumulate garbage.
      const sanitized: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(map)) {
        const paths = (v ?? []).filter((p) => typeof p === "string" && p.length > 0);
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
