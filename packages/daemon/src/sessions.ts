/**
 * Per-agent session formats normalised into a single internal shape so the
 * UI never has to know who wrote the file. Each agent's parser is its own
 * function below — add a new agent by writing parseXJsonl + plugging it
 * into parseSessionFile().
 *
 * The on-disk formats are NOT standardised across tools. Claude Code uses
 * one JSONL schema, Codex uses another, OpenAI's older logs use yet a
 * third. We keep that mess contained here.
 */

import { readFile, stat, open } from "node:fs/promises";
import type { AgentKind } from "./agents";

export type NormalizedRole = "user" | "assistant" | "system" | "tool";

export type NormalizedBlockKind =
  | "text"
  /** Assistant's extended thinking blocks (internal reasoning). */
  | "thinking"
  | "tool_use"
  | "tool_result"
  /** IDE state injected by the wrapper (`<ide_opened_file>`, `<ide_selection>` …). */
  | "ide_context"
  /** `<system-reminder>` … `</system-reminder>` wrappers. */
  | "system_reminder"
  /** `<command-name>` / `<command-message>` slash-command markers. */
  | "command"
  /** Standalone bracketed markers like "[Request interrupted by user]". */
  | "marker";

/** Recognise Claude's standalone bracket-markers so the UI can render them
 *  as quiet annotations instead of bold message text. */
export function isMarker(text: string): boolean {
  const t = text.trim();
  return /^\[(Request interrupted|Tool use rejected|Tool use was rejected|Request interrupted by user)\b/i.test(t);
}

export interface NormalizedBlock {
  type: NormalizedBlockKind;
  /** Free-form text. For tool_result this is the rendered output. */
  text?: string;
  /** tool_use only. */
  toolName?: string;
  toolInput?: unknown;
  /** Links a tool_result back to the tool_use that produced it. */
  toolUseId?: string;
  /** For ide_context / system_reminder / command: the tag name, e.g. "ide_opened_file". */
  tagName?: string;
}

/**
 * Claude Code injects semantic XML wrappers into raw text blocks
 * (`<ide_opened_file>...</ide_opened_file>`, `<system-reminder>...`,
 * `<command-name>...`, etc). We split those out into typed blocks so the
 * UI can render IDE context / system reminders / slash commands
 * differently from plain text. Anything outside a wrapper stays as
 * plain text. Returns at least one block.
 */
export function splitInjectedTags(text: string): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  const re =
    /<(ide_[a-z_]+|system-reminder|command-[a-z_]+|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) blocks.push({ type: "text", text: before });
    }
    const tag = match[1]!;
    const content = match[2]!.trim();
    let kind: NormalizedBlockKind = "text";
    if (tag.startsWith("ide_")) kind = "ide_context";
    else if (tag === "system-reminder") kind = "system_reminder";
    else if (tag.startsWith("command-") || tag.startsWith("local-command-"))
      kind = "command";
    blocks.push({ type: kind, text: content, tagName: tag });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex).trim();
    if (tail) blocks.push({ type: "text", text: tail });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text }];
}

export interface NormalizedMessage {
  role: NormalizedRole;
  blocks: NormalizedBlock[];
  timestamp?: string;
  /** Per-agent event id (uuid for Claude, free-form elsewhere). */
  id?: string;
}

export interface NormalizedSession {
  agent: AgentKind;
  cwd: string;
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  messages: NormalizedMessage[];
  /** User-provided title for this session (stored in the workspace). The
   *  server populates this when serving /api/session; the parsers leave
   *  it unset. */
  manualTitle?: string;
}

function emptySession(agent: AgentKind): NormalizedSession {
  return { agent, cwd: "", sessionId: "", messages: [] };
}

/** Clip block text to TEXT_CLIP_BYTES. Returns the input unchanged if
 *  already within the budget. Truncation uses utf-8 byte length so we
 *  never split a multibyte sequence — `slice` works on JS string units
 *  but for our budget it's close enough; we apply the suffix so the user
 *  knows there's more. */
