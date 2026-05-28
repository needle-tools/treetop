import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import {
  parseWorktreeList,
  parseFileStatus,
  parseBranchStatus,
  parseLastCommit,
  parseCommitList,
  parseChangedFiles,
  parseNumstat,
  parseShortstatLines,
  parseUnpushedCommits,
  parseRemoteUrl,
  parseRemotesOutput,
  parseUpstreamRemote,
  pickRemoteUrlForShare,
  isLockError,
  runGitWithLockRetry,
} from "../src/git";
import type { RemoteRef } from "../src/git";

const NUL = String.fromCharCode(0);

describe("isLockError", () => {
  test("matches git's index.lock 'File exists' error", () => {
    const stderr =
      "error: Unable to create '/Users/x/repo/.git/index.lock': File exists.\n" +
      "Another git process seems to be running in this repository, e.g. an editor opened by 'git commit'.";
    expect(isLockError(stderr)).toBe(true);
  });

  test("matches a bare 'Another git process seems to be running' message", () => {
    expect(isLockError("Another git process seems to be running")).toBe(true);
  });

  test("matches a shallow.lock / packed-refs.lock too", () => {
    expect(
      isLockError(
        "fatal: Unable to create '/r/.git/shallow.lock': File exists",
      ),
    ).toBe(true);
  });

  test("does not match unrelated failures", () => {
    expect(isLockError("fatal: Not possible to fast-forward, aborting.")).toBe(
      false,
    );
    expect(isLockError("Authentication failed for 'https://...'")).toBe(false);
    expect(isLockError("")).toBe(false);
  });
});

describe("runGitWithLockRetry", () => {
  const lock = () => ({
    exitCode: 128,
    stdout: Buffer.from(""),
    stderr: Buffer.from(
      "error: Unable to create '/r/.git/index.lock': File exists.\n" +
        "Another git process seems to be running in this repository",
    ),
  });
  const ok = () => ({
    exitCode: 0,
    stdout: Buffer.from("Updating 46dc9d8..54c4e79\n"),
    stderr: Buffer.from(""),
  });
  const otherFail = () => ({
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from("fatal: Not possible to fast-forward, aborting."),
  });

  test("retries exactly once on a lock error and returns the second result", async () => {
    let calls = 0;
    const r = await runGitWithLockRetry(() => {
      calls++;
      return Promise.resolve(calls === 1 ? lock() : ok());
    }, 0);
    expect(calls).toBe(2);
    expect(r.exitCode).toBe(0);
  });

  test("does not retry when the first attempt succeeds", async () => {
    let calls = 0;
    const r = await runGitWithLockRetry(() => {
      calls++;
      return Promise.resolve(ok());
    }, 0);
    expect(calls).toBe(1);
    expect(r.exitCode).toBe(0);
  });

  test("does not retry on a non-lock failure", async () => {
    let calls = 0;
    const r = await runGitWithLockRetry(() => {
      calls++;
      return Promise.resolve(otherFail());
    }, 0);
    expect(calls).toBe(1);
    expect(r.exitCode).toBe(1);
  });

  test("retries only once even if the lock persists", async () => {
    let calls = 0;
    const r = await runGitWithLockRetry(() => {
      calls++;
      return Promise.resolve(lock());
    }, 0);
    expect(calls).toBe(2);
    expect(r.exitCode).toBe(128);
  });
});

describe("parseWorktreeList", () => {
  test("returns empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  test("parses a single worktree on a branch", () => {
    const input = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main
`;
    expect(parseWorktreeList(input)).toEqual([
      {
        path: resolve("/home/user/repo"),
        branch: "main",
        head: "abc123",
        bare: false,
        detached: false,
      },
    ]);
  });

  test("parses multiple worktrees separated by blank lines", () => {
    const input = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/wt/feat
HEAD def456
branch refs/heads/feat/audio
`;
    const result = parseWorktreeList(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.branch).toBe("main");
    expect(result[1]?.branch).toBe("feat/audio");
    expect(result[1]?.path).toBe(resolve("/home/user/wt/feat"));
  });

  test("parses a detached worktree (no branch, detached flag)", () => {
    const input = `worktree /home/user/repo
HEAD abc123
detached
`;
    const result = parseWorktreeList(input);
    expect(result[0]?.detached).toBe(true);
    expect(result[0]?.branch).toBe("");
  });

  test("parses a bare worktree", () => {
    const input = `worktree /home/user/bare.git
bare
`;
    const result = parseWorktreeList(input);
    expect(result[0]?.bare).toBe(true);
  });

  test("strips the refs/heads/ prefix from branch names", () => {
    const input = `worktree /a
HEAD x
branch refs/heads/feat/nested/name
`;
    expect(parseWorktreeList(input)[0]?.branch).toBe("feat/nested/name");
  });
});

