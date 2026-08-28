import {
  codexLiveMessagesFromEvent,
  type CodexAppEvent,
  type CodexAppHistoryBlock,
  type CodexAppHistoryMessage,
  type CodexLiveNormalizeContext,
} from "./codex-event-stream";
import {
  buildVisualTranscriptItems,
  updateVisualTranscriptItems,
  visualTranscriptMessageWindow,
  type VisualTranscriptItem,
} from "./last-user-message";

export interface ReplayFrame {
  seq?: number;
  at?: string;
  direction?: "client" | "server" | string;
  raw?: string;
  message?: Record<string, unknown>;
}

export type ReplayStep =
  | {
      kind: "message";
      seq: number;
      at?: string;
      label: string;
      message: CodexAppHistoryMessage & { intent?: "steer" };
    }
  | {
      kind: "event";
      seq: number;
      at?: string;
      label: string;
      event: CodexAppEvent;
    };

export interface ParsedCodexReplay {
  mode: "rpc" | "transcript";
  id?: string;
  startedAt?: string;
  steps: ReplayStep[];
  warnings: string[];
}

export type CodexReplayMessage = CodexAppHistoryMessage & { intent?: "steer" };

export interface CodexReplayPlaybackState {
  replay: ParsedCodexReplay;
  stepIndex: number;
  messages: CodexReplayMessage[];
  items: VisualTranscriptItem<CodexAppHistoryBlock, CodexAppHistoryMessage>[];
  renderedMessageCount: number;
  totalMessageCount: number;
  visibleMessageLimit: number;
  context: CodexLiveNormalizeContext;
}

export interface CodexReplayParseProgress {
  label: string;
  parsed: number;
  total?: number;
}

export interface CodexReplayParseOptions {
  chunkSize?: number;
  onProgress?: (progress: CodexReplayParseProgress) => void;
}

export const DEFAULT_REPLAY_VISIBLE_MESSAGE_LIMIT = 260;

export function parseCodexReplayText(text: string): ParsedCodexReplay {
  const warnings: string[] = [];
  const root = parseReplayRoot(text, warnings);
  return parseCodexReplayRoot(root, warnings);
}

export async function parseCodexReplayTextAsync(
  text: string,
  options: CodexReplayParseOptions = {},
): Promise<ParsedCodexReplay> {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return parseCodexReplayRoot([], warnings);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      options.onProgress?.({ label: "Parsing JSON", parsed: 0 });
      await nextParseFrame();
      const root = JSON.parse(trimmed);
      options.onProgress?.({ label: "Building replay", parsed: 1, total: 1 });
      await nextParseFrame();
      return parseCodexReplayRoot(root, warnings);
    } catch {
      // Codex JSONL also starts each line with `{`; fall through to line parsing.
    }
  }

  const lines = trimmed.split(/\r?\n/);
  const records: unknown[] = [];
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 1000));
  for (const [idx, line] of lines.entries()) {
    const clean = line.trim();
    if (clean) {
      try {
        records.push(JSON.parse(clean));
      } catch {
        warnings.push(`Skipped line ${idx + 1}: not JSON`);
      }
    }
    if ((idx + 1) % chunkSize === 0 || idx === lines.length - 1) {
      options.onProgress?.({
        label: `Parsing line ${idx + 1} / ${lines.length}`,
        parsed: idx + 1,
        total: lines.length,
      });
      await nextParseFrame();
    }
  }
  options.onProgress?.({
    label: "Building transcript",
    parsed: lines.length,
    total: lines.length,
  });
  await nextParseFrame();
  return parseCodexReplayRoot(records, warnings);
}

function parseCodexReplayRoot(
  root: unknown,
  warnings: string[],
): ParsedCodexReplay {
  const records = replayRecords(root);
  const transcript = codexTranscriptFromRecords(records, warnings);
  if (transcript) return transcript;
  const steps: ReplayStep[] = [];
  let seq = 0;
  for (const record of records) {
    for (const step of replayStepsFromRecord(record, ++seq, warnings)) {
      steps.push(step);
    }
  }
  const rootRecord = objectRecord(root);
  return {
    mode: "rpc",
    id: objectString(rootRecord, "id"),
    startedAt: objectString(rootRecord, "startedAt"),
    steps,
    warnings,
  };
}

function nextParseFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function codexReplayMessagesUntil(
  replay: ParsedCodexReplay,
  stepCount: number,
): CodexReplayMessage[] {
  const messages: CodexReplayMessage[] = [];
  const context: CodexLiveNormalizeContext = {};
  for (const step of replay.steps.slice(0, Math.max(0, stepCount))) {
    appendReplayStepMessages(messages, step, context);
  }
  return messages;
}

export function codexReplayItemsUntil(
  replay: ParsedCodexReplay,
  stepCount: number,
): VisualTranscriptItem<CodexAppHistoryBlock, CodexAppHistoryMessage>[] {
  const active = replay.mode === "rpc" && stepCount < replay.steps.length;
  const window = visualTranscriptMessageWindow(
    codexReplayMessagesUntil(replay, stepCount),
    {
      minMessages: DEFAULT_REPLAY_VISIBLE_MESSAGE_LIMIT,
      minUserTurns: 2,
    },
  );
  return buildVisualTranscriptItems(window.messages, {
    active,
    messageIndexOffset: window.messageIndexOffset,
  });
}

export function createCodexReplayPlayback(
  replay: ParsedCodexReplay,
  options: { stepIndex?: number; visibleMessageLimit?: number } = {},
): CodexReplayPlaybackState {
  const visibleMessageLimit =
    options.visibleMessageLimit ?? DEFAULT_REPLAY_VISIBLE_MESSAGE_LIMIT;
  return setCodexReplayPlaybackStep(
    {
      replay,
      stepIndex: 0,
      messages: [],
      items: [],
      renderedMessageCount: 0,
      totalMessageCount: 0,
      visibleMessageLimit,
      context: {},
    },
    options.stepIndex ?? 0,
  );
}

export function setCodexReplayPlaybackStep(
  state: CodexReplayPlaybackState,
  stepIndex: number,
): CodexReplayPlaybackState {
  const target = clampReplayStep(state.replay, stepIndex);
  if (target < state.stepIndex) {
    const fresh: CodexReplayPlaybackState = {
      replay: state.replay,
      stepIndex: 0,
      messages: [],
      items: [],
      renderedMessageCount: 0,
      totalMessageCount: 0,
      visibleMessageLimit: state.visibleMessageLimit,
      context: {},
    };
    return setCodexReplayPlaybackStep(fresh, target);
  }

  const messages = state.messages.slice();
  const context = state.context;
  const previousWindow = replayMessageWindow(
    state.messages,
    state.visibleMessageLimit,
  );
  const previousActive =
    state.replay.mode === "rpc" && state.stepIndex < state.replay.steps.length;
  for (let index = state.stepIndex; index < target; index += 1) {
    const step = state.replay.steps[index];
    if (step) appendReplayStepMessages(messages, step, context);
  }
  const nextWindow = replayMessageWindow(messages, state.visibleMessageLimit);
  const active =
    state.replay.mode === "rpc" && target < state.replay.steps.length;
  const appendHint =
    previousWindow.messageIndexOffset === nextWindow.messageIndexOffset
      ? previousWindow.messages.length
      : undefined;
  return {
    ...state,
    stepIndex: target,
    messages,
    items: updateVisualTranscriptItems({
      previousMessages: previousWindow.messages,
      previousItems: state.items,
      previousActive,
      messages: nextWindow.messages,
      active,
      changeStartHint: appendHint,
      messageIndexOffset: nextWindow.messageIndexOffset,
    }),
    renderedMessageCount: nextWindow.messages.length,
    totalMessageCount: messages.length,
    context,
  };
}

function clampReplayStep(replay: ParsedCodexReplay, stepIndex: number): number {
  return Math.max(0, Math.min(replay.steps.length, Math.trunc(stepIndex) || 0));
}

function appendReplayStepMessages(
  messages: CodexReplayMessage[],
  step: ReplayStep,
  context: CodexLiveNormalizeContext,
): void {
  const nextMessages =
    step.kind === "message"
      ? [step.message]
      : codexLiveMessagesFromEvent(step.event, context);
  for (const message of nextMessages) {
    if (isVisibleReplayMessage(message)) messages.push(message);
  }
}

function isVisibleReplayMessage(message: CodexReplayMessage): boolean {
  return (
    message.blocks.length > 0 ||
    !!message.tokenUsage ||
    (typeof message.tokensUsed === "number" && message.tokensUsed > 0)
  );
}

function replayMessageWindow(messages: CodexReplayMessage[], limit: number) {
  const cappedLimit = Math.max(1, Math.trunc(limit) || 1);
  return visualTranscriptMessageWindow(messages, {
    minMessages: cappedLimit,
    minUserTurns: 2,
  });
}

