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

import { createHash } from "node:crypto";
import { readFile, stat, open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentKind } from "./agents";
import { createLimiter } from "./concurrency";
import {
  createCodexTranscriptNormalizer,
  contextCompactionDetailsFromMetadata,
  type AgentTranscriptBlock,
} from "@treetop/nicifier";

export type NormalizedRole = "user" | "assistant" | "system" | "tool";

export type NormalizedBlockKind =
  | "text"
  /** Assistant's extended thinking blocks (internal reasoning). */
  | "thinking"
  | "plan"
  | "goal"
  | "tool_use"
  | "tool_result"
  /** Image/file artifact produced by or supplied to an agent. */
  | "media"
  /** IDE state injected by the wrapper (`<ide_opened_file>`, `<ide_selection>` …). */
  | "ide_context"
  /** `<system-reminder>` … `</system-reminder>` wrappers. */
  | "system_reminder"
  /** A recorded model-visible developer/system context replacement. */
  | "context_update"
  /** `<command-name>` / `<command-message>` slash-command markers. */
  | "command"
  /** Standalone bracketed markers like "[Request interrupted by user]". */
  | "marker"
  /** Multi-agent child session events (`spawn_agent`, `wait_agent`, notifications). */
  | "subagent";

/** Recognise Claude's standalone bracket-markers so the UI can render them
 *  as quiet annotations instead of bold message text. */
