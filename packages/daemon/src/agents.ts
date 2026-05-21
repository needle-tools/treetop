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
  let lastContextTokens: number | undefined;
  let lastModel: string | undefined;
  for (const line of content.split("\n")) {
    if (!line) continue;
    // Cheap pre-filter so we don't JSON.parse every line on huge files.
    // `compact_boundary` is rare but mandatory — when it appears after
    // the latest assistant usage, the previous reading is stale and
    // must be cleared. Looking for the literal substring keeps the
    // fast path fast.
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
        const inp = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const cr =
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0;
        const cc =
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : 0;
        // A later assistant turn with no usage block must not clobber
        // an earlier good reading — that's why this update is gated on
        // `usage && typeof usage === "object"` above.
        lastContextTokens = inp + cr + cc;
        lastModel = typeof msg?.model === "string" ? msg.model : undefined;
      }
    } else if (
      obj.type === "system" &&
      obj.subtype === "compact_boundary"
    ) {
      // /compact (manual or auto): the model's context window has been
      // reset. Drop the previous reading so the chip stops lying about
      // pre-compact size. A new assistant turn after the compact will
      // re-populate it with fresh usage.
      lastContextTokens = undefined;
      // Keep `lastModel` — same model, just compacted state.
    }
  }
  const result: ClaudeUserScanResult = {
    firstUserMessage,
    lastUserMessages: tail,
    userMessageCount: userCount,
    totalMessageCount: totalCount,
    lastContextTokens,
    model: lastModel,
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

/** Exact token-usage readings from a Codex JSONL.
 *
 *  Codex (0.130+) emits `event_msg` lines with `payload.type ===
 *  "token_count"`. The payload's `info` block carries:
 *    - last_token_usage.input_tokens — what the model saw on the
 *      previous turn (≈ "current context size before next turn")
 *    - model_context_window — the cap (in tokens) for the model that
 *      handled this session, no heuristic required
 *  We also pick up the most recent `turn_context.payload.model` so the
 *  UI can show the model name alongside the chip.
 *
 *  Unlike Claude's `usage.input_tokens` / `cache_read_input_tokens` /
 *  `cache_creation_input_tokens` (which are disjoint slices of the
 *  request that we sum), OpenAI's `cached_input_tokens` is a *subset*
 *  of `input_tokens` — informational about cache hits — so we do NOT
 *  add it on top.
 *
 *  Returns undefined for any field that wasn't present in the file, so
 *  fresh sessions (no token_count event yet) or old logs degrade
 *  gracefully back to the chars/4 estimator. */
export interface CodexTokenUsage {
  lastInputTokens?: number;
  modelContextWindow?: number;
  model?: string;
}

export async function scanCodexTokenUsage(
  path: string,
): Promise<CodexTokenUsage> {
  const empty: CodexTokenUsage = {
    lastInputTokens: undefined,
    modelContextWindow: undefined,
    model: undefined,
  };
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return empty;
  }
  let lastInputTokens: number | undefined;
  let modelContextWindow: number | undefined;
  let model: string | undefined;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      obj.type === "turn_context" &&
      typeof obj.payload === "object" &&
      obj.payload
    ) {
      const p = obj.payload as Record<string, unknown>;
      if (typeof p.model === "string") model = p.model;
      continue;
    }
    if (
      obj.type === "event_msg" &&
      typeof obj.payload === "object" &&
      obj.payload
    ) {
      const p = obj.payload as Record<string, unknown>;
      if (p.type !== "token_count") continue;
      const info = p.info;
      if (!info || typeof info !== "object") continue;
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
  return { lastInputTokens, modelContextWindow, model };
}

/** Rough char-based estimate (chars/4) of the total tokens currently in
 *  a Codex session's context. Codex's JSONL doesn't carry an `input_tokens`
 *  field per turn the way Claude does, so we approximate by summing the
 *  character length of every user/assistant message and dividing by 4
 *  — the same heuristic OpenAI's own tokenizer docs use as a rule of
 *  thumb. Developer / system / event lines don't count. */
