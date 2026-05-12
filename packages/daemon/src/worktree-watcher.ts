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
 * also filter): `node_modules/`, `.git/`, `.supergit/`, `dist/`,
 * `.vite/`. `.supergit/` matters when the supergit workspace happens
 * to live inside a watched worktree (dogfooding) — the daemon itself
 * writes events.jsonl/attachments/terminal state there, which would
 * otherwise feed back into broadcast("change") and starve the daemon's
 * shell-out pool. `dist/` and `.vite/` cover the common dev-server
 * rebuild cases.
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
      if (filename && shouldIgnore(filename)) return;
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
  ".git",
  ".supergit",
  "dist",
  ".vite",
]);

function shouldIgnore(filename: string): boolean {
  // `filename` is the path relative to the watched root. Normalise to
  // forward-slash segments so the check works on Windows too.
  const parts = filename.split(sep).flatMap((p) => p.split("/"));
  return parts.some((p) => IGNORED_SEGMENTS.has(p));
}
