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
