import { $ } from "bun";
import { access } from "node:fs/promises";
import { join as joinPath, resolve as resolvePath } from "node:path";

const PUSH_PULL_TIMEOUT_MS = 60_000;

/** Delay before retrying a git op that failed on a stale `*.lock` file.
 *  Short enough that the user doesn't notice, long enough that a
 *  concurrent git process (another agent, an editor, our own background
 *  fetch) has usually finished and released the lock. */
const LOCK_RETRY_DELAY_MS = 350;

/** True when git failed because a `.git/*.lock` file already existed —
 *  the classic "Unable to create '…/index.lock': File exists. Another git
 *  process seems to be running" error. This is almost always transient:
 *  two git processes (multiple agents, an editor, our own background
 *  fetch) raced for the same lock. Retrying once usually clears it. */
export function isLockError(text: string): boolean {
  return (
    /Unable to create '[^']*\.lock': File exists/i.test(text) ||
    /Another git process seems to be running/i.test(text)
  );
}

interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Run a git command via `run`; if it fails with a transient lock error
 *  (see {@link isLockError}), wait `delayMs` and retry exactly once.
 *  `run` is a thunk so the retry re-spawns the command from scratch. */
export async function runGitWithLockRetry<T extends GitResult>(
  run: () => Promise<T>,
  delayMs: number = LOCK_RETRY_DELAY_MS,
): Promise<T> {
  const r = await run();
  if (r.exitCode === 0) return r;
  if (!isLockError(`${r.stdout.toString()}${r.stderr.toString()}`)) return r;
  if (delayMs > 0) await Bun.sleep(delayMs);
  return run();
}

function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: Timer;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

/** Best-effort filesystem existence check. Returns false on any error so
 *  callers can use it as a pure boolean test. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  detached: boolean;
  /** True when the path is a plain directory with no git repo. The branch,
   *  head, and status fields are empty/null; git operations are not valid. */
  nonGit?: boolean;
}

export interface FileStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  /** Submodule entries whose only "dirt" is *inside* the submodule —
   *  the parent's recorded SHA hasn't moved. Reported separately so
   *  the parent doesn't look dirty just because a registered child
   *  has its own uncommitted edits. When the parent's recorded SHA
   *  HAS moved (sub field's commit-changed flag is 'C'), the entry
   *  counts toward staged/unstaged like any other file. */
  submodules: number;
  /** Count of *every* tracked entry whose sub-field starts with `S`
   *  — i.e. any submodule activity, whether the parent's recorded
   *  SHA moved or only the child's working tree drifted. Overlaps
   *  with `submodules` (those rows also count here) and additionally
   *  captures the pointer-bump case that gets folded into
   *  staged/unstaged. Surfaces as a "subtract me to ignore
   *  submodules" knob (e.g. SessionDock uses it to gate the dock
   *  dirty signal without losing the row-level badge for pointer
   *  bumps). */
  submoduleChanges: number;
  /** Total insertions + deletions across staged + unstaged diffs. */
  dirtyLines: number;
}

export interface BranchStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** ISO timestamp of the oldest commit on local that isn't on upstream.
   *  Null when ahead === 0 or when there's no upstream / the lookup
   *  failed. The UI uses this to age the unpushed-commits pill so it
   *  reads more urgently after a threshold. */
  aheadOldestTime: string | null;
  /** Commits reachable from HEAD but from no remote-tracking ref
   *  (`git rev-list --count HEAD --not --remotes`). A branch with no
   *  upstream gets no `branch.ab` line from git, so `ahead` is 0 and
   *  there's no push-pressure signal — this fills that gap by answering
   *  "how many commits exist nowhere on a remote." Populated only when
   *  `upstream === null` (the UI uses `ahead` otherwise); null when an
   *  upstream exists, the lookup failed, or the value came straight from
   *  the porcelain parser. */
  unpushed: number | null;
}

export interface LastCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  time: string; // ISO
  parents?: number;
  refs?: string[];
}

export interface WorktreeDetails {
  fileStatus: FileStatus;
  branchStatus: BranchStatus | null;
  lastCommit: LastCommit | null;
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const normalRepo = resolvePath(repoPath);
  try {
    const result = await $`git -C ${repoPath} worktree list --porcelain`
      .quiet()
      .text();
    const worktrees = parseWorktreeList(result);
    // Guard: git -C walks upward, so a plain dir inside a parent repo
    // succeeds but returns the PARENT's worktree. Reject when the
    // returned root isn't the path we asked about — BUT allow
    // submodules through: their worktree path points at
    // .git/modules/… which resolveSubmoduleWorktreePaths will fix.
    if (worktrees.length > 0 && worktrees[0]!.path !== normalRepo) {
      const isSubmoduleGitdir = /[/\\]\.git[/\\]/.test(worktrees[0]!.path);
      if (!isSubmoduleGitdir) {
        if (await fileExists(repoPath)) {
          return [
            {
              path: normalRepo,
              branch: "",
              head: "",
              bare: false,
              detached: false,
              nonGit: true,
            },
          ];
        }
        return [];
      }
    }
    return resolveSubmoduleWorktreePaths(repoPath, worktrees);
  } catch {
    // Path exists on disk but isn't a git repo — return a synthetic entry so
    // the UI can still open terminals/agents there.
    if (await fileExists(repoPath)) {
      return [
        {
          path: normalRepo,
          branch: "",
          head: "",
          bare: false,
          detached: false,
          nonGit: true,
        },
      ];
    }
    return [];
  }
}

/**
 * `git worktree list --porcelain` reports the **gitdir** for submodules,
 * not the actual working-tree directory. That gitdir lives somewhere
 * like `<parent-repo>/.git/modules/<submodule-name>/` — opening it in
 * Finder/VSCode/Terminal exposes git's internal database instead of
 * the user's source files. For each worktree whose path is inside a
 * `.git/` tree, substitute the real working-tree root by asking git
 * itself via `rev-parse --show-toplevel`, anchored at the user's
 * registered repo path (which IS in the working tree).
 *
 * Non-submodule worktrees pass through unchanged.
 */