describe("parseFileStatus", () => {
  test("empty porcelain returns all zeros", () => {
    expect(parseFileStatus("")).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      submodules: 0,
      submoduleChanges: 0,
      dirtyLines: 0,
    });
  });

  test("counts untracked files", () => {
    const input = `? foo.txt
? bar.ts
`;
    expect(parseFileStatus(input).untracked).toBe(2);
  });

  test("counts staged modification (X column = M, Y column = .)", () => {
    const input = `1 M. N... 100644 100644 100644 abc def src/foo.ts
`;
    const s = parseFileStatus(input);
    expect(s.staged).toBe(1);
    expect(s.unstaged).toBe(0);
  });

  test("counts unstaged modification (X column = ., Y column = M)", () => {
    const input = `1 .M N... 100644 100644 100644 abc def src/foo.ts
`;
    const s = parseFileStatus(input);
    expect(s.staged).toBe(0);
    expect(s.unstaged).toBe(1);
  });

  test("counts a file that is both staged and unstaged (MM)", () => {
    const input = `1 MM N... 100644 100644 100644 abc def src/foo.ts
`;
    const s = parseFileStatus(input);
    expect(s.staged).toBe(1);
    expect(s.unstaged).toBe(1);
  });

  test("counts unmerged entries on both sides", () => {
    const input = `u UU N... 100644 100644 100644 100644 a b c d src/foo.ts
`;
    const s = parseFileStatus(input);
    expect(s.staged).toBe(1);
    expect(s.unstaged).toBe(1);
  });

  test("ignores branch header lines", () => {
    const input = `# branch.oid abc
# branch.head main
`;
    expect(parseFileStatus(input)).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
      submodules: 0,
      submoduleChanges: 0,
      dirtyLines: 0,
    });
  });

  test("submodule with only internal dirt (sub commit-changed = '.') counts as submodule, not unstaged", () => {
    // S.MU = submodule, parent commit unchanged, has internal modifications & untracked.
    // XY=.M reflects the submodule-internal dirt; the parent itself didn't change.
    const input = `1 .M S.MU 160000 160000 160000 abc abc modules/car-physics
`;
    const s = parseFileStatus(input);
    expect(s.unstaged).toBe(0);
    expect(s.untracked).toBe(0);
    expect(s.submodules).toBe(1);
    // Also surfaced via submoduleChanges so the dock can ignore it.
    expect(s.submoduleChanges).toBe(1);
  });

  test("submodule with parent commit change (sub commit-changed = 'C') still counts as unstaged", () => {
    // SC.. = submodule, parent's recorded SHA moved. That's a real parent-level change.
    const input = `1 .M SC.. 160000 160000 160000 abc def modules/face-filter
`;
    const s = parseFileStatus(input);
    expect(s.unstaged).toBe(1);
    expect(s.submodules).toBe(0);
    // The pointer-bump still counts as submodule activity for callers
    // (like the dock) that want to ignore submodules entirely.
    expect(s.submoduleChanges).toBe(1);
  });

  test("submodule with both commit change and internal dirt counts as unstaged (commit change wins)", () => {
    const input = `1 .M SCMU 160000 160000 160000 abc def modules/needle-engine
`;
    const s = parseFileStatus(input);
    expect(s.unstaged).toBe(1);
    expect(s.submodules).toBe(0);
    expect(s.submoduleChanges).toBe(1);
  });

  test("mixed: regular unstaged file plus internal-only submodule", () => {
    const input = `1 .M N... 100644 100644 100644 abc def src/foo.ts
1 .M S.MU 160000 160000 160000 abc abc modules/car-physics
`;
    const s = parseFileStatus(input);
    expect(s.unstaged).toBe(1);
    expect(s.submodules).toBe(1);
    // Only the submodule row contributes to submoduleChanges; the
    // regular file does not.
    expect(s.submoduleChanges).toBe(1);
  });
});

