import type {
  MessageBlock,
  TokenUsage,
  VisualMediaBlock,
} from "../last-user-message";
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
    tokensUsed?: number;
    tokenUsage?: TokenUsage;
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
  id: string;
  kind: "file" | "image" | "remote" | "container" | "other";
  action: "used" | "changed" | "produced";
  label: string;
  path?: string;
  title?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  diffKind?: "workdir" | "staged" | "untracked";
  changes?: VisualWorkArtifactChange[];
}

export interface VisualWorkArtifactChange {
  action: VisualWorkArtifact["action"];
  label: string;
  path?: string;
  title?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  diffKind?: "workdir" | "staged" | "untracked";
}

export interface VisualWorkCategoryCount {
  category: string;
  label: string;
  iconName: string;
  count: number;
}

export interface VisualWorkChangedFile {
  path: string;
  label: string;
  additions?: number;
  deletions?: number;
  diff?: string;
}

export interface VisualWorkTokenOverview {
  agent: number;
  tool: number;
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  freshInput: number;
  output: number;
  reasoningOutput: number;
  generatedOutput: number;
  reportedTotal: number;
  total: number;
  perSecond: number;
  agentPerSecond: number;
  toolPerSecond: number;
}

export interface VisualWorkOverview {
  lines: string[];
  artifacts: VisualWorkArtifact[];
  time: VisualWorkTimeOverview;
  tokenCount: number;
  tokens: VisualWorkTokenOverview;
  actionCount: number;
  responseCount: number;
  categories: VisualWorkCategoryCount[];
  changedFiles: VisualWorkChangedFile[];
  remoteHosts: string[];
}

export interface VisualWorkDetailOptions {
  full: boolean;
  recentLimit?: number;
}

export interface VisualWorkOverviewOptions {
  now?: string | number | Date;
  timeScope?: "item" | "entries";
}

export interface VisualWorkDetailGroup<T extends VisualWorkDisplayEntryLike> {
  id: string;
  kind: "actions" | "response";
  entries: T[];
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

function isoString(value: number): string {
  return new Date(value).toISOString();
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
  if (
    preview.includes("PostgreSQL") ||
    preview.includes("MySQL") ||
    preview.includes("MariaDB") ||
    preview.includes("SQLite")
  )
    return "database";
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
    case "database":
      return "database query";
    case "file":
      return "file operation";
    case "image":
      return "image operation";
    default:
      return "command";
  }
}

function categoryIconName(category: string): string {
  switch (category) {
    case "edit":
      return "apply_patch";
    case "read":
      return "view_image";
    case "search":
      return "search";
    case "git":
      return "git";
    case "test":
      return "test";
    case "browser":
      return "list_pages";
    case "docker":
      return "docker";
    case "database":
      return "database";
    case "file":
      return "filesystem_create";
    case "image":
      return "image_generation_call";
    default:
      return "exec_command";
  }
}

