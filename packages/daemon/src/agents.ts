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

export type AgentKind = "claude" | "codex" | "copilot" | "ollama";

export interface AgentSession {
  agent: AgentKind;
  /** Resolved absolute path of the cwd the agent was working in. */
  cwd: string;
  /** Set when the session was imported from another machine via the
   *  session-share flow. Carries the originating machine's friendly
   *  label so the UI can render an "↓ from <machine>" chip without
   *  needing a second fetch. Absent for native sessions. */
  importedFrom?: string;
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
  /** User + assistant turns with timestamps in the last 4 hours.
   *  Rough activity indicator for the dock's "hot session" badge. */
  recentMessageCount?: number;
  /** ISO timestamp of the last actual user/assistant message in the
   *  JSONL. Use this for "when was this session last touched by a
   *  human/AI" rather than `lastActive` (file mtime), which is
   *  inflated by `claude --resume` and other side writes. */
  lastMessageTs?: string;
  /** Estimated tokens currently in the agent's context window before
   *  the next prompt. For Claude this is exact (last assistant turn's
   *  `usage.input + cache_read + cache_creation`). For Codex 0.130+
   *  it's also exact when a `token_count` event is present
   *  (`last_token_usage.input_tokens`); otherwise it falls back to a
   *  chars/4 estimate. The UI surfaces this in the session header so
   *  the user can eyeball how close they are to the model's context
   *  cap. */
  contextTokens?: number;
  /** True when `contextTokens` came from an authoritative usage block
   *  (Claude `message.usage` / Codex `token_count` event), false when
   *  it's a chars/4 estimate. The UI prefixes estimates with `~`. */
  contextTokensExact?: boolean;
  /** Model context window in tokens, when the JSONL ships it. Codex
   *  0.130+ writes `info.model_context_window` in every `token_count`
   *  event — using that is more accurate than guessing from the
   *  model id, especially for OpenAI's per-deployment cap variations.
   *  The UI prefers this over its model-id heuristic when present. */
  contextWindow?: number;
  /** Model id (e.g. `claude-sonnet-4-6`, `claude-opus-4-7-20250101`,
   *  `gpt-5.5`). Used by the UI for display and, when `contextWindow`
   *  isn't shipped, as the fallback heuristic for the context cap. */
  model?: string;
}

export const CLAUDE_ROOT = () => join(homedir(), ".claude", "projects");

/** Claude Code encodes a session's cwd into a flat dir name under
 *  `~/.claude/projects/` by replacing any path/non-identifier
 *  character with `-`. Verified by inspecting real Claude project
 *  dirs: `/.git/` → `--git-`, `~` → `-`, `.` → `-`. Our previous
 *  implementation only replaced `/`, `\`, `:` and skipped `.`/`~`,
 *  which broke `claude --resume` on cwds containing those characters
 *  (e.g. a folder literally named `package~` — we landed the JSONL
 *  in `<...>js-package~` but Claude looked in `<...>js-package-`).
 *
 *  The filesystem is case-insensitive on Windows + macOS (default
 *  APFS) but case-preserving — the first invocation in a given cwd
 *  locks the casing, and subsequent invocations (potentially with a
 *  differently-cased cwd string) keep appending into the same dir.
 *  We mirror that: encode literally, but if a case-insensitive
 *  sibling already exists, reuse its exact casing so we land in the
 *  same dir Claude itself would write to. */
export async function claudeProjectDirForCwd(
  cwd: string,
  projectsRoot: string = CLAUDE_ROOT(),
): Promise<string> {
  // Strip a single trailing slash/backslash before encoding, otherwise
  // `/p` and `/p/` produce different dirs (`-p` vs `-p-`) and a synced
  // session whose cwd happened to carry a trailing separator becomes
  // invisible to `claude --resume` from the canonical no-trailing form.
  const normalized = cwd.replace(/[/\\]+$/, "") || cwd;
  // Anything not [A-Za-z0-9-] becomes a dash. This matches Claude's
  // own encoder — keep this in sync if Claude's behaviour ever
  // changes (e.g. starts preserving underscores).
  const encoded = normalized.replace(/[^A-Za-z0-9-]/g, "-");
  let entries: string[];
  try {
    entries = await readdir(projectsRoot);
  } catch {
    return join(projectsRoot, encoded);
  }
  const lower = encoded.toLowerCase();
  for (const e of entries) {
    if (e.toLowerCase() === lower) return join(projectsRoot, e);
  }
  return join(projectsRoot, encoded);
}

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
    /<(ide_[a-z_]+|system-reminder|command-[a-z_]+|local-command-stdout|local-command-stderr|turn_aborted)>[\s\S]*?<\/\1>/g,
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
  mtimeMs?: number,
): Promise<{ cwd?: string; title?: string; lastUserMessage?: string }> {
  if (mtimeMs !== undefined) {
    const cached = claudeMetaCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      claudeMetaCache.delete(path);
      claudeMetaCache.set(path, cached);
      return cached.result;
    }
  }
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
  const result = { cwd, title, lastUserMessage };
  if (mtimeMs !== undefined) {
    claudeMetaCache.set(path, { mtimeMs, result });
    if (claudeMetaCache.size > MAX_CLAUDE_META_CACHE) {
      const oldest = claudeMetaCache.keys().next().value;
      if (oldest !== undefined) claudeMetaCache.delete(oldest);
    }
  }
  return result;
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
  /** Sum of `input_tokens + cache_read_input_tokens +
   *  cache_creation_input_tokens` on the most recent assistant turn
   *  that carried a `message.usage` block. Treated as "context size
   *  the model saw on its last turn" — a close proxy for what the
   *  next prompt will be carrying in. Undefined if no assistant turn
   *  carried usage (fresh sessions / old logs). */
  lastContextTokens?: number;
  /** `message.model` from the same most-recent-usage assistant turn.
   *  The UI uses this to pick a context-window cap (200k vs 1M). */
  model?: string;
  /** User + assistant turns whose `timestamp` falls within the last
   *  RECENT_WINDOW_MS. Rough activity indicator — the count is fresh
   *  whenever the JSONL changes (active sessions) but goes stale for
   *  idle sessions whose file hasn't been touched since the last scan. */
  recentMessageCount: number;
  /** ISO timestamp of the most recent user/assistant message in the
   *  JSONL. Distinct from the file mtime because operations like
   *  `claude --resume` touch the file without appending new
   *  messages, which would inflate the file mtime past the actual
   *  last conversation activity. */
  lastMessageTs?: string;
}

