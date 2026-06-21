export interface MessageBlock {
  type: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  explanation?: string;
  planItems?: VisualPlanItem[];
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

export interface Message<B extends MessageBlock = MessageBlock> {
  role: string;
  blocks: B[];
  timestamp?: string;
  id?: string;
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
      kind: "work";
      entries: VisualWorkEntry<B, M>[];
      startedAt?: string;
      endedAt?: string;
      open?: boolean;
    };

export type VisualMarkerKind =
  | "complete"
  | "started"
  | "compacted"
  | "aborted"
  | "other";

export interface VisualWorkDisplayEntry<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> {
  kind: "entry" | "marker";
  entry: VisualWorkEntry<B, M>;
  pairedResult?: VisualWorkEntry<B, M>;
  markerBlock?: B;
  markerKind?: VisualMarkerKind;
  markerLabel?: string;
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
  const inProgress = items.filter((item) => item.status === "in_progress").length;
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
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const plan = visualPlanFromBlock(message.blocks[blockIndex]);
      if (plan) return plan;
    }
  }
  return undefined;
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
  return text
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
  return Array.from(
    text.matchAll(CODEX_IMAGE_ENVELOPE_RE),
    (match) => {
      const attrs = codexImageEnvelopeAttrs(match[0] ?? "");
      return {
        label: codexImageEnvelopeLabel(attrs.name),
        path: attrs.path ?? attrs.file_path ?? attrs.src ?? attrs.url ?? "",
      };
    },
  ).filter((attachment) => attachment.path.trim().length > 0);
}

export interface VisualToolResultText {
  title: string;
  body: string;
  wrappedCodexChunk: boolean;
  wallTimeSeconds?: number;
  exitCode?: number;
  originalTokenCount?: number;
}

function cleanThinkingTitle(text: string): string {
  return text
    .trim()
    .replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)$/s, "$1")
    .replace(/^(?:\*|_)(.*?)(?:\*|_)$/s, "$1")
    .trim();
}

export function visualThinkingSummary(text: string | undefined): {
  title: string;
  body: string;
} {
  const raw = (text ?? "").replace(/\r\n/g, "\n").trim();
  const cleaned = raw
    .replace(/^thinking(?:\s*[:—–-]\s*|\s+)/i, "")
    .trim();
  if (!cleaned) return { title: "", body: "" };
  const [firstLine = "", ...rest] = cleaned.split("\n");
  const title = cleanThinkingTitle(firstLine);
  const body = rest.join("\n").trim();
  if (title && body && title.length <= 96) return { title, body };
  return { title: "", body: cleaned };
}

export function cleanVisualToolResultText(
  text: string | undefined,
): VisualToolResultText {
  const raw = text ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      title: "Tool result",
      body: "",
      wrappedCodexChunk: false,
    };
  }

  const codexChunk = trimmed.match(
    /^Chunk ID:\s+\S+\s+Wall time:\s+([\d.]+)\s+seconds\s+Process exited with code\s+(-?\d+)(?:\s+Original token count:\s+(\d+))?\s+Output:\s*([\s\S]*)$/i,
  );
  const plainCommandResult = trimmed.match(
    /^Exit code:\s+(-?\d+)\s+Wall time:\s+([\d.]+)\s+seconds?\s+Output:\s*([\s\S]*)$/i,
  );
  if (!codexChunk && !plainCommandResult) {
    return {
      title: "Tool result",
      body: trimmed,
      wrappedCodexChunk: false,
    };
  }

  const exitCode = codexChunk?.[2] ?? plainCommandResult?.[1] ?? "0";
  const parsedExitCode = Number.parseInt(exitCode, 10);
  const wallTimeSeconds = Number(codexChunk?.[1] ?? plainCommandResult?.[2]);
  const output = (codexChunk?.[4] ?? plainCommandResult?.[3] ?? "").trim();
  const title = output
    ? "Command output"
    : parsedExitCode === 0
      ? "Command completed"
      : "Command failed";
  return {
    title,
    body: output,
    wrappedCodexChunk: true,
    wallTimeSeconds: Number.isFinite(wallTimeSeconds)
      ? wallTimeSeconds
      : undefined,
    exitCode: parsedExitCode,
    originalTokenCount: codexChunk?.[3]
      ? Number.parseInt(codexChunk[3], 10)
      : undefined,
  };
}

function hasBlockType(entry: VisualWorkEntry | undefined, type: string): boolean {
  return !!entry && entry.blocks.some((block) => block.type === type);
}

