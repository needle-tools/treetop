import {
  cleanVisualToolResultText,
  visualObservedProcessOutput,
  visualPathPreviewTargets,
  visualSnapshotUidLabelsFromToolResult,
  visualToolIsTestCommand,
  type VisualObservedProcessOutput,
  type VisualToolPreviewContext,
  type VisualToolPreviewPart,
} from "@treetop/nicifier";

export {
  cleanVisualToolResultText,
  shouldShowLiveToolTimer,
  shouldShowLiveWorkTimer,
  visualFileEditCountBadge,
  visualFileEditSummaryForBlock,
  visualFileEditTotals,
  visualObservedProcessOutput,
  visualPathPreviewTargets,
  visualToolApprovalBadge,
  visualToolCallPayloadLanguage,
  visualToolCallPayloadText,
  visualToolCanStillRun,
  visualToolCommandResultBadges,
  visualToolCommandNicifierCoverage,
  visualToolConfigAssignments,
  visualToolConfigSummaryLabel,
  visualToolConfigTooltipText,
  visualToolEnvAssignments,
  visualToolEnvSummaryLabel,
  visualToolEnvTooltipText,
  visualToolFetchResultBadges,
  visualToolIconNameForPreview,
  visualToolInlineScript,
  visualToolInlineScriptLanguageLabel,
  visualToolInlineScriptPreviewText,
  visualToolLauncherLabel,
  visualToolMediaBlocks,
  visualToolPreviewParts,
  visualToolPreviewText,
  visualToolRemoteHostLabel,
  visualWorkAutoOpenActionGroupId,
  visualWorkDetailEntries,
  visualWorkDetailGroups,
  visualWorkOverview,
  visualSnapshotUidLabelsFromToolResult,
  visualToolTestResultBadges,
  type VisualToolPreviewContext,
  type VisualObservedProcessOutput,
  type VisualToolApprovalBadge,
  type VisualToolConfigAssignment,
  type VisualToolEnvAssignment,
  type VisualToolInlineScript,
  type VisualToolPreviewPart,
  type VisualToolResultBadge,
  type VisualWorkArtifact,
  type VisualWorkArtifactChange,
  type VisualWorkOverview,
  type VisualWorkTimeOverview,
} from "@treetop/nicifier";

export interface MessageBlock {
  type: string;
  text?: string;
  streaming?: boolean;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  approvalPolicy?: string;
  approvalDecision?: string;
  sandboxPolicy?: string;
  explanation?: string;
  planItems?: VisualPlanItem[];
  goalObjective?: string;
  goalStatus?: string;
  goalTokensUsed?: number;
  goalTimeUsedSeconds?: number;
  goalUpdatedAt?: number;
  goalThreadId?: string;
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

export interface VisualMediaBlock extends MessageBlock {
  type: "media";
  mediaKind: "image" | "file" | "artifact";
  path?: string;
  url?: string;
  title?: string;
  alt?: string;
  mimeType?: string;
}

export function visualWorkImageBlocks<
  B extends MessageBlock,
  M extends Message<B>,
>(entries: readonly VisualWorkEntry<B, M>[]): B[] {
  return entries.flatMap((entry) =>
    entry.blocks.filter(
      (block) =>
        block.type === "media" &&
        (block as B & { mediaKind?: string }).mediaKind === "image",
    ),
  );
}

export function visualMediaPathTarget(
  block: MessageBlock,
): Extract<VisualToolPreviewPart, { kind: "path" }> | undefined {
  if (block.type !== "media") return undefined;
  const media = block as VisualMediaBlock;
  if (!media.path) return undefined;
  return visualPathPreviewTargets([media.path])[0];
}

export type VisualPlanStatus = "pending" | "in_progress" | "completed" | string;

export interface VisualPlanItem {
  step: string;
  status: VisualPlanStatus;
}

export interface VisualPlan {
  explanation?: string;
  items: VisualPlanItem[];
  completed: number;
  total: number;
  inProgress: number;
}

export interface VisualGoal {
  objective: string;
  status: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt?: number;
  threadId?: string;
}

export interface TokenUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  cacheWriteInput1h?: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

export interface Message<B extends MessageBlock = MessageBlock> {
  role: string;
  blocks: B[];
  timestamp?: string;
  id?: string;
  tokensUsed?: number;
  tokenUsage?: TokenUsage;
  model?: string;
  intent?: "steer";
  optimisticAfterMessageId?: string;
  optimisticAfterMessageIndex?: number;
}

/** Latest real conversation timestamp, excluding empty accounting/replay rows. */
export function latestSessionMessageActivityIso(
  messages: readonly Message[],
  indexedLastMessageIso?: string,
): string | undefined {
  let latest = indexedLastMessageIso;
  let latestMs = latest ? Date.parse(latest) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(latestMs)) {
    latest = undefined;
    latestMs = Number.NEGATIVE_INFINITY;
  }
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.blocks.length === 0) continue;
    const timestamp = message.timestamp;
    if (!timestamp) continue;
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs) && timestampMs > latestMs) {
      latest = timestamp;
      latestMs = timestampMs;
    }
  }
  return latest;
}

export interface VisualWorkEntry<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> {
  message: M;
  blocks: B[];
  messageIndex: number;
}

export type VisualTranscriptItem<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> =
  | {
      kind: "message";
      message: M;
      blocks: B[];
      messageIndex: number;
    }
  | {
      kind: "marker";
      entry: VisualWorkEntry<B, M>;
      markerBlock: B;
      markerKind: VisualMarkerKind;
      markerLabel: string;
    }
  | {
      kind: "work";
      entries: VisualWorkEntry<B, M>[];
      startedAt?: string;
      endedAt?: string;
      open?: boolean;
      terminalMarkerKind?: VisualMarkerKind;
      terminalMarkerLabel?: string;
    };

export type VisualMarkerKind =
  | "complete"
  | "started"
  | "compacted"
  | "warning"
  | "failed"
  | "aborted"
  | "other";

export interface VisualWorkDisplayEntry<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> {
  kind: "entry" | "marker";
  entry: VisualWorkEntry<B, M>;
  pairedResults?: VisualWorkEntry<B, M>[];
  pairedResult?: VisualWorkEntry<B, M>;
  pairedMedia?: B[];
  pairedToolUse?: VisualWorkEntry<B, M>;
  markerBlock?: B;
  markerKind?: VisualMarkerKind;
  markerLabel?: string;
  previewContext?: VisualToolPreviewContext;
}

export interface VisualWorkSummary {
  steps: number;
  compactions: number;
  warnings: number;
  steerings: number;
  subagents: number;
}

export interface VisualTranscriptDeltaPatch<
  B extends MessageBlock = MessageBlock,
> {
  id: string;
  role: string;
  type: string;
  delta: string;
  blockFields?: Partial<B>;
  timestamp?: string;
  maxTextChars?: number;
}

const VISUAL_DELTA_TRUNCATION_MARKER =
  "\n[… output truncated for display; full output remains in the session …]\n";

function boundedVisualDeltaText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  if (maxChars <= VISUAL_DELTA_TRUNCATION_MARKER.length) {
    return text.slice(-maxChars);
  }
  const available = maxChars - VISUAL_DELTA_TRUNCATION_MARKER.length;
  const headChars = Math.floor(available / 4);
  const tailChars = available - headChars;
  return (
    text.slice(0, headChars) +
    VISUAL_DELTA_TRUNCATION_MARKER +
    text.slice(-tailChars)
  );
}

export interface VisualFileEdit {
  path: string;
  action: "added" | "edited" | "deleted";
  additions?: number;
  deletions?: number;
  raw?: string;
}

export interface VisualFileEditSummary {
  title: string;
  files: VisualFileEdit[];
}

export interface VisualSubagentMeta {
  id?: string;
  nickname?: string;
  action: "spawn" | "wait" | "notification";
  status: "running" | "completed" | "failed" | "unknown";
  type?: string;
  model?: string;
  effort?: string;
  task?: string;
  result?: string;
}

function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function visibleSubagentText(value: unknown): string | undefined {
  const text = stringFromUnknown(value);
  if (!text) return undefined;
  if (/^gAAAAA[A-Za-z0-9_-]{80,}={0,2}$/.test(text)) return undefined;
  return text;
}

function normalizedSubagentToolName(
  toolName: string | undefined,
): "spawn_agent" | "wait_agent" | undefined {
  const normalized = (toolName ?? "").toLowerCase();
  if (normalized.split(/[.:/]/).includes("spawn_agent")) return "spawn_agent";
  if (normalized.split(/[.:/]/).includes("wait_agent")) return "wait_agent";
  if (normalized.endsWith("spawn_agent")) return "spawn_agent";
  if (normalized.endsWith("wait_agent")) return "wait_agent";
  return undefined;
}

export function visualSubagentMetaFromBlocks(
  toolUseBlock: MessageBlock | undefined,
  resultBlock?: MessageBlock | undefined,
): VisualSubagentMeta | undefined {
  const direct =
    visualSubagentMetaFromToolResult(toolUseBlock, resultBlock) ??
    visualSubagentMetaFromBlock(resultBlock) ??
    visualSubagentMetaFromBlock(toolUseBlock);
  if (!direct) return undefined;
  const input = recordFromUnknown(toolUseBlock?.toolInput);
  return {
    ...direct,
    nickname:
      direct.nickname ??
      stringFromUnknown(input?.task_name) ??
      stringFromUnknown(input?.target),
    type: direct.type ?? stringFromUnknown(input?.agent_type),
    model: direct.model ?? stringFromUnknown(input?.model),
    effort: direct.effort ?? stringFromUnknown(input?.reasoning_effort),
    task: visibleSubagentText(direct.task ?? input?.message),
  };
}