function clipText(text: string): string {
  if (text.length <= TEXT_CLIP_BYTES) return text;
  return text.slice(0, TEXT_CLIP_BYTES) + TEXT_CLIP_SUFFIX;
}

/** Recursively clip every string in a tool_use's `input` payload. Claude's
 *  `Write` / `Edit` tool inputs include the full file content (or old/new
 *  strings) which is what blows up the cache for code-editing sessions —
 *  one Edit can be 100 KB+ of held string. The UI only displays the tool
 *  name and a hint (file_path, command, …) so the heavy text strings can
 *  safely be clipped here.
 *
 *  Non-string values are returned as-is. Arrays/objects are shallow-cloned
 *  so we never mutate the parsed JSON in place. */
function clipToolInput(input: unknown): unknown {
  if (typeof input === "string") return clipText(input);
  if (Array.isArray(input)) return input.map(clipToolInput);
  if (input !== null && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = clipToolInput(v);
    }
    return out;
  }
  return input;
}

/** Process a single JSONL line into `out`. Returns void; mutates `out`
 *  in place. Used by both the batch `parseClaudeJsonl` and the
 *  incremental tail-parser in `getSessionResponseJson`. */
function parseClaudeJsonlLine(line: string, out: NormalizedSession): void {
  if (!line) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof obj.cwd === "string" && !out.cwd) out.cwd = obj.cwd;
  if (typeof obj.sessionId === "string" && !out.sessionId)
    out.sessionId = obj.sessionId;

  const type = obj.type;
  if (type !== "user" && type !== "assistant") return;
  // `isMeta: true` is Claude Code's flag for system-injected records
  // written under `type: "user"`: the resume nudge ("Continue from
  // where you left off."), `<local-command-caveat>` wrappers around
  // slash-command output, skill-listing instructions piped in via
  // `sourceToolUseID`. None of these are user-typed turns, so they
  // must not surface as user bubbles in either the chat preview or
  // the read-mode session view.
  if (obj.isMeta === true) return;

  const msg = obj.message as Record<string, unknown> | undefined;
  if (!msg) return;
  const role: NormalizedRole =
    msg.role === "assistant" ? "assistant" : "user";
  const content = msg.content;
  const blocks: NormalizedBlock[] = [];

  const pushText = (txt: string) => {
    if (isMarker(txt)) blocks.push({ type: "marker", text: txt.trim() });
    else {
      const split = splitInjectedTags(txt);
      for (const blk of split) {
        if (typeof blk.text === "string") blk.text = clipText(blk.text);
        blocks.push(blk);
      }
    }
  };

  if (typeof content === "string") {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) continue;
      const b = raw as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        pushText(b.text);
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        blocks.push({ type: "thinking", text: clipText(b.thinking) });
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          toolName: typeof b.name === "string" ? b.name : undefined,
          toolInput: clipToolInput(b.input),
          toolUseId: typeof b.id === "string" ? b.id : undefined,
        });
      } else if (b.type === "tool_result") {
        const text =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? (b.content as Array<{ text?: unknown }>)
                  .map((x) => (typeof x.text === "string" ? x.text : ""))
                  .join("\n")
              : "";
        blocks.push({
          type: "tool_result",
          text: clipText(text),
          toolUseId:
            typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
        });
      }
    }
  }

  if (blocks.length === 0) return;

  // Claude's tool-call protocol stores tool *results* as JSONL entries
  // with type=user, msg.role=user — that's the Anthropic API convention
  // (results are fed back to the model as user-role messages). They are
  // not actual user turns. If every parsed block is a tool_result,
  // relabel the role so the UI doesn't call agent output "user".
  const effectiveRole: NormalizedRole =
    role === "user" && blocks.every((b) => b.type === "tool_result")
      ? "tool"
      : role;

  const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
  if (ts && !out.startedAt) out.startedAt = ts;
  if (ts) out.endedAt = ts;

  out.messages.push({
    role: effectiveRole,
    blocks,
    timestamp: ts,
    id: typeof obj.uuid === "string" ? obj.uuid : undefined,
  });
}

