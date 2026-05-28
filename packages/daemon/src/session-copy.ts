/**
 * Copy a session to another worktree. Rewrites paths (source cwd →
 * target worktree path), writes the JSONL into the Claude projects
 * dir so `claude --resume <sid>` works from the target cwd.
 *
 * No network, no accept/decline — everything is local to this machine
 * and owned by the same user.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { rewritePaths, type SharePlatform } from "./session-share";
import { claudeProjectDirForCwd, CLAUDE_ROOT } from "./agents";

export interface CopyResult {
  ok: boolean;
  copiedTo?: string;
  error?: string;
}

export async function copySessionToWorktree(args: {
  /** Absolute path of the session JSONL to copy. */
  source: string;
  /** The source worktree/repo path (the session's cwd). */
  sourceCwd: string;
  /** The target worktree path to copy into. */
  targetCwd: string;
  /** Override Claude projects dir for tests. */
  claudeProjectsDir?: string;
}): Promise<CopyResult> {
  const {
    source,
    sourceCwd,
    targetCwd,
    claudeProjectsDir = CLAUDE_ROOT(),
  } = args;

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

  // Rewrite paths only if the cwd actually differs.
  const platform: SharePlatform =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  if (resolve(sourceCwd) !== resolve(targetCwd)) {
    jsonl = rewritePaths(jsonl, {
      from: sourceCwd,
      to: targetCwd,
      fromPlatform: platform,
      toPlatform: platform,
    });
  }

  // Write to the Claude projects dir under the target's cwd encoding.
  const targetDir = await claudeProjectDirForCwd(targetCwd, claudeProjectsDir);
  await mkdir(targetDir, { recursive: true });
  const sid =
    source
      .split(sep)
      .pop()
      ?.replace(/\.jsonl$/, "") ?? "unknown";
  const copiedTo = await import("node:path").then((p) =>
    p.join(targetDir, `${sid}.jsonl`),
  );
  await writeFile(copiedTo, jsonl);

  return { ok: true, copiedTo };
}
