import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

export interface WatchOpts {
  /** ms of quiet after the last event before onChange fires. Default 300. */
  debounceMs?: number;
}

/**
 * Recursively watch a worktree directory and call `onChange` (debounced)
 * whenever a non-ignored file changes inside it. Returns an unsubscribe
 * function that stops the watcher and clears any pending debounce.
 *
 * Ignored paths (matched by literal path segment, so nested occurrences
 * also filter): `node_modules/`, `.supergit/`, `dist/`, `.vite/`.
 * `.supergit/` matters when the supergit workspace happens to live
 * inside a watched worktree (dogfooding) — the daemon itself writes
 * events.jsonl/attachments/terminal state there, which would otherwise
 * feed back into broadcast("change") and starve the daemon's shell-out
 * pool. `dist/` and `.vite/` cover the common dev-server rebuild cases.
 *
 * `.git/` gets fine-grained filtering rather than a blanket ignore:
 * `objects/`, `logs/`, `hooks/`, `info/`, `*.lock`, and `COMMIT_EDITMSG`
 * are chatty noise, but `HEAD`, `index`, `refs/**`, `packed-refs`, and
 * the state-transition files (`MERGE_HEAD`, `REBASE_HEAD`, `FETCH_HEAD`,
 * `ORIG_HEAD`, `CHERRY_PICK_HEAD`) are exactly the writes that mean the
 * worktree's `fileStatus` / `lastCommit` just changed. Letting those
 * through is what makes the dashboard refresh after a commit, branch
 * switch, or fetch.
 *
 * Single watcher per call. Uses `fs.watch({ recursive: true })` which
 * is native on macOS (FSEvents) and Node 20+ on Linux. Bun's fs.watch
 * is a drop-in wrapper around the same primitive.
 */
export function watchWorktree(
  path: string,
  onChange: () => void,
  opts: WatchOpts = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(path, { recursive: true }, (_event, filename) => {
      if (stopped) return;
      if (filename && shouldIgnore(filename)) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (stopped) return;
        onChange();
      }, debounceMs);
    });
  } catch {
    return () => {};
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".supergit",
  "dist",
  ".vite",
]);

// Files directly under `.git/` whose modification means worktree state
// the dashboard cares about just changed. `refs/` is handled as a
// prefix check below, not via this set.
const GIT_DIR_INTERESTING = new Set([
  "HEAD",
  "index",
  "packed-refs",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "FETCH_HEAD",
  "ORIG_HEAD",
]);

function shouldIgnore(filename: string): boolean {
  // `filename` is the path relative to the watched root. Normalise to
  // forward-slash segments so the check works on Windows too.
  const parts = filename.split(sep).flatMap((p) => p.split("/"));
  if (parts.some((p) => IGNORED_SEGMENTS.has(p))) return true;
  const gitIdx = parts.indexOf(".git");
  if (gitIdx === -1) return false;
  const inside = parts.slice(gitIdx + 1);
  if (inside.length === 0) return true;
  // git takes a `<name>.lock` for every write — index.lock, HEAD.lock,
  // refs/heads/main.lock — and unlinks it on commit. The "real" write
  // we want still fires separately, so drop the lock churn.
  const last = inside[inside.length - 1] ?? "";
  if (last.endsWith(".lock")) return true;
  const head = inside[0];
  if (head === "refs") return false;
  if (inside.length === 1 && GIT_DIR_INTERESTING.has(head)) return false;
  return true;
}