export function isMarker(text: string): boolean {
  const t = text.trim();
  return /^\[(Request interrupted|Tool use rejected|Tool use was rejected|Request interrupted by user)\b/i.test(
    t,
  );
}

export interface NormalizedBlock extends AgentTranscriptBlock {}
export type NormalizedPlanStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | string;

export interface NormalizedPlanItem {
  step: string;
  status: NormalizedPlanStatus;
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
  /** Assistant output token delta reported by the agent runtime. */
  tokensUsed?: number;
  /** Full model token usage delta reported by the agent runtime. */
  tokenUsage?: NormalizedTokenUsage;
  /** Model active when this usage checkpoint was recorded. */
  model?: string;
  /** Per-agent event id (uuid for Claude, free-form elsewhere). */
  id?: string;
  /** Optional override for the assistant's display name on this turn.
   *  Used by Ollama where the model that produced a given response is
   *  the meaningful author (e.g. `gemma4:latest`, `qwen3-coder:30b`),
   *  not the generic "Ollama" label — and forward-looking so a session
   *  that continues with a *different* model can still attribute each
   *  turn correctly. Other agents leave this unset and fall back to
   *  the agent-name label. */
  author?: string;
}

export interface NormalizedTokenUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  cacheWriteInput1h?: number;
  output: number;
  reasoningOutput: number;
  total: number;
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

interface CodexParseContext {
  sourcePath?: string;
  normalizeTranscript?: ReturnType<typeof createCodexTranscriptNormalizer>;
}

function codexTranscriptNormalizer(context: CodexParseContext) {
  context.normalizeTranscript ??= createCodexTranscriptNormalizer({
    resolveInlineData: (dataUrl) => ({ inlineDataHash: inlineDataHash(dataUrl) }),
    generatedImagePath: (record) => codexGeneratedImagePath(record, context),
  });
  return context.normalizeTranscript;
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

function stringProp(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectProp(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function mediaKindFrom(
  type: string | undefined,
  mimeType: string | undefined,
  source: string | undefined,
): "image" | "file" | "artifact" {
  const t = type?.toLowerCase() ?? "";
  const mime = mimeType?.toLowerCase() ?? "";
  const src = source?.toLowerCase() ?? "";
  if (
    t.includes("image") ||
    mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:$|[?#])/i.test(src)
  ) {
    return "image";
  }
  return src || mime ? "file" : "artifact";
}

const DATA_URL_PREFIX_RE = /^data:([^;,]+)?(?:;[^,]*)?,/i;

function dataUrlMimeType(url: string | undefined): string | undefined {
  const match = url?.match(DATA_URL_PREFIX_RE);
  return match?.[1] || undefined;
}

function inlineDataHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function rawBase64ImageDataUrl(
  value: string | undefined,
  mimeType = "image/png",
): string | undefined {
  const compact = value?.replace(/\s+/g, "");
  if (!compact || compact.length < 16) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
  return `data:${mimeType};base64,${compact}`;
}

function imageGenerationToolUseId(
  raw: Record<string, unknown>,
): string | undefined {
  return (
    stringProp(raw, "call_id") ??
    stringProp(raw, "callId") ??
    stringProp(raw, "id")
  );
}

function codexSessionIdFromSourcePath(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) return undefined;
  return basename(sourcePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  )?.[1];
}

function codexHomeFromSessionPath(sourcePath: string | undefined): string | undefined {
  if (!sourcePath) return undefined;
  const marker = `${"/"}.codex${"/"}sessions${"/"}`;
  const normalized = sourcePath.replace(/\\/g, "/");
  const index = normalized.indexOf(marker);
  if (index < 0) return undefined;
  return sourcePath.slice(0, index + "/.codex".length);
}

function codexGeneratedImagePath(
  raw: Record<string, unknown>,
  context: CodexParseContext = {},
): string | undefined {
  const explicit =
    stringProp(raw, "path") ??
    stringProp(raw, "file_path") ??
    stringProp(raw, "filePath") ??
    stringProp(raw, "savedPath") ??
    stringProp(raw, "saved_path");
  if (explicit) return explicit;
  const callId = imageGenerationToolUseId(raw);
  if (!callId) return undefined;
  const sessionId = codexSessionIdFromSourcePath(context.sourcePath);
  const codexHome = codexHomeFromSessionPath(context.sourcePath);
  if (!sessionId || !codexHome) return undefined;
  return join(codexHome, "generated_images", sessionId, `${callId}.png`);
}

function mediaBlockFromContent(
  raw: Record<string, unknown>,
): NormalizedBlock | null {
  const type = stringProp(raw, "type");
  const source = objectProp(raw, "source");
  const imageUrl = objectProp(raw, "image_url");
  const outputImage = objectProp(raw, "output_image");
  const file = objectProp(raw, "file");
  const container = outputImage ?? imageUrl ?? source ?? file ?? raw;

  const path =
    stringProp(raw, "path") ??
    stringProp(raw, "file_path") ??
    stringProp(raw, "filePath") ??
    stringProp(container, "path") ??
    stringProp(container, "file_path") ??
    stringProp(container, "filePath");
  const rawUrl =
    stringProp(raw, "url") ??
    stringProp(raw, "image_url") ??
    stringProp(container, "url") ??
    stringProp(container, "image_url");
  const inlineDataMimeType = dataUrlMimeType(rawUrl);
  const url = inlineDataMimeType ? undefined : rawUrl;
  const mimeType =
    stringProp(raw, "mime_type") ??
    stringProp(raw, "mimeType") ??
    stringProp(raw, "media_type") ??
    stringProp(container, "mime_type") ??
    stringProp(container, "mimeType") ??
    stringProp(container, "media_type") ??
    inlineDataMimeType;
  const sourceRef = path ?? url;
  const kind = mediaKindFrom(type, mimeType, sourceRef);
  const isMediaType =
    type === "image" ||
    type === "input_image" ||
    type === "output_image" ||
    type === "localImage" ||
    type === "file" ||
    type === "artifact" ||
    type === "input_file" ||
    type === "output_file";
  if (!isMediaType && !sourceRef && !mimeType) return null;

  const title =
    stringProp(raw, "title") ??
    stringProp(raw, "name") ??
    stringProp(raw, "filename") ??
    stringProp(container, "title") ??
    stringProp(container, "name") ??
    stringProp(container, "filename") ??
    (kind === "image" ? "Image" : "Artifact");
  const alt =
    stringProp(raw, "alt") ??
    stringProp(raw, "alt_text") ??
    stringProp(container, "alt") ??
    stringProp(container, "alt_text") ??
    title;

  const block: NormalizedBlock = {
    type: "media",
    mediaKind: kind,
    title,
    alt,
  };
  if (mimeType) block.mimeType = mimeType;
  if (path) block.path = path;
  if (url) block.url = url;
  if (!path && !url && (source?.type === "base64" || inlineDataMimeType)) {
    block.text = `[${mimeType ?? "image"} data stored in source transcript]`;
    if (rawUrl && inlineDataMimeType) {
      block.inlineDataHash = inlineDataHash(rawUrl);
    }
  }
  return block;
}

function attachSessionInlineMediaUrls(
  session: NormalizedSession,
  source: string,
): void {
  const encodedSource = encodeURIComponent(source);
  for (const message of session.messages) {
    for (const block of message.blocks) {
      if (block.type !== "media" || !block.inlineDataHash || block.url)
        continue;
      block.url = `/api/session/media?source=${encodedSource}&hash=${block.inlineDataHash}`;
      block.text = undefined;
      block.inlineDataHash = undefined;
    }
  }
}

export type SessionInlineMediaResult =
  | { status: 400; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string }
  | { status: 200; bytes: Uint8Array; mimeType: string };

export interface SessionInlineMediaOptions {
  maxSide?: number;
}

function decodeDataUrl(
  url: string,
): { bytes: Uint8Array; mimeType: string } | null {
  const match = url.match(DATA_URL_PREFIX_RE);
  if (!match) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const mimeType = match[1] || "application/octet-stream";
  try {
    const bytes = /(?:^|;)base64(?:;|$)/i.test(meta)
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

function findInlineDataUrlByHash(value: unknown, hash: string): string | null {
  if (typeof value === "string") {
    return DATA_URL_PREFIX_RE.test(value) && inlineDataHash(value) === hash
      ? value
      : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInlineDataUrlByHash(item, hash);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const imageDataUrl = rawBase64ImageDataUrl(
      stringProp(record, "result") ?? stringProp(record, "b64_json"),
      stringProp(record, "mime_type") ?? stringProp(record, "mimeType"),
    );
    if (imageDataUrl && inlineDataHash(imageDataUrl) === hash) {
      return imageDataUrl;
    }
    for (const item of Object.values(record)) {
      const found = findInlineDataUrlByHash(item, hash);
      if (found) return found;
    }
  }
  return null;
}

export async function readSessionInlineMedia(
  source: string,
  hash: string | null | undefined,
  options: SessionInlineMediaOptions = {},
): Promise<SessionInlineMediaResult> {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) {
    return { status: 400, error: "?hash required" };
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = Bun.file(source).stream();
  } catch {
    return { status: 404, error: "session not found" };
  }

  const decoder = new TextDecoder();
  let leftover = "";

  const scanLine = async (
    line: string,
  ): Promise<SessionInlineMediaResult | null> => {
    if (
      !line ||
      (!line.includes("data:") &&
        !line.includes("image_generation") &&
        !line.includes("imageGeneration") &&
        !line.includes("b64_json"))
    ) {
      return null;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return null;
    }
    const dataUrl = findInlineDataUrlByHash(obj, hash);
    if (!dataUrl) return null;
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return { status: 400, error: "invalid data URL" };
    if (options.maxSide !== undefined) {
      const maxSide = Math.floor(options.maxSide);
      if (!Number.isFinite(maxSide) || maxSide <= 0) {
        return { status: 400, error: "?max must be a positive number" };
      }
      if (!decoded.mimeType.toLowerCase().startsWith("image/")) {
        return { status: 400, error: "?max is only supported for images" };
      }
    }
    return { status: 200, ...decoded };
  };

  try {
    for await (const chunk of stream) {
      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        const found = await scanLine(line);
        if (found) return found;
      }
    }
    const tail = leftover + decoder.decode();
    const found = await scanLine(tail);
    if (found) return found;
  } catch {
    return { status: 404, error: "session not found" };
  }
  return { status: 404, error: "media not found" };
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
  if (type === "system" && obj.subtype === "compact_boundary") {
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    const compaction = contextCompactionDetailsFromMetadata(obj.compactMetadata);
    if (ts && !out.startedAt) out.startedAt = ts;
    if (ts) out.endedAt = ts;
    pushSessionMessage(out, "system", [{
      type: "marker",
      text: "[Context compacted]",
      ...(compaction ? { compaction } : {}),
    }], ts);
    return;
  }
  if (type === "summary") {
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    if (ts && !out.startedAt) out.startedAt = ts;
    if (ts) out.endedAt = ts;
    pushSessionMessage(
      out,
      "system",
      [{ type: "marker", text: "[Context compacted]" }],
      ts,
    );
    return;
  }
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
  const role: NormalizedRole = msg.role === "assistant" ? "assistant" : "user";
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
      } else {
        const media = mediaBlockFromContent(b);
        if (media) blocks.push(media);
      }
    }
  }

  const usage = objectField(msg.usage);
  const cacheCreation = finiteNonNegativeNumber(
    usage?.cache_creation_input_tokens ?? usage?.cacheCreationInputTokens,
  ) ?? 0;
  const cacheCreationDetail = objectField(usage?.cache_creation);
  const cacheWriteInput1h = Math.min(
    cacheCreation,
    finiteNonNegativeNumber(cacheCreationDetail?.ephemeral_1h_input_tokens) ??
      0,
  );
  const cachedInput =
    finiteNonNegativeNumber(usage?.cache_read_input_tokens) ?? 0;
  const freshInput = finiteNonNegativeNumber(usage?.input_tokens) ?? 0;
  const output = finiteNonNegativeNumber(usage?.output_tokens) ?? 0;
  const outputDetails = objectField(usage?.output_tokens_details);
  const reasoningOutput =
    finiteNonNegativeNumber(
      outputDetails?.thinking_tokens ?? usage?.reasoning_output_tokens,
    ) ?? 0;
  const input = freshInput + cachedInput + cacheCreation;
  const tokenUsage: NormalizedTokenUsage | undefined =
    input + output > 0
      ? {
          input,
          cachedInput,
          cacheWriteInput: cacheCreation,
          cacheWriteInput1h,
          output,
          reasoningOutput,
          total: input + output,
        }
      : undefined;

  if (blocks.length === 0 && !tokenUsage) return;

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
    ...(typeof msg.model === "string" ? { model: msg.model } : {}),
    ...(tokenUsage ? { tokensUsed: tokenUsage.output, tokenUsage } : {}),
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

/** Stateful, bounded-memory access to the production JSONL parsers for
 * corpus audits and other streaming consumers. Parsed messages are drained
 * after every line while per-session Codex tool/token context stays alive. */
export function createStreamingSessionParser(
  agent: "claude" | "codex",
  options: { sourcePath?: string } = {},
): {
  ingest(line: string): NormalizedMessage[];
  metadata(): Pick<
    NormalizedSession,
    "cwd" | "sessionId" | "startedAt" | "endedAt"
  >;
} {
  const out = emptySession(agent);
  const context: CodexParseContext = { sourcePath: options.sourcePath };
  return {
    ingest(line) {
      if (agent === "claude") parseClaudeJsonlLine(line, out);
      else parseCodexJsonlLine(line, out, context);
      return out.messages.splice(0, out.messages.length);
    },
    metadata() {
      return {
        cwd: out.cwd,
        sessionId: out.sessionId,
        startedAt: out.startedAt,
        endedAt: out.endedAt,
      };
    },
  };
}

function pushSessionMessage(
  out: NormalizedSession,
  role: NormalizedRole,
  blocks: NormalizedBlock[],
  timestamp?: string,
  options: {
    tokensUsed?: number;
    tokenUsage?: NormalizedTokenUsage;
    model?: string;
  } = {},
): void {
  if (
    blocks.length === 0 &&
    options.tokensUsed === undefined &&
    options.tokenUsage === undefined
  )
    return;
  if (timestamp && !out.startedAt) out.startedAt = timestamp;
  if (timestamp) out.endedAt = timestamp;
  out.messages.push({ role, blocks, timestamp, ...options });
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function codexProtocolMarkerText(name: string, rawAttrs: string): string {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_][\w-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(rawAttrs)) !== null) {
    attrs[match[1]!] = match[2]!;
  }
  if (name === "git-create-branch" && attrs.branch) {
    return `[Codex git create branch: ${attrs.branch}]`;
  }
  if (name === "git-push" && attrs.branch) {
    return `[Codex git push: ${attrs.branch}]`;
  }
  const label = name.replace(/^git-/, "git ").replace(/-/g, " ");
  return `[Codex ${label}]`;
}

function codexTextBlocks(text: string): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  let pending = "";
  const lines = text.split("\n");
  const flushPending = () => {
    const cleaned = pending.replace(/\n{2,}$/g, "\n");
    pending = "";
    if (cleaned) blocks.push({ type: "text", text: clipText(cleaned) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(/^::([A-Za-z][\w-]*)\{(.*)\}$/);
    if (marker) {
      flushPending();
      blocks.push({
        type: "marker",
        text: codexProtocolMarkerText(marker[1]!, marker[2]!),
      });
      continue;
    }
    pending += line;
    if (i < lines.length - 1) pending += "\n";
  }
  flushPending();
  return blocks;
}

function parseCodexJsonlLine(
  line: string,
  out: NormalizedSession,
  context: CodexParseContext = {},
): void {
  if (!line) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const normalized = codexTranscriptNormalizer(context).ingest(obj);
  if (normalized.recognized) {
    if (normalized.metadata?.cwd && !out.cwd) out.cwd = normalized.metadata.cwd;
    if (normalized.metadata?.sessionId && !out.sessionId) out.sessionId = normalized.metadata.sessionId;
    for (const message of normalized.messages) {
      pushSessionMessage(
        out,
        message.role,
        message.blocks,
        message.timestamp,
        {
          ...(message.tokensUsed !== undefined ? { tokensUsed: message.tokensUsed } : {}),
          ...(message.tokenUsage ? { tokenUsage: message.tokenUsage } : {}),
          ...(message.model ? { model: message.model } : {}),
        },
      );
    }
    if (normalized.metadata?.timestamp && !out.startedAt) out.startedAt = normalized.metadata.timestamp;
    if (normalized.metadata?.timestamp) out.endedAt = normalized.metadata.timestamp;
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
      blocks: codexTextBlocks(text),
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
export function parseCodexJsonl(
  text: string,
  context: CodexParseContext = {},
): NormalizedSession {
  const out = emptySession("codex");
  if (!text) return out;
  for (const line of text.split("\n")) {
    parseCodexJsonlLine(line, out, context);
  }
  return out;
}

/**
 * Parse the daemon's per-Ollama-session JSONL into a normalized chat.
 *
 * Ollama is API-driven (see plans/ollama.md "Plan: API-driven chat
 * mode"): the daemon's `/api/ollama/chat` endpoint writes one
 * `kind: "turn"` entry per user/assistant turn. The parser maps them
 * one-to-one onto messages — no PTY parsing, no ANSI stripping, no
 * `>>> ` splitter.
 *
 * Legacy PTY-captured sessions (`kind: "output"` chunks from when
 * Ollama ran as a TUI) are no longer parsed; pre-existing files of
 * that shape render as header-only. See git history for the previous
 * splitter if a recovery tool is ever needed.
 */
export function parseOllamaJsonl(text: string): NormalizedSession {
  const out = emptySession("ollama");
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let headerModel: string | undefined;
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
      if (typeof obj.model === "string") headerModel = obj.model;
    } else if (kind === "turn") {
      // Skip malformed entries rather than crashing the whole parse.
      // A garbled turn shouldn't lose the rest of the conversation.
      const role = obj.role;
      const content = obj.content;
      const attachments = parseOllamaTurnAttachments(obj.attachments);
      if (
        (role !== "user" && role !== "assistant") ||
        typeof content !== "string"
      ) {
        continue;
      }
      const blocks: NormalizedBlock[] = [
        ...attachments.map(
          (attachment): NormalizedBlock => ({
            type: "media",
            mediaKind: "image",
            path: attachment.path,
            title: attachment.title,
            alt: attachment.title,
            mimeType: attachment.mimeType,
            hasAlpha: attachment.hasAlpha,
          }),
        ),
        ...(content ? [{ type: "text" as const, text: content }] : []),
      ];
      if (blocks.length === 0) continue;
      const msg: NormalizedMessage = {
        role,
        blocks,
      };
      if (typeof obj.ts === "string") msg.timestamp = obj.ts;
      if (role === "assistant") {
        const turnModel =
          typeof obj.model === "string" ? obj.model : headerModel;
        if (turnModel) msg.author = turnModel;
      }
      out.messages.push(msg);
    } else if (kind === "exit" && typeof obj.ts === "string") {
      endedAt = obj.ts;
    }
  }
  if (startedAt) out.startedAt = startedAt;
  if (endedAt) out.endedAt = endedAt;
  return out;
}

function parseOllamaTurnAttachments(
  value: unknown,
): {
  path: string;
  title?: string;
  mimeType?: string;
  hasAlpha?: boolean;
}[] {
  if (!Array.isArray(value)) return [];
  const out: {
    path: string;
    title?: string;
    mimeType?: string;
    hasAlpha?: boolean;
  }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || !record.path) continue;
    out.push({
      path: record.path,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.mimeType === "string"
        ? { mimeType: record.mimeType }
        : {}),
      ...(typeof record.hasAlpha === "boolean"
        ? { hasAlpha: record.hasAlpha }
        : {}),
    });
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
  if (agent === "codex") {
    const session = parseCodexJsonl(text, { sourcePath: path });
    attachSessionInlineMediaUrls(session, path);
    return session;
  }
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
 * Trade-off: callers get a bounded window by default. The SPA can ask for a
 * wider bounded window on explicit scroll-back; we still never full-parse
 * arbitrarily large histories just because a column is mounted.
 *
 * Tail-append: when a file grows we read only the new bytes since
 * `cached.size`, parse them with the per-line helpers, and push them onto
 * `cached.parsed.messages`. Then we trim back to the recent window, widening
 * it enough to keep the user boundary that owns the retained work.
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
const MAX_CACHED = 256;
const MAX_CACHED_MESSAGES = 100;
const MAX_REQUESTED_MESSAGES = 2_000;
/** Per-block text cap. Claude `tool_result` blocks routinely contain full
 *  file contents (~90 KB each) — they balloon the cache far beyond what
 *  the chat view actually needs to display. We clip each block's `text`
 *  to TEXT_CLIP_BYTES bytes with a marker; the user can re-open the file
 *  in their editor for the full content. */
const TEXT_CLIP_BYTES = 16 * 1024;
const TEXT_CLIP_SUFFIX =
  "\n\n… [truncated by supergit; full content available in the source file]";
interface SessionCacheEntry {
  mtimeMs: number;
  /** Number of bytes from the file we have already parsed into `parsed`. */
  size: number;
  parsed: NormalizedSession;
  /** Stateful parser data retained so appended rows normalize relative to
   * the already-parsed transcript instead of starting a second timeline. */
  parseContext: CodexParseContext;
  /** Message window this cache entry was trimmed to. Scroll-back requests can
   *  widen one entry without changing the default window for every column. */
  maxMessages: number;
  /** Suffix of the last read that didn't end with a newline. Prepended to
   *  the next chunk so a JSONL line split across two reads still parses. */
  partialLine: string;
  /** Serialized form of `parsed` without `manualTitle`. Refreshed only when
   *  `parsed` mutates (tail-append, full re-parse); reused as-is for every
   *  cache-hit response so we don't pay `JSON.stringify` on every poll. */
  jsonNoTitle: string;
}
const sessionCache = new Map<string, SessionCacheEntry>();

interface SessionFileStatsCacheEntry {
  mtimeMs: number;
  size: number;
  newlineCount: number;
  endsWithNewline: boolean;
  codexPricing: CodexPricingScanState;
}

interface SessionPricingUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

interface SessionPricingUsageSegment {
  model?: string;
  at?: string;
  usage: SessionPricingUsage;
}

interface CodexPricingScanState {
  model?: string;
  previousTotal?: SessionPricingUsage;
  segments: SessionPricingUsageSegment[];
}

export interface SessionFileStats {
  fileSizeBytes: number;
  lineCount: number;
  model?: string;
  pricingUsage?: SessionPricingUsageSegment[];
  pricingUsageExact?: boolean;
}

const sessionFileStatsCache = new Map<string, SessionFileStatsCacheEntry>();
const sessionFileStatsInflight = new Map<string, Promise<SessionFileStats>>();
const MAX_SESSION_FILE_STATS_CACHE = 512;
const sessionFileStatsLimit = createLimiter(1);

function codexPricingUsage(value: unknown): SessionPricingUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const number = (key: string): number => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, candidate)
      : 0;
  };
  const input = number("input_tokens");
  const cachedInput = number("cached_input_tokens");
  const cacheWriteInput = number("cache_write_input_tokens");
  const output = number("output_tokens");
  const reasoningOutput = number("reasoning_output_tokens");
  const total = number("total_tokens") || input + output;
  if (total <= 0 && cachedInput <= 0 && reasoningOutput <= 0) return undefined;
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    reasoningOutput,
    total,
  };
}