export async function resolveSubmoduleWorktreePaths(
  repoPath: string,
  worktrees: Worktree[],
): Promise<Worktree[]> {
  const gitDirPattern = /[/\\]\.git[/\\]/;
  const needsFix = worktrees.some((w) => gitDirPattern.test(w.path));
  if (!needsFix) return worktrees;
  let toplevel: string | null = null;
  try {
    const r = await $`git -C ${repoPath} rev-parse --show-toplevel`
      .quiet()
      .nothrow();
    if (r.exitCode === 0) {
      const out = r.stdout.toString().trim();
      if (out.length > 0) toplevel = resolvePath(out);
    }
  } catch {
    // best effort — leave paths as-is if rev-parse fails
  }
  if (!toplevel) return worktrees;
  return worktrees.map((w) =>
    gitDirPattern.test(w.path) ? { ...w, path: toplevel! } : w,
  );
}

/**
 * Resolve any working directory (a main checkout OR a linked worktree,
 * which supergit creates as a sibling via `git worktree add ../foo`) to
 * its repo's MAIN worktree path — i.e. the path the user registered in
 * repos.json. Uses `rev-parse --git-common-dir`, whose parent is the
 * main worktree:
 *   - from the main worktree it returns `.git`        → resolves to <cwd>
 *   - from a linked worktree it returns `<main>/.git` → resolves to <main>
 * Returns null if `cwd` isn't inside a git repo. Used to map a TUI's cwd
 * back to its repo (and thus its accent colour) for the user-box tint.
 */
export async function mainWorktreePathFor(cwd: string): Promise<string | null> {
  try {
    const r = await $`git -C ${cwd} rev-parse --git-common-dir`
      .quiet()
      .nothrow();
    if (r.exitCode !== 0) return null;
    const raw = r.stdout.toString().trim();
    if (!raw) return null;
    const gitDir = resolvePath(cwd, raw); // absolute path to `…/.git`
    // Parent of the common `.git` dir is the main worktree.
    return resolvePath(gitDir, "..");
  } catch {
    return null;
  }
}

/**
 * Run `git fetch --all --prune --quiet` for a repo. Network failures, missing
 * remotes, auth prompts that would block — all silently treated as no-ops.
 * Returns true if fetch ran cleanly, false otherwise.
 */
export interface CreatedWorktree {
  path: string;
  branch: string;
}

function sanitizeBranchForPath(branch: string): string {
  // Replace slashes (`feat/audio`) with `-` for the on-disk dirname so we
  // don't accidentally nest dirs under feat/.
  return branch.replace(/[\/\\]/g, "-");
}

/**
 * Create a new worktree for `repoPath` on a new branch named `branch`.
 * Defaults to `~/wt/<repoBasename>/<sanitizedBranch>` for the worktree path,
 * which matches the convention in PLAN.md.
 */
export async function branchExists(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const r =
    await $`git -C ${repoPath} show-ref --verify --quiet refs/heads/${branch}`
      .quiet()
      .nothrow();
  return r.exitCode === 0;
}

/**
 * Add a worktree for the given branch. Detects whether the branch
 * already exists:
 *
 *   - **Branch exists** → `git worktree add <path> <branch>` (checks
 *     out the existing branch into the new worktree). Returns
 *     `{ created: false }`.
 *   - **Branch is new**  → `git worktree add <path> -b <branch> <base>`
 *     (creates a new branch from `base` and checks it out). Returns
 *     `{ created: true }`.
 *
 * Either way, the worktree path defaults to
 * `~/wt/<repoBasename>/<sanitizedBranch>`.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  options: { base?: string; wtRoot?: string } = {},
): Promise<CreatedWorktree & { created: boolean }> {
  const { homedir } = await import("node:os");
  const { mkdir } = await import("node:fs/promises");
  const { join, basename } = await import("node:path");
  const repoName = basename(repoPath.replace(/[\/\\]+$/, ""));
  const root = options.wtRoot ?? join(homedir(), "wt", repoName);
  await mkdir(root, { recursive: true });
  const wtPath = join(root, sanitizeBranchForPath(branch));
  const base = options.base ?? "HEAD";
  const exists = await branchExists(repoPath, branch);
  const args = exists
    ? ["git", "-C", repoPath, "worktree", "add", wtPath, branch]
    : ["git", "-C", repoPath, "worktree", "add", wtPath, "-b", branch, base];
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(
      `git worktree add failed: ${stderr.trim() || "exit " + exit}`,
    );
  }
  return { path: wtPath, branch, created: !exists };
}

/**
 * Remove a worktree by path. The branch is *not* deleted.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const args = ["git", "-C", repoPath, "worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktreePath);
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(
      `git worktree remove failed: ${stderr.trim() || "exit " + exit}`,
    );
  }
}

export interface BranchListing {
  /** Branch currently checked out in this worktree (null if detached). */
  current: string | null;
  /** Local refs (refs/heads/*). */
  local: string[];
  /** Remote refs as "<remote>/<branch>", e.g. "origin/main". */
  remote: string[];
}

export async function listBranches(repoPath: string): Promise<BranchListing> {
  let current: string | null = null;
  try {
    const out = await $`git -C ${repoPath} symbolic-ref --quiet --short HEAD`
      .quiet()
      .nothrow();
    const s = out.stdout.toString().trim();
    if (s) current = s;
  } catch {
    current = null;
  }
  const local: string[] = [];
  const remote: string[] = [];
  try {
    // Sort by committer date descending so the branch picker shows
    // recently-touched branches first — most "switch to X" intents
    // target something the user worked on lately.
    const out =
      await $`git -C ${repoPath} for-each-ref --sort=-committerdate --format=${"%(refname)"} refs/heads refs/remotes`
        .quiet()
        .nothrow();
    for (const raw of out.stdout.toString().split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("refs/heads/")) {
        local.push(line.slice("refs/heads/".length));
      } else if (line.startsWith("refs/remotes/")) {
        const name = line.slice("refs/remotes/".length);
        if (name.endsWith("/HEAD")) continue;
        remote.push(name);
      }
    }
  } catch {
    // best effort
  }
  return { current, local, remote };
}