/** (path, mtimeMs) → previous scan result. JSONL session files don't change
 *  after a session closes, so most scans across a single /api/agents call
 *  hit the cache and skip a full readFile. A 2,000-file home directory
 *  without this cache reads gigabytes of JSONL every time /api/repos polls
 *  — which is exactly the wedge we observed. Keyed on mtimeMs (not size)
 *  because some agents rewrite files in place; mtime catches that. */
const claudeMetaCache = new Map<
  string,
  {
    mtimeMs: number;
    result: { cwd?: string; title?: string; lastUserMessage?: string };
  }
>();
const MAX_CLAUDE_META_CACHE = 5000;

export function clearClaudeMetaCache(): void {
  claudeMetaCache.clear();
}

interface UserScanCacheEntry {
  mtimeMs: number;
  /** Byte offset we've parsed up to — lets us read only new bytes on
   *  the next call instead of re-reading the whole file. */
  offset: number;
  result: ClaudeUserScanResult;
  /** Whether the background full-scan has completed. When false, the
   *  counts are approximate (from a tail-only read). */
  fullScanDone: boolean;
}

const claudeUserScanCache = new Map<string, UserScanCacheEntry>();

const MAX_CLAUDE_USER_SCAN_CACHE = 5000;

export function clearClaudeUserScanCache(): void {
  claudeUserScanCache.clear();
}

/** Messages within this window from scan-time count toward
 *  `recentMessageCount`. 4 hours matches the dock's "recent activity"
 *  indicator granularity. */
const RECENT_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Parse JSONL lines and update a running ClaudeUserScanResult in
 *  place. Shared by the full-scan, tail-scan, and incremental paths. */
function ingestUserScanLines(
  lines: string,
  result: ClaudeUserScanResult,
  countLines: boolean,
): void {
  const recentCutoff = Date.now() - RECENT_WINDOW_MS;
  for (const line of lines.split("\n")) {
    if (!line) continue;
    if (
      !line.includes('"type":"user"') &&
      !line.includes('"type":"assistant"') &&
      !line.includes('"compact_boundary"')
    ) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Recent-message counter: bump for any user/assistant turn whose
    // timestamp falls within the window. Checked before the
    // tool-result / isMeta filters so pure tool-result entries
    // (which aren't real user turns) still count for the "raw
    // throughput" indicator. isMeta records aren't counted because
    // they're system-injected, not user activity.
    const isRecent =
      typeof obj.timestamp === "string" &&
      Date.parse(obj.timestamp) >= recentCutoff;
    if (obj.type === "user") {
      if (obj.isMeta === true) continue;
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
      if (countLines) result.totalMessageCount++;
      if (isRecent) result.recentMessageCount++;
      if (typeof obj.timestamp === "string") {
        if (
          !result.lastMessageTs ||
          obj.timestamp > result.lastMessageTs
        ) {
          result.lastMessageTs = obj.timestamp;
        }
      }
      const raw = firstTextFromMessageContent(content);
      if (!raw) continue;
      const cleaned = cleanForTitle(raw);
      if (!cleaned) continue;
      const capped = capForTooltip(cleaned);
      if (!result.firstUserMessage) result.firstUserMessage = capped;
      result.lastUserMessages.push(capped);
      if (result.lastUserMessages.length > 3) result.lastUserMessages.shift();
      if (countLines) result.userMessageCount++;
    } else if (obj.type === "assistant") {
      if (countLines) result.totalMessageCount++;
      if (isRecent) result.recentMessageCount++;
      if (typeof obj.timestamp === "string") {
        if (
          !result.lastMessageTs ||
          obj.timestamp > result.lastMessageTs
        ) {
          result.lastMessageTs = obj.timestamp;
        }
      }
      const msg = obj.message as
        | { model?: unknown; usage?: unknown }
        | undefined;
      const usage = msg?.usage as
        | {
            input_tokens?: unknown;
            cache_read_input_tokens?: unknown;
            cache_creation_input_tokens?: unknown;
          }
        | undefined;
      if (usage && typeof usage === "object") {
        const inp =
          typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const cr =
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0;
        const cc =
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : 0;
        result.lastContextTokens = inp + cr + cc;
        result.model = typeof msg?.model === "string" ? msg.model : undefined;
      }
    } else if (obj.type === "system" && obj.subtype === "compact_boundary") {
      result.lastContextTokens = undefined;
    }
  }
}