describe("parseShortstatLines", () => {
  test("empty string returns 0", () => {
    expect(parseShortstatLines("")).toBe(0);
  });
  test("insertions only", () => {
    expect(parseShortstatLines(" 3 files changed, 45 insertions(+)\n")).toBe(
      45,
    );
  });
  test("deletions only", () => {
    expect(parseShortstatLines(" 1 file changed, 12 deletions(-)\n")).toBe(12);
  });
  test("both insertions and deletions", () => {
    expect(
      parseShortstatLines(
        " 5 files changed, 100 insertions(+), 50 deletions(-)\n",
      ),
    ).toBe(150);
  });
});

describe("parseBranchStatus", () => {
  test("returns null when no branch.head present", () => {
    expect(parseBranchStatus("")).toBeNull();
  });

  test("parses branch, upstream, ahead, behind", () => {
    const input = `# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
`;
    expect(parseBranchStatus(input)).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      // aheadOldestTime is filled in by getWorktreeDetails after a
      // separate `git log` call; the porcelain parser always returns
      // null. See git.integration.test.ts for the populated-value
      // contract.
      aheadOldestTime: null,
    });
  });

  test("returns zeros for ahead/behind when no upstream", () => {
    const input = `# branch.oid abc
# branch.head main
`;
    expect(parseBranchStatus(input)).toEqual({
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      aheadOldestTime: null,
    });
  });
});

describe("parseLastCommit", () => {
  test("returns null for empty output", () => {
    expect(parseLastCommit("")).toBeNull();
  });

  test("returns null for malformed output", () => {
    expect(parseLastCommit("notenough")).toBeNull();
  });

  test("parses NUL-separated fields and derives shortSha", () => {
    const NUL = " ";
    const input = `abcdef0123456789${NUL}Fix the bug${NUL}Marcel${NUL}2026-05-12T01:23:45Z`;
    const r = parseLastCommit(input);
    expect(r?.sha).toBe("abcdef0123456789");
    expect(r?.shortSha).toBe("abcdef0");
    expect(r?.subject).toBe("Fix the bug");
    expect(r?.author).toBe("Marcel");
    expect(r?.time).toBe("2026-05-12T01:23:45Z");
  });
});

describe("parseChangedFiles", () => {
  test("empty input → empty buckets", () => {
    expect(parseChangedFiles("")).toEqual({
      staged: [],
      unstaged: [],
      untracked: [],
    });
  });

  test("sorts the basic XY codes into the right buckets", () => {
    const input =
      [
        "M  src/staged-only.ts",
        " M src/unstaged-only.ts",
        "MM src/both.ts",
        "A  src/added.ts",
        "?? src/new-file.ts",
      ].join("\n") + "\n";
    const r = parseChangedFiles(input);
    expect(r.staged).toEqual([
      "src/staged-only.ts",
      "src/both.ts",
      "src/added.ts",
    ]);
    expect(r.unstaged).toEqual(["src/unstaged-only.ts", "src/both.ts"]);
    expect(r.untracked).toEqual(["src/new-file.ts"]);
  });

  test("renames show the new path, not 'new -> old'", () => {
    // `git status --porcelain` prints "R  new -> old" for staged
    // renames. The tooltip wants the destination — that's what the
    // user thinks of as "the file that changed".
    const input = "R  src/renamed-to.ts -> src/renamed-from.ts\n";
    const r = parseChangedFiles(input);
    expect(r.staged).toEqual(["src/renamed-to.ts"]);
    expect(r.unstaged).toEqual([]);
  });

  test("copies are treated the same as renames", () => {
    const input = "C  src/copy.ts -> src/orig.ts\n";
    const r = parseChangedFiles(input);
    expect(r.staged).toEqual(["src/copy.ts"]);
  });

  test("tolerates paths with spaces (they extend to end-of-line)", () => {
    const input = " M src/has a space.ts\n";
    expect(parseChangedFiles(input).unstaged).toEqual(["src/has a space.ts"]);
  });

  test("ignores blank lines and short malformed lines", () => {
    const input = "\n\nM  src/ok.ts\nX\n";
    const r = parseChangedFiles(input);
    expect(r.staged).toEqual(["src/ok.ts"]);
    expect(r.unstaged).toEqual([]);
  });

  test("ignored entries (!!) are dropped, not surfaced as staged/unstaged", () => {
    const input = "!! build/output.js\nM  src/ok.ts\n";
    const r = parseChangedFiles(input);
    expect(r.staged).toEqual(["src/ok.ts"]);
    expect(r.unstaged).toEqual([]);
    expect(r.untracked).toEqual([]);
  });
});