/** Normalize Claude Code's JSONL — entries with type: "user" | "assistant"
 * and a `message` object containing role + content (string OR block list). */
export function parseClaudeJsonl(text: string): NormalizedSession {
  const out = emptySession("claude");
  if (!text) return out;
  for (const line of text.split("\n")) {
    parseClaudeJsonlLine(line, out);
  }
  return out;
}

/** Per-line Codex parser, used by the batch + tail variants. */
function parseCodexJsonlLine(line: string, out: NormalizedSession): void {
  if (!line) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // codex 0.130+ wraps metadata in a top-level `session_meta` event
  // and actual chat turns in `response_item` events. Handle those
  // first; non-matching shapes fall through to the older flat
  // format below for backwards compat with the pre-0.130 layout
  // and our own test fixtures.
  if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
    const p = obj.payload as Record<string, unknown>;
    if (typeof p.cwd === "string" && !out.cwd) out.cwd = p.cwd;
    if (typeof p.id === "string" && !out.sessionId) out.sessionId = p.id;
    const ts =
      typeof p.timestamp === "string"
        ? p.timestamp
        : typeof obj.timestamp === "string"
          ? obj.timestamp
          : undefined;
    if (ts && !out.startedAt) out.startedAt = ts;
    if (ts) out.endedAt = ts;
    return;
  }
  if (obj.type === "response_item" && obj.payload && typeof obj.payload === "object") {
    const p = obj.payload as Record<string, unknown>;
    if (p.type !== "message") return;
    const role: NormalizedRole = (() => {
      if (typeof p.role !== "string") return "user";
      if (p.role === "assistant") return "assistant";
      if (p.role === "system" || p.role === "developer") return "system";
      return "user";
    })();
    const blocks: NormalizedBlock[] = [];
    if (Array.isArray(p.content)) {
      for (const raw of p.content) {
        if (typeof raw !== "object" || raw === null) continue;
        const b = raw as Record<string, unknown>;
        if (typeof b.text === "string") {
          blocks.push({ type: "text", text: clipText(b.text) });
        }
      }
    } else if (typeof p.content === "string") {
      blocks.push({ type: "text", text: clipText(p.content) });
    }
    if (blocks.length === 0) return;
    const ts =
      typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    if (ts && !out.startedAt) out.startedAt = ts;
    if (ts) out.endedAt = ts;
    out.messages.push({ role, blocks, timestamp: ts });
    return;
  }
  if (obj.type === "event_msg" || obj.type === "turn_context") {
    // Non-message metadata events — skip rendering.
    return;
  }

  if (typeof obj.cwd === "string" && !out.cwd) out.cwd = obj.cwd;
  if (typeof obj.sessionId === "string" && !out.sessionId)
    out.sessionId = obj.sessionId;

  const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
  if (ts && !out.startedAt) out.startedAt = ts;
  if (ts) out.endedAt = ts;

  const role =
    typeof obj.role === "string"
      ? obj.role === "assistant" || obj.role === "system"
        ? (obj.role as NormalizedRole)
        : "user"
      : null;

  const text =
    typeof obj.content === "string"
      ? obj.content
      : typeof obj.text === "string"
        ? obj.text
        : typeof obj.message === "string"
          ? obj.message
          : null;

  if (role && text) {
    out.messages.push({
      role,
      blocks: [{ type: "text", text: clipText(text) }],
      timestamp: ts,
    });
    return;
  }

  // Tool call shape, best effort
  if (
    typeof obj.type === "string" &&
    (obj.type === "tool_call" || obj.type === "tool_use") &&
    typeof obj.name === "string"
  ) {
    out.messages.push({
      role: "assistant",
      blocks: [
        {
          type: "tool_use",
          toolName: obj.name,
          toolInput: clipToolInput(obj.input ?? obj.arguments),
        },
      ],
      timestamp: ts,
    });
  }
}