/** Run `git checkout <branch>` inside a worktree. Refuses on dirty
 *  working tree unless `force` is true or `preStash` is true.
 *
 *  Options:
 *    - `force`: pass `--force` to git checkout (discards local changes).
 *    - `preStash`: if the worktree is dirty, run `git stash push` first
 *      (with a recognizable message and --include-untracked) so the
 *      user can `git stash pop` later. Then proceed with a clean
 *      checkout. Returns `{ stashed: true }` so the caller can tell.
 *
 *  Existing-branch checkouts only — caller passes a name from
 *  listBranches's local set, or a remote name (e.g. "origin/foo") to
 *  create a local tracking branch implicitly via `git checkout -t`. */
export async function checkoutBranch(
  worktreePath: string,
  branch: string,
  options: { force?: boolean; preStash?: boolean } = {},
): Promise<{ stashed: boolean }> {
  let stashed = false;
  const isDirty = async (): Promise<boolean> => {
    const r = await $`git -C ${worktreePath} status --porcelain`
      .quiet()
      .nothrow();
    return r.stdout.toString().trim().length > 0;
  };

  if (!options.force) {
    if (await isDirty()) {
      if (options.preStash) {
        const message = `supergit-auto ${new Date().toISOString()}`;
        const stashRes =
          await $`git -C ${worktreePath} stash push --include-untracked -m ${message}`
            .quiet()
            .nothrow();
        if (stashRes.exitCode !== 0) {
          throw new Error(
            `git stash failed: ${stashRes.stderr.toString().trim() || "exit " + stashRes.exitCode}`,
          );
        }
        stashed = true;
      } else {
        throw new Error(
          "worktree has uncommitted/untracked changes — commit, stash, or force",
        );
      }
    }
  }

  const isRemote = branch.includes("/") && !branch.startsWith("refs/");
  const args = ["git", "-C", worktreePath, "checkout"];
  if (options.force) args.push("--force");
  if (isRemote) args.push("-t");
  args.push(branch);
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`git checkout failed: ${stderr.trim() || "exit " + exit}`);
  }
  return { stashed };
}

/** Result of {@link pullFastForward}.
 *
 *  - `updated`: HEAD advanced; the worktree now matches `@{u}`.
 *  - `up_to_date`: HEAD was already at upstream — no-op.
 *  - `diverged`: local has commits not on upstream; `--ff-only` refused.
 *  - `dirty`: local working tree has changes that would be clobbered by
 *    the incoming commits (overlap), or `git pull` aborted because of
 *    uncommitted changes.
 *  - `no_upstream`: branch has no configured upstream.
 *  - `auth`: git couldn't authenticate (no credential helper, bad
 *    token, SSH key missing, etc.).
 *  - `error`: anything else (network failure, hook abort, etc.). */
export type PullKind =
  | "updated"
  | "up_to_date"
  | "diverged"
  | "dirty"
  | "no_upstream"
  | "auth"
  | "error";

export interface PullResult {
  ok: boolean;
  kind: PullKind;
  message: string;
  /** True if we ran `git stash push --include-untracked` before retrying
   *  the pull. The caller can surface this to the user so they know their
   *  local changes were set aside. */
  stashed?: boolean;
  /** When {@link stashed} is true, whether the auto-stash was popped back
   *  cleanly after the pull succeeded. False if the pop hit a conflict (see
   *  {@link stashConflict}) and the stash was left in place. */
  stashRestored?: boolean;
  /** True if `git stash pop` reported a conflict while reapplying the
   *  auto-stash. The stash entry is preserved so the user can recover; the
   *  working tree has conflict markers to resolve. */
  stashConflict?: boolean;
}

/** Fast-forward the current branch to its upstream in `worktreePath`.
 *  Runs `git merge --ff-only @{u}` — NOT `git pull` — because the daemon's
 *  background fetch cycle already keeps `@{u}` fresh, and `git pull` would
 *  add a gratuitous network round-trip that makes the badge feel sluggish.
 *  Never falls back to merge/rebase: anything other than a strict
 *  fast-forward is reported to the caller so the UI can prompt the user.
 *
 *  Options:
 *    - `preStash`: if the first attempt fails because of dirty state
 *      (would-be-clobbered files), run `git stash push --include-untracked`
 *      and retry once. On a successful pull we then `git stash pop` to
 *      reapply the local changes. Returns `{ stashed: true, stashRestored }`
 *      — `stashRestored: false` with `stashConflict: true` means the pop hit
 *      a conflict and the stash was kept so the user can recover. */