function blockToolUseIds(entry: VisualWorkEntry | undefined): string[] {
  if (!entry) return [];
  return entry.blocks
    .map((block) => block.toolUseId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function firstToolUseName(entry: VisualWorkEntry | undefined): string | undefined {
  return entry?.blocks.find(
    (block) =>
      block.type === "tool_use" &&
      typeof block.toolName === "string" &&
      block.toolName.length > 0,
  )?.toolName;
}

function withToolResultName<
  B extends MessageBlock,
  M extends Message<B>,
>(
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
  if (/(?:codex\s+)?task complete/i.test(cleaned)) return "Task complete";
  if (/(?:codex\s+)?task started/i.test(cleaned)) return "Task started";
  if (/(?:codex\s+)?context compacted/i.test(cleaned)) return "Context compacted";
  if (/(?:codex\s+)?turn aborted/i.test(cleaned)) return "Turn aborted";
  return cleaned || "Marker";
}

export function visualMarkerKind(text: string | undefined): VisualMarkerKind {
  const cleaned = text ?? "";
  if (/(?:codex\s+)?task complete/i.test(cleaned)) return "complete";
  if (/(?:codex\s+)?task started/i.test(cleaned)) return "started";
  if (/(?:codex\s+)?context compacted/i.test(cleaned)) return "compacted";
  if (/(?:codex\s+)?turn aborted/i.test(cleaned)) return "aborted";
  return "other";
}

function editActionLabel(action: VisualFileEdit["action"]): string {
  if (action === "added") return "Added";
  if (action === "deleted") return "Deleted";
  return "Edited";
}

function summarizeFileEdits(files: VisualFileEdit[]): VisualFileEditSummary | undefined {
  if (files.length === 0) return undefined;
  const title =
    files.length === 1
      ? `${editActionLabel(files[0]!.action)} ${files[0]!.path.split("/").pop()}`
      : `Edited ${files.length} files`;
  return { title, files };
}

function parseApplyPatchEdits(patch: string): VisualFileEditSummary | undefined {
  const byPath = new Map<string, VisualFileEdit>();
  const rawByPath = new Map<string, string[]>();
  let current: VisualFileEdit | undefined;
  let currentPath: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (fileMatch) {
      const action =
        fileMatch[1] === "Add"
          ? "added"
          : fileMatch[1] === "Delete"
            ? "deleted"
            : "edited";
      const path = fileMatch[2]!.trim();
      currentPath = path;
      rawByPath.set(path, [line]);
      current = byPath.get(path);
      if (!current) {
        current = { path, action, additions: 0, deletions: 0 };
        byPath.set(path, current);
      } else if (current.action !== "added" && action !== "edited") {
        current.action = action;
      }
      continue;
    }
    if (currentPath) rawByPath.get(currentPath)?.push(line);
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions = (current.additions ?? 0) + 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions = (current.deletions ?? 0) + 1;
    }
  }
  for (const file of byPath.values()) {
    file.raw = rawByPath.get(file.path)?.join("\n").trim();
  }
  return summarizeFileEdits([...byPath.values()]);
}