/** Best-effort Codex parser. Format varies across versions; we look for
 *  `role` + string `content` and fall back to top-level `text`/`message`. */
export function parseCodexJsonl(text: string): NormalizedSession {
  const out = emptySession("codex");
  if (!text) return out;
  for (const line of text.split("\n")) {
    parseCodexJsonlLine(line, out);
  }
  return out;
}

/**
 * Parse the daemon's per-Ollama-session JSONL into a normalized chat.
 *
 * The on-disk file holds `kind: "header"`, `kind: "output"` chunks
 * (raw PTY bytes captured every ~3s while the session is live), and
 * `kind: "exit"`. Ollama itself never writes structured turns — we
 * have to recover them from the captured PTY transcript.
 *
 * The TUI's prompt is `>>> Send a message (/? for help)` on its own
 * line; user-typed text appears appended to that same line (echoed
 * by the readline). The model's reply follows on subsequent lines
 * until the next `>>> ` prompt. We:
 *   1. Strip ANSI escapes so the text is plain.
 *   2. Strip the placeholder prompt fragments TUI repaints emit.
 *   3. Walk lines, treating each `>>> ` as a turn boundary: the rest
 *      of the line is the user message, anything until the next
 *      prompt is the assistant message.
 *
 * Best-effort: a model that emits `>>> ` inside its own response
 * would confuse the splitter, and multi-line user input pasted into
 * the TUI may not round-trip perfectly. Good enough for the read
 * view; if it bites, the alternative is to drive `/api/chat` from
 * supergit directly (see plans/ollama.md).
 */
export function parseOllamaJsonl(text: string): NormalizedSession {
  const out = emptySession("ollama");
  let combined = "";
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = obj.kind;
    if (kind === "header") {
      if (typeof obj.spawnCwd === "string" && !out.cwd) out.cwd = obj.spawnCwd;
      if (typeof obj.termId === "string" && !out.sessionId)
        out.sessionId = obj.termId;
      if (typeof obj.createdAt === "string") startedAt = obj.createdAt;
    } else if (kind === "output" && typeof obj.data === "string") {
      combined += obj.data;
    } else if (kind === "exit" && typeof obj.ts === "string") {
      endedAt = obj.ts;
    }
  }
  if (startedAt) out.startedAt = startedAt;
  if (endedAt) out.endedAt = endedAt;

  const stripped = stripAnsi(combined);
  for (const msg of splitOllamaTurns(stripped)) {
    out.messages.push(msg);
  }
  return out;
}

/** Strip ANSI CSI / OSC / single-char ESC sequences and collapse lone
 *  carriage returns. Same cleanup OllamaTranscriptView used to do
 *  client-side; centralizing it here lets the read view share
 *  SessionView's renderer instead of inventing its own. */
function stripAnsi(s: string): string {
  if (!s) return "";
  let t = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  t = t.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
  t = t.replace(/\x1B[@-Z\\-_]/g, "");
  t = t.replace(/\r(?!\n)/g, "");
  return t;
}

/** The Ollama TUI repaints its placeholder prompt multiple times per
 *  line; collapse every "Send a message (/? for help)" fragment into
 *  nothing so the user-typed text on each `>>> ` line is what's left. */
const OLLAMA_PROMPT_PLACEHOLDER = /Send a message \(\/\? for help\)\s*/g;

/** Split a cleaned Ollama transcript into alternating user/assistant
 *  turns. A `>>> ` line marks a user turn; the user message is the
 *  rest of that line, the assistant message is everything up to the
 *  next `>>> ` line. Whitespace-only turns on either side are skipped
 *  (an empty user input followed by a model response wouldn't render
 *  meaningfully anyway). */