/** Background full-scan queue. After the fast tail-only scan returns
 *  immediate results, these are processed in small batches so the
 *  daemon stays responsive while backfilling accurate counts. */
const backgroundScanQueue: { path: string; mtimeMs: number }[] = [];
let backgroundScanRunning = false;
const BG_SCAN_BATCH = 5;

function queueBackgroundScan(path: string, mtimeMs: number): void {
  if (backgroundScanQueue.some((e) => e.path === path)) return;
  backgroundScanQueue.push({ path, mtimeMs });
  if (!backgroundScanRunning) {
    backgroundScanRunning = true;
    setTimeout(processBackgroundScans, 50);
  }
}

async function processBackgroundScans(): Promise<void> {
  while (backgroundScanQueue.length > 0) {
    const batch = backgroundScanQueue.splice(0, BG_SCAN_BATCH);
    await Promise.all(
      batch.map(async ({ path, mtimeMs }) => {
        let content: string;
        try {
          content = await readFile(path, "utf-8");
        } catch {
          return;
        }
        const result: ClaudeUserScanResult = {
          lastUserMessages: [],
          userMessageCount: 0,
          totalMessageCount: 0,
          recentMessageCount: 0,
        };
        ingestUserScanLines(content, result, true);
        const entry: UserScanCacheEntry = {
          mtimeMs,
          offset: Buffer.byteLength(content, "utf-8"),
          result,
          fullScanDone: true,
        };
        claudeUserScanCache.delete(path);
        claudeUserScanCache.set(path, entry);
      }),
    );
    // Yield between batches so other requests aren't starved.
    await new Promise((r) => setTimeout(r, 10));
  }
  backgroundScanRunning = false;
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
    // File grew since last scan — read only the new bytes.
    if (cached && cached.fullScanDone) {
      const st = await stat(path).catch(() => null);
      if (st && st.size > cached.offset) {
        const fh = await open(path, "r").catch(() => null);
        if (fh) {
          try {
            const length = st.size - cached.offset;
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, cached.offset);
            ingestUserScanLines(buf.toString("utf-8"), cached.result, true);
            cached.offset = st.size;
            cached.mtimeMs = mtimeMs;
            claudeUserScanCache.delete(path);
            claudeUserScanCache.set(path, cached);
            return cached.result;
          } finally {
            await fh.close();
          }
        }
      }
      // File shrank (truncation/compact) — fall through to fresh scan.
    }
  }
  const TAIL_BYTES = 64 * 1024;
  const st = await stat(path).catch(() => null);
  const fileSize = st?.size ?? 0;
  // Small file (fits in one tail read): parse the whole thing with
  // counts — no background scan needed. Large file: tail-only for
  // immediate results (lastUserMessages, model, contextTokens), then
  // queue a background full scan to backfill accurate counts.
  const isSmall = fileSize <= TAIL_BYTES;
  const tailText = await readTail(path, TAIL_BYTES);
  const result: ClaudeUserScanResult = {
    lastUserMessages: [],
    userMessageCount: 0,
    totalMessageCount: 0,
    recentMessageCount: 0,
  };
  if (tailText) {
    ingestUserScanLines(tailText, result, isSmall);
  }
  if (mtimeMs !== undefined) {
    const entry: UserScanCacheEntry = {
      mtimeMs,
      offset: fileSize,
      result,
      fullScanDone: isSmall,
    };
    claudeUserScanCache.set(path, entry);
    if (claudeUserScanCache.size > MAX_CLAUDE_USER_SCAN_CACHE) {
      const oldest = claudeUserScanCache.keys().next().value;
      if (oldest !== undefined) claudeUserScanCache.delete(oldest);
    }
    if (!isSmall) queueBackgroundScan(path, mtimeMs);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Codex scan cache — mirrors Claude's mtime-keyed LRU so unchanged session
// files never get re-read.  All four per-file Codex helpers write into this
// combined cache entry so a single mtime check guards all of them.
// ---------------------------------------------------------------------------

export interface CodexTokenUsage {
  lastInputTokens?: number;
  modelContextWindow?: number;
  model?: string;
}

interface CodexScanCacheEntry {
  mtimeMs: number;
  messageCount: number;
  contextChars: number;
  usage: CodexTokenUsage;
  meta: { cwd?: string; id?: string };
  firstUserMessage?: string;
  lastUserMessages: string[];
}

const codexScanCache = new Map<string, CodexScanCacheEntry>();
const MAX_CODEX_SCAN_CACHE = 5000;

export function clearCodexScanCache(): void {
  codexScanCache.clear();
}

/** Head bytes for session_meta (Codex 0.130+ embeds 20KB+ system prompt). */
const CODEX_HEAD_BYTES = 64 * 1024;
/** Tail bytes for token_count / turn_context. */
const CODEX_TAIL_BYTES = 64 * 1024;

async function ensureCodexScanCached(
  path: string,
  mtimeMs?: number,
): Promise<CodexScanCacheEntry> {
  if (mtimeMs !== undefined) {
    const cached = codexScanCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      codexScanCache.delete(path);
      codexScanCache.set(path, cached);
      return cached;
    }
  }

  let fileSize = 0;
  try {
    const st = await stat(path);
    fileSize = st.size;
  } catch {
    const empty: CodexScanCacheEntry = {
      mtimeMs: mtimeMs ?? 0,
      messageCount: 0,
      contextChars: 0,
      usage: {
        lastInputTokens: undefined,
        modelContextWindow: undefined,
        model: undefined,
      },
      meta: {},
      lastUserMessages: [],
    };
    codexScanCache.set(path, empty);
    return empty;
  }

  const head = await readHead(path, CODEX_HEAD_BYTES);
  const tail =
    fileSize > CODEX_HEAD_BYTES ? await readTail(path, CODEX_TAIL_BYTES) : null;

  let meta: { cwd?: string; id?: string } = {};
  let lastInputTokens: number | undefined;
  let modelContextWindow: number | undefined;
  let model: string | undefined;

  function ingestMetaAndUsage(text: string): void {
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        !meta.cwd &&
        obj.type === "session_meta" &&
        typeof obj.payload === "object" &&
        obj.payload
      ) {
        const p = obj.payload as Record<string, unknown>;
        meta = {
          cwd: typeof p.cwd === "string" ? p.cwd : undefined,
          id: typeof p.id === "string" ? p.id : undefined,
        };
      }
      if (!meta.cwd && typeof obj.cwd === "string") {
        meta = { cwd: obj.cwd };
      }
      if (
        obj.type === "turn_context" &&
        typeof obj.payload === "object" &&
        obj.payload
      ) {
        const p = obj.payload as Record<string, unknown>;
        if (typeof p.model === "string") model = p.model;
      }
      if (
        obj.type === "event_msg" &&
        typeof obj.payload === "object" &&
        obj.payload
      ) {
        const p = obj.payload as Record<string, unknown>;
        if (p.type === "token_count") {
          const info = p.info;
          if (info && typeof info === "object") {
            const infoObj = info as Record<string, unknown>;
            const last = infoObj.last_token_usage as
              | { input_tokens?: unknown }
              | undefined;
            if (last && typeof last.input_tokens === "number") {
              lastInputTokens = last.input_tokens;
            }
            if (typeof infoObj.model_context_window === "number") {
              modelContextWindow = infoObj.model_context_window;
            }
          }
        }
      }
    }
  }

  ingestMetaAndUsage(head);
  if (tail) ingestMetaAndUsage(tail);

  // Streaming message count + context chars + user message extraction
  // via Bun.file().stream(). Extracts first user message and last 3
  // user messages for session previews.
  let messageCount = 0;
  let contextChars = 0;
  const needContextChars = lastInputTokens === undefined;
  let firstUserMessage: string | undefined;
  const lastUserMessages: string[] = [];
  const MAX_LAST_USER = 3;
  const MSG_CAP = 200;

  /** True when the text looks like a Codex system-injected message
   *  (AGENTS.md, environment_context, permissions) rather than a real
   *  user prompt. These get role:"user" in the JSONL but shouldn't
   *  surface as titles or previews. */
  function isSystemInjected(text: string): boolean {
    const t = text.trimStart();
    if (t.startsWith("<")) return true;
    if (t.startsWith("# AGENTS.md") || t.startsWith("# CLAUDE.md")) return true;
    if (/^#\s+(Instructions|Context|System)\b/i.test(t)) return true;
    return false;
  }

  /** Extract a capped user-message text from a parsed line, skipping
   *  system-injected content that Codex wraps in role:"user". */
  function extractUserText(line: string): string | undefined {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // 0.130+
      if (
        obj.type === "response_item" &&
        typeof obj.payload === "object" &&
        obj.payload
      ) {
        const p = obj.payload as Record<string, unknown>;
        if (
          p.type === "message" &&
          p.role === "user" &&
          Array.isArray(p.content)
        ) {
          for (const block of p.content) {
            if (typeof block === "object" && block !== null) {
              const t = (block as { text?: unknown }).text;
              if (
                typeof t === "string" &&
                t.length > 0 &&
                !isSystemInjected(t)
              ) {
                return t.length > MSG_CAP ? t.slice(0, MSG_CAP) + "…" : t;
              }
            }
          }
        }
      }
      // Pre-0.130
      if (
        obj.role === "user" &&
        typeof obj.content === "string" &&
        obj.content.length > 0 &&
        !isSystemInjected(obj.content)
      ) {
        return obj.content.length > MSG_CAP
          ? obj.content.slice(0, MSG_CAP) + "…"
          : obj.content;
      }
    } catch {
      /* skip */
    }
    return undefined;
  }

  function trackUserMessage(line: string): void {
    if (!line.includes('"user"')) return;
    const text = extractUserText(line);
    if (!text) return;
    if (!firstUserMessage) firstUserMessage = text;
    lastUserMessages.push(text);
    if (lastUserMessages.length > MAX_LAST_USER) lastUserMessages.shift();
  }

  try {
    const stream = Bun.file(path).stream();
    const decoder = new TextDecoder();
    let leftover = "";

    for await (const chunk of stream) {
      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        if (line.includes('"response_item"')) {
          if (line.includes('"user"') || line.includes('"assistant"')) {
            messageCount++;
            if (line.includes('"user"')) trackUserMessage(line);
            if (needContextChars) {
              try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                if (
                  obj.type === "response_item" &&
                  typeof obj.payload === "object" &&
                  obj.payload
                ) {
                  const p = obj.payload as Record<string, unknown>;
                  if (p.type === "message") {
                    if (Array.isArray(p.content)) {
                      for (const block of p.content) {
                        if (typeof block === "object" && block !== null) {
                          const t = (block as { text?: unknown }).text;
                          if (typeof t === "string") contextChars += t.length;
                        }
                      }
                    } else if (typeof p.content === "string") {
                      contextChars += (p.content as string).length;
                    }
                  }
                }
              } catch {
                /* count stands */
              }
            }
          }
          continue;
        }
        if (
          line.includes('"role"') &&
          (line.includes('"user"') || line.includes('"assistant"'))
        ) {
          messageCount++;
          if (line.includes('"user"')) trackUserMessage(line);
          if (needContextChars) {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              if (typeof obj.content === "string")
                contextChars += obj.content.length;
            } catch {
              /* skip */
            }
          }
        }
      }
    }
    if (
      leftover &&
      (leftover.includes('"response_item"') || leftover.includes('"role"'))
    ) {
      if (leftover.includes('"user"') || leftover.includes('"assistant"')) {
        messageCount++;
        if (leftover.includes('"user"')) trackUserMessage(leftover);
        if (needContextChars) {
          try {
            const obj = JSON.parse(leftover) as Record<string, unknown>;
            if (
              obj.type === "response_item" &&
              typeof obj.payload === "object" &&
              obj.payload
            ) {
              const p = obj.payload as Record<string, unknown>;
              if (p.type === "message") {
                if (Array.isArray(p.content)) {
                  for (const block of p.content) {
                    if (typeof block === "object" && block !== null) {
                      const t = (block as { text?: unknown }).text;
                      if (typeof t === "string") contextChars += t.length;
                    }
                  }
                } else if (typeof p.content === "string") {
                  contextChars += (p.content as string).length;
                }
              }
            } else if (typeof obj.content === "string") {
              contextChars += obj.content.length;
            }
          } catch {
            /* partial line */
          }
        }
      }
    }
  } catch {
    // File unreadable — keep whatever we got from head/tail.
  }

  const usage: CodexTokenUsage = { lastInputTokens, modelContextWindow, model };
  const entry: CodexScanCacheEntry = {
    mtimeMs: mtimeMs ?? 0,
    messageCount,
    contextChars,
    usage,
    meta,
    firstUserMessage,
    lastUserMessages,
  };

  codexScanCache.set(path, entry);
  if (codexScanCache.size > MAX_CODEX_SCAN_CACHE) {
    const oldest = codexScanCache.keys().next().value;
    if (oldest !== undefined) codexScanCache.delete(oldest);
  }

  return entry;
}