function codexPricingDelta(
  current: SessionPricingUsage,
  previous: SessionPricingUsage | undefined,
  last: SessionPricingUsage | undefined,
): SessionPricingUsage {
  if (!previous) return current;
  if (current.total < previous.total) return last ?? current;
  return {
    input: Math.max(0, current.input - previous.input),
    cachedInput: Math.max(0, current.cachedInput - previous.cachedInput),
    cacheWriteInput: Math.max(
      0,
      current.cacheWriteInput - previous.cacheWriteInput,
    ),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(
      0,
      current.reasoningOutput - previous.reasoningOutput,
    ),
    total: Math.max(0, current.total - previous.total),
  };
}

function ingestCodexPricingLine(
  line: string,
  state: CodexPricingScanState,
): void {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : undefined;
  if (record.type === "turn_context" && payload) {
    const collaborationMode =
      payload.collaboration_mode &&
      typeof payload.collaboration_mode === "object"
        ? (payload.collaboration_mode as Record<string, unknown>)
        : undefined;
    const settings =
      collaborationMode?.settings &&
      typeof collaborationMode.settings === "object"
        ? (collaborationMode.settings as Record<string, unknown>)
        : undefined;
    const model = payload.model ?? settings?.model;
    if (typeof model === "string" && model.trim()) state.model = model.trim();
    return;
  }
  if (record.type !== "event_msg" || payload?.type !== "token_count") return;
  const info =
    payload.info && typeof payload.info === "object"
      ? (payload.info as Record<string, unknown>)
      : undefined;
  if (!info) return;
  const eventModel =
    info.model ?? info.model_name ?? payload.model ?? record.model;
  if (!state.model && typeof eventModel === "string" && eventModel.trim()) {
    state.model = eventModel.trim();
  }
  const total = codexPricingUsage(info.total_token_usage);
  if (!total) return;
  const delta = codexPricingDelta(
    total,
    state.previousTotal,
    codexPricingUsage(info.last_token_usage),
  );
  state.previousTotal = total;
  if (delta.total <= 0) return;
  state.segments.push({
    model: state.model,
    at: typeof record.timestamp === "string" ? record.timestamp : undefined,
    usage: delta,
  });
}