function codexTranscriptFromRecords(
  records: unknown[],
  warnings: string[],
): ParsedCodexReplay | null {
  if (!records.some(isCodexTranscriptRecord)) return null;
  const steps: ReplayStep[] = [];
  const toolNames = new Map<string, string>();
  const usageContext: CodexReplayUsageContext = {};
  let id: string | undefined;
  let startedAt: string | undefined;
  for (const [index, record] of records.entries()) {
    const row = objectRecord(record);
    const payload = objectRecord(row?.payload);
    const type = objectString(row, "type");
    if (type === "session_meta") {
      id ??= objectString(payload, "id");
      startedAt ??=
        objectString(payload, "timestamp") ?? objectString(row, "timestamp");
      continue;
    }
    const step = codexTranscriptStepFromRow(
      row,
      payload,
      index + 1,
      toolNames,
      usageContext,
      warnings,
    );
    if (step) steps.push(step);
  }
  return { mode: "transcript", id, startedAt, steps, warnings };
}

function codexTranscriptStepFromRow(
  row: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined,
  seq: number,
  toolNames: Map<string, string>,
  usageContext: CodexReplayUsageContext,
  warnings: string[],
): ReplayStep | undefined {
  if (!row || !payload) return undefined;
  const rowType = objectString(row, "type");
  const payloadType = objectString(payload, "type");
  const timestamp =
    objectString(row, "timestamp") ?? objectString(payload, "timestamp");

  if (rowType === "compacted" || payloadType === "compact_context") {
    return transcriptMessageStep(seq, timestamp, "Context compacted", {
      id: `codex-transcript-marker-${seq}`,
      role: "system",
      timestamp,
      blocks: [{ type: "marker", text: "Context compacted" }],
    });
  }

  if (rowType === "event_msg") {
    const tokenUsage = codexReplayTokenUsageFromPayload(payload, usageContext);
    if (tokenUsage) {
      return transcriptMessageStep(seq, timestamp, "Token usage", {
        id: `codex-transcript-token-usage-${seq}`,
        role: "assistant",
        timestamp,
        tokensUsed: tokenUsage.output + tokenUsage.reasoningOutput,
        tokenUsage,
        blocks: [],
      });
    }
    const marker = codexTranscriptEventMarker(payload);
    if (marker) {
      return transcriptMessageStep(seq, timestamp, marker, {
        id: `codex-transcript-marker-${seq}`,
        role: "system",
        timestamp,
        blocks: [{ type: "marker", text: marker }],
      });
    }
    return undefined;
  }

  if (rowType !== "response_item") return undefined;
  if (payloadType === "message") {
    const rawRole = objectString(payload, "role");
    const role = transcriptRole(rawRole);
    let blocks = transcriptContentBlocks(payload.content);
    if (!role) {
      return transcriptContextStep(seq, timestamp, rawRole, blocks);
    }
    if (role === "user") {
      const originalBlocks = blocks;
      blocks = transcriptVisibleUserBlocks(blocks);
      if (!blocks.length) {
        return transcriptContextStep(seq, timestamp, "user", originalBlocks);
      }
    }
    if (!blocks.length) return undefined;
    return transcriptMessageStep(
      seq,
      timestamp,
      `${capitalize(role)} message`,
      {
        id: `codex-transcript-message-${seq}`,
        role,
        timestamp,
        blocks,
      },
    );
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const toolUseId =
      objectString(payload, "call_id") ??
      objectString(payload, "id") ??
      `tool-${seq}`;
    const toolName =
      objectString(payload, "name") ??
      objectString(payload, "tool_name") ??
      payloadType;
    const invocation = transcriptToolInvocation(
      toolName,
      payload,
      warnings,
      seq,
    );
    toolNames.set(toolUseId, invocation.toolName);
    return transcriptMessageStep(seq, timestamp, invocation.toolName, {
      id: `codex-transcript-tool-${seq}`,
      role: "assistant",
      timestamp,
      blocks: [
        {
          type: "tool_use",
          toolName: invocation.toolName,
          toolUseId,
          toolInput: invocation.toolInput,
        },
      ],
    });
  }

  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output"
  ) {
    const toolUseId =
      objectString(payload, "call_id") ??
      objectString(payload, "id") ??
      `tool-${seq}`;
    const toolName = toolNames.get(toolUseId) ?? objectString(payload, "name");
    const result = transcriptToolOutputBlocks(payload);
    return transcriptMessageStep(
      seq,
      timestamp,
      `${toolName ?? "Tool"} result`,
      {
        id: `codex-transcript-result-${seq}`,
        role: "tool",
        timestamp,
        blocks: [
          {
            type: "tool_result",
            toolName,
            toolUseId,
            text: result.text,
          },
          ...result.mediaBlocks,
        ],
      },
    );
  }

  if (payloadType === "reasoning") {
    const text = transcriptReasoningText(payload);
    if (!text) return undefined;
    return transcriptMessageStep(seq, timestamp, "Thinking", {
      id: `codex-transcript-thinking-${seq}`,
      role: "assistant",
      timestamp,
      blocks: [{ type: "thinking", text }],
    });
  }

  return undefined;
}