function visualSubagentMetaFromToolResult(
  toolUseBlock: MessageBlock | undefined,
  resultBlock: MessageBlock | undefined,
): VisualSubagentMeta | undefined {
  const toolName = normalizedSubagentToolName(
    toolUseBlock?.toolName ?? resultBlock?.toolName,
  );
  if (
    resultBlock?.type !== "tool_result" ||
    !toolName ||
    typeof resultBlock.text !== "string"
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultBlock.text);
  } catch {
    return undefined;
  }
  const record = recordFromUnknown(parsed);
  if (!record) return undefined;
  if (toolName === "spawn_agent") {
    return {
      id: stringFromUnknown(record.agent_id),
      nickname: stringFromUnknown(record.nickname),
      action: "spawn",
      status: "running",
    };
  }
  const status = recordFromUnknown(record.status);
  if (!status) {
    return { action: "wait", status: "unknown" };
  }
  const entries = Object.entries(status);
  if (entries.length !== 1) {
    return { action: "wait", status: "unknown" };
  }
  const [id, rawState] = entries[0]!;
  const state = recordFromUnknown(rawState);
  const completed = state ? stringFromUnknown(state.completed) : undefined;
  const failed = state
    ? (stringFromUnknown(state.failed) ?? stringFromUnknown(state.error))
    : undefined;
  return {
    id,
    action: "wait",
    status: completed ? "completed" : failed ? "failed" : "unknown",
    result: completed ?? failed ?? resultBlock.text,
  };
}

export function visualSubagentMetaFromBlock(
  block: MessageBlock | undefined,
): VisualSubagentMeta | undefined {
  if (!block) return undefined;
  if (block.type === "subagent") {
    return {
      id: block.subagentId,
      nickname: block.subagentNickname,
      action: block.subagentAction ?? "notification",
      status: block.subagentStatus ?? "unknown",
      type: block.subagentType,
      model: block.subagentModel,
      effort: block.subagentEffort,
      task: visibleSubagentText(block.subagentMessage),
      result: block.subagentResult ?? block.text,
    };
  }
  const toolName = normalizedSubagentToolName(block.toolName);
  if (!toolName) {
    return undefined;
  }
  const input = recordFromUnknown(block.toolInput);
  const targets = Array.isArray(input?.targets)
    ? input.targets.filter(
        (target): target is string => typeof target === "string",
      )
    : [];
  return {
    id: block.subagentId ?? stringFromUnknown(input?.agent_id) ?? targets[0],
    nickname: block.subagentNickname,
    action:
      block.subagentAction ?? (toolName === "spawn_agent" ? "spawn" : "wait"),
    status:
      block.subagentStatus ??
      (toolName === "spawn_agent" ? "running" : "unknown"),
    type: block.subagentType ?? stringFromUnknown(input?.agent_type),
    model: block.subagentModel ?? stringFromUnknown(input?.model),
    effort: block.subagentEffort ?? stringFromUnknown(input?.reasoning_effort),
    task: visibleSubagentText(block.subagentMessage ?? input?.message),
    result: block.subagentResult,
  };
}

/** Merge subagent lifecycle/tool rows by the stable child thread id. Activity
 * rows can carry the id for an earlier collaboration tool through toolUseId. */
export function visualWorkSubagents<
  B extends MessageBlock,
  M extends Message<B>,
>(entries: readonly VisualWorkDisplayEntry<B, M>[]): VisualSubagentMeta[] {
  const subagentIdByToolUseId = new Map<string, string>();
  const blocksFor = (entry: VisualWorkDisplayEntry<B, M>): B[] => [
    ...entry.entry.blocks,
    ...(entry.pairedToolUse?.blocks ?? []),
    ...(entry.pairedResult?.blocks ?? []),
  ];
  for (const entry of entries) {
    for (const block of blocksFor(entry)) {
      const meta = visualSubagentMetaFromBlock(block);
      if (meta?.id && block.toolUseId) {
        subagentIdByToolUseId.set(block.toolUseId, meta.id);
      }
    }
  }

  const byKey = new Map<string, VisualSubagentMeta>();
  for (const displayEntry of entries) {
    if (displayEntry.kind !== "entry") continue;
    const toolUse = blocksFor(displayEntry).find(
      (block) => block.type === "tool_use",
    );
    const result = blocksFor(displayEntry).find(
      (block) => block.type === "tool_result",
    );
    const directBlock = blocksFor(displayEntry).find(
      (block) => block.type === "subagent",
    );
    const meta =
      visualSubagentMetaFromBlocks(toolUse, result) ??
      visualSubagentMetaFromBlock(directBlock);
    if (!meta) continue;
    const toolUseId =
      toolUse?.toolUseId ?? result?.toolUseId ?? directBlock?.toolUseId;
    const id =
      meta.id ??
      (toolUseId ? subagentIdByToolUseId.get(toolUseId) : undefined);
    const key = id ?? `${meta.action}:${visualSubagentLabel(meta)}`;
    const existing = byKey.get(key);
    byKey.set(key, {
      ...existing,
      ...meta,
      ...(id ? { id } : {}),
      nickname: existing?.nickname ?? meta.nickname,
      task: existing?.task ?? meta.task,
      result: meta.result ?? existing?.result,
    });
  }
  return [...byKey.values()];
}

export function visualSubagentLabel(meta: VisualSubagentMeta): string {
  return (
    meta.nickname || meta.type || (meta.id ? meta.id.slice(0, 8) : "agent")
  );
}

export function visualPlanFromPayload(input: unknown): VisualPlan | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const rawItems = Array.isArray(record.plan)
    ? record.plan
    : Array.isArray(record.planItems)
      ? record.planItems
      : Array.isArray(record.items)
        ? record.items
        : undefined;
  if (!rawItems) return undefined;
  const items = rawItems
    .map((item): VisualPlanItem | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const step = typeof row.step === "string" ? row.step.trim() : "";
      if (!step) return null;
      const status =
        typeof row.status === "string" && row.status.trim()
          ? row.status.trim()
          : "pending";
      return { step, status };
    })
    .filter((item): item is VisualPlanItem => item !== null);
  if (items.length === 0) return undefined;
  const explanation =
    typeof record.explanation === "string" && record.explanation.trim()
      ? record.explanation.trim()
      : undefined;
  const completed = items.filter((item) => item.status === "completed").length;
  const inProgress = items.filter(
    (item) => item.status === "in_progress",
  ).length;
  return {
    explanation,
    items,
    completed,
    total: items.length,
    inProgress,
  };
}

export function visualPlanFromBlock(
  block: MessageBlock | undefined,
): VisualPlan | undefined {
  if (!block) return undefined;
  if (block.type === "plan") {
    return visualPlanFromPayload({
      explanation: block.explanation,
      planItems: block.planItems,
    });
  }
  return undefined;
}

export function latestVisualPlan(
  messages: readonly Message[],
): VisualPlan | undefined {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (
      let blockIndex = message.blocks.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const plan = visualPlanFromBlock(message.blocks[blockIndex]);
      if (plan) return plan;
    }
  }
  return undefined;
}

export function latestVisualGoal(
  messages: readonly Message[],
): VisualGoal | undefined {
  let objective: string | undefined;
  let status: string | undefined;
  let tokensUsed: number | undefined;
  let timeUsedSeconds: number | undefined;
  let updatedAt: number | undefined;
  let threadId: string | undefined;
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (
      let blockIndex = message.blocks.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = message.blocks[blockIndex];
      if (!block || block.type !== "goal") continue;
      objective ??= block.goalObjective?.trim() || undefined;
      status ??= block.goalStatus?.trim() || undefined;
      tokensUsed ??= block.goalTokensUsed;
      timeUsedSeconds ??= block.goalTimeUsedSeconds;
      updatedAt ??= block.goalUpdatedAt;
      threadId ??= block.goalThreadId;
      if (objective && status) {
        return {
          objective,
          status,
          tokensUsed,
          timeUsedSeconds,
          updatedAt,
          threadId,
        };
      }
    }
  }
  if (!objective && !status) return undefined;
  return {
    objective: objective ?? "Active thread goal",
    status: status ?? "active",
    tokensUsed,
    timeUsedSeconds,
    updatedAt,
    threadId,
  };
}

const BURST_GAP_MS = 30_000;

function isInternalUserMessageText(text: string): boolean {
  return text.trimStart().startsWith("<turn_aborted>");
}

export function extractUserText(m: Message): string {
  const text = (m.blocks ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
  return isInternalUserMessageText(text) ? "" : text;
}

export function lastUserMessageBurst(msgs: Message[]): string | undefined {
  if (!msgs || msgs.length === 0) return undefined;
  const collected: string[] = [];
  let prevTs: number | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const text = extractUserText(m);
    if (text.length === 0) continue;
    const tsRaw = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const ts = Number.isNaN(tsRaw) ? null : tsRaw;
    if (collected.length > 0 && prevTs !== null && ts !== null) {
      if (prevTs - ts > BURST_GAP_MS) break;
    }
    collected.unshift(text);
    if (ts !== null) prevTs = ts;
  }
  if (collected.length === 0) return undefined;
  return collected.join("\n");
}

export function lastUserMessageWithContext(
  msgs: Message[],
  burst: string | undefined,
): string | undefined {
  if (!burst) return undefined;
  if (burst.length >= 10 && burst.includes(" ")) return burst;
  if (!msgs) return burst;
  let pastBurst = false;
  let prevTs: number | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const text = extractUserText(m);
    if (text.length === 0) continue;
    const tsRaw = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const ts = Number.isNaN(tsRaw) ? null : tsRaw;
    if (!pastBurst) {
      if (prevTs !== null && ts !== null && prevTs - ts > BURST_GAP_MS) {
        pastBurst = true;
      } else {
        if (ts !== null) prevTs = ts;
        continue;
      }
    }
    if (pastBurst) return `${text}\n[…]\n${burst}`;
  }
  return burst;
}

