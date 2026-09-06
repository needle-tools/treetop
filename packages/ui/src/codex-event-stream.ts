import { apiUrl } from "./api";

export interface CodexAppEvent {
  kind: "notification" | "request";
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
  threadId?: string;
  turnId?: string;
  receivedAt: string;
  seq?: number;
}

export interface CodexLiveToolUse {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  inputQuality: number;
  approvalPolicy?: string;
  approvalDecision?: string;
  sandboxPolicy?: string;
  mediaBlock?: CodexAppHistoryBlock;
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

export interface CodexLiveToolResult {
  id: string;
  toolName: string;
  text: string;
  toolUseId: string;
  mediaBlocks?: CodexAppHistoryBlock[];
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

export interface CodexLiveMarker {
  id: string;
  text: string;
}

export interface CodexLiveNormalizeContext {
  toolNames?: Map<string, string>;
  toolInputs?: Map<string, unknown>;
  previousTotalTokenUsage?: CodexAppTokenUsage;
}

function codexLiveToolNameMap(
  context: CodexLiveNormalizeContext,
): Map<string, string> {
  context.toolNames ??= new Map<string, string>();
  return context.toolNames;
}

function codexLiveToolInputMap(
  context: CodexLiveNormalizeContext,
): Map<string, unknown> {
  context.toolInputs ??= new Map<string, unknown>();
  return context.toolInputs;
}

export interface CodexAppHistoryBlock {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "media"
    | "marker"
    | "system_reminder"
    | "subagent";
  text?: string;
  tagName?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  approvalPolicy?: string;
  approvalDecision?: string;
  sandboxPolicy?: string;
  mediaKind?: "image" | "file" | "artifact";
  mimeType?: string;
  path?: string;
  url?: string;
  title?: string;
  alt?: string;
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

export interface CodexAppHistoryMessage {
  role: "user" | "assistant" | "system" | "tool";
  blocks: CodexAppHistoryBlock[];
  timestamp?: string;
  id?: string;
  tokensUsed?: number;
  tokenUsage?: CodexAppTokenUsage;
}

export interface CodexAppTokenUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

export type CodexEventStreamState = "connecting" | "live" | "reconnecting";

interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (evt: MessageEvent) => void): void;
  close(): void;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;

interface Subscriber {
  onEvent?: (event: CodexAppEvent) => void;
  onState?: (state: CodexEventStreamState) => void;
}

interface HubSubscriber extends Subscriber {
  threadId: string | undefined;
}

export function codexEventThreadIdForSession(opts: {
  agent: string;
  mode: string;
  sessionId: string | undefined;
  liveCodexApp: boolean;
}): string | undefined {
  if (opts.agent !== "codex") return undefined;
  if (opts.mode !== "read") return undefined;
  if (!opts.liveCodexApp) return undefined;
  return opts.sessionId || undefined;
}

export function codexAppHistoryKey(
  threadId: string | undefined,
  cwd: string | undefined,
): string {
  return threadId && cwd ? `${threadId}\0${cwd}` : "";
}

export const CODEX_APP_HISTORY_TURNS_PAGE_SIZE = 4;

export function shouldLoadCodexAppThreadHistory(opts: {
  visualAppSurface: boolean;
  threadId: string | undefined;
  cwd: string | undefined;
  hasSession: boolean;
  loadedHistoryKey: string;
  loadingHistoryKey: string;
  failedHistoryKey?: string;
  failedHistoryKeys?: ReadonlySet<string>;
}): boolean {
  if (!opts.visualAppSurface || !opts.hasSession) return false;
  const key = codexAppHistoryKey(opts.threadId, opts.cwd);
  if (!key) return false;
  return (
    key !== opts.loadedHistoryKey &&
    key !== opts.loadingHistoryKey &&
    key !== opts.failedHistoryKey &&
    !opts.failedHistoryKeys?.has(key)
  );
}

export function shouldRunCodexAppLiveSurface(opts: {
  visualAppSurface: boolean;
  mode: "read" | "terminal";
  nearViewport: boolean;
}): boolean {
  return opts.visualAppSurface && opts.mode === "read" && opts.nearViewport;
}

export function shouldSubscribeCodexAppLiveState(opts: {
  visualAppSurface: boolean;
  mode: "read" | "terminal";
}): boolean {
  return opts.visualAppSurface && opts.mode === "read";
}

export function shouldUseCodexAppHistorySource(opts: {
  liveSurfaceActive: boolean;
  transcriptSource: string | undefined;
}): boolean {
  return opts.liveSurfaceActive && !opts.transcriptSource;
}

export function canRequestOlderCodexAppThreadHistory(opts: {
  threadId: string | undefined;
  cwd: string | undefined;
  nextCursor: string | null | undefined;
}): boolean {
  const key = codexAppHistoryKey(opts.threadId, opts.cwd);
  return !!key && !!opts.nextCursor;
}

interface Hub {
  es: EventSourceLike;
  state: CodexEventStreamState;
  subscribers: Set<HubSubscriber>;
  history: CodexAppEvent[];
}

const hubs = new Map<string, Hub>();
const HISTORY_LIMIT = 1_000;
let eventSourceCtorForTests: EventSourceConstructor | null = null;

function daemonKey(daemonId: string | undefined): string {
  return daemonId ?? "";
}

function eventSourceUrl(daemonId: string | undefined): string {
  return apiUrl("/api/codex-app/events", daemonId);
}

function eventSourceCtor(): EventSourceConstructor {
  const ctor = eventSourceCtorForTests ?? globalThis.EventSource;
  if (!ctor) throw new Error("EventSource is not available");
  return ctor as EventSourceConstructor;
}

function setState(hub: Hub, state: CodexEventStreamState): void {
  hub.state = state;
  for (const subscriber of hub.subscribers) subscriber.onState?.(state);
}

function eventThreadId(event: CodexAppEvent): string | undefined {
  return (
    event.threadId ??
    (typeof event.params.threadId === "string"
      ? event.params.threadId
      : undefined)
  );
}

function subscriberWantsEvent(
  subscriber: HubSubscriber,
  event: CodexAppEvent,
): boolean {
  if (!subscriber.threadId) return true;
  return eventThreadId(event) === subscriber.threadId;
}

function pushEvent(hub: Hub, event: CodexAppEvent): void {
  hub.history.push(event);
  if (hub.history.length > HISTORY_LIMIT) {
    hub.history.splice(0, hub.history.length - HISTORY_LIMIT);
  }
  for (const subscriber of hub.subscribers) {
    if (subscriberWantsEvent(subscriber, event)) subscriber.onEvent?.(event);
  }
}

function parseEvent(data: unknown): CodexAppEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as CodexAppEvent;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.method !== "string") return null;
    if (parsed.kind !== "notification" && parsed.kind !== "request")
      return null;
    if (!parsed.params || typeof parsed.params !== "object") return null;
    if (typeof parsed.receivedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function codexLiveToolUseFromEvent(
  event: CodexAppEvent,
  context: CodexLiveNormalizeContext = {},
): CodexLiveToolUse | null {
  const item = codexEventItem(event.params);
  if (
    item?.type === "function_call_output" ||
    item?.type === "custom_tool_call_output"
  ) {
    return null;
  }
  const itemId = codexEventItemId(event);
  if (!itemId) return null;
  const toolName = codexEventToolName(event.method, event.params, context);
  if (!toolName) return null;
  const rawToolInput =
    toolName === "file change" && event.params.changes !== undefined
      ? event.params.changes
      : codexEventToolInput(event.params);
  const normalizedTool =
    item?.type === "custom_tool_call"
      ? codexWrappedToolInvocation(toolName, rawToolInput)
      : { name: toolName, input: rawToolInput };
  codexLiveToolNameMap(context).set(itemId, normalizedTool.name);
  const id = `${normalizedTool.name === "file change" ? "codex-file" : "codex-tool"}-${itemId}`;
  let toolInput = normalizedTool.input;
  const inputMap = codexLiveToolInputMap(context);
  const previousInput = inputMap.get(itemId);
  if (
    previousInput !== undefined &&
    codexToolInputQuality(previousInput) > codexToolInputQuality(toolInput)
  ) {
    toolInput = previousInput;
  } else {
    inputMap.set(itemId, toolInput);
  }
  const mediaBlock =
    normalizedTool.name === "view_image"
      ? codexViewImageMediaBlock(toolInput)
      : undefined;
  const approvalFields = codexCommandApprovalFields(event.params);
  const subagentFields = codexSubagentBlockFromToolUse(
    normalizedTool.name,
    toolInput,
  );
  return {
    id,
    toolName: normalizedTool.name,
    toolInput,
    toolUseId: itemId,
    inputQuality: codexToolInputQuality(toolInput),
    ...approvalFields,
    ...subagentFields,
    ...(mediaBlock ? { mediaBlock } : {}),
  };
}

export function codexLiveToolResultFromEvent(
  event: CodexAppEvent,
  context: CodexLiveNormalizeContext = {},
): CodexLiveToolResult | null {
  const item = codexEventItem(event.params);
  const itemId = codexEventItemId(event);
  const toolName = codexEventToolName(event.method, event.params, context);
  if (!item || !itemId || !toolName) return null;
  if (item.type === "commandExecution") {
    const text = codexCommandExecutionResultText(item);
    return text !== undefined
      ? {
          id: `codex-output-${itemId}`,
          toolName,
          text,
          toolUseId: itemId,
        }
      : null;
  }
  if (item.type === "imageGeneration") {
    return codexImageGenerationHasResult(item)
      ? {
          id: `codex-output-${itemId}`,
          toolName,
          text: "Generated image",
          toolUseId: itemId,
        }
      : null;
  }
  if (
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    const result = codexGenericToolResultPayload(item);
    if (result === undefined) return null;
    const { text, mediaBlocks } = codexToolOutputBlocksFromPayload(result);
    return {
      id: `codex-output-${itemId}`,
      toolName,
      text,
      toolUseId: itemId,
      ...(mediaBlocks.length > 0 ? { mediaBlocks } : {}),
      ...codexSubagentBlockFromToolOutput(toolName, text),
    };
  }
  return null;
}

export function codexLiveMarkerFromEvent(
  event: CodexAppEvent,
): CodexLiveMarker | null {
  if (
    event.method === "context_compacted" ||
    event.params.type === "context_compacted"
  ) {
    return {
      id: `codex-marker-${event.turnId ?? event.params.turnId ?? "context"}-context-${event.seq ?? event.receivedAt}`,
      text: "[Context compacted]",
    };
  }
  if (event.method !== "error") return null;
  if (event.params.willRetry !== false) return null;
  const error = event.params.error;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const message = stringField(record, "message");
  const codexErrorInfo = stringField(record, "codexErrorInfo");
  const label =
    codexErrorInfo === "contextWindowExceeded"
      ? "Context window exceeded"
      : (message ?? "Unretryable error");
  return {
    id: `codex-marker-${event.turnId ?? event.params.turnId ?? event.seq ?? "error"}`,
    text: `[Turn failed: ${label}]`,
  };
}

export function codexLiveMessagesFromEvent(
  event: CodexAppEvent,
  context: CodexLiveNormalizeContext = {},
): CodexAppHistoryMessage[] {
  const messages: CodexAppHistoryMessage[] = [];
  const timestamp = codexLiveItemTimestamp(event);
  const tokenUsage = codexTokenUsageFromEvent(event, context);
  if (tokenUsage !== undefined) {
    messages.push({
      id: `codex-usage-${event.turnId ?? event.params.turnId ?? "turn"}-${event.seq ?? event.receivedAt}`,
      role: "assistant",
      timestamp,
      tokensUsed: codexOutputTokensFromUsage(tokenUsage),
      tokenUsage,
      blocks: [],
    });
  }
  const liveToolUse = codexLiveToolUseFromEvent(event, context);
  if (liveToolUse && !event.method.endsWith("/outputDelta")) {
    messages.push(
      codexToolUseMessage({
        id: liveToolUse.id,
        timestamp,
        toolName: liveToolUse.toolName,
        toolInput: liveToolUse.toolInput,
        toolUseId: liveToolUse.toolUseId,
        approvalPolicy: liveToolUse.approvalPolicy,
        approvalDecision: liveToolUse.approvalDecision,
        sandboxPolicy: liveToolUse.sandboxPolicy,
        extraFields: codexSubagentBlockFromToolUse(
          liveToolUse.toolName,
          liveToolUse.toolInput,
        ),
        extraBlocks: liveToolUse.mediaBlock ? [liveToolUse.mediaBlock] : [],
      }),
    );
  }
  const liveToolResult = codexLiveToolResultFromEvent(event, context);
  if (liveToolResult) {
    messages.push(
      codexToolResultMessage({
        id: liveToolResult.id,
        timestamp,
        toolName: liveToolResult.toolName,
        toolUseId: liveToolResult.toolUseId,
        text: liveToolResult.text,
        extraFields: codexSubagentBlockFromToolOutput(
          liveToolResult.toolName,
          liveToolResult.text,
        ),
        extraBlocks: liveToolResult.mediaBlocks,
      }),
    );
  }
  const liveGeneratedMedia = codexLiveImageGenerationMedia(event);
  if (liveGeneratedMedia.length > 0) {
    const mediaId =
      liveToolResult?.toolUseId ??
      codexEventItemId(event) ??
      event.seq ??
      "image";
    messages.push({
      id: `codex-media-${mediaId}`,
      role: "assistant",
      timestamp,
      blocks: liveGeneratedMedia,
    });
  }
  const liveMarker = codexLiveMarkerFromEvent(event);
  if (liveMarker) {
    messages.push(
      codexMarkerMessage(liveMarker.id, event.receivedAt, liveMarker.text),
    );
  }
  return messages;
}

export function codexAppHistoryMessagesFromThread(
  thread: unknown,
  context: CodexLiveNormalizeContext = {},
): CodexAppHistoryMessage[] {
  if (!thread || typeof thread !== "object") return [];
  const turns = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) return [];
  const messages: CodexAppHistoryMessage[] = [];
  const toolNames = codexLiveToolNameMap(context);
  const usageContext: CodexLiveNormalizeContext = {};
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const turnRecord = turn as Record<string, unknown>;
    const turnId = stringField(turnRecord, "id");
    const timestamp = codexUnixSecondsToIso(turnRecord.startedAt);
    const items = Array.isArray(turnRecord.items) ? turnRecord.items : [];
    for (const rawItem of items) {
      const itemMessages = codexAppMessagesFromThreadItem(
        rawItem,
        turnId,
        timestamp,
        toolNames,
        usageContext,
      );
      messages.push(...itemMessages);
    }
  }
  return messages;
}