function actionCategoryCounts(
  entries: readonly VisualWorkDisplayEntryLike[],
): VisualWorkCategoryCount[] {
  const counts = new Map<string, number>();
  for (const entry of toolDisplayEntries(entries)) {
    const toolBlock = toolUseBlock(entry);
    const category = inferToolCategory(toolBlock);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => ({
      category,
      count,
      label: categoryLabel(category),
      iconName: categoryIconName(category),
    }));
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function tokenRate(tokens: number, elapsed: number): number {
  if (tokens <= 0 || elapsed <= 0) return 0;
  return Math.round((tokens / (elapsed / 1000)) * 10) / 10;
}

function tokenUsageFromEntry(
  entry: VisualWorkDisplayEntryLike,
): TokenUsage | undefined {
  const usage = entry.entry.message.tokenUsage;
  if (
    usage &&
    Number.isFinite(usage.total) &&
    usage.total > 0
  ) {
    return usage;
  }
  const output = numericField(entry.entry.message.tokensUsed);
  if (output !== undefined && output > 0) {
    return {
      input: 0,
      cachedInput: 0,
      cacheWriteInput: 0,
      output,
      reasoningOutput: 0,
      total: output,
    };
  }
  if (!isAgentResponseEntry(entry)) return undefined;
  const blockOutput = entry.entry.blocks.reduce(
    (sum, block) =>
      sum +
      (numericField((block as { tokensUsed?: unknown }).tokensUsed) ?? 0),
    0,
  );
  if (blockOutput <= 0) return undefined;
  return {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: blockOutput,
    reasoningOutput: 0,
    total: blockOutput,
  };
}

function tokenOverview(
  entries: readonly VisualWorkDisplayEntryLike[],
  time: VisualWorkTimeOverview,
): VisualWorkTokenOverview {
  // Command-output "Original token count" describes tool payload size, not
  // model usage. Keep token accounting on reported model usage only. Codex
  // reports cached input as part of input, so the headline uses fresh input
  // plus generated output; raw reported totals stay available for tooltips.
  const tool = 0;
  const totals = entries.reduce(
    (acc, entry) => {
      const usage = tokenUsageFromEntry(entry);
      if (!usage) return acc;
      acc.input += usage.input;
      acc.cachedInput += usage.cachedInput;
      acc.cacheWriteInput += usage.cacheWriteInput;
      acc.output += usage.output;
      acc.reasoningOutput += usage.reasoningOutput;
      acc.total += usage.total;
      return acc;
    },
    {
      input: 0,
      cachedInput: 0,
      cacheWriteInput: 0,
      output: 0,
      reasoningOutput: 0,
      total: 0,
    },
  );
  const freshInput = Math.max(0, totals.input - totals.cachedInput);
  const generatedOutput = totals.output + totals.reasoningOutput;
  const total = freshInput + generatedOutput;
  const agent = total;
  return {
    agent,
    tool,
    input: totals.input,
    cachedInput: totals.cachedInput,
    cacheWriteInput: totals.cacheWriteInput,
    freshInput,
    output: totals.output,
    reasoningOutput: totals.reasoningOutput,
    generatedOutput,
    reportedTotal: totals.total,
    total,
    perSecond: tokenRate(totals.output, time.elapsedMs),
    agentPerSecond: tokenRate(agent, time.elapsedMs),
    toolPerSecond: tokenRate(tool, time.elapsedMs),
  };
}

export function visualWorkDisplayEntryIsAgentResponse(
  entry: VisualWorkDisplayEntryLike,
): boolean {
  return isAgentResponseEntry(entry);
}

function isAgentResponseEntry(entry: VisualWorkDisplayEntryLike): boolean {
  if (entry.kind !== "entry") return false;
  if (
    firstBlockOfType(entry.entry, "tool_use") ||
    firstBlockOfType(entry.entry, "tool_result") ||
    firstBlockOfType(entry.entry, "marker") ||
    firstBlockOfType(entry.entry, "thinking") ||
    firstBlockOfType(entry.entry, "plan") ||
    firstBlockOfType(entry.entry, "subagent")
  ) {
    return false;
  }
  return (
    entry.entry.message.role === "assistant" &&
    entry.entry.blocks.some(
      (block) => block.type === "text" && !!block.text?.trim(),
    )
  );
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

function entryTimeBounds(
  entries: readonly VisualWorkDisplayEntryLike[],
): { start: number; end: number } | undefined {
  const times = entries
    .flatMap((entry) => [
      isoMs(entry.entry.message.timestamp),
      isoMs(entry.pairedToolUse?.message.timestamp),
      isoMs(entry.pairedResult?.message.timestamp),
    ])
    .filter((value): value is number => value !== undefined);
  if (times.length === 0) return undefined;
  return { start: Math.min(...times), end: Math.max(...times) };
}

function itemScopedToEntries(
  item: VisualWorkItemLike,
  entries: readonly VisualWorkDisplayEntryLike[],
): VisualWorkItemLike {
  const bounds = entryTimeBounds(entries);
  if (!bounds) return item;
  const hasUnresolvedTool =
    item.open === true &&
    entries.some((entry) => !!toolUseEntry(entry) && !toolResultEntry(entry));
  return {
    startedAt: isoString(bounds.start),
    endedAt: hasUnresolvedTool ? undefined : isoString(bounds.end),
    open: hasUnresolvedTool,
  };
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
  artifact: Omit<VisualWorkArtifact, "id">,
): void {
  const stablePath = artifact.path
    ? artifact.path.replace(/\\/g, "/").replace(/\/+$/, "")
    : "";
  const id = [
    artifact.kind,
    stablePath || artifact.title || artifact.label,
  ].join("\u0000");
  const change: VisualWorkArtifactChange = {
    action: artifact.action,
    label: artifact.label,
    path: artifact.path,
    title: artifact.title,
    additions: artifact.additions,
    deletions: artifact.deletions,
    diff: artifact.diff?.trim() || artifact.diff,
    diffKind: artifact.diffKind,
  };
  artifacts.push({ ...artifact, id, changes: [change] });
}

function preferredArtifactAction(
  a: VisualWorkArtifact["action"],
  b: VisualWorkArtifact["action"],
): VisualWorkArtifact["action"] {
  const rank: Record<VisualWorkArtifact["action"], number> = {
    used: 0,
    changed: 1,
    produced: 2,
  };
  return rank[b] > rank[a] ? b : a;
}

function mergeArtifactDiff(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  const left = a?.trim();
  const right = b?.trim();
  if (!left) return right || undefined;
  if (!right || left === right) return left;
  return `${left}\n${right}`;
}

function mergeArtifact(
  current: VisualWorkArtifact,
  next: VisualWorkArtifact,
): VisualWorkArtifact {
  const currentDiff = current.diff?.trim();
  const nextDiff = next.diff?.trim();
  const newDiff = !!nextDiff && nextDiff !== currentDiff;
  return {
    ...current,
    action: preferredArtifactAction(current.action, next.action),
    label: next.label || current.label,
    path: next.path ?? current.path,
    title: next.title ?? current.title,
    additions:
      current.additions === undefined
        ? next.additions
        : next.additions === undefined
          ? current.additions
          : newDiff
            ? current.additions + next.additions
            : Math.max(current.additions, next.additions),
    deletions:
      current.deletions === undefined
        ? next.deletions
        : next.deletions === undefined
          ? current.deletions
          : newDiff
            ? current.deletions + next.deletions
            : Math.max(current.deletions, next.deletions),
    diff: mergeArtifactDiff(current.diff, next.diff),
    diffKind: next.diffKind ?? current.diffKind,
    changes: [...(current.changes ?? []), ...(next.changes ?? [])],
  };
}

function isShellSyntaxFragment(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^[|&;(){}[\]<>]+$/.test(trimmed)) return true;
  return [
    "|",
    "||",
    "&&",
    ";",
    "head",
    "tail",
    "sed",
    "rg",
    "grep",
    "awk",
    "jq",
    "sort",
    "xargs",
  ].includes(trimmed);
}

function looksLikeArtifactPath(path: string, label: string): boolean {
  const clean = path.trim();
  if (isShellSyntaxFragment(clean)) return false;
  if (clean.startsWith("/") || clean.startsWith("./") || clean.startsWith("../"))
    return true;
  if (clean.includes("\\") || clean.includes("/")) return true;
  if (/:\d+(?:-\d+)?$/.test(label)) return true;
  return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,12}(?::\d+(?:-\d+)?)?$/.test(clean);
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
        additions: file.additions,
        deletions: file.deletions,
        diff: file.raw,
      });
    }
  }
  for (const media of visualToolMediaBlocks(toolBlock, resultBlock)) {
    addArtifact(artifacts, mediaArtifact(media, toolBlock));
  }
  if (!editSummary) {
    for (const part of visualToolPreviewParts(toolBlock)) {
      if (part.kind !== "path") continue;
      if (!looksLikeArtifactPath(part.path, part.text)) continue;
      addArtifact(artifacts, {
        kind: "file",
        action: "used",
        label: part.text,
        path: part.path,
      });
    }
  }
  return artifacts;
}