export async function scanCodexContextTokens(path: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return 0;
  }
  let chars = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // 0.130+: response_item → payload.{type:"message", role, content[]}
    if (
      obj.type === "response_item" &&
      typeof obj.payload === "object" &&
      obj.payload
    ) {
      const p = obj.payload as Record<string, unknown>;
      if (p.type !== "message") continue;
      if (p.role !== "user" && p.role !== "assistant") continue;
      if (Array.isArray(p.content)) {
        for (const block of p.content) {
          if (typeof block === "object" && block !== null) {
            const t = (block as { text?: unknown }).text;
            if (typeof t === "string") chars += t.length;
          }
        }
      } else if (typeof p.content === "string") {
        chars += p.content.length;
      }
      continue;
    }
    // Pre-0.130 flat form: top-level role + content.
    if (obj.role === "user" || obj.role === "assistant") {
      if (typeof obj.content === "string") chars += obj.content.length;
    }
  }
  return Math.floor(chars / 4);
}

/** UUID pattern — Claude uses v4 UUIDs for session directories. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const meta = await readClaudeSessionMeta(sessionPath);
  if (!meta.cwd) return null;
  const userStats = await scanClaudeUserMessages(
    sessionPath,
    fileStat.mtimeMs,
  );
  return {
    agent: "claude",
    cwd: resolve(meta.cwd),
    lastActive: fileStat.mtime.toISOString(),
    sessionId,
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
  const sessions: AgentSession[] = [];
  for (const proj of projDirs) {
    const projPath = join(root, proj);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(projPath, { withFileTypes: true });
    } catch {
      continue;
    }
    // Track session IDs we've seen via flat .jsonl files so we don't
    // double-count sessions that have both a .jsonl AND a directory.
    const seenIds = new Set<string>();
    // Pass 1: flat .jsonl files (original format).
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionPath = join(projPath, entry.name);
      const sessionId = entry.name.replace(/\.jsonl$/, "");
      try {
        const stats = await stat(sessionPath);
        const session = await claudeSessionFromFile(
          sessionPath,
          sessionId,
          stats,
        );
        if (session) {
          sessions.push(session);
          seenIds.add(sessionId);
        }
      } catch {
        // unreadable session, skip
      }
    }
    // Pass 2: directory-based sessions (newer Claude format).
    // Each UUID directory may contain subagents/*.jsonl. Pick the most
    // recently modified subagent file as the session representative.
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      if (seenIds.has(entry.name)) continue; // already found via .jsonl
      const sessionDir = join(projPath, entry.name);
      try {
        const best = await bestSubagentFile(sessionDir);
        if (!best) continue;
        const session = await claudeSessionFromFile(
          best.path,
          entry.name,
          best,
        );
        if (session) sessions.push(session);
      } catch {
        // skip
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
        // Exact reading wins; chars/4 estimate is the fallback for
        // brand-new sessions (no token_count event yet) and pre-0.130
        // logs that never wrote the field at all.
        const usage = await scanCodexTokenUsage(sessionPath);
        let contextTokens: number | undefined;
        let contextTokensExact: boolean | undefined;
        if (usage.lastInputTokens !== undefined && usage.lastInputTokens > 0) {
          contextTokens = usage.lastInputTokens;
          contextTokensExact = true;
        } else {
          const estimate = await scanCodexContextTokens(sessionPath);
          if (estimate > 0) {
            contextTokens = estimate;
            contextTokensExact = false;
          }
        }
        sessions.push({
          agent: "codex",
          cwd: resolve(meta.cwd),
          lastActive: stats.mtime.toISOString(),
          // Prefer the in-file id (what `codex resume <id>` expects)
          // over the filename basename, since the filename includes a
          // `rollout-<iso>-` prefix that's not a valid id.
          sessionId: meta.id ?? sessionPath.split(/[/\\]/).pop()!.replace(/\.(jsonl|json)$/, ""),
          source: sessionPath,
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
export async function scanOllama(workspacePath: string): Promise<AgentSession[]> {
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

export async function detectAgents(workspacePath?: string): Promise<AgentSession[]> {
  const [claude, codex, copilot, ollama] = await Promise.all([
    scanClaude().catch(() => []),
    scanCodex().catch(() => []),
    scanCopilot().catch(() => []),
    workspacePath
      ? scanOllama(workspacePath).catch(() => [])
      : Promise.resolve([] as AgentSession[]),
  ]);
  return [...claude, ...codex, ...copilot, ...ollama];
}

/**
 * Filter agents whose cwd equals or sits under `worktreePath`. Returned
 * sorted newest-first so callers can show the most recent at the top.
 */
// On Windows, drive letters can differ in case (c:\ vs C:\) and the
// filesystem is case-insensitive, so all path comparisons must be
// case-insensitive. On Unix, paths are case-sensitive.
const normCase = process.platform === "win32"
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
