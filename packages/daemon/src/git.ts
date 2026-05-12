import { $ } from "bun";
import { access } from "node:fs/promises";
import { join as joinPath } from "node:path";

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
}

export interface FileStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface BranchStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface LastCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  time: string; // ISO
}

export interface WorktreeDetails {
  fileStatus: FileStatus;
  branchStatus: BranchStatus | null;
  lastCommit: LastCommit | null;
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  try {
    const result = await $`git -C ${repoPath} worktree list --porcelain`
      .quiet()
      .text();
    const worktrees = parseWorktreeList(result);
    return resolveSubmoduleWorktreePaths(repoPath, worktrees);
  } catch {
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
  const needsFix = worktrees.some((w) => w.path.includes("/.git/"));
  if (!needsFix) return worktrees;
  let toplevel: string | null = null;
  try {
    const r = await $`git -C ${repoPath} rev-parse --show-toplevel`
      .quiet()
      .nothrow();
    if (r.exitCode === 0) {
      const out = r.stdout.toString().trim();
      if (out.length > 0) toplevel = out;
    }
  } catch {
    // best effort — leave paths as-is if rev-parse fails
  }
  if (!toplevel) return worktrees;
  return worktrees.map((w) =>
    w.path.includes("/.git/") ? { ...w, path: toplevel! } : w,
  );
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
  const r = await $`git -C ${repoPath} show-ref --verify --quiet refs/heads/${branch}`
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
    throw new Error(`git worktree add failed: ${stderr.trim() || "exit " + exit}`);
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
    const out = await $`git -C ${repoPath} for-each-ref --sort=-committerdate --format=${"%(refname)"} refs/heads refs/remotes`
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
      current.path = line.slice("worktree ".length);
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
): Promise<WorktreeDetails> {
  try {
    const [statusOut, logOut] = await Promise.all([
      $`git -C ${worktreePath} status --porcelain=v2 --branch`.quiet().text(),
      $`git -C ${worktreePath} log -1 --format=%H%x00%s%x00%an%x00%aI`
        .quiet()
        .text()
        .catch(() => ""),
    ]);
    return {
      fileStatus: parseFileStatus(statusOut),
      branchStatus: parseBranchStatus(statusOut),
      lastCommit: parseLastCommit(logOut),
    };
  } catch {
    return {
      fileStatus: { staged: 0, unstaged: 0, untracked: 0 },
      branchStatus: null,
      lastCommit: null,
    };
  }
}

export function parseFileStatus(porcelain: string): FileStatus {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("? ")) {
      untracked++;
      continue;
    }
    // Tracked entries: "1 XY ..." (ordinary) or "2 XY ..." (renamed/copied)
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
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
  return { staged, unstaged, untracked };
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
  return { branch, upstream, ahead, behind };
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
  options: { before?: string; limit?: number } = {},
): Promise<LastCommit[]> {
  const limit = options.limit ?? 20;
  const ref = options.before ? `${options.before}^` : "HEAD";
  try {
    const out = await $`git -C ${worktreePath} log --format=%H%x00%s%x00%an%x00%aI -n ${limit} ${ref}`
      .quiet()
      .text();
    return parseCommitList(out);
  } catch {
    return [];
  }
}

export function parseCommitList(logOut: string): LastCommit[] {
  return logOut
    .split("\n")
    .filter((l) => l.length > 0)
    .map(parseLastCommit)
    .filter((c): c is LastCommit => c !== null);
}

export type DiffKind = "workdir" | "staged";

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
    const diff = await (kind === "staged"
      ? $`git -C ${worktreePath} diff --staged --no-color ${ctx}`
      : $`git -C ${worktreePath} diff --no-color ${ctx}`)
      .quiet()
      .text();

    if (kind === "workdir") {
      const untracked = await $`git -C ${worktreePath} ls-files --others --exclude-standard`
        .quiet()
        .text();
      const untrackedEntries = untracked.split("\n").filter((l) => l.length > 0);
      if (untrackedEntries.length > 0) {
        const synthetic: string[] = [];
        for (const entry of untrackedEntries) {
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
            synthetic.push(
              `diff --git a/${entry} b/${entry}\n` +
              `new file mode 040000\n` +
              `--- /dev/null\n` +
              `+++ b/${entry}\n` +
              `@@ -0,0 +1,1 @@\n` +
              `+${label}\n`,
            );
            continue;
          }
          // Regular file — `git diff --no-index` exits 1 when files
          // differ (which is always, for /dev/null vs a real file).
          // .nothrow() lets us capture the body without throwing.
          const result = await $`git -C ${worktreePath} diff --no-index --no-color ${ctx} /dev/null ${entry}`
            .quiet()
            .nothrow();
          const text = result.stdout.toString();
          if (text.length > 0) synthetic.push(text);
        }
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