export async function scanCodexMessageCount(
  path: string,
  mtimeMs?: number,
): Promise<number> {
  const entry = await ensureCodexScanCached(path, mtimeMs);
  return entry.messageCount;
}

export async function scanCodexTokenUsage(
  path: string,
  mtimeMs?: number,
): Promise<CodexTokenUsage> {
  const entry = await ensureCodexScanCached(path, mtimeMs);
  return entry.usage;
}

export async function scanCodexContextTokens(
  path: string,
  mtimeMs?: number,
): Promise<number> {
  const entry = await ensureCodexScanCached(path, mtimeMs);
  return Math.floor(entry.contextChars / 4);
}

/** UUID pattern — Claude uses v4 UUIDs for session directories. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** For a directory-based session (`<project>/<uuid>/`), find the most
 *  recently modified `.jsonl` inside `<uuid>/subagents/` and return its
 *  path + mtime. Returns null if nothing usable is found. */
async function bestSubagentFile(
  sessionDir: string,
): Promise<{ path: string; mtimeMs: number; mtime: Date } | null> {
  const subDir = join(sessionDir, "subagents");
  let entries: string[];
  try {
    entries = await readdir(subDir);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number; mtime: Date } | null = null;
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    const full = join(subDir, e);
    try {
      const st = await stat(full);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { path: full, mtimeMs: st.mtimeMs, mtime: st.mtime };
      }
    } catch {
      // skip unreadable
    }
  }
  return best;
}