function splitOllamaTurns(text: string): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const lines = text.split("\n");
  let i = 0;
  // Skip leading non-prompt lines (the TUI's banner / model load
  // notice) — there's no user turn before the first `>>> `.
  while (i < lines.length && !lines[i]!.startsWith(">>> ")) i++;
  while (i < lines.length) {
    const promptLine = lines[i]!;
    i++;
    // User input is whatever comes after `>>> `, minus any TUI
    // placeholder repaints. Trim because the placeholder can leave
    // trailing whitespace.
    const userText = promptLine
      .slice(">>> ".length)
      .replace(OLLAMA_PROMPT_PLACEHOLDER, "")
      .trim();
    // Collect assistant lines until the next `>>> ` (or EOF).
    const assistantLines: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith(">>> ")) {
      assistantLines.push(lines[i]!);
      i++;
    }
    const assistantText = assistantLines.join("\n").trim();
    if (userText.length > 0) {
      out.push({
        role: "user",
        blocks: [{ type: "text", text: userText }],
      });
    }
    if (assistantText.length > 0) {
      out.push({
        role: "assistant",
        blocks: [{ type: "text", text: assistantText }],
      });
    }
  }
  return out;
}

export async function parseSessionFile(
  agent: AgentKind,
  path: string,
): Promise<NormalizedSession> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return emptySession(agent);
  }
  if (agent === "claude") return parseClaudeJsonl(text);
  if (agent === "codex") return parseCodexJsonl(text);
  if (agent === "ollama") return parseOllamaJsonl(text);
  // No reader for copilot yet — its data isn't a tail-friendly JSONL.
  return emptySession(agent);
}

/**
 * Bounded-tail parsed-session cache for /api/session, keyed by absolute path.
 *
 * Two-step bound: the cache holds **at most MAX_CACHED sessions**, and each
 * session retains **at most MAX_CACHED_MESSAGES messages** (the most
 * recent). The trim is what keeps memory tractable for very long sessions
 * (e.g. 30k-message Claude JSONLs are gigabytes parsed; we keep only the
 * tail so cache size is ~MAX_CACHED × MAX_CACHED_MESSAGES × per-message
 * bytes, not O(disk file size)).
 *
 * Trade-off: callers (the SPA) lose scroll-back beyond the trimmed window.
 * The UI doesn't yet ask for older messages on demand, so this is a
 * deliberate cap rather than a perceived limitation — and well worth it
 * vs. multi-GB daemon RSS.
 *
 * Tail-append: when a file grows we read only the new bytes since
 * `cached.size`, parse them with the per-line helpers, and push them onto
 * `cached.parsed.messages`. Then we trim back to MAX_CACHED_MESSAGES.
 * `startedAt` is set on first parse and never moved — it reflects the
 * actual session start even after we drop early messages.
 *
 * Partial last-line handling: a write may land between stat and read,
 * leaving the new chunk's tail incomplete. We keep that suffix in
 * `partialLine` and prepend it on the next append.
 *
 * `manualTitle` is injected per-request via string surgery on the
 * stringified body so the cache key doesn't depend on workspace title state.
 */
const MAX_CACHED = 4;
const MAX_CACHED_MESSAGES = 100;
/** Per-block text cap. Claude `tool_result` blocks routinely contain full
 *  file contents (~90 KB each) — they balloon the cache far beyond what
 *  the chat view actually needs to display. We clip each block's `text`
 *  to TEXT_CLIP_BYTES bytes with a marker; the user can re-open the file
 *  in their editor for the full content. */
