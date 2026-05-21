import { test, expect, describe } from "bun:test";
import {
  formatActivityPrompt,
  shouldGenerate,
  type RepoActivity,
} from "../src/repo-summary";

/** Build a synthetic RepoActivity with N commits — handy for the
 *  clipping tests. */
function activity(overrides: Partial<RepoActivity> = {}): RepoActivity {
  return {
    repoName: "supergit",
    sinceHours: 24,
    branches: [{ name: "main", commitCount: 3 }],
    dirtyWorktrees: [],
    commits: [
      {
        sha: "2c7f8501a9b2e3f4",
        author: "Marcel",
        relTime: "3h ago",
        subject: "ollama summary",
        insertions: 180,
        deletions: 12,
        files: 4,
      },
    ],
    topFiles: [
      { path: "packages/daemon/src/server.ts", insertions: 120, deletions: 10 },
    ],
    ...overrides,
  };
}

describe("formatActivityPrompt", () => {
  test("renders repo name, branch summary, dirty count, commit list, top files", () => {
    const p = formatActivityPrompt(activity());
    expect(p).toContain("Repository: supergit");
    expect(p).toContain("Branches active in last 24h: main (3 commits)");
    expect(p).toContain("Dirty worktrees: 0");
    expect(p).toContain("2c7f850");
    expect(p).toContain("Marcel");
    expect(p).toContain("3h ago");
    expect(p).toContain("ollama summary");
    expect(p).toContain("+180 / -12 across 4 files");
    expect(p).toContain("packages/daemon/src/server.ts");
    expect(p).toContain("+120 / -10");
  });

  test("uses 7-char short sha consistently", () => {
    const p = formatActivityPrompt(activity());
    // Short sha is 7 chars of the input sha.
    expect(p).toContain("2c7f850");
    expect(p).not.toContain("2c7f8501a9b2e3f4");
  });

  test("clips commit list to 50 with an '… and N more' note", () => {
    const commits = Array.from({ length: 70 }, (_, i) => ({
      sha: `aa${i.toString().padStart(14, "0")}`,
      author: "Marcel",
      relTime: `${i}h ago`,
      subject: `commit ${i}`,
      insertions: 1,
      deletions: 0,
      files: 1,
    }));
    const p = formatActivityPrompt(activity({ commits }));
    // First 50 commits should appear; commit 50+ should not.
    expect(p).toContain("commit 0");
    expect(p).toContain("commit 49");
    expect(p).not.toContain("commit 50");
    expect(p).not.toContain("commit 69");
    expect(p).toContain("… and 20 more commits");
  });

  test("caps top files list at 10 entries", () => {
    const topFiles = Array.from({ length: 25 }, (_, i) => ({
      path: `file-${i}.ts`,
      insertions: 100 - i,
      deletions: 0,
    }));
    const p = formatActivityPrompt(activity({ topFiles }));
    expect(p).toContain("file-0.ts");
    expect(p).toContain("file-9.ts");
    expect(p).not.toContain("file-10.ts");
  });

  test("reports dirty worktrees with paths and counts", () => {
    const p = formatActivityPrompt(
      activity({
        dirtyWorktrees: [
          { path: "/repos/supergit/feat-xr", unstaged: 3, staged: 1 },
          { path: "/repos/supergit/feat-audio", unstaged: 2, staged: 0 },
        ],
      }),
    );
    expect(p).toContain("Dirty worktrees: 2");
    expect(p).toContain("feat-xr");
    expect(p).toContain("3 unstaged");
    expect(p).toContain("1 staged");
  });

  test("returns a sentinel string when there's nothing to summarise", () => {
    // No commits in the window AND no dirty worktrees → the route
    // detects this and skips the Ollama call.
    const p = formatActivityPrompt(
      activity({ commits: [], topFiles: [], branches: [], dirtyWorktrees: [] }),
    );
    expect(p).toBe("EMPTY");
  });

  test("treats commits as the meaningful signal — dirty alone is enough", () => {
    // A repo with no commits but uncommitted work is still worth a
    // summary ("you left 3 files unstaged in feat-xr"). Not empty.
    const p = formatActivityPrompt(
      activity({
        commits: [],
        topFiles: [],
        branches: [],
        dirtyWorktrees: [{ path: "/w/feat-xr", unstaged: 3, staged: 0 }],
      }),
    );
    expect(p).not.toBe("EMPTY");
    expect(p).toContain("feat-xr");
  });
});

describe("shouldGenerate", () => {
  test("returns 'missing' when no cache exists", () => {
    expect(shouldGenerate(null, "deadbeef", 8)).toBe("missing");
  });

  test("returns 'new-commits' when the cached sha is stale", () => {
    const reason = shouldGenerate(
      {
        lastSha: "oldsha",
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
        commitCount: 5,
      },
      "newsha",
      8,
    );
    expect(reason).toBe("new-commits");
  });

  test("does not call out 'new-commits' on a sha match even with zero commits", () => {
    // commitCount: 0 means "we summarised an empty window before."
    // The sha still matches HEAD, so there's nothing new — fresh.
    const reason = shouldGenerate(
      {
        lastSha: "samesha",
        generatedAt: new Date().toISOString(),
        commitCount: 0,
      },
      "samesha",
      8,
    );
    expect(reason).toBeNull();
  });

  test("returns 'stale-age' when the cache is older than maxAgeHours", () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3600_000).toISOString();
    const reason = shouldGenerate(
      { lastSha: "samesha", generatedAt: tenHoursAgo, commitCount: 3 },
      "samesha",
      8,
    );
    expect(reason).toBe("stale-age");
  });

  test("returns null when fresh and sha matches", () => {
    const reason = shouldGenerate(
      {
        lastSha: "samesha",
        generatedAt: new Date().toISOString(),
        commitCount: 3,
      },
      "samesha",
      8,
    );
    expect(reason).toBeNull();
  });

  test("'new-commits' wins over 'stale-age' when both apply", () => {
    // Old cache + sha differs → we report new-commits (the more
    // specific reason).
    const tenHoursAgo = new Date(Date.now() - 10 * 3600_000).toISOString();
    const reason = shouldGenerate(
      { lastSha: "old", generatedAt: tenHoursAgo, commitCount: 3 },
      "new",
      8,
    );
    expect(reason).toBe("new-commits");
  });
});