/** Build an AgentSession from a Claude JSONL file. Shared by both the
 *  flat-file and directory-based code paths. */
async function claudeSessionFromFile(
  sessionPath: string,
  sessionId: string,
  fileStat: { mtimeMs: number; mtime: Date },
): Promise<AgentSession | null> {
  const meta = await readClaudeSessionMeta(sessionPath, fileStat.mtimeMs);
  if (!meta.cwd) return null;
  const userStats = await scanClaudeUserMessages(sessionPath, fileStat.mtimeMs);
  return {
    agent: "claude",
    cwd: resolve(meta.cwd),
    lastActive: fileStat.mtime.toISOString(),
    sessionId,
    source: sessionPath,
    title: meta.title,
    lastUserMessage: meta.lastUserMessage,
    firstUserMessage: userStats.firstUserMessage,
    lastUserMessages:
      userStats.lastUserMessages.length > 0
        ? userStats.lastUserMessages
        : undefined,
    userMessageCount:
      userStats.userMessageCount > 0 ? userStats.userMessageCount : undefined,
    messageCount:
      userStats.totalMessageCount > 0 ? userStats.totalMessageCount : undefined,
    recentMessageCount:
      userStats.recentMessageCount > 0
        ? userStats.recentMessageCount
        : undefined,
    lastMessageTs: userStats.lastMessageTs,
    contextTokens: userStats.lastContextTokens,
    contextTokensExact:
      userStats.lastContextTokens !== undefined ? true : undefined,
    model: userStats.model,
  };
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
  const perProject = await Promise.all(
    projDirs.map(async (proj) => {
      const projPath = join(root, proj);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(projPath, { withFileTypes: true });
      } catch {
        return [];
      }
      // Pass 1: flat .jsonl files (original format) — parallel.
      const flatEntries = entries.filter(
        (e) => e.isFile() && e.name.endsWith(".jsonl"),
      );
      const flatResults = await Promise.all(
        flatEntries.map(async (entry) => {
          const sessionPath = join(projPath, entry.name);
          const sessionId = entry.name.replace(/\.jsonl$/, "");
          try {
            const stats = await stat(sessionPath);
            const session = await claudeSessionFromFile(
              sessionPath,
              sessionId,
              stats,
            );
            return session ? { sessionId, session } : null;
          } catch {
            return null;
          }
        }),
      );
      const sessions: AgentSession[] = [];
      const seenIds = new Set<string>();
      for (const r of flatResults) {
        if (r) {
          sessions.push(r.session);
          seenIds.add(r.sessionId);
        }
      }
      // Pass 2: directory-based sessions (newer Claude format) — parallel.
      const dirEntries = entries.filter(
        (e) => e.isDirectory() && UUID_RE.test(e.name) && !seenIds.has(e.name),
      );
      const dirResults = await Promise.all(
        dirEntries.map(async (entry) => {
          const sessionDir = join(projPath, entry.name);
          try {
            const best = await bestSubagentFile(sessionDir);
            if (!best) return null;
            return await claudeSessionFromFile(best.path, entry.name, best);
          } catch {
            return null;
          }
        }),
      );
      for (const s of dirResults) {
        if (s) sessions.push(s);
      }
      return sessions;
    }),
  );
  return perProject.flat();
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
  mtimeMs?: number,
): Promise<{ cwd?: string; id?: string }> {
  const entry = await ensureCodexScanCached(path, mtimeMs);
  return entry.meta;
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
    const tScan = performance.now();
    const files = await collectCodexSessionFiles(root);
    const tCollect = performance.now() - tScan;
    const sessions: AgentSession[] = [];
    let slowestFile = "";
    let slowestMs = 0;
    for (const sessionPath of files) {
      try {
        const tFile = performance.now();
        const stats = await stat(sessionPath);
        const mt = stats.mtimeMs;
        const meta = await readCodexSessionMeta(sessionPath, mt);
        if (!meta.cwd) continue;
        const messageCount = await scanCodexMessageCount(sessionPath, mt);
        const usage = await scanCodexTokenUsage(sessionPath, mt);
        let contextTokens: number | undefined;
        let contextTokensExact: boolean | undefined;
        if (usage.lastInputTokens !== undefined && usage.lastInputTokens > 0) {
          contextTokens = usage.lastInputTokens;
          contextTokensExact = true;
        } else {
          const estimate = await scanCodexContextTokens(sessionPath, mt);
          if (estimate > 0) {
            contextTokens = estimate;
            contextTokensExact = false;
          }
        }
        const fileMs = performance.now() - tFile;
        if (fileMs > slowestMs) {
          slowestMs = fileMs;
          slowestFile = sessionPath;
        }
        const cached = codexScanCache.get(sessionPath);
        const lastMsgs = cached?.lastUserMessages ?? [];
        sessions.push({
          agent: "codex",
          cwd: resolve(meta.cwd),
          lastActive: stats.mtime.toISOString(),
          sessionId:
            meta.id ??
            sessionPath
              .split(/[/\\]/)
              .pop()!
              .replace(/\.(jsonl|json)$/, ""),
          source: sessionPath,
          title: cached?.firstUserMessage,
          firstUserMessage: cached?.firstUserMessage,
          lastUserMessage: lastMsgs[lastMsgs.length - 1],
          lastUserMessages: lastMsgs.length > 0 ? lastMsgs : undefined,
          userMessageCount:
            messageCount > 0 ? Math.ceil(messageCount / 2) : undefined,
          messageCount: messageCount > 0 ? messageCount : undefined,
          contextTokens,
          contextTokensExact,
          contextWindow: usage.modelContextWindow,
          model: usage.model,
        });
      } catch {
        // skip
      }
    }
    const totalMs = performance.now() - tScan;
    if (totalMs > 500) {
      console.log(
        `supergit daemon: scanCodex ${totalMs.toFixed(0)}ms — ` +
          `collect=${tCollect.toFixed(0)}ms files=${files.length} sessions=${sessions.length}` +
          (slowestFile
            ? ` slowest=${slowestMs.toFixed(0)}ms ${slowestFile.split("/").pop()}`
            : ""),
      );
    }
    // Detect Codex subagent batches: multiple sessions sharing the
    // same rollout timestamp were spawned together. Tag all but the
    // largest (by messageCount) so the UI can show a "subagent" hint.
    const rolloutRe = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/;
    const byRollout = new Map<string, AgentSession[]>();
    for (const s of sessions) {
      const m = rolloutRe.exec(s.source);
      if (m) {
        const arr = byRollout.get(m[1]!);
        if (arr) arr.push(s);
        else byRollout.set(m[1]!, [s]);
      }
    }
    for (const group of byRollout.values()) {
      if (group.length <= 1) continue;
      group.sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0));
      for (let i = 1; i < group.length; i++) {
        const s = group[i]!;
        if (!s.title) s.title = "subagent";
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

/** Read the workspace's `ollama/` directory of session headers and lift
 *  them into the AgentSession shape. Ollama doesn't write transcripts
 *  to disk, so the entries carry only what the daemon recorded at spawn:
 *  the picked model (used as the title), worktree, cwd, and the file's
 *  mtime as lastActive. `sessionId` is the termId — unique per spawn —
 *  so the UI's per-worktree picker can deduplicate against live PTYs. */
export async function scanOllama(
  workspacePath: string,
): Promise<AgentSession[]> {
  const dir = join(workspacePath, "ollama");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const text = await readFile(path, "utf-8");
      const firstLine = text.split("\n", 1)[0];
      if (!firstLine) continue;
      const obj = JSON.parse(firstLine) as {
        kind?: string;
        termId?: string;
        wt?: string;
        spawnCwd?: string;
        model?: string;
        createdAt?: string;
      };
      if (
        obj.kind !== "header" ||
        typeof obj.termId !== "string" ||
        typeof obj.spawnCwd !== "string" ||
        typeof obj.model !== "string"
      ) {
        continue;
      }
      const st = await stat(path);
      sessions.push({
        agent: "ollama",
        cwd: resolve(obj.spawnCwd),
        lastActive: st.mtime.toISOString(),
        sessionId: obj.termId,
        source: path,
        // Use the model tag as the title — every UI surface that
        // displays an Ollama session row keys identification off it.
        title: obj.model,
        model: obj.model,
      });
    } catch {
      // skip malformed entries
    }
  }
  return sessions;
}

