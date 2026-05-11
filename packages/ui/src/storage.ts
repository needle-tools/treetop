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