function cloneCodexPricingState(
  state: CodexPricingScanState | undefined,
): CodexPricingScanState {
  return state
    ? {
        model: state.model,
        previousTotal: state.previousTotal
          ? { ...state.previousTotal }
          : undefined,
        segments: [...state.segments],
      }
    : { segments: [] };
}

async function scanSessionStatsRange(
  path: string,
  start: number,
  end: number,
  initialPricing?: CodexPricingScanState,
): Promise<{
  newlineCount: number;
  endsWithNewline: boolean;
  codexPricing: CodexPricingScanState;
}> {
  const codexPricing = cloneCodexPricingState(initialPricing);
  if (end <= start) {
    return { newlineCount: 0, endsWithNewline: false, codexPricing };
  }
  const fh = await open(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new TextDecoder();
  let offset = start;
  let newlineCount = 0;
  let lastByte = -1;
  let lineProbe = "";
  let relevantLine = false;
  let discardLine = false;
  const MAX_LINE_PROBE = 4 * 1024;
  const MAX_RELEVANT_LINE = 512 * 1024;
  const looksRelevant = (value: string) =>
    /"type"\s*:\s*"turn_context"/.test(value) ||
    (/"type"\s*:\s*"event_msg"/.test(value) &&
      /"type"\s*:\s*"token_count"/.test(value));
  const captureOversizedTurnContext = () => {
    if (!/"type"\s*:\s*"turn_context"/.test(lineProbe)) return;
    const match = /"model"\s*:\s*("(?:\\.|[^"\\])*")/.exec(lineProbe);
    if (!match?.[1]) return;
    try {
      const model = JSON.parse(match[1]);
      if (typeof model === "string" && model.trim()) {
        codexPricing.model = model.trim();
      }
    } catch {
      // The bounded prefix ended inside the model string; a later context row
      // can still provide model evidence without retaining this giant line.
    }
  };
  const discardOversizedRelevantLine = () => {
    captureOversizedTurnContext();
    lineProbe = "";
    relevantLine = false;
    discardLine = true;
  };
  const appendLineFragment = (fragment: string) => {
    if (!fragment || discardLine) return;
    if (relevantLine) {
      if (lineProbe.length + fragment.length > MAX_RELEVANT_LINE) {
        discardOversizedRelevantLine();
      } else {
        lineProbe += fragment;
      }
      return;
    }
    const remainingProbe = MAX_LINE_PROBE - lineProbe.length;
    lineProbe += fragment.slice(0, Math.max(0, remainingProbe));
    if (looksRelevant(lineProbe)) {
      relevantLine = true;
      const remainder = fragment.slice(Math.max(0, remainingProbe));
      if (lineProbe.length + remainder.length > MAX_RELEVANT_LINE) {
        discardOversizedRelevantLine();
      } else {
        lineProbe += remainder;
      }
    } else if (lineProbe.length >= MAX_LINE_PROBE) {
      lineProbe = "";
      discardLine = true;
    }
  };
  const finishLine = () => {
    if (!discardLine && (relevantLine || looksRelevant(lineProbe))) {
      ingestCodexPricingLine(lineProbe, codexPricing);
    }
    lineProbe = "";
    relevantLine = false;
    discardLine = false;
  };
  try {
    while (offset < end) {
      const length = Math.min(buffer.length, end - offset);
      const { bytesRead } = await fh.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      let newlineAt = -1;
      while ((newlineAt = buffer.indexOf(10, newlineAt + 1)) < bytesRead) {
        if (newlineAt < 0) break;
        newlineCount++;
      }
      const text = decoder.decode(buffer.subarray(0, bytesRead), {
        stream: offset + bytesRead < end,
      });
      let textStart = 0;
      let textNewline = -1;
      while ((textNewline = text.indexOf("\n", textStart)) >= 0) {
        appendLineFragment(text.slice(textStart, textNewline));
        finishLine();
        textStart = textNewline + 1;
      }
      appendLineFragment(text.slice(textStart));
      lastByte = buffer[bytesRead - 1] ?? -1;
      offset += bytesRead;
    }
    if (lineProbe || relevantLine) finishLine();
  } finally {
    await fh.close();
  }
  return {
    newlineCount,
    endsWithNewline: lastByte === 10,
    codexPricing,
  };
}

