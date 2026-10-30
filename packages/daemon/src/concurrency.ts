/**
 * A tiny promise-concurrency limiter (pLimit-style, no dependency).
 *
 * `/api/repos` enrich fans out git work across every repo/worktree at once.
 * On a cold cache (e.g. right after a daemon restart) that's a thundering
 * herd: dozens-to-hundreds of concurrent git spawns + large output buffers,
 * which spiked daemon RSS into the GBs and stalled the single event loop
 * long enough to starve PTY spawns. Routing cold git ops through one shared
 * limiter caps the peak while keeping throughput high.
 */

/**
 * Returns a `limit(fn)` that runs at most `maxConcurrent` tasks at once;
 * the rest queue and start as slots free. Each call resolves/rejects with
 * its own task's outcome, and a rejected task still releases its slot.
 */
export function createLimiter(
  maxConcurrent: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = (): void => {
    if (active >= maxConcurrent) return;
    const start = queue.shift();
    if (!start) return;
    active++;
    start();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}

/** Background reads and network fetches must not consume interactive slots. */
export function createGitWorkScheduler() {
  const inventory = createLimiter(2),
    reads = createLimiter(2),
    lineCounts = createLimiter(1),
    fetches = createLimiter(1),
    interactive = createLimiter(1),
    branches = createLimiter(2),
    queries = createLimiter(2);
  const onDemand = new Set([
    "readGitText", "listSubmoduleDetails", "mainWorktreePathFor", "listBranches",
    "getUpstreamRemoteName", "listCommits", "getDiffFileContent", "getFileDiff",
    "getCommitDiff", "listCommitFiles", "getCommitFileDiff", "getDiff",
  ]);
  return <T>(
    operation: string,
    fresh: boolean,
    task: () => Promise<T>,
  ): Promise<T> =>
    (operation === "getSelectedRemoteBranchStatus"
      ? branches
      : onDemand.has(operation)
      ? queries
      : fresh
      ? interactive
      : operation === "fetchAll"
        ? fetches
        : operation === "getDirtyLineCount"
          ? lineCounts
          : operation === "listWorktrees" || operation === "listRemotes"
            ? inventory
            : reads)(task);
}
