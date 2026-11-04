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
  let foregroundRequests = 0;
  let resumeBackground: (() => void) | undefined;
  let backgroundReady = Promise.resolve();
  function holdBackground() {
    if (foregroundRequests++ === 0) {
      backgroundReady = new Promise<void>(resolve => { resumeBackground = resolve; });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--foregroundRequests === 0) resumeBackground?.();
    };
  }
  const inventory = createLimiter(2),
    reads = createLimiter(2),
    lineCounts = createLimiter(1),
    fetches = createLimiter(1),
    interactive = createLimiter(1),
    branches = createLimiter(2),
    queries = createLimiter(2),
    statuses = createLimiter(1),
    parentStatuses = createLimiter(1);
  const onDemand = new Set([
    "readGitText", "listSubmoduleDetails", "mainWorktreePathFor", "listBranches",
    "getUpstreamRemoteName", "listCommits", "getDiffFileContent", "getFileDiff",
    "getCommitDiff", "listCommitFiles", "getCommitFileDiff", "getDiff",
  ]);
  const lanes = { inventory, reads, lineCounts, fetches, interactive, branches, queries, statuses, parentStatuses };
  const counts = Object.fromEntries(Object.keys(lanes).map(lane => [lane, { active: 0, queued: 0 }]));
  const schedule = <T>(
    operation: string,
    fresh: boolean,
    task: () => Promise<T>,
    onStart?: (state: { lane: string; active: number; queued: number }) => void,
  ): Promise<T> => {
    const lane = fresh && (operation === "listWorktrees" || operation === "listRemotes")
      ? "interactive"
      : operation === "readParentWorktreeStatus"
      ? "parentStatuses"
      : operation === "readWorktreeStatus"
      ? "statuses"
      : operation === "getSelectedRemoteBranchStatus"
      ? "branches"
      : onDemand.has(operation)
      ? "queries"
      : fresh
      ? "interactive"
      : operation === "fetchAll"
        ? "fetches"
        : operation === "getDirtyLineCount"
          ? "lineCounts"
          : operation === "listWorktrees" || operation === "listRemotes"
            ? "inventory"
            : "reads";
    const state = counts[lane];
    state.queued++;
    return lanes[lane](async () => {
      // Yield new speculative processes to explicit launches. Existing Git
      // processes and interactive reads keep running; no sessions are reaped.
      if (["inventory", "reads", "lineCounts", "fetches"].includes(lane)) {
        while (foregroundRequests > 0) await backgroundReady;
      }
      state.queued--;
      state.active++;
      try {
        onStart?.({ lane, ...state });
        return await task();
      } finally {
        state.active--;
      }
    });
  };
  return Object.assign(schedule, {
    holdBackground,
    snapshot: () => Object.fromEntries(Object.entries(counts).map(([lane, state]) => [lane, { ...state }])),
  });
}