const TEXT_CLIP_BYTES = 16 * 1024;
const TEXT_CLIP_SUFFIX = "\n\n… [truncated by supergit; full content available in the source file]";
interface SessionCacheEntry {
  mtimeMs: number;
  /** Number of bytes from the file we have already parsed into `parsed`. */
  size: number;
  parsed: NormalizedSession;
  /** Suffix of the last read that didn't end with a newline. Prepended to
   *  the next chunk so a JSONL line split across two reads still parses. */
  partialLine: string;
  /** Serialized form of `parsed` without `manualTitle`. Refreshed only when
   *  `parsed` mutates (tail-append, full re-parse); reused as-is for every
   *  cache-hit response so we don't pay `JSON.stringify` on every poll. */
  jsonNoTitle: string;
}
const sessionCache = new Map<string, SessionCacheEntry>();

export function clearParseCache(): void {
  sessionCache.clear();
}

/** Snapshot of the session cache for diagnostics. Reports per-entry sizes
 *  in bytes (using the serialized `jsonNoTitle` as the proxy — it's the
 *  exact wire size, and the parsed structure is roughly in the same
 *  order of magnitude). Total covers the JSON strings; the live parsed
 *  graph adds roughly another 1× on top. */
export function sessionCacheStats(): {
  entries: number;
  maxEntries: number;
  maxMessagesPerEntry: number;
  totalJsonBytes: number;
  perEntry: Array<{
    path: string;
    mtimeMs: number;
    sizeOnDisk: number;
    messages: number;
    jsonBytes: number;
    partialLineBytes: number;
  }>;
} {
  let total = 0;
  const perEntry = [...sessionCache.entries()].map(([path, e]) => {
    const jsonBytes = Buffer.byteLength(e.jsonNoTitle, "utf-8");
    total += jsonBytes;
    return {
      path,
      mtimeMs: e.mtimeMs,
      sizeOnDisk: e.size,
      messages: e.parsed.messages.length,
      jsonBytes,
      partialLineBytes: e.partialLine.length,
    };
  });
  return {
    entries: sessionCache.size,
    maxEntries: MAX_CACHED,
    maxMessagesPerEntry: MAX_CACHED_MESSAGES,
    totalJsonBytes: total,
    perEntry,
  };
}

function injectManualTitle(
  jsonNoTitle: string,
  manualTitle: string | undefined,
): string {
  if (!manualTitle) return jsonNoTitle;
  // The cached JSON serializes a NormalizedSession with no manualTitle, so
  // it ends with the closing brace of the top-level object. We splice the
  // field in just before that brace. JSON.stringify on the title handles
  // escaping for us.
  return (
    jsonNoTitle.slice(0, -1) +
    ',"manualTitle":' +
    JSON.stringify(manualTitle) +
    "}"
  );
}

/** Touch LRU: move `path` to the most-recent position. */
function touch(path: string, entry: SessionCacheEntry): void {
  sessionCache.delete(path);
  sessionCache.set(path, entry);
}

function evictLRU(): void {
  while (sessionCache.size > MAX_CACHED) {
    const oldestKey = sessionCache.keys().next().value;
    if (oldestKey === undefined) break;
    sessionCache.delete(oldestKey);
  }
}

/** Parse a chunk of JSONL into `out` in place. The chunk is split on '\n';
 *  if the chunk does not end in '\n', the trailing partial line is returned
 *  so the caller can prepend it to the next chunk. */
function appendChunk(
  agent: AgentKind,
  chunk: string,
  out: NormalizedSession,
): string {
  const endsWithNewline = chunk.endsWith("\n");
  const lines = chunk.split("\n");
  const trailing = endsWithNewline ? "" : (lines.pop() ?? "");
  // If the chunk ended with '\n', split() yields a trailing "" we want to skip.
  if (endsWithNewline) lines.pop();
  for (const line of lines) {
    if (agent === "claude") parseClaudeJsonlLine(line, out);
    else if (agent === "codex") parseCodexJsonlLine(line, out);
  }
  return trailing;
}

/** Trim `messages` down to the last MAX_CACHED_MESSAGES entries. In place;
 *  no-op when already short. */
