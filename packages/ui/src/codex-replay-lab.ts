import {
  codexLiveMessagesFromEvent,
  type CodexAppEvent,
  type CodexAppHistoryBlock,
  type CodexAppHistoryMessage,
  type CodexAppSessionTransport,
  type CodexAppThreadPage,
  type CodexAppEventSubscriber,
  type CodexLiveNormalizeContext,
} from "./codex-event-stream";
import {
  buildVisualTranscriptItems,
  updateVisualTranscriptItems,
  visualTranscriptMessageWindow,
  type VisualTranscriptItem,
} from "./last-user-message";
import {
  canonicalCodexToolName,
  codexPatchApplyResultText,
  estimateModelTokenCost,
  parseCodexImageWrapper,
  parseCodexToolScriptInvocation,
  type ModelsDevPricingSnapshot,
  type SessionTokenUsageSegment,
} from "@treetop/nicifier";

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
      sourceLine?: number;
      sourceByteEnd?: number;
      label: string;
      message: CodexAppHistoryMessage & { intent?: "steer" };
    }
  | {
      kind: "event";
      seq: number;
      at?: string;
      sourceLine?: number;
      sourceByteEnd?: number;
      label: string;
      event: CodexAppEvent;
    };

export interface ParsedCodexReplay {
  agent: "codex" | "claude";
  mode: "rpc" | "transcript";
  id?: string;
  cwd?: string;
  startedAt?: string;
  lineCount?: number;
  fileSizeBytes?: number;
  steps: ReplayStep[];
  warnings: string[];
}

export type CodexReplayMessage = CodexAppHistoryMessage & { intent?: "steer" };

export interface CodexReplayTranscriptSession {
  agent: "codex" | "claude";
  cwd: string;
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  messages: CodexReplayMessage[];
}

export interface CodexReplayViewEntry {
  agent: "codex" | "claude";
  threadId: string;
  title: string;
  mtimeMs: number;
  rpcRecordingCount: number;
  rpcFrameCount: number;
  hasTranscript: true;
  transcript: {
    path: string;
    messageCount: number;
    cwd: string;
  };
}

export interface CodexReplayViewModel {
  replay: ParsedCodexReplay;
  playback: CodexReplayPlaybackState;
  session: CodexReplayTranscriptSession;
  entry: CodexReplayViewEntry;
  lineCount?: number;
  fileSizeBytes?: number;
}

export type CodexReplayViewModelInput = {
  title: string;
  mtimeMs: number;
  source?: string;
  lineCount?: number;
  fileSizeBytes?: number;
} & (
  | { replay: ParsedCodexReplay; session?: never }
  | { replay?: never; session: CodexReplayTranscriptSession }
);

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

export interface CodexReplayFileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
}

export interface CodexReplayDirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  entries(): AsyncIterableIterator<
    [string, CodexReplayFileHandleLike | CodexReplayDirectoryHandleLike]
  >;
}

export interface CodexReplayDirectoryFile {
  relativePath: string;
  handle: CodexReplayFileHandleLike;
}

export interface CodexReplayFileOverview {
  agent: "codex" | "claude";
  sessionId?: string;
  cwd?: string;
  startedAt?: string;
  title?: string;
  lineCount?: number;
  lineCountExact?: boolean;
}

export type CodexReplaySessionSort =
  | "recent"
  | "agent"
  | "size"
  | "lines"
  | "name";

export const REPLAY_SESSION_LOCATIONS = [
  {
    platform: "macOS",
    codex: [
      "~/.codex/sessions/YYYY/MM/DD/*.jsonl",
      "~/.codex/archived_sessions/*.jsonl",
    ],
    claude: ["~/.claude/projects/<project-folder>/*.jsonl"],
  },
  {
    platform: "Windows",
    codex: [
      "%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\*.jsonl",
      "%USERPROFILE%\\.codex\\archived_sessions\\*.jsonl",
    ],
    claude: ["%USERPROFILE%\\.claude\\projects\\<project-folder>\\*.jsonl"],
  },
] as const;

export interface CodexReplaySessionFixture {
  threadId: string;
  cwd: string;
  page: CodexAppThreadPage;
  events: CodexAppEvent[];
}

export interface CodexReplaySessionTransport extends CodexAppSessionTransport {
  readonly stepCount: number;
  setStep(stepIndex: number): void;
}

export const DEFAULT_REPLAY_VISIBLE_MESSAGE_LIMIT = 260;

const HIGH_TOOL_CALL_COUNT = 12;
const HIGH_NEW_INPUT_TOKENS = 20_000;
const HIGH_OUTPUT_TOKENS = 8_000;
const LOW_THROUGHPUT_TOKENS_PER_SECOND = 5;
const LOW_THROUGHPUT_MIN_OUTPUT_TOKENS = 20;
const LOW_THROUGHPUT_MIN_DURATION_MS = 10_000;
const LONG_TOOL_FREE_TURN_MS = 120_000;
const REPLAY_TEXT_LIMIT = 16 * 1024;
const REPLAY_TEXT_CLIP_SUFFIX = "… [truncated by Treetop]";
const REPLAY_STREAM_YIELD_BYTES = 4 * 1024 * 1024;
const REPLAY_INLINE_MEDIA_LIMIT = 2 * 1024 * 1024;
const REPLAY_INLINE_MEDIA_TOTAL_LIMIT = 32 * 1024 * 1024;
const REPLAY_JSONL_ROW_LIMIT = 16 * 1024 * 1024;

export type CodexReplayTurnIssueKind =
  | "high-tool-usage"
  | "high-new-input"
  | "high-output"
  | "low-throughput"
  | "long-processing";

export interface CodexReplayTurnIssue {
  kind: CodexReplayTurnIssueKind;
  label: string;
  detail: string;
  severity: number;
}

export interface CodexReplayTurnAnalysis {
  index: number;
  label: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  toolCallCount: number;
  newInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokensPerSecond?: number;
  estimatedCostUsd?: number;
  unpricedCheckpoints: number;
  issues: CodexReplayTurnIssue[];
  heat: number;
}

