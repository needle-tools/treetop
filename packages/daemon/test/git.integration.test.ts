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
import {
  listWorktrees,
  getWorktreeDetails,
  listCommits,
  getDiff,
  createWorktree,
  removeWorktree,
  listBranches,
  checkoutBranch,
} from "../src/git";
import { stat } from "node:fs/promises";

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

describe("removeWorktree against real git", () => {
  test("clean removal deletes the directory and the .git slot", async () => {
    const repo = await tempRepo();
    const wtRoot = await realpath(await mkdtemp(join(tmpdir(), "supergit-wt-")));
    const created = await createWorktree(repo, "feature-a", { wtRoot });

    // sanity: dir exists, listWorktrees sees it
    expect((await stat(created.path)).isDirectory()).toBe(true);
    expect((await listWorktrees(repo)).some((w) => w.path === created.path)).toBe(true);

    await removeWorktree(repo, created.path);

    // dir gone
    let dirGone = false;
    try { await stat(created.path); } catch { dirGone = true; }
    expect(dirGone).toBe(true);
    // listWorktrees no longer references it
    expect((await listWorktrees(repo)).some((w) => w.path === created.path)).toBe(false);
    // branch ref preserved
    const branches = (await $`git -C ${repo} branch --list feature-a`.quiet()).stdout.toString();
    expect(branches).toContain("feature-a");
  });

  test("refuses to remove when the worktree has uncommitted changes", async () => {
    const repo = await tempRepo();
    const wtRoot = await realpath(await mkdtemp(join(tmpdir(), "supergit-wt-")));
    const created = await createWorktree(repo, "dirty-branch", { wtRoot });
    await writeFile(join(created.path, "dirty.txt"), "uncommitted\n");

    let thrown: Error | null = null;
    try {
      await removeWorktree(repo, created.path);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // worktree still exists
    expect((await stat(created.path)).isDirectory()).toBe(true);

    // force=true overrides
    await removeWorktree(repo, created.path, { force: true });
    let dirGone = false;
    try { await stat(created.path); } catch { dirGone = true; }
    expect(dirGone).toBe(true);
  });
});

describe("listBranches against real git", () => {
  test("reports current branch + local refs in a fresh repo", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} branch feature-a`.quiet();
    await $`git -C ${repo} branch feature-b`.quiet();
    const b = await listBranches(repo);
    expect(b.current).toBe("main");
    expect(b.local.sort()).toEqual(["feature-a", "feature-b", "main"]);
    expect(b.remote).toEqual([]);
  });

  test("returns current=null when HEAD is detached", async () => {
    const repo = await tempRepo();
    const head = (await $`git -C ${repo} rev-parse HEAD`.quiet()).stdout.toString().trim();
    await $`git -C ${repo} checkout --detach ${head}`.quiet().nothrow();
    const b = await listBranches(repo);
    expect(b.current).toBeNull();
  });
});

describe("checkoutBranch against real git", () => {
  test("checks out an existing branch in a clean worktree", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} branch feat-x`.quiet();
    await checkoutBranch(repo, "feat-x");
    const head = (await $`git -C ${repo} symbolic-ref --short HEAD`.quiet()).stdout.toString().trim();
    expect(head).toBe("feat-x");
  });

  test("refuses to checkout when the worktree is dirty", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} branch feat-y`.quiet();
    await writeFile(join(repo, "dirty.txt"), "uncommitted\n");
    let thrown: Error | null = null;
    try {
      await checkoutBranch(repo, "feat-y");
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    // still on main
    const head = (await $`git -C ${repo} symbolic-ref --short HEAD`.quiet()).stdout.toString().trim();
    expect(head).toBe("main");
  });

  test("force=true checks out anyway when dirty (untracked file is preserved)", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} branch feat-z`.quiet();
    await writeFile(join(repo, "stray.txt"), "untracked\n");
    await checkoutBranch(repo, "feat-z", { force: true });
    const head = (await $`git -C ${repo} symbolic-ref --short HEAD`.quiet()).stdout.toString().trim();
    expect(head).toBe("feat-z");
  });
});
