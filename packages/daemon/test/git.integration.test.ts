/**
 * Real-git integration tests for git.ts. These spin up temporary repos with
 * actual `git` invocations so we catch divergence between `git worktree`
 * output format and our parser, which a pure unit test would miss.
 */

import { test, expect, describe } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { $ } from "bun";
import {
  listWorktrees,
  getWorktreeDetails,
  listCommits,
  getDiff,
  getFileDiff,
  createWorktree,
  removeWorktree,
  listBranches,
  checkoutBranch,
  listRemotes,
  resolveSubmoduleWorktreePaths,
  mainWorktreePathFor,
  pullFastForward,
  pushUpstream,
  getSelectedRemoteBranchStatus,
  type Worktree,
} from "../src/git";
import { stat } from "node:fs/promises";

// Hermetic git: these integration tests must not inherit the host's
// global/system git config. CI runners (and some dev machines) configure a
// credential-injecting `url.<token>@github.com/.insteadOf https://github.com/`
// so private clones work — but `git remote -v` then returns a token-laden URL
// (masked as `***` in Actions logs), breaking listRemotes' exact-match
// assertion. Disabling system config and pointing global config at a
// nonexistent file leaves only each temp repo's LOCAL config (identity +
// remotes) in play, which is exactly what these tests mean to exercise.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(
  tmpdir(),
  "supergit-tests-no-such-gitconfig",
);

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
    const wtParent = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-")),
    );
    const wtPath = join(wtParent, "feat");
    await $`git -C ${repo} worktree add ${wtPath} -b feat/audio -q`.quiet();

    const wts = await listWorktrees(repo);
    expect(wts).toHaveLength(2);
    const branches = wts.map((w) => w.branch).sort();
    expect(branches).toEqual(["feat/audio", "main"]);
  });

  test("mainWorktreePathFor maps both main and sibling worktree to the main path", async () => {
    const repo = await tempRepo();
    // From the main checkout → itself.
    expect(await mainWorktreePathFor(repo)).toBe(repo);

    // A sibling worktree (how supergit creates them) → still the main path.
    const wtParent = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-")),
    );
    const wtPath = join(wtParent, "feat");
    await $`git -C ${repo} worktree add ${wtPath} -b feat/x -q`.quiet();
    expect(await mainWorktreePathFor(wtPath)).toBe(repo);
  });

  test("mainWorktreePathFor returns null outside a git repo", async () => {
    const notARepo = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-notrepo-")),
    );
    expect(await mainWorktreePathFor(notARepo)).toBeNull();
  });

  test("returns a synthetic nonGit entry for a plain directory", async () => {
    // Lets the UI render terminals/agents in plain folders. The user can
    // `git init` later and the next refresh picks up the real worktrees.
    const notARepo = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-notrepo-")),
    );
    expect(await listWorktrees(notARepo)).toEqual([
      {
        path: notARepo,
        branch: "",
        head: "",
        bare: false,
        detached: false,
        nonGit: true,
      },
    ]);
  });

  test("returns empty array for a path that does not exist", async () => {
    const missing = join(
      tmpdir(),
      "supergit-missing-" + Date.now() + "-" + Math.random(),
    );
    expect(await listWorktrees(missing)).toEqual([]);
  });

  test("recognizes a folder as git after git init", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "supergit-init-")));
    const before = await listWorktrees(dir);
    expect(before[0]?.nonGit).toBe(true);

    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} config user.email test@example.com`.quiet();
    await $`git -C ${dir} config user.name TestUser`.quiet();
    await $`git -C ${dir} commit --allow-empty -m initial -q`.quiet();

    const after = await listWorktrees(dir);
    expect(after).toHaveLength(1);
    expect(after[0]?.nonGit).toBeUndefined();
    expect(after[0]?.branch).toBe("main");
  });
});

describe("listRemotes against real git", () => {
  test("returns [] for a plain non-git directory", async () => {
    const d = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-noremote-")),
    );
    expect(await listRemotes(d)).toEqual([]);
  });

  test("returns [] for a path that does not exist", async () => {
    const missing = join(
      tmpdir(),
      "supergit-missing-" + Date.now() + "-" + Math.random(),
    );
    expect(await listRemotes(missing)).toEqual([]);
  });

  test("returns [] for a fresh repo with no remote configured", async () => {
    const repo = await tempRepo();
    expect(await listRemotes(repo)).toEqual([]);
  });

  test("parses and enriches a single origin remote", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin https://github.com/foo/bar.git`.quiet();
    const remotes = await listRemotes(repo);
    expect(remotes).toEqual([
      {
        name: "origin",
        url: "https://github.com/foo/bar.git",
        webUrl: "https://github.com/foo/bar",
        provider: "github",
        host: "github.com",
      },
    ]);
  });

  test("returns multiple remotes (origin + upstream), deduped across fetch/push", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin git@gitlab.com:me/repo.git`.quiet();
    await $`git -C ${repo} remote add upstream https://github.com/them/repo.git`.quiet();
    const remotes = await listRemotes(repo);
    const names = remotes.map((r) => r.name).sort();
    expect(names).toEqual(["origin", "upstream"]);
    const origin = remotes.find((r) => r.name === "origin")!;
    expect(origin.provider).toBe("gitlab");
    expect(origin.webUrl).toBe("https://gitlab.com/me/repo");
    const upstream = remotes.find((r) => r.name === "upstream")!;
    expect(upstream.provider).toBe("github");
    expect(upstream.webUrl).toBe("https://github.com/them/repo");
  });
});