const CODEX_IMAGE_ENVELOPE_RE = /<image\b[^>]*>\s*/gi;
const CODEX_REQUEST_BODY_RE = /(?:^|\n)## My request for Codex:\s*\n?/;
const CODEX_FILE_MENTION_IMAGE_RE =
  /(?:^|\n)(?:##\s*)?([^\n:]+?\.(?:png|jpe?g|webp|gif)):\s*\n?([^\n]+\.(?:png|jpe?g|webp|gif))/gi;

function codexImageEnvelopeAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe =
    /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\[[^\]]+\]|[^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    attrs[(match[1] ?? "").toLowerCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function codexImageEnvelopeLabel(rawName: string | undefined): string {
  const trimmed = rawName?.trim() ?? "";
  if (!trimmed) return "Image";
  const bracketed = trimmed.match(/^\[(.+)\]$/);
  return bracketed?.[1]?.trim() || trimmed;
}

export function cleanVisualUserText(text: string | undefined): string {
  if (!text) return "";
  const requestMatch = text.match(CODEX_REQUEST_BODY_RE);
  const requestText =
    requestMatch?.index !== undefined
      ? text.slice(requestMatch.index + requestMatch[0].length)
      : text;
  return requestText
    .replace(CODEX_IMAGE_ENVELOPE_RE, "")
    .replace(/\s*\[Image\s+#\d+\]\s*/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export interface VisualUserImageAttachment {
  label: string;
  path: string;
}

export function visualUserImageAttachments(
  text: string | undefined,
): VisualUserImageAttachment[] {
  if (!text) return [];
  const attachments = Array.from(
    text.matchAll(CODEX_IMAGE_ENVELOPE_RE),
    (match) => {
      const attrs = codexImageEnvelopeAttrs(match[0] ?? "");
      return {
        label: codexImageEnvelopeLabel(attrs.name),
        path: attrs.path ?? attrs.file_path ?? attrs.src ?? attrs.url ?? "",
      };
    },
  ).filter((attachment) => attachment.path.trim().length > 0);
  for (const match of text.matchAll(CODEX_FILE_MENTION_IMAGE_RE)) {
    const label = match[1]?.trim() || "Image";
    const path = match[2]?.trim() || "";
    if (path) attachments.push({ label, path });
  }
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = attachment.path.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatVisualWorkDuration(
  startedAt: string | undefined,
  endedAt: string | undefined,
): string | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return undefined;
  }
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return formatVisualDurationSeconds(totalSeconds);
}

export function formatVisualDurationSeconds(
  totalSeconds: number,
): string | undefined {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return undefined;
  totalSeconds = Math.floor(totalSeconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    const parts = [`${days}d`];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }
  if (hours > 0) {
    const parts = [`${hours}hr`];
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }
  if (minutes > 0) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function visualToolWaitForDurationLabel(
  block: MessageBlock | undefined,
  startedAt: string | undefined,
  nowIso: string,
): string | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const toolName = (block.toolName ?? "").toLowerCase();
  if (toolName !== "wait_for" && !toolName.endsWith(".wait_for")) {
    return undefined;
  }
  const timeoutSeconds = waitForTimeoutSeconds(block.toolInput);
  if (timeoutSeconds === undefined) return undefined;
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(start) || Number.isNaN(now) || now < start) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((now - start) / 1000));
  const elapsed = formatVisualDurationSeconds(elapsedSeconds);
  if (!elapsed) return undefined;
  return `${elapsed} / ${formatWaitTimeoutSeconds(timeoutSeconds)}`;
}

function waitForTimeoutSeconds(input: unknown): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>).timeout;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value > 1000 ? Math.ceil(value / 1000) : Math.ceil(value);
}

function formatWaitTimeoutSeconds(seconds: number): string {
  return `${Math.max(1, Math.ceil(seconds))}s`;
}

function cleanThinkingTitle(text: string): string {
  const fragments = markdownTitleFragments(text);
  if (fragments) return fragments.join(", ");
  return text
    .trim()
    .replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/s, "$1")
    .replace(/^(?:\*|_)(.*?)(?:\*|_)$/s, "$1")
    .trim();
}

function markdownTitleFragments(text: string): string[] | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const fragments: string[] = [];
  for (const line of lines) {
    const lineFragments = markdownTitleLineFragments(line);
    if (!lineFragments) return null;
    fragments.push(...lineFragments);
  }
  if (fragments.length < 2) return null;
  return fragments;
}

