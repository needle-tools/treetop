import type { MessageBlock, VisualMediaBlock } from "../last-user-message";
import {
  cleanVisualToolResultText,
  visualFileEditSummaryForBlock,
  visualFileEditTotals,
  visualToolMediaBlocks,
  visualToolPreviewParts,
  visualToolPreviewText,
  visualToolRemoteHostLabel,
} from "./tool-preview";

interface VisualWorkEntryLike {
  message: {
    role: string;
    timestamp?: string;
  };
  blocks: MessageBlock[];
  messageIndex: number;
}

interface VisualWorkDisplayEntryLike {
  kind: "entry" | "marker";
  entry: VisualWorkEntryLike;
  pairedResult?: VisualWorkEntryLike;
  pairedToolUse?: VisualWorkEntryLike;
  markerKind?: string;
}

interface VisualWorkItemLike {
  startedAt?: string;
  endedAt?: string;
  open?: boolean;
}

export interface VisualWorkTimeOverview {
  elapsedMs: number;
  toolWaitMs: number;
  agentMs: number;
  toolWaitPercent: number;
  agentPercent: number;
}

export interface VisualWorkArtifact {
  kind: "file" | "image" | "remote" | "container" | "other";
  action: "used" | "changed" | "produced";
  label: string;
  path?: string;
  title?: string;
}

export interface VisualWorkOverview {
  lines: string[];
  artifacts: VisualWorkArtifact[];
  time: VisualWorkTimeOverview;
  tokenCount: number;
}

export interface VisualWorkDetailOptions {
  full: boolean;
  recentLimit?: number;
}

interface ToolTimingInterval {
  start: number;
  end: number;
}

function firstBlockOfType(
  entry: VisualWorkEntryLike | undefined,
  type: string,
): MessageBlock | undefined {
  return entry?.blocks.find((block) => block.type === type);
}

function isoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function basename(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return cleaned.split("/").filter(Boolean).pop() ?? path;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function joinPreview(values: readonly string[], limit = 4): string {
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")}, +${values.length - limit}`;
}

function toolDisplayEntries(
  entries: readonly VisualWorkDisplayEntryLike[],
): VisualWorkDisplayEntryLike[] {
  return entries.filter(
    (entry) =>
      !!firstBlockOfType(entry.entry, "tool_use") ||
      !!firstBlockOfType(entry.pairedToolUse, "tool_use") ||
      !!firstBlockOfType(entry.entry, "tool_result") ||
      !!firstBlockOfType(entry.pairedResult, "tool_result"),
  );
}

function toolUseEntry(
  entry: VisualWorkDisplayEntryLike,
): VisualWorkEntryLike | undefined {
  return firstBlockOfType(entry.entry, "tool_use")
    ? entry.entry
    : entry.pairedToolUse;
}

function toolResultEntry(
  entry: VisualWorkDisplayEntryLike,
): VisualWorkEntryLike | undefined {
  return firstBlockOfType(entry.entry, "tool_result")
    ? entry.entry
    : entry.pairedResult;
}

function toolUseBlock(
  entry: VisualWorkDisplayEntryLike,
): MessageBlock | undefined {
  return (
    firstBlockOfType(entry.entry, "tool_use") ??
    firstBlockOfType(entry.pairedToolUse, "tool_use")
  );
}

function toolResultBlock(
  entry: VisualWorkDisplayEntryLike,
): MessageBlock | undefined {
  return (
    firstBlockOfType(entry.entry, "tool_result") ??
    firstBlockOfType(entry.pairedResult, "tool_result")
  );
}

function inferToolCategory(toolBlock: MessageBlock | undefined): string {
  const preview = visualToolPreviewText(toolBlock).toLowerCase();
  const name = (toolBlock?.toolName ?? "").toLowerCase();
  if (visualFileEditSummaryForBlock(toolBlock)) return "edit";
  if (name.includes("image") || preview.includes("image")) return "image";
  if (name.includes("browser") || name.includes("page")) return "browser";
  if (
    preview.startsWith("read logs") ||
    preview.startsWith("read ") ||
    preview.startsWith("view image")
  )
    return "read";
  if (
    preview.startsWith("search ") ||
    preview.startsWith("find ") ||
    preview.includes(' for "')
  )
    return "search";
  if (
    preview.startsWith("check git") ||
    preview.startsWith("review diff") ||
    preview.startsWith("stage ") ||
    preview.startsWith("commit ") ||
    /^git\b/.test(preview)
  )
    return "git";
  if (preview.startsWith("run ") || preview.includes(" test")) return "test";
  if (
    preview.startsWith("create ") ||
    preview.startsWith("delete ") ||
    preview.startsWith("copy ") ||
    preview.startsWith("move ")
  )
    return "file";
  if (preview.includes("docker") || preview.includes("container"))
    return "docker";
  return "command";
}

function categoryLabel(category: string): string {
  switch (category) {
    case "edit":
      return "edit";
    case "read":
      return "read";
    case "search":
      return "search";
    case "git":
      return "git check";
    case "test":
      return "test";
    case "browser":
      return "browser action";
    case "docker":
      return "docker action";
    case "file":
      return "file operation";
    case "image":
      return "image operation";
    default:
      return "command";
  }
}

function resultTokenCount(entry: VisualWorkDisplayEntryLike): number {
  const result = toolResultBlock(entry);
  if (!result || result.type !== "tool_result") return 0;
  return cleanVisualToolResultText(result.text).originalTokenCount ?? 0;
}

function toolTimingInterval(
  item: VisualWorkItemLike,
  entry: VisualWorkDisplayEntryLike,
  nowMs: number,
): ToolTimingInterval | undefined {
  const useEntry = toolUseEntry(entry);
  if (!useEntry) return undefined;
  const resultEntry = toolResultEntry(entry);
  const result = toolResultBlock(entry);
  const startMs = isoMs(useEntry.message.timestamp);
  const resultMs = isoMs(resultEntry?.message.timestamp);
  const wallMs =
    result?.type === "tool_result"
      ? (cleanVisualToolResultText(result.text).wallTimeSeconds ?? 0) * 1000
      : undefined;

  if (resultMs !== undefined && wallMs !== undefined) {
    return {
      start:
        startMs !== undefined
          ? Math.min(startMs, resultMs)
          : Math.max(0, resultMs - wallMs),
      end:
        wallMs > 0 && startMs !== undefined
          ? Math.max(resultMs, startMs + wallMs)
          : resultMs,
    };
  }
  if (startMs === undefined) return undefined;
  if (resultMs !== undefined) return { start: startMs, end: resultMs };
  if (item.open === true && item.endedAt === undefined) {
    return { start: startMs, end: nowMs };
  }
  return undefined;
}

function mergeIntervals(
  intervals: readonly ToolTimingInterval[],
): ToolTimingInterval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged: ToolTimingInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function toolWaitMs(
  item: VisualWorkItemLike,
  entries: readonly VisualWorkDisplayEntryLike[],
  nowMs: number,
): number {
  return mergeIntervals(
    entries
      .map((entry) => toolTimingInterval(item, entry, nowMs))
      .filter((interval): interval is ToolTimingInterval => !!interval),
  ).reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

function elapsedMs(
  item: VisualWorkItemLike,
  entries: readonly VisualWorkDisplayEntryLike[],
  nowMs: number,
): number {
  const starts = [
    isoMs(item.startedAt),
    ...entries.map((entry) => isoMs(entry.entry.message.timestamp)),
  ].filter((value): value is number => value !== undefined);
  const ends = [
    isoMs(item.endedAt),
    ...entries.flatMap((entry) => [
      isoMs(entry.entry.message.timestamp),
      isoMs(entry.pairedResult?.message.timestamp),
    ]),
  ].filter((value): value is number => value !== undefined);
  const start = starts.length > 0 ? Math.min(...starts) : nowMs;
  const end =
    item.open === true && item.endedAt === undefined
      ? nowMs
      : ends.length > 0
        ? Math.max(...ends)
        : start;
  return Math.max(0, end - start);
}

function workTimeOverview(
  item: VisualWorkItemLike,
  entries: readonly VisualWorkDisplayEntryLike[],
  nowMs: number,
): VisualWorkTimeOverview {
  const elapsed = elapsedMs(item, entries, nowMs);
  const wait = Math.min(elapsed, toolWaitMs(item, entries, nowMs));
  const agent = Math.max(0, elapsed - wait);
  const toolWaitPercent = elapsed > 0 ? Math.round((wait / elapsed) * 100) : 0;
  return {
    elapsedMs: elapsed,
    toolWaitMs: wait,
    agentMs: agent,
    toolWaitPercent,
    agentPercent: elapsed > 0 ? 100 - toolWaitPercent : 0,
  };
}

function addArtifact(
  artifacts: VisualWorkArtifact[],
  artifact: VisualWorkArtifact,
): void {
  artifacts.push(artifact);
}

function artifactsForEntry(
  entry: VisualWorkDisplayEntryLike,
): VisualWorkArtifact[] {
  const artifacts: VisualWorkArtifact[] = [];
  const toolBlock = toolUseBlock(entry);
  const resultBlock = toolResultBlock(entry);
  const editSummary = visualFileEditSummaryForBlock(toolBlock);
  if (editSummary) {
    for (const file of editSummary.files) {
      addArtifact(artifacts, {
        kind: "file",
        action: "changed",
        label: basename(file.path),
        path: file.path,
        title: file.path,
      });
    }
  }
  for (const media of visualToolMediaBlocks(toolBlock, resultBlock)) {
    addArtifact(artifacts, mediaArtifact(media, toolBlock));
  }
  if (!editSummary) {
    for (const part of visualToolPreviewParts(toolBlock)) {
      if (part.kind !== "path") continue;
      addArtifact(artifacts, {
        kind: "file",
        action: "used",
        label: part.text,
        path: part.path,
        title: part.path,
      });
    }
  }
  return artifacts;
}

function mediaArtifact(
  media: VisualMediaBlock,
  toolBlock: MessageBlock | undefined,
): VisualWorkArtifact {
  const toolName = (toolBlock?.toolName ?? "").toLowerCase();
  return {
    kind: "image",
    action:
      toolName.includes("screenshot") ||
      toolName.includes("image") ||
      toolName.includes("generation")
        ? "produced"
        : "used",
    label:
      (media.title ?? media.path)
        ? basename(media.title ?? media.path!)
        : "image",
    path: media.path,
    title: media.title ?? media.path,
  };
}

function commandSummaryLine(
  entries: readonly VisualWorkDisplayEntryLike[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of toolDisplayEntries(entries)) {
    const toolBlock = toolUseBlock(entry);
    const category = inferToolCategory(toolBlock);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return undefined;
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(
      ([category, count]) =>
        `${count} ${plural(count, categoryLabel(category))}`,
    );
  return `Ran ${total} ${plural(total, "tool")}: ${parts.join(", ")}`;
}

function editSummaryLine(
  entries: readonly VisualWorkDisplayEntryLike[],
): string | undefined {
  const files = new Map<
    string,
    {
      path: string;
      additions: number;
      deletions: number;
      sawAdd: boolean;
      sawDel: boolean;
    }
  >();
  for (const entry of entries) {
    const summary = visualFileEditSummaryForBlock(toolUseBlock(entry));
    if (!summary) continue;
    const totals = visualFileEditTotals(summary);
    for (const file of summary.files) {
      const existing = files.get(file.path) ?? {
        path: file.path,
        additions: 0,
        deletions: 0,
        sawAdd: false,
        sawDel: false,
      };
      if (file.additions !== undefined) {
        existing.additions += file.additions;
        existing.sawAdd = true;
      }
      if (file.deletions !== undefined) {
        existing.deletions += file.deletions;
        existing.sawDel = true;
      }
      files.set(file.path, existing);
    }
    if (summary.files.length === 0 && totals.additions === undefined) {
      continue;
    }
  }
  const changed = [...files.values()];
  if (changed.length === 0) return undefined;
  const additions = changed.reduce((sum, file) => sum + file.additions, 0);
  const deletions = changed.reduce((sum, file) => sum + file.deletions, 0);
  const labels = uniqueSorted(changed.map((file) => basename(file.path)));
  const counts = changed.some((file) => file.sawAdd || file.sawDel)
    ? ` (+${additions} −${deletions})`
    : "";
  return `Changed ${changed.length} ${plural(changed.length, "file")}${counts}: ${joinPreview(labels)}`;
}

function remoteSummaryLine(
  entries: readonly VisualWorkDisplayEntryLike[],
): string | undefined {
  const hosts = uniqueSorted(
    entries
      .map((entry) => visualToolRemoteHostLabel(toolUseBlock(entry)))
      .filter((host): host is string => !!host),
  );
  if (hosts.length === 0) return undefined;
  return `Accessed SSH: ${joinPreview(hosts)}`;
}

function artifactSummary(
  entries: readonly VisualWorkDisplayEntryLike[],
): VisualWorkArtifact[] {
  return entries.flatMap(artifactsForEntry);
}

export function visualWorkOverview(
  item: VisualWorkItemLike,
  entries: readonly VisualWorkDisplayEntryLike[],
  options: { now?: string | number | Date } = {},
): VisualWorkOverview {
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : typeof options.now === "string"
          ? Date.parse(options.now)
          : Date.now();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const lines = [
    editSummaryLine(entries),
    commandSummaryLine(entries),
    remoteSummaryLine(entries),
  ].filter((line): line is string => !!line);
  return {
    lines,
    artifacts: artifactSummary(entries),
    time: workTimeOverview(item, entries, safeNowMs),
    tokenCount: entries.reduce(
      (sum, entry) => sum + resultTokenCount(entry),
      0,
    ),
  };
}

export function visualWorkDetailEntries<T extends VisualWorkDisplayEntryLike>(
  item: VisualWorkItemLike,
  entries: readonly T[],
  options: VisualWorkDetailOptions,
): T[] {
  if (options.full) return [...entries];
  if (item.open !== true) return [];
  const limit = Math.max(0, options.recentLimit ?? 5);
  if (limit === 0) return [];
  return entries.slice(-limit);
}