export interface CodexReplayAnalysis {
  turns: CodexReplayTurnAnalysis[];
  issueTurnCount: number;
  maxHeat: number;
  totalEstimatedCostUsd: number;
  unpricedCheckpoints: number;
}

export function analyzeCodexReplayTurns(
  messages: readonly CodexReplayMessage[],
  options: {
    defaultModel?: string;
    modelsDev?: ModelsDevPricingSnapshot;
  } = {},
): CodexReplayAnalysis {
  const grouped: CodexReplayMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user") grouped.push([]);
    if (grouped.length > 0) grouped[grouped.length - 1]!.push(message);
  }
  const turns = grouped.map((turnMessages, index) =>
    analyzeCodexReplayTurn(turnMessages, index, options),
  );
  return {
    turns,
    issueTurnCount: turns.filter((turn) => turn.issues.length > 0).length,
    maxHeat: turns.reduce((max, turn) => Math.max(max, turn.heat), 0),
    totalEstimatedCostUsd: turns.reduce(
      (total, turn) => total + (turn.estimatedCostUsd ?? 0),
      0,
    ),
    unpricedCheckpoints: turns.reduce(
      (total, turn) => total + turn.unpricedCheckpoints,
      0,
    ),
  };
}

export function summarizeCodexReplayPricingUsage(
  messages: readonly CodexReplayMessage[],
): SessionTokenUsageSegment[] {
  return messages.flatMap((message) =>
    message.tokenUsage
      ? [
          {
            model: message.model,
            at: message.timestamp,
            usage: message.tokenUsage,
          },
        ]
      : [],
  );
}

function analyzeCodexReplayTurn(
  messages: readonly CodexReplayMessage[],
  index: number,
  options: {
    defaultModel?: string;
    modelsDev?: ModelsDevPricingSnapshot;
  },
): CodexReplayTurnAnalysis {
  const timestamps = messages
    .map((message) => message.timestamp)
    .filter((timestamp): timestamp is string => !!timestamp)
    .map((timestamp) => ({ timestamp, ms: Date.parse(timestamp) }))
    .filter(({ ms }) => Number.isFinite(ms))
    .sort((a, b) => a.ms - b.ms);
  const startedAt = timestamps[0];
  const endedAt = timestamps[timestamps.length - 1];
  const durationMs =
    startedAt && endedAt ? Math.max(0, endedAt.ms - startedAt.ms) : undefined;
  const toolIds = new Set<string>();
  let anonymousToolCalls = 0;
  let newInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let estimatedCostUsd = 0;
  let pricedCheckpoints = 0;
  let unpricedCheckpoints = 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== "tool_use") continue;
      if (block.toolUseId) toolIds.add(block.toolUseId);
      else anonymousToolCalls += 1;
    }
    const usage = message.tokenUsage;
    if (!usage) continue;
    newInputTokens += Math.max(0, usage.input - usage.cachedInput);
    outputTokens += Math.max(0, usage.output);
    reasoningTokens += Math.max(0, usage.reasoningOutput);
    const cost = estimateModelTokenCost(
      usage,
      message.model ?? options.defaultModel,
      message.timestamp,
      { modelsDev: options.modelsDev },
    );
    if (cost) {
      estimatedCostUsd += cost.totalUsd;
      pricedCheckpoints += 1;
    } else {
      unpricedCheckpoints += 1;
    }
  }
  const toolCallCount = toolIds.size + anonymousToolCalls;
  const durationSeconds = durationMs !== undefined ? durationMs / 1000 : 0;
  const tokensPerSecond =
    toolCallCount === 0 && durationSeconds > 0 && outputTokens > 0
      ? outputTokens / durationSeconds
      : undefined;
  const issues: CodexReplayTurnIssue[] = [];
  if (toolCallCount >= HIGH_TOOL_CALL_COUNT) {
    issues.push({
      kind: "high-tool-usage",
      label: "High tool usage",
      detail: `${toolCallCount} tool calls`,
      severity: clamp01(toolCallCount / 24),
    });
  }
  if (newInputTokens >= HIGH_NEW_INPUT_TOKENS) {
    issues.push({
      kind: "high-new-input",
      label: "Large new input",
      detail: `${formatReplayTokenCount(newInputTokens)} uncached tokens`,
      severity: clamp01(newInputTokens / 80_000),
    });
  }
  if (outputTokens >= HIGH_OUTPUT_TOKENS) {
    issues.push({
      kind: "high-output",
      label: "Large output",
      detail: `${formatReplayTokenCount(outputTokens)} output tokens`,
      severity: clamp01(outputTokens / 24_000),
    });
  }
  if (
    tokensPerSecond !== undefined &&
    durationMs !== undefined &&
    durationMs >= LOW_THROUGHPUT_MIN_DURATION_MS &&
    outputTokens >= LOW_THROUGHPUT_MIN_OUTPUT_TOKENS &&
    tokensPerSecond < LOW_THROUGHPUT_TOKENS_PER_SECOND
  ) {
    issues.push({
      kind: "low-throughput",
      label: "Low throughput",
      detail: `${tokensPerSecond.toFixed(1)} output tok/s`,
      severity: clamp01(1 - tokensPerSecond / LOW_THROUGHPUT_TOKENS_PER_SECOND),
    });
  }
  if (
    toolCallCount === 0 &&
    durationMs !== undefined &&
    durationMs >= LONG_TOOL_FREE_TURN_MS
  ) {
    issues.push({
      kind: "long-processing",
      label: "Long processing",
      detail: `${formatReplayDuration(durationMs)} without tools`,
      severity: clamp01(durationMs / 600_000),
    });
  }
  const activityHeat = Math.max(
    toolCallCount / 20,
    newInputTokens / 80_000,
    outputTokens / 16_000,
    durationMs !== undefined ? durationMs / 300_000 : 0,
  );
  return {
    index,
    label: replayTurnLabel(messages, index),
    ...(startedAt ? { startedAt: startedAt.timestamp } : {}),
    ...(endedAt ? { endedAt: endedAt.timestamp } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    toolCallCount,
    newInputTokens,
    outputTokens,
    reasoningTokens,
    ...(pricedCheckpoints > 0 ? { estimatedCostUsd } : {}),
    unpricedCheckpoints,
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    issues,
    heat: clamp01(
      Math.max(activityHeat, ...issues.map((issue) => issue.severity), 0.04),
    ),
  };
}

