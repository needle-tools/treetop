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
}

export interface CodexLiveToolResult {
  id: string;
  toolName: string;
  text: string;
  toolUseId: string;
}

export interface CodexLiveMarker {
  id: string;
  text: string;
}

export interface CodexAppHistoryBlock {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "media"
    | "marker";
  text?: string;
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
}

export interface CodexAppHistoryMessage {
  role: "user" | "assistant" | "system" | "tool";
  blocks: CodexAppHistoryBlock[];
  timestamp?: string;
  id?: string;
}

export type CodexEventStreamState =
  | "connecting"
  | "live"
  | "reconnecting";

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
    (typeof event.params.threadId === "string" ? event.params.threadId : undefined)
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
    if (parsed.kind !== "notification" && parsed.kind !== "request") return null;
    if (!parsed.params || typeof parsed.params !== "object") return null;
    if (typeof parsed.receivedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function codexLiveToolUseFromEvent(
  event: CodexAppEvent,
): CodexLiveToolUse | null {
  const itemId = codexEventItemId(event);
  if (!itemId) return null;
  const toolName = codexEventToolName(event.method, event.params);
  if (!toolName) return null;
  const id = `${toolName === "file change" ? "codex-file" : "codex-tool"}-${itemId}`;
  const toolInput =
    toolName === "file change" && event.params.changes !== undefined
      ? event.params.changes
      : codexEventToolInput(event.params);
  const mediaBlock =
    toolName === "view_image" ? codexViewImageMediaBlock(toolInput) : undefined;
  const approvalFields = codexCommandApprovalFields(event.params);
  return {
    id,
    toolName,
    toolInput,
    toolUseId: itemId,
    inputQuality: codexToolInputQuality(toolInput),
    ...approvalFields,
    ...(mediaBlock ? { mediaBlock } : {}),
  };
}

export function codexLiveToolResultFromEvent(
  event: CodexAppEvent,
): CodexLiveToolResult | null {
  const item = codexEventItem(event.params);
  const itemId = codexEventItemId(event);
  const toolName = codexEventToolName(event.method, event.params);
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
  return null;
}

export function codexLiveMarkerFromEvent(
  event: CodexAppEvent,
): CodexLiveMarker | null {
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
): CodexAppHistoryMessage[] {
  const messages: CodexAppHistoryMessage[] = [];
  const liveToolUse = codexLiveToolUseFromEvent(event);
  if (liveToolUse && !event.method.endsWith("/outputDelta")) {
    messages.push(
      codexToolUseMessage({
        id: liveToolUse.id,
        timestamp: event.receivedAt,
        toolName: liveToolUse.toolName,
        toolInput: liveToolUse.toolInput,
        toolUseId: liveToolUse.toolUseId,
        approvalPolicy: liveToolUse.approvalPolicy,
        approvalDecision: liveToolUse.approvalDecision,
        sandboxPolicy: liveToolUse.sandboxPolicy,
        extraBlocks: liveToolUse.mediaBlock ? [liveToolUse.mediaBlock] : [],
      }),
    );
  }
  const liveToolResult = codexLiveToolResultFromEvent(event);
  if (liveToolResult) {
    messages.push(
      codexToolResultMessage({
        id: liveToolResult.id,
        timestamp: event.receivedAt,
        toolName: liveToolResult.toolName,
        toolUseId: liveToolResult.toolUseId,
        text: liveToolResult.text,
      }),
    );
  }
  const liveGeneratedMedia = codexLiveImageGenerationMedia(event);
  if (liveGeneratedMedia.length > 0) {
    const mediaId =
      liveToolResult?.toolUseId ?? codexEventItemId(event) ?? event.seq ?? "image";
    messages.push({
      id: `codex-media-${mediaId}`,
      role: "assistant",
      timestamp: event.receivedAt,
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
): CodexAppHistoryMessage[] {
  if (!thread || typeof thread !== "object") return [];
  const turns = (thread as Record<string, unknown>).turns;
  if (!Array.isArray(turns)) return [];
  const messages: CodexAppHistoryMessage[] = [];
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
      );
      messages.push(...itemMessages);
    }
  }
  return messages;
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
      messagePayloadWeight(currentMessage) >= messagePayloadWeight(historyMessage);
    merged.push(
      keepCurrent ? currentMessage : historyMessage,
    );
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
): CodexAppHistoryMessage[] {
  if (!rawItem || typeof rawItem !== "object") return [];
  const item = rawItem as Record<string, unknown>;
  const itemType = stringField(item, "type");
  const itemId = stringField(item, "id") ?? turnId ?? "item";
  if (itemType === "userMessage") {
    const blocks = codexUserInputBlocks(item.content);
    return blocks.length
      ? [{ id: `codex-user-${itemId}`, role: "user", timestamp, blocks }]
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

function codexUserInputBlocks(input: unknown): CodexAppHistoryBlock[] {
  if (!Array.isArray(input)) return [];
  const blocks: CodexAppHistoryBlock[] = [];
  let text = "";
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const type = stringField(item, "type");
    if (type === "text") {
      const part = stringField(item, "text");
      if (part) text += part;
    } else if (type === "image") {
      const url = stringField(item, "url");
      if (url) {
        blocks.push({
          type: "media",
          mediaKind: "image",
          url,
          title: "Image",
          alt: "Image",
        });
      }
    } else if (type === "localImage") {
      const path = stringField(item, "path");
      if (path) {
        blocks.push({
          type: "media",
          mediaKind: "image",
          path,
          title: "Image",
          alt: "Image",
        });
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
  if (exitCode === undefined && durationMs === undefined) {
    return output;
  }
  const seconds =
    durationMs !== undefined ? Math.max(0, durationMs / 1000) : 0;
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
      extraBlocks: viewImageMedia ? [viewImageMedia] : [],
    }),
  ];
  const result = item.result ?? item.contentItems ?? item.error;
  if (result !== undefined && result !== null) {
    messages.push(
      codexToolResultMessage({
        id: `codex-output-${itemId}`,
        timestamp,
        toolName: tool,
        toolUseId: itemId,
        text: stringifyPayload(result),
      }),
    );
  }
  return messages;
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
      },
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

function codexViewImageMediaBlock(
  input: unknown,
): CodexAppHistoryBlock | null {
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

function codexReasoningText(item: Record<string, unknown>): string | undefined {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];
  const text = [...summary, ...content]
    .filter((part): part is string => typeof part === "string" && !!part.trim())
    .join("\n\n")
    .trim();
  return text || undefined;
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
  return typeof event.params.itemId === "string"
    ? event.params.itemId
    : typeof item?.id === "string"
      ? item.id
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
): string | null {
  const item = params ? codexEventItem(params) : undefined;
  if (item?.type === "commandExecution") return "exec_command";
  if (item?.type === "fileChange") return "file change";
  if (item?.type === "imageGeneration") return "image_generation_call";
  if (item?.type === "mcpToolCall" || item?.type === "dynamicToolCall") {
    return stringField(item, "tool") ?? item.type;
  }
  if (method.includes("commandExecution") || method.includes("command/exec")) {
    return "exec_command";
  }
  if (method.includes("process/")) return "exec_command";
  if (method.includes("fileChange")) return "file change";
  return null;
}

function codexEventToolInput(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
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

function createHub(
  daemonId: string | undefined,
): Hub {
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