describe("parseUnpushedCommits", () => {
  test("empty input → []", () => {
    expect(parseUnpushedCommits("")).toEqual([]);
  });

  test("NUL-separated sha/subject/author/date is parsed verbatim", () => {
    // The daemon uses `--pretty=format:%H<NUL>%s<NUL>%an<NUL>%ar` so
    // subjects/authors/dates with arbitrary whitespace round-trip.
    const input = [
      `abcdef0123456789abcdef0123456789abcdef01${NUL}Fix the audio bug${NUL}Ada Lovelace${NUL}2 hours ago`,
      `1234567890abcdef1234567890abcdef12345678${NUL}Refactor: extract helper${NUL}Grace Hopper${NUL}3 days ago`,
    ].join("\n");
    expect(parseUnpushedCommits(input)).toEqual([
      {
        sha: "abcdef0123456789abcdef0123456789abcdef01",
        subject: "Fix the audio bug",
        author: "Ada Lovelace",
        date: "2 hours ago",
      },
      {
        sha: "1234567890abcdef1234567890abcdef12345678",
        subject: "Refactor: extract helper",
        author: "Grace Hopper",
        date: "3 days ago",
      },
    ]);
  });

  test("subjects with spaces and punctuation round-trip verbatim", () => {
    const input = `abc1234abc1234abc1234abc1234abc1234abc12${NUL}fix(parser): handle  multiple   spaces — and em-dash${NUL}Donald Knuth${NUL}5 minutes ago`;
    expect(parseUnpushedCommits(input)).toEqual([
      {
        sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        subject: "fix(parser): handle  multiple   spaces — and em-dash",
        author: "Donald Knuth",
        date: "5 minutes ago",
      },
    ]);
  });

  test("missing trailing fields default to empty strings", () => {
    // git emits %an and %ar but a sufficiently broken environment can
    // still hand us truncated input; we don't want to crash.
    const input = `abc1234abc1234abc1234abc1234abc1234abc12${NUL}only subject`;
    expect(parseUnpushedCommits(input)).toEqual([
      {
        sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        subject: "only subject",
        author: "",
        date: "",
      },
    ]);
  });

  test("legacy space-separated lines (no NUL) still parse", () => {
    // Backwards-compat: an older format that emitted "%H %s" still
    // round-trips with empty author/date so a partial deploy doesn't
    // blow up the UI.
    const input =
      "abc1234abc1234abc1234abc1234abc1234abc12 still works without NUL";
    expect(parseUnpushedCommits(input)).toEqual([
      {
        sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        subject: "still works without NUL",
        author: "",
        date: "",
      },
    ]);
  });

  test("drops blank lines without misattributing", () => {
    const input = `\nabc1234abc1234abc1234abc1234abc1234abc12${NUL}one${NUL}A${NUL}now\n\n1234567812345678123456781234567812345678${NUL}two${NUL}B${NUL}yesterday\n`;
    expect(parseUnpushedCommits(input)).toEqual([
      {
        sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        subject: "one",
        author: "A",
        date: "now",
      },
      {
        sha: "1234567812345678123456781234567812345678",
        subject: "two",
        author: "B",
        date: "yesterday",
      },
    ]);
  });
});