export function codexAppHistoryMessagesFromTurnPage(
  thread: unknown,
  context: CodexLiveNormalizeContext = {},
): CodexAppHistoryMessage[] {
  if (!thread || typeof thread !== "object") return [];
  const record = thread as Record<string, unknown>;
  const turns = Array.isArray(record.turns) ? [...record.turns] : [];
  return codexAppHistoryMessagesFromThread(
    {
      ...record,
      turns: turns.reverse(),
    },
    context,
  );
}

export function mergeCodexAppHistoryMessages<
  M extends { id?: string; blocks: unknown[] },
>(history: readonly M[], current: readonly M[]): M[] {
  const currentById = new Map<string, M>();
  for (const message of current) {
    if (message.id) currentById.set(message.id, message);
  }
  const seen = new Set<string>();
  const merged: M[] = [];
  for (const historyMessage of history) {
    const id = historyMessage.id;
    if (!id) {
      merged.push(historyMessage);
      continue;
    }
    seen.add(id);
    const currentMessage = currentById.get(id);
    const keepCurrent =
      currentMessage &&
      messagePayloadWeight(currentMessage) >=
        messagePayloadWeight(historyMessage);
    merged.push(keepCurrent ? currentMessage : historyMessage);
  }
  for (const currentMessage of current) {
    if (!currentMessage.id || !seen.has(currentMessage.id)) {
      merged.push(currentMessage);
    }
  }
  return merged;
}