/**
 * Exact on-disk JSONL metrics for an explicitly viewed session. The first
 * request streams the file in bounded chunks; later requests only scan bytes
 * appended since the cached snapshot. Keeping this out of detectAgents avoids
 * turning dashboard startup into a full read of every historical transcript.
 */
export async function getSessionFileStats(
  path: string,
): Promise<SessionFileStats> {
  const st = await stat(path);
  const key = `${path}\0${st.mtimeMs}\0${st.size}`;
  const pending = sessionFileStatsInflight.get(key);
  if (pending) return pending;

  const task = sessionFileStatsLimit(async () => {
    const cached = sessionFileStatsCache.get(path);
    let newlineCount = 0;
    let endsWithNewline = false;
    let codexPricing: CodexPricingScanState;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      newlineCount = cached.newlineCount;
      endsWithNewline = cached.endsWithNewline;
      codexPricing = cached.codexPricing;
    } else if (cached && cached.endsWithNewline && st.size > cached.size) {
      const appended = await scanSessionStatsRange(
        path,
        cached.size,
        st.size,
        cached.codexPricing,
      );
      newlineCount = cached.newlineCount + appended.newlineCount;
      endsWithNewline = appended.endsWithNewline;
      codexPricing = appended.codexPricing;
    } else {
      const full = await scanSessionStatsRange(path, 0, st.size);
      newlineCount = full.newlineCount;
      endsWithNewline = full.endsWithNewline;
      codexPricing = full.codexPricing;
    }
    sessionFileStatsCache.delete(path);
    sessionFileStatsCache.set(path, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      newlineCount,
      endsWithNewline,
      codexPricing,
    });
    if (sessionFileStatsCache.size > MAX_SESSION_FILE_STATS_CACHE) {
      const oldest = sessionFileStatsCache.keys().next().value;
      if (oldest !== undefined) sessionFileStatsCache.delete(oldest);
    }
    const pricingUsage =
      codexPricing.segments.length > 0 ? codexPricing.segments : undefined;
    return {
      fileSizeBytes: st.size,
      lineCount: newlineCount + (st.size > 0 && !endsWithNewline ? 1 : 0),
      ...(codexPricing.model ? { model: codexPricing.model } : {}),
      ...(pricingUsage
        ? { pricingUsage, pricingUsageExact: true as const }
        : {}),
    };
  }).finally(() => {
    sessionFileStatsInflight.delete(key);
  });
  sessionFileStatsInflight.set(key, task);
  return task;
}

