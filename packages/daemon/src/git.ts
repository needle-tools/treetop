import { $ } from "bun";

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
    return parseWorktreeList(result);
  } catch {
    return [];
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
export async function createWorktree(
  repoPath: string,
  branch: string,
  options: { base?: string; wtRoot?: string } = {},
): Promise<CreatedWorktree> {
  const { homedir } = await import("node:os");
  const { mkdir } = await import("node:fs/promises");
  const { join, basename } = await import("node:path");
  const repoName = basename(repoPath.replace(/[\/\\]+$/, ""));
  const root = options.wtRoot ?? join(homedir(), "wt", repoName);
  await mkdir(root, { recursive: true });
  const wtPath = join(root, sanitizeBranchForPath(branch));
  const base = options.base ?? "HEAD";
  const proc = Bun.spawn(
    ["git", "-C", repoPath, "worktree", "add", wtPath, "-b", branch, base],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`git worktree add failed: ${stderr.trim() || "exit " + exit}`);
  }
  return { path: wtPath, branch };
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
 * Empty string when there's nothing. Untracked files are summarised at the
 * top so reviewers see them too — git diff doesn't otherwise mention them.
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
      const untrackedFiles = untracked.split("\n").filter((l) => l.length > 0);
      if (untrackedFiles.length > 0) {
        const header =
          `# untracked files (${untrackedFiles.length}):\n` +
          untrackedFiles.map((f) => `?  ${f}`).join("\n") +
          "\n\n";
        return header + diff;
      }
    }

    return diff;
  } catch {
    return "";
  }
}