export async function pullFastForward(
  worktreePath: string,
  options: { preStash?: boolean; remote?: string | null } = {},
): Promise<PullResult> {
  const targetRef = async (): Promise<string> => {
    if (!options.remote) return "@{u}";
    const branch = await currentBranchName(worktreePath);
    if (!branch) return "";
    const ref = `refs/remotes/${options.remote}/${branch}`;
    return (await remoteBranchRefExists(worktreePath, ref)) ? ref : "";
  };

  const run = async (): Promise<PullResult> => {
    let r;
    try {
      const target = await targetRef();
      if (!target) {
        return {
          ok: false,
          kind: "no_upstream",
          message: options.remote
            ? `No ${options.remote}/${(await currentBranchName(worktreePath)) ?? "HEAD"} remote branch.`
            : "Branch has no upstream.",
        };
      }
      r = await runGitWithLockRetry(() =>
        raceTimeout(
          $`GIT_TERMINAL_PROMPT=0 git -C ${worktreePath} merge --ff-only ${target}`
            .quiet()
            .nothrow(),
          PUSH_PULL_TIMEOUT_MS,
          "git pull",
        ),
      );
    } catch (e) {
      return {
        ok: false,
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    const stdout = r.stdout.toString();
    const stderr = r.stderr.toString();
    const combined = `${stdout}\n${stderr}`;
    if (r.exitCode === 0) {
      if (/Already up to date/i.test(combined)) {
        return { ok: true, kind: "up_to_date", message: combined.trim() };
      }
      return { ok: true, kind: "updated", message: combined.trim() };
    }
    // Classify the failure. Match against the most specific patterns
    // first so a "non-fast-forward" verdict doesn't get swallowed by
    // the dirty-state branch.
    const msg = combined.trim();
    if (/There is no tracking information|no upstream/i.test(combined)) {
      return { ok: false, kind: "no_upstream", message: msg };
    }
    if (
      /could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey\)|Authentication failed|invalid credentials/i.test(
        combined,
      )
    ) {
      return { ok: false, kind: "auth", message: msg };
    }
    if (
      /Not possible to fast-forward|diverg(ed|ent)|non-fast-forward/i.test(
        combined,
      )
    ) {
      return { ok: false, kind: "diverged", message: msg };
    }
    if (
      /local changes.*would be overwritten|untracked working tree files.*would be overwritten|Please commit your changes or stash them/i.test(
        combined,
      )
    ) {
      return { ok: false, kind: "dirty", message: msg };
    }
    return { ok: false, kind: "error", message: msg };
  };

  let result = await run();
  if (!result.ok && result.kind === "dirty" && options.preStash) {
    const stashMsg = `supergit-auto ${new Date().toISOString()}`;
    let stashRes;
    try {
      stashRes = await raceTimeout(
        $`GIT_TERMINAL_PROMPT=0 git -C ${worktreePath} stash push --include-untracked -m ${stashMsg}`
          .quiet()
          .nothrow(),
        PUSH_PULL_TIMEOUT_MS,
        "git stash",
      );
    } catch (e) {
      return {
        ok: false,
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (stashRes.exitCode !== 0) {
      return {
        ok: false,
        kind: "error",
        message: `git stash failed: ${
          stashRes.stderr.toString().trim() || "exit " + stashRes.exitCode
        }`,
      };
    }
    result = await run();
    result.stashed = true;
    // Reapply the local changes we set aside. Only attempt the pop when the
    // pull actually succeeded — if it didn't, the stash stays put and the
    // caller already sees the failure. A pop that conflicts leaves the stash
    // in place (git keeps it), so we report stashConflict and let the user
    // resolve rather than silently dropping their work.
    if (result.ok) {
      let popRes;
      try {
        popRes = await raceTimeout(
          $`GIT_TERMINAL_PROMPT=0 git -C ${worktreePath} stash pop`
            .quiet()
            .nothrow(),
          PUSH_PULL_TIMEOUT_MS,
          "git stash pop",
        );
      } catch {
        // Timed out or threw — leave the stash for manual recovery.
        result.stashRestored = false;
        return result;
      }
      if (popRes.exitCode === 0) {
        result.stashRestored = true;
      } else {
        result.stashRestored = false;
        result.stashConflict = /conflict/i.test(
          `${popRes.stdout.toString()}\n${popRes.stderr.toString()}`,
        );
      }
    }
  }
  return result;
}

export interface PushResult {
  ok: boolean;
  message: string;
  kind?: "auth";
}

/** Run `git push` in `worktreePath`, using whatever upstream the branch
 *  is configured to track. No `--force` — non-fast-forward failures
 *  surface to the caller verbatim so the UI can show them in a toast. */
export async function pushUpstream(
  worktreePath: string,
  options: { remote?: string | null } = {},
): Promise<PushResult> {
  let r;
  try {
    const branch = options.remote ? await currentBranchName(worktreePath) : null;
    const refspec = branch ? `HEAD:refs/heads/${branch}` : null;
    r = await runGitWithLockRetry(() =>
      raceTimeout(
        options.remote && refspec
          ? $`GIT_TERMINAL_PROMPT=0 git -C ${worktreePath} push ${options.remote} ${refspec}`
              .quiet()
              .nothrow()
          : $`GIT_TERMINAL_PROMPT=0 git -C ${worktreePath} push`
              .quiet()
              .nothrow(),
        PUSH_PULL_TIMEOUT_MS,
        "git push",
      ),
    );
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  const message = `${stdout}${stderr}`.trim();
  if (
    r.exitCode !== 0 &&
    /could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey\)|Authentication failed|invalid credentials/i.test(
      message,
    )
  ) {
    return { ok: false, message, kind: "auth" };
  }
  return { ok: r.exitCode === 0, message };
}

export interface RemoteRef {
  /** Remote name as git stores it (e.g. "origin", "upstream"). */
  name: string;
  /** Raw fetch URL from `git remote -v`. */
  url: string;
  /** Browser-openable URL derived from `url`, or null when we couldn't
   *  parse it (rare — falls back to a generic `https://<host>/<path>`
   *  for unknown providers, so this is only null for total garbage). */
  webUrl: string | null;
  /** Lowercased provider key when known: "github", "gitlab", "bitbucket",
   *  "azure", "codeberg", "sourcehut", "gitea". Null for unknown hosts. */
  provider: string | null;
  /** Hostname extracted from the URL, or null if unparseable. */
  host: string | null;
}

function detectProvider(host: string): string | null {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (
    h === "ssh.dev.azure.com" ||
    h === "dev.azure.com" ||
    h.endsWith(".visualstudio.com")
  ) {
    return "azure";
  }
  if (h === "bitbucket.org" || h.includes("bitbucket.")) return "bitbucket";
  if (h === "codeberg.org") return "codeberg";
  if (h === "git.sr.ht" || h.endsWith(".sr.ht")) return "sourcehut";
  // GitLab self-hosted is common — match on hostname token. Check after
  // bitbucket/sourcehut/codeberg so those win on overlap.
  if (h === "gitlab.com" || h.includes("gitlab.")) return "gitlab";
  if (h.includes("gitea")) return "gitea";
  return null;
}

/**
 * Parse a git remote URL into a browser-openable web URL plus host/provider
 * metadata. Handles HTTPS, SCP-style (`git@host:path`), `ssh://`, and `git://`.
 *
 * The web URL is the best-effort "what would you click to view this repo in
 * a browser" — we never invent owners or branches, just strip `.git` and
 * rewrite the scheme. Azure DevOps gets a small special case because its
 * SSH path differs from its HTTPS path. Everything else falls back to
 * `https://<host>/<path>`.
 */
export function parseRemoteUrl(raw: string): {
  webUrl: string | null;
  provider: string | null;
  host: string | null;
} {
  const url = (raw ?? "").trim();
  if (!url) return { webUrl: null, provider: null, host: null };

  let host: string | null = null;
  let pathPart: string | null = null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    // Anything with an explicit scheme (https://, ssh://, git://, http://).
    try {
      const u = new URL(url);
      host = u.hostname;
      pathPart = u.pathname.replace(/^\/+/, "");
    } catch {
      return { webUrl: null, provider: null, host: null };
    }
  } else if (url.includes(":") && !url.startsWith("/")) {
    // SCP-style: [user@]host:path. The `:` is mandatory and must not be
    // followed by `//` (we already handled real URLs above). We reject
    // forms with whitespace before the `:` because those are not URLs.
    const colon = url.indexOf(":");
    const left = url.slice(0, colon);
    const right = url.slice(colon + 1);
    if (/\s/.test(left) || left.length === 0 || right.length === 0) {
      return { webUrl: null, provider: null, host: null };
    }
    const at = left.lastIndexOf("@");
    host = at >= 0 ? left.slice(at + 1) : left;
    pathPart = right.replace(/^\/+/, "");
  } else {
    return { webUrl: null, provider: null, host: null };
  }

  if (!host || !pathPart) return { webUrl: null, provider: null, host: null };

  pathPart = pathPart.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!pathPart) return { webUrl: null, provider: null, host: null };

  const provider = detectProvider(host);

  let webUrl: string;
  if (provider === "azure") {
    // Azure DevOps SSH path is `v3/<org>/<project>/<repo>`, but the web URL
    // lives at `dev.azure.com/<org>/<project>/_git/<repo>`. HTTPS form
    // already matches the web URL, so the regex just no-ops for it.
    const m = /^v3\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathPart);
    if (m) {
      webUrl = `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}`;
    } else {
      webUrl = `https://${host}/${pathPart}`;
    }
  } else {
    webUrl = `https://${host}/${pathPart}`;
  }

  return { webUrl, provider, host };
}