function codexAppMessagesFromThreadItem(
  rawItem: unknown,
  turnId: string | undefined,
  timestamp: string | undefined,
  toolNames: Map<string, string>,
  usageContext: CodexLiveNormalizeContext = {},
): CodexAppHistoryMessage[] {
  if (!rawItem || typeof rawItem !== "object") return [];
  const item = rawItem as Record<string, unknown>;
  const itemType = stringField(item, "type");
  const itemId =
    stringField(item, "id") ?? stringField(item, "call_id") ?? turnId ?? "item";
  const tokenUsage = codexTokenUsageFromPayload(item, usageContext);
  if (tokenUsage !== undefined) {
    return [
      {
        id: `codex-usage-${itemId}`,
        role: "assistant",
        timestamp,
        tokensUsed: codexOutputTokensFromUsage(tokenUsage),
        tokenUsage,
        blocks: [],
      },
    ];
  }
  if (itemType === "userMessage") {
    const blocks = codexUserInputBlocks(item.content);
    return blocks.length
      ? [
          {
            id: `codex-user-${itemId}`,
            role: blocks.every((block) => block.type === "subagent")
              ? "assistant"
              : "user",
            timestamp,
            blocks,
          },
        ]
      : [];
  }
  if (itemType === "agentMessage") {
    const text = stringField(item, "text");
    return text
      ? [
          {
            id: `codex-agent-${itemId}`,
            role: "assistant",
            timestamp,
            blocks: [{ type: "text", text }],
          },
        ]
      : [];
  }
  if (itemType === "plan") {
    const text = stringField(item, "text");
    return text
      ? [
          {
            id: `codex-plan-${itemId}`,
            role: "assistant",
            timestamp,
            blocks: [{ type: "thinking", text }],
          },
        ]
      : [];
  }
  if (itemType === "reasoning") {
    const text = codexReasoningText(item);
    return text
      ? [
          {
            id: `codex-plan-${itemId}`,
            role: "assistant",
            timestamp,
            blocks: [{ type: "thinking", text }],
          },
        ]
      : [];
  }
  if (itemType === "commandExecution") {
    return codexCommandExecutionMessages(item, itemId, timestamp);
  }
  if (itemType === "fileChange") {
    return [
      codexToolUseMessage({
        id: `codex-file-${itemId}`,
        timestamp,
        toolName: "file change",
        toolInput: item.changes,
        toolUseId: itemId,
      }),
    ];
  }
  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    return codexGenericToolMessages(item, itemId, timestamp);
  }
  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const callId = stringField(item, "call_id") ?? itemId;
    const rawTool = canonicalCodexToolName(
      stringField(item, "name") ??
        (itemType === "custom_tool_call" ? "custom_tool" : "function_call"),
    );
    const rawToolInput =
      itemType === "function_call"
        ? codexToolArguments(item.arguments)
        : (item.input ?? item.arguments);
    const normalized =
      itemType === "custom_tool_call"
        ? codexWrappedToolInvocation(rawTool, rawToolInput)
        : { name: rawTool, input: rawToolInput };
    const tool = normalized.name;
    const toolInput = normalized.input;
    toolNames.set(callId, tool);
    const viewImageMedia =
      tool === "view_image" ? codexViewImageMediaBlock(toolInput) : null;
    return [
      codexToolUseMessage({
        id: `codex-tool-${callId}`,
        timestamp,
        toolName: tool,
        toolInput,
        toolUseId: callId,
        extraFields: codexSubagentBlockFromToolUse(tool, toolInput),
        extraBlocks: viewImageMedia ? [viewImageMedia] : [],
      }),
    ];
  }
  if (
    itemType === "function_call_output" ||
    itemType === "custom_tool_call_output"
  ) {
    const callId = stringField(item, "call_id") ?? itemId;
    const tool = toolNames.get(callId) ?? stringField(item, "name") ?? itemType;
    const { text: output, mediaBlocks } = codexToolOutputBlocksFromPayload(
      item.output ?? item.result ?? "",
    );
    return [
      codexToolResultMessage({
        id: `codex-output-${callId}`,
        timestamp,
        toolName: tool,
        toolUseId: callId,
        text: output,
        extraFields: codexSubagentBlockFromToolOutput(tool, output),
        extraBlocks: mediaBlocks,
      }),
    ];
  }
  if (itemType === "imageView") {
    const path = stringField(item, "path");
    return path
      ? [
          {
            id: `codex-media-${itemId}`,
            role: "assistant",
            timestamp,
            blocks: [
              {
                type: "media",
                mediaKind: "image",
                path,
                title: "Image",
                alt: "Image",
              },
            ],
          },
        ]
      : [];
  }
  if (itemType === "imageGeneration") {
    const messages = [
      codexToolUseMessage({
        id: `codex-tool-${itemId}`,
        timestamp,
        toolName: "image_generation_call",
        toolInput: codexImageGenerationInput(item),
        toolUseId: itemId,
      }),
    ];
    if (codexImageGenerationHasResult(item)) {
      messages.push(
        codexToolResultMessage({
          id: `codex-output-${itemId}`,
          timestamp,
          toolName: "image_generation_call",
          toolUseId: itemId,
          text: "Generated image",
        }),
      );
    }
    const mediaBlocks = codexImageGenerationMediaBlocks(item, itemId);
    if (mediaBlocks.length > 0) {
      messages.push({
        id: `codex-media-${itemId}`,
        role: "assistant",
        timestamp,
        blocks: mediaBlocks,
      });
    }
    return messages;
  }
  if (itemType === "contextCompaction") {
    return [
      codexMarkerMessage(
        `codex-marker-${itemId}`,
        timestamp,
        "[Context compacted]",
      ),
    ];
  }
  return [];
}