function markdownTitleLineFragments(text: string): string[] | null {
  const raw = text.trim();
  if (!raw) return null;
  const fragments: string[] = [];
  const pattern = /(\*\*|__)(.*?)\1/gs;
  let lastIndex = 0;
  for (const match of raw.matchAll(pattern)) {
    const between = raw.slice(lastIndex, match.index).trim();
    if (between) return null;
    const fragment = (match[2] ?? "").trim();
    if (fragment) fragments.push(fragment);
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  if (raw.slice(lastIndex).trim()) return null;
  if (!fragments.length) return null;
  return fragments;
}

export function visualThinkingSummary(text: string | undefined): {
  title: string;
  body: string;
} {
  const raw = (text ?? "").replace(/\r\n/g, "\n").trim();
  const cleaned = raw.replace(/^thinking(?:\s*[:—–-]\s*|\s+)/i, "").trim();
  if (!cleaned) return { title: "", body: "" };
  const cleanedTitleFragments = markdownTitleFragments(cleaned);
  if (cleanedTitleFragments) {
    return { title: cleanedTitleFragments.join(", "), body: "" };
  }
  const [firstLine = "", ...rest] = cleaned.split("\n");
  const title = cleanThinkingTitle(firstLine);
  const body = rest.join("\n").trim();
  if (markdownTitleFragments(firstLine) && title) return { title, body };
  if (title && body && title.length <= 96) return { title, body };
  if (title && !body && title.length <= 96) return { title, body: "" };
  return { title: "", body: cleaned };
}
function hasBlockType(
  entry: VisualWorkEntry | undefined,
  type: string,
): boolean {
  return !!entry && entry.blocks.some((block) => block.type === type);
}

function blockToolUseIds(entry: VisualWorkEntry | undefined): string[] {
  if (!entry) return [];
  return entry.blocks
    .map((block) => block.toolUseId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function firstToolUseName(
  entry: VisualWorkEntry | undefined,
): string | undefined {
  return entry?.blocks.find(
    (block) =>
      block.type === "tool_use" &&
      typeof block.toolName === "string" &&
      block.toolName.length > 0,
  )?.toolName;
}

function firstToolUseBlock(
  entry: VisualWorkEntry | undefined,
): MessageBlock | undefined {
  return entry?.blocks.find((block) => block.type === "tool_use");
}

function firstToolResultBlock(
  entry: VisualWorkEntry | undefined,
): MessageBlock | undefined {
  return entry?.blocks.find((block) => block.type === "tool_result");
}

export function visualObservedProcessOwnerToolUseBlock<
  B extends MessageBlock,
  M extends Message<B>,
>(
  entries: readonly VisualWorkDisplayEntry<B, M>[],
  observedProcessOutput: VisualObservedProcessOutput | undefined,
): B | undefined {
  const sessionId = observedProcessOutput?.processSessionId;
  if (sessionId === undefined) return undefined;
  for (const displayEntry of entries) {
    const resultBlock =
      firstToolResultBlock(displayEntry.pairedResult) ??
      firstToolResultBlock(displayEntry.entry);
    if (!resultBlock) continue;
    const result = cleanVisualToolResultText(resultBlock.text);
    if (result.processSessionId !== sessionId) continue;
    const toolUseBlock =
      firstToolUseBlock(displayEntry.entry) ??
      firstToolUseBlock(displayEntry.pairedToolUse);
    if (!toolUseBlock || !visualToolIsTestCommand(toolUseBlock)) continue;
    return toolUseBlock as B;
  }
  return undefined;
}

function isObservedProcessOutputPair(
  toolUseEntry: VisualWorkEntry | undefined,
  resultEntry: VisualWorkEntry | undefined,
): boolean {
  return !!visualObservedProcessOutput(
    firstToolUseBlock(toolUseEntry),
    firstToolResultBlock(resultEntry),
  );
}

const QUICK_TOOL_RESULT_COLLAPSE_MS = 1000;

function visualEntryTimestampMs(
  entry: VisualWorkEntry | undefined,
): number | undefined {
  const timestamp = entry?.message.timestamp;
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function shouldCollapseToolResultPair(
  toolUseEntry: VisualWorkEntry | undefined,
  resultEntry: VisualWorkEntry | undefined,
  pairedByToolUseId: boolean,
  adjacent: boolean,
): boolean {
  if (isObservedProcessOutputPair(toolUseEntry, resultEntry)) return false;
  if (!pairedByToolUseId && !adjacent) return false;
  const startMs = visualEntryTimestampMs(toolUseEntry);
  const resultMs = visualEntryTimestampMs(resultEntry);
  if (startMs === undefined || resultMs === undefined) {
    return adjacent;
  }
  return Math.abs(resultMs - startMs) <= QUICK_TOOL_RESULT_COLLAPSE_MS;
}

function firstSubagentBlock<B extends MessageBlock>(
  entry: VisualWorkEntry<B> | undefined,
): B | undefined {
  return entry?.blocks.find((block) => block.type === "subagent");
}

function isSameSubagentCompletion(
  left: VisualSubagentMeta | undefined,
  right: VisualSubagentMeta | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.action !== "wait" || right.action !== "notification") return false;
  if (left.status !== "completed" && left.status !== "failed") return false;
  if (right.status !== left.status) return false;
  if (left.id && right.id && left.id !== right.id) return false;
  if (left.result && right.result && left.result !== right.result) return false;
  return true;
}

function isRedundantSubagentNotification(
  toolUseEntry: VisualWorkEntry | undefined,
  resultEntry: VisualWorkEntry | undefined,
  notificationEntry: VisualWorkEntry | undefined,
): boolean {
  const resultMeta = visualSubagentMetaFromBlocks(
    firstToolUseBlock(toolUseEntry),
    firstToolResultBlock(resultEntry),
  );
  const notificationMeta = visualSubagentMetaFromBlock(
    firstSubagentBlock(notificationEntry),
  );
  return isSameSubagentCompletion(resultMeta, notificationMeta);
}

function withToolResultName<B extends MessageBlock, M extends Message<B>>(
  entry: VisualWorkEntry<B, M>,
  toolName: string | undefined,
): VisualWorkEntry<B, M> {
  if (!toolName) return entry;
  if (
    !entry.blocks.some(
      (block) => block.type === "tool_result" && !block.toolName,
    )
  ) {
    return entry;
  }
  const blocks = entry.blocks.map((block) =>
    block.type === "tool_result" && !block.toolName
      ? ({ ...block, toolName } as B)
      : block,
  );
  return {
    ...entry,
    blocks,
    message: { ...entry.message, blocks },
  };
}

function visualMarkerBlock<B extends MessageBlock>(
  entry: VisualWorkEntry<B> | undefined,
): B | undefined {
  return entry?.blocks.length === 1 && entry.blocks[0]?.type === "marker"
    ? entry.blocks[0]
    : undefined;
}

export function visualMarkerLabel(text: string | undefined): string {
  const cleaned = (text ?? "").replace(/^\[|\]$/g, "").trim();
  if (/context window exceeded|context window full/i.test(cleaned)) {
    return "Context window full";
  }
  if (/(?:codex\s+)?turn failed/i.test(cleaned)) return "Turn failed";
  if (/(?:codex\s+)?task complete/i.test(cleaned)) return "Task complete";
  if (/(?:codex\s+)?task started/i.test(cleaned)) return "Task started";
  if (/(?:codex\s+)?context compacted/i.test(cleaned))
    return "Context compacted";
  if (/^(?:warning|retrying):/i.test(cleaned)) return cleaned;
  if (/(?:codex\s+)?turn aborted/i.test(cleaned)) return "Turn aborted";
  return cleaned || "Marker";
}

export function visualMarkerKind(text: string | undefined): VisualMarkerKind {
  const cleaned = text ?? "";
  if (/context window exceeded|context window full/i.test(cleaned)) {
    return "failed";
  }
  if (/(?:codex\s+)?turn failed/i.test(cleaned)) return "failed";
  if (/(?:codex\s+)?task complete/i.test(cleaned)) return "complete";
  if (/(?:codex\s+)?task started/i.test(cleaned)) return "started";
  if (/(?:codex\s+)?context compacted/i.test(cleaned)) return "compacted";
  if (/\[(?:warning|retrying):/i.test(cleaned)) return "warning";
  if (/(?:codex\s+)?turn aborted/i.test(cleaned)) return "aborted";
  return "other";
}

function isTerminalVisualMarkerKind(
  kind: VisualMarkerKind | undefined,
): boolean {
  return kind === "complete" || kind === "aborted" || kind === "failed";
}

function isAssistantRoleLabelOnlyBlocks<B extends MessageBlock>(
  message: Message<B> | undefined,
  blocks: readonly B[],
): boolean {
  if (message?.role !== "assistant") return false;
  if (blocks.length === 0) return false;
  if (blocks.some((block) => block.type !== "text")) return false;
  const text = blocks
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  return /^(codex|claude|ollama)$/i.test(text);
}

function isAssistantRoleLabelOnlyEntry<
  B extends MessageBlock,
  M extends Message<B>,
>(entry: VisualWorkEntry<B, M>): boolean {
  return isAssistantRoleLabelOnlyBlocks(entry.message, entry.blocks);
}

export function buildVisualWorkDisplayEntries<
  B extends MessageBlock,
  M extends Message<B>,
>(entries: readonly VisualWorkEntry<B, M>[]): VisualWorkDisplayEntry<B, M>[] {
  const toolUseByResult = new Map<number, VisualWorkEntry<B, M>>();
  const toolUseIndexByResult = new Map<number, number>();
  const resultsByToolUse = new Map<number, VisualWorkEntry<B, M>[]>();
  const mediaByToolUse = new Map<number, B[]>();
  const toolUseById = new Map<string, number>();
  const pairedToolUses = new Set<number>();
  const collapsedMediaIndexes = new Set<number>();
  const collapsedResultIndexes = new Set<number>();
  const collapsedSubagentNotificationIndexes = new Set<number>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (hasBlockType(entry, "tool_use")) {
      for (const id of blockToolUseIds(entry)) {
        if (!toolUseById.has(id)) toolUseById.set(id, index);
      }
    }
    if (!hasBlockType(entry, "tool_result")) continue;

    let pairedToolUseIndex: number | undefined;
    let pairedByToolUseId = false;
    const resultToolUseIds = blockToolUseIds(entry);
    for (const id of resultToolUseIds) {
      const candidate = toolUseById.get(id);
      if (candidate !== undefined) {
        pairedToolUseIndex = candidate;
        pairedByToolUseId = true;
        break;
      }
    }
    if (resultToolUseIds.length === 0) {
      const adjacentCandidate = index - 1;
      if (
        hasBlockType(entries[adjacentCandidate], "tool_use") &&
        !pairedToolUses.has(adjacentCandidate)
      ) {
        pairedToolUseIndex = adjacentCandidate;
      }
    }
    if (pairedToolUseIndex === undefined) continue;

    toolUseByResult.set(index, entries[pairedToolUseIndex]!);
    toolUseIndexByResult.set(index, pairedToolUseIndex);
    const namedResult = withToolResultName(
      entry,
      firstToolUseName(entries[pairedToolUseIndex]),
    );
    const pairedResults = resultsByToolUse.get(pairedToolUseIndex) ?? [];
    pairedResults.push(namedResult);
    resultsByToolUse.set(pairedToolUseIndex, pairedResults);
    pairedToolUses.add(pairedToolUseIndex);
    if (
      shouldCollapseToolResultPair(
        entries[pairedToolUseIndex],
        entry,
        pairedByToolUseId,
        pairedToolUseIndex === index - 1,
      )
    ) {
      collapsedResultIndexes.add(index);
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (
      entry.blocks.length === 0 ||
      entry.blocks.some((block) => block.type !== "media")
    ) {
      continue;
    }
    let pairedBlocks = 0;
    for (const block of entry.blocks) {
      const toolUseIndex = block.toolUseId
        ? toolUseById.get(block.toolUseId)
        : undefined;
      if (toolUseIndex === undefined) continue;
      const media = mediaByToolUse.get(toolUseIndex) ?? [];
      media.push(block);
      mediaByToolUse.set(toolUseIndex, media);
      pairedBlocks += 1;
    }
    if (pairedBlocks === entry.blocks.length) {
      collapsedMediaIndexes.add(index);
    }
  }

  for (let index = 1; index < entries.length; index += 1) {
    if (!hasBlockType(entries[index]!, "subagent")) continue;
    const previousIndex = index - 1;
    if (
      isRedundantSubagentNotification(
        toolUseByResult.get(previousIndex),
        entries[previousIndex],
        entries[index],
      )
    ) {
      collapsedSubagentNotificationIndexes.add(index);
    }
  }

  const out: VisualWorkDisplayEntry<B, M>[] = [];
  let snapshotUidLabels: ReadonlyMap<string, string> | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (isAssistantRoleLabelOnlyEntry(entry)) {
      continue;
    }
    const markerBlock = visualMarkerBlock(entry);
    if (markerBlock) {
      out.push({
        kind: "marker",
        entry,
        markerBlock,
        markerKind: visualMarkerKind(markerBlock.text),
        markerLabel: visualMarkerLabel(markerBlock.text),
      });
      continue;
    }
    if (
      hasBlockType(entry, "tool_use") &&
      isObservedProcessOutputPair(entry, resultsByToolUse.get(index)?.at(-1))
    ) {
      continue;
    }
    if (collapsedResultIndexes.has(index)) {
      continue;
    }
    if (collapsedMediaIndexes.has(index)) {
      continue;
    }
    if (collapsedSubagentNotificationIndexes.has(index)) {
      continue;
    }
    const pairedToolUse = toolUseByResult.get(index);
    const pairedResults = hasBlockType(entry, "tool_use")
      ? (resultsByToolUse.get(index) ?? [])
      : undefined;
    const pairedMedia = mediaByToolUse.get(
      hasBlockType(entry, "tool_use")
        ? index
        : (toolUseIndexByResult.get(index) ?? -1),
    );
    const displayEntry: VisualWorkDisplayEntry<B, M> = {
      kind: "entry",
      entry: pairedToolUse
        ? withToolResultName(entry, firstToolUseName(pairedToolUse))
        : entry,
      pairedResults,
      pairedResult: pairedResults?.at(-1),
      pairedMedia,
      pairedToolUse,
      previewContext: snapshotUidLabels ? { snapshotUidLabels } : undefined,
    };
    out.push(displayEntry);

    const snapshotLabels = visualSnapshotUidLabelsFromToolResult(
      firstToolUseBlock(displayEntry.pairedToolUse ?? displayEntry.entry),
      firstToolResultBlock(displayEntry.pairedResult) ??
        firstToolResultBlock(displayEntry.entry),
    );
    if (snapshotLabels) {
      snapshotUidLabels = snapshotLabels;
    }
  }
  return out;
}

export function buildVisibleVisualWorkDisplayEntries<
  B extends MessageBlock,
  M extends Message<B>,
>(
  item: Extract<VisualTranscriptItem<B, M>, { kind: "work" }>,
): VisualWorkDisplayEntry<B, M>[] {
  const entries = buildVisualWorkDisplayEntries(item.entries);

  return entries.filter((entry) => {
    if (entry.kind !== "marker") return true;
    if (terminalMarkerContinuesLater(item.entries, entry.entry)) return false;
    if (!item.terminalMarkerKind || !item.terminalMarkerLabel) return true;
    return !(
      entry.markerKind === item.terminalMarkerKind &&
      entry.markerLabel === item.terminalMarkerLabel
    );
  });
}

function isResponseBlock(block: MessageBlock): boolean {
  return block.type === "text" || block.type === "media";
}

function isGeneratedMediaBlock(block: MessageBlock): boolean {
  return (
    block.type === "media" &&
    typeof block.toolName === "string" &&
    /image.*(?:call|generation)/i.test(block.toolName)
  );
}

function mediaBlockKey(block: MessageBlock): string {
  const anyBlock = block as MessageBlock & {
    path?: string;
    url?: string;
    inlineDataHash?: string;
    title?: string;
  };
  return [
    anyBlock.path ?? "",
    anyBlock.url ?? "",
    anyBlock.inlineDataHash ?? "",
    anyBlock.title ?? "",
    block.text ?? "",
    block.toolUseId ?? "",
  ].join("\u0000");
}

function generatedMediaBlocksForFinalResponse<B extends MessageBlock>(
  workEntries: readonly VisualWorkEntry<B>[],
  responseBlocks: readonly B[],
): B[] {
  const existing = new Set(
    responseBlocks.filter((block) => block.type === "media").map(mediaBlockKey),
  );
  const out: B[] = [];
  for (const entry of workEntries) {
    for (const block of entry.blocks) {
      if (!isGeneratedMediaBlock(block)) continue;
      const key = mediaBlockKey(block);
      if (existing.has(key)) continue;
      existing.add(key);
      out.push(block);
    }
  }
  return out;
}

function isAssistantResponseEntry<B extends MessageBlock, M extends Message<B>>(
  entry: VisualWorkEntry<B, M>,
): boolean {
  return (
    entry.message.role === "assistant" && entry.blocks.some(isResponseBlock)
  );
}

function hasTurnMarker<B extends MessageBlock, M extends Message<B>>(
  entries: readonly VisualWorkEntry<B, M>[],
  kind: VisualMarkerKind,
): boolean {
  return entries.some((entry) =>
    entry.blocks.some(
      (block) =>
        block.type === "marker" && visualMarkerKind(block.text) === kind,
    ),
  );
}

export function visualWorkSummary<B extends MessageBlock, M extends Message<B>>(
  entries: readonly VisualWorkEntry<B, M>[],
): VisualWorkSummary {
  let compactions = 0;
  let warnings = 0;
  let steerings = 0;
  const subagentIdByToolUseId = new Map<string, string>();
  for (const entry of entries) {
    for (const block of entry.blocks) {
      const meta = visualSubagentMetaFromBlock(block);
      if (meta?.id && block.toolUseId) {
        subagentIdByToolUseId.set(block.toolUseId, meta.id);
      }
    }
  }
  const subagents = new Set<string>();
  let boundaryMarkers = 0;
  for (const entry of entries) {
    if (userMessageIntent(entry.message) === "steer") {
      steerings += 1;
      continue;
    }
    const markerBlock = visualMarkerBlock(entry);
    const markerKind = visualMarkerKind(markerBlock?.text);
    if (
      markerKind === "started" ||
      markerKind === "complete" ||
      markerKind === "aborted" ||
      markerKind === "failed"
    ) {
      boundaryMarkers += 1;
      continue;
    }
    if (markerKind === "compacted") {
      compactions += 1;
    }
    if (markerKind === "warning") {
      warnings += 1;
    }
    for (const block of entry.blocks) {
      const meta = visualSubagentMetaFromBlock(block);
      if (!meta) continue;
      subagents.add(
        meta.id ??
          (block.toolUseId
            ? (subagentIdByToolUseId.get(block.toolUseId) ?? block.toolUseId)
            : `${entry.messageIndex}`),
      );
    }
  }
  return {
    steps:
      entries.length -
      compactions -
      warnings -
      steerings -
      boundaryMarkers -
      subagents.size,
    compactions,
    warnings,
    steerings,
    subagents: subagents.size,
  };
}

function compactionMarkerEntry<B extends MessageBlock, M extends Message<B>>(
  entry: VisualWorkEntry<B, M>,
): VisualTranscriptItem<B, M> | undefined {
  const markerBlock = visualMarkerBlock(entry);
  if (!markerBlock || visualMarkerKind(markerBlock.text) !== "compacted")
    return undefined;
  return {
    kind: "marker",
    entry,
    markerBlock,
    markerKind: "compacted",
    markerLabel: visualMarkerLabel(markerBlock.text),
  };
}

function terminalWorkMarker<B extends MessageBlock, M extends Message<B>>(
  entries: readonly VisualWorkEntry<B, M>[],
): Pick<
  Extract<VisualTranscriptItem<B, M>, { kind: "work" }>,
  "terminalMarkerKind" | "terminalMarkerLabel"
> {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const markerBlock = visualMarkerBlock(entry);
    const kind = visualMarkerKind(markerBlock?.text);
    if (kind === "aborted" || kind === "failed") {
      if (terminalMarkerContinuesLater(entries, entry)) continue;
      return {
        terminalMarkerKind: kind,
        terminalMarkerLabel: visualMarkerLabel(markerBlock?.text),
      };
    }
  }
  return {};
}

function isOptimisticUserMessage<B extends MessageBlock>(
  message: Message<B> | undefined,
): boolean {
  return (
    message?.role === "user" &&
    typeof message.id === "string" &&
    message.id.startsWith("codex-optimistic-user-")
  );
}

export function userMessageIntent<B extends MessageBlock>(
  message: Message<B> | undefined,
): "steer" | undefined {
  if (!message || message.role !== "user") return undefined;
  if (message.intent === "steer") return "steer";
  if (message.id === "codex-optimistic-user-steer") return "steer";
  if (message.id?.startsWith("codex-optimistic-user-steer-")) return "steer";
  return undefined;
}

function hasSteeringEligibleWork<B extends MessageBlock, M extends Message<B>>(
  entries: readonly VisualWorkEntry<B, M>[],
): boolean {
  return entries.some(
    (entry) =>
      entry.message.role !== "user" &&
      entry.blocks.some((block) => block.type !== "marker"),
  );
}

function entryTerminalMarkerKind<B extends MessageBlock, M extends Message<B>>(
  entry: VisualWorkEntry<B, M>,
): VisualMarkerKind | undefined {
  const kind = visualMarkerKind(visualMarkerBlock(entry)?.text);
  return kind === "aborted" || kind === "failed" || kind === "complete"
    ? kind
    : undefined;
}

function terminalMarkerContinuesLater<
  B extends MessageBlock,
  M extends Message<B>,
>(
  entries: readonly VisualWorkEntry<B, M>[],
  markerEntry: VisualWorkEntry<B, M>,
): boolean {
  const markerIndex = entries.indexOf(markerEntry);
  if (markerIndex < 0 || !entryTerminalMarkerKind(markerEntry)) return false;
  return entries
    .slice(markerIndex + 1)
    .some((entry) => userMessageIntent(entry.message) === "steer");
}

function terminalMarkerForMergedWork<
  B extends MessageBlock,
  M extends Message<B>,
>(
  entries: readonly VisualWorkEntry<B, M>[],
): Pick<
  Extract<VisualTranscriptItem<B, M>, { kind: "work" }>,
  "terminalMarkerKind" | "terminalMarkerLabel"
> {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const kind = entryTerminalMarkerKind(entry);
    if (!kind) continue;
    if (terminalMarkerContinuesLater(entries, entry)) continue;
    return {
      terminalMarkerKind: kind,
      terminalMarkerLabel: visualMarkerLabel(visualMarkerBlock(entry)?.text),
    };
  }
  return {};
}

function isBoundaryMarkerOnlyWork<B extends MessageBlock, M extends Message<B>>(
  entries: readonly VisualWorkEntry<B, M>[],
): boolean {
  return (
    entries.length > 0 &&
    entries.every((entry) =>
      entry.blocks.every((block) => {
        if (block.type !== "marker") return false;
        const kind = visualMarkerKind(block.text);
        return kind === "started" || kind === "complete";
      }),
    )
  );
}

function withUserMessageIntent<B extends MessageBlock, M extends Message<B>>(
  message: M,
  intent: "steer" | undefined,
): M {
  if (!intent || message.intent === intent) return message;
  return { ...message, intent } as M;
}

function coalesceAdjacentVisualWorkItems<
  B extends MessageBlock,
  M extends Message<B>,
>(items: VisualTranscriptItem<B, M>[]): VisualTranscriptItem<B, M>[] {
  const out: VisualTranscriptItem<B, M>[] = [];
  for (const item of items) {
    const previous = out[out.length - 1];
    if (item.kind === "work" && previous?.kind === "work") {
      const entries = [...previous.entries, ...item.entries];
      const terminalMarker = terminalMarkerForMergedWork(entries);
      out[out.length - 1] = {
        kind: "work",
        entries,
        startedAt: previous.startedAt ?? item.startedAt,
        endedAt: item.endedAt ?? previous.endedAt,
        open: item.open,
        ...terminalMarker,
      };
      continue;
    }
    out.push(item);
  }
  return out;
}

function userMessageFingerprint<B extends MessageBlock>(
  message: Message<B>,
): string {
  return message.blocks
    .map((block) => {
      if (block.type === "text") {
        return `text:${cleanVisualUserText(block.text)}`;
      }
      const anyBlock = block as B & {
        path?: string;
        url?: string;
        mediaKind?: string;
      };
      if (block.type === "media") {
        return [
          "media",
          anyBlock.mediaKind ?? "",
          anyBlock.path || anyBlock.url || "",
        ].join(":");
      }
      return `${block.type}:${block.text ?? ""}`;
    })
    .join("\n");
}

function sameUserMessageContent<B extends MessageBlock>(
  a: Message<B>,
  b: Message<B>,
): boolean {
  return (
    a.role === "user" &&
    b.role === "user" &&
    userMessageFingerprint(a) === userMessageFingerprint(b)
  );
}

export function withoutDuplicateOptimisticUserMessages<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[]): M[] {
  const out: M[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (
      previous &&
      sameUserMessageContent(previous, message) &&
      (isOptimisticUserMessage(previous) || isOptimisticUserMessage(message))
    ) {
      if (
        isOptimisticUserMessage(previous) &&
        !isOptimisticUserMessage(message)
      ) {
        out[out.length - 1] = withUserMessageIntent(
          message,
          userMessageIntent(previous),
        );
      } else if (
        !isOptimisticUserMessage(previous) &&
        isOptimisticUserMessage(message)
      ) {
        out[out.length - 1] = withUserMessageIntent(
          previous,
          userMessageIntent(message),
        );
      }
      continue;
    }
    out.push(message);
  }
  return out;
}