describe("parseRemoteUrl", () => {
  test("returns null fields for an empty / unparseable input", () => {
    expect(parseRemoteUrl("")).toEqual({
      webUrl: null,
      provider: null,
      host: null,
    });
    expect(parseRemoteUrl("   ")).toEqual({
      webUrl: null,
      provider: null,
      host: null,
    });
    expect(parseRemoteUrl("not a url at all")).toEqual({
      webUrl: null,
      provider: null,
      host: null,
    });
  });

  test("https GitHub URL strips .git", () => {
    expect(parseRemoteUrl("https://github.com/user/repo.git")).toEqual({
      webUrl: "https://github.com/user/repo",
      provider: "github",
      host: "github.com",
    });
  });

  test("https GitHub URL without .git", () => {
    expect(parseRemoteUrl("https://github.com/user/repo")).toEqual({
      webUrl: "https://github.com/user/repo",
      provider: "github",
      host: "github.com",
    });
  });

  test("scp-style git@github URL", () => {
    expect(parseRemoteUrl("git@github.com:user/repo.git")).toEqual({
      webUrl: "https://github.com/user/repo",
      provider: "github",
      host: "github.com",
    });
  });

  test("ssh:// URL with user", () => {
    expect(parseRemoteUrl("ssh://git@github.com/user/repo.git")).toEqual({
      webUrl: "https://github.com/user/repo",
      provider: "github",
      host: "github.com",
    });
  });

  test("ssh:// URL with explicit port", () => {
    expect(parseRemoteUrl("ssh://git@github.com:22/user/repo.git")).toEqual({
      webUrl: "https://github.com/user/repo",
      provider: "github",
      host: "github.com",
    });
  });

  test("git:// URL", () => {
    expect(parseRemoteUrl("git://github.com/user/repo.git")).toEqual({
      webUrl: "https://github.com/user/repo",
      provider: "github",
      host: "github.com",
    });
  });

  test("nested GitLab groups", () => {
    expect(parseRemoteUrl("https://gitlab.com/group/sub/repo.git")).toEqual({
      webUrl: "https://gitlab.com/group/sub/repo",
      provider: "gitlab",
      host: "gitlab.com",
    });
  });

  test("Bitbucket scp-style", () => {
    expect(parseRemoteUrl("git@bitbucket.org:team/repo.git")).toEqual({
      webUrl: "https://bitbucket.org/team/repo",
      provider: "bitbucket",
      host: "bitbucket.org",
    });
  });

  test("self-hosted gitea host pattern", () => {
    const r = parseRemoteUrl("git@gitea.example.com:user/repo.git");
    expect(r.provider).toBe("gitea");
    expect(r.host).toBe("gitea.example.com");
    expect(r.webUrl).toBe("https://gitea.example.com/user/repo");
  });

  test("codeberg", () => {
    expect(parseRemoteUrl("https://codeberg.org/user/repo.git").provider).toBe(
      "codeberg",
    );
  });

  test("sourcehut", () => {
    expect(parseRemoteUrl("git@git.sr.ht:~user/repo").provider).toBe(
      "sourcehut",
    );
  });

  test("Azure DevOps SSH v3 form rewrites to dev.azure.com/_git/", () => {
    expect(parseRemoteUrl("git@ssh.dev.azure.com:v3/org/proj/repo")).toEqual({
      webUrl: "https://dev.azure.com/org/proj/_git/repo",
      provider: "azure",
      host: "ssh.dev.azure.com",
    });
  });

  test("unknown provider falls back to https of host/path", () => {
    expect(parseRemoteUrl("git@code.example.com:user/repo.git")).toEqual({
      webUrl: "https://code.example.com/user/repo",
      provider: null,
      host: "code.example.com",
    });
  });

  test("strips trailing slashes", () => {
    expect(parseRemoteUrl("https://github.com/user/repo/").webUrl).toBe(
      "https://github.com/user/repo",
    );
  });
});