function codexTokenUsageFromEvent(
  event: CodexAppEvent,
  context: CodexLiveNormalizeContext = {},
): CodexAppTokenUsage | undefined {
  if (
    event.method !== "token_count" &&
    event.params.type !== "token_count" &&
    !codexPayloadHasTokenUsage(event.params)
  ) {
    return undefined;
  }
  return codexTokenUsageFromPayload(event.params, context);
}

function codexTokenUsageFromObject(
  usage: Record<string, unknown> | undefined,
): CodexAppTokenUsage | undefined {
  if (!usage) return undefined;
  const input = finiteNumber(usage.input_tokens ?? usage.inputTokens) ?? 0;
  const cachedInput =
    finiteNumber(usage.cached_input_tokens ?? usage.cachedInputTokens) ?? 0;
  const cacheWriteInput =
    finiteNumber(
      usage.cache_write_input_tokens ??
        usage.cacheWriteInputTokens ??
        usage.cache_creation_input_tokens ??
        usage.cacheCreationInputTokens,
    ) ?? 0;
  const output = finiteNumber(usage.output_tokens ?? usage.outputTokens) ?? 0;
  const reasoning =
    finiteNumber(
      usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
    ) ?? 0;
  const total =
    finiteNumber(usage.total_tokens ?? usage.totalTokens) ?? input + output;
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

function codexTokenUsageHasContent(
  usage: CodexAppTokenUsage | undefined,
): usage is CodexAppTokenUsage {
  return (
    usage !== undefined &&
    (usage.total > 0 ||
      usage.input > 0 ||
      usage.output > 0 ||
      usage.reasoningOutput > 0)
  );
}

function codexTokenUsageDelta(
  current: CodexAppTokenUsage,
  previous: CodexAppTokenUsage | undefined,
): CodexAppTokenUsage {
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

function codexTokenUsageFromPayload(
  payload: Record<string, unknown>,
  context: CodexLiveNormalizeContext = {},
): CodexAppTokenUsage | undefined {
  const sources = codexTokenUsageSources(payload);
  const threadUsage = codexThreadTokenUsageFromSources(sources, context);
  if (threadUsage) return threadUsage;
  const lastUsage = codexTokenUsageFromSources(
    sources,
    "last_token_usage",
    "lastTokenUsage",
    "usage",
  );
  const totalUsage = codexTokenUsageFromSources(
    sources,
    "total_token_usage",
    "totalTokenUsage",
  );
  if (lastUsage) {
    if (totalUsage) context.previousTotalTokenUsage = totalUsage;
    return lastUsage;
  }
  if (!totalUsage) return undefined;
  const delta = codexTokenUsageDelta(
    totalUsage,
    context.previousTotalTokenUsage,
  );
  context.previousTotalTokenUsage = totalUsage;
  return codexTokenUsageHasContent(delta) ? delta : undefined;
}

function codexPayloadHasTokenUsage(payload: Record<string, unknown>): boolean {
  return codexTokenUsageSources(payload).some((source) =>
    [
      "tokenUsage",
      "last_token_usage",
      "lastTokenUsage",
      "usage",
      "total_token_usage",
      "totalTokenUsage",
    ].some((key) => codexObjectField(source, key) !== undefined),
  );
}

function codexThreadTokenUsageFromSources(
  sources: Record<string, unknown>[],
  context: CodexLiveNormalizeContext,
): CodexAppTokenUsage | undefined {
  for (const source of sources) {
    const tokenUsage = codexObjectField(source, "tokenUsage");
    if (!tokenUsage) continue;
    const lastUsage = codexTokenUsageFromObject(
      codexObjectField(tokenUsage, "last"),
    );
    const totalUsage = codexTokenUsageFromObject(
      codexObjectField(tokenUsage, "total"),
    );
    if (lastUsage) {
      if (totalUsage) context.previousTotalTokenUsage = totalUsage;
      return lastUsage;
    }
    if (!totalUsage) continue;
    const delta = codexTokenUsageDelta(
      totalUsage,
      context.previousTotalTokenUsage,
    );
    context.previousTotalTokenUsage = totalUsage;
    if (codexTokenUsageHasContent(delta)) return delta;
  }
  return undefined;
}

function codexTokenUsageSources(
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();
  const add = (value: Record<string, unknown> | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    sources.push(value);
  };

  add(payload);
  const info = codexObjectField(payload, "info");
  add(info);
  const item = codexObjectField(payload, "item");
  add(item);
  if (item) add(codexObjectField(item, "info"));
  return sources;
}

function codexTokenUsageFromSources(
  sources: Record<string, unknown>[],
  ...keys: string[]
): CodexAppTokenUsage | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const usage = codexTokenUsageFromObject(codexObjectField(source, key));
      if (usage) return usage;
    }
  }
  return undefined;
}