describe("getWorktreeDetails against real git", () => {
  test("reports clean workdir and last commit for a fresh repo", async () => {
    const repo = await tempRepo();
    const details = await getWorktreeDetails(repo);
    expect(details.fileStatus).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      submodules: 0,
      submoduleChanges: 0,
      dirtyLines: 0,
    });
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

  test("counts dirty lines for tracked changes", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "tracked.txt"), "v1\n");
    await $`git -C ${repo} add tracked.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    await writeFile(join(repo, "tracked.txt"), "v1\nv2\nv3\n");

    const details = await getWorktreeDetails(repo);
    expect(details.fileStatus.unstaged).toBe(1);
    expect(details.fileStatus.dirtyLines).toBe(2);
  });

  test("leaves dirty lines at zero for untracked-only changes", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "new.txt"), "v1\nv2\n");

    const details = await getWorktreeDetails(repo);
    expect(details.fileStatus.untracked).toBe(1);
    expect(details.fileStatus.dirtyLines).toBe(0);
  });

  // aheadOldestTime drives the "stale unpushed" pill in the UI. The
  // contract: when ahead > 0 and an upstream exists, it's the ISO
  // timestamp of the *oldest* local commit not on upstream (so the UI
  // can compute "N hours unpushed" from the moment the first one
  // landed). When ahead === 0 or there's no upstream, it's null.
  test("aheadOldestTime is null when in sync with upstream", async () => {
    const bare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-bare-")),
    );
    await $`git -C ${bare} init -q --bare -b main`.quiet();
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin ${bare}`.quiet();
    await $`git -C ${repo} push -u origin main -q`.quiet();
    const details = await getWorktreeDetails(repo);
    expect(details.branchStatus?.ahead).toBe(0);
    expect(details.branchStatus?.aheadOldestTime).toBeNull();
  });

  test("aheadOldestTime is null when there's no upstream", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} commit --allow-empty -m unpushed -q`.quiet();
    const details = await getWorktreeDetails(repo);
    expect(details.branchStatus?.upstream).toBeNull();
    expect(details.branchStatus?.aheadOldestTime).toBeNull();
  });

  test("aheadOldestTime is the OLDEST unpushed commit when ahead", async () => {
    const bare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-bare-")),
    );
    await $`git -C ${bare} init -q --bare -b main`.quiet();
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin ${bare}`.quiet();
    await $`git -C ${repo} push -u origin main -q`.quiet();

    // Two unpushed commits, date-pinned so we can assert exactly which
    // one's timestamp comes back. Use a non-zero TZ offset because git
    // canonicalises `+00:00` to `Z` on output. Older = the one whose
    // committer-date is earlier; that's the one the UI starts the
    // "N hours unpushed" countdown from.
    const olderDate = "2026-01-01T10:00:00+02:00";
    const newerDate = "2026-01-01T11:00:00+02:00";
    await $`git -C ${repo} commit --allow-empty -m older -q --date=${olderDate}`
      .env({
        ...process.env,
        GIT_COMMITTER_DATE: olderDate,
      })
      .quiet();
    await $`git -C ${repo} commit --allow-empty -m newer -q --date=${newerDate}`
      .env({
        ...process.env,
        GIT_COMMITTER_DATE: newerDate,
      })
      .quiet();

    const details = await getWorktreeDetails(repo);
    expect(details.branchStatus?.ahead).toBe(2);
    expect(details.branchStatus?.aheadOldestTime).toBe(
      "2026-01-01T10:00:00+02:00",
    );
  });

  // `unpushed` answers "how many commits exist nowhere on a remote" for
  // branches with NO upstream — git emits no ahead/behind for those, so
  // it's the only push-pressure signal. Counted via
  // `git rev-list --count HEAD --not --remotes`. Populated only when
  // there's no upstream; null otherwise (the UI uses `ahead` then).
  test("unpushed counts every commit when the repo has no remote at all", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} commit --allow-empty -m second -q`.quiet();
    const details = await getWorktreeDetails(repo);
    expect(details.branchStatus?.upstream).toBeNull();
    // initial + second — nothing is on any remote because none exists.
    expect(details.branchStatus?.unpushed).toBe(2);
  });

  test("unpushed counts only commits not on any remote-tracking ref", async () => {
    const bare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-bare-")),
    );
    await $`git -C ${bare} init -q --bare -b main`.quiet();
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin ${bare}`.quiet();
    await $`git -C ${repo} push origin main -q`.quiet();

    // A fresh branch tracking nothing: its commits aren't on origin/main,
    // but the commits it shares with main ARE (via the remote-tracking
    // ref), so only the new one counts.
    await $`git -C ${repo} checkout -q -b feature`.quiet();
    await $`git -C ${repo} commit --allow-empty -m feat -q`.quiet();
    const details = await getWorktreeDetails(repo);
    expect(details.branchStatus?.upstream).toBeNull();
    expect(details.branchStatus?.unpushed).toBe(1);
  });

  test("unpushed is null when the branch has an upstream", async () => {
    const bare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-bare-")),
    );
    await $`git -C ${bare} init -q --bare -b main`.quiet();
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin ${bare}`.quiet();
    await $`git -C ${repo} push -u origin main -q`.quiet();
    const details = await getWorktreeDetails(repo);
    expect(details.branchStatus?.upstream).toBe("origin/main");
    expect(details.branchStatus?.unpushed).toBeNull();
  });

  test("selected remote without a matching branch does not mask a worktree's configured upstream", async () => {
    const upstreamBare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-upstream-bare-")),
    );
    await $`git -C ${upstreamBare} init -q --bare -b main`.quiet();
    const repo = await tempRepo();
    await $`git -C ${repo} remote add origin ${upstreamBare}`.quiet();
    await $`git -C ${repo} push -u origin main -q`.quiet();

    const wtParent = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-upstream-")),
    );
    const wtPath = join(wtParent, "feature");
    await $`git -C ${repo} worktree add ${wtPath} -b feature -q`.quiet();
    await $`git -C ${wtPath} commit --allow-empty -m remote-feature -q`.quiet();
    await $`git -C ${wtPath} push -u origin feature -q`.quiet();
    await $`git -C ${wtPath} commit --allow-empty -m local-feature -q`.quiet();

    const otherBare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-other-bare-")),
    );
    await $`git -C ${otherBare} init -q --bare -b main`.quiet();
    await $`git -C ${repo} remote add upstream ${otherBare}`.quiet();
    await $`git -C ${repo} push -q upstream main`.quiet();

    const details = await getWorktreeDetails(wtPath, { remote: "upstream" });
    expect(details.branchStatus?.upstream).toBe("origin/feature");
    expect(details.branchStatus?.ahead).toBe(1);
    expect(details.branchStatus?.unpushed).toBeNull();
  });

  test("selected remote becomes the push target for a branch with no upstream", async () => {
    const bare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-origin-bare-")),
    );
    await $`git -C ${bare} init -q --bare -b main`.quiet();
    const repo = await tempRepo();
    await $`git -C ${repo} remote add needle ${bare}`.quiet();
    await $`git -C ${repo} push -q needle main`.quiet();

    await $`git -C ${repo} checkout -q -b experiment/local-only`.quiet();
    await $`git -C ${repo} commit --allow-empty -m local-only -q`.quiet();

    const details = await getWorktreeDetails(repo, { remote: "needle" });
    expect(details.branchStatus?.upstream).toBe("needle/experiment/local-only");
    expect(details.branchStatus?.ahead).toBe(1);
    expect(details.branchStatus?.behind).toBe(0);
    expect(details.branchStatus?.unpushed).toBeNull();
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
    expect(await listCommits(repo, { limit: 2 })).toHaveLength(2);
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

  test("renders untracked files as synthetic +new-file diffs (no legacy header)", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "new.txt"), "line1\nline2\n");
    const diff = await getDiff(repo);

    // No legacy "# untracked files" comment header — they now render
    // as proper diff blocks so the Unstaged tab reads as one unified list.
    expect(diff).not.toContain("# untracked files");

    // Standard `git diff --no-index /dev/null <file>` output shape:
    //   diff --git a/dev/null b/new.txt   (git's quirk for /dev/null vs file)
    //   new file mode …
    //   --- /dev/null
    //   +++ b/new.txt
    //   @@ -0,0 +1,2 @@
    //   +line1
    //   +line2
    expect(diff).toMatch(/diff --git .* b\/new\.txt/);
    expect(diff).toContain("new file mode");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/new.txt");
    expect(diff).toContain("+line1");
    expect(diff).toContain("+line2");
  });

  test("untracked + modified appear in the same diff payload", async () => {
    const repo = await tempRepo();
    // Existing committed file we'll modify.
    await writeFile(join(repo, "a.txt"), "v1\n");
    await $`git -C ${repo} add a.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    await writeFile(join(repo, "a.txt"), "v2\n");
    // Plus a brand-new untracked file.
    await writeFile(join(repo, "fresh.txt"), "hello\n");

    const diff = await getDiff(repo);
    // Both file paths are present, both as proper diff blocks.
    expect(diff).toContain("a.txt");
    expect(diff).toContain("-v1");
    expect(diff).toContain("+v2");
    expect(diff).toContain("fresh.txt");
    expect(diff).toContain("+hello");
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

  test("untracked embedded git repo is labelled as such (unregistered submodule)", async () => {
    // The real-world version: someone `git clone`-ed a dependency into
    // a subdirectory of their repo without `git submodule add`-ing it.
    // The inner `.git/` makes `git ls-files --others` treat the whole
    // dir as opaque; we surface it with a distinct label so the user
    // knows the fix is `git submodule add` or `.gitignore`, not `git add`.
    const repo = await tempRepo();
    const inner = join(repo, "modules", "lib");
    await mkdir(inner, { recursive: true });
    await $`git -C ${inner} init -q -b main`.quiet();
    await $`git -C ${inner} config user.email t@example.com`.quiet();
    await $`git -C ${inner} config user.name T`.quiet();
    await writeFile(join(inner, "README.md"), "hi\n");
    await $`git -C ${inner} add README.md`.quiet();
    await $`git -C ${inner} commit -m initial -q`.quiet();

    const diff = await getDiff(repo);
    expect(diff).toMatch(/diff --git a\/modules\/lib\/ b\/modules\/lib\//);
    expect(diff).toContain("new file mode 040000");
    expect(diff).toContain("untracked embedded git repo");
    expect(diff).toContain("git submodule add");
  });
});

