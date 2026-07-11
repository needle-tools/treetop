import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

const FILE = "active-terminals.json";

export interface PersistedTerminal {
  termId: string;
  cmd: string[];
  cwd: string;
  wtPath: string;
  title?: string;
  /** First command the user typed (the session-defining command, e.g. ssh). */
  firstCmd?: string;
  /** Last command the user typed. */
  lastCmd?: string;
}

interface PersistFile {
  terminals: PersistedTerminal[];
}

/** Best-effort creation time (epoch ms) for a persisted terminal, derived from
 *  the termId. Every termId the daemon mints is `t_<base36(Date.now())>_<...>`
 *  (see the backend's id generator and resumePersistedTerminal), so the first
 *  segment decodes straight back to when the PTY was spawned. Returns null for
 *  any id that doesn't fit the shape — callers treat unknown-age entries as
 *  un-judgeable rather than guessing. */
export function terminalCreatedAt(termId: string): number | null {
  const m = /^t_([0-9a-z]+)_/.exec(termId);
  if (!m) return null;
  const ms = parseInt(m[1]!, 36);
  // Sanity-gate to a plausible epoch-ms window so a weird id can't masquerade
  // as "created in 1970" (which would nuke it) or the far future (immortal).
  if (!Number.isFinite(ms) || ms < 1_000_000_000_000 || ms > 4_000_000_000_000)
    return null;
  return ms;
}

/**
 * Bound the persisted-terminal set so it can't grow without limit.
 *
 * The file leaks on every daemon restart: a terminal is recorded when spawned
 * and only removed when its PTY exits *cleanly*, but a rebuild kills the helper
 * (and every PTY) with no daemon around to process the exits — so every
 * still-open terminal is stranded in the file forever. Over many rebuilds this
 * piles up into dozens/hundreds of dead "disconnected — Resume" cards.
 *
 * Two independent caps, applied on startup:
 *   - drop anything older than `maxAgeMs` (by termId-derived spawn time)
 *   - keep only the `maxEntries` most-recent of what remains
 * Unknown-age entries are never age-dropped (we can't judge them) but still
 * count against `maxEntries`, sorted last so real recent terminals win a slot.
 *
 * Pure; preserves the surviving entries' original file order.
 */
export function prunePersistedTerminals(
  entries: readonly PersistedTerminal[],
  opts: { now: number; maxAgeMs: number; maxEntries: number },
): PersistedTerminal[] {
  const withMeta = entries.map((e, i) => ({
    e,
    i,
    t: terminalCreatedAt(e.termId),
  }));
  const fresh = withMeta.filter(
    ({ t }) => t === null || opts.now - t <= opts.maxAgeMs,
  );
  const keep = [...fresh]
    .sort((a, b) => {
      if (a.t !== null && b.t !== null) return b.t - a.t; // newest first
      if (a.t !== null) return -1; // known-age ranks above unknown
      if (b.t !== null) return 1;
      return b.i - a.i; // both unknown: later in file = more recent
    })
    .slice(0, Math.max(0, opts.maxEntries));
  const keepIds = new Set(keep.map(({ e }) => e.termId));
  return entries.filter((e) => keepIds.has(e.termId));
}

export class TerminalPersist {
  private dir: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(workspacePath: string) {
    this.dir = workspacePath;
  }

  async list(): Promise<PersistedTerminal[]> {
    try {
      const raw = await readFile(join(this.dir, FILE), "utf-8");
      const parsed = JSON.parse(raw) as PersistFile;
      return parsed.terminals ?? [];
    } catch {
      return [];
    }
  }

  async save(entry: PersistedTerminal): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.list();
      const filtered = existing.filter((t) => t.termId !== entry.termId);
      filtered.push(entry);
      await this.write({ terminals: filtered });
    });
  }

  async remove(termId: string): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.list();
      const filtered = existing.filter((t) => t.termId !== termId);
      if (filtered.length === existing.length) return;
      await this.write({ terminals: filtered });
    });
  }

  async updateLastCmd(termId: string, lastCmd: string): Promise<void> {
    await this.withLock(async () => {
      const existing = await this.list();
      const entry = existing.find((t) => t.termId === termId);
      if (!entry) return;
      if (!entry.firstCmd) entry.firstCmd = lastCmd;
      entry.lastCmd = lastCmd;
      await this.write({ terminals: existing });
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await this.write({ terminals: [] });
    });
  }

  /** Trim the file to `prunePersistedTerminals`' bounds. Returns how many
   *  entries were dropped (0 if nothing changed). Call once at startup. */
  async prune(opts: {
    now: number;
    maxAgeMs: number;
    maxEntries: number;
  }): Promise<number> {
    let removed = 0;
    await this.withLock(async () => {
      const existing = await this.list();
      const kept = prunePersistedTerminals(existing, opts);
      if (kept.length !== existing.length) {
        await this.write({ terminals: kept });
        removed = existing.length - kept.length;
      }
    });
    return removed;
  }

  private async write(data: PersistFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const dst = join(this.dir, FILE);
    const tmp = `${dst}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    try {
      await rename(tmp, dst);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  private async withLock(fn: () => Promise<void>): Promise<void> {
    const prev = this.writeLock;
    this.writeLock = prev.then(fn, fn);
    await this.writeLock;
  }
}