/** Parse `git remote -v` output into `{name, url}` pairs, deduping fetch/push
 *  entries (each remote appears twice — we keep the fetch URL only). */
export function parseRemotesOutput(
  out: string,
): { name: string; url: string }[] {
  const seen = new Set<string>();
  const result: { name: string; url: string }[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Format: "<name>\t<url> (fetch|push)". Tab is the canonical separator
    // but git allows whitespace, so be liberal.
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
    if (!m) continue;
    if (m[3] !== "fetch") continue;
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({ name, url: m[2]! });
  }
  return result;
}

/** Run `git remote -v` and return enriched RemoteRef entries. Returns []
 *  for non-git directories, missing paths, or repos with no remotes — the
 *  UI can treat the result as authoritative. */
export async function listRemotes(repoPath: string): Promise<RemoteRef[]> {
  const r = await $`git -C ${repoPath} remote -v`.quiet().nothrow();
  if (r.exitCode !== 0) return [];
  const parsed = parseRemotesOutput(r.stdout.toString());
  return parsed.map(({ name, url }) => ({ name, url, ...parseRemoteUrl(url) }));
}

/** Parse `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`
 *  output. Successful form is "<remote>/<branch>" (e.g. "origin/main");
 *  we extract the remote part. Empty/unparseable input → null so callers
 *  can fall back. */
export function parseUpstreamRemote(out: string): string | null {
  const line = out.trim().split("\n")[0]?.trim();
  if (!line) return null;
  const slash = line.indexOf("/");
  if (slash <= 0) return null;
  return line.slice(0, slash);
}

/** Resolve the remote name (e.g. "origin", "upstream") that the
 *  checked-out branch at `worktreePath` tracks. Returns null when the
 *  branch has no upstream configured, the path is detached HEAD, or
 *  the git invocation fails — callers should fall back to the
 *  first-remote heuristic in that case. */
export async function getUpstreamRemoteName(
  worktreePath: string,
): Promise<string | null> {
  const r =
    await $`git -C ${worktreePath} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`
      .quiet()
      .nothrow();
  if (r.exitCode !== 0) return null;
  return parseUpstreamRemote(r.stdout.toString());
}

/** Pick the remote URL to put in a session-share manifest. The share
 *  receiver uses this URL to locate (or clone) the repo on its side,
 *  so picking the WRONG remote in a multi-remote setup (think a fork
 *  where `origin = your-fork` and `upstream = canonical`) sends
 *  receivers chasing the wrong repo. Order of preference:
 *    1. Remote that the currently checked-out branch tracks.
 *    2. First remote in the list (historical behaviour — matches the
 *       common single-remote case).
 *  Returns null only when the repo has no remotes at all. Pure so the
 *  test suite can pin every combination without spinning up a real
 *  multi-remote repo on disk. */
export function pickRemoteUrlForShare(
  remotes: RemoteRef[],
  upstreamRemoteName: string | null,
): string | null {
  if (upstreamRemoteName) {
    const found = remotes.find((r) => r.name === upstreamRemoteName);
    if (found) return found.url;
  }
  return remotes[0]?.url ?? null;
}

export async function fetchAll(repoPath: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", repoPath, "fetch", "--all", "--prune", "--quiet"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const exit = await proc.exited;
    return exit === 0;
  } catch {
    return false;
  }
}

export function parseWorktreeList(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};

  const flush = () => {
    if (current.path === undefined) return;
    worktrees.push({
      path: current.path,
      branch: current.branch ?? "",
      head: current.head ?? "",
      bare: current.bare ?? false,
      detached: current.detached ?? false,
    });
    current = {};
  };

  for (const line of porcelain.split("\n")) {
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      flush();
      // normalize(): git on Windows returns forward-slash paths (C:/...),
      // but Node's path APIs use backslashes. resolve() normalizes both.
      current.path = resolvePath(line.slice("worktree ".length));
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();

  return worktrees;
}