describe("getFileDiff against real git", () => {
  test("workdir kind returns only the requested file's diff", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "v1\n");
    await writeFile(join(repo, "b.txt"), "v1\n");
    await $`git -C ${repo} add a.txt b.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    await writeFile(join(repo, "a.txt"), "v2\n");
    await writeFile(join(repo, "b.txt"), "v2\n");

    const diff = await getFileDiff(repo, "a.txt", "workdir");
    expect(diff).toContain("a.txt");
    expect(diff).toContain("-v1");
    expect(diff).toContain("+v2");
    // The other modified file must NOT leak into the per-file diff —
    // that's the whole point of the pathspec filter.
    expect(diff).not.toContain("b.txt");
  });

  test("staged kind returns the index diff for the requested file", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "hello\n");
    await $`git -C ${repo} add a.txt`.quiet();
    const diff = await getFileDiff(repo, "a.txt", "staged");
    expect(diff).toContain("a.txt");
    expect(diff).toContain("+hello");
  });

  test("staged kind ignores unstaged modifications on the same file", async () => {
    // Stage v1, then edit the workdir to v2. The staged diff must show
    // the v1 add (index vs HEAD) and *not* the v2 workdir change.
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "v1\n");
    await $`git -C ${repo} add a.txt`.quiet();
    await writeFile(join(repo, "a.txt"), "v2\n");
    const diff = await getFileDiff(repo, "a.txt", "staged");
    expect(diff).toContain("+v1");
    expect(diff).not.toContain("+v2");
  });

  test("untracked kind synthesises a new-file diff via --no-index", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "fresh.txt"), "hello\nworld\n");
    const diff = await getFileDiff(repo, "fresh.txt", "untracked");
    expect(diff).toMatch(/diff --git .* b\/fresh\.txt/);
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/fresh.txt");
    expect(diff).toContain("+hello");
    expect(diff).toContain("+world");
  });

  test("context=0 omits surrounding lines, only +/- remain in the hunk", async () => {
    // Default context for the per-file route is 0 — that's what the
    // hover popup uses to keep its footprint small. Verify the hunk
    // truly contains only the changed lines for a multi-line file.
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "line1\nline2\nline3\nline4\n");
    await $`git -C ${repo} add a.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    await writeFile(join(repo, "a.txt"), "line1\nCHANGED\nline3\nline4\n");

    const diff = await getFileDiff(repo, "a.txt", "workdir", 0);
    // The hunk body (everything after the first `@@ … @@`) must
    // contain only the -/+ pair for line 2 — no surrounding context.
    const hunkBody = diff
      .split(/^@@.*@@.*$/m)
      .slice(1)
      .join("\n");
    const bodyLines = hunkBody.split("\n").filter((l) => l.length > 0);
    expect(bodyLines).toEqual(["-line2", "+CHANGED"]);
  });

  test("returns empty string for a path with no changes", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, "a.txt"), "v1\n");
    await $`git -C ${repo} add a.txt`.quiet();
    await $`git -C ${repo} commit -m add -q`.quiet();
    // No edit — diff for this file should be empty.
    expect(await getFileDiff(repo, "a.txt", "workdir")).toBe("");
  });
});

