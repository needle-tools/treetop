/**
 * Detect active AI agent sessions (Claude Code, OpenAI Codex CLI, VSCode
 * Copilot Chat) by scanning each agent's known filesystem layout. Each
 * scanner is independent and best-effort — a missing or unreadable dir
 * just yields zero sessions, no error propagates.
 *
 * The daemon does not start agents; this is observation only.
 */

import { readdir, stat, readFile, open } from "node:fs/promises";
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
  /** Short human-readable title: Claude's auto-summary or the first user
   *  prompt, capped to ~80 chars. Undefined when nothing usable was found. */
  title?: string;
  /** The most recent *user* message in the session (capped). Surfaced on
   *  hover in the session picker so you can tell sessions apart even when
   *  the title's identical or generic. */
  lastUserMessage?: string;
  /** User-provided title for this session (stored in the workspace,
   *  keyed by `source`). When set, the UI prefers it over `title`. */
  manualTitle?: string;
  /** First user prompt, cleaned. Surfaced in the session popover so the
   *  reader can recall what kicked the session off, independently of
   *  `title` (which may have come from a `summary` line). */
  firstUserMessage?: string;
  /** Up to the last 3 user prompts, oldest-first. The most recent one
   *  is also available as `lastUserMessage`. */
  lastUserMessages?: string[];
  /** Total number of non-empty user prompts in the session. Used to
   *  render "[… N more messages …]" between the first and the last 3
   *  in the tooltip. */
  userMessageCount?: number;
  /** Total messages in the session — both user and assistant turns
   *  for Claude; both user-role and assistant-role response_items for
   *  Codex. Surfaced as a cell in the agents popover so the user can
   *  tell at a glance how much conversation each session contains. */
  messageCount?: number;
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

/** Read at most `bytes` bytes from the start of `path`. Avoids slurping
 *  multi-megabyte session files when we only need the first few events. */
async function readHead(path: string, bytes = 64 * 1024): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function firstTextFromMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) continue;
      const b = raw as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return undefined;
}

function cleanForTitle(txt: string): string {
  // Strip Claude's injected wrapper blocks before considering the text
  // as a candidate title.
  const stripped = txt.replace(
    /<(ide_[a-z_]+|system-reminder|command-[a-z_]+|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g,
    "",
  );
  return stripped.replace(/\s+/g, " ").trim();
}

/** Read at most `bytes` from the END of `path`. Used to find the most
 *  recent user message in long session files where the head doesn't
 *  contain it. The first line of the slice may be a partial line; we
 *  drop it. */
async function readTail(path: string, bytes = 64 * 1024): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, "r");
    const stats = await fh.stat();
    const fileSize = stats.size;
    const length = Math.min(bytes, fileSize);
    const start = Math.max(0, fileSize - length);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const text = buf.toString("utf-8");
    // If we didn't start at byte 0, the first line is likely a fragment.
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : "";
  } catch {
    return "";
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Pull cwd + a short human title + last-user-message out of a Claude
 *  session JSONL. Title fallback chain: explicit `summary` → first user
 *  prompt → most recent user prompt → first assistant text. Reads the
 *  first 256KB for title material, plus the last 64KB so the most-recent
 *  user message is accurate even when the head and tail of a long
 *  session don't overlap. */
export async function readClaudeSessionMeta(
  path: string,
): Promise<{ cwd?: string; title?: string; lastUserMessage?: string }> {
  const head = await readHead(path, 256 * 1024);
  if (!head) return {};
  let cwd: string | undefined;
  let summary: string | undefined;
  let firstUserText: string | undefined;
  let lastUserText: string | undefined;
  let firstAssistantText: string | undefined;

  const ingestUser = (raw: string | undefined) => {
    if (!raw) return;
    const cleaned = cleanForTitle(raw);
    if (!cleaned) return;
    if (!firstUserText) firstUserText = cleaned;
    lastUserText = cleaned;
  };

  for (const line of head.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (obj.type === "summary" && typeof obj.summary === "string" && !summary) {
      summary = obj.summary;
    }
    if (obj.type === "user") {
      const msg = obj.message as { content?: unknown } | undefined;
      ingestUser(firstTextFromMessageContent(msg?.content));
    } else if (obj.type === "assistant" && !firstAssistantText) {
      const msg = obj.message as { content?: unknown } | undefined;
      const raw = firstTextFromMessageContent(msg?.content);
      if (raw) {
        const cleaned = cleanForTitle(raw);
        if (cleaned) firstAssistantText = cleaned;
      }
    }
  }

  // Long-session correction: also scan the file's tail for any newer user
  // messages we missed in the head.
  const tail = await readTail(path, 64 * 1024);
  if (tail) {
    for (const line of tail.split("\n")) {
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type === "user") {
        const msg = obj.message as { content?: unknown } | undefined;
        ingestUser(firstTextFromMessageContent(msg?.content));
      }
    }
  }

  let title = summary ?? firstUserText ?? lastUserText ?? firstAssistantText;
  if (title) {
    if (title.length > 120) title = title.slice(0, 119) + "…";
  }
  let lastUserMessage = lastUserText;
  if (lastUserMessage && lastUserMessage.length > 600) {
    lastUserMessage = lastUserMessage.slice(0, 599) + "…";
  }
  return { cwd, title, lastUserMessage };
}