export async function getWorktreeDetails(
  worktreePath: string,
  options: { remote?: string | null } = {},
): Promise<WorktreeDetails> {
  try {
    // Speculative third call: oldest local commit not on upstream. Errors
    // when there's no upstream — caught into "" and discarded. Running
    // it in parallel with status keeps the happy path one round-trip.
    const [statusOut, logOut, aheadOldestOut, shortstatOut] = await Promise.all(
      [
        $`git -C ${worktreePath} status --porcelain=v2 --branch`.quiet().text(),
        $`git -C ${worktreePath} log -1 --format=%H%x00%s%x00%an%x00%aI`
          .quiet()
          .text()
          .catch(() => ""),
        $`git -C ${worktreePath} log @{u}..HEAD --reverse --format=%cI`
          .quiet()
          .text()
          .catch(() => ""),
        $`git -C ${worktreePath} diff --shortstat HEAD`
          .quiet()
          .text()
          .catch(() => ""),
      ],
    );
    let branchStatus = parseBranchStatus(statusOut);
    if (branchStatus && options.remote) {
      const selectedStatus = await getSelectedRemoteBranchStatus(
        worktreePath,
        options.remote,
      );
      if (selectedStatus?.upstream || !branchStatus.upstream) {
        branchStatus = selectedStatus ?? branchStatus;
      }
    }
    if (branchStatus && branchStatus.ahead > 0) {
      const oldest = aheadOldestOut.split("\n")[0]?.trim() ?? "";
      if (oldest.length > 0) branchStatus.aheadOldestTime = oldest;
    }
    // No upstream → git emits no `branch.ab`, so `ahead` is 0 and the UI
    // has nothing to show. Fall back to counting commits reachable from
    // HEAD but from no remote-tracking ref ("exists nowhere on a remote").
    // Only pay this extra round-trip for the remote-less case; the common
    // has-upstream path stays at one round-trip. `.catch("")` covers the
    // no-commits-yet repo (rev-list with no HEAD errors).
    if (branchStatus && branchStatus.upstream === null) {
      const countOut = await $`git -C ${worktreePath} rev-list --count HEAD --not --remotes`
        .quiet()
        .text()
        .catch(() => "");
      const n = Number.parseInt(countOut.trim(), 10);
      if (!Number.isNaN(n)) branchStatus.unpushed = n;
    }
    const fileStatus = parseFileStatus(statusOut);
    fileStatus.dirtyLines = parseShortstatLines(shortstatOut);
    return {
      fileStatus,
      branchStatus,
      lastCommit: parseLastCommit(logOut),
    };
  } catch {
    return {
      fileStatus: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        submodules: 0,
        submoduleChanges: 0,
        dirtyLines: 0,
      },
      branchStatus: null,
      lastCommit: null,
    };
  }
}

async function currentBranchName(worktreePath: string): Promise<string | null> {
  const out = await $`git -C ${worktreePath} symbolic-ref --quiet --short HEAD`
    .quiet()
    .nothrow();
  const branch = out.stdout.toString().trim();
  return out.exitCode === 0 && branch.length > 0 ? branch : null;
}

async function remoteBranchRefExists(
  worktreePath: string,
  remoteRef: string,
): Promise<boolean> {
  const out =
    await $`git -C ${worktreePath} rev-parse --verify --quiet ${remoteRef}^{commit}`
      .quiet()
      .nothrow();
  return out.exitCode === 0;
}

export async function getSelectedRemoteBranchStatus(
  worktreePath: string,
  remote: string,
): Promise<BranchStatus | null> {
  const branch = await currentBranchName(worktreePath);
  if (!branch) return null;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  if (await remoteBranchRefExists(worktreePath, remoteRef)) {
    const [countsOut, oldestOut] = await Promise.all([
      $`git -C ${worktreePath} rev-list --left-right --count HEAD...${remoteRef}`
        .quiet()
        .text()
        .catch(() => ""),
      $`git -C ${worktreePath} log ${remoteRef}..HEAD --reverse --format=%cI`
        .quiet()
        .text()
        .catch(() => ""),
    ]);
    const [aheadRaw, behindRaw] = countsOut.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadRaw ?? "0", 10);
    const behind = Number.parseInt(behindRaw ?? "0", 10);
    const aheadOldestTime = oldestOut.split("\n")[0]?.trim() || null;
    return {
      branch,
      upstream: `${remote}/${branch}`,
      ahead: Number.isNaN(ahead) ? 0 : ahead,
      behind: Number.isNaN(behind) ? 0 : behind,
      aheadOldestTime,
      unpushed: null,
    };
  }

  const countOut =
    await $`git -C ${worktreePath} rev-list --count HEAD --not --remotes=${remote}`
      .quiet()
      .text()
      .catch(() => "");
  const unpushed = Number.parseInt(countOut.trim(), 10);
  return {
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    aheadOldestTime: null,
    unpushed: Number.isNaN(unpushed) ? null : unpushed,
  };
}

export function parseFileStatus(porcelain: string): FileStatus {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let submodules = 0;
  let submoduleChanges = 0;
  for (const line of porcelain.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("? ")) {
      untracked++;
      continue;
    }
    // Tracked entries: "1 XY ..." (ordinary) or "2 XY ..." (renamed/copied).
    // Porcelain v2 layout: `1 <XY> <sub> ...` — sub starts at offset 5 and
    // is 4 chars wide. `N...` for non-submodules; `S<c><m><u>` for
    // submodules where <c> = 'C' means the parent's recorded SHA moved.
    // When the only difference is *inside* the submodule (<c> = '.'),
    // bucket as "submodules" so the parent doesn't get tagged as dirty
    // for a child repo's own uncommitted work. Every S-prefix entry
    // — pointer-bump or not — also increments `submoduleChanges` so
    // callers (e.g. the dock) can ignore submodule activity entirely.
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      if (line.charAt(5) === "S") {
        submoduleChanges++;
        if (line.charAt(6) === ".") {
          submodules++;
          continue;
        }
      }
      const x = line.charAt(2);
      const y = line.charAt(3);
      if (x !== "." && x !== " ") staged++;
      if (y !== "." && y !== " ") unstaged++;
      continue;
    }
    // Unmerged entries: "u XY ..." — count as both
    if (line.startsWith("u ")) {
      staged++;
      unstaged++;
    }
  }
  return {
    staged,
    unstaged,
    untracked,
    submodules,
    submoduleChanges,
    dirtyLines: 0,
  };
}

export function parseShortstatLines(shortstat: string): number {
  let total = 0;
  const ins = shortstat.match(/(\d+) insertion/);
  const del = shortstat.match(/(\d+) deletion/);
  if (ins) total += Number(ins[1]);
  if (del) total += Number(del[1]);
  return total;
}