function transcriptContextStep(
  seq: number,
  timestamp: string | undefined,
  role: string | undefined,
  blocks: CodexAppHistoryBlock[],
): ReplayStep | undefined {
  const text = blocks
    .map((block) => (block.type === "text" ? block.text?.trim() : undefined))
    .filter((part): part is string => !!part)
    .join("\n\n")
    .trim();
  if (!text) return undefined;
  const label = transcriptContextLabel(role);
  return transcriptMessageStep(seq, timestamp, label, {
    id: `codex-transcript-context-${seq}`,
    role: "system",
    timestamp,
    blocks: [
      {
        type: "system_reminder",
        tagName: label,
        text,
      },
    ],
  });
}

function transcriptContextLabel(role: string | undefined): string {
  if (role === "developer") return "Developer context";
  if (role === "system") return "System context";
  if (role === "user") return "Injected user context";
  return role ? `${capitalize(role)} context` : "Injected context";
}

function transcriptToolInvocation(
  toolName: string,
  payload: Record<string, unknown>,
  warnings: string[],
  seq: number,
): { toolName: string; toolInput: unknown } {
  const canonicalToolName = canonicalReplayToolName(toolName);
  const input = transcriptToolInput(payload, warnings, seq);
  if (canonicalToolName !== "exec_command" || typeof input !== "string") {
    return { toolName: canonicalToolName, toolInput: input };
  }
  const wrapped = parseCodexToolScriptInvocation(input);
  return wrapped ?? { toolName: canonicalToolName, toolInput: input };
}

function transcriptMessageStep(
  seq: number,
  at: string | undefined,
  label: string,
  message: CodexAppHistoryMessage,
): ReplayStep {
  return { kind: "message", seq, at, label, message };
}

function transcriptToolInput(
  payload: Record<string, unknown>,
  _warnings: string[],
  _seq: number,
): unknown {
  const raw =
    objectString(payload, "arguments") ??
    objectString(payload, "input") ??
    objectString(payload, "content");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function transcriptToolOutputBlocks(payload: Record<string, unknown>): {
  text: string;
  mediaBlocks: CodexAppHistoryBlock[];
} {
  for (const key of ["output", "content", "text", "result"]) {
    const value = payload[key];
    if (typeof value === "string") return { text: value, mediaBlocks: [] };
    if (Array.isArray(value)) return transcriptOutputArrayBlocks(value);
  }
  return { text: JSON.stringify(payload), mediaBlocks: [] };
}

function transcriptOutputArrayBlocks(items: unknown[]): {
  text: string;
  mediaBlocks: CodexAppHistoryBlock[];
} {
  const textParts: string[] = [];
  const mediaBlocks: CodexAppHistoryBlock[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim()) textParts.push(item);
      continue;
    }
    const record = objectRecord(item);
    if (!record) continue;
    const media = transcriptMediaBlock(record);
    if (media) {
      mediaBlocks.push(media);
      continue;
    }
    const text =
      objectString(record, "text") ?? objectString(record, "content");
    if (text) textParts.push(text);
  }
  return { text: textParts.join("\n"), mediaBlocks };
}

function transcriptContentBlocks(content: unknown): CodexAppHistoryBlock[] {
  const items = Array.isArray(content) ? content : [content];
  const blocks: CodexAppHistoryBlock[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim()) {
      blocks.push({ type: "text", text: item });
      continue;
    }
    const record = objectRecord(item);
    if (!record) continue;
    const type = objectString(record, "type");
    const text =
      objectString(record, "text") ??
      objectString(record, "input_text") ??
      objectString(record, "output_text");
    if (text) {
      blocks.push(
        type === "reasoning_text"
          ? { type: "thinking", text }
          : { type: "text", text },
      );
    }
    const media = transcriptMediaBlock(record);
    if (media) blocks.push(media);
  }
  return blocks;
}

