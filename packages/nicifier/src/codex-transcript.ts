import {
  canonicalCodexToolName,
  codexPatchApplyResultText,
  codexSubagentActivityFields,
  parseCodexImageWrapper,
  parseCodexToolScriptInvocations,
  visualFileEditSummaryForBlock,
} from "./tool-preview.js";
import {
  contextTokenSnapshotFromUsageRecord,
  type ContextCompactionDetails,
} from "./model-pricing.js";
import { createCodexContextUpdateNormalizer } from "./session-context.js";
import type { VisualFileEdit } from "./core/types.js";

export type CodexTranscriptRole = "user" | "assistant" | "system" | "tool";

export interface CodexTranscriptTokenUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

export interface AgentTranscriptBlock {
  type:
    | "text"
    | "thinking"
    | "plan"
    | "goal"
    | "tool_use"
    | "tool_result"
    | "media"
    | "ide_context"
    | "system_reminder"
    | "context_update"
    | "command"
    | "question"
    | "marker"
    | "subagent";
  text?: string;
  questionId?: string;
  questionOptions?: readonly { label: string; description?: string }[];
  toolName?: string;
  toolInput?: unknown;
  toolInvocations?: readonly {
    toolName: string;
    toolInput: unknown;
    observedFileEdits?: readonly VisualFileEdit[];
  }[];
  observedFileEdits?: readonly VisualFileEdit[];
  toolUseId?: string;
  approvalPolicy?: string;
  approvalDecision?: string;
  sandboxPolicy?: string;
  explanation?: string;
  planItems?: { step: string; status: string }[];
  goalObjective?: string;
  goalStatus?: string;
  goalTokensUsed?: number;
  goalTimeUsedSeconds?: number;
  goalUpdatedAt?: number;
  goalThreadId?: string;
  tagName?: string;
  contextRole?: "developer" | "system";
  contextPhase?: "set" | "changed" | "reapplied";
  contextCategory?: string;
  contextCharacters?: number;
  contextPreviousCharacters?: number;
  contextDeltaCharacters?: number;
  contextDiff?: string;
  mediaKind?: "image" | "file" | "artifact";
  mimeType?: string;
  path?: string;
  url?: string;
  inlineDataHash?: string;
  title?: string;
  alt?: string;
  hasAlpha?: boolean;
  compaction?: ContextCompactionDetails;
  subagentId?: string;
  subagentNickname?: string;
  subagentAction?: "spawn" | "wait" | "notification";
  subagentStatus?: "running" | "completed" | "failed" | "unknown";
  subagentType?: string;
  subagentModel?: string;
  subagentEffort?: string;
  subagentMessage?: string;
  subagentResult?: string;
}

export type CodexTranscriptBlock = AgentTranscriptBlock;

/** Normalize Codex's non-blocking question payload into the same visual block
 * shape for JSONL transcripts and app-server item snapshots. */
export function asyncQuestionBlocksFromPayload(
  value: unknown,
  groupId?: string,
): AgentTranscriptBlock[] {
  const payload = object(value);
  if (!payload || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((entry, index) => {
    const question = object(entry);
    if (!question) return [];
    const text =
      string(question, "question") ??
      string(question, "title") ??
      string(question, "header");
    if (!text?.trim()) return [];
    const questionId =
      string(question, "id") ?? (groupId ? `${groupId}:${index}` : undefined);
    const questionOptions = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (typeof option === "string" && option.trim()) {
            return [{ label: option }];
          }
          const row = object(option);
          const label = string(row, "label");
          return label?.trim()
            ? [{
                label,
                ...(string(row, "description")
                  ? { description: string(row, "description") }
                  : {}),
              }]
            : [];
        })
      : [];
    return [{
      type: "question" as const,
      text,
      ...(questionId ? { questionId } : {}),
      ...(questionOptions.length ? { questionOptions } : {}),
    }];
  });
}

export interface CodexTranscriptMessage {
  role: CodexTranscriptRole;
  blocks: CodexTranscriptBlock[];
  timestamp?: string;
  tokensUsed?: number;
  tokenUsage?: CodexTranscriptTokenUsage;
  model?: string;
}

export interface CodexTranscriptRecordResult {
  recognized: boolean;
  messages: CodexTranscriptMessage[];
  metadata?: { cwd?: string; sessionId?: string; timestamp?: string };
}