function filePathFromObject(input: Record<string, unknown>): string | undefined {
  const value =
    input.file_path ??
    input.filePath ??
    input.path ??
    input.target_file ??
    input.targetFile;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function changedLineCount(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  if (!value) return 0;
  return value.endsWith("\n")
    ? value.split("\n").length - 1
    : value.split("\n").length;
}

function claudeEditSummary(
  toolName: string,
  input: Record<string, unknown>,
): VisualFileEditSummary | undefined {
  const name = toolName.toLowerCase();
  if (name.includes("multiedit") && Array.isArray(input.edits)) {
    const path = filePathFromObject(input);
    if (!path) return undefined;
    let additions = 0;
    let deletions = 0;
    for (const edit of input.edits) {
      if (!edit || typeof edit !== "object") continue;
      const obj = edit as Record<string, unknown>;
      additions += changedLineCount(obj.new_string) ?? 0;
      deletions += changedLineCount(obj.old_string) ?? 0;
    }
    return summarizeFileEdits([
      {
        path,
        action: "edited",
        additions: additions > 0 ? additions : undefined,
        deletions: deletions > 0 ? deletions : undefined,
      },
    ]);
  }

  if (name === "edit" || name.endsWith("_edit")) {
    const path = filePathFromObject(input);
    if (!path) return undefined;
    return summarizeFileEdits([
      {
        path,
        action: "edited",
        additions: changedLineCount(input.new_string),
        deletions: changedLineCount(input.old_string),
      },
    ]);
  }

  if (name === "write" || name.endsWith("_write")) {
    const path = filePathFromObject(input);
    if (!path) return undefined;
    return summarizeFileEdits([
      {
        path,
        action: "added",
        additions: changedLineCount(input.content),
      },
    ]);
  }

  return undefined;
}

export function visualFileEditSummaryForBlock(
  block: MessageBlock | undefined,
): VisualFileEditSummary | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const toolName = block.toolName ?? "";
  const lowerName = toolName.toLowerCase();
  const input = block.toolInput;

  if (lowerName === "apply_patch" || lowerName.includes("apply_patch")) {
    if (typeof input === "string") return parseApplyPatchEdits(input);
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      const patch = obj.patch ?? obj.input ?? obj.content;
      if (typeof patch === "string") return parseApplyPatchEdits(patch);
    }
  }

  if (lowerName.includes("file change") && input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const rawChanges = obj.changes ?? obj.files ?? obj.edits;
    if (Array.isArray(rawChanges)) {
      const files = rawChanges
        .map((change): VisualFileEdit | undefined => {
          if (!change || typeof change !== "object") return undefined;
          const item = change as Record<string, unknown>;
          const path = filePathFromObject(item);
          if (!path) return undefined;
          const kind = String(item.type ?? item.action ?? "edited").toLowerCase();
          return {
            path,
            action: kind.includes("add")
              ? "added"
              : kind.includes("delete") || kind.includes("remove")
                ? "deleted"
                : "edited",
          };
        })
        .filter((file): file is VisualFileEdit => !!file);
      return summarizeFileEdits(files);
    }
  }

  if (input && typeof input === "object") {
    return claudeEditSummary(toolName, input as Record<string, unknown>);
  }

  return undefined;
}

export function buildVisualWorkDisplayEntries<
  B extends MessageBlock,
  M extends Message<B>,
>(
  entries: readonly VisualWorkEntry<B, M>[],
): VisualWorkDisplayEntry<B, M>[] {
  const pairedResults = new Set<number>();
  const resultByToolUse = new Map<number, VisualWorkEntry<B, M>>();
  const toolUseById = new Map<string, number>();
  const toolUseIndexes: number[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (hasBlockType(entry, "tool_use")) {
      toolUseIndexes.push(index);
      for (const id of blockToolUseIds(entry)) {
        if (!toolUseById.has(id)) toolUseById.set(id, index);
      }
    }
    if (!hasBlockType(entry, "tool_result")) continue;

    let pairedToolUseIndex: number | undefined;
    for (const id of blockToolUseIds(entry)) {
      const candidate = toolUseById.get(id);
      if (candidate !== undefined && !resultByToolUse.has(candidate)) {
        pairedToolUseIndex = candidate;
        break;
      }
    }
    pairedToolUseIndex ??= toolUseIndexes.find(
      (candidate) => !resultByToolUse.has(candidate),
    );
    if (pairedToolUseIndex === undefined) continue;

    resultByToolUse.set(
      pairedToolUseIndex,
      withToolResultName(entry, firstToolUseName(entries[pairedToolUseIndex])),
    );
    pairedResults.add(index);
  }

  const out: VisualWorkDisplayEntry<B, M>[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (pairedResults.has(index)) continue;
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
    out.push({
      kind: "entry",
      entry,
      pairedResult: resultByToolUse.get(index),
    });
  }
  return out;
}

function isResponseBlock(block: MessageBlock): boolean {
  return block.type === "text" || block.type === "media";
}