export function withOptimisticUserMessageIntent<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[], overlays: readonly Message<B>[]): M[] {
  if (overlays.length === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "user" || isOptimisticUserMessage(message)) {
      return message;
    }
    const optimistic = overlays.find(
      (overlay) =>
        isOptimisticUserMessage(overlay) &&
        userMessageIntent(overlay) &&
        sameUserMessageContent(message, overlay),
    );
    return withUserMessageIntent(message, userMessageIntent(optimistic));
  });
}

export function hasCanonicalUserMessageMatchingOptimistic<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[], optimistic: Message<B>): boolean {
  if (!isOptimisticUserMessage(optimistic)) return false;
  return messages.some(
    (message) =>
      !isOptimisticUserMessage(message) &&
      sameUserMessageContent(message, optimistic),
  );
}

export function mergeVisualSessionMessages<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[], overlays: readonly M[]): M[] {
  if (overlays.length === 0) return messages as M[];
  const messagesWithIntent = withOptimisticUserMessageIntent(
    messages,
    overlays,
  );
  if (overlays.length === 0)
    return withoutDuplicateOptimisticUserMessages(messagesWithIntent);
  const pendingOverlays = overlays.filter(
    (overlay) =>
      !hasCanonicalUserMessageMatchingOptimistic(messagesWithIntent, overlay),
  );
  if (pendingOverlays.length === 0) {
    return withoutDuplicateOptimisticUserMessages(messagesWithIntent);
  }
  const overlaysByAnchor = new Map<number, M[]>();
  for (const overlay of pendingOverlays) {
    const anchor = optimisticInsertionIndex(messagesWithIntent, overlay);
    const list = overlaysByAnchor.get(anchor) ?? [];
    list.push(overlay);
    overlaysByAnchor.set(anchor, list);
  }
  const merged: M[] = [];
  const beforeFirst = overlaysByAnchor.get(-1);
  if (beforeFirst) merged.push(...beforeFirst);
  messagesWithIntent.forEach((message, index) => {
    merged.push(message);
    const anchored = overlaysByAnchor.get(index);
    if (anchored) merged.push(...anchored);
  });
  return withoutDuplicateOptimisticUserMessages(merged);
}