function transcriptMediaBlock(
  record: Record<string, unknown>,
): CodexAppHistoryBlock | undefined {
  const path =
    objectString(record, "path") ??
    objectString(record, "filePath") ??
    objectString(record, "imagePath");
  const imageUrlValue = record.image_url ?? record.imageUrl;
  const imageUrl =
    typeof imageUrlValue === "string"
      ? imageUrlValue
      : objectString(objectRecord(imageUrlValue), "url");
  const url = objectString(record, "url") ?? imageUrl;
  if (!path && !url) return undefined;
  return {
    type: "media",
    mediaKind: "image",
    path,
    url,
    title: objectString(record, "name") ?? objectString(record, "title"),
    mimeType:
      objectString(record, "mimeType") ?? objectString(record, "mime_type"),
  };
}

function transcriptVisibleUserBlocks(
  blocks: CodexAppHistoryBlock[],
): CodexAppHistoryBlock[] {
  const visible: CodexAppHistoryBlock[] = [];
  for (const block of blocks) {
    if (block.type !== "text" || !block.text) {
      visible.push(block);
      continue;
    }
    const text = codexVisibleUserText(block.text);
    if (text) visible.push({ ...block, text });
  }
  return visible;
}

function transcriptReasoningText(
  payload: Record<string, unknown>,
): string | undefined {
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    const parts = summary
      .map((item) => objectString(objectRecord(item), "text"))
      .filter((text): text is string => !!text);
    if (parts.length) return parts.join("\n\n");
  }
  return objectString(payload, "text");
}

function transcriptRole(
  role: string | undefined,
): CodexAppHistoryMessage["role"] | undefined {
  if (role === "user" || role === "assistant" || role === "tool") {
    return role;
  }
  return undefined;
}