function codexOutputTokensFromUsage(usage: CodexAppTokenUsage): number {
  return usage.output + usage.reasoningOutput;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function codexUserInputBlocks(input: unknown): CodexAppHistoryBlock[] {
  if (!Array.isArray(input)) return [];
  const blocks: CodexAppHistoryBlock[] = [];
  let text = "";
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const media = codexMediaBlockFromContent(item);
    if (media) {
      blocks.push(media);
      continue;
    }
    const type = stringField(item, "type");
    if (type === "text" || type === "input_text" || type === "inputText") {
      const part = stringField(item, "text");
      if (part) {
        const subagent = codexSubagentNotificationBlock(part);
        if (subagent) blocks.push(subagent);
        else text += part;
      }
    }
  }
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

function codexCommandExecutionMessages(
  item: Record<string, unknown>,
  itemId: string,
  timestamp: string | undefined,
): CodexAppHistoryMessage[] {
  const messages: CodexAppHistoryMessage[] = [
    codexToolUseMessage({
      id: `codex-tool-${itemId}`,
      timestamp,
      toolName: "exec_command",
      toolInput: cleanCodexToolInput({
        command: stringField(item, "command"),
        cwd: stringField(item, "cwd"),
        source: stringField(item, "source"),
        commandActions: Array.isArray(item.commandActions)
          ? item.commandActions
          : undefined,
      }),
      toolUseId: itemId,
      ...codexCommandApprovalFields(item),
    }),
  ];
  const output = codexCommandExecutionResultText(item);
  if (output !== undefined) {
    messages.push(
      codexToolResultMessage({
        id: `codex-output-${itemId}`,
        timestamp,
        toolName: "exec_command",
        toolUseId: itemId,
        text: output,
      }),
    );
  }
  return messages;
}

function codexCommandExecutionResultText(
  item: Record<string, unknown>,
): string | undefined {
  const output =
    typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : undefined;
  const exitCode =
    typeof item.exitCode === "number" && Number.isFinite(item.exitCode)
      ? item.exitCode
      : undefined;
  const durationMs =
    typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
      ? item.durationMs
      : undefined;
  const completed = stringField(item, "status") === "completed";
  if (output === undefined && exitCode === undefined && !completed) {
    return undefined;
  }
  if (!completed && exitCode === undefined && durationMs === undefined) {
    return output;
  }
  const seconds = durationMs !== undefined ? Math.max(0, durationMs / 1000) : 0;
  return `Exit code: ${exitCode ?? 0}\nWall time: ${seconds.toFixed(4)} seconds\nOutput:\n${output ?? ""}`;
}

function codexGenericToolMessages(
  item: Record<string, unknown>,
  itemId: string,
  timestamp: string | undefined,
): CodexAppHistoryMessage[] {
  const tool = stringField(item, "tool") ?? stringField(item, "type") ?? "tool";
  const toolInput = codexToolArguments(item.arguments);
  const viewImageMedia =
    tool === "view_image" ? codexViewImageMediaBlock(toolInput) : null;
  const messages: CodexAppHistoryMessage[] = [
    codexToolUseMessage({
      id: `codex-tool-${itemId}`,
      timestamp,
      toolName: tool,
      toolInput,
      toolUseId: itemId,
      extraFields: codexSubagentBlockFromToolUse(tool, toolInput),
      extraBlocks: viewImageMedia ? [viewImageMedia] : [],
    }),
  ];
  const result = codexGenericToolResultPayload(item);
  if (result !== undefined && result !== null) {
    const { text, mediaBlocks } = codexToolOutputBlocksFromPayload(result);
    messages.push(
      codexToolResultMessage({
        id: `codex-output-${itemId}`,
        timestamp,
        toolName: tool,
        toolUseId: itemId,
        text,
        extraFields: codexSubagentBlockFromToolOutput(tool, text),
        extraBlocks: mediaBlocks,
      }),
    );
  }
  return messages;
}

function codexSubagentBlockFromToolUse(
  tool: string,
  input: unknown,
): Partial<CodexAppHistoryBlock> {
  if (tool !== "spawn_agent" && tool !== "wait_agent") return {};
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const targets = Array.isArray(record.targets)
    ? record.targets.filter(
        (target): target is string => typeof target === "string",
      )
    : [];
  return definedHistoryFields({
    subagentAction: tool === "spawn_agent" ? "spawn" : "wait",
    subagentStatus: tool === "spawn_agent" ? "running" : "unknown",
    subagentId:
      stringField(record, "agent_id") ??
      (targets.length === 1 ? targets[0] : undefined),
    subagentType: stringField(record, "agent_type"),
    subagentModel: stringField(record, "model"),
    subagentEffort: stringField(record, "reasoning_effort"),
    subagentMessage: stringField(record, "message"),
  });
}

function codexSubagentBlockFromToolOutput(
  tool: string | undefined,
  output: string,
): Partial<CodexAppHistoryBlock> {
  if (tool !== "spawn_agent" && tool !== "wait_agent") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  if (tool === "spawn_agent") {
    return definedHistoryFields({
      subagentAction: "spawn",
      subagentStatus: "running",
      subagentId: stringField(record, "agent_id"),
      subagentNickname: stringField(record, "nickname"),
    });
  }
  const status = record.status;
  if (!status || typeof status !== "object") return { subagentAction: "wait" };
  const entries = Object.entries(status as Record<string, unknown>);
  if (entries.length !== 1) return { subagentAction: "wait" };
  const [subagentId, rawState] = entries[0]!;
  const state =
    rawState && typeof rawState === "object"
      ? (rawState as Record<string, unknown>)
      : {};
  const completed = stringField(state, "completed");
  const failed = stringField(state, "failed") ?? stringField(state, "error");
  return definedHistoryFields({
    subagentAction: "wait",
    subagentId,
    subagentStatus: completed ? "completed" : failed ? "failed" : "unknown",
    subagentResult: completed ?? failed ?? output,
  });
}

function codexSubagentNotificationBlock(
  text: string,
): CodexAppHistoryBlock | null {
  const match = text
    .trim()
    .match(
      /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/,
    );
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return {
      type: "subagent",
      text,
      subagentAction: "notification",
      subagentStatus: "unknown",
    };
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const status =
    record.status && typeof record.status === "object"
      ? (record.status as Record<string, unknown>)
      : {};
  const completed = stringField(status, "completed");
  const failed = stringField(status, "failed") ?? stringField(status, "error");
  const running = stringField(status, "running");
  const result = completed ?? failed ?? running;
  const block: CodexAppHistoryBlock = {
    type: "subagent",
    text: result,
    subagentAction: "notification",
    subagentStatus: completed
      ? "completed"
      : failed
        ? "failed"
        : running
          ? "running"
          : "unknown",
  };
  const subagentId = stringField(record, "agent_path");
  if (subagentId) block.subagentId = subagentId;
  if (result) block.subagentResult = result;
  return block;
}

function definedHistoryFields(
  fields: Partial<CodexAppHistoryBlock>,
): Partial<CodexAppHistoryBlock> {
  const out: Partial<CodexAppHistoryBlock> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function codexGenericToolResultPayload(item: Record<string, unknown>): unknown {
  return item.result ?? item.output ?? item.contentItems ?? item.error;
}

function codexToolUseMessage(opts: {
  id: string;
  timestamp: string | undefined;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  approvalPolicy?: string;
  approvalDecision?: string;
  sandboxPolicy?: string;
  extraFields?: Partial<CodexAppHistoryBlock>;
  extraBlocks?: CodexAppHistoryBlock[];
}): CodexAppHistoryMessage {
  return {
    id: opts.id,
    role: "assistant",
    timestamp: opts.timestamp,
    blocks: [
      {
        type: "tool_use",
        toolName: opts.toolName,
        toolInput: opts.toolInput,
        toolUseId: opts.toolUseId,
        ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts.approvalDecision
          ? { approvalDecision: opts.approvalDecision }
          : {}),
        ...(opts.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
        ...(opts.extraFields ?? {}),
      },
      ...(opts.extraBlocks ?? []),
    ],
  };
}

function codexToolResultMessage(opts: {
  id: string;
  timestamp: string | undefined;
  toolName: string;
  toolUseId: string;
  text: string;
  extraFields?: Partial<CodexAppHistoryBlock>;
  extraBlocks?: CodexAppHistoryBlock[];
}): CodexAppHistoryMessage {
  return {
    id: opts.id,
    role: "tool",
    timestamp: opts.timestamp,
    blocks: [
      {
        type: "tool_result",
        toolName: opts.toolName,
        toolUseId: opts.toolUseId,
        text: opts.text,
        ...(opts.extraFields ?? {}),
      },
      ...(opts.extraBlocks ?? []),
    ],
  };
}

function codexMarkerMessage(
  id: string,
  timestamp: string | undefined,
  text: string,
): CodexAppHistoryMessage {
  return {
    id,
    role: "system",
    timestamp,
    blocks: [{ type: "marker", text }],
  };
}

function codexMediaTitleFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function codexViewImageMediaBlock(input: unknown): CodexAppHistoryBlock | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const path = stringField(record, "path");
  if (!path) return null;
  const title =
    stringField(record, "title") ??
    stringField(record, "name") ??
    codexMediaTitleFromPath(path);
  return {
    type: "media",
    mediaKind: "image",
    path,
    title,
    alt: title,
  };
}

function codexObjectField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

const CODEX_DATA_URL_PREFIX_RE = /^data:([^;,]+)?(?:;[^,]*)?,/i;

function codexDataUrlMimeType(url: string | undefined): string | undefined {
  const match = url?.match(CODEX_DATA_URL_PREFIX_RE);
  return match?.[1] || undefined;
}

function codexMediaKindFrom(
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

function codexMediaBlockFromContent(
  raw: Record<string, unknown>,
): CodexAppHistoryBlock | null {
  const type = stringField(raw, "type");
  const source = codexObjectField(raw, "source");
  const imageUrl = codexObjectField(raw, "image_url");
  const outputImage = codexObjectField(raw, "output_image");
  const file = codexObjectField(raw, "file");
  const container = outputImage ?? imageUrl ?? source ?? file ?? raw;
  const path =
    stringField(raw, "path") ??
    stringField(raw, "file_path") ??
    stringField(raw, "filePath") ??
    stringField(container, "path") ??
    stringField(container, "file_path") ??
    stringField(container, "filePath");
  const url =
    stringField(raw, "url") ??
    stringField(raw, "image_url") ??
    stringField(container, "url") ??
    stringField(container, "image_url");
  const dataUrlMimeType = codexDataUrlMimeType(url);
  const mimeType =
    stringField(raw, "mime_type") ??
    stringField(raw, "mimeType") ??
    stringField(raw, "media_type") ??
    stringField(container, "mime_type") ??
    stringField(container, "mimeType") ??
    stringField(container, "media_type") ??
    dataUrlMimeType;
  const sourceRef = path ?? url;
  const kind = codexMediaKindFrom(type, mimeType, sourceRef);
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
    stringField(raw, "title") ??
    stringField(raw, "name") ??
    stringField(raw, "filename") ??
    stringField(container, "title") ??
    stringField(container, "name") ??
    stringField(container, "filename") ??
    (kind === "image"
      ? "Image"
      : path
        ? codexMediaTitleFromPath(path)
        : "Artifact");
  const alt =
    stringField(raw, "alt") ??
    stringField(raw, "alt_text") ??
    stringField(container, "alt") ??
    stringField(container, "alt_text") ??
    title;
  const block: CodexAppHistoryBlock = {
    type: "media",
    mediaKind: kind,
    title,
    alt,
  };
  if (mimeType) block.mimeType = mimeType;
  if (path) block.path = path;
  if (url) block.url = url;
  return block;
}

function codexToolOutputBlocksFromPayload(output: unknown): {
  text: string;
  mediaBlocks: CodexAppHistoryBlock[];
} {
  if (typeof output === "string") return { text: output, mediaBlocks: [] };
  if (!Array.isArray(output)) {
    return { text: stringifyPayload(output), mediaBlocks: [] };
  }
  const textParts: string[] = [];
  const mediaBlocks: CodexAppHistoryBlock[] = [];
  for (const raw of output) {
    if (typeof raw === "string") {
      if (raw.trim()) textParts.push(raw);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const media = codexMediaBlockFromContent(item);
    if (media) {
      mediaBlocks.push(media);
      continue;
    }
    const text = stringField(item, "text") ?? stringField(item, "content");
    if (!text) continue;
    const type = stringField(item, "type");
    if (
      type === undefined ||
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      type === "inputText" ||
      type === "outputText"
    ) {
      textParts.push(text);
    }
  }
  return { text: textParts.join("\n"), mediaBlocks };
}

function codexImageGenerationInput(
  item: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return cleanCodexToolInput({
    prompt: stringField(item, "prompt"),
    status: stringField(item, "status"),
    size: stringField(item, "size"),
    quality: stringField(item, "quality"),
  });
}

function codexImageGenerationHasResult(item: Record<string, unknown>): boolean {
  return (
    !!stringField(item, "savedPath") ||
    !!stringField(item, "path") ||
    !!stringField(item, "url") ||
    !!stringField(item, "result")
  );
}

function codexImageGenerationMediaBlocks(
  item: Record<string, unknown>,
  itemId: string,
): CodexAppHistoryBlock[] {
  const path = stringField(item, "savedPath") ?? stringField(item, "path");
  const url = stringField(item, "url");
  const mimeType =
    stringField(item, "mimeType") ?? stringField(item, "mime_type");
  const title = path ? codexMediaTitleFromPath(path) : "Generated image";
  if (!path && !url) return [];
  return [
    {
      type: "media",
      mediaKind: "image",
      ...(mimeType ? { mimeType } : {}),
      ...(path ? { path } : {}),
      ...(url ? { url } : {}),
      title,
      alt: title,
      toolName: "image_generation_call",
      toolUseId: itemId,
    },
  ];
}

function codexLiveImageGenerationMedia(
  event: CodexAppEvent,
): CodexAppHistoryBlock[] {
  const item = codexEventItem(event.params);
  const itemId = codexEventItemId(event);
  if (!item || item.type !== "imageGeneration" || !itemId) return [];
  return codexImageGenerationMediaBlocks(item, itemId);
}

function codexToolArguments(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function canonicalCodexToolName(name: string): string {
  if (name === "exec") return "exec_command";
  if (name === "image_gen.imagegen" || name === "imagegen.imagegen") {
    return "image_generation_call";
  }
  return name;
}

interface CodexWrappedToolInvocation {
  name: string;
  input: unknown;
}

function codexWrappedToolInvocation(
  name: string,
  input: unknown,
): CodexWrappedToolInvocation {
  const canonicalName = canonicalCodexToolName(name);
  if (typeof input !== "string" || canonicalName !== "exec_command") {
    return { name: canonicalName, input };
  }
  const invocation = parseCodexToolScriptInvocation(input);
  return invocation ?? { name: canonicalName, input };
}

function parseCodexToolScriptInvocation(
  source: string,
): CodexWrappedToolInvocation | undefined {
  const call = source.match(/tools\.([A-Za-z_$][\w$]*)\s*\(/);
  if (!call?.[1] || call.index === undefined) return undefined;
  const argsStart = source.indexOf("(", call.index);
  const args = balancedCallArgument(source, argsStart);
  if (!args) return undefined;
  const rawName = call[1].replace(/__/g, ".");
  const name = canonicalCodexToolName(rawName);
  const trimmedArgs = args.trim();
  const variable = trimmedArgs.match(/^[A-Za-z_$][\w$]*$/)?.[0];
  const input =
    variable !== undefined
      ? stringVariableValue(source, variable)
      : parseCodexToolScriptObject(trimmedArgs);
  return { name, input: input ?? trimmedArgs };
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
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
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
    if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return undefined;
}

function stringVariableValue(
  source: string,
  variable: string,
): string | undefined {
  const match = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(variable)}\\s*=\\s*(\"(?:\\\\.|[^\"\\\\])*\")\\s*;`,
    "s",
  ).exec(source);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

function parseCodexToolScriptObject(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    // Codex Desktop custom-tool scripts use JS object literals with unquoted
    // keys. Normalize that concrete transport shape without executing it.
  }
  if (!source.startsWith("{") && !source.startsWith("[")) return undefined;
  const jsonish = source.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(jsonish);
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codexReasoningText(item: Record<string, unknown>): string | undefined {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];
  const text = [...summary, ...content]
    .map(codexReasoningPartText)
    .filter((part): part is string => typeof part === "string" && !!part.trim())
    .join("\n\n")
    .trim();
  return text || undefined;
}

function codexReasoningPartText(part: unknown): string | undefined {
  if (typeof part === "string") return part.trim() ? part : undefined;
  if (!part || typeof part !== "object") return undefined;
  const text = stringField(part as Record<string, unknown>, "text");
  return text?.trim() ? text : undefined;
}

function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function codexUnixSecondsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : undefined;
}

function codexUnixMillisecondsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function codexLiveItemTimestamp(event: CodexAppEvent): string {
  if (event.method === "item/started") {
    return (
      codexUnixMillisecondsToIso(event.params.startedAtMs) ?? event.receivedAt
    );
  }
  if (event.method === "item/completed") {
    return (
      codexUnixMillisecondsToIso(event.params.completedAtMs) ?? event.receivedAt
    );
  }
  return event.receivedAt;
}

function messagePayloadWeight(message: { blocks: unknown[] }): number {
  let weight = 0;
  for (const block of message.blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string") weight += record.text.length;
    if (record.toolInput !== undefined) weight += 100;
    if (record.path || record.url) weight += 50;
  }
  return weight;
}

export function codexEventItemId(event: CodexAppEvent): string | undefined {
  const item = codexEventItem(event.params);
  if (
    (item?.type === "function_call" ||
      item?.type === "custom_tool_call" ||
      item?.type === "function_call_output" ||
      item?.type === "custom_tool_call_output") &&
    typeof item.call_id === "string"
  ) {
    return item.call_id;
  }
  return typeof event.params.itemId === "string"
    ? event.params.itemId
    : typeof event.params.callId === "string"
      ? event.params.callId
      : typeof item?.id === "string"
        ? item.id
        : typeof item?.call_id === "string"
          ? item.call_id
          : event.turnId;
}

export function codexToolInputQuality(input: unknown): number {
  if (typeof input === "string") return input.trim() ? 3 : 0;
  if (!input || typeof input !== "object") return 0;
  const record = input as Record<string, unknown>;
  let quality = 0;
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "itemId" ||
      key === "turnId" ||
      key === "delta" ||
      key === "output" ||
      key === "stdout" ||
      key === "stderr"
    ) {
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    quality += key === "cmd" || key === "command" || key === "changes" ? 2 : 1;
  }
  return quality;
}

function codexEventToolName(
  method: string,
  params?: Record<string, unknown>,
  context: CodexLiveNormalizeContext = {},
): string | null {
  const item = params ? codexEventItem(params) : undefined;
  if (item?.type === "commandExecution") return "exec_command";
  if (item?.type === "fileChange") return "file change";
  if (item?.type === "imageGeneration") return "image_generation_call";
  if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall") {
    return stringField(item, "tool") ?? item.type;
  }
  if (item?.type === "function_call" || item?.type === "custom_tool_call") {
    return canonicalCodexToolName(stringField(item, "name") ?? item.type);
  }
  if (method === "item/tool/call" && params) {
    return stringField(params, "tool") ?? "dynamicToolCall";
  }
  if (
    item?.type === "function_call_output" ||
    item?.type === "custom_tool_call_output"
  ) {
    const itemId =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
          ? item.id
          : undefined;
    return (
      stringField(item, "name") ??
      (itemId ? context.toolNames?.get(itemId) : undefined) ??
      item.type
    );
  }
  if (method.includes("commandExecution") || method.includes("command/exec")) {
    return "exec_command";
  }
  if (method.includes("process/")) return "exec_command";
  if (method.includes("fileChange")) return "file change";
  return null;
}

function codexEventToolInput(params: Record<string, unknown>): unknown {
  const item = codexEventItem(params);
  if (item?.type === "commandExecution") {
    return cleanCodexToolInput({
      command: stringField(item, "command"),
      cwd: stringField(item, "cwd"),
      source: stringField(item, "source"),
      commandActions: Array.isArray(item.commandActions)
        ? item.commandActions
        : undefined,
    });
  }
  if (item?.type === "fileChange") {
    return cleanCodexToolInput({
      changes: item.changes,
      cwd: stringField(item, "cwd"),
    });
  }
  if (item?.type === "imageGeneration") {
    return codexImageGenerationInput(item);
  }
  if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall") {
    const input = codexToolArguments(item.arguments);
    return input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : input === undefined
        ? undefined
        : { value: input };
  }
  if (
    typeof params.callId === "string" &&
    typeof params.tool === "string" &&
    "arguments" in params
  ) {
    const input = codexToolArguments(params.arguments);
    return input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : input === undefined
        ? undefined
        : { value: input };
  }
  if (item?.type === "function_call" || item?.type === "custom_tool_call") {
    return item.type === "function_call"
      ? codexToolArguments(item.arguments)
      : (item.input ?? item.arguments);
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      key === "delta" ||
      key === "threadId" ||
      key === "turnId" ||
      key === "itemId" ||
      value === undefined
    ) {
      continue;
    }
    input[key] = value;
  }
  return Object.keys(input).length ? input : undefined;
}