function visualTranscriptTailBlockKey(block: MessageBlock): string {
  const media = block as MessageBlock & { path?: string; url?: string };
  return [
    block.type,
    block.toolUseId ?? "",
    block.toolName ?? "",
    block.text?.length ?? 0,
    media.path ?? media.url ?? "",
    block.planItems
      ?.map((item) => `${item.status}:${item.step.length}`)
      .join(",") ?? "",
  ].join(":");
}

/** A bounded signature for scroll-tail decisions. Historical rows cannot
 * affect whether a new tail update should follow, so never walk the full
 * transcript here. */
export function visualTranscriptTailKey<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[]): string {
  const tail = messages.slice(-4);
  return `${messages.length}|${tail
    .map((message) =>
      [
        message.id ?? "",
        message.role,
        message.timestamp ?? "",
        message.blocks.map(visualTranscriptTailBlockKey).join(","),
      ].join("#"),
    )
    .join("|")}`;
}

function optimisticInsertionIndex<B extends MessageBlock, M extends Message<B>>(
  messages: readonly M[],
  overlay: M,
): number {
  if (typeof overlay.optimisticAfterMessageId === "string") {
    const byId = messages.findIndex(
      (message) => message.id === overlay.optimisticAfterMessageId,
    );
    if (byId >= 0) return byId;
  }
  if (
    typeof overlay.optimisticAfterMessageIndex === "number" &&
    Number.isFinite(overlay.optimisticAfterMessageIndex)
  ) {
    return Math.max(
      -1,
      Math.min(
        messages.length - 1,
        Math.trunc(overlay.optimisticAfterMessageIndex),
      ),
    );
  }
  return messages.length - 1;
}

export function applyVisualTranscriptDeltaPatches<
  B extends MessageBlock,
  M extends Message<B>,