export function sessionSourceOffset(fileSize: number, value: string | undefined): number {
  const requested = Number(value ?? 0);
  return Number.isFinite(requested)
    ? Math.max(0, Math.min(fileSize, Math.trunc(requested)))
    : 0;
}

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

function withManualTitle(
  session: NormalizedSession,
  manualTitle: string | undefined,
): NormalizedSession {
  return manualTitle ? { ...session, manualTitle } : session;
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

function normalizeRequestedMessages(minMessages: number | undefined): number {
  if (!Number.isFinite(minMessages)) return MAX_CACHED_MESSAGES;
  return Math.max(
    MAX_CACHED_MESSAGES,
    Math.min(MAX_REQUESTED_MESSAGES, Math.ceil(minMessages ?? 0)),
  );
}

/** Parse a chunk of JSONL into `out` in place. The chunk is split on '\n';
 *  if the chunk does not end in '\n', the trailing partial line is returned
 *  so the caller can prepend it to the next chunk. */
function appendChunk(
  agent: AgentKind,
  chunk: string,
  out: NormalizedSession,
  context: CodexParseContext = {},
): string {
  const endsWithNewline = chunk.endsWith("\n");
  const lines = chunk.split("\n");
  const trailing = endsWithNewline ? "" : (lines.pop() ?? "");
  // If the chunk ended with '\n', split() yields a trailing "" we want to skip.
  if (endsWithNewline) lines.pop();
  for (const line of lines) {
    if (agent === "claude") parseClaudeJsonlLine(line, out);
    else if (agent === "codex") parseCodexJsonlLine(line, out, context);
  }
  return trailing;
}

/** Keep at least the old bounded recent tail, and widen it only when needed
 *  to include the user turn that owns the oldest retained row plus up to the
 *  last two real user turns. The newest of those may be the currently-active
 *  turn, with no assistant response yet. Agent logs can emit hundreds of tiny
 *  tool messages after one prompt; slicing only the last N messages would hand
 *  the UI orphan tool rows with no user bubble to group under. */
function trimMessages(
  session: NormalizedSession,
  maxMessages: number = MAX_CACHED_MESSAGES,
): void {
  const count = session.messages.length;
  if (count <= maxMessages) return;

  const cappedStart = count - maxMessages;

  let containingTurnStart = -1;
  for (let i = cappedStart; i >= 0; i--) {
    if (session.messages[i]?.role === "user") {
      containingTurnStart = i;
      break;
    }
  }

  let seenUsers = 0;
  let userBoundaryStart = -1;
  for (let i = count - 1; i >= 0; i--) {
    if (session.messages[i]?.role !== "user") continue;
    seenUsers += 1;
    userBoundaryStart = i;
    if (seenUsers === 2) {
      break;
    }
  }

  const start =
    userBoundaryStart === -1 && containingTurnStart === -1
      ? cappedStart
      : Math.min(
          cappedStart,
          ...(userBoundaryStart === -1 ? [] : [userBoundaryStart]),
          ...(containingTurnStart === -1 ? [] : [containingTurnStart]),
        );
  session.messages = session.messages.slice(start);
}

function tailNeedsMoreHistory(
  session: NormalizedSession,
  maxMessages: number = MAX_CACHED_MESSAGES,
): boolean {
  if (hasOrphanedPrefix(session)) return true;
  const count = session.messages.length;
  if (count <= maxMessages) return false;
  const cappedStart = count - maxMessages;
  for (let i = cappedStart; i >= 0; i--) {
    if (session.messages[i]?.role === "user") return false;
  }
  return true;
}

function hasOrphanedPrefix(session: NormalizedSession): boolean {
  const firstUserIndex = session.messages.findIndex((m) => m.role === "user");
  if (firstUserIndex === 0) return false;
  const prefix =
    firstUserIndex === -1
      ? session.messages
      : session.messages.slice(0, firstUserIndex);
  return prefix.some((m) => m.role === "assistant" || m.role === "tool");
}

function hasOrphanedTrimHead(
  session: NormalizedSession,
  maxMessages: number = MAX_CACHED_MESSAGES,
): boolean {
  if (session.messages.length < maxMessages) return false;
  const firstUserIndex = session.messages.findIndex((m) => m.role === "user");
  if (firstUserIndex <= 0) return false;
  return session.messages
    .slice(0, firstUserIndex)
    .some((m) => m.role === "assistant" || m.role === "tool");
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
const MAX_TAIL_BYTES = 64 * 1024 * 1024; // 64 MB
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
): Promise<{
  cwd?: string;
  sessionId?: string;
  startedAt?: string;
}> {
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
    if (
      !cwd &&
      obj.type === "session_meta" &&
      obj.payload &&
      typeof obj.payload === "object"
    ) {
      const p = obj.payload as Record<string, unknown>;
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (!sessionId && typeof p.id === "string") sessionId = p.id;
    }
    if (!sessionId && typeof obj.sessionId === "string")
      sessionId = obj.sessionId;
    if (!startedAt && typeof obj.timestamp === "string")
      startedAt = obj.timestamp;
    if (cwd && sessionId && startedAt) break;
  }
  return { cwd, sessionId, startedAt };
}