function replayTurnLabel(
  messages: readonly CodexReplayMessage[],
  index: number,
): string {
  const user = messages.find((message) => message.role === "user");
  const text = user?.blocks.find((block) => block.type === "text")?.text;
  if (!text) return `Turn ${index + 1}`;
  return compactReplayTitle(text) ?? `Turn ${index + 1}`;
}

function compactReplayTitle(text: string): string | undefined {
  const compact = text
    .replace(
      /<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,
      "",
    )
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    })
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*My request(?: for Codex)?:\s*/i, "");
  if (!compact) return undefined;
  return compact.length > 64 ? `${compact.slice(0, 63)}…` : compact;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatReplayTokenCount(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 100_000)
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(value / 1_000)}k`;
}

export function formatReplayCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function formatReplayDuration(valueMs: number): string {
  const seconds = Math.max(0, Math.round(valueMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatReplayClock(valueMs: number): string {
  const seconds = Math.max(0, Math.floor(valueMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

type ReplayTimeline = {
  steps: readonly {
    at?: string;
    sourceLine?: number;
    sourceByteEnd?: number;
  }[];
};
export type ReplayPlaybackRate =
  | "time:1"
  | "time:10"
  | "steps:1"
  | "steps:2"
  | "steps:5"
  | "steps:20";
const replayStepTimeOffsetCache = new WeakMap<
  ReplayTimeline,
  { steps: ReplayTimeline["steps"]; offsets: number[] }
>();

export function replayPlaybackTiming(
  rate: ReplayPlaybackRate,
):
  | { mode: "time"; multiplier: number; tickMs: 50 }
  | { mode: "steps"; stepsPerSecond: number; tickMs: number } {
  const value = Number(rate.slice(rate.indexOf(":") + 1));
  return rate.startsWith("time:")
    ? { mode: "time", multiplier: value, tickMs: 50 }
    : { mode: "steps", stepsPerSecond: value, tickMs: 1000 / value };
}

export function replayElapsedMsAtStep(
  replay: ReplayTimeline,
  stepIndex: number,
): number {
  const offsets = replayStepTimeOffsets(replay);
  const target = Math.max(
    0,
    Math.min(offsets.length, Math.trunc(stepIndex) || 0),
  );
  return target === 0 ? 0 : (offsets[target - 1] ?? 0);
}

export function replayDurationMs(replay: ReplayTimeline): number {
  return replayElapsedMsAtStep(replay, replay.steps.length);
}

export function replayStepIndexAtElapsedMs(
  replay: ReplayTimeline,
  elapsedMs: number,
): number {
  const offsets = replayStepTimeOffsets(replay);
  const target = Math.max(0, elapsedMs);
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function replaySourceProgressAtStep(
  replay: ReplayTimeline & {
    lineCount?: number;
    fileSizeBytes?: number;
  },
  stepIndex: number,
): { lineCount?: number; fileSizeBytes?: number; exact: boolean } {
  const target = Math.max(
    0,
    Math.min(replay.steps.length, Math.trunc(stepIndex) || 0),
  );
  if (target === 0) {
    return {
      ...(replay.lineCount !== undefined ? { lineCount: 0 } : {}),
      ...(replay.fileSizeBytes !== undefined ? { fileSizeBytes: 0 } : {}),
      exact: true,
    };
  }
  if (target === replay.steps.length) {
    return {
      ...(replay.lineCount !== undefined
        ? { lineCount: replay.lineCount }
        : {}),
      ...(replay.fileSizeBytes !== undefined
        ? { fileSizeBytes: replay.fileSizeBytes }
        : {}),
      exact: true,
    };
  }
  const step = replay.steps[target - 1];
  const ratio = replay.steps.length > 0 ? target / replay.steps.length : 0;
  const exact =
    (replay.lineCount === undefined || step?.sourceLine !== undefined) &&
    (replay.fileSizeBytes === undefined || step?.sourceByteEnd !== undefined);
  return {
    ...(replay.lineCount !== undefined
      ? {
          lineCount: step?.sourceLine ?? Math.round(replay.lineCount * ratio),
        }
      : {}),
    ...(replay.fileSizeBytes !== undefined
      ? {
          fileSizeBytes:
            step?.sourceByteEnd ?? Math.round(replay.fileSizeBytes * ratio),
        }
      : {}),
    exact,
  };
}

function replayStepTimeOffsets(replay: ReplayTimeline): number[] {
  const cached = replayStepTimeOffsetCache.get(replay);
  if (cached?.steps === replay.steps) return cached.offsets;
  const timestamps = replay.steps.map((step) => Date.parse(step.at ?? ""));
  const first = timestamps.find((timestamp) => Number.isFinite(timestamp));
  if (first === undefined) {
    const offsets = timestamps.map(() => 0);
    replayStepTimeOffsetCache.set(replay, { steps: replay.steps, offsets });
    return offsets;
  }
  let previous = 0;
  const offsets = timestamps.map((timestamp) => {
    if (Number.isFinite(timestamp)) {
      previous = Math.max(previous, timestamp - first);
    }
    return previous;
  });
  replayStepTimeOffsetCache.set(replay, { steps: replay.steps, offsets });
  return offsets;
}

export type CodexReplaySessionFilter =
  | "all"
  | "both"
  | "rpc-only"
  | "transcript-only";

export function summarizeCodexReplaySessions(
  sessions: readonly { hasTranscript: boolean; rpcFrameCount: number }[],
): {
  total: number;
  rpc: number;
  transcript: number;
  both: number;
  rpcOnly: number;
  transcriptOnly: number;
} {
  const rpc = sessions.filter((session) => session.rpcFrameCount > 0).length;
  const transcript = sessions.filter((session) => session.hasTranscript).length;
  const both = sessions.filter(
    (session) => session.hasTranscript && session.rpcFrameCount > 0,
  ).length;
  return {
    total: sessions.length,
    rpc,
    transcript,
    both,
    rpcOnly: rpc - both,
    transcriptOnly: transcript - both,
  };
}

export function filterCodexReplaySessions<
  T extends { hasTranscript: boolean; rpcFrameCount: number },
>(sessions: readonly T[], filter: CodexReplaySessionFilter): T[] {
  if (filter === "both")
    return sessions.filter(
      (session) => session.hasTranscript && session.rpcFrameCount > 0,
    );
  if (filter === "rpc-only") {
    return sessions.filter(
      (session) => !session.hasTranscript && session.rpcFrameCount > 0,
    );
  }
  if (filter === "transcript-only") {
    return sessions.filter(
      (session) => session.hasTranscript && session.rpcFrameCount === 0,
    );
  }
  return [...sessions];
}

export function sortCodexReplaySessions<
  T extends {
    agent?: "codex" | "claude";
    title: string;
    mtimeMs: number;
    transcript?: { size?: number; lineCount?: number };
  },
>(sessions: readonly T[], sort: CodexReplaySessionSort): T[] {
  return [...sessions].sort((a, b) => {
    if (sort === "agent") {
      const agentRank = (agent: T["agent"]): number =>
        agent === "codex" ? 0 : agent === "claude" ? 1 : 2;
      return (
        agentRank(a.agent) - agentRank(b.agent) ||
        b.mtimeMs - a.mtimeMs ||
        a.title.localeCompare(b.title)
      );
    }
    if (sort === "name") return a.title.localeCompare(b.title);
    if (sort === "size") {
      return (b.transcript?.size ?? -1) - (a.transcript?.size ?? -1);
    }
    if (sort === "lines") {
      return (b.transcript?.lineCount ?? -1) - (a.transcript?.lineCount ?? -1);
    }
    return b.mtimeMs - a.mtimeMs;
  });
}

export function parseCodexReplaySessionFixture(
  text: string,
  threadId: string,
): CodexReplaySessionFixture {
  const warnings: string[] = [];
  const records = replayRecords(parseReplayRoot(text, warnings));
  let page: CodexAppThreadPage | undefined;
  let cwd = "";
  let snapshotRecordIndex = -1;

  for (const [index, record] of records.entries()) {
    const frame = replayFrameFromRecord(record);
    if (!frame || frame.direction === "client") continue;
    const message = frame.message ?? parseRawMessage(frame.raw);
    const result = objectRecord(message?.result);
    const thread = objectRecord(result?.thread);
    if (!thread || objectString(thread, "id") !== threadId) continue;
    const initialTurnsPage = objectRecord(result?.initialTurnsPage);
    if (!Array.isArray(initialTurnsPage?.data)) continue;
    page = {
      thread: { ...thread, turns: initialTurnsPage.data },
      ...(result && "model" in result ? { model: result.model } : {}),
      ...(typeof initialTurnsPage?.nextCursor === "string"
        ? { nextCursor: initialTurnsPage.nextCursor }
        : {}),
    };
    cwd = objectString(thread, "cwd") ?? "";
    snapshotRecordIndex = index;
    break;
  }

  if (!page) {
    throw new Error(`Recording has no thread snapshot for ${threadId}`);
  }

  const events: CodexAppEvent[] = [];
  for (const [index, record] of records.entries()) {
    if (index <= snapshotRecordIndex) continue;
    const fallbackSeq = index + 1;
    for (const step of replayStepsFromRecord(record, fallbackSeq, [])) {
      if (step.kind !== "event") continue;
      if (step.event.threadId && step.event.threadId !== threadId) continue;
      events.push(step.event);
    }
  }

  return { threadId, cwd, page, events };
}

export function createCodexReplaySessionTransport(
  fixture: CodexReplaySessionFixture,
  initialStep = 0,
): CodexReplaySessionTransport {
  const subscribers = new Set<CodexAppEventSubscriber>();
  let stepIndex = Math.min(
    fixture.events.length,
    Math.max(0, Math.floor(initialStep)),
  );

  return {
    stepCount: fixture.events.length,
    async readThread() {
      return fixture.page;
    },
    subscribe(threadId, subscriber) {
      if (threadId !== fixture.threadId) {
        throw new Error(`Replay transport cannot subscribe to ${threadId}`);
      }
      subscribers.add(subscriber);
      subscriber.onState?.("live");
      for (const event of fixture.events.slice(0, stepIndex)) {
        subscriber.onEvent?.(event);
      }
      return () => subscribers.delete(subscriber);
    },
    setStep(nextStepIndex) {
      const next = Math.min(
        fixture.events.length,
        Math.max(0, Math.floor(nextStepIndex)),
      );
      if (next < stepIndex) {
        throw new Error("Replay transport must be remounted to rewind");
      }
      for (const event of fixture.events.slice(stepIndex, next)) {
        for (const subscriber of subscribers) subscriber.onEvent?.(event);
      }
      stepIndex = next;
    },
  };
}

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

/** Parse a browser-dropped JSONL file without first materializing the entire
 * file as one string. Real Codex transcripts can be gigabytes; retaining only
 * normalized replay steps keeps raw records collectible after each line. */
export async function parseCodexReplayBlobAsync(
  blob: Pick<Blob, "size" | "stream">,
  options: CodexReplayParseOptions = {},
): Promise<ParsedCodexReplay> {
  const warnings: string[] = [];
  const steps: ReplayStep[] = [];
  const toolNames = new Map<string, string>();
  const usageContext: CodexReplayUsageContext = {};
  const decoder = new TextDecoder();
  const reader = blob.stream().getReader();
  let pendingLineParts: string[] = [];
  let pendingLineLength = 0;
  let oversizedLinePrefix = "";
  let discardingOversizedLine = false;
  let bytesRead = 0;
  let lastYieldAt = 0;
  let lineCount = 0;
  let mode: ParsedCodexReplay["mode"] | undefined;
  let agent: ParsedCodexReplay["agent"] | undefined;
  let id: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let retainedInlineMediaBytes = 0;
  let inlineMediaLimitWarned = false;
  let currentLineByteEnd = 0;

  const retainStep = (step: ReplayStep) => {
    if (step.kind !== "message") {
      steps.push({
        ...step,
        sourceLine: lineCount,
        sourceByteEnd: currentLineByteEnd,
      });
      return;
    }
    const blocks = step.message.blocks.filter((block) => {
      if (block.type !== "media" || !block.url?.startsWith("data:")) {
        return true;
      }
      if (
        retainedInlineMediaBytes + block.url.length <=
        REPLAY_INLINE_MEDIA_TOTAL_LIMIT
      ) {
        retainedInlineMediaBytes += block.url.length;
        return true;
      }
      if (!inlineMediaLimitWarned) {
        warnings.push("Omitted inline media after 32 MiB safety limit");
        inlineMediaLimitWarned = true;
      }
      return false;
    });
    if (blocks.length || step.message.tokenUsage) {
      steps.push({
        ...step,
        sourceLine: lineCount,
        sourceByteEnd: currentLineByteEnd,
        message: { ...step.message, blocks },
      });
    }
  };

  const ingestLine = (line: string) => {
    lineCount += 1;
    const clean = line.trim();
    if (!clean) return;
    let record: unknown;
    try {
      record = JSON.parse(clean);
    } catch {
      warnings.push(`Skipped line ${lineCount}: not JSON`);
      return;
    }
    if (!mode && isClaudeTranscriptRecord(record)) {
      agent = "claude";
      mode = "transcript";
    } else if (!mode && isCodexTranscriptRecord(record)) {
      agent = "codex";
      mode = "transcript";
    } else if (!mode && replayFrameFromRecord(record)) {
      agent = "codex";
      mode = "rpc";
    }
    if (!mode) return;
    if (mode === "transcript") {
      const row = objectRecord(record);
      const payload = objectRecord(row?.payload);
      if (agent === "claude") {
        id ??= objectString(row, "sessionId");
        cwd ??= objectString(row, "cwd");
        startedAt ??= objectString(row, "timestamp");
        const step = claudeTranscriptStepFromRow(row, lineCount);
        if (step) retainStep(step);
        return;
      }
      if (objectString(row, "type") === "session_meta") {
        id ??= objectString(payload, "id");
        cwd ??= objectString(payload, "cwd");
        startedAt ??=
          objectString(payload, "timestamp") ?? objectString(row, "timestamp");
        return;
      }
      const parsedSteps = codexTranscriptStepFromRow(
        row,
        payload,
        lineCount,
        toolNames,
        usageContext,
        warnings,
      );
      for (const step of replaySteps(parsedSteps)) retainStep(step);
      return;
    }
    const identity = replayIdentityFromRecord(record);
    id ??= identity.id;
    cwd ??= identity.cwd;
    startedAt ??= identity.startedAt;
    for (const step of replayStepsFromRecord(record, lineCount, warnings)) {
      retainStep(step);
    }
  };

  const appendLinePart = (part: string) => {
    if (discardingOversizedLine) return;
    if (oversizedLinePrefix.length < 4096) {
      oversizedLinePrefix += part.slice(0, 4096 - oversizedLinePrefix.length);
    }
    pendingLineLength += part.length;
    if (pendingLineLength > REPLAY_JSONL_ROW_LIMIT) {
      pendingLineParts = [];
      discardingOversizedLine = true;
      return;
    }
    pendingLineParts.push(part);
  };

  const finishLine = (sourceByteEnd: number) => {
    currentLineByteEnd = sourceByteEnd;
    if (discardingOversizedLine) {
      lineCount += 1;
      warnings.push(`Skipped line ${lineCount}: exceeds 16 MiB safety limit`);
      if (
        mode === "transcript" &&
        /"type"\s*:\s*"(?:compacted|compact_context)"/.test(oversizedLinePrefix)
      ) {
        retainStep(
          transcriptMessageStep(lineCount, undefined, "Context compacted", {
            id: `codex-transcript-marker-${lineCount}`,
            role: "system",
            blocks: [{ type: "marker", text: "Context compacted" }],
          }),
        );
      }
    } else {
      ingestLine(pendingLineParts.join(""));
    }
    pendingLineParts = [];
    pendingLineLength = 0;
    oversizedLinePrefix = "";
    discardingOversizedLine = false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkStart = bytesRead;
      bytesRead += value.byteLength;
      const newlineByteEnds: number[] = [];
      let newlineAt = value.indexOf(10);
      while (newlineAt >= 0) {
        newlineByteEnds.push(chunkStart + newlineAt + 1);
        newlineAt = value.indexOf(10, newlineAt + 1);
      }
      let newlineIndex = 0;
      const parts = decoder.decode(value, { stream: true }).split("\n");
      if (parts.length === 1) {
        appendLinePart(parts[0] ?? "");
      } else {
        appendLinePart(parts[0] ?? "");
        finishLine(newlineByteEnds[newlineIndex++] ?? bytesRead);
        for (let index = 1; index < parts.length - 1; index += 1) {
          appendLinePart(parts[index] ?? "");
          finishLine(newlineByteEnds[newlineIndex++] ?? bytesRead);
        }
        appendLinePart(parts.at(-1) ?? "");
      }
      if (bytesRead - lastYieldAt >= REPLAY_STREAM_YIELD_BYTES) {
        lastYieldAt = bytesRead;
        options.onProgress?.({
          label: `Reading ${bytesRead} / ${blob.size} bytes`,
          parsed: bytesRead,
          total: blob.size,
        });
        await nextParseFrame();
      }
    }
    appendLinePart(decoder.decode());
    if (pendingLineLength > 0 || discardingOversizedLine) finishLine(blob.size);
  } finally {
    reader.releaseLock();
  }
  options.onProgress?.({
    label: "Building transcript",
    parsed: blob.size,
    total: blob.size,
  });
  return {
    agent: agent ?? "codex",
    mode: mode ?? "transcript",
    id,
    cwd,
    startedAt,
    lineCount,
    fileSizeBytes: blob.size,
    steps,
    warnings,
  };
}

/** Recursively enumerate JSONL handles without opening any file. */
export async function collectCodexReplayDirectoryFiles(
  root: CodexReplayDirectoryHandleLike,
): Promise<CodexReplayDirectoryFile[]> {
  const files: CodexReplayDirectoryFile[] = [];
  async function visit(
    directory: CodexReplayDirectoryHandleLike,
    parentPath: string,
  ): Promise<void> {
    for await (const [name, handle] of directory.entries()) {
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      if (handle.kind === "directory") {
        await visit(handle, relativePath);
      } else if (name.toLowerCase().endsWith(".jsonl")) {
        files.push({ relativePath, handle });
      }
    }
  }
  await visit(root, "");
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Read only the head of a candidate session to identify it for a folder
 * index. Opening the session later uses the normal streaming parser. */
export async function inspectCodexReplayFilePrefix(
  file: Pick<Blob, "size" | "slice">,
  options: { maxBytes?: number; lineSampleBytes?: number } = {},
): Promise<CodexReplayFileOverview | undefined> {
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? 512 * 1024));
  const lineSamplePromise = sampleReplayLineCount(
    file,
    options.lineSampleBytes,
  );
  const availableBytes = Math.min(file.size, maxBytes);
  let prefixBytes = Math.min(availableBytes, 128 * 1024);
  let replay = await parseCodexReplayBlobAsync(file.slice(0, prefixBytes));
  let messages = codexReplayMessagesUntil(replay, replay.steps.length);
  let userText = messages
    .find((message) => message.role === "user")
    ?.blocks.find((block) => block.type === "text")?.text;
  while (!userText && prefixBytes < availableBytes) {
    prefixBytes = Math.min(availableBytes, prefixBytes * 2);
    replay = await parseCodexReplayBlobAsync(file.slice(0, prefixBytes));
    messages = codexReplayMessagesUntil(replay, replay.steps.length);
    userText = messages
      .find((message) => message.role === "user")
      ?.blocks.find((block) => block.type === "text")?.text;
  }
  const lineSample = await lineSamplePromise;
  if (!replay.id && !replay.cwd && messages.length === 0) return undefined;
  return {
    agent: replay.agent,
    sessionId: replay.id,
    cwd: replay.cwd,
    startedAt: replay.startedAt,
    title: userText ? compactReplayTitle(userText) : undefined,
    lineCount: lineSample.count,
    lineCountExact: lineSample.exact,
  };
}

async function sampleReplayLineCount(
  file: Pick<Blob, "size" | "slice">,
  requestedSampleBytes?: number,
): Promise<{ count: number; exact: boolean }> {
  if (file.size === 0) return { count: 0, exact: true };
  const sampleBytes = Math.max(
    1024,
    Math.trunc(requestedSampleBytes ?? 32 * 1024),
  );
  if (file.size <= sampleBytes * 3) {
    return {
      count: await countBlobLines(file.slice(0, file.size)),
      exact: true,
    };
  }
  const middleStart = Math.floor((file.size - sampleBytes) / 2);
  const ranges = [
    [0, sampleBytes],
    [middleStart, middleStart + sampleBytes],
    [file.size - sampleBytes, file.size],
  ] as const;
  let newlines = 0;
  for (const [start, end] of ranges) {
    newlines += await countBlobNewlines(file.slice(start, end));
  }
  return {
    count: Math.max(
      1,
      Math.round((newlines / (sampleBytes * ranges.length)) * file.size),
    ),
    exact: false,
  };
}

async function countBlobLines(blob: Blob): Promise<number> {
  if (blob.size === 0) return 0;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const newlines = countNewlineBytes(bytes);
  return newlines + (bytes.at(-1) === 10 ? 0 : 1);
}

async function countBlobNewlines(blob: Blob): Promise<number> {
  return countNewlineBytes(new Uint8Array(await blob.arrayBuffer()));
}

function countNewlineBytes(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  return count;
}

function replayIdentityFromRecord(record: unknown): {
  id?: string;
  cwd?: string;
  startedAt?: string;
} {
  const frame = replayFrameFromRecord(record);
  const message = frame?.message ?? parseRawMessage(frame?.raw);
  const result = objectRecord(message?.result);
  const thread = objectRecord(result?.thread);
  return {
    id: objectString(thread, "id"),
    cwd: objectString(thread, "cwd"),
    startedAt: frame?.at,
  };
}

export function filterCodexReplayTextForThread(
  text: string,
  threadId: string,
): string {
  const trimmed = text.trim();
  if (!trimmed || !threadId) return text;
  try {
    const root = JSON.parse(trimmed);
    if (root && typeof root === "object" && !Array.isArray(root)) {
      const record = root as Record<string, unknown>;
      const key = replayRecordArrayKey(record);
      const frames = key ? record[key] : undefined;
      if (key && Array.isArray(frames)) {
        return JSON.stringify({
          ...record,
          [key]: frames.filter((frame) =>
            codexReplayRecordThreadIds(frame).includes(threadId),
          ),
        });
      }
    }
  } catch {
    // JSONL is the common recording format; fall through to line filtering.
  }
  const lines = trimmed.split(/\r?\n/);
  return lines
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return codexReplayRecordThreadIds(JSON.parse(line)).includes(threadId);
      } catch {
        return false;
      }
    })
    .join("\n");
}

function parseCodexReplayRoot(
  root: unknown,
  warnings: string[],
): ParsedCodexReplay {
  const records = replayRecords(root);
  if (records.some(isClaudeTranscriptRecord)) {
    const steps: ReplayStep[] = [];
    let id: string | undefined;
    let cwd: string | undefined;
    let startedAt: string | undefined;
    for (const [index, record] of records.entries()) {
      const row = objectRecord(record);
      id ??= objectString(row, "sessionId");
      cwd ??= objectString(row, "cwd");
      startedAt ??= objectString(row, "timestamp");
      const step = claudeTranscriptStepFromRow(row, index + 1);
      if (step) steps.push(step);
    }
    return {
      agent: "claude",
      mode: "transcript",
      id,
      cwd,
      startedAt,
      steps,
      warnings,
    };
  }
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
    agent: "codex",
    mode: "rpc",
    id: objectString(rootRecord, "id"),
    startedAt: objectString(rootRecord, "startedAt"),
    steps,
    warnings,
  };
}

function claudeTranscriptStepFromRow(
  row: Record<string, unknown> | undefined,
  seq: number,
): ReplayStep | undefined {
  if (!row) return undefined;
  const type = objectString(row, "type");
  const timestamp = objectString(row, "timestamp");
  if (type === "summary") {
    return transcriptMessageStep(seq, timestamp, "Context compacted", {
      id: objectString(row, "uuid") ?? `claude-transcript-marker-${seq}`,
      role: "system",
      timestamp,
      blocks: [{ type: "marker", text: "Context compacted" }],
    });
  }
  if ((type !== "user" && type !== "assistant") || row.isMeta === true) {
    return undefined;
  }
  const message = objectRecord(row.message);
  if (!message) return undefined;
  const blocks: CodexAppHistoryBlock[] = [];
  const content = message.content;
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      blocks.push({ type: "text", text: clipReplayText(value) });
    }
  };
  if (typeof content === "string") {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const value of content) {
      const block = objectRecord(value);
      const blockType = objectString(block, "type");
      if (blockType === "text") {
        pushText(block?.text);
      } else if (blockType === "thinking") {
        const text = objectString(block, "thinking");
        if (text) blocks.push({ type: "thinking", text: clipReplayText(text) });
      } else if (blockType === "tool_use") {
        blocks.push({
          type: "tool_use",
          toolName: objectString(block, "name"),
          toolUseId: objectString(block, "id"),
          toolInput: block?.input,
        });
      } else if (blockType === "tool_result") {
        const resultContent = block?.content;
        const text =
          typeof resultContent === "string"
            ? resultContent
            : Array.isArray(resultContent)
              ? resultContent
                  .map((item) => objectString(objectRecord(item), "text") ?? "")
                  .join("\n")
              : "";
        blocks.push({
          type: "tool_result",
          toolUseId: objectString(block, "tool_use_id"),
          text: clipReplayText(text),
        });
      }
    }
  }
  const usage = objectRecord(message.usage);
  const freshInput = replayFiniteNumber(usage?.input_tokens);
  const cachedInput = replayFiniteNumber(usage?.cache_read_input_tokens);
  const cacheWriteInput = replayFiniteNumber(
    usage?.cache_creation_input_tokens,
  );
  const output = replayFiniteNumber(usage?.output_tokens);
  const input = freshInput + cachedInput + cacheWriteInput;
  const tokenUsage =
    input + output > 0
      ? {
          input,
          cachedInput,
          cacheWriteInput,
          output,
          reasoningOutput: 0,
          total: input + output,
        }
      : undefined;
  if (!blocks.length && !tokenUsage) return undefined;
  const role =
    type === "user" &&
    blocks.length > 0 &&
    blocks.every((block) => block.type === "tool_result")
      ? "tool"
      : type;
  return transcriptMessageStep(seq, timestamp, `${capitalize(role)} message`, {
    id: objectString(row, "uuid") ?? `claude-transcript-message-${seq}`,
    role,
    timestamp,
    model: objectString(message, "model"),
    tokensUsed: tokenUsage?.output,
    tokenUsage,
    blocks,
  });
}

function replayFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
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

/** Canonical boundary between replay ingestion and Replay Lab rendering.
 * Reading bytes differs for a browser File and a daemon-owned path; after
 * parsing, both sources become this exact replay/playback/session shape. */
export function createCodexReplayViewModel(
  input: CodexReplayViewModelInput,
): CodexReplayViewModel {
  const parsedReplay =
    input.replay ?? replayFromTranscriptSession(input.session);
  const lineCount = input.lineCount ?? parsedReplay.lineCount;
  const fileSizeBytes = input.fileSizeBytes ?? parsedReplay.fileSizeBytes;
  const replay =
    lineCount === parsedReplay.lineCount &&
    fileSizeBytes === parsedReplay.fileSizeBytes
      ? parsedReplay
      : { ...parsedReplay, lineCount, fileSizeBytes };
  const playback = createCodexReplayPlayback(replay, {
    stepIndex: replay.steps.length,
  });
  const messages = playback.messages;
  const sessionInput = input.session;
  const session: CodexReplayTranscriptSession = {
    agent: sessionInput?.agent ?? replay.agent,
    cwd: sessionInput?.cwd ?? replay.cwd ?? "",
    sessionId:
      sessionInput?.sessionId ??
      replay.id ??
      `replay-${input.mtimeMs}-${input.fileSizeBytes ?? 0}`,
    startedAt: sessionInput?.startedAt ?? replay.startedAt,
    endedAt:
      sessionInput?.endedAt ??
      [...messages].reverse().find((message) => message.timestamp)?.timestamp,
    messages,
  };
  return {
    replay,
    playback,
    session,
    entry: {
      agent: session.agent,
      threadId: session.sessionId,
      title: input.title,
      mtimeMs: input.mtimeMs,
      rpcRecordingCount: replay.mode === "rpc" ? 1 : 0,
      rpcFrameCount: replay.mode === "rpc" ? replay.steps.length : 0,
      hasTranscript: true,
      transcript: {
        path: input.source ?? "",
        messageCount: messages.length,
        cwd: session.cwd,
      },
    },
    lineCount: input.lineCount ?? replay.lineCount,
    fileSizeBytes: input.fileSizeBytes ?? replay.fileSizeBytes,
  };
}

function replayFromTranscriptSession(
  session: CodexReplayTranscriptSession,
): ParsedCodexReplay {
  return {
    agent: session.agent,
    mode: "transcript",
    id: session.sessionId,
    cwd: session.cwd,
    startedAt: session.startedAt,
    steps: session.messages.map((message, index) => ({
      kind: "message",
      seq: index + 1,
      at: message.timestamp,
      label: message.role,
      message,
    })),
    warnings: [],
  };
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
    const parsedSteps = codexTranscriptStepFromRow(
      row,
      payload,
      index + 1,
      toolNames,
      usageContext,
      warnings,
    );
    steps.push(...replaySteps(parsedSteps));
  }
  return { agent: "codex", mode: "transcript", id, startedAt, steps, warnings };
}

function codexTranscriptStepFromRow(
  row: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined,
  seq: number,
  toolNames: Map<string, string>,
  usageContext: CodexReplayUsageContext,
  warnings: string[],
): ReplayStep | ReplayStep[] | undefined {
  if (!row || !payload) return undefined;
  const rowType = objectString(row, "type");
  const payloadType = objectString(payload, "type");
  const timestamp =
    objectString(row, "timestamp") ?? objectString(payload, "timestamp");

  if (rowType === "turn_context") {
    usageContext.model = objectString(payload, "model") ?? usageContext.model;
    return undefined;
  }

  if (rowType === "compacted" || payloadType === "compact_context") {
    return transcriptMessageStep(seq, timestamp, "Context compacted", {
      id: `codex-transcript-marker-${seq}`,
      role: "system",
      timestamp,
      blocks: [{ type: "marker", text: "Context compacted" }],
    });
  }

  if (rowType === "event_msg") {
    if (payloadType === "patch_apply_end") {
      const toolUseId = objectString(payload, "call_id");
      const patchSteps: ReplayStep[] = [];
      if (payload.changes && typeof payload.changes === "object") {
        patchSteps.push(
          transcriptMessageStep(seq, timestamp, "file change", {
            id: `codex-transcript-patch-${seq}`,
            role: "assistant",
            timestamp,
            blocks: [
              {
                type: "tool_use",
                toolName: "file change",
                toolUseId,
                toolInput: { changes: payload.changes },
              },
            ],
          }),
        );
      }
      patchSteps.push(
        transcriptMessageStep(seq, timestamp, "Patch result", {
          id: `codex-transcript-patch-result-${seq}`,
          role: "tool",
          timestamp,
          blocks: [
            {
              type: "tool_result",
              toolName: toolNames.get(toolUseId ?? "") ?? "apply_patch",
              toolUseId,
              text: codexPatchApplyResultText(payload),
            },
          ],
        }),
      );
      return patchSteps;
    }
    const tokenUsage = codexReplayTokenUsageFromPayload(payload, usageContext);
    if (tokenUsage) {
      return transcriptMessageStep(seq, timestamp, "Token usage", {
        id: `codex-transcript-token-usage-${seq}`,
        role: "assistant",
        timestamp,
        model: usageContext.model,
        tokensUsed: tokenUsage.output,
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
    // The production transcript parser intentionally omits encrypted/summary
    // reasoning records. Replay must not reinterpret them into extra steps.
    return undefined;
  }

  return undefined;
}

function replaySteps(
  value: ReplayStep | ReplayStep[] | undefined,
): ReplayStep[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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
  const canonicalToolName = canonicalCodexToolName(toolName);
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
  if (raw.length > REPLAY_TEXT_LIMIT) return clipReplayText(raw);
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
    if (typeof value === "string") {
      return { text: clipReplayText(value), mediaBlocks: [] };
    }
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
  return { text: clipReplayText(textParts.join("\n")), mediaBlocks };
}

function transcriptContentBlocks(content: unknown): CodexAppHistoryBlock[] {
  const items = Array.isArray(content) ? content : [content];
  const blocks: CodexAppHistoryBlock[] = [];
  let pendingImageWrapper:
    | ReturnType<typeof parseCodexImageWrapper>
    | undefined;
  for (const item of items) {
    if (typeof item === "string" && item.trim()) {
      blocks.push({ type: "text", text: clipReplayText(item) });
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
      const wrapper = parseCodexImageWrapper(text);
      if (wrapper) {
        pendingImageWrapper = wrapper;
        continue;
      }
      if (text.trim() === "</image>") {
        pendingImageWrapper = undefined;
        continue;
      }
      blocks.push(
        type === "reasoning_text"
          ? { type: "thinking", text: clipReplayText(text) }
          : { type: "text", text: clipReplayText(text) },
      );
    }
    const media = transcriptMediaBlock(record);
    if (media) {
      if (pendingImageWrapper) {
        media.path = pendingImageWrapper.path;
        media.title = pendingImageWrapper.label;
        media.alt = pendingImageWrapper.label;
        pendingImageWrapper = undefined;
      }
      blocks.push(media);
    }
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
  if (
    !path &&
    url?.startsWith("data:") &&
    url.length > REPLAY_INLINE_MEDIA_LIMIT
  ) {
    return undefined;
  }
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

function clipReplayText(text: string): string {
  if (text.length <= REPLAY_TEXT_LIMIT) return text;
  return `${text.slice(0, REPLAY_TEXT_LIMIT)}${REPLAY_TEXT_CLIP_SUFFIX}`;
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
  model?: string;
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

function isCodexTranscriptRecord(value: unknown): boolean {
  const record = objectRecord(value);
  if (!record) return false;
  const type = objectString(record, "type");
  return (
    type === "session_meta" ||
    type === "response_item" ||
    type === "event_msg" ||
    type === "turn_context" ||
    type === "compacted"
  );
}

function isClaudeTranscriptRecord(value: unknown): boolean {
  const record = objectRecord(value);
  if (!record) return false;
  const type = objectString(record, "type");
  return type === "user" || type === "assistant" || type === "summary";
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
  const key = replayRecordArrayKey(record);
  if (key) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [root];
}

function replayFrameFromRecord(record: unknown): ReplayFrame | undefined {
  if (isReplayFrame(record)) return record;
  const unwrapped = unwrapRecord(record);
  return isReplayFrame(unwrapped) ? unwrapped : undefined;
}

function replayRecordArrayKey(
  record: Record<string, unknown>,
): string | undefined {
  return ["frames", "events", "records", "entries", "log"].find((key) =>
    Array.isArray(record[key]),
  );
}

function codexReplayRecordThreadIds(record: unknown): string[] {
  const ids = new Set<string>();
  collectReplayThreadIds(record, (id) => ids.add(id));
  return [...ids];
}

function collectReplayThreadIds(
  value: unknown,
  add: (id: string) => void,
): void {
  const record = objectRecord(value);
  if (!record) return;
  for (const key of ["threadId", "thread_id", "sessionId", "conversationId"]) {
    const id = objectString(record, key);
    if (id) add(id);
  }
  const path = objectString(record, "path");
  if (path) {
    for (const match of path.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi)) {
      add(match[0]);
    }
  }
  const thread = objectRecord(record.thread);
  const threadId =
    objectString(thread, "id") ?? objectString(thread, "sessionId");
  if (threadId) add(threadId);
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) collectReplayThreadIds(item, add);
      continue;
    }
    collectReplayThreadIds(child, add);
  }
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