>(
  messages: readonly M[],
  patches: readonly VisualTranscriptDeltaPatch<B>[],
): M[] {
  if (patches.length === 0) return [...messages];
  const out = [...messages];
  const indexById = new Map<string, number>();
  out.forEach((message, index) => {
    if (message.id) indexById.set(message.id, index);
  });

  for (const patch of patches) {
    if (!patch.delta) continue;
    const blockFields = (patch.blockFields ?? {}) as Partial<B>;
    const existingIndex = indexById.get(patch.id);
    if (existingIndex === undefined) {
      const text =
        patch.maxTextChars === undefined
          ? patch.delta
          : boundedVisualDeltaText(patch.delta, patch.maxTextChars);
      const block = {
        ...blockFields,
        type: patch.type,
        text,
      } as B;
      const message = {
        id: patch.id,
        role: patch.role,
        timestamp: patch.timestamp,
        blocks: [block],
      } as M;
      indexById.set(patch.id, out.length);
      out.push(message);
      continue;
    }

    const message = out[existingIndex];
    if (!message) continue;
    const current = message.blocks[0];
    const base: B =
      current && current.type === patch.type
        ? current
        : ({ ...blockFields, type: patch.type, text: "" } as B);
    const appendedText = (base.text ?? "") + patch.delta;
    const block = {
      ...base,
      ...(!base.toolName && blockFields.toolName
        ? { toolName: blockFields.toolName }
        : {}),
      ...(!base.toolUseId && blockFields.toolUseId
        ? { toolUseId: blockFields.toolUseId }
        : {}),
      text:
        patch.maxTextChars === undefined
          ? appendedText
          : boundedVisualDeltaText(appendedText, patch.maxTextChars),
    } as B;
    out[existingIndex] = { ...message, blocks: [block] } as M;
  }

  return out;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageKey<B extends MessageBlock, M extends Message<B>>(
  message: M,
  messageIndex: number,
): string {
  return [
    message.id ?? "",
    messageIndex,
    message.role,
    message.timestamp ?? "",
  ].join(":");
}

function blockSignature(block: MessageBlock): string {
  const planKey =
    block.planItems?.map((item) => `${item.status}:${item.step}`).join("\n") ??
    "";
  return [
    block.type,
    block.text ?? "",
    block.toolUseId ?? "",
    block.toolName ?? "",
    stableJson(block.toolInput),
    block.explanation ?? "",
    planKey,
  ].join("\u0000");
}

function entrySignature<B extends MessageBlock, M extends Message<B>>(
  entry: VisualWorkEntry<B, M>,
): string {
  return [
    getVisualWorkEntryKey(entry),
    entry.blocks.map(blockSignature).join("\u0001"),
  ].join("\u0002");
}

function itemSignature<B extends MessageBlock, M extends Message<B>>(
  item: VisualTranscriptItem<B, M>,
): string {
  if (item.kind === "message") {
    return [
      getVisualTranscriptItemKey(item, item.messageIndex),
      item.blocks.map(blockSignature).join("\u0001"),
    ].join("\u0002");
  }
  if (item.kind === "marker") {
    return [
      getVisualTranscriptItemKey(item),
      blockSignature(item.markerBlock),
      item.markerKind,
      item.markerLabel,
    ].join("\u0002");
  }
  return [
    getVisualTranscriptItemKey(item),
    item.startedAt ?? "",
    item.endedAt ?? "",
    item.open === true ? "open" : "closed",
    item.terminalMarkerKind ?? "",
    item.terminalMarkerLabel ?? "",
    item.entries.map(entrySignature).join("\u0003"),
  ].join("\u0002");
}

function sameBlockReferences<B extends MessageBlock>(
  a: readonly B[],
  b: readonly B[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameEntryReferences<B extends MessageBlock, M extends Message<B>>(
  a: VisualWorkEntry<B, M>,
  b: VisualWorkEntry<B, M>,
): boolean {
  return (
    a.message === b.message &&
    a.messageIndex === b.messageIndex &&
    sameBlockReferences(a.blocks, b.blocks)
  );
}

function sameItemReferences<B extends MessageBlock, M extends Message<B>>(
  a: VisualTranscriptItem<B, M>,
  b: VisualTranscriptItem<B, M>,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "message" && b.kind === "message") {
    return (
      a.message === b.message &&
      a.messageIndex === b.messageIndex &&
      sameBlockReferences(a.blocks, b.blocks)
    );
  }
  if (a.kind === "marker" && b.kind === "marker") {
    return (
      sameEntryReferences(a.entry, b.entry) &&
      a.markerBlock === b.markerBlock &&
      a.markerKind === b.markerKind &&
      a.markerLabel === b.markerLabel
    );
  }
  if (a.kind !== "work" || b.kind !== "work") return false;
  if (
    a.startedAt !== b.startedAt ||
    a.endedAt !== b.endedAt ||
    a.open !== b.open ||
    a.terminalMarkerKind !== b.terminalMarkerKind ||
    a.terminalMarkerLabel !== b.terminalMarkerLabel ||
    a.entries.length !== b.entries.length
  ) {
    return false;
  }
  for (let i = 0; i < a.entries.length; i += 1) {
    if (!sameEntryReferences(a.entries[i]!, b.entries[i]!)) return false;
  }
  return true;
}

export function getVisualWorkEntryKey<
  B extends MessageBlock,
  M extends Message<B>,
>(entry: VisualWorkEntry<B, M>): string {
  return `entry:${messageKey(entry.message, entry.messageIndex)}`;
}

export function getVisualTranscriptItemKey<
  B extends MessageBlock,
  M extends Message<B>,
>(item: VisualTranscriptItem<B, M>, fallbackIndex = 0): string {
  if (item.kind === "message") {
    return `message:${messageKey(item.message, item.messageIndex)}`;
  }
  if (item.kind === "marker") {
    return [
      "marker",
      getVisualWorkEntryKey(item.entry),
      item.markerKind,
      item.markerLabel,
    ].join(":");
  }
  const first = item.entries[0];
  return [
    "work",
    item.startedAt ?? "",
    first ? getVisualWorkEntryKey(first) : `empty:${fallbackIndex}`,
  ].join(":");
}

export function getVisualWorkDisplayEntryKey<
  B extends MessageBlock,
  M extends Message<B>,
>(displayEntry: VisualWorkDisplayEntry<B, M>): string {
  const resultKey = displayEntry.pairedResult
    ? getVisualWorkEntryKey(displayEntry.pairedResult)
    : "";
  const resultKeys = displayEntry.pairedResults
    ?.map(getVisualWorkEntryKey)
    .join(",");
  const toolUseKey = displayEntry.pairedToolUse
    ? getVisualWorkEntryKey(displayEntry.pairedToolUse)
    : "";
  return [
    displayEntry.kind,
    getVisualWorkEntryKey(displayEntry.entry),
    resultKeys ?? resultKey,
    toolUseKey,
  ].join(":");
}

export function reuseStableVisualTranscriptItems<
  B extends MessageBlock,
  M extends Message<B>,
>(
  previous: readonly VisualTranscriptItem<B, M>[],
  next: readonly VisualTranscriptItem<B, M>[],
): VisualTranscriptItem<B, M>[] {
  if (previous.length === 0) return [...next];
  const previousByKey = new Map<string, VisualTranscriptItem<B, M>>();
  previous.forEach((item, index) => {
    previousByKey.set(getVisualTranscriptItemKey(item, index), item);
  });

  return next.map((item, index) => {
    const key = getVisualTranscriptItemKey(item, index);
    const previousItem = previousByKey.get(key);
    if (!previousItem) return item;
    if (sameItemReferences(previousItem, item)) return previousItem;
    if (itemSignature(previousItem) === itemSignature(item)) {
      return previousItem;
    }
    if (item.kind !== "work" || previousItem.kind !== "work") {
      return item;
    }

    const previousEntriesByKey = new Map<string, VisualWorkEntry<B, M>>();
    previousItem.entries.forEach((entry) => {
      previousEntriesByKey.set(getVisualWorkEntryKey(entry), entry);
    });
    let reusedAny = false;
    const entries = item.entries.map((entry) => {
      const previousEntry = previousEntriesByKey.get(
        getVisualWorkEntryKey(entry),
      );
      if (
        previousEntry &&
        (sameEntryReferences(previousEntry, entry) ||
          entrySignature(previousEntry) === entrySignature(entry))
      ) {
        reusedAny = true;
        return previousEntry;
      }
      return entry;
    });
    return reusedAny ? { ...item, entries } : item;
  });
}

export function buildVisualTranscriptItems<
  B extends MessageBlock,
  M extends Message<B>,
>(
  messages: readonly M[],
  opts: { active?: boolean; messageIndexOffset?: number } = {},
): VisualTranscriptItem<B, M>[] {
  const out: VisualTranscriptItem<B, M>[] = [];
  let messageIndex = 0;
  let pendingTurnPrefixEntries: VisualWorkEntry<B, M>[] = [];
  let pendingTurnStartedAt: string | undefined;
  let previousTurnAcceptsSteering: boolean = false;
  const messageIndexOffset = opts.messageIndexOffset ?? 0;

  function displayBlocks(message: M | undefined): B[] {
    const blocks = ((message?.blocks ?? []) as B[]).filter(
      (block) => block.type !== "goal",
    );
    return isAssistantRoleLabelOnlyBlocks(message, blocks) ? [] : blocks;
  }

  function isTokenOnlyUsageMessage(message: M | undefined): boolean {
    return (
      message?.role === "assistant" &&
      (hasReportedTokenUsage(message) ||
        (typeof message.tokensUsed === "number" &&
          Number.isFinite(message.tokensUsed) &&
          message.tokensUsed > 0)) &&
      displayBlocks(message).length === 0
    );
  }

  function hasReportedTokenUsage(message: M | undefined): boolean {
    const usage = message?.tokenUsage;
    return (
      !!usage &&
      typeof usage.total === "number" &&
      Number.isFinite(usage.total) &&
      usage.total > 0
    );
  }

  function pushMessage(entry: VisualWorkEntry<B, M>): void {
    out.push({
      kind: "message",
      message: entry.message,
      blocks: entry.blocks,
      messageIndex: entry.messageIndex,
    });
  }

  function pushMarker(entry: VisualWorkEntry<B, M>): boolean {
    const marker = compactionMarkerEntry(entry);
    if (!marker) return false;
    out.push(marker);
    return true;
  }

  function nextDisplayMessageRole(startIndex: number): string | undefined {
    for (let i = startIndex; i < messages.length; i += 1) {
      const next = messages[i];
      if (!next || displayBlocks(next).length === 0) continue;
      return next.role;
    }
    return undefined;
  }

  function nextDisplayUserMessage(startIndex: number): M | undefined {
    for (let i = startIndex; i < messages.length; i += 1) {
      const next = messages[i];
      if (!next || displayBlocks(next).length === 0) continue;
      if (next.role === "user") return next;
    }
    return undefined;
  }

  function nextDisplayUserIntent(startIndex: number): "steer" | undefined {
    return userMessageIntent(nextDisplayUserMessage(startIndex));
  }

  function hasExplicitSteerIntent(message: M | undefined): boolean {
    if (!message || message.role !== "user") return false;
    return userMessageIntent(message) === "steer";
  }

  function pushTurnWorkAndResponse(
    rawEntries: VisualWorkEntry<B, M>[],
    userTimestamp: string | undefined,
    active: boolean,
    nextUserTimestamp?: string,
    forceWorkUntilTerminal: boolean = false,
  ): void {
    let entries: VisualWorkEntry<B, M>[] = [];
    let segmentStartedAt = userTimestamp;
    let lastCompactionMs: number | undefined;
    let forceWorkSegment = forceWorkUntilTerminal;

    for (const entry of rawEntries) {
      const markerBlock = visualMarkerBlock(entry);
      const markerKind = visualMarkerKind(markerBlock?.text);
      if (isTerminalVisualMarkerKind(markerKind)) {
        entries.push(entry);
        if (terminalMarkerContinuesLater(rawEntries, entry)) continue;
        pushWorkAndResponse(
          entries,
          segmentStartedAt,
          false,
          entry.message.timestamp,
          forceWorkSegment,
        );
        entries = [];
        segmentStartedAt = entry.message.timestamp;
        forceWorkSegment = false;
        continue;
      }
      if (markerKind !== "compacted") {
        entries.push(entry);
        continue;
      }
      const markerMs = timestampMs(entry.message.timestamp);
      if (
        markerMs !== undefined &&
        lastCompactionMs !== undefined &&
        Math.abs(markerMs - lastCompactionMs) < 1000
      ) {
        continue;
      }
      lastCompactionMs = markerMs;
      entries.push(entry);
    }

    pushWorkAndResponse(
      entries,
      segmentStartedAt,
      active,
      active ? undefined : nextUserTimestamp,
      forceWorkSegment,
    );
  }

  function pushWorkAndResponse(
    entries: VisualWorkEntry<B, M>[],
    userTimestamp: string | undefined,
    active: boolean,
    forcedEndedAt?: string,
    forceWorkOnly: boolean = false,
  ): void {
    const terminalMarker = terminalWorkMarker(entries);
    const hasResponse = entries.some(isAssistantResponseEntry);
    if (active || forceWorkOnly || !hasResponse) {
      if (entries.length > 0) {
        if (isBoundaryMarkerOnlyWork(entries)) return;
        const firstWorkTs = entries.find((entry) =>
          timestampMs(entry.message.timestamp),
        )?.message.timestamp;
        const shouldKeepOpen =
          !forcedEndedAt || hasTurnMarker(entries, "complete");
        out.push({
          kind: "work",
          entries,
          startedAt: userTimestamp ?? firstWorkTs,
          endedAt: forcedEndedAt,
          open: shouldKeepOpen ? true : undefined,
          ...terminalMarker,
        });
      }
      return;
    }

    const finalResponseIndex = entries.findLastIndex((entry) =>
      isAssistantResponseEntry(entry),
    );
    const finalResponse = entries[finalResponseIndex]!;
    const workEntries: VisualWorkEntry<B, M>[] = [];
    entries.forEach((entry, entryIndex) => {
      const blocks =
        entryIndex === finalResponseIndex
          ? entry.blocks.filter((block) => !isResponseBlock(block))
          : entry.blocks;
      if (blocks.length > 0 || isTokenOnlyUsageMessage(entry.message)) {
        workEntries.push({ ...entry, blocks });
      }
    });
    const responseBlocks = finalResponse.blocks.filter(isResponseBlock);
    const generatedMediaBlocks = generatedMediaBlocksForFinalResponse(
      workEntries,
      responseBlocks,
    );

    if (workEntries.length > 0) {
      if (isBoundaryMarkerOnlyWork(workEntries)) {
        out.push({
          kind: "message",
          message: finalResponse.message,
          blocks: [...generatedMediaBlocks, ...responseBlocks],
          messageIndex: finalResponse.messageIndex,
        });
        return;
      }
      const firstWorkTs = workEntries.find((entry) =>
        timestampMs(entry.message.timestamp),
      )?.message.timestamp;
      out.push({
        kind: "work",
        entries: workEntries,
        startedAt: userTimestamp ?? firstWorkTs,
        endedAt: forcedEndedAt ?? finalResponse.message.timestamp,
        ...terminalWorkMarker(workEntries),
      });
    }

    out.push({
      kind: "message",
      message: finalResponse.message,
      blocks: [...generatedMediaBlocks, ...responseBlocks],
      messageIndex: finalResponse.messageIndex,
    });
  }

  while (messageIndex < messages.length) {
    const message = messages[messageIndex]!;
    const absoluteMessageIndex = messageIndex + messageIndexOffset;
    const blocks = displayBlocks(message);
    if (blocks.length === 0) {
      messageIndex += 1;
      continue;
    }
    if (message.role !== "user") {
      const entry = {
        message,
        blocks,
        messageIndex: absoluteMessageIndex,
      };
      const markerBlock = blocks.find((block) => block.type === "marker");
      if (
        markerBlock &&
        visualMarkerKind(markerBlock.text) === "started" &&
        nextDisplayMessageRole(messageIndex + 1) === "user"
      ) {
        pendingTurnPrefixEntries.push(entry);
        messageIndex += 1;
        continue;
      }
      if (nextDisplayUserIntent(messageIndex + 1) === "steer") {
        pendingTurnPrefixEntries.push(entry);
        messageIndex += 1;
        continue;
      }
      if (
        previousTurnAcceptsSteering &&
        hasExplicitSteerIntent(nextDisplayUserMessage(messageIndex + 1))
      ) {
        pendingTurnPrefixEntries.push(entry);
        messageIndex += 1;
        continue;
      }
      const pushedMarker = pushMarker(entry);
      if (!pushedMarker)
        pushMessage({ message, blocks, messageIndex: absoluteMessageIndex });
      messageIndex += 1;
      continue;
    }

    const explicitSteer = userMessageIntent(message) === "steer";
    const turnWasAlreadyOpen: boolean =
      explicitSteer ||
      (previousTurnAcceptsSteering && hasExplicitSteerIntent(message));
    const messageForDisplay = withUserMessageIntent(
      message,
      explicitSteer || turnWasAlreadyOpen ? "steer" : undefined,
    );
    if (!turnWasAlreadyOpen) {
      out.push({
        kind: "message",
        message: messageForDisplay,
        blocks,
        messageIndex: absoluteMessageIndex,
      });
    }
    previousTurnAcceptsSteering = false;
    const userTimestamp = message.timestamp;
    const turnStartedAt = pendingTurnStartedAt ?? userTimestamp;
    const turnEntries: VisualWorkEntry<B, M>[] = turnWasAlreadyOpen
      ? [
          ...pendingTurnPrefixEntries,
          {
            message: messageForDisplay,
            blocks,
            messageIndex: absoluteMessageIndex,
          },
        ]
      : pendingTurnPrefixEntries;
    pendingTurnPrefixEntries = [];
    pendingTurnStartedAt = undefined;
    messageIndex += 1;
    while (
      messageIndex < messages.length &&
      messages[messageIndex]?.role !== "user"
    ) {
      const turnMessage = messages[messageIndex]!;
      const turnBlocks = displayBlocks(turnMessage);
      if (turnBlocks.length === 0) {
        if (isTokenOnlyUsageMessage(turnMessage)) {
          turnEntries.push({
            message: turnMessage,
            blocks: [],
            messageIndex: messageIndex + messageIndexOffset,
          });
        }
        messageIndex += 1;
        continue;
      }
      const markerBlock = turnBlocks.find((block) => block.type === "marker");
      if (
        markerBlock &&
        visualMarkerKind(markerBlock.text) === "started" &&
        nextDisplayMessageRole(messageIndex + 1) === "user"
      ) {
        pendingTurnPrefixEntries = [
          {
            message: turnMessage,
            blocks: turnBlocks,
            messageIndex: messageIndex + messageIndexOffset,
          },
        ];
        messageIndex += 1;
        break;
      }
      turnEntries.push({
        message: turnMessage,
        blocks: turnBlocks,
        messageIndex: messageIndex + messageIndexOffset,
      });
      messageIndex += 1;
    }
    const turnStillOpen: boolean =
      ((turnWasAlreadyOpen || hasTurnMarker(turnEntries, "started")) &&
        !hasTurnMarker(turnEntries, "complete") &&
        !hasTurnMarker(turnEntries, "aborted")) ||
      (nextDisplayUserIntent(messageIndex) === "steer" &&
        hasTurnMarker(turnEntries, "started"));
    const acceptsSteering: boolean =
      turnStillOpen &&
      (turnWasAlreadyOpen || hasSteeringEligibleWork(turnEntries));
    if (
      acceptsSteering &&
      messages[messageIndex]?.role === "user" &&
      hasExplicitSteerIntent(messages[messageIndex])
    ) {
      pendingTurnPrefixEntries = turnEntries;
      pendingTurnStartedAt = turnStartedAt;
      previousTurnAcceptsSteering = true;
      continue;
    }
    pushTurnWorkAndResponse(
      turnEntries,
      turnStartedAt,
      opts.active === true && messageIndex >= messages.length,
      messages[messageIndex]?.timestamp,
      turnWasAlreadyOpen,
    );
    previousTurnAcceptsSteering = false;
  }

  return coalesceAdjacentVisualWorkItems(out);
}

export interface VisualTranscriptMessageWindow<
  M extends Message<MessageBlock>,
> {
  messages: M[];
  messageIndexOffset: number;
  hiddenMessageCount: number;
  totalMessageCount: number;
}

export function visualTranscriptMessageWindow<
  B extends MessageBlock,
  M extends Message<B>,
>(
  messages: readonly M[],
  opts: { minMessages: number; minUserTurns?: number },
): VisualTranscriptMessageWindow<M> {
  const totalMessageCount = messages.length;
  const minMessages = Math.max(1, Math.trunc(opts.minMessages) || 1);
  if (totalMessageCount <= minMessages) {
    return {
      messages: [...messages],
      messageIndexOffset: 0,
      hiddenMessageCount: 0,
      totalMessageCount,
    };
  }

  let start = Math.max(0, totalMessageCount - minMessages);
  for (let index = start; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      start = index;
      break;
    }
  }

  const minUserTurns = Math.max(0, Math.trunc(opts.minUserTurns ?? 2) || 0);
  if (minUserTurns > 0) {
    let seenUserTurns = 0;
    for (let index = totalMessageCount - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "user") continue;
      seenUserTurns += 1;
      if (seenUserTurns >= minUserTurns) {
        start = Math.min(start, index);
        break;
      }
    }
  }

  return {
    messages: messages.slice(start),
    messageIndexOffset: start,
    hiddenMessageCount: start,
    totalMessageCount,
  };
}