/** Per-prompt cap for the tooltip-friendly user-message snapshot. The
 *  popover renders 4 messages plus a separator inside a native browser
 *  tooltip; each one needs to stay readable but compact. 360 chars is
 *  enough for a paragraph; longer messages get ellipsized. */
const USER_MESSAGE_CAP = 360;

function capForTooltip(s: string): string {
  if (s.length <= USER_MESSAGE_CAP) return s;
  return s.slice(0, USER_MESSAGE_CAP - 1) + "…";
}

/** Stream the whole session file and collect just the user-message
 *  shape used by the session popover tooltip: the first user prompt,
 *  the last 3, and the total count. Lines that don't contain
 *  `"type":"user"` are skipped without parsing; matching lines are
 *  JSON-parsed and their text content extracted via the same
 *  cleanForTitle pipeline that produces titles, so wrapper junk
 *  (`<command-name>`, `<ide_opened_file>`, etc.) is excluded.
 *
 *  Returns zeroed stats on read failure, so a missing or unreadable
 *  file just leaves the popover with the title and nothing else —
 *  no error propagates. */
interface ClaudeUserScanResult {
  firstUserMessage?: string;
  lastUserMessages: string[];
  userMessageCount: number;
  /** Total user + assistant turns. Tool-result-only "user" entries
   *  (Anthropic's API convention; the parser relabels these as role
   *  "tool" elsewhere) are excluded from this count. */
  totalMessageCount: number;
}

/** (path, mtimeMs) → previous scan result. JSONL session files don't change
 *  after a session closes, so most scans across a single /api/agents call
 *  hit the cache and skip a full readFile. A 2,000-file home directory
 *  without this cache reads gigabytes of JSONL every time /api/repos polls
 *  — which is exactly the wedge we observed. Keyed on mtimeMs (not size)
 *  because some agents rewrite files in place; mtime catches that. */
const claudeUserScanCache = new Map<
  string,
  { mtimeMs: number; result: ClaudeUserScanResult }
>();

/** Bounded; reset on miss when above. Sessions count is ~2k for an active
 *  user — generous headroom + LRU eviction. */
const MAX_CLAUDE_USER_SCAN_CACHE = 5000;

export function clearClaudeUserScanCache(): void {
  claudeUserScanCache.clear();
}

export async function scanClaudeUserMessages(
  path: string,
  mtimeMs?: number,
): Promise<ClaudeUserScanResult> {
  if (mtimeMs !== undefined) {
    const cached = claudeUserScanCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      // LRU touch.
      claudeUserScanCache.delete(path);
      claudeUserScanCache.set(path, cached);
      return cached.result;
    }
  }
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { lastUserMessages: [], userMessageCount: 0, totalMessageCount: 0 };
  }
  let firstUserMessage: string | undefined;
  const tail: string[] = [];
  let userCount = 0;
  let totalCount = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    // Cheap pre-filter so we don't JSON.parse every line on huge files.
    if (
      !line.includes('"type":"user"') &&
      !line.includes('"type":"assistant"')
    ) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "user") {
      // Tool-result-only "user" turns (an Anthropic API convention)
      // shouldn't be counted as conversation. Detect by inspecting
      // message.content blocks.
      const msg = obj.message as { content?: unknown } | undefined;
      const content = msg?.content;
      const isToolResultOnly = (() => {
        if (!Array.isArray(content)) return false;
        if (content.length === 0) return false;
        return content.every(
          (b) =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "tool_result",
        );
      })();
      if (isToolResultOnly) continue;
      totalCount++;
      const raw = firstTextFromMessageContent(content);
      if (!raw) continue;
      const cleaned = cleanForTitle(raw);
      if (!cleaned) continue;
      const capped = capForTooltip(cleaned);
      if (!firstUserMessage) firstUserMessage = capped;
      tail.push(capped);
      if (tail.length > 3) tail.shift();
      userCount++;
    } else if (obj.type === "assistant") {
      totalCount++;
    }
  }
  const result: ClaudeUserScanResult = {
    firstUserMessage,
    lastUserMessages: tail,
    userMessageCount: userCount,
    totalMessageCount: totalCount,
  };
  if (mtimeMs !== undefined) {
    claudeUserScanCache.set(path, { mtimeMs, result });
    if (claudeUserScanCache.size > MAX_CLAUDE_USER_SCAN_CACHE) {
      const oldest = claudeUserScanCache.keys().next().value;
      if (oldest !== undefined) claudeUserScanCache.delete(oldest);
    }
  }
  return result;
}

/** Total chat-turn count for a Codex JSONL. Counts `response_item`
 *  lines where payload.type is "message" — the 0.130+ message shape —
 *  with role being user or assistant only. Developer/system injected
 *  messages don't count. Falls back to top-level role+content lines
 *  for older flat-format sessions. */
