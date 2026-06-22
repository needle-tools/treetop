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
  | "plan"
  | "tool_use"
  | "tool_result"
  /** Image/file artifact produced by or supplied to an agent. */
  | "media"
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
  return /^\[(Request interrupted|Tool use rejected|Tool use was rejected|Request interrupted by user)\b/i.test(
    t,
  );
}

export interface NormalizedBlock {
  type: NormalizedBlockKind;
  /** Free-form text. For tool_result this is the rendered output. */
  text?: string;
  /** tool_use only. */
  toolName?: string;
  toolInput?: unknown;
  /** plan only. */
  explanation?: string;
  planItems?: NormalizedPlanItem[];
  /** Links a tool_result back to the tool_use that produced it. */
  toolUseId?: string;
  /** For ide_context / system_reminder / command: the tag name, e.g. "ide_opened_file". */
  tagName?: string;
  /** media only. */
  mediaKind?: "image" | "file" | "artifact";
  mimeType?: string;
  path?: string;
  url?: string;
  title?: string;
  alt?: string;
}

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
  const url =
    stringProp(raw, "url") ??
    stringProp(raw, "image_url") ??
    stringProp(container, "url") ??
    stringProp(container, "image_url");
  const mimeType =
    stringProp(raw, "mime_type") ??
    stringProp(raw, "mimeType") ??
    stringProp(raw, "media_type") ??
    stringProp(container, "mime_type") ??
    stringProp(container, "mimeType") ??
    stringProp(container, "media_type");
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
  if (!path && !url && source?.type === "base64") {
    block.text = `[${mimeType ?? "image"} data stored in source transcript]`;
  }
  return block;
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

function codexTimestamp(obj: Record<string, unknown>): string | undefined {
  return typeof obj.timestamp === "string" ? obj.timestamp : undefined;
}

function pushSessionMessage(
  out: NormalizedSession,
  role: NormalizedRole,
  blocks: NormalizedBlock[],
  timestamp?: string,
): void {
  if (blocks.length === 0) return;
  if (timestamp && !out.startedAt) out.startedAt = timestamp;
  if (timestamp) out.endedAt = timestamp;
  out.messages.push({ role, blocks, timestamp });
}

function codexToolInput(input: unknown): unknown {
  if (typeof input !== "string") return clipToolInput(input);
  try {
    return clipToolInput(JSON.parse(input));
  } catch {
    return clipToolInput(input);
  }
}

function normalizePlanFromUnknown(
  input: unknown,
): { explanation?: string; planItems: NormalizedPlanItem[] } | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const rawPlan = record.plan;
  if (!Array.isArray(rawPlan)) return null;
  const planItems = rawPlan
    .map((item): NormalizedPlanItem | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const step = typeof row.step === "string" ? row.step.trim() : "";
      if (!step) return null;
      const status =
        typeof row.status === "string" && row.status.trim()
          ? row.status.trim()
          : "pending";
      return { step: clipText(step), status };
    })
    .filter((item): item is NormalizedPlanItem => item !== null);
  if (planItems.length === 0) return null;
  const explanation =
    typeof record.explanation === "string" && record.explanation.trim()
      ? clipText(record.explanation.trim())
      : undefined;
  return { explanation, planItems };
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