async function primeCodexNormalizerBeforeTail(
  fh: Awaited<ReturnType<typeof open>>,
  tailStart: number,
  maxBytes: number,
  context: CodexParseContext,
): Promise<Buffer | null | undefined> {
  if (tailStart <= 0 || maxBytes <= 0) return undefined;
  const start = Math.max(0, tailStart - maxBytes);
  const buffer = Buffer.alloc(tailStart - start);
  await fh.read(buffer, 0, buffer.length, start);
  let completeStart = 0;
  if (start > 0) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) return undefined;
    completeStart = firstNewline + 1;
  }
  const boundaryAligned = buffer.at(-1) === 0x0a;
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeEnd = boundaryAligned
    ? buffer.length
    : Math.max(completeStart, lastNewline + 1);
  const seamPrefix = boundaryAligned
    ? null
    : Buffer.from(buffer.subarray(completeEnd));
  const lines = buffer.subarray(completeStart, completeEnd).toString("utf-8").split("\n");
  const normalize = codexTranscriptNormalizer(context);
  for (const line of lines) {
    if (!line) continue;
    try {
      normalize.ingest(JSON.parse(line));
    } catch {
      // The bounded warmup can begin between UTF-8 characters or records.
    }
  }
  return seamPrefix;
}

function primeCodexNormalizerWithSeam(
  seamPrefix: Buffer,
  tailPrefix: Buffer,
  context: CodexParseContext,
): void {
  try {
    const line = Buffer.concat([seamPrefix, tailPrefix]).toString("utf-8");
    codexTranscriptNormalizer(context).ingest(JSON.parse(line));
  } catch {
    // An oversized record can begin before the bounded warmup window.
  }
}

export async function tailParseSessionFile(
  agent: AgentKind,
  path: string,
  tailBytes: number = TAIL_BYTES,
  headBytes: number = HEAD_META_BYTES,
  context: CodexParseContext = { sourcePath: path },
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
    const codexSeam = agent === "codex"
      ? await primeCodexNormalizerBeforeTail(fh, startPos, headBytes, context)
      : undefined;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, startPos);
    let text: string;
    // Drop the first (potentially partial) line if we didn't start at offset 0.
    if (startPos > 0) {
      if (agent !== "codex" || codexSeam !== null) {
        const firstNewline = buf.indexOf(0x0a);
        if (firstNewline === -1) {
          const empty = emptySession(agent);
          if (headMeta.cwd) empty.cwd = headMeta.cwd;
          if (headMeta.sessionId) empty.sessionId = headMeta.sessionId;
          if (headMeta.startedAt) empty.startedAt = headMeta.startedAt;
          return empty;
        }
        if (agent === "codex" && codexSeam !== undefined) {
          primeCodexNormalizerWithSeam(
            codexSeam,
            buf.subarray(0, firstNewline),
            context,
          );
        }
        text = buf.subarray(firstNewline + 1).toString("utf-8");
      } else {
        text = buf.toString("utf-8");
      }
    } else {
      text = buf.toString("utf-8");
    }
    const parsed =
      agent === "claude"
        ? parseClaudeJsonl(text)
        : parseCodexJsonl(text, context);
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

async function tailParseSessionFileForCache(
  agent: AgentKind,
  path: string,
  fileSize: number,
  maxMessages: number = MAX_CACHED_MESSAGES,
): Promise<{ parsed: NormalizedSession; context: CodexParseContext }> {
  let tailBytes = Math.min(TAIL_BYTES, fileSize);
  while (true) {
    const context: CodexParseContext = { sourcePath: path };
    const parsed = await tailParseSessionFile(
      agent,
      path,
      tailBytes,
      HEAD_META_BYTES,
      context,
    );
    if (!tailNeedsMoreHistory(parsed, maxMessages)) return { parsed, context };
    if (tailBytes >= fileSize || tailBytes >= MAX_TAIL_BYTES) {
      return { parsed, context };
    }
    tailBytes = Math.min(tailBytes * 2, fileSize, MAX_TAIL_BYTES);
  }
}

/**
 * Return the /api/session response body plus the parsed session, using a
 * tail-based parsed-session cache. Batch callers use `session` to compute
 * hashes/patches without reparsing the JSON body they are about to send.
 */
async function getSessionResponseData(
  agent: AgentKind,
  path: string,
  manualTitle?: string,
  minMessages?: number,
): Promise<{ body: string; etag: string; session: NormalizedSession }> {
  const maxMessages = normalizeRequestedMessages(minMessages);
  const st = await stat(path).catch(() => null);
  if (!st) {
    const session = emptySession(agent);
    const body = injectManualTitle(JSON.stringify(session), manualTitle);
    return {
      body,
      etag: `"0-0"`,
      session: withManualTitle(session, manualTitle),
    };
  }
  const etag = `"${st.mtimeMs}-${st.size}"`;

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
    trimMessages(parsed, maxMessages);
    attachSessionInlineMediaUrls(parsed, path);
    return {
      body: injectManualTitle(JSON.stringify(parsed), manualTitle),
      etag,
      session: withManualTitle(parsed, manualTitle),
    };
  }

  const cached = sessionCache.get(path);

  // Cache hit, file unchanged: return the pre-stringified body. No
  // parse, no stringify, no Buffer alloc — the cheapest possible path.
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.maxMessages >= maxMessages &&
    !hasOrphanedTrimHead(cached.parsed, cached.maxMessages)
  ) {
    touch(path, cached);
    return {
      body: injectManualTitle(cached.jsonNoTitle, manualTitle),
      etag,
      session: withManualTitle(cached.parsed, manualTitle),
    };
  }

  // Cache hit, file grew: incremental append. We don't gate on mtimeMs here
  // — size growth alone is a strong signal an active agent has written
  // more JSONL. (mtime updates as well in practice, but Bun on some FSes
  // batches mtime updates while size advances byte-by-byte.)
  if (
    cached &&
    st.size > cached.size &&
    cached.maxMessages >= maxMessages &&
    agent !== "copilot" &&
    !hasOrphanedTrimHead(cached.parsed, cached.maxMessages)
  ) {
    const fh = await open(path, "r").catch(() => null);
    if (fh) {
      try {
        const length = st.size - cached.size;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, cached.size);
        const chunk = cached.partialLine + buf.toString("utf-8");
        const newPartial = appendChunk(
          agent,
          chunk,
          cached.parsed,
          cached.parseContext,
        );
        cached.partialLine = newPartial;
        cached.size = st.size;
        cached.mtimeMs = st.mtimeMs;
        trimMessages(cached.parsed, cached.maxMessages);
        attachSessionInlineMediaUrls(cached.parsed, path);
        cached.jsonNoTitle = JSON.stringify(cached.parsed);
        touch(path, cached);
        return {
          body: injectManualTitle(cached.jsonNoTitle, manualTitle),
          etag,
          session: withManualTitle(cached.parsed, manualTitle),
        };
      } finally {
        await fh.close();
      }
    }
  }

  // Cache miss, or file shrank/got rewritten: tail-read only the last
  // TAIL_BYTES and parse those lines.
  const { parsed, context: parseContext } = await tailParseSessionFileForCache(
    agent,
    path,
    st.size,
    maxMessages,
  );
  trimMessages(parsed, maxMessages);
  attachSessionInlineMediaUrls(parsed, path);
  const jsonNoTitle = JSON.stringify(parsed);
  sessionCache.set(path, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    parsed,
    parseContext,
    maxMessages,
    partialLine: "",
    jsonNoTitle,
  });
  evictLRU();
  return {
    body: injectManualTitle(jsonNoTitle, manualTitle),
    etag,
    session: withManualTitle(parsed, manualTitle),
  };
}