export interface CodexTranscriptNormalizerOptions {
  resolveInlineData?: (
    dataUrl: string,
  ) => Pick<CodexTranscriptBlock, "url" | "inlineDataHash"> | undefined;
  generatedImagePath?: (record: Record<string, unknown>) => string | undefined;
}

const TRANSCRIPT_TEXT_LIMIT = 16 * 1024;
const TRANSCRIPT_TEXT_CLIP_SUFFIX = "… [truncated by Treetop]";

export function clipTranscriptText(text: string): string {
  if (text.length <= TRANSCRIPT_TEXT_LIMIT) return text;
  return `${text.slice(0, TRANSCRIPT_TEXT_LIMIT)}${TRANSCRIPT_TEXT_CLIP_SUFFIX}`;
}

export function clipTranscriptValue(value: unknown): unknown {
  if (typeof value === "string") return clipTranscriptText(value);
  if (Array.isArray(value)) return value.map(clipTranscriptValue);
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, clipTranscriptValue(item)]),
  );
}

export function isCodexTranscriptRecord(value: unknown): boolean {
  const record = object(value);
  if (!record) return false;
  return [
    "session_meta",
    "response_item",
    "event_msg",
    "turn_context",
    "compacted",
  ].includes(string(record, "type") ?? "");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function mediaKind(type?: string, mime?: string, source?: string): "image" | "file" | "artifact" {
  if (
    type?.toLowerCase().includes("image") ||
    mime?.toLowerCase().startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:$|[?#])/i.test(source ?? "")
  ) return "image";
  return source || mime ? "file" : "artifact";
}

function mediaTitle(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function containsClippedString(before: unknown, after: unknown): boolean {
  if (typeof before === "string") return typeof after === "string" && after !== before;
  if (!before || typeof before !== "object" || !after || typeof after !== "object") return false;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.some((value, index) => containsClippedString(value, after[index]));
  }
  if (Array.isArray(before) || Array.isArray(after)) return false;
  const afterRecord = after as Record<string, unknown>;
  return Object.entries(before as Record<string, unknown>).some(([key, value]) => containsClippedString(value, afterRecord[key]));
}

function usageFrom(value: unknown): CodexTranscriptTokenUsage | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const input = number(usage.input_tokens ?? usage.inputTokens) ?? 0;
  const cachedInput = number(usage.cached_input_tokens ?? usage.cachedInputTokens) ?? 0;
  const cacheWriteInput = number(
    usage.cache_write_input_tokens ??
      usage.cacheWriteInputTokens ??
      usage.cache_creation_input_tokens ??
      usage.cacheCreationInputTokens,
  ) ?? 0;
  const output = number(usage.output_tokens ?? usage.outputTokens) ?? 0;
  const reasoningOutput = number(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens) ?? 0;
  const total = number(usage.total_tokens ?? usage.totalTokens) ?? input + output;
  return input + cachedInput + cacheWriteInput + output + reasoningOutput > 0
    ? { input, cachedInput, cacheWriteInput, output, reasoningOutput, total }
    : undefined;
}

function usageDelta(current: CodexTranscriptTokenUsage, previous?: CodexTranscriptTokenUsage): CodexTranscriptTokenUsage {
  if (!previous || current.total < previous.total) return current;
  return {
    input: Math.max(0, current.input - previous.input),
    cachedInput: Math.max(0, current.cachedInput - previous.cachedInput),
    cacheWriteInput: Math.max(0, current.cacheWriteInput - previous.cacheWriteInput),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(0, current.reasoningOutput - previous.reasoningOutput),
    total: Math.max(0, current.total - previous.total),
  };
}

function visibleUserText(value: string): string {
  const visible = value
    .replace(/<goal_context\b[^>]*>[\s\S]*?<\/goal_context>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<filesystem>[\s\S]*?<\/filesystem>/g, "")
    .replace(/<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/g, "")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hex, decimal) => {
      const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    })
    .trim();
  if (/^#\s+(AGENTS|CLAUDE)\.md instructions\b/i.test(visible)) return "";
  if (/^#\s+(Instructions|Context|System)\b/i.test(visible)) return "";
  return visible;
}

function protocolTextBlocks(value: string, clip: (text: string) => string): CodexTranscriptBlock[] {
  const blocks: CodexTranscriptBlock[] = [];
  let pending = "";
  const flush = () => {
    const text = pending.replace(/\n{2,}$/g, "\n");
    pending = "";
    if (text) blocks.push({ type: "text", text: clip(text) });
  };
  const lines = value.split("\n");
  lines.forEach((line, index) => {
    const marker = line.match(/^::([A-Za-z][\w-]*)\{(.*)\}$/);
    if (marker) {
      flush();
      const attrs = Object.fromEntries(
        [...marker[2]!.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)]
          .map((match) => [match[1]!, match[2]!]),
      );
      const name = marker[1]!;
      const label = name === "git-create-branch" && attrs.branch
        ? `git create branch: ${attrs.branch}`
        : name === "git-push" && attrs.branch
          ? `git push: ${attrs.branch}`
          : name.replace(/^git-/, "git ").replace(/-/g, " ");
      blocks.push({ type: "marker", text: `[Codex ${label}]` });
    } else {
      pending += line + (index < lines.length - 1 ? "\n" : "");
    }
  });
  flush();
  return blocks;
}