/** Walk `<workspace>/imported-sessions/<machine>/<agent>/` and surface
 *  every import as an AgentSession. Two layouts coexist:
 *
 *   - **New (claude):** sidecar `.manifest.json` lives here, but the
 *     rewritten JSONL itself lives under `~/.claude/projects/...`. The
 *     sidecar's `importedJsonlPath` points at the real file. These
 *     entries' `source` matches what `scanClaude` would return, so
 *     `detectAgents` dedupes them and just attaches the `importedFrom`
 *     annotation onto the native entry.
 *
 *   - **Legacy / codex:** the JSONL sits next to the sidecar under
 *     `imported-sessions/...` and `source` points there. These show up
 *     as standalone entries with no native counterpart.
 *
 *  Orphans (a `.jsonl` with no sidecar) get a best-effort entry so the
 *  file isn't invisible. */
export async function scanImported(
  workspacePath: string,
): Promise<AgentSession[]> {
  const root = join(workspacePath, "imported-sessions");
  let machines: string[];
  try {
    machines = await readdir(root);
  } catch {
    return [];
  }
  const out: AgentSession[] = [];
  for (const machine of machines) {
    let agentDirs: string[];
    try {
      agentDirs = await readdir(join(root, machine));
    } catch {
      continue;
    }
    for (const agentDir of agentDirs) {
      if (
        agentDir !== "claude" &&
        agentDir !== "codex" &&
        agentDir !== "ollama"
      )
        continue;
      const dir = join(root, machine, agentDir);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      const sidecarBySid = new Map<string, string>();
      const jsonlBySid = new Map<string, string>();
      for (const name of entries) {
        if (name.endsWith(".manifest.json")) {
          sidecarBySid.set(name.replace(/\.manifest\.json$/, ""), name);
        } else if (name.endsWith(".jsonl")) {
          const sid = name.replace(/\.jsonl$/, "").replace(/\.from-\d+$/, "");
          jsonlBySid.set(sid, name);
        }
      }
      // Pass 1: each sidecar surfaces an import. The JSONL might be at
      // sidecar.importedJsonlPath (new layout) or sibling (legacy).
      for (const [sid, sidecarName] of sidecarBySid) {
        const sidecarPath = join(dir, sidecarName);
        let sidecar: {
          sid?: string;
          title?: string;
          originMachineLabel?: string;
          localRepoPath?: string;
          localWorktreePath?: string;
          importedJsonlPath?: string;
        };
        try {
          sidecar = JSON.parse(await readFile(sidecarPath, "utf-8"));
        } catch {
          continue;
        }
        const cwd = sidecar.localWorktreePath || sidecar.localRepoPath || "";
        if (!cwd) continue;
        const siblingJsonl = jsonlBySid.get(sid);
        const jsonlPath =
          sidecar.importedJsonlPath ??
          (siblingJsonl ? join(dir, siblingJsonl) : null);
        if (!jsonlPath) continue;
        let st;
        try {
          st = await stat(jsonlPath);
        } catch {
          // JSONL missing (file deleted, moved, perm issue) — drop
          // the listing so we don't surface a dead source. The
          // sidecar can be cleaned up by hand or by the next accept.
          continue;
        }
        out.push({
          agent: agentDir as "claude" | "codex" | "ollama",
          cwd: resolve(cwd),
          lastActive: st.mtime.toISOString(),
          sessionId: sidecar.sid ?? sid,
          source: jsonlPath,
          title: sidecar.title,
          importedFrom: sidecar.originMachineLabel ?? machine,
        });
        jsonlBySid.delete(sid);
      }
      // Pass 2: orphan JSONLs (no sidecar). Best-effort metadata so
      // the user sees the file rather than nothing.
      for (const [sid, name] of jsonlBySid) {
        const jsonlPath = join(dir, name);
        try {
          const st = await stat(jsonlPath);
          out.push({
            agent: agentDir as "claude" | "codex" | "ollama",
            cwd: "",
            lastActive: st.mtime.toISOString(),
            sessionId: sid,
            source: jsonlPath,
            importedFrom: machine,
          });
        } catch {
          // skip
        }
      }
    }
  }
  return out;
}

