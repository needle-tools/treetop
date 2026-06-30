/**
 * Pure NDJSON line parser for the /api/repos stream, extracted from
 * App.svelte; behavior pinned by App-characterization.test.ts.
 *
 * Nothing in here does I/O — the fetch/reader/decoder/buffer-split
 * shell stays in fetchReposNDJSON (App.svelte). This module owns only
 * the per-line JSON.parse + manifest→skeleton mapping + repo dispatch.
 */

/** Minimum repo shape required by the NDJSON parser.
 *
 * App.svelte's full Repo interface is a structural superset of this, so
 * values of type Repo satisfy NdjsonRepo without any cast.  The index
 * signature `[key: string]: unknown` lets callers treat the return value
 * as their own richer Repo type after a single `as Repo` at the call site
 * (or none, if the compiler can widen structurally). */
export interface NdjsonRepo {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  color?: string;
  daemonId?: string;
  worktrees: unknown[];
  remotes?: unknown[];
  /** True only on manifest skeletons — the repo's git fan-out hasn't
   *  streamed in yet. Lets the row renderer show a loading spinner
   *  instead of a misleading "no worktrees" badge (both states have
   *  worktrees: []). Enriched `repo` lines from the daemon never set
   *  it, so the upsert clears it once real data lands. */
  pending?: boolean;
  [key: string]: unknown;
}

export interface ParseNDJSONOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onManifest?: (skeletons: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onRepo?: (repo: any) => void;
  /** When set, each skeleton and repo gets `daemonId` injected so
   *  the caller can route API calls back to the right daemon. */
  daemonId?: string;
}

/**
 * Parse a batch of complete NDJSON lines from the /api/repos stream.
 *
 * - `manifest` message: maps `msg.repos` → skeleton NdjsonRepo[] (empty
 *   worktrees/remotes arrays, `pending: true`, order preserved, optional
 *   color forwarded, daemonId injected when provided) → calls `onManifest`.
 * - `repo` message: calls `onRepo(msg.repo)` (with daemonId injected).
 * - Malformed / JSON-parse-error lines are skipped silently.
 * - Unknown message types are ignored.
 *
 * Returns an array of every repo delivered via `repo` messages, in
 * delivery (completion) order — same as the `out` array that
 * fetchReposNDJSON accumulates.
 */
export function parseNDJSONLines(
  lines: string[],
  opts?: ParseNDJSONOpts,
): NdjsonRepo[] {
  const { onManifest, onRepo, daemonId } = opts ?? {};
  const out: NdjsonRepo[] = [];

  for (const line of lines) {
    if (!line.length) continue;
    // Per-line parse failures shouldn't kill the whole stream — drop the
    // bad line and keep going so a single corrupt entry can't blank the
    // dashboard.
    try {
      const msg = JSON.parse(line) as
        | {
            type: "manifest";
            repos: {
              id: string;
              path: string;
              name: string;
              addedAt: string;
              color?: string;
            }[];
          }
        | { type: "repo"; repo: NdjsonRepo };

      if (msg.type === "manifest" && Array.isArray(msg.repos)) {
        const skeletons: NdjsonRepo[] = msg.repos.map((m) => ({
          id: m.id,
          path: m.path,
          name: m.name,
          addedAt: m.addedAt,
          color: m.color,
          worktrees: [],
          remotes: [],
          pending: true,
          ...(daemonId ? { daemonId } : {}),
        }));
        onManifest?.(skeletons);
      } else if (msg.type === "repo" && msg.repo) {
        const repo = daemonId ? { ...msg.repo, daemonId } : msg.repo;
        out.push(repo);
        onRepo?.(repo);
      }
    } catch {
      // skip malformed line
    }
  }

  return out;
}
