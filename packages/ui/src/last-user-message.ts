export interface MessageBlock {
  type: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface Message<B extends MessageBlock = MessageBlock> {
  role: string;
  blocks: B[];
  timestamp?: string;
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
  if (!codexChunk) {
    return {
      title: "Tool result",
      body: trimmed,
      wrappedCodexChunk: false,
    };
  }

  const exitCode = codexChunk[2] ?? "0";
  const parsedExitCode = Number.parseInt(exitCode, 10);
  const wallTimeSeconds = Number(codexChunk[1]);
  const output = (codexChunk[4] ?? "").trim();
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
    originalTokenCount: codexChunk[3]
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

    resultByToolUse.set(pairedToolUseIndex, entry);
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

function isAssistantResponseBlock(block: MessageBlock): boolean {
  return block.type === "text" || block.type === "media";
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
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
    const hasResponse = entries.some((entry) =>
      entry.blocks.some(isAssistantResponseBlock),
    );
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
      (entry) =>
        entry.message.role === "assistant" &&
        entry.blocks.some(isAssistantResponseBlock),
    );
    const finalResponse = entries[finalResponseIndex]!;
    const workEntries: VisualWorkEntry<B, M>[] = [];
    entries.forEach((entry, entryIndex) => {
      const blocks =
        entryIndex === finalResponseIndex
          ? entry.blocks.filter((block) => !isAssistantResponseBlock(block))
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
      blocks: finalResponse.blocks.filter(isAssistantResponseBlock),
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