function isAssistantResponseEntry<B extends MessageBlock, M extends Message<B>>(
  entry: VisualWorkEntry<B, M>,
): boolean {
  return (
    entry.message.role === "assistant" && entry.blocks.some(isResponseBlock)
  );
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
        mimeType?: string;
        mediaKind?: string;
      };
      if (block.type === "media") {
        return [
          "media",
          anyBlock.mediaKind ?? "",
          anyBlock.path ?? "",
          anyBlock.url ?? "",
          anyBlock.mimeType ?? "",
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
        out[out.length - 1] = message;
      }
      continue;
    }
    out.push(message);
  }
  return out;
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
  if (overlays.length === 0) return withoutDuplicateOptimisticUserMessages(messages);
  return withoutDuplicateOptimisticUserMessages(
    [...messages, ...overlays].sort((a, b) => {
      const aMs = timestampMs(a.timestamp) ?? Number.POSITIVE_INFINITY;
      const bMs = timestampMs(b.timestamp) ?? Number.POSITIVE_INFINITY;
      return aMs - bMs;
    }),
  );
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
      const block = {
        ...blockFields,
        type: patch.type,
        text: patch.delta,
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
    const block = {
      ...base,
      ...(!base.toolName && blockFields.toolName
        ? { toolName: blockFields.toolName }
        : {}),
      ...(!base.toolUseId && blockFields.toolUseId
        ? { toolUseId: blockFields.toolUseId }
        : {}),
      text: (base.text ?? "") + patch.delta,
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
    block.planItems
      ?.map((item) => `${item.status}:${item.step}`)
      .join("\n") ?? "";
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
  return [
    getVisualTranscriptItemKey(item),
    item.startedAt ?? "",
    item.endedAt ?? "",
    item.open === true ? "open" : "closed",
    item.entries.map(entrySignature).join("\u0003"),
  ].join("\u0002");
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
  return [
    displayEntry.kind,
    getVisualWorkEntryKey(displayEntry.entry),
    resultKey,
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
      const previousEntry = previousEntriesByKey.get(getVisualWorkEntryKey(entry));
      if (previousEntry && entrySignature(previousEntry) === entrySignature(entry)) {
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
  opts: { active?: boolean } = {},
): VisualTranscriptItem<B, M>[] {
  const out: VisualTranscriptItem<B, M>[] = [];
  let messageIndex = 0;

  function pushMessage(entry: VisualWorkEntry<B, M>): void {
    out.push({
      kind: "message",
      message: entry.message,
      blocks: entry.blocks,
      messageIndex: entry.messageIndex,
    });
  }

  function pushTurnWorkAndResponse(
    entries: VisualWorkEntry<B, M>[],
    userTimestamp: string | undefined,
    active: boolean,
  ): void {
    const hasResponse = entries.some(isAssistantResponseEntry);
    if (active || !hasResponse) {
      if (entries.length > 0) {
        const firstWorkTs = entries.find((entry) =>
          timestampMs(entry.message.timestamp),
        )?.message.timestamp;
        out.push({
          kind: "work",
          entries,
          startedAt: userTimestamp ?? firstWorkTs,
          open: true,
        });
      }
      return;
    }

    const finalResponseIndex = entries.findLastIndex(
      (entry) => isAssistantResponseEntry(entry),
    );
    const finalResponse = entries[finalResponseIndex]!;
    const workEntries: VisualWorkEntry<B, M>[] = [];
    entries.forEach((entry, entryIndex) => {
      const blocks =
        entryIndex === finalResponseIndex
          ? entry.blocks.filter((block) => !isResponseBlock(block))
          : entry.blocks;
      if (blocks.length > 0) {
        workEntries.push({ ...entry, blocks });
      }
    });

    if (workEntries.length > 0) {
      const firstWorkTs = workEntries.find((entry) =>
        timestampMs(entry.message.timestamp),
      )?.message.timestamp;
      out.push({
        kind: "work",
        entries: workEntries,
        startedAt: userTimestamp ?? firstWorkTs,
        endedAt: finalResponse.message.timestamp,
      });
    }

    out.push({
      kind: "message",
      message: finalResponse.message,
      blocks: finalResponse.blocks.filter(isResponseBlock),
      messageIndex: finalResponse.messageIndex,
    });
  }

  while (messageIndex < messages.length) {
    const message = messages[messageIndex]!;
    const blocks = message.blocks ?? [];
    if (message.role !== "user") {
      pushMessage({ message, blocks, messageIndex });
      messageIndex += 1;
      continue;
    }

    out.push({ kind: "message", message, blocks, messageIndex });
    const userTimestamp = message.timestamp;
    const turnEntries: VisualWorkEntry<B, M>[] = [];
    messageIndex += 1;
    while (
      messageIndex < messages.length &&
      messages[messageIndex]?.role !== "user"
    ) {
      const turnMessage = messages[messageIndex]!;
      turnEntries.push({
        message: turnMessage,
        blocks: turnMessage.blocks ?? [],
        messageIndex,
      });
      messageIndex += 1;
    }
    pushTurnWorkAndResponse(
      turnEntries,
      userTimestamp,
      opts.active === true && messageIndex >= messages.length,
    );
  }

  return out;
}