export async function getSessionResponseJson(
  agent: AgentKind,
  path: string,
  manualTitle?: string,
  minMessages?: number,
): Promise<{ body: string; etag: string }> {
  const { body, etag } = await getSessionResponseData(
    agent,
    path,
    manualTitle,
    minMessages,
  );
  return { body, etag };
}

function cachedSessionCanSatisfy(
  path: string,
  minMessages: number | undefined,
): boolean {
  const cached = sessionCache.get(path);
  return !!cached && cached.maxMessages >= normalizeRequestedMessages(minMessages);
}

/** One source's outcome in a `/api/sessions/batch` response. Mirrors the
 *  single-source `/api/session` route: 200 carries the body + ETag, 304 just
 *  the ETag (caller keeps its cached copy), 403 means the source is outside
 *  any known agent root. */
export type BatchSessionResult =
  | {
      source: string;
      status: 200;
      etag: string;
      body: string;
      messageHashes: string[];
    }
  | {
      source: string;
      status: 206;
      etag: string;
      session: Omit<NormalizedSession, "messages">;
      patch: {
        oldStart: number;
        oldEnd: number;
        messages: NormalizedMessage[];
      };
      messageHashes: string[];
    }
  | { source: string; status: 304; etag: string }
  | { source: string; status: 403 };

export interface BatchSessionCursor {
  index: number;
  hash: string;
}

function hashMessage(message: NormalizedMessage): string {
  return createHash("sha1")
    .update(JSON.stringify(message))
    .digest("base64url")
    .slice(0, 16);
}

function messageHashes(messages: readonly NormalizedMessage[]): string[] {
  return messages.map(hashMessage);
}

function sessionMeta(
  session: NormalizedSession,
): Omit<NormalizedSession, "messages"> {
  const { messages: _messages, ...meta } = session;
  return meta;
}

function patchFromCursor(
  session: NormalizedSession,
  hashes: string[],
  cursor: readonly BatchSessionCursor[] | undefined,
): {
  session: Omit<NormalizedSession, "messages">;
  patch: {
    oldStart: number;
    oldEnd: number;
    messages: NormalizedMessage[];
  };
  messageHashes: string[];
} | null {
  if (!cursor || cursor.length === 0 || session.messages.length === 0) {
    return null;
  }
  const hashesByValue = new Map<string, number[]>();
  hashes.forEach((hash, index) => {
    const list = hashesByValue.get(hash);
    if (list) list.push(index);
    else hashesByValue.set(hash, [index]);
  });
  const candidates = cursor
    .filter(
      (sample): sample is BatchSessionCursor =>
        Number.isInteger(sample.index) &&
        sample.index >= 0 &&
        typeof sample.hash === "string" &&
        sample.hash.length > 0,
    )
    .sort((a, b) => b.index - a.index);
  for (const sample of candidates) {
    const matchingNewIndexes = hashesByValue.get(sample.hash);
    if (!matchingNewIndexes) continue;
    for (const newIndex of [...matchingNewIndexes].reverse()) {
      const oldStart = sample.index - newIndex;
      if (oldStart < 0) continue;
      return {
        session: sessionMeta(session),
        patch: {
          oldStart,
          oldEnd: sample.index + 1,
          messages: session.messages.slice(newIndex + 1),
        },
        messageHashes: hashes,
      };
    }
  }
  return null;
}

/**
 * Batched equivalent of the `/api/session` GET handler: resolve + 304/200 each
 * source in one call so the client can coalesce N per-column polls into a single
 * request (see plans/performance.md "per-column session-poll storm"). Kept here
 * (not in the server monolith) so it's unit-testable.
 *
 * Per source: `resolveAgent` gates it to a known agent root (null → 403); a
 * cheap stat-based ETag short-circuits to 304 *before* the full parse when the
 * client's ETag still matches; otherwise the full body is built and compared,
 * returning 304 on an exact ETag match and 200 with the body otherwise.
 *
 * @param items        sources to fetch, each with the client's last ETag (if any)
 * @param resolveAgent maps a source to its AgentKind, or null if disallowed
 * @param getTitle     manual title to inject for a source, or undefined
 */
export async function getSessionsBatchResults(
  items: {
    source: string;
    etag?: string;
    messageCursor?: BatchSessionCursor[];
    minMessages?: number;
  }[],
  resolveAgent: (source: string) => AgentKind | null,
  getTitle: (source: string) => string | undefined,
): Promise<BatchSessionResult[]> {
  return Promise.all(
    items.map(
      async ({
        source,
        etag,
        messageCursor,
        minMessages,
      }): Promise<BatchSessionResult> => {
        const agent = resolveAgent(source);
        if (!agent) return { source, status: 403 };

        // Quick stat ETag: skip the parse entirely when the file is unchanged.
        // Matches getSessionResponseJson's `"<mtimeMs>-<size>"` scheme.
        const cacheAlreadySatisfiesRequest = cachedSessionCanSatisfy(
          source,
          minMessages,
        );
        if (etag) {
          const st = await stat(source).catch(() => null);
          if (st) {
            const quick = `"${st.mtimeMs}-${st.size}"`;
            if (etag === quick && cacheAlreadySatisfiesRequest) {
              return { source, status: 304, etag: quick };
            }
          }
        }

        const {
          body,
          etag: full,
          session,
        } = await getSessionResponseData(
          agent,
          source,
          getTitle(source),
          minMessages,
        );
        if (etag && etag === full && cacheAlreadySatisfiesRequest) {
          return { source, status: 304, etag: full };
        }
        const hashes = messageHashes(session.messages);
        if (etag) {
          const patch = patchFromCursor(session, hashes, messageCursor);
          if (patch) return { source, status: 206, etag: full, ...patch };
        }
        return { source, status: 200, etag: full, body, messageHashes: hashes };
      },
    ),
  );
}