function commonMessagePrefixLength<
  B extends MessageBlock,
  M extends Message<B>,
>(a: readonly M[], b: readonly M[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function hintedCommonMessagePrefixLength<
  B extends MessageBlock,
  M extends Message<B>,
>(
  a: readonly M[],
  b: readonly M[],
  changeStartHint: number | undefined,
): number | undefined {
  if (changeStartHint === undefined || !Number.isFinite(changeStartHint)) {
    return undefined;
  }
  const index = Math.max(
    0,
    Math.min(Math.trunc(changeStartHint), a.length, b.length),
  );
  if (index === 0) return 0;
  if (a[0] !== b[0]) return undefined;
  if (a[index - 1] !== b[index - 1]) return undefined;
  return index;
}

function lastUserMessageIndexAtOrBefore<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[], index: number): number {
  for (let i = Math.min(index, messages.length - 1); i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return 0;
}

function itemIsBeforeMessageIndex<B extends MessageBlock, M extends Message<B>>(
  item: VisualTranscriptItem<B, M>,
  messageIndex: number,
): boolean {
  if (item.kind === "message") return item.messageIndex < messageIndex;
  if (item.kind === "marker") return item.entry.messageIndex < messageIndex;
  return item.entries.every((entry) => entry.messageIndex < messageIndex);
}

export function updateVisualTranscriptItems<
  B extends MessageBlock,
  M extends Message<B>,
>(opts: {
  previousMessages: readonly M[];
  previousItems: readonly VisualTranscriptItem<B, M>[];
  previousActive?: boolean;
  messages: readonly M[];
  active?: boolean;
  changeStartHint?: number;
  messageIndexOffset?: number;
}): VisualTranscriptItem<B, M>[] {
  const messageIndexOffset = Math.max(
    0,
    Math.trunc(opts.messageIndexOffset ?? 0),
  );
  if (opts.previousItems.length === 0) {
    return buildVisualTranscriptItems(opts.messages, {
      active: opts.active,
      messageIndexOffset,
    });
  }
  if (opts.previousActive !== opts.active) {
    return reuseStableVisualTranscriptItems(
      opts.previousItems,
      buildVisualTranscriptItems(opts.messages, {
        active: opts.active,
        messageIndexOffset,
      }),
    );
  }

  const commonPrefix =
    hintedCommonMessagePrefixLength(
      opts.previousMessages,
      opts.messages,
      opts.changeStartHint,
    ) ?? commonMessagePrefixLength(opts.previousMessages, opts.messages);
  const appendOrTailUpdate =
    commonPrefix > 0 &&
    commonPrefix <= opts.messages.length &&
    commonPrefix >= opts.previousMessages.length - 1;
  if (!appendOrTailUpdate) {
    return reuseStableVisualTranscriptItems(
      opts.previousItems,
      buildVisualTranscriptItems(opts.messages, {
        active: opts.active,
        messageIndexOffset,
      }),
    );
  }

  const appendedUser =
    commonPrefix === opts.previousMessages.length &&
    opts.messages[commonPrefix]?.role === "user";
  const previousTail = opts.previousItems[opts.previousItems.length - 1];
  const previousTailIsOpenWork =
    previousTail?.kind === "work" && previousTail.open === true;
  const rebuildStart =
    appendedUser && !previousTailIsOpenWork && opts.active !== true
      ? commonPrefix
      : lastUserMessageIndexAtOrBefore(
          opts.messages,
          Math.max(0, commonPrefix - 1),
        );
  const absoluteRebuildStart = rebuildStart + messageIndexOffset;
  const prefixItems = opts.previousItems.filter((item) =>
    itemIsBeforeMessageIndex(item, absoluteRebuildStart),
  );
  const tailItems = buildVisualTranscriptItems<B, M>(
    opts.messages.slice(rebuildStart),
    {
      active: opts.active,
      messageIndexOffset: absoluteRebuildStart,
    },
  );

  return reuseStableVisualTranscriptItems(opts.previousItems, [
    ...prefixItems,
    ...tailItems,
  ]);
}
