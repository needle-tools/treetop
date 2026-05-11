/**
 * Real-git integration tests for git.ts. These spin up temporary repos with
 * actual `git` invocations so we catch divergence between `git worktree`
 * output format and our parser, which a pure unit test would miss.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { listWorktrees, getWorktreeDetails, listCommits, getDiff } from "../src/git";

async function tempRepo(): Promise<string> {
  // realpath resolves macOS's /var -> /private/var symlink so the path
  // matches what `git worktree list` reports.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "supergit-git-")));
  await $`git -C ${dir} init -q -b main`.quiet();
  await $`git -C ${dir} config user.email test@example.com`.quiet();
  await $`git -C ${dir} config user.name TestUser`.quiet();
  await $`git -C ${dir} commit --allow-empty -m initial -q`.quiet();
  return dir;
}

describe("listWorktrees against real git", () => {
  test("returns the main worktree for a fresh repo", async () => {
    const repo = await tempRepo();
    const wts = await listWorktrees(repo);
    expect(wts).toHaveLength(1);
    expect(wts[0]?.path).toBe(repo);
    expect(wts[0]?.branch).toBe("main");
    expect(wts[0]?.detached).toBe(false);
  });

  test("picks up an additional worktree on a new branch", async () => {
    const repo = await tempRepo();
    const wtParent = await realpath(await mkdtemp(join(tmpdir(), "supergit-wt-")));
    const wtPath = join(wtParent, "feat");
    await $`git -C ${repo} worktree add ${wtPath} -b feat/audio -q`.quiet();

    const wts = await listWorktrees(repo);
    expect(wts).toHaveLength(2);
    const branches = wts.map((w) => w.branch).sort();
    expect(branches).toEqual(["feat/audio", "main"]);
  });

  test("returns empty array for a non-git directory", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "supergit-notrepo-"));
    expect(await listWorktrees(notARepo)).toEqual([]);
  });
});

describe("getWorktreeDetails against real git", () => {
  test("reports clean workdir and last commit for a fresh repo", async () => {
    const repo = await tempRepo();
    const details = await getWorktreeDetails(repo);
    expect(details.fileStatus).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    expect(details.branchStatus?.branch).toBe("main");
    expect(details.lastCommit?.subject).toBe("initial");
  });

  test("counts untracked files", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "new.txt"), "hello");
    const details = await getWorktreeDetails(repo);
    expect(details.fileStatus.untracked).toBe(1);
  });

  test("counts unstaged modifications", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "tracked.txt"), "v1");
    await $`git -C ${repo} add tracked.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    await writeFile(join(repo, "tracked.txt"), "v2");
    const details = await getWorktreeDetails(repo);
    expect(details.fileStatus.unstaged).toBe(1);
    expect(details.fileStatus.staged).toBe(0);
  });
});

describe("listCommits against real git", () => {
  test("returns commits in newest-first order", async () => {
    const repo = await tempRepo();
    for (const msg of ["second", "third"]) {
      await $`git -C ${repo} commit --allow-empty -m ${msg} -q`.quiet();
    }
    const commits = await listCommits(repo, { limit: 10 });
    expect(commits.map((c) => c.subject)).toEqual([
      "third",
      "second",
      "initial",
    ]);
  });

  test("respects the limit option", async () => {
    const repo = await tempRepo();
    for (const msg of ["a", "b", "c", "d"]) {
      await $`git -C ${repo} commit --allow-empty -m ${msg} -q`.quiet();
    }
    expect((await listCommits(repo, { limit: 2 }))).toHaveLength(2);
  });

  test("paginates with the `before` option", async () => {
    const repo = await tempRepo();
    for (const msg of ["a", "b", "c"]) {
      await $`git -C ${repo} commit --allow-empty -m ${msg} -q`.quiet();
    }
    const first = await listCommits(repo, { limit: 2 });
    expect(first.map((c) => c.subject)).toEqual(["c", "b"]);
    const next = await listCommits(repo, { limit: 5, before: first[1]!.sha });
    expect(next.map((c) => c.subject)).toEqual(["a", "initial"]);
  });
});

describe("getDiff against real git", () => {
  test("empty string when nothing has changed", async () => {
    const repo = await tempRepo();
    expect(await getDiff(repo)).toBe("");
  });

  test("includes a section listing untracked files", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "new.txt"), "hi");
    const diff = await getDiff(repo);
    expect(diff).toContain("# untracked files");
    expect(diff).toContain("new.txt");
  });

  test("workdir diff shows unstaged modifications", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "v1\n");
    await $`git -C ${repo} add a.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    await writeFile(join(repo, "a.txt"), "v2\n");
    const diff = await getDiff(repo, "workdir");
    expect(diff).toContain("a.txt");
    expect(diff).toContain("-v1");
    expect(diff).toContain("+v2");
  });

  test("staged diff shows index vs HEAD only", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "v1\n");
    await $`git -C ${repo} add a.txt`.quiet();
    const diff = await getDiff(repo, "staged");
    expect(diff).toContain("a.txt");
    expect(diff).toContain("+v1");
  });
});