function contentMedia(
  raw: Record<string, unknown>,
  resolveInlineData?: CodexTranscriptNormalizerOptions["resolveInlineData"],
): CodexTranscriptBlock | undefined {
  const type = string(raw, "type");
  const container = object(raw.output_image) ??
    object(raw.image_url) ??
    object(raw.source) ??
    object(raw.file) ??
    raw;
  const path = string(raw, "path") ??
    string(raw, "file_path") ??
    string(raw, "filePath") ??
    string(container, "path") ??
    string(container, "file_path") ??
    string(container, "filePath");
  const rawUrl = string(raw, "url") ??
    string(raw, "image_url") ??
    string(container, "url") ??
    string(container, "image_url");
  const dataMime = rawUrl?.match(/^data:([^;,]+)?(?:;[^,]*)?,/i)?.[1];
  const url = dataMime ? undefined : rawUrl;
  const mimeType = string(raw, "mime_type") ??
    string(raw, "mimeType") ??
    string(raw, "media_type") ??
    string(container, "mime_type") ??
    string(container, "mimeType") ??
    string(container, "media_type") ??
    dataMime;
  const kind = mediaKind(type, mimeType, path ?? url);
  const knownType = [
    "image", "input_image", "output_image", "localImage", "file", "artifact",
    "input_file", "output_file",
  ].includes(type ?? "");
  if (!knownType && !path && !url && !mimeType) return undefined;
  const title = string(raw, "title") ??
    string(raw, "name") ??
    string(raw, "filename") ??
    string(container, "title") ??
    string(container, "name") ??
    string(container, "filename") ??
    (kind === "image" ? "Image" : "Artifact");
  return {
    type: "media",
    mediaKind: kind,
    title,
    alt: string(raw, "alt") ?? string(raw, "alt_text") ?? title,
    ...(mimeType ? { mimeType } : {}),
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(!path && !url && (object(raw.source)?.type === "base64" || dataMime)
      ? {
          text: `[${mimeType ?? "image"} data stored in source transcript]`,
          ...(rawUrl ? resolveInlineData?.(rawUrl) : {}),
        }
      : {}),
  };
}

function toolOutput(
  output: unknown,
  resolveInlineData?: CodexTranscriptNormalizerOptions["resolveInlineData"],
): { text: string; mediaBlocks: CodexTranscriptBlock[] } {
  if (typeof output === "string") return { text: output, mediaBlocks: [] };
  if (!Array.isArray(output)) return { text: "", mediaBlocks: [] };
  const texts: string[] = [];
  const mediaBlocks: CodexTranscriptBlock[] = [];
  for (const value of output) {
    if (typeof value === "string") {
      if (value.trim()) texts.push(value);
      continue;
    }
    const item = object(value);
    if (!item) continue;
    const media = contentMedia(item, resolveInlineData);
    if (media) {
      mediaBlocks.push(media);
      continue;
    }
    const text = string(item, "text") ?? string(item, "content");
    const type = string(item, "type");
    if (text && [undefined, "text", "input_text", "output_text", "inputText", "outputText"].includes(type)) {
      texts.push(text);
    }
  }
  return { text: texts.join("\n"), mediaBlocks };
}