function mediaArtifact(
  media: VisualMediaBlock,
  toolBlock: MessageBlock | undefined,
): Omit<VisualWorkArtifact, "id"> {
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
  const categories = actionCategoryCounts(entries);
  const total = categories.reduce((sum, category) => sum + category.count, 0);
  if (total === 0) return undefined;
  const parts = categories
    .map(
      (category) =>
        `${category.count} ${plural(category.count, category.label)}`,
    );
  return `Ran ${total} ${plural(total, "tool")}: ${parts.join(", ")}`;
}

function changedFileSummary(
  entries: readonly VisualWorkDisplayEntryLike[],
): VisualWorkChangedFile[] {
  const files = new Map<
    string,
    {
      path: string;
      additions: number;
      deletions: number;
      sawAdd: boolean;
      sawDel: boolean;
      diffs: string[];
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
        diffs: [],
      };
      if (file.additions !== undefined) {
        existing.additions += file.additions;
        existing.sawAdd = true;
      }
      if (file.deletions !== undefined) {
        existing.deletions += file.deletions;
        existing.sawDel = true;
      }
      if (file.raw?.trim()) existing.diffs.push(file.raw.trim());
      files.set(file.path, existing);
    }
    if (summary.files.length === 0 && totals.additions === undefined) {
      continue;
    }
  }
  const changed = [...files.values()];
  return changed
    .sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
    .map((file) => ({
      path: file.path,
      label: basename(file.path),
      additions: file.sawAdd ? file.additions : undefined,
      deletions: file.sawDel ? file.deletions : undefined,
      diff: file.diffs.length > 0 ? file.diffs.join("\n") : undefined,
    }));
}

