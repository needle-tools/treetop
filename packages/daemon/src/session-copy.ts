/**
 * Copy a session to another workspace. Reads the target workspace's
 * repos.json, matches the session's repo by normalised git remote,
 * rewrites paths (source repo root → target repo root), and writes
 * the JSONL into the Claude projects dir so `claude --resume <sid>`
 * works from the target workspace's repo clone.
 *
 * No network, no accept/decline — both workspaces are local to this
 * machine and owned by the same user.
 */

import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { normalizeRemote, rewritePaths, type SharePlatform } from "./session-share";
import { claudeProjectDirForCwd, CLAUDE_ROOT } from "./agents";
import { listRemotes } from "./git";

const WORKSPACES_ROOT = () => join(homedir(), "supergit", "workspaces");

export interface WorkspaceInfo {
  name: string;
  path: string;
}

/** List sibling workspaces, excluding the current one. */
export async function listWorkspaces(
  currentWorkspaceDir: string,
): Promise<WorkspaceInfo[]> {
  const root = WORKSPACES_ROOT();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const currentResolved = resolve(currentWorkspaceDir);
  const out: WorkspaceInfo[] = [];
  for (const name of entries) {
    const p = join(root, name);
    try {
      const s = await stat(p);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    if (resolve(p) === currentResolved) continue;
    out.push({ name, path: p });
  }
  return out;
}

interface TargetRepo {
  path: string;
  name: string;
}

/** Find a repo in a target workspace that matches the given normalised
 *  git remote URL. Reads the target's repos.json and runs
 *  `git remote -v` for each entry. Returns null if no match. */
async function findRepoInWorkspace(
  targetWorkspaceDir: string,
  normRemote: string,
): Promise<TargetRepo | null> {
  let repos: Array<{ path: string; name?: string }>;
  try {
    const raw = await readFile(
      join(targetWorkspaceDir, "repos.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { repos?: unknown[] };
    repos = (parsed.repos ?? []).filter(
      (r): r is { path: string; name?: string } =>
        !!r && typeof r === "object" && typeof (r as { path?: unknown }).path === "string",
    );
  } catch {
    return null;
  }
  for (const repo of repos) {
    const remotes = await listRemotes(repo.path).catch(() => []);
    const match = remotes.find(
      (r) => normalizeRemote(r.url) === normRemote,
    );
    if (match) return { path: repo.path, name: repo.name ?? "" };
  }
  return null;
}

export interface CopyResult {
  ok: boolean;
  copiedTo?: string;
  error?: string;
}

export async function copySessionToWorkspace(args: {
  /** Absolute path of the session JSONL to copy. */
  source: string;
  /** The current workspace's repo path that the session belongs to. */
  sourceRepoPath: string;
  /** Normalised git remote of the source repo. */
  sourceRemote: string;
  /** Absolute path of the target workspace dir. */
  targetWorkspaceDir: string;
  /** Override Claude projects dir for tests. */
  claudeProjectsDir?: string;
}): Promise<CopyResult> {
  const {
    source,
    sourceRepoPath,
    sourceRemote,
    targetWorkspaceDir,
    claudeProjectsDir = CLAUDE_ROOT(),
  } = args;

  // Find the matching repo in the target workspace.
  const target = await findRepoInWorkspace(
    targetWorkspaceDir,
    sourceRemote,
  );
  if (!target) {
    return {
      ok: false,
      error: `Target workspace has no repo matching remote ${sourceRemote}`,
    };
  }

  // Read the source JSONL.
  let jsonl: string;
  try {
    jsonl = await readFile(source, "utf-8");
  } catch (e) {
    return {
      ok: false,
      error: `Could not read source: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Rewrite paths only if the repo lives at a different location.
  const platform: SharePlatform =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  if (resolve(sourceRepoPath) !== resolve(target.path)) {
    jsonl = rewritePaths(jsonl, {
      from: sourceRepoPath,
      to: target.path,
      fromPlatform: platform,
      toPlatform: platform,
    });
  }

  // Write to the Claude projects dir under the target's cwd encoding.
  const targetDir = await claudeProjectDirForCwd(target.path, claudeProjectsDir);
  await mkdir(targetDir, { recursive: true });
  const sid = source.split(sep).pop()?.replace(/\.jsonl$/, "") ?? "unknown";
  const copiedTo = join(targetDir, `${sid}.jsonl`);
  await writeFile(copiedTo, jsonl);

  return { ok: true, copiedTo };
}
