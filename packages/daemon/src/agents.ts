/**
 * Detect active AI agent sessions (Claude Code, OpenAI Codex CLI, VSCode
 * Copilot Chat) by scanning each agent's known filesystem layout. Each
 * scanner is independent and best-effort — a missing or unreadable dir
 * just yields zero sessions, no error propagates.
 *
 * The daemon does not start agents; this is observation only.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type AgentKind = "claude" | "codex" | "copilot";

export interface AgentSession {
  agent: AgentKind;
  /** Resolved absolute path of the cwd the agent was working in. */
  cwd: string;
  /** ISO timestamp; we use the session file mtime. */
  lastActive: string;
  /** Per-agent session id where available (used for resume). */
  sessionId?: string;
  /** File path the session was discovered at. Useful for debugging. */
  source: string;
}

const CLAUDE_ROOT = () => join(homedir(), ".claude", "projects");

const CODEX_ROOTS = () => [
  join(homedir(), ".codex", "sessions"),
  join(homedir(), ".config", "openai-codex", "sessions"),
];

const COPILOT_WS_ROOT = () => {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "workspaceStorage",
    );
  }
  if (process.platform === "linux") {
    return join(homedir(), ".config", "Code", "User", "workspaceStorage");
  }
  if (process.platform === "win32") {
    return join(
      homedir(),
      "AppData",
      "Roaming",
      "Code",
      "User",
      "workspaceStorage",
    );
  }
  return "";
};

/** Read a session file line by line and return the value of the first
 *  occurrence of `field`. Returns null if not found or not a string. */
export async function readJsonlField(
  path: string,
  field: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const val = obj[field];
      if (typeof val === "string") return val;
    } catch {
      // not JSON or partial line — skip
    }
  }
  return null;
}

export async function scanClaude(
  root: string = CLAUDE_ROOT(),
): Promise<AgentSession[]> {
  let projDirs: string[];
  try {
    projDirs = await readdir(root);
  } catch {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const proj of projDirs) {
    const projPath = join(root, proj);
    let files: string[];
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionPath = join(projPath, file);
      try {
        const stats = await stat(sessionPath);
        const cwd = await readJsonlField(sessionPath, "cwd");
        if (!cwd) continue;
        sessions.push({
          agent: "claude",
          cwd: resolve(cwd),
          lastActive: stats.mtime.toISOString(),
          sessionId: file.replace(/\.jsonl$/, ""),
          source: sessionPath,
        });
      } catch {
        // unreadable session, skip
      }
    }
  }
  return sessions;
}

export async function scanCodex(
  roots: string[] = CODEX_ROOTS(),
): Promise<AgentSession[]> {
  // Use the first existing root only. Different Codex installs put their
  // sessions in different places; we don't want to merge stale data from
  // an old install with the current one.
  for (const root of roots) {
    let files: string[];
    try {
      files = await readdir(root);
    } catch {
      continue;
    }
    const sessions: AgentSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl") && !file.endsWith(".json")) continue;
      const sessionPath = join(root, file);
      try {
        const stats = await stat(sessionPath);
        const cwd = await readJsonlField(sessionPath, "cwd");
        if (!cwd) continue;
        sessions.push({
          agent: "codex",
          cwd: resolve(cwd),
          lastActive: stats.mtime.toISOString(),
          sessionId: file.replace(/\.(jsonl|json)$/, ""),
          source: sessionPath,
        });
      } catch {
        // skip
      }
    }
    return sessions;
  }
  return [];
}

export async function scanCopilot(
  root: string = COPILOT_WS_ROOT(),
): Promise<AgentSession[]> {
  if (!root) return [];
  let workspaces: string[];
  try {
    workspaces = await readdir(root);
  } catch {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const ws of workspaces) {
    const wsPath = join(root, ws);
    let folder: string | null = null;
    try {
      const content = await readFile(join(wsPath, "workspace.json"), "utf-8");
      const obj = JSON.parse(content) as { folder?: string };
      if (typeof obj.folder === "string" && obj.folder.startsWith("file://")) {
        folder = decodeURIComponent(obj.folder.replace(/^file:\/\//, ""));
      }
    } catch {
      continue;
    }
    if (!folder) continue;

    const copilotPath = join(wsPath, "github.copilot-chat");
    try {
      const stats = await stat(copilotPath);
      sessions.push({
        agent: "copilot",
        cwd: resolve(folder),
        lastActive: stats.mtime.toISOString(),
        sessionId: ws,
        source: copilotPath,
      });
    } catch {
      // this workspace has no copilot data; skip
    }
  }
  return sessions;
}

export async function detectAgents(): Promise<AgentSession[]> {
  const [claude, codex, copilot] = await Promise.all([
    scanClaude().catch(() => []),
    scanCodex().catch(() => []),
    scanCopilot().catch(() => []),
  ]);
  return [...claude, ...codex, ...copilot];
}

/**
 * Filter agents whose cwd equals or sits under `worktreePath`. Returned
 * sorted newest-first so callers can show the most recent at the top.
 */
export function agentsForWorktree(
  worktreePath: string,
  sessions: AgentSession[],
): AgentSession[] {
  const wt = resolve(worktreePath);
  const wtWithSep = wt.endsWith(sep) ? wt : wt + sep;
  return sessions
    .filter((s) => s.cwd === wt || s.cwd.startsWith(wtWithSep))
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
}
