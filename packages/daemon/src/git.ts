import { $ } from "bun";

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  detached: boolean;
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