describe("resolveSubmoduleWorktreePaths", () => {
  // Pure unit-style test: pass crafted worktree records and verify the
  // .git/modules path gets substituted with rev-parse --show-toplevel
  // for the registered repo path. No submodule fixture needed.
  test("substitutes .git/modules paths with the actual toplevel", async () => {
    const repo = await tempRepo();
    const fake: Worktree[] = [
      {
        path: join(repo, ".git", "modules", "some-submodule"),
        branch: "main",
        head: "deadbeef",
        bare: false,
        detached: false,
      },
    ];
    const fixed = await resolveSubmoduleWorktreePaths(repo, fake);
    expect(fixed[0]!.path).toBe(repo);
  });

  test("leaves non-submodule paths alone", async () => {
    const repo = await tempRepo();
    const ok: Worktree[] = [
      {
        path: repo,
        branch: "main",
        head: "abc",
        bare: false,
        detached: false,
      },
      {
        path: "/some/random/worktree",
        branch: "feat",
        head: "def",
        bare: false,
        detached: false,
      },
    ];
    const fixed = await resolveSubmoduleWorktreePaths(repo, ok);
    expect(fixed[0]!.path).toBe(repo);
    expect(fixed[1]!.path).toBe("/some/random/worktree");
  });

  test("end-to-end: a real submodule's listWorktrees no longer points at .git/modules", async () => {
    // Build a parent repo with a real submodule and verify our top-level
    // listWorktrees(submodulePath) returns the submodule's working
    // tree, not its gitdir under .git/modules.
    const parent = await tempRepo();
    const sub = await tempRepo();
    // Move the submodule contents into <parent>/sub/ via `git submodule add`.
    // Use file:// URL since the submodule is local on disk.
    await $`git -C ${parent} -c protocol.file.allow=always submodule add ${sub} sub`.quiet();
    await $`git -C ${parent} commit -q -m add-sub`.quiet();
    const submoduleWorkdir = join(parent, "sub");
    const list = await listWorktrees(submoduleWorkdir);
    // The reported path must NOT contain `.git/modules` — our resolver
    // should have flipped it to the real working tree.
    expect(list.length).toBeGreaterThan(0);
    for (const wt of list) {
      expect(wt.path).not.toMatch(/[/\\]\.git[/\\]modules[/\\]/);
      expect(wt.nonGit).toBeUndefined();
    }
    expect(list[0]!.path).toBe(submoduleWorkdir);
    expect(list[0]!.head.length).toBeGreaterThan(0);
  });
});

