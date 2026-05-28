/**
 * Pure merge logic for restoring shell terminal columns after a UI
 * reload. Two inputs feed the column list per worktree:
 *
 *   1. `/api/shells`              → currently-alive PTYs the daemon is
 *                                   still holding. Become
 *                                   `__attached__:shell:<termId>` columns
 *                                   that WS-reattach on render.
 *
 *   2. `/api/terminals/persisted` → PTYs the daemon was tracking when it
 *                                   last wrote `active-terminals.json`.
 *                                   Become `__restore__:<termId>` cards
 *                                   ("disconnected — Resume / Dismiss").
 *
 * The bug this module fixes: a PTY that's BOTH alive AND in the persisted
 * file (the common case after a UI-only reload — the daemon never lost
 * it, so it's in both lists) ended up rendered TWICE — once as a working
 * attached column, and once as a "disconnected" Resume card for the same
 * `termId`. The UI used to compare only same-prefix sources (`s.source ===
 * "__restore__:T1"`) and didn't notice the `__attached__:shell:T1` column
 * already covering that termId.
 */

export interface LiveShell {
  termId: string;
  wt: string;
  alive: boolean;
}

export interface PersistedTerminalEntry {
  termId: string;
  cmd: string[];
  cwd: string;
  wtPath: string;
  title?: string;
  firstCmd?: string;
  lastCmd?: string;
}

export interface OpenSessionRef {
  agent: string;
  source: string;
  /** Carry-through for any other OpenSession fields callers stamp. */
  [key: string]: unknown;
}

const ATTACHED_SHELL_PREFIX = "__attached__:shell:";
const RESTORE_PREFIX = "__restore__:";

/** Extract the termId from an `__attached__:shell:<termId>` source.
 *  Returns null for any other source shape. */
export function attachedShellTermId(source: string): string | null {
  if (!source.startsWith(ATTACHED_SHELL_PREFIX)) return null;
  const id = source.slice(ATTACHED_SHELL_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Extract the termId from a `__restore__:<termId>` source. */
export function restoreTermId(source: string): string | null {
  if (!source.startsWith(RESTORE_PREFIX)) return null;
  const id = source.slice(RESTORE_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Apply the `/api/shells` response to an existing openSessions map.
 *
 * - Drops `__attached__:shell:<termId>` entries whose termId is no
 *   longer alive (stale carry-over from before a daemon restart).
 * - Adds `__attached__:shell:<termId>` for newly-alive shells, unless
 *   the user explicitly dismissed that source.
 *
 * Pure; returns a new map.
 */
export function mergeLiveShells(
  current: Record<string, OpenSessionRef[]>,
  liveShells: readonly LiveShell[],
  dismissed: ReadonlySet<string>,
): Record<string, OpenSessionRef[]> {
  const liveTermIds = new Set(
    liveShells.filter((sh) => sh.alive).map((sh) => sh.termId),
  );
  const next: Record<string, OpenSessionRef[]> = { ...current };
  for (const wt of Object.keys(next)) {
    const before = next[wt] ?? [];
    const after = before.filter((s) => {
      const termId = attachedShellTermId(s.source);
      if (termId === null) return true; // not an attached-shell row
      return liveTermIds.has(termId);
    });
    if (after.length !== before.length) next[wt] = after;
  }
  for (const sh of liveShells) {
    if (!sh.alive) continue;
    const source = `${ATTACHED_SHELL_PREFIX}${sh.termId}`;
    if (dismissed.has(source)) continue;
    const existing = next[sh.wt] ?? [];
    if (existing.some((s) => s.source === source)) continue;
    next[sh.wt] = [{ agent: "shell", source }, ...existing];
  }
  return next;
}

/**
 * Apply the `/api/terminals/persisted` response to an existing
 * openSessions map.
 *
 * - Skips entries whose termId is already shown as
 *   `__attached__:shell:<termId>` (live re-attach). Without this guard,
 *   one running terminal shows up as TWO columns after reload: the
 *   working attached one plus a stale "disconnected — Resume" card.
 * - Skips entries already present as `__restore__:<termId>`.
 *
 * Pure; returns a new map.
 */
export function mergePersistedTerminals(
  current: Record<string, OpenSessionRef[]>,
  persisted: readonly PersistedTerminalEntry[],
): Record<string, OpenSessionRef[]> {
  if (persisted.length === 0) return current;
  const next: Record<string, OpenSessionRef[]> = { ...current };
  for (const entry of persisted) {
    const source = `${RESTORE_PREFIX}${entry.termId}`;
    const existing = next[entry.wtPath] ?? [];
    const alreadyAttached = existing.some(
      (s) => attachedShellTermId(s.source) === entry.termId,
    );
    if (alreadyAttached) continue;
    if (existing.some((s) => s.source === source)) continue;
    next[entry.wtPath] = [{ agent: "shell", source }, ...existing];
  }
  return next;
}