export async function detectAgents(
  workspacePath?: string,
): Promise<AgentSession[]> {
  const t0 = performance.now();
  const [claude, codex, copilot, ollama, imported] = await Promise.all([
    scanClaude().catch(() => []),
    scanCodex().catch(() => []),
    scanCopilot().catch(() => []),
    workspacePath
      ? scanOllama(workspacePath).catch(() => [])
      : Promise.resolve([] as AgentSession[]),
    workspacePath
      ? scanImported(workspacePath).catch(() => [])
      : Promise.resolve([] as AgentSession[]),
  ]);
  const elapsed = performance.now() - t0;
  if (elapsed > 500) {
    console.log(
      `supergit daemon: detectAgents ${elapsed.toFixed(0)}ms — ` +
        `claude=${claude.length} codex=${codex.length} copilot=${copilot.length} ` +
        `ollama=${ollama.length} imported=${imported.length}`,
    );
  }
  // Imported claude sessions live under `~/.claude/projects/...` and so
  // also show up in `scanClaude` results. Dedupe by source: keep the
  // native entry (richer stats) and attach the sidecar's
  // `importedFrom` (+ title fallback) so the UI can still badge it as
  // "↓ from <machine>". Imports with no native counterpart (codex,
  // legacy, or a JSONL that no longer exists in claude-projects) are
  // appended as-is.
  const bySource = new Map<string, AgentSession>();
  for (const s of [...claude, ...codex, ...copilot, ...ollama]) {
    bySource.set(s.source, s);
  }
  for (const s of imported) {
    const existing = bySource.get(s.source);
    if (existing) {
      if (s.importedFrom && !existing.importedFrom) {
        existing.importedFrom = s.importedFrom;
      }
      if (s.title && !existing.title) existing.title = s.title;
    } else {
      bySource.set(s.source, s);
    }
  }
  return [...bySource.values()];
}