function codexVisibleUserText(text: string): string {
  let visible = text;
  visible = visible.replace(
    /<goal_context\b[^>]*>[\s\S]*?<\/goal_context>/g,
    "",
  );
  visible = visible.replace(
    /<environment_context>[\s\S]*?<\/environment_context>/g,
    "",
  );
  visible = visible.replace(/<filesystem>[\s\S]*?<\/filesystem>/g, "");
  visible = visible.replace(
    /<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>/g,
    "",
  );
  const trimmed = visible.trim();
  if (/^#\s+(AGENTS|CLAUDE)\.md instructions\b/i.test(trimmed)) return "";
  if (/^#\s+(Instructions|Context|System)\b/i.test(trimmed)) return "";
  if (/^<skills_instructions>/i.test(trimmed)) return "";
  if (/^<permissions instructions>/i.test(trimmed)) return "";
  return trimmed;
}

function codexTranscriptEventMarker(
  payload: Record<string, unknown>,
): string | undefined {
  switch (payload.type) {
    case "task_started":
      return "[Task started]";
    case "task_complete":
      return "[Task complete]";
    case "context_compacted":
      return "[Context compacted]";
    case "turn_aborted": {
      const reason = objectString(payload, "reason");
      return reason ? `[Turn aborted: ${reason}]` : "[Turn aborted]";
    }
    default:
      return undefined;
  }
}

interface CodexReplayUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

interface CodexReplayUsageContext {
  previousTotalTokenUsage?: CodexReplayUsage;
}

function codexReplayTokenUsageFromPayload(
  payload: Record<string, unknown>,
  context: CodexReplayUsageContext,
): CodexReplayUsage | undefined {
  const info = objectRecord(payload.info) ?? payload;
  const lastUsage = codexReplayTokenUsageFromObject(
    objectRecord(info.last_token_usage) ??
      objectRecord(payload.lastTokenUsage) ??
      objectRecord(payload.usage),
  );
  const totalUsage = codexReplayTokenUsageFromObject(
    objectRecord(info.total_token_usage) ??
      objectRecord(payload.totalTokenUsage),
  );
  if (lastUsage) {
    if (totalUsage) context.previousTotalTokenUsage = totalUsage;
    return lastUsage;
  }
  if (!totalUsage) return undefined;
  const delta = codexReplayTokenUsageDelta(
    totalUsage,
    context.previousTotalTokenUsage,
  );
  context.previousTotalTokenUsage = totalUsage;
  return codexReplayTokenUsageHasContent(delta) ? delta : undefined;
}

function codexReplayTokenUsageFromObject(
  usage: Record<string, unknown> | undefined,
): CodexReplayUsage | undefined {
  if (!usage) return undefined;
  const input = finiteCodexNumber(usage.input_tokens ?? usage.inputTokens) ?? 0;
  const cachedInput =
    finiteCodexNumber(usage.cached_input_tokens ?? usage.cachedInputTokens) ??
    0;
  const cacheWriteInput =
    finiteCodexNumber(
      usage.cache_write_input_tokens ??
        usage.cacheWriteInputTokens ??
        usage.cache_creation_input_tokens ??
        usage.cacheCreationInputTokens,
    ) ?? 0;
  const output =
    finiteCodexNumber(usage.output_tokens ?? usage.outputTokens) ?? 0;
  const reasoning =
    finiteCodexNumber(
      usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
    ) ?? 0;
  const total =
    finiteCodexNumber(usage.total_tokens ?? usage.totalTokens) ??
    input + output;
  if (total <= 0 && output + reasoning <= 0) return undefined;
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    reasoningOutput: reasoning,
    total,
  };
}

function codexReplayTokenUsageDelta(
  current: CodexReplayUsage,
  previous: CodexReplayUsage | undefined,
): CodexReplayUsage {
  if (!previous || current.total < previous.total) return current;
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

function codexReplayTokenUsageHasContent(
  usage: CodexReplayUsage | undefined,
): usage is CodexReplayUsage {
  return (
    usage !== undefined &&
    (usage.total > 0 ||
      usage.input > 0 ||
      usage.output > 0 ||
      usage.reasoningOutput > 0)
  );
}

function finiteCodexNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function canonicalReplayToolName(name: string): string {
  if (name === "exec") return "exec_command";
  if (name === "image_gen.imagegen" || name === "imagegen.imagegen") {
    return "image_generation_call";
  }
  return name;
}

function parseCodexToolScriptInvocation(
  source: string,
): { toolName: string; toolInput: unknown } | undefined {
  const call = source.match(/tools\.([A-Za-z_$][\w$]*)\s*\(/);
  if (!call?.[1] || call.index === undefined) return undefined;
  const argsStart = source.indexOf("(", call.index);
  const args = balancedCallArgument(source, argsStart);
  if (!args) return undefined;
  const rawName = call[1].replace(/__/g, ".");
  const toolName = canonicalReplayToolName(rawName);
  const trimmedArgs = args.trim();
  const toolInput = parseCodexToolScriptObject(trimmedArgs) ?? trimmedArgs;
  return { toolName, toolInput };
}

function balancedCallArgument(
  source: string,
  openParen: number,
): string | undefined {
  if (openParen < 0 || source[openParen] !== "(") return undefined;
  let depth = 0;
  let quote: '"' | "'" | "`" | undefined;
  let escaped = false;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch !== ")") continue;
    depth--;
    if (depth === 0) return source.slice(openParen + 1, i);
  }
  return undefined;
}

function parseCodexToolScriptObject(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tool wrappers often contain JavaScript object literals with quoted keys.
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const normalized = trimmed
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  try {
    return JSON.parse(normalized);
  } catch {
    return undefined;
  }
}

function isCodexTranscriptRecord(value: unknown): boolean {
  const record = objectRecord(value);
  if (!record) return false;
  const type = objectString(record, "type");
  return (
    type === "session_meta" ||
    type === "response_item" ||
    type === "event_msg" ||
    type === "compacted"
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function parseReplayRoot(text: string, warnings: string[]): unknown {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    const records: unknown[] = [];
    for (const [idx, line] of trimmed.split(/\r?\n/).entries()) {
      const clean = line.trim();
      if (!clean) continue;
      try {
        records.push(JSON.parse(clean));
      } catch {
        warnings.push(`Skipped line ${idx + 1}: not JSON`);
      }
    }
    return records;
  }
}

function replayRecords(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== "object") return [];
  const record = root as Record<string, unknown>;
  for (const key of ["frames", "events", "records", "entries", "log"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [root];
}

function replayStepsFromRecord(
  record: unknown,
  fallbackSeq: number,
  warnings: string[],
): ReplayStep[] {
  if (isCodexEvent(record)) {
    return [eventStep(record, fallbackSeq)];
  }
  if (isReplayFrame(record)) {
    return stepsFromFrame(record, fallbackSeq, warnings);
  }
  const unwrapped = unwrapRecord(record);
  if (isCodexEvent(unwrapped)) {
    return [eventStep(unwrapped, fallbackSeq)];
  }
  if (isReplayFrame(unwrapped)) {
    return stepsFromFrame(unwrapped, fallbackSeq, warnings);
  }
  warnings.push(`Skipped record ${fallbackSeq}: unsupported replay shape`);
  return [];
}

function unwrapRecord(record: unknown): unknown {
  let current = record;
  for (const key of ["record", "frame", "event", "message", "data"]) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      break;
    const value = (current as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return current;
      }
    }
    return value;
  }
  return current;
}

function stepsFromFrame(
  frame: ReplayFrame,
  fallbackSeq: number,
  warnings: string[],
): ReplayStep[] {
  const message = frame.message ?? parseRawMessage(frame.raw);
  if (!message) {
    warnings.push(`Skipped frame ${fallbackSeq}: missing JSON-RPC message`);
    return [];
  }
  const seq = typeof frame.seq === "number" ? frame.seq : fallbackSeq;
  if (frame.direction === "client") {
    return messageFromClientRpc(message, seq, frame.at);
  }
  const method = objectString(message, "method");
  if (!method) return [];
  const params = objectRecord(message.params) ?? {};
  return [
    {
      kind: "event",
      seq,
      at: frame.at,
      label: method,
      event: {
        kind: message.id === undefined ? "notification" : "request",
        method,
        params,
        threadId: threadIdFromParams(params),
        turnId: turnIdFromParams(params),
        receivedAt: frame.at ?? new Date(0).toISOString(),
        seq,
      },
    },
  ];
}

function messageFromClientRpc(
  message: Record<string, unknown>,
  seq: number,
  at: string | undefined,
): ReplayStep[] {
  const method = objectString(message, "method");
  if (method !== "turn/start" && method !== "turn/steer") return [];
  const params = objectRecord(message.params) ?? {};
  const blocks = inputBlocks(params.input);
  if (!blocks.length) return [];
  const replayMessage: CodexAppHistoryMessage & { intent?: "steer" } = {
    id: `codex-replay-user-${seq}`,
    role: "user",
    timestamp: at,
    intent: method === "turn/steer" ? "steer" : undefined,
    blocks,
  };
  return [
    {
      kind: "message",
      seq,
      at,
      label: method === "turn/steer" ? "Steer" : "User message",
      message: replayMessage,
    },
  ];
}

function inputBlocks(input: unknown): CodexAppHistoryBlock[] {
  const items = Array.isArray(input) ? input : [input];
  const blocks: CodexAppHistoryBlock[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim()) {
      blocks.push({ type: "text", text: item });
      continue;
    }
    const record = objectRecord(item);
    if (!record) continue;
    const text = objectString(record, "text");
    if (text) blocks.push({ type: "text", text });
    const path =
      objectString(record, "path") ??
      objectString(record, "filePath") ??
      objectString(record, "imagePath");
    const url = objectString(record, "url");
    if (path || url) {
      blocks.push({
        type: "media",
        mediaKind: "image",
        path,
        url,
        title: objectString(record, "name") ?? objectString(record, "title"),
        mimeType: objectString(record, "mimeType"),
      });
    }
  }
  return blocks;
}

function eventStep(event: CodexAppEvent, fallbackSeq: number): ReplayStep {
  const seq = typeof event.seq === "number" ? event.seq : fallbackSeq;
  return {
    kind: "event",
    seq,
    at: event.receivedAt,
    label: event.method,
    event: { ...event, seq },
  };
}

function isReplayFrame(value: unknown): value is ReplayFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.message !== undefined || record.raw !== undefined;
}

function isCodexEvent(value: unknown): value is CodexAppEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string" && typeof record.method === "string";
}

function parseRawMessage(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return objectRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function threadIdFromParams(
  params: Record<string, unknown>,
): string | undefined {
  return (
    objectString(params, "threadId") ??
    objectString(objectRecord(params.thread), "id") ??
    objectString(params, "conversationId")
  );
}

function turnIdFromParams(params: Record<string, unknown>): string | undefined {
  return (
    objectString(params, "turnId") ??
    objectString(objectRecord(params.turn), "id")
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function objectString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