function trimMessages(session: NormalizedSession): void {
  if (session.messages.length > MAX_CACHED_MESSAGES) {
    session.messages = session.messages.slice(-MAX_CACHED_MESSAGES);
  }
}

/**
 * Read only the trailing TAIL_BYTES of a session file (enough to comfortably
 * cover MAX_CACHED_MESSAGES of typical agent JSONL lines) and parse those
 * lines. Avoids the gigabyte-of-transient-objects cost of full-parsing a
 * very long session just to discard 99% of the result in `trimMessages`.
 *
 * Returns an empty session if the file can't be opened or stat'd.
 *
 * Claude JSONL repeats `cwd` and `sessionId` on every entry, so even with
 * the first (partial) line discarded we still surface those fields from
 * any retained line. The downside is that `startedAt` reflects the
 * earliest *retained* timestamp, not the true session start — acceptable
 * for the dashboard's purposes; the UI doesn't show it as authoritative.
 *
 * For Codex, the leading `session_meta` event holds cwd/sessionId in
 * 0.130+ — if it lives outside the tail window we miss it. That's
 * acceptable for now (the UI degrades gracefully) and the tail path is
 * still the right trade vs. full-parse on every cache-miss.
 */
const TAIL_BYTES = 8 * 1024 * 1024; // 8 MB
/** Head bytes we scan for the authoritative cwd / sessionId / startedAt.
 *  Claude / Codex both stamp these on every entry, but only the *first*
 *  occurrence corresponds to the project directory `~/.claude/projects/...`
 *  Claude uses for `--resume` lookup. If the tail-only read latches onto
 *  an intermediate cd-into-subdir line, the wrong cwd propagates to the
 *  resume PTY → "No conversation found with session ID". */
const HEAD_META_BYTES = 64 * 1024;

/** Scan up to HEAD_META_BYTES from the start of a session JSONL and
 *  return the first cwd / sessionId / timestamp. Cheap line walk;
 *  abandons as soon as all three are populated. */
async function readSessionHeadMeta(
  fh: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  headBytes: number,
): Promise<{ cwd?: string; sessionId?: string; startedAt?: string }> {
  if (fileSize === 0) return {};
  const size = Math.min(headBytes, fileSize);
  const buf = Buffer.alloc(size);
  await fh.read(buf, 0, size, 0);
  const text = buf.toString("utf-8");
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let startedAt: string | undefined;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd && typeof obj.cwd === "string") cwd = obj.cwd;
    // Codex 0.130+ puts cwd under payload.cwd on a session_meta event.
    if (!cwd && obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
      const p = obj.payload as Record<string, unknown>;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (!sessionId && typeof p.id === "string") sessionId = p.id;
    }
    if (!sessionId && typeof obj.sessionId === "string") sessionId = obj.sessionId;
    if (!startedAt && typeof obj.timestamp === "string") startedAt = obj.timestamp;
    if (cwd && sessionId && startedAt) break;
  }
  return { cwd, sessionId, startedAt };
}

export async function tailParseSessionFile(
  agent: AgentKind,
  path: string,
  tailBytes: number = TAIL_BYTES,
  headBytes: number = HEAD_META_BYTES,
): Promise<NormalizedSession> {
  if (agent !== "claude" && agent !== "codex") return emptySession(agent);
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return emptySession(agent);
  try {
    const st = await fh.stat();
    if (st.size === 0) return emptySession(agent);
    // Always read the head first so cwd / sessionId reflect where the
    // session started, even when an intermediate message recorded a
    // subdirectory cwd.
    const headMeta = await readSessionHeadMeta(fh, st.size, headBytes);
    const readSize = Math.min(tailBytes, st.size);
    const startPos = st.size - readSize;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, startPos);
    let text = buf.toString("utf-8");
    // Drop the first (potentially partial) line if we didn't start at offset 0.
    if (startPos > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline === -1) {
        const empty = emptySession(agent);
        if (headMeta.cwd) empty.cwd = headMeta.cwd;
        if (headMeta.sessionId) empty.sessionId = headMeta.sessionId;
        if (headMeta.startedAt) empty.startedAt = headMeta.startedAt;
        return empty;
      }
      text = text.slice(firstNewline + 1);
    }
    const parsed = agent === "claude" ? parseClaudeJsonl(text) : parseCodexJsonl(text);
    // Overlay head meta — the head wins for identity fields. The tail
    // keeps the messages (those are the recent ones the UI wants).
    if (headMeta.cwd) parsed.cwd = headMeta.cwd;
    if (headMeta.sessionId) parsed.sessionId = headMeta.sessionId;
    if (headMeta.startedAt) parsed.startedAt = headMeta.startedAt;
    return parsed;
  } finally {
    await fh.close();
  }
}