export async function scanCodexMessageCount(path: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "response_item" && typeof obj.payload === "object" && obj.payload) {
      const p = obj.payload as Record<string, unknown>;
      if (p.type !== "message") continue;
      if (p.role === "user" || p.role === "assistant") count++;
      continue;
    }
    // Pre-0.130 flat form.
    if (
      typeof obj.role === "string" &&
      (obj.role === "user" || obj.role === "assistant")
    ) {
      count++;
    }
  }
  return count;
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
        const meta = await readClaudeSessionMeta(sessionPath);
        if (!meta.cwd) continue;
        // Full user-message scan: accurate count + last 3 even when the
        // head/tail snippets readClaudeSessionMeta uses don't overlap.
        // The scan caches by (path, mtimeMs) so unchanged files don't
        // re-read multi-MB JSONLs on every /api/repos call.
        const userStats = await scanClaudeUserMessages(
          sessionPath,
          stats.mtimeMs,
        );
        sessions.push({
          agent: "claude",
          cwd: resolve(meta.cwd),
          lastActive: stats.mtime.toISOString(),
          sessionId: file.replace(/\.jsonl$/, ""),
          source: sessionPath,
          title: meta.title,
          lastUserMessage: meta.lastUserMessage,
          firstUserMessage: userStats.firstUserMessage,
          lastUserMessages: userStats.lastUserMessages.length > 0
            ? userStats.lastUserMessages
            : undefined,
          userMessageCount: userStats.userMessageCount > 0
            ? userStats.userMessageCount
            : undefined,
          messageCount: userStats.totalMessageCount > 0
            ? userStats.totalMessageCount
            : undefined,
        });
      } catch {
        // unreadable session, skip
      }
    }
  }
  return sessions;
}

/** Recursively collect `.jsonl` / `.json` files under `dir`. Codex
 *  0.130+ partitions sessions by date (`YYYY/MM/DD/rollout-...jsonl`),
 *  so a flat readdir misses everything. Bounded to a small max depth
 *  so a malformed root can't run away. */
async function collectCodexSessionFiles(
  dir: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 5) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectCodexSessionFiles(full, depth + 1)));
    } else if (
      e.isFile() &&
      (e.name.endsWith(".jsonl") || e.name.endsWith(".json"))
    ) {
      // ~/.codex/history.jsonl is codex's shell-style global command
      // history, not a session file. Skip files named "history.*" at
      // the root so they don't show up as ghost sessions.
      if (depth === 0 && /^history\.(jsonl|json)$/.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/** Pull cwd + session id out of a codex JSONL. Codex 0.130+ stores
 *  these under a `session_meta` block (`payload.cwd`, `payload.id`);
 *  older codex versions and our flat fixtures put `cwd` at the top
 *  level. Returns whichever is found first; `id` defaults to null so
 *  callers can fall back to the filename basename. */
async function readCodexSessionMeta(
  path: string,
): Promise<{ cwd?: string; id?: string }> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return {};
  }
  let topCwd: string | undefined;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // 0.130+ form: { type: "session_meta", payload: { id, cwd, ... } }
    if (obj.type === "session_meta" && typeof obj.payload === "object" && obj.payload !== null) {
      const p = obj.payload as Record<string, unknown>;
      const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
      const id = typeof p.id === "string" ? p.id : undefined;
      if (cwd || id) return { cwd, id };
    }
    // Pre-0.130 / fixture form: top-level cwd somewhere in the file.
    if (!topCwd && typeof obj.cwd === "string") {
      topCwd = obj.cwd;
    }
  }
  return { cwd: topCwd };
}

export async function scanCodex(
  roots: string[] = CODEX_ROOTS(),
): Promise<AgentSession[]> {
  // Use the first existing root only. Different Codex installs put their
  // sessions in different places; we don't want to merge stale data from
  // an old install with the current one.
  for (const root of roots) {
    let rootExists = true;
    try {
      await stat(root);
    } catch {
      rootExists = false;
    }
    if (!rootExists) continue;
    const files = await collectCodexSessionFiles(root);
    const sessions: AgentSession[] = [];
    for (const sessionPath of files) {
      try {
        const stats = await stat(sessionPath);
        const meta = await readCodexSessionMeta(sessionPath);
        if (!meta.cwd) continue;
        const messageCount = await scanCodexMessageCount(sessionPath);
        sessions.push({
          agent: "codex",
          cwd: resolve(meta.cwd),
          lastActive: stats.mtime.toISOString(),
          // Prefer the in-file id (what `codex resume <id>` expects)
          // over the filename basename, since the filename includes a
          // `rollout-<iso>-` prefix that's not a valid id.
          sessionId: meta.id ?? sessionPath.split("/").pop()!.replace(/\.(jsonl|json)$/, ""),
          source: sessionPath,
          messageCount: messageCount > 0 ? messageCount : undefined,
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