function subagentUse(name: string, input: unknown, clip: (value: string) => string): Partial<CodexTranscriptBlock> {
  if (name !== "spawn_agent" && name !== "wait_agent") return {};
  const row = object(input) ?? {};
  const targets = Array.isArray(row.targets) ? row.targets.filter((value): value is string => typeof value === "string") : [];
  return {
    subagentAction: name === "spawn_agent" ? "spawn" : "wait",
    subagentStatus: name === "spawn_agent" ? "running" : "unknown",
    subagentId: string(row, "agent_id") ?? (targets.length === 1 ? targets[0] : undefined),
    subagentType: string(row, "agent_type"),
    subagentModel: string(row, "model"),
    subagentEffort: string(row, "reasoning_effort"),
    subagentMessage: string(row, "message") ? clip(string(row, "message")!) : undefined,
  };
}

function subagentResult(name: string | undefined, output: string, clip: (value: string) => string): Partial<CodexTranscriptBlock> {
  if (name !== "spawn_agent" && name !== "wait_agent") return {};
  let row: Record<string, unknown> | undefined;
  try {
    row = object(JSON.parse(output));
  } catch {
    return {};
  }
  if (!row) return {};
  if (name === "spawn_agent") {
    return {
      subagentAction: "spawn",
      subagentStatus: "running",
      subagentId: string(row, "agent_id"),
      subagentNickname: string(row, "nickname"),
    };
  }
  const entries = Object.entries(object(row.status) ?? {});
  if (entries.length !== 1) return { subagentAction: "wait" };
  const [subagentId, raw] = entries[0]!;
  const state = object(raw) ?? {};
  const completed = string(state, "completed");
  const failed = string(state, "failed") ?? string(state, "error");
  return {
    subagentAction: "wait",
    subagentId,
    subagentStatus: completed ? "completed" : failed ? "failed" : "unknown",
    subagentResult: clip(completed ?? failed ?? output),
  };
}

function subagentNotification(value: string, clip: (value: string) => string): CodexTranscriptBlock | undefined {
  const match = value.trim().match(/^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/);
  if (!match) return undefined;
  let row: Record<string, unknown> | undefined;
  try {
    row = object(JSON.parse(match[1]!));
  } catch {
    // The notification remains visible even when a future payload is not JSON.
  }
  if (!row) {
    return {
      type: "subagent",
      text: clip(value),
      subagentAction: "notification",
      subagentStatus: "unknown",
    };
  }
  const status = object(row.status) ?? {};
  const completed = string(status, "completed");
  const failed = string(status, "failed") ?? string(status, "error");
  const running = string(status, "running");
  const result = completed ?? failed ?? running;
  return {
    type: "subagent",
    text: result ? clip(result) : undefined,
    subagentAction: "notification",
    subagentStatus: completed ? "completed" : failed ? "failed" : running ? "running" : "unknown",
    subagentId: string(row, "agent_path"),
    subagentResult: result ? clip(result) : undefined,
  };
}

function goalBlock(output: string): CodexTranscriptBlock | undefined {
  let row: Record<string, unknown> | undefined;
  try {
    row = object(object(JSON.parse(output))?.goal);
  } catch {
    return undefined;
  }
  if (!row) return undefined;
  const objective = string(row, "objective");
  const status = string(row, "status");
  if (!objective && !status) return undefined;
  return {
    type: "goal",
    goalObjective: objective,
    goalStatus: status,
    goalTokensUsed: number(row.tokensUsed),
    goalTimeUsedSeconds: number(row.timeUsedSeconds),
    goalUpdatedAt: number(row.updatedAt),
    goalThreadId: string(row, "threadId"),
  };
}

function imageId(row: Record<string, unknown>): string | undefined {
  return string(row, "call_id") ?? string(row, "callId") ?? string(row, "id");
}