/**
 * Filter agents whose cwd equals or sits under `worktreePath`. Returned
 * sorted newest-first so callers can show the most recent at the top.
 */
// On Windows, drive letters can differ in case (c:\ vs C:\) and the
// filesystem is case-insensitive, so all path comparisons must be
// case-insensitive. On Unix, paths are case-sensitive.
const normCase =
  process.platform === "win32"
    ? (s: string) => s.toLowerCase()
    : (s: string) => s;

export function agentsForWorktree(
  worktreePath: string,
  sessions: AgentSession[],
): AgentSession[] {
  const wt = normCase(resolve(worktreePath));
  const wtWithSep = wt.endsWith(sep) ? wt : wt + sep;
  return sessions
    .filter((s) => {
      const c = normCase(s.cwd);
      return c === wt || c.startsWith(wtWithSep);
    })
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
}

/**
 * A folder the user might want to add to the dashboard, derived from the
 * cwd of a detected agent session. Groups every session that ran in the
 * same cwd into a single suggestion with the rolled-up count of sessions
 * and the most recent activity timestamp.
 *
 * `repoUrl` and `alreadyRegistered` are NOT computed here — they're a
 * job for the route handler that has access to git + the workspace's
 * repo list. This helper stays pure for testability.
 */
export interface FolderSuggestion {
  path: string;
  name: string;
  sessionCount: number;
  lastActive: string;
  agents: AgentKind[];
}

/**
 * Group sessions by their resolved cwd and produce one suggestion per
 * distinct folder. Sessions with no cwd are skipped. Folders whose
 * normalised path is in `suppress` (already-registered repos and their
 * worktrees) are filtered out. Result is sorted newest-active first.
 *
 * Case-insensitive comparison on Windows; case-sensitive on Unix.
 */
export function groupSessionsByFolder(
  sessions: AgentSession[],
  suppress: Set<string> = new Set(),
): FolderSuggestion[] {
  // Group by normalised path so windows c:\ === C:\.
  const byKey = new Map<
    string,
    {
      path: string;
      sessions: AgentSession[];
      agents: Set<AgentKind>;
      lastActive: string;
    }
  >();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const resolved = resolve(s.cwd);
    const key = normCase(resolved);
    if (suppress.has(key)) continue;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        path: resolved,
        sessions: [],
        agents: new Set(),
        lastActive: s.lastActive,
      };
      byKey.set(key, entry);
    }
    entry.sessions.push(s);
    entry.agents.add(s.agent);
    if (Date.parse(s.lastActive) > Date.parse(entry.lastActive)) {
      entry.lastActive = s.lastActive;
    }
  }
  const out: FolderSuggestion[] = [];
  for (const e of byKey.values()) {
    out.push({
      path: e.path,
      name: e.path.split(sep).filter(Boolean).pop() ?? e.path,
      sessionCount: e.sessions.length,
      lastActive: e.lastActive,
      agents: [...e.agents].sort(),
    });
  }
  out.sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive));
  return out;
}