export function parseBranchStatus(porcelain: string): BranchStatus | null {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const parts = line.slice("# branch.ab ".length).split(" ");
      ahead = Number.parseInt(parts[0]?.replace("+", "") ?? "0", 10);
      behind = Number.parseInt(parts[1]?.replace("-", "") ?? "0", 10);
    }
  }
  if (branch === null) return null;
  return { branch, upstream, ahead, behind, aheadOldestTime: null, unpushed: null };
}

export function parseLastCommit(logOut: string): LastCommit | null {
  const trimmed = logOut.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split("\0");
  if (parts.length < 4) return null;
  const sha = parts[0]!;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: parts[1]!,
    author: parts[2]!,
    time: parts[3]!,
  };
}

export async function listCommits(
  worktreePath: string,
  options: { before?: string; limit?: number; all?: boolean } = {},
): Promise<LastCommit[]> {
  const limit = options.limit ?? 20;
  const args = [
    "-C",
    worktreePath,
    "log",
    `--format=%H%x00%s%x00%an%x00%aI%x00%P%x00%D`,
    "-n",
    String(limit),
  ];
  if (options.all) args.push("--all");
  if (options.before) args.push(`${options.before}^`);
  else if (!options.all) args.push("HEAD");
  try {
    const out = await $`git ${args}`.quiet().text();
    return parseCommitList(out);
  } catch {
    return [];
  }
}

export function parseCommitList(logOut: string): LastCommit[] {
  return logOut
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.trim().split("\0");
      if (parts.length < 4) return null;
      const sha = parts[0]!;
      const parentStr = parts[4] ?? "";
      const parentCount =
        parentStr.length === 0 ? 0 : parentStr.split(" ").length;
      const refStr = parts[5] ?? "";
      const refs =
        refStr.length === 0
          ? []
          : refStr
              .split(", ")
              .map((r) => r.trim())
              .filter(Boolean);
      return {
        sha,
        shortSha: sha.slice(0, 7),
        subject: parts[1]!,
        author: parts[2]!,
        time: parts[3]!,
        parents: parentCount,
        refs,
      } satisfies LastCommit;
    })
    .filter((c): c is LastCommit => c !== null);
}

/** Per-bucket list of changed file paths in a worktree. Feeds the
 *  "N unstaged" hover tooltip in the dashboard. Input is the output of
 *  `git status --porcelain` (v1 format). The path field there starts at
 *  column 3 and runs to end-of-line, so it tolerates spaces in paths
 *  without us having to switch to NUL-separated parsing. */
export function parseChangedFiles(porcelain: string): {
  staged: string[];
  unstaged: string[];
  untracked: string[];
} {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 3) continue;
    const x = line.charAt(0);
    const y = line.charAt(1);
    let path = line.slice(3);
    // Renames/copies on the staged side print as "R  new -> old" or
    // "C  new -> old". Show the destination (new) path — that's what
    // the user thinks of as "the file that changed".
    if (x === "R" || x === "C") {
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) path = path.slice(0, arrow);
    }
    if (x === "?" && y === "?") {
      untracked.push(path);
      continue;
    }
    // Ignored entries show as "!! …" with --ignored; we don't ask for
    // those, but guard anyway so a future flag flip doesn't leak them.
    if (x === "!") continue;
    if (x !== " " && x !== "?") staged.push(path);
    if (y !== " " && y !== "?") unstaged.push(path);
  }
  return { staged, unstaged, untracked };
}

/** Per-file line stats. `binary` is true when git reports `-\t-` (no
 *  textual diff). For binary entries added/removed are 0 so callers can
 *  still render a sentinel without a special-case. */
export interface NumstatEntry {
  added: number;
  removed: number;
  binary: boolean;
}

/** Parse `git diff --numstat` (and `--cached` / `--no-index` variants).
 *  Each line is `added\tremoved\tpath`. Binary files print `-\t-`.
 *  Renames with default rename detection print `path` as `{old => new}`
 *  or `dir/{a => b}/file` — callers that need plain paths should pass
 *  `--no-renames` so each side reports as separate add/delete entries. */
export function parseNumstat(out: string): Record<string, NumstatEntry> {
  const map: Record<string, NumstatEntry> = {};
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    // Split on the FIRST two tabs only; paths can contain tabs in theory
    // but are vanishingly rare. The path field is everything after the
    // second tab.
    const t1 = line.indexOf("\t");
    if (t1 < 0) continue;
    const t2 = line.indexOf("\t", t1 + 1);
    if (t2 < 0) continue;
    const addedStr = line.slice(0, t1);
    const removedStr = line.slice(t1 + 1, t2);
    const path = line.slice(t2 + 1);
    if (path.length === 0) continue;
    if (addedStr === "-" || removedStr === "-") {
      map[path] = { added: 0, removed: 0, binary: true };
      continue;
    }
    const added = Number.parseInt(addedStr, 10);
    const removed = Number.parseInt(removedStr, 10);
    if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;
    map[path] = { added, removed, binary: false };
  }
  return map;
}

/** Subjects of the commits that are on HEAD but not on the upstream
 *  yet (or, in the inbound direction, commits we haven't fetched/pulled
 *  yet). Drives the "↑N" / "↓N" hover tooltips. Input is the output of
 *
 *      git log <range> --pretty=format:%H%x00%s%x00%an%x00%aI -n <limit>
 *
 *  using NUL bytes between fields so subjects with arbitrary whitespace
 *  / punctuation round-trip verbatim. Newlines separate commits. */
export interface UnpushedCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export function parseUnpushedCommits(logOut: string): UnpushedCommit[] {
  return logOut
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split("\0");
      // Defensive: if git's format ever drifts back to space-separated or
      // a field is missing, fall back to "everything after the sha is the
      // subject" rather than throwing. Empty author/date are fine.
      if (parts.length < 2) {
        const m = /^([0-9a-f]+)\s+(.*)$/i.exec(line);
        if (!m) return { sha: line, subject: "", author: "", date: "" };
        return { sha: m[1]!, subject: m[2]!, author: "", date: "" };
      }
      return {
        sha: parts[0] ?? "",
        subject: parts[1] ?? "",
        author: parts[2] ?? "",
        date: parts[3] ?? "",
      };
    });
}

export type DiffKind = "workdir" | "staged";