function editSummaryLine(
  entries: readonly VisualWorkDisplayEntryLike[],
): string | undefined {
  const changed = changedFileSummary(entries);
  if (changed.length === 0) return undefined;
  const additions = changed.reduce(
    (sum, file) => sum + (file.additions ?? 0),
    0,
  );
  const deletions = changed.reduce(
    (sum, file) => sum + (file.deletions ?? 0),
    0,
  );
  const labels = uniqueSorted(changed.map((file) => file.label));
  const counts = changed.some(
    (file) => file.additions !== undefined || file.deletions !== undefined,
  )
    ? ` (+${additions} −${deletions})`
    : "";
  return `Changed ${changed.length} ${plural(changed.length, "file")}${counts}: ${joinPreview(labels)}`;
}

function remoteHosts(
  entries: readonly VisualWorkDisplayEntryLike[],
): string[] {
  return uniqueSorted(
    entries
      .map((entry) => visualToolRemoteHostLabel(toolUseBlock(entry)))
      .filter((host): host is string => !!host),
  );
}

function remoteSummaryLine(
  entries: readonly VisualWorkDisplayEntryLike[],
): string | undefined {
  const hosts = remoteHosts(entries);
  if (hosts.length === 0) return undefined;
  return `Accessed SSH: ${joinPreview(hosts)}`;
}

function artifactSummary(
  entries: readonly VisualWorkDisplayEntryLike[],
): VisualWorkArtifact[] {
  const artifacts = entries.flatMap(artifactsForEntry);
  const deduped = new Map<string, VisualWorkArtifact>();
  for (const artifact of artifacts) {
    const existing = deduped.get(artifact.id);
    deduped.set(
      artifact.id,
      existing ? mergeArtifact(existing, artifact) : artifact,
    );
  }
  return [...deduped.values()];
}

function responseSummaryLine(
  entries: readonly VisualWorkDisplayEntryLike[],
): string | undefined {
  const count = entries.filter(isAgentResponseEntry).length;
  return count > 0
    ? `Captured ${count} agent ${plural(count, "response")}`
    : undefined;
}

export function visualWorkOverview(
  item: VisualWorkItemLike,
  entries: readonly VisualWorkDisplayEntryLike[],
  options: VisualWorkOverviewOptions = {},
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
  const scopedItem =
    options.timeScope === "entries" ? itemScopedToEntries(item, entries) : item;
  const time = workTimeOverview(scopedItem, entries, safeNowMs);
  const tokens = tokenOverview(entries, time);
  const categories = actionCategoryCounts(entries);
  const changedFiles = changedFileSummary(entries);
  const hosts = remoteHosts(entries);
  const lines = [
    editSummaryLine(entries),
    commandSummaryLine(entries),
    responseSummaryLine(entries),
    remoteSummaryLine(entries),
  ].filter((line): line is string => !!line);
  return {
    lines,
    artifacts: artifactSummary(entries),
    time,
    tokenCount: tokens.total,
    tokens,
    actionCount: categories.reduce((sum, category) => sum + category.count, 0),
    responseCount: entries.filter(isAgentResponseEntry).length,
    categories,
    changedFiles,
    remoteHosts: hosts,
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

function visualWorkDisplayEntryGroupKey(
  entry: VisualWorkDisplayEntryLike,
): string {
  return String(entry.entry.messageIndex);
}

export function visualWorkDetailGroups<T extends VisualWorkDisplayEntryLike>(
  entries: readonly T[],
): VisualWorkDetailGroup<T>[] {
  const groups: VisualWorkDetailGroup<T>[] = [];
  let pendingActions: T[] = [];

  function flushActions(): void {
    if (pendingActions.length === 0) return;
    const first = pendingActions[0]!;
    const last = pendingActions[pendingActions.length - 1]!;
    groups.push({
      id: `actions:${visualWorkDisplayEntryGroupKey(first)}:${visualWorkDisplayEntryGroupKey(last)}`,
      kind: "actions",
      entries: pendingActions,
    });
    pendingActions = [];
  }

  for (const entry of entries) {
    if (!isAgentResponseEntry(entry)) {
      pendingActions.push(entry);
      continue;
    }
    flushActions();
    groups.push({
      id: `response:${visualWorkDisplayEntryGroupKey(entry)}`,
      kind: "response",
      entries: [entry],
    });
  }
  flushActions();
  return groups;
}