function codexCommandApprovalFields(
  params: Record<string, unknown>,
): Pick<
  CodexAppHistoryBlock,
  "approvalPolicy" | "approvalDecision" | "sandboxPolicy"
> {
  const item = codexEventItem(params);
  const source = item ?? params;
  const approvalPolicy =
    stringField(source, "approvalPolicy") ??
    stringField(source, "approval_policy");
  const approvalDecision =
    stringField(source, "approvalDecision") ??
    stringField(source, "approvalStatus") ??
    stringField(source, "decision");
  const sandboxPolicy =
    stringField(source, "sandboxPolicy") ??
    stringField(source, "sandbox_policy") ??
    codexSandboxPolicyLabel(source.sandboxPolicy) ??
    codexSandboxPolicyLabel(source.sandbox_policy);
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalDecision ? { approvalDecision } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  };
}

function codexSandboxPolicyLabel(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && type.trim() ? type.trim() : undefined;
}

function codexEventItem(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return params.item && typeof params.item === "object"
    ? (params.item as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cleanCodexToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function createHub(daemonId: string | undefined): Hub {
  const es = new (eventSourceCtor())(eventSourceUrl(daemonId));
  const hub: Hub = {
    es,
    state: "connecting",
    subscribers: new Set(),
    history: [],
  };
  es.onopen = () => setState(hub, "live");
  es.onerror = () => setState(hub, "reconnecting");
  es.addEventListener("codex", (msg) => {
    const event = parseEvent(msg.data);
    if (event) pushEvent(hub, event);
  });
  return hub;
}

export function subscribeCodexEvents(
  daemonId: string | undefined,
  threadId: string | undefined,
  subscriber: Subscriber,
): () => void {
  const key = daemonKey(daemonId);
  let hub = hubs.get(key);
  if (!hub) {
    hub = createHub(daemonId);
    hubs.set(key, hub);
  }
  const hubSubscriber: HubSubscriber = { ...subscriber, threadId };
  hub.subscribers.add(hubSubscriber);
  hubSubscriber.onState?.(hub.state);
  for (const event of hub.history) {
    if (subscriberWantsEvent(hubSubscriber, event)) {
      hubSubscriber.onEvent?.(event);
    }
  }
  return () => {
    const current = hubs.get(key);
    if (!current) return;
    current.subscribers.delete(hubSubscriber);
    if (current.subscribers.size > 0) return;
    current.es.close();
    hubs.delete(key);
  };
}

export function __setCodexEventSourceCtorForTests(
  ctor: EventSourceConstructor | null,
): void {
  eventSourceCtorForTests = ctor;
}

export function __resetCodexEventStreamsForTests(): void {
  for (const hub of hubs.values()) hub.es.close();
  hubs.clear();
  eventSourceCtorForTests = null;
}