describe("parseRemotesOutput", () => {
  test("empty input returns []", () => {
    expect(parseRemotesOutput("")).toEqual([]);
  });

  test("dedupes fetch+push pairs per remote name, keeps fetch URL", () => {
    const input = `origin\thttps://github.com/u/r.git (fetch)
origin\thttps://github.com/u/r.git (push)
upstream\tgit@github.com:other/r.git (fetch)
upstream\tgit@github.com:other/r.git (push)`;
    expect(parseRemotesOutput(input)).toEqual([
      { name: "origin", url: "https://github.com/u/r.git" },
      { name: "upstream", url: "git@github.com:other/r.git" },
    ]);
  });

  test("skips malformed lines", () => {
    const input = `garbage
origin\thttps://x.com/r.git (fetch)
also bad
`;
    expect(parseRemotesOutput(input)).toEqual([
      { name: "origin", url: "https://x.com/r.git" },
    ]);
  });

  test("preserves the order remotes appear in", () => {
    const input = `b\thttps://x/b.git (fetch)
b\thttps://x/b.git (push)
a\thttps://x/a.git (fetch)
a\thttps://x/a.git (push)`;
    expect(parseRemotesOutput(input).map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("parseUpstreamRemote", () => {
  test("empty input returns null", () => {
    expect(parseUpstreamRemote("")).toBeNull();
    expect(parseUpstreamRemote("   ")).toBeNull();
    expect(parseUpstreamRemote("\n")).toBeNull();
  });

  test("extracts the remote name from origin/main", () => {
    expect(parseUpstreamRemote("origin/main\n")).toBe("origin");
  });

  test("extracts the remote name from a named upstream (not origin)", () => {
    // The whole point of this helper — fork workflow with both
    // origin (your fork) and upstream (canonical). The branch tracks
    // upstream, so the share manifest needs upstream's URL.
    expect(parseUpstreamRemote("upstream/main\n")).toBe("upstream");
  });

  test("handles branch names that contain slashes", () => {
    // `feat/audio` is a single branch name; only the first slash
    // separates the remote.
    expect(parseUpstreamRemote("origin/feat/audio\n")).toBe("origin");
  });

  test("ignores trailing whitespace and extra lines", () => {
    expect(parseUpstreamRemote("origin/main   \n\n")).toBe("origin");
  });

  test("returns null when there is no slash (malformed)", () => {
    expect(parseUpstreamRemote("mainOnly\n")).toBeNull();
  });

  test("returns null when the line starts with a slash", () => {
    expect(parseUpstreamRemote("/main\n")).toBeNull();
  });
});

describe("pickRemoteUrlForShare", () => {
  const ref = (name: string, url: string): RemoteRef => ({
    name,
    url,
    webUrl: null,
    provider: null,
    host: null,
  });

  test("no remotes → null", () => {
    expect(pickRemoteUrlForShare([], "origin")).toBeNull();
    expect(pickRemoteUrlForShare([], null)).toBeNull();
  });

  test("single remote → that remote's URL (regardless of upstream)", () => {
    const remotes = [ref("origin", "https://x/r.git")];
    expect(pickRemoteUrlForShare(remotes, "origin")).toBe("https://x/r.git");
    expect(pickRemoteUrlForShare(remotes, null)).toBe("https://x/r.git");
  });

  test("multi-remote: picks the remote the branch tracks, not the first", () => {
    // The bug we're fixing — fork checkout where `origin = my fork`
    // and `upstream = canonical`. Branch tracks `upstream`; manifest
    // must carry upstream's URL or the receiver clones the wrong
    // repo.
    const remotes = [
      ref("origin", "https://github.com/me/fork.git"),
      ref("upstream", "https://github.com/canonical/repo.git"),
    ];
    expect(pickRemoteUrlForShare(remotes, "upstream")).toBe(
      "https://github.com/canonical/repo.git",
    );
  });

  test("multi-remote, branch tracks first-listed remote → returns that one", () => {
    const remotes = [
      ref("origin", "https://github.com/me/fork.git"),
      ref("upstream", "https://github.com/canonical/repo.git"),
    ];
    expect(pickRemoteUrlForShare(remotes, "origin")).toBe(
      "https://github.com/me/fork.git",
    );
  });

  test("upstream is null (detached HEAD / no upstream) → first remote", () => {
    const remotes = [
      ref("origin", "https://github.com/me/fork.git"),
      ref("upstream", "https://github.com/canonical/repo.git"),
    ];
    expect(pickRemoteUrlForShare(remotes, null)).toBe(
      "https://github.com/me/fork.git",
    );
  });

  test("upstream names a remote that doesn't exist → first remote", () => {
    // Defensive: git config can record a tracking remote that was
    // since deleted from `git remote -v`. Don't crash — fall back.
    const remotes = [
      ref("origin", "https://github.com/me/fork.git"),
      ref("upstream", "https://github.com/canonical/repo.git"),
    ];
    expect(pickRemoteUrlForShare(remotes, "ghost")).toBe(
      "https://github.com/me/fork.git",
    );
  });
});

describe("parseNumstat", () => {
  test("returns empty for empty input", () => {
    expect(parseNumstat("")).toEqual({});
  });

  test("parses added/removed/path tab-separated lines", () => {
    const input = `3\t1\tsrc/foo.ts
12\t0\tsrc/bar.ts
0\t7\tsrc/gone.ts
`;
    expect(parseNumstat(input)).toEqual({
      "src/foo.ts": { added: 3, removed: 1, binary: false },
      "src/bar.ts": { added: 12, removed: 0, binary: false },
      "src/gone.ts": { added: 0, removed: 7, binary: false },
    });
  });

  test("flags binary files (-\\t-) without throwing", () => {
    const input = `-\t-\tassets/logo.png
5\t2\tsrc/foo.ts
`;
    expect(parseNumstat(input)).toEqual({
      "assets/logo.png": { added: 0, removed: 0, binary: true },
      "src/foo.ts": { added: 5, removed: 2, binary: false },
    });
  });

  test("preserves paths with spaces", () => {
    const input = `2\t3\tdir with space/file name.ts\n`;
    expect(parseNumstat(input)).toEqual({
      "dir with space/file name.ts": { added: 2, removed: 3, binary: false },
    });
  });

  test("skips malformed lines", () => {
    const input = `garbage
not-a-number\tx\tpath
4\t1\tok.ts
`;
    expect(parseNumstat(input)).toEqual({
      "ok.ts": { added: 4, removed: 1, binary: false },
    });
  });
});