describe("createWorktree against real git", () => {
  test("creates a NEW branch when the requested branch doesn't exist", async () => {
    const repo = await tempRepo();
    const wtRoot = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-")),
    );
    const result = await createWorktree(repo, "fresh-branch", { wtRoot });
    expect(result.created).toBe(true);
    // The branch ref now exists.
    const ref = (
      await $`git -C ${repo} show-ref --verify --quiet refs/heads/fresh-branch`
        .quiet()
        .nothrow()
    ).exitCode;
    expect(ref).toBe(0);
  });

  test("reuses an EXISTING branch when one with that name already exists", async () => {
    const repo = await tempRepo();
    // Create the branch first via raw git, then ask createWorktree for
    // a worktree on the same name. Previously this would error out
    // with `a branch named '<x>' already exists`.
    await $`git -C ${repo} branch existing-branch`.quiet();
    const wtRoot = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-")),
    );
    const result = await createWorktree(repo, "existing-branch", { wtRoot });
    expect(result.created).toBe(false);
    expect(result.branch).toBe("existing-branch");
    // The new worktree should have existing-branch checked out.
    const wts = await listWorktrees(repo);
    const wt = wts.find((w) => w.path === result.path);
    expect(wt?.branch).toBe("existing-branch");
  });
});

describe("removeWorktree against real git", () => {
  test("clean removal deletes the directory and the .git slot", async () => {
    const repo = await tempRepo();
    const wtRoot = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-")),
    );
    const created = await createWorktree(repo, "feature-a", { wtRoot });

    // sanity: dir exists, listWorktrees sees it
    expect((await stat(created.path)).isDirectory()).toBe(true);
    expect(
      (await listWorktrees(repo)).some((w) => w.path === created.path),
    ).toBe(true);

    await removeWorktree(repo, created.path);

    // dir gone
    let dirGone = false;
    try {
      await stat(created.path);
    } catch {
      dirGone = true;
    }
    expect(dirGone).toBe(true);
    // listWorktrees no longer references it
    expect(
      (await listWorktrees(repo)).some((w) => w.path === created.path),
    ).toBe(false);
    // branch ref preserved
    const branches = (
      await $`git -C ${repo} branch --list feature-a`.quiet()
    ).stdout.toString();
    expect(branches).toContain("feature-a");
  });

  test("refuses to remove when the worktree has uncommitted changes", async () => {
    const repo = await tempRepo();
    const wtRoot = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-wt-")),
    );
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
    try {
      await stat(created.path);
    } catch {
      dirGone = true;
    }
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

  test("local branches are sorted by committer date (most recent first)", async () => {
    const repo = await tempRepo();
    // Make commits on three branches at distinct times so ordering is
    // unambiguous. Commit on each branch as separate operations and use
    // GIT_COMMITTER_DATE to fix the ordering deterministically.
    async function commitAt(branch: string, dateIso: string, file: string) {
      await $`git -C ${repo} checkout -q -b ${branch}`.quiet().nothrow();
      await writeFile(join(repo, file), `${branch}\n`);
      await $`git -C ${repo} add ${file}`.quiet();
      // Bun.$ doesn't expose an env-injection API on the tag itself,
      // so we use git's own env-var syntax via inline assignment in
      // the spawn args.
      const proc = Bun.spawn(
        ["git", "-C", repo, "commit", "-q", "-m", `on-${branch}`],
        {
          env: {
            ...process.env,
            GIT_COMMITTER_DATE: dateIso,
            GIT_AUTHOR_DATE: dateIso,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      await proc.exited;
      await $`git -C ${repo} checkout -q main`.quiet().nothrow();
    }
    await commitAt("oldest", "2026-01-01T00:00:00Z", "a.txt");
    await commitAt("middle", "2026-02-01T00:00:00Z", "b.txt");
    await commitAt("newest", "2026-03-01T00:00:00Z", "c.txt");

    const b = await listBranches(repo);
    // `main` could appear anywhere depending on when our initial commit
    // happened; just assert the three test branches are in the right
    // relative order.
    const idx = (name: string) => b.local.indexOf(name);
    expect(idx("newest")).toBeGreaterThanOrEqual(0);
    expect(idx("middle")).toBeGreaterThanOrEqual(0);
    expect(idx("oldest")).toBeGreaterThanOrEqual(0);
    expect(idx("newest")).toBeLessThan(idx("middle"));
    expect(idx("middle")).toBeLessThan(idx("oldest"));
  });

  test("returns current=null when HEAD is detached", async () => {
    const repo = await tempRepo();
    const head = (await $`git -C ${repo} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
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
    const head = (
      await $`git -C ${repo} symbolic-ref --short HEAD`.quiet()
    ).stdout
      .toString()
      .trim();
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
    const head = (
      await $`git -C ${repo} symbolic-ref --short HEAD`.quiet()
    ).stdout
      .toString()
      .trim();
    expect(head).toBe("main");
  });

  test("preStash=true stashes the dirty work, then checks out cleanly", async () => {
    const repo = await tempRepo();
    // Track a file first so the modification is detectable as dirty,
    // and create the branch FROM that commit so the file exists on
    // both branches.
    await writeFile(join(repo, "tracked.txt"), "v1\n");
    await $`git -C ${repo} add tracked.txt`.quiet();
    await $`git -C ${repo} commit -m add-tracked -q`.quiet();
    await $`git -C ${repo} branch feat-stash`.quiet();
    // Now make a modification — this is the dirty state.
    await writeFile(join(repo, "tracked.txt"), "v2-uncommitted\n");

    const result = await checkoutBranch(repo, "feat-stash", { preStash: true });
    expect(result.stashed).toBe(true);

    // On feat-stash, the file should be back to v1 (the committed version).
    const onDisk = (await $`cat ${join(repo, "tracked.txt")}`.quiet()).stdout
      .toString()
      .trim();
    expect(onDisk).toBe("v1");

    // The stash should be present with our recognizable supergit-auto tag.
    const stashList = (
      await $`git -C ${repo} stash list`.quiet()
    ).stdout.toString();
    expect(stashList).toContain("supergit-auto");
  });

  test("force=true checks out anyway when dirty (untracked file is preserved)", async () => {
    const repo = await tempRepo();
    await $`git -C ${repo} branch feat-z`.quiet();
    await writeFile(join(repo, "stray.txt"), "untracked\n");
    await checkoutBranch(repo, "feat-z", { force: true });
    const head = (
      await $`git -C ${repo} symbolic-ref --short HEAD`.quiet()
    ).stdout
      .toString()
      .trim();
    expect(head).toBe("feat-z");
  });
});

/**
 * Helper: spin up a bare "origin" + two clones (a, b). Both clones track
 * main. Returns the bare path and the two clone paths.
 */
async function tempRepoTrio(): Promise<{ bare: string; a: string; b: string }> {
  const bare = await realpath(
    await mkdtemp(join(tmpdir(), "supergit-pp-bare-")),
  );
  await $`git -C ${bare} init -q --bare -b main`.quiet();
  // Seed via a scratch repo so the bare has at least one commit on main.
  const seed = await tempRepo();
  await $`git -C ${seed} remote add origin ${bare}`.quiet();
  await $`git -C ${seed} push -u origin main -q`.quiet();
  // Clone twice so we have two independent worktrees pointing at the
  // same upstream — lets us simulate "remote has new commits."
  const aParent = await realpath(
    await mkdtemp(join(tmpdir(), "supergit-pp-a-")),
  );
  const bParent = await realpath(
    await mkdtemp(join(tmpdir(), "supergit-pp-b-")),
  );
  const a = join(aParent, "a");
  const b = join(bParent, "b");
  await $`git clone -q ${bare} ${a}`.quiet();
  await $`git clone -q ${bare} ${b}`.quiet();
  for (const p of [a, b]) {
    await $`git -C ${p} config user.email test@example.com`.quiet();
    await $`git -C ${p} config user.name TestUser`.quiet();
  }
  return { bare, a, b };
}

describe("pullFastForward against real git", () => {
  test("kind=up_to_date when nothing to pull", async () => {
    const { a } = await tempRepoTrio();
    const r = await pullFastForward(a);
    expect(r.kind).toBe("up_to_date");
    expect(r.ok).toBe(true);
  });

  test("kind=updated when upstream is strictly ahead (fast-forward)", async () => {
    const { a, b } = await tempRepoTrio();
    // b adds a commit, pushes; a should be able to fast-forward.
    await writeFile(join(b, "from-b.txt"), "hello\n");
    await $`git -C ${b} add from-b.txt`.quiet();
    await $`git -C ${b} commit -m from-b -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    // a needs to know about the new ref:
    await $`git -C ${a} fetch -q`.quiet();

    const r = await pullFastForward(a);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("updated");
    // file should now exist in a
    const exists = await stat(join(a, "from-b.txt"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("kind=diverged when local and remote both have unique commits", async () => {
    const { a, b } = await tempRepoTrio();
    // Both clones add commits without sharing.
    await writeFile(join(b, "from-b.txt"), "b\n");
    await $`git -C ${b} add from-b.txt`.quiet();
    await $`git -C ${b} commit -m from-b -q`.quiet();
    await $`git -C ${b} push -q`.quiet();

    await writeFile(join(a, "from-a.txt"), "a\n");
    await $`git -C ${a} add from-a.txt`.quiet();
    await $`git -C ${a} commit -m from-a -q`.quiet();
    await $`git -C ${a} fetch -q`.quiet();

    const r = await pullFastForward(a);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("diverged");
  });

  test("kind=dirty when local working tree has changes that would be clobbered", async () => {
    const { a, b } = await tempRepoTrio();
    // b modifies shared file
    await writeFile(join(b, "shared.txt"), "v1\n");
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v1 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    // a fetches but doesn't pull; then dirties the same file locally
    await $`git -C ${a} fetch -q`.quiet();
    await writeFile(join(a, "shared.txt"), "local-uncommitted\n");

    const r = await pullFastForward(a);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("dirty");
  });

  test("preStash=true on a dirty pull stashes then fast-forwards", async () => {
    const { a, b } = await tempRepoTrio();
    // Seed shared.txt in the bare so both clones already track it.
    await writeFile(join(b, "shared.txt"), "v0\n");
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v0 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    await $`git -C ${a} pull -q --ff-only`.quiet();

    // b updates shared.txt and pushes
    await writeFile(join(b, "shared.txt"), "v1\n");
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v1 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();

    // a fetches, then dirties shared.txt locally
    await $`git -C ${a} fetch -q`.quiet();
    await writeFile(join(a, "shared.txt"), "uncommitted-local\n");

    const r = await pullFastForward(a, { preStash: true });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("updated");
    expect(r.stashed).toBe(true);
    // Stash should exist with the recognizable supergit-auto tag.
    const stashList = (
      await $`git -C ${a} stash list`.quiet()
    ).stdout.toString();
    expect(stashList).toContain("supergit-auto");
  });

  test("preStash=true reapplies the stash after pulling when changes don't conflict", async () => {
    const { a, b } = await tempRepoTrio();
    // Seed a multi-line file so upstream and local edits can land in
    // non-overlapping regions (clean three-way pop).
    const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
    await writeFile(join(b, "shared.txt"), ten + "\n");
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v0 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    await $`git -C ${a} pull -q --ff-only`.quiet();

    // b edits the FIRST line, pushes.
    await writeFile(
      join(b, "shared.txt"),
      ten.replace("l1", "l1-from-upstream") + "\n",
    );
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v1 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();

    // a fetches, then dirties the LAST line locally (different region).
    await $`git -C ${a} fetch -q`.quiet();
    await writeFile(
      join(a, "shared.txt"),
      ten.replace("l10", "l10-local-uncommitted") + "\n",
    );

    const r = await pullFastForward(a, { preStash: true });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("updated");
    expect(r.stashed).toBe(true);
    expect(r.stashRestored).toBe(true);
    expect(r.stashConflict).toBeFalsy();

    // Working tree carries BOTH the upstream edit and the local edit.
    const onDisk = (
      await $`cat ${join(a, "shared.txt")}`.quiet()
    ).stdout.toString();
    expect(onDisk).toContain("l1-from-upstream");
    expect(onDisk).toContain("l10-local-uncommitted");

    // The auto-stash was popped — nothing left behind.
    const stashList = (
      await $`git -C ${a} stash list`.quiet()
    ).stdout.toString();
    expect(stashList).not.toContain("supergit-auto");
  });

  test("preStash=true keeps the stash when reapplying conflicts", async () => {
    const { a, b } = await tempRepoTrio();
    await writeFile(join(b, "shared.txt"), "v0\n");
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v0 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    await $`git -C ${a} pull -q --ff-only`.quiet();

    // b and a both touch the SAME line — popping the stash must conflict.
    await writeFile(join(b, "shared.txt"), "v1-upstream\n");
    await $`git -C ${b} add shared.txt`.quiet();
    await $`git -C ${b} commit -m v1 -q`.quiet();
    await $`git -C ${b} push -q`.quiet();

    await $`git -C ${a} fetch -q`.quiet();
    await writeFile(join(a, "shared.txt"), "v1-local-uncommitted\n");

    const r = await pullFastForward(a, { preStash: true });
    // The pull itself still succeeded — only the reapply hit a conflict.
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("updated");
    expect(r.stashed).toBe(true);
    expect(r.stashRestored).toBe(false);
    expect(r.stashConflict).toBe(true);

    // The stash is preserved so the user can recover their work.
    const stashList = (
      await $`git -C ${a} stash list`.quiet()
    ).stdout.toString();
    expect(stashList).toContain("supergit-auto");
  });

  test("uses the selected remote branch instead of the configured upstream", async () => {
    const { a, b } = await tempRepoTrio();
    const upstreamBare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-upstream-bare-")),
    );
    await $`git -C ${upstreamBare} init -q --bare -b main`.quiet();
    await $`git -C ${a} remote add upstream ${upstreamBare}`.quiet();
    await $`git -C ${a} push -q upstream main`.quiet();

    await writeFile(join(b, "origin-only.txt"), "origin\n");
    await $`git -C ${b} add origin-only.txt`.quiet();
    await $`git -C ${b} commit -m origin-only -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    await $`git -C ${a} fetch -q origin`.quiet();

    const originStatus = await getSelectedRemoteBranchStatus(a, "origin");
    const upstreamStatus = await getSelectedRemoteBranchStatus(a, "upstream");

    expect(originStatus?.upstream).toBe("origin/main");
    expect(originStatus?.behind).toBe(1);
    expect(upstreamStatus?.upstream).toBe("upstream/main");
    expect(upstreamStatus?.behind).toBe(0);
  });
});

describe("pushUpstream against real git", () => {
  test("returns ok when there's nothing to push", async () => {
    const { a } = await tempRepoTrio();
    const r = await pushUpstream(a);
    expect(r.ok).toBe(true);
  });

  test("pushes a new local commit to the upstream", async () => {
    const { a, bare } = await tempRepoTrio();
    await writeFile(join(a, "from-a.txt"), "a\n");
    await $`git -C ${a} add from-a.txt`.quiet();
    await $`git -C ${a} commit -m from-a -q`.quiet();

    const r = await pushUpstream(a);
    expect(r.ok).toBe(true);
    // The bare's main ref should now resolve to the same SHA as a's HEAD.
    const localHead = (await $`git -C ${a} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
    const remoteHead = (
      await $`git -C ${bare} rev-parse refs/heads/main`.quiet()
    ).stdout
      .toString()
      .trim();
    expect(remoteHead).toBe(localHead);
  });

  test("pushes to the selected remote instead of the configured upstream", async () => {
    const { a, bare } = await tempRepoTrio();
    const upstreamBare = await realpath(
      await mkdtemp(join(tmpdir(), "supergit-push-upstream-bare-")),
    );
    await $`git -C ${upstreamBare} init -q --bare -b main`.quiet();
    await $`git -C ${a} remote add upstream ${upstreamBare}`.quiet();
    await $`git -C ${a} push -q upstream main`.quiet();

    await writeFile(join(a, "to-upstream.txt"), "upstream\n");
    await $`git -C ${a} add to-upstream.txt`.quiet();
    await $`git -C ${a} commit -m to-upstream -q`.quiet();

    const r = await pushUpstream(a, { remote: "upstream" });
    expect(r.ok).toBe(true);
    const localHead = (await $`git -C ${a} rev-parse HEAD`.quiet()).stdout
      .toString()
      .trim();
    const upstreamHead = (
      await $`git -C ${upstreamBare} rev-parse refs/heads/main`.quiet()
    ).stdout
      .toString()
      .trim();
    const originHead = (
      await $`git -C ${bare} rev-parse refs/heads/main`.quiet()
    ).stdout
      .toString()
      .trim();
    expect(upstreamHead).toBe(localHead);
    expect(originHead).not.toBe(localHead);
  });

  test("fails (non-fast-forward) when remote has diverged", async () => {
    const { a, b } = await tempRepoTrio();
    // b moves origin/main forward
    await writeFile(join(b, "from-b.txt"), "b\n");
    await $`git -C ${b} add from-b.txt`.quiet();
    await $`git -C ${b} commit -m from-b -q`.quiet();
    await $`git -C ${b} push -q`.quiet();
    // a makes a competing local commit (no fetch so a doesn't know)
    await writeFile(join(a, "from-a.txt"), "a\n");
    await $`git -C ${a} add from-a.txt`.quiet();
    await $`git -C ${a} commit -m from-a -q`.quiet();

    const r = await pushUpstream(a);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected|non-fast-forward|fetch first/i);
  });
});