/**
 * Return the /api/session response body as a JSON string, using a tail-based
 * parsed-session cache.
 */
export async function getSessionResponseJson(
  agent: AgentKind,
  path: string,
  manualTitle?: string,
): Promise<string> {
  const st = await stat(path).catch(() => null);
  if (!st) {
    return injectManualTitle(JSON.stringify(emptySession(agent)), manualTitle);
  }

  // Ollama: bypass the tail-cache. The captured PTY transcripts are
  // small (spinner braille is stripped at capture, conversations
  // rarely exceed a few MB) and the parser needs to walk every
  // `output` chunk to recover turn boundaries — there's no useful
  // tail-window trick because the model's response can span dozens
  // of chunks. Full parse on each request is fine; trim still
  // applies so callers see a bounded message count.
  if (agent === "ollama") {
    const text = await readFile(path, "utf-8").catch(() => "");
    const parsed = parseOllamaJsonl(text);
    trimMessages(parsed);
    return injectManualTitle(JSON.stringify(parsed), manualTitle);
  }

  const cached = sessionCache.get(path);

  // Cache hit, file unchanged: return the pre-stringified body. No
  // parse, no stringify, no Buffer alloc — the cheapest possible path.
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    touch(path, cached);
    return injectManualTitle(cached.jsonNoTitle, manualTitle);
  }

  // Cache hit, file grew: incremental append. We don't gate on mtimeMs here
  // — size growth alone is a strong signal an active agent has written
  // more JSONL. (mtime updates as well in practice, but Bun on some FSes
  // batches mtime updates while size advances byte-by-byte.)
  if (cached && st.size > cached.size && agent !== "copilot") {
    const fh = await open(path, "r").catch(() => null);
    if (fh) {
      try {
        const length = st.size - cached.size;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, cached.size);
        const chunk = cached.partialLine + buf.toString("utf-8");
        const newPartial = appendChunk(agent, chunk, cached.parsed);
        cached.partialLine = newPartial;
        cached.size = st.size;
        cached.mtimeMs = st.mtimeMs;
        trimMessages(cached.parsed);
        // Re-stringify now while we're mutating, so future cache hits on
        // this entry don't have to.
        cached.jsonNoTitle = JSON.stringify(cached.parsed);
        touch(path, cached);
        return injectManualTitle(cached.jsonNoTitle, manualTitle);
      } finally {
        await fh.close();
      }
    }
    // open() failed — fall through to full re-parse.
  }

  // Cache miss, or file shrank/got rewritten: tail-read only the last
  // TAIL_BYTES and parse those lines. The cache stays consistent with
  // disk for *subsequent* polls because tail-append reads from
  // `cached.size` (= st.size after this set), and any future growth is
  // appended onto the tail-parsed messages — we never need the
  // discarded prefix again.
  const parsed = await tailParseSessionFile(agent, path);
  trimMessages(parsed);
  const jsonNoTitle = JSON.stringify(parsed);
  sessionCache.set(path, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    parsed,
    partialLine: "",
    jsonNoTitle,
  });
  evictLRU();
  return injectManualTitle(jsonNoTitle, manualTitle);
}