/** Kind for {@link getFileDiff}: same as {@link DiffKind} plus `untracked`,
 *  which uses `git diff --no-index /dev/null <file>` because `git diff`
 *  alone never mentions untracked paths. The /api/diff bulk route encodes
 *  untracked diffs into the `workdir` payload (see {@link getDiff}), but
 *  for per-file hover-popup fetches the caller already knows which bucket
 *  a path lives in, so accepting `untracked` here avoids a wasteful full
 *  workdir diff + post-filter on the client. */
export type FileDiffKind = DiffKind | "untracked";

/**
 * Textual diff for a single file. Used by the per-row hover popup in the
 * worktree-row "changed files" tooltip — the user already knows what
 * file they're hovering, so we don't need to ship the whole workdir
 * diff (which can be megabytes) just to render one file's hunks.
 *
 * Pathspec separator (`-- <file>`) is required so paths that look like
 * git refs (e.g. a file literally named `HEAD`) aren't reinterpreted.
 * Returns empty string on failure rather than throwing — the hover
 * popup just renders "no diff" in that case, which is the right UX.
 */
export async function getFileDiff(
  worktreePath: string,
  file: string,
  kind: FileDiffKind = "workdir",
  context: number = 0,
): Promise<string> {
  const ctx = `--unified=${clampContext(context)}`;
  try {
    if (kind === "untracked") {
      // --no-index exits 1 when the two paths differ (always true for
      // /dev/null vs a real file); .nothrow() prevents Bun from
      // promoting that into a thrown error.
      const result =
        await $`git -C ${worktreePath} diff --no-index --no-color ${ctx} /dev/null ${file}`
          .quiet()
          .nothrow();
      return result.stdout.toString();
    }
    const cmd =
      kind === "staged"
        ? $`git -C ${worktreePath} diff --staged --no-color ${ctx} -- ${file}`
        : $`git -C ${worktreePath} diff --no-color ${ctx} -- ${file}`;
    return await cmd.quiet().text();
  } catch {
    return "";
  }
}

/**
 * Diff for a single commit (vs its first parent). Used by the History panel
 * when the user clicks a commit to expand its content.
 */
export async function getCommitDiff(
  worktreePath: string,
  sha: string,
  context: number = 2,
): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
    // Don't pass user-supplied strings to git; only short/long hex SHAs.
    return "";
  }
  const ctx = `--unified=${clampContext(context)}`;
  try {
    return await $`git -C ${worktreePath} show --no-color --pretty=fuller ${ctx} ${sha}`
      .quiet()
      .text();
  } catch {
    return "";
  }
}

function clampContext(context: number): number {
  if (!Number.isFinite(context)) return 2;
  return Math.max(0, Math.min(99999, Math.floor(context)));
}

/**
 * Return the textual diff for a worktree. `workdir` = unstaged changes;
 * `staged` = the index vs HEAD. `context` controls -U<n>; pass a very large
 * value (e.g. 99999) to effectively get the full file. Default 2 lines.
 * Empty string when there's nothing.
 *
 * Untracked files: `git diff` on its own doesn't mention them. We
 * synthesise `git diff --no-index /dev/null <file>` per untracked path
 * so they show up inline as proper "new file" diffs (lines all `+`),
 * letting the Unstaged tab read as one unified list. Binary files render
 * as git's "Binary files differ" placeholder via `--no-index`'s default
 * behaviour. Files vanishing between `ls-files` and the per-file diff
 * (race on a fast `rm`) are skipped silently.
 */
export async function getDiff(
  worktreePath: string,
  kind: DiffKind = "workdir",
  context: number = 2,
): Promise<string> {
  const ctx = `--unified=${clampContext(context)}`;
  try {
    const diff = await (
      kind === "staged"
        ? $`git -C ${worktreePath} diff --staged --no-color ${ctx}`
        : $`git -C ${worktreePath} diff --no-color ${ctx}`
    )
      .quiet()
      .text();

    if (kind === "workdir") {
      const untracked =
        await $`git -C ${worktreePath} ls-files --others --exclude-standard`
          .quiet()
          .text();
      const untrackedEntries = untracked
        .split("\n")
        .filter((l) => l.length > 0);
      if (untrackedEntries.length > 0) {
        // Spawn one git subprocess per entry in parallel. With many
        // untracked files (e.g. 50+) the previous serial loop dominated
        // diff latency, especially under load. Promise.all preserves
        // array order so the joined output stays byte-identical.
        const synthetic = (
          await Promise.all(
            untrackedEntries.map(async (entry) => {
              if (entry.endsWith("/")) {
                // `git ls-files --others` collapses entire untracked dirs into
                // one entry. We can't sensibly diff every file inside (one
                // such dir had 16k files in practice). Two flavours to
                // distinguish for the user:
                //   - **embedded git repo** (a submodule that was never
                //     registered with `git submodule add` — has its own
                //     `.git/`). Common when you `git clone …` into a
                //     subdirectory by mistake or vendor a dependency.
                //   - plain untracked directory.
                const abs = joinPath(worktreePath, entry);
                const isEmbeddedRepo = await fileExists(joinPath(abs, ".git"));
                const label = isEmbeddedRepo
                  ? "(untracked embedded git repo — register with `git submodule add` or add to .gitignore)"
                  : "(untracked directory)";
                return (
                  `diff --git a/${entry} b/${entry}\n` +
                  `new file mode 040000\n` +
                  `--- /dev/null\n` +
                  `+++ b/${entry}\n` +
                  `@@ -0,0 +1,1 @@\n` +
                  `+${label}\n`
                );
              }
              // Regular file — `git diff --no-index` exits 1 when files
              // differ (which is always, for /dev/null vs a real file).
              // .nothrow() lets us capture the body without throwing.
              const result =
                await $`git -C ${worktreePath} diff --no-index --no-color ${ctx} /dev/null ${entry}`
                  .quiet()
                  .nothrow();
              return result.stdout.toString();
            }),
          )
        ).filter((s) => s.length > 0);
        if (synthetic.length > 0) {
          // Append the modified-file diff *after* the synthetic untracked
          // diffs so they appear first in the list — matches the order a
          // reviewer expects (new things on top).
          return synthetic.join("") + diff;
        }
      }
    }

    return diff;
  } catch {
    return "";
  }
}