function generatedImageMedia(
  row: Record<string, unknown>,
  options: CodexTranscriptNormalizerOptions,
): CodexTranscriptBlock | undefined {
  const type = string(row, "type");
  if (!type || !/image.*(?:call|generation|end)/i.test(type)) return undefined;
  const id = imageId(row);
  const path = string(row, "path") ??
    string(row, "file_path") ??
    string(row, "filePath") ??
    string(row, "savedPath") ??
    string(row, "saved_path") ??
    options.generatedImagePath?.(row);
  const mimeType = string(row, "mime_type") ?? string(row, "mimeType") ?? "image/png";
  const base: CodexTranscriptBlock = {
    type: "media",
    mediaKind: "image",
    mimeType,
    title: "Generated image",
    alt: "Generated image",
    toolName: type,
    toolUseId: id,
  };
  if (path) return { ...base, path, title: mediaTitle(path), alt: mediaTitle(path) };
  const raw = (string(row, "result") ?? string(row, "b64_json"))?.replace(/\s+/g, "");
  if (!raw || raw.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return undefined;
  const dataUrl = `data:${mimeType};base64,${raw}`;
  return {
    ...base,
    text: `[${mimeType} data stored in source transcript]`,
    ...options.resolveInlineData?.(dataUrl),
  };
}

function marker(payload: Record<string, unknown>, clip: (value: string) => string): string | undefined {
  if (payload.type === "task_started") return "[Task started]";
  if (payload.type === "task_complete") {
    const message = string(object(payload.error), "message");
    return message ? `[Turn failed: ${clip(message)}]` : "[Task complete]";
  }
  if (payload.type === "context_compacted") return "[Context compacted]";
  if (payload.type === "turn_aborted") {
    const reason = string(payload, "reason");
    return `[Turn aborted${reason ? `: ${reason}` : ""}]`;
  }
  return undefined;
}

export function createCodexTranscriptNormalizer(options: CodexTranscriptNormalizerOptions = {}) {
  const clip = clipTranscriptText;
  const clipInput = clipTranscriptValue;
  const toolNames = new Map<string, string>();
  const normalizeContext = createCodexContextUpdateNormalizer();
  let previousTotalUsage: CodexTranscriptTokenUsage | undefined;
  let latestContextTokens: number | undefined;
  let pendingCompaction: CodexTranscriptBlock | undefined;
  let model: string | undefined;
  let approvalPolicy: string | undefined;
  let sandboxPolicy: string | undefined;
  const pendingWebSearchIds: string[] = [];

  const message = (
    role: CodexTranscriptRole,
    blocks: CodexTranscriptBlock[],
    timestamp?: string,
    usage?: CodexTranscriptTokenUsage,
  ): CodexTranscriptMessage => ({
    role,
    blocks,
    timestamp,
    ...(usage ? { tokenUsage: usage, tokensUsed: usage.output, model } : {}),
  });
  const rememberTool = (id: unknown, name?: string) => {
    if (typeof id === "string" && id && name) toolNames.set(id, name);
  };
  const resultTool = (id: unknown) => typeof id === "string" ? toolNames.get(id) : undefined;
  const compacted = (timestamp?: string): CodexTranscriptRecordResult => {
    const block: CodexTranscriptBlock = {
      type: "marker",
      text: "[Context compacted]",
      ...(latestContextTokens !== undefined
        ? { compaction: { beforeTokens: latestContextTokens } }
        : {}),
    };
    pendingCompaction = block;
    return {
      recognized: true,
      messages: [message("system", [block], timestamp)],
    };
  };

  return {
    ingestTruncatedPrefix(prefix: string): CodexTranscriptRecordResult {
      const isCompaction = /"type"\s*:\s*"compacted"/.test(prefix) ||
        /"type"\s*:\s*"compact_context"/.test(prefix);
      const timestampMatch = /"timestamp"\s*:\s*("(?:\\.|[^"\\])*")/.exec(prefix);
      let timestamp: string | undefined;
      if (timestampMatch?.[1]) {
        try {
          timestamp = JSON.parse(timestampMatch[1]);
        } catch {
          // The retained prefix may end inside the timestamp string.
        }
      }
      return isCompaction
        ? compacted(timestamp)
        : { recognized: false, messages: [] };
    },
    ingest(value: unknown): CodexTranscriptRecordResult {
      const row = object(value);
      if (!row) return { recognized: false, messages: [] };
      const rowType = string(row, "type");
      const payload = object(row.payload);
      const payloadType = string(payload, "type");
      const timestamp = string(row, "timestamp") ?? string(payload, "timestamp");
      if (rowType === "session_meta" && payload) {
        normalizeContext.primeBaseInstructions(payload.base_instructions);
        return {
          recognized: true, messages: [], metadata: { cwd: string(payload, "cwd"), sessionId: string(payload, "id"), timestamp },
        };
      }
      if (rowType === "turn_context" && payload) {
        model = string(payload, "model") ?? model;
        approvalPolicy = string(payload, "approval_policy") ?? approvalPolicy;
        const sandbox = payload.sandbox_policy;
        sandboxPolicy = (typeof sandbox === "string" ? sandbox : string(object(sandbox), "type")) ?? sandboxPolicy;
        return { recognized: true, messages: [] };
      }
      if (rowType === "compacted" || payloadType === "compact_context") {
        return compacted(timestamp);
      }
      if (rowType === "event_msg" && payload) {
        if (payloadType === "item_completed") {
          const activity = codexSubagentActivityFields(payload.item);
          if (activity) return { recognized: true, messages: [message("assistant", [{ type: "subagent", ...activity }], timestamp)] };
        }
        if (payloadType === "thread_settings_applied") {
          const settings = object(payload.thread_settings);
          model = string(settings, "model") ?? model;
          approvalPolicy = string(settings, "approval_policy") ?? approvalPolicy;
          const sandbox = settings?.sandbox_policy;
          sandboxPolicy = (typeof sandbox === "string" ? sandbox : string(object(sandbox), "type")) ?? sandboxPolicy;
          return { recognized: true, messages: [] };
        }
        const info = object(payload.info) ?? payload;
        const lastRecord = object(info.last_token_usage) ?? object(payload.lastTokenUsage) ?? object(payload.usage);
        const lastUsage = usageFrom(lastRecord);
        const totalUsage = usageFrom(object(info.total_token_usage) ?? object(payload.totalTokenUsage));
        if (lastRecord) {
          const snapshot = contextTokenSnapshotFromUsageRecord(lastRecord);
          if (snapshot) {
            if (pendingCompaction?.compaction && snapshot.attributedTokens === 0) {
              pendingCompaction.compaction.afterTokens = snapshot.totalTokens;
              pendingCompaction = undefined;
            }
            latestContextTokens = snapshot.totalTokens;
          }
        }
        const usage = lastUsage ?? (totalUsage ? usageDelta(totalUsage, previousTotalUsage) : undefined);
        if (totalUsage) previousTotalUsage = totalUsage;
        if (usage && (usage.total || usage.input || usage.output || usage.reasoningOutput)) {
          return {
            recognized: true,
            messages: [message("assistant", [], timestamp, usage)],
          };
        }
        const markerText = marker(payload, clip);
        if (markerText) {
          const block: CodexTranscriptBlock = {
            type: "marker",
            text: markerText,
            ...(markerText === "[Context compacted]" && latestContextTokens !== undefined
              ? { compaction: { beforeTokens: latestContextTokens } }
              : {}),
          };
          if (block.compaction) pendingCompaction = block;
          return { recognized: true, messages: [message("system", [block], timestamp)] };
        }
        if (payloadType === "patch_apply_end") {
          const id = string(payload, "call_id");
          const messages: CodexTranscriptMessage[] = [];
          if (object(payload.changes)) {
            messages.push(message("assistant", [{
              type: "tool_use",
              toolName: "file change",
              toolInput: { changes: payload.changes },
              toolUseId: id,
            }], timestamp));
          }
          messages.push(message("tool", [{
            type: "tool_result",
            text: clip(codexPatchApplyResultText(payload)),
            toolName: resultTool(id) ?? "apply_patch",
            toolUseId: id,
          }], timestamp));
          return { recognized: true, messages };
        }
        if (payloadType === "web_search_end") {
          const id = string(payload, "call_id");
          const messages: CodexTranscriptMessage[] = [];
          if (id?.startsWith("exec-")) {
            rememberTool(id, "web_search");
            messages.push(message("assistant", [{
              type: "tool_use",
              toolName: "web_search",
              toolInput: clipInput({ action: payload.action, query: payload.query }),
              toolUseId: id,
            }], timestamp));
          } else if (id) {
            pendingWebSearchIds.push(id);
          }
          const searchText = [
            string(payload, "query"),
            object(payload.action) ? JSON.stringify(payload.action) : "",
          ].filter(Boolean).join("\n") || "Web search completed";
          messages.push(message("tool", [{
            type: "tool_result",
            text: clip(searchText),
            toolName: resultTool(id) ?? "web_search",
            toolUseId: id,
          }], timestamp));
          return { recognized: true, messages };
        }
        if (payloadType === "image_generation_end") {
          const id = imageId(payload);
          const name = resultTool(id) ?? "image_generation_call";
          const media = generatedImageMedia(payload, options);
          return { recognized: true, messages: [
            message("tool", [{ type: "tool_result", text: "Generated image", toolName: name, toolUseId: id }], timestamp),
            ...(media ? [message("assistant", [{ ...media, toolName: name, toolUseId: id }], timestamp)] : []),
          ] };
        }
        return { recognized: true, messages: [] };
      }
      if (rowType !== "response_item" || !payload) return { recognized: false, messages: [] };
      if (payloadType === "message") {
        const contextUpdate = normalizeContext(payload);
        if (contextUpdate) return { recognized: true, messages: [{ role: contextUpdate.role, blocks: contextUpdate.blocks, timestamp }] };
        const rawRole = string(payload, "role");
        const role: CodexTranscriptRole | undefined = rawRole === "assistant"
          ? "assistant"
          : rawRole === "user"
            ? "user"
            : rawRole === "system" || rawRole === "developer"
              ? "system"
              : undefined;
        if (!role) return { recognized: true, messages: [] };
        const blocks: CodexTranscriptBlock[] = [];
        const mentioned: { title: string; path: string }[] = [];
        let pendingImagePath: string | undefined;
        const contents = Array.isArray(payload.content) ? payload.content : [payload.content];
        for (const raw of contents) {
          if (typeof raw === "string") {
            const text = role === "user" ? visibleUserText(raw) : raw;
            if (text) blocks.push(...protocolTextBlocks(text, clip));
            continue;
          }
          const part = object(raw);
          if (!part) continue;
          const text = string(part, "text") ?? string(part, "input_text") ?? string(part, "output_text");
          if (text) {
            if (role === "user") {
              const envelope = text.match(/^\s*# Files mentioned by the user:\s*\n([\s\S]*?)\n## My request(?: for Codex)?:\s*\n?([\s\S]*)$/i);
              if (envelope) {
                for (const line of envelope[1]!.split("\n")) {
                  const file = line.match(/^##\s+(.+?):\s+(\/.*)$/);
                  if (file) {
                    mentioned.push({
                      title: file[1]!.trim(),
                      path: file[2]!.trim(),
                    });
                  }
                }
                const visible = visibleUserText(envelope[2]!);
                if (visible) blocks.push(...protocolTextBlocks(visible, clip));
                continue;
              }
              const wrapper = parseCodexImageWrapper(text);
              if (wrapper) {
                pendingImagePath = wrapper.path;
                continue;
              }
              if (text.trim() === "</image>") {
                pendingImagePath = undefined;
                continue;
              }
            }
            const notification = subagentNotification(text, clip);
            if (notification) blocks.push(notification);
            else {
              const visible = role === "user" ? visibleUserText(text) : text;
              if (visible) blocks.push(...protocolTextBlocks(visible, clip));
            }
          } else {
            const media = contentMedia(part, options.resolveInlineData);
            if (media) {
              if (pendingImagePath) {
                media.path = pendingImagePath;
                media.title = mediaTitle(pendingImagePath);
                media.alt = media.title;
                pendingImagePath = undefined;
              }
              blocks.push(media);
            }
          }
        }
        for (const file of mentioned) {
          if (blocks.some((block) => block.type === "media" && block.path === file.path)) continue;
          blocks.push({
            type: "media",
            mediaKind: mediaKind(undefined, undefined, file.path),
            path: file.path,
            title: file.title,
            alt: file.title,
          });
        }
        if (!blocks.length) return { recognized: true, messages: [] };
        const effectiveRole = role === "user" && blocks.every((block) => block.type === "subagent") ? "assistant" : role;
        return { recognized: true, messages: [message(effectiveRole, blocks, timestamp)] };
      }
      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const id = string(payload, "call_id") ?? string(payload, "id");
        const rawName = canonicalCodexToolName(string(payload, "name") ?? (payloadType === "custom_tool_call" ? "custom_tool" : "function_call"));
        let input: unknown = payloadType === "function_call" ? payload.arguments : payload.input;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch {} }
        const invocations = rawName === "exec_command" && typeof input === "string" ? parseCodexToolScriptInvocations(input) : [];
        const primary = invocations[0];
        const name = primary?.toolName ?? rawName;
        const fullInput = primary?.toolInput ?? input;
        input = clipInput(fullInput);
        rememberTool(id, name);
        if (name === "request_user_input_async") {
          const blocks = asyncQuestionBlocksFromPayload(fullInput, id);
          return {
            recognized: true,
            messages: blocks.length ? [message("assistant", blocks, timestamp)] : [],
          };
        }
        if (["get_goal", "create_goal", "update_goal"].includes(name)) return { recognized: true, messages: [] };
        const plan = name === "update_plan" ? object(input) : undefined;
        if (plan && Array.isArray(plan.plan)) {
          const planItems = plan.plan.flatMap((item) => {
            const row = object(item);
            const step = string(row, "step");
            return step
              ? [{ step: clip(step), status: string(row, "status") ?? "pending" }]
              : [];
          });
          if (planItems.length) {
            return {
              recognized: true,
              messages: [message("assistant", [{
                type: "plan",
                explanation: string(plan, "explanation"),
                planItems,
                toolName: name,
                toolInput: input,
                toolUseId: id,
              }], timestamp)],
            };
          }
        }
        const clippedInvocations = invocations.map((invocation) => ({ ...invocation, toolInput: clipInput(invocation.toolInput) }));
        const editSummary = visualFileEditSummaryForBlock({ type: "tool_use", toolName: name, toolInput: fullInput });
        const inputWasClipped = containsClippedString(fullInput, input);
        const block: CodexTranscriptBlock = {
          type: "tool_use", toolName: name, toolInput: input,
          ...(clippedInvocations.length > 1 ? { toolInvocations: clippedInvocations } : {}),
          ...(editSummary?.files.length
            ? {
                observedFileEdits: editSummary.files.map((file) => ({
                  ...file,
                  raw: inputWasClipped ? undefined : file.raw,
                })),
              }
            : {}),
          toolUseId: id,
          ...subagentUse(name, input, clip),
          ...(["exec_command", "apply_patch"].includes(name) && approvalPolicy ? { approvalPolicy } : {}),
          ...(["exec_command", "apply_patch"].includes(name) && sandboxPolicy ? { sandboxPolicy } : {}),
        };
        const blocks = [block];
        if (name === "view_image") {
          const path = string(object(input), "path");
          if (path) {
            blocks.push({
              type: "media",
              mediaKind: "image",
              path,
              title: mediaTitle(path),
              alt: mediaTitle(path),
            });
          }
        }
        return { recognized: true, messages: [message("assistant", blocks, timestamp)] };
      }
      if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const id = string(payload, "call_id") ?? string(payload, "id");
        const name = resultTool(id) ?? string(payload, "name");
        if (name === "request_user_input_async") {
          return { recognized: true, messages: [] };
        }
        const output = toolOutput(payload.output, options.resolveInlineData);
        if (["get_goal", "create_goal", "update_goal"].includes(name ?? "")) {
          const goal = goalBlock(output.text);
          return { recognized: true, messages: goal ? [message("system", [goal], timestamp)] : [] };
        }
        const blocks: CodexTranscriptBlock[] = [{
          type: "tool_result",
          text: clip(output.text),
          toolName: name,
          toolUseId: id,
          ...subagentResult(name, output.text, clip),
        }, ...output.mediaBlocks.map((block) => ({
          ...block,
          toolName: name,
          toolUseId: id,
        }))];
        return {
          recognized: true,
          messages: [message("tool", blocks, timestamp)],
        };
      }
      if (payloadType === "web_search_call") {
        const explicit = string(payload, "call_id");
        const id = explicit ?? pendingWebSearchIds.shift();
        rememberTool(id, "web_search");
        return {
          recognized: true,
          messages: [message("assistant", [{
            type: "tool_use",
            toolName: "web_search",
            toolInput: clipInput({ status: payload.status, action: payload.action }),
            toolUseId: id,
          }], timestamp)],
        };
      }
      if (payloadType === "reasoning") return { recognized: true, messages: [] };
      if (payloadType && /image.*(?:call|generation)/i.test(payloadType)) {
        const id = imageId(payload); rememberTool(id, payloadType);
        const toolInput = clipInput(Object.fromEntries(
          Object.entries(payload)
            .filter(([key]) => !["result", "b64_json", "output"].includes(key)),
        ));
        const media = generatedImageMedia(payload, options);
        return { recognized: true, messages: [
          message("assistant", [{ type: "tool_use", toolName: payloadType, toolInput, toolUseId: id }], timestamp),
          ...(media
            ? [
                message("tool", [{
                  type: "tool_result",
                  text: "Generated image",
                  toolName: payloadType,
                  toolUseId: id,
                }], timestamp),
                message("assistant", [{
                  ...media,
                  toolName: payloadType,
                  toolUseId: id,
                }], timestamp),
              ]
            : []),
        ] };
      }
      const media = contentMedia(payload, options.resolveInlineData);
      if (media) return { recognized: true, messages: [message("assistant", [media], timestamp)] };
      return { recognized: true, messages: [] };
    },
  };
}