function codexVisibleUserText(text: string): string {
  let visible = text;
  visible = visible.replace(
    /<environment_context>[\s\S]*?<\/environment_context>/g,
    "",
  );
  visible = visible.replace(
    /<filesystem>[\s\S]*?<\/filesystem>/g,
    "",
  );
  visible = visible.replace(
    /<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/g,
    "",
  );
  const trimmed = visible.trim();
  if (/^#\s+(AGENTS|CLAUDE)\.md instructions\b/i.test(trimmed)) return "";
  if (/^#\s+(Instructions|Context|System)\b/i.test(trimmed)) return "";
  return trimmed;
}

function codexEventMarker(payload: Record<string, unknown>): string | null {
  switch (payload.type) {
    case "task_started":
      return "[Task started]";
    case "task_complete":
      return "[Task complete]";
    case "context_compacted":
      return "[Context compacted]";
    case "turn_aborted": {
      const reason =
        typeof payload.reason === "string" && payload.reason.trim()
          ? `: ${payload.reason.trim()}`
          : "";
      return `[Turn aborted${reason}]`;
    }
    default:
      return null;
  }
}

function codexPatchApplyText(payload: Record<string, unknown>): string {
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  const text = [stdout, stderr].filter(Boolean).join("\n");
  if (text) return text;
  return payload.success === false ? "Patch apply failed" : "Patch applied";
}

function codexWebSearchText(payload: Record<string, unknown>): string {
  const query = typeof payload.query === "string" ? payload.query : "";
  const action =
    payload.action && typeof payload.action === "object"
      ? JSON.stringify(payload.action)
      : "";
  const text = [query, action].filter(Boolean).join("\n");
  return text || "Web search completed";
}

const codexToolNamesBySession = new WeakMap<
  NormalizedSession,
  Map<string, string>
>();

function codexToolNames(out: NormalizedSession): Map<string, string> {
  let names = codexToolNamesBySession.get(out);
  if (!names) {
    names = new Map();
    codexToolNamesBySession.set(out, names);
  }
  return names;
}

function rememberCodexToolName(
  out: NormalizedSession,
  id: unknown,
  name: string | undefined,
): void {
  if (typeof id !== "string" || !id || !name) return;
  codexToolNames(out).set(id, name);
}

function codexToolNameForResult(
  out: NormalizedSession,
  id: unknown,
): string | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return codexToolNames(out).get(id);
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
  if (
    obj.type === "session_meta" &&
    obj.payload &&
    typeof obj.payload === "object"
  ) {
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
  if (
    obj.type === "response_item" &&
    obj.payload &&
    typeof obj.payload === "object"
  ) {
    const p = obj.payload as Record<string, unknown>;
    const ts = codexTimestamp(obj);
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name =
        typeof p.name === "string"
          ? p.name
          : p.type === "custom_tool_call"
            ? "custom_tool"
            : "function_call";
      const input =
        p.type === "function_call"
          ? codexToolInput(p.arguments)
          : clipToolInput(p.input);
      rememberCodexToolName(out, p.call_id, name);
      if (name === "update_plan") {
        const plan = normalizePlanFromUnknown(input);
        if (plan) {
          pushSessionMessage(
            out,
            "assistant",
            [
              {
                type: "plan",
                explanation: plan.explanation,
                planItems: plan.planItems,
                toolName: name,
                toolInput: input,
                toolUseId:
                  typeof p.call_id === "string" ? p.call_id : undefined,
              },
            ],
            ts,
          );
          return;
        }
      }
      pushSessionMessage(
        out,
        "assistant",
        [
          {
            type: "tool_use",
            toolName: name,
            toolInput: input,
            toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
          },
        ],
        ts,
      );
      return;
    }
    if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output"
    ) {
      const text = typeof p.output === "string" ? p.output : "";
      pushSessionMessage(
        out,
        "tool",
        [
          {
            type: "tool_result",
            text: clipText(text),
            toolName: codexToolNameForResult(out, p.call_id),
            toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
          },
        ],
        ts,
      );
      return;
    }
    if (p.type === "web_search_call") {
      rememberCodexToolName(out, p.call_id, "web_search");
      pushSessionMessage(
        out,
        "assistant",
        [
          {
            type: "tool_use",
            toolName: "web_search",
            toolInput: clipToolInput({
              status: p.status,
              action: p.action,
            }),
            toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
          },
        ],
        ts,
      );
      return;
    }
    if (
      typeof p.type === "string" &&
      /image.*(?:call|generation)/i.test(p.type)
    ) {
      const media = mediaBlockFromContent(p);
      if (media && (media.path || media.url || media.mimeType)) {
        pushSessionMessage(out, "assistant", [media], ts);
      } else {
        pushSessionMessage(
          out,
          "assistant",
          [
            {
              type: "tool_use",
              toolName: p.type,
              toolInput: clipToolInput(p),
              toolUseId:
                typeof p.call_id === "string" ? p.call_id : undefined,
            },
          ],
          ts,
        );
      }
      return;
    }
    {
      const media = mediaBlockFromContent(p);
      if (media && (media.path || media.url || media.mimeType)) {
        pushSessionMessage(out, "assistant", [media], ts);
        return;
      }
    }
    if (p.type !== "message") return;
    const role: NormalizedRole = (() => {
      if (typeof p.role !== "string") return "user";
      if (p.role === "assistant") return "assistant";
      if (p.role === "system" || p.role === "developer") return "system";
      return "user";
    })();
    if (role === "system") return;
    const blocks: NormalizedBlock[] = [];
    if (Array.isArray(p.content)) {
      for (const raw of p.content) {
        if (typeof raw !== "object" || raw === null) continue;
        const b = raw as Record<string, unknown>;
        if (typeof b.text === "string") {
          const text = role === "user" ? codexVisibleUserText(b.text) : b.text;
          if (text) blocks.push(...codexTextBlocks(text));
        } else {
          const media = mediaBlockFromContent(b);
          if (media) blocks.push(media);
        }
      }
    } else if (typeof p.content === "string") {
      const text =
        role === "user" ? codexVisibleUserText(p.content) : p.content;
      if (text) blocks.push(...codexTextBlocks(text));
    }
    pushSessionMessage(out, role, blocks, ts);
    return;
  }
  if (obj.type === "compacted") {
    pushSessionMessage(
      out,
      "system",
      [{ type: "marker", text: "[Context compacted]" }],
      codexTimestamp(obj),
    );
    return;
  }
  if (
    obj.type === "event_msg" &&
    obj.payload &&
    typeof obj.payload === "object"
  ) {
    const p = obj.payload as Record<string, unknown>;
    const ts = codexTimestamp(obj);
    const marker = codexEventMarker(p);
    if (marker) {
      pushSessionMessage(out, "system", [{ type: "marker", text: marker }], ts);
      return;
    }
    if (p.type === "patch_apply_end") {
      pushSessionMessage(
        out,
        "tool",
        [
          {
            type: "tool_result",
            text: clipText(codexPatchApplyText(p)),
            toolName: codexToolNameForResult(out, p.call_id) ?? "apply_patch",
            toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
          },
        ],
        ts,
      );
      return;
    }
    if (p.type === "web_search_end") {
      pushSessionMessage(
        out,
        "tool",
        [
          {
            type: "tool_result",
            text: clipText(codexWebSearchText(p)),
            toolName:
              codexToolNameForResult(out, p.call_id) ?? "web_search",
            toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
          },
        ],
        ts,
      );
      return;
    }
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
      if (
        (role !== "user" && role !== "assistant") ||
        typeof content !== "string"
      ) {
        continue;
      }
      const msg: NormalizedMessage = {
        role,
        blocks: [{ type: "text", text: content }],
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

/** Keep at least the old bounded recent tail, and widen it only when needed
 *  to include the user turn that owns the oldest retained row plus up to the
 *  last two real user turns. The newest of those may be the currently-active
 *  turn, with no assistant response yet. Agent logs can emit hundreds of tiny
 *  tool messages after one prompt; slicing only the last N messages would hand
 *  the UI orphan tool rows with no user bubble to group under. */
function trimMessages(session: NormalizedSession): void {
  const count = session.messages.length;
  if (count <= MAX_CACHED_MESSAGES) return;

  const cappedStart = count - MAX_CACHED_MESSAGES;

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

function tailNeedsMoreHistory(session: NormalizedSession): boolean {
  if (hasOrphanedPrefix(session)) return true;
  const count = session.messages.length;
  if (count <= MAX_CACHED_MESSAGES) return false;
  const cappedStart = count - MAX_CACHED_MESSAGES;
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

function hasOrphanedTrimHead(session: NormalizedSession): boolean {
  if (session.messages.length < MAX_CACHED_MESSAGES) return false;
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
    const parsed =
      agent === "claude" ? parseClaudeJsonl(text) : parseCodexJsonl(text);
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
): Promise<NormalizedSession> {
  let tailBytes = Math.min(TAIL_BYTES, fileSize);
  while (true) {
    const parsed = await tailParseSessionFile(agent, path, tailBytes);
    if (!tailNeedsMoreHistory(parsed)) return parsed;
    if (tailBytes >= fileSize || tailBytes >= MAX_TAIL_BYTES) return parsed;
    tailBytes = Math.min(tailBytes * 2, fileSize, MAX_TAIL_BYTES);
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
): Promise<{ body: string; etag: string }> {
  const st = await stat(path).catch(() => null);
  if (!st) {
    const body = injectManualTitle(
      JSON.stringify(emptySession(agent)),
      manualTitle,
    );
    return { body, etag: `"0-0"` };
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
    trimMessages(parsed);
    return {
      body: injectManualTitle(JSON.stringify(parsed), manualTitle),
      etag,
    };
  }

  const cached = sessionCache.get(path);

  // Cache hit, file unchanged: return the pre-stringified body. No
  // parse, no stringify, no Buffer alloc — the cheapest possible path.
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    !hasOrphanedTrimHead(cached.parsed)
  ) {
    touch(path, cached);
    return { body: injectManualTitle(cached.jsonNoTitle, manualTitle), etag };
  }

  // Cache hit, file grew: incremental append. We don't gate on mtimeMs here
  // — size growth alone is a strong signal an active agent has written
  // more JSONL. (mtime updates as well in practice, but Bun on some FSes
  // batches mtime updates while size advances byte-by-byte.)
  if (
    cached &&
    st.size > cached.size &&
    agent !== "copilot" &&
    !hasOrphanedTrimHead(cached.parsed)
  ) {
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
        cached.jsonNoTitle = JSON.stringify(cached.parsed);
        touch(path, cached);
        return {
          body: injectManualTitle(cached.jsonNoTitle, manualTitle),
          etag,
        };
      } finally {
        await fh.close();
      }
    }
  }

  // Cache miss, or file shrank/got rewritten: tail-read only the last
  // TAIL_BYTES and parse those lines.
  const parsed = await tailParseSessionFileForCache(agent, path, st.size);
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
  return { body: injectManualTitle(jsonNoTitle, manualTitle), etag };
}

/** One source's outcome in a `/api/sessions/batch` response. Mirrors the
 *  single-source `/api/session` route: 200 carries the body + ETag, 304 just
 *  the ETag (caller keeps its cached copy), 403 means the source is outside
 *  any known agent root. */
export type BatchSessionResult =
  | { source: string; status: 200; etag: string; body: string }
  | { source: string; status: 304; etag: string }
  | { source: string; status: 403 };

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
  items: { source: string; etag?: string }[],
  resolveAgent: (source: string) => AgentKind | null,
  getTitle: (source: string) => string | undefined,
): Promise<BatchSessionResult[]> {
  return Promise.all(
    items.map(async ({ source, etag }): Promise<BatchSessionResult> => {
      const agent = resolveAgent(source);
      if (!agent) return { source, status: 403 };

      // Quick stat ETag: skip the parse entirely when the file is unchanged.
      // Matches getSessionResponseJson's `"<mtimeMs>-<size>"` scheme.
      if (etag) {
        const st = await stat(source).catch(() => null);
        if (st) {
          const quick = `"${st.mtimeMs}-${st.size}"`;
          if (etag === quick) return { source, status: 304, etag: quick };
        }
      }

      const { body, etag: full } = await getSessionResponseJson(
        agent,
        source,
        getTitle(source),
      );
      if (etag && etag === full) return { source, status: 304, etag: full };
      return { source, status: 200, etag: full, body };
    }),
  );
}
