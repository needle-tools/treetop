import type {
  MessageBlock,
  VisualFileEdit,
  VisualFileEditSummary,
  VisualMediaBlock,
} from "../last-user-message";

export interface VisualToolResultText {
  title: string;
  body: string;
  wrappedCodexChunk: boolean;
  wallTimeSeconds?: number;
  exitCode?: number;
  originalTokenCount?: number;
  processRunning?: boolean;
  processSessionId?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parsedToolResultPayload(output: string):
  | {
      output?: string;
      exitCode?: number;
      wallTimeSeconds?: number;
      originalTokenCount?: number;
      processSessionId?: number;
    }
  | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const exitCode = finiteNumber(parsed.exit_code);
    const wallTimeSeconds = finiteNumber(parsed.wall_time_seconds);
    const originalTokenCount = finiteNumber(parsed.original_token_count);
    const processSessionId = finiteNumber(parsed.session_id);
    return {
      output: typeof parsed.output === "string" ? parsed.output : undefined,
      exitCode,
      wallTimeSeconds,
      originalTokenCount,
      processSessionId,
    };
  } catch {
    return undefined;
  }
}

function sessionIdFromResultOutput(output: string): number | undefined {
  const match = output.match(/\bSESSION_ID=(\d+)\b/);
  if (!match) return undefined;
  const sessionId = Number.parseInt(match[1]!, 10);
  return Number.isFinite(sessionId) ? sessionId : undefined;
}

function commandResultTitle(
  output: string,
  exitCode: number | undefined,
  processRunning: boolean,
): string {
  if (processRunning)
    return output ? "Process output" : "Process still running";
  if (output) return "Command output";
  if (exitCode === 0) return "Command completed";
  if (exitCode !== undefined) return "Command failed";
  return "Command completed";
}

export function visualFileEditTotals(
  summary: VisualFileEditSummary | undefined,
): { additions?: number; deletions?: number } {
  if (!summary) return {};
  let additions = 0;
  let deletions = 0;
  let sawAdditions = false;
  let sawDeletions = false;
  for (const file of summary.files) {
    if (file.additions !== undefined) {
      additions += file.additions;
      sawAdditions = true;
    }
    if (file.deletions !== undefined) {
      deletions += file.deletions;
      sawDeletions = true;
    }
  }
  return {
    additions: sawAdditions ? additions : undefined,
    deletions: sawDeletions ? deletions : undefined,
  };
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
  const codexRunningChunk = trimmed.match(
    /^Chunk ID:\s+\S+\s+Wall time:\s+([\d.]+)\s+seconds\s+Process running with session ID\s+(\d+)(?:\s+Original token count:\s+(\d+))?\s+Output:\s*([\s\S]*)$/i,
  );
  const plainCommandResult = trimmed.match(
    /^Exit code:\s+(-?\d+)\s+Wall time:\s+([\d.]+)\s+seconds?\s+Output:\s*([\s\S]*)$/i,
  );
  const scriptCompletedResult = trimmed.match(
    /^Script completed\s+Wall time\s+([\d.]+)\s+seconds?\s+Output:\s*([\s\S]*)$/i,
  );
  const scriptRunningResult = trimmed.match(
    /^Script running with cell ID\s+\d+\s+Wall time\s+([\d.]+)\s+seconds?\s+Output:\s*([\s\S]*)$/i,
  );
  if (
    !codexChunk &&
    !codexRunningChunk &&
    !plainCommandResult &&
    !scriptCompletedResult &&
    !scriptRunningResult
  ) {
    return {
      title: "Tool result",
      body: trimmed,
      wrappedCodexChunk: false,
    };
  }

  if (codexRunningChunk) {
    const wallTimeSeconds = Number(codexRunningChunk[1]);
    const processSessionId = Number.parseInt(codexRunningChunk[2]!, 10);
    const output = (codexRunningChunk[4] ?? "").trim();
    return {
      title: output ? "Process output" : "Process still running",
      body: output,
      wrappedCodexChunk: true,
      wallTimeSeconds: Number.isFinite(wallTimeSeconds)
        ? wallTimeSeconds
        : undefined,
      originalTokenCount: codexRunningChunk[3]
        ? Number.parseInt(codexRunningChunk[3], 10)
        : undefined,
      processRunning: true,
      processSessionId: Number.isFinite(processSessionId)
        ? processSessionId
        : undefined,
    };
  }

  if (scriptRunningResult) {
    const wallTimeSeconds = Number(scriptRunningResult[1]);
    const output = (scriptRunningResult[2] ?? "").trim();
    const processSessionId = sessionIdFromResultOutput(output);
    return {
      title: output ? "Process output" : "Process still running",
      body: output,
      wrappedCodexChunk: true,
      wallTimeSeconds: Number.isFinite(wallTimeSeconds)
        ? wallTimeSeconds
        : undefined,
      processRunning: true,
      processSessionId,
    };
  }

  if (scriptCompletedResult) {
    const wrapperWallTimeSeconds = Number(scriptCompletedResult[1]);
    const rawOutput = (scriptCompletedResult[2] ?? "").trim();
    const payload = parsedToolResultPayload(rawOutput);
    const output = (payload?.output ?? rawOutput).trim();
    const processSessionId =
      payload?.processSessionId ?? sessionIdFromResultOutput(output);
    const processRunning =
      payload?.exitCode === undefined && processSessionId !== undefined;
    return {
      title: commandResultTitle(output, payload?.exitCode, processRunning),
      body: output,
      wrappedCodexChunk: true,
      wallTimeSeconds:
        payload?.wallTimeSeconds ??
        (Number.isFinite(wrapperWallTimeSeconds)
          ? wrapperWallTimeSeconds
          : undefined),
      exitCode: payload?.exitCode,
      originalTokenCount: payload?.originalTokenCount,
      processRunning: processRunning ? true : undefined,
      processSessionId,
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

export interface VisualObservedProcessOutput {
  title: string;
  preview: string;
  processSessionId?: number;
  wallTimeSeconds?: number;
}

export function visualObservedProcessOutput(
  toolUseBlock: MessageBlock | undefined,
  toolResultBlock: MessageBlock | undefined,
): VisualObservedProcessOutput | undefined {
  if ((toolUseBlock?.toolName ?? "").toLowerCase() !== "write_stdin") {
    return undefined;
  }
  if (toolResultBlock?.type !== "tool_result") return undefined;
  const result = cleanVisualToolResultText(toolResultBlock.text);
  if (!result.processRunning) return undefined;
  const preview = result.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!preview) return undefined;
  return {
    title: "Read logs",
    preview,
    processSessionId: result.processSessionId,
    wallTimeSeconds: result.wallTimeSeconds,
  };
}

function stringifyToolPayload(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function stringFromToolInputField(
  input: unknown,
  key: string,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    return value.map(String).join(" ");
  }
  return undefined;
}

function commandTextFromToolInput(
  input: unknown,
  toolName: string | undefined,
): string | undefined {
  return (
    stringFromToolInputField(input, "cmd") ??
    stringFromToolInputField(input, "command") ??
    commandFromToolInput(input, toolName)
  );
}

export function visualToolCallPayloadText(
  block: MessageBlock | undefined,
): string {
  if (!block || block.type !== "tool_use") return "";
  return stringifyToolPayload(block.toolInput);
}

export function visualToolCallPayloadLanguage(
  block: MessageBlock | undefined,
): string {
  if (!block || block.type !== "tool_use") return "text";
  return typeof block.toolInput === "string" ? "text" : "json";
}

export interface VisualToolInlineScript {
  language: string;
  title: string;
  code: string;
}

export function visualToolInlineScript(
  block: MessageBlock | undefined,
): VisualToolInlineScript | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const structuredScript = inlineScriptFromStructuredTool(
    block.toolName ?? "",
    block.toolInput,
  );
  if (structuredScript) return structuredScript;
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return undefined;
  return inlineScriptFromCommandPreservingHeredoc(command);
}

export function visualToolInlineScriptLanguageLabel(
  block: MessageBlock | undefined,
): string {
  const inlineScript = visualToolInlineScript(block);
  if (inlineScript) return inlineScriptLanguageLabel(inlineScript.language);
  if (!block || block.type !== "tool_use") return "";
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return "";
  const scriptFile = directScriptCommand(
    normalizeLaunchedCommand(command).command,
  );
  return scriptFile ? inlineScriptLanguageLabel(scriptFile.language) : "";
}

export function visualToolInlineScriptPreviewText(
  block: MessageBlock | undefined,
): string {
  const script = visualToolInlineScript(block);
  if (!script) return "";
  return inlineScriptPreviewText(script);
}

function inlineScriptPreviewText(script: VisualToolInlineScript): string {
  return script.code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

export function visualToolPreviewText(
  block: MessageBlock | undefined,
  context?: VisualToolPreviewContext,
): string {
  return visualToolPreviewParts(block, context)
    .map((part) => part.text)
    .join("");
}

export function visualToolIconNameForPreview(
  block: MessageBlock | undefined,
  preview = visualToolPreviewText(block),
): string | undefined {
  const toolName = (block?.toolName ?? "").toLowerCase();
  if (isImageGenerationToolName(toolName)) return "image_generation";
  if (toolName === "click" || toolName.endsWith(".click")) return "click";
  if (toolName === "take_screenshot" || toolName.endsWith(".take_screenshot"))
    return "take_screenshot";
  if (toolName === "take_snapshot" || toolName.endsWith(".take_snapshot"))
    return "take_snapshot";
  if (
    /^Check git\b/.test(preview) ||
    /^Check (?:staged )?diff whitespace\b/.test(preview) ||
    /^Review (?:staged )?diff\b/.test(preview) ||
    /^Search .* from \S+ for\b/.test(preview) ||
    /^Show (?:recent commits|current branch|current commit|HEAD)\b/.test(
      preview,
    ) ||
    /^Count commits\b/.test(preview) ||
    /^List tracked files\b/.test(preview) ||
    /^Stage\b/.test(preview) ||
    /^Commit changes\b/.test(preview) ||
    /^git\b/.test(preview)
  ) {
    return "git";
  }
  if (/^Search\b/.test(preview)) return "search";
  if (/^Read logs?\b/.test(preview)) return "read";
  if (/^Count\b/.test(preview)) return "read";
  if (/^Query JSON\b/.test(preview)) return "read";
  if (/^Process text\b/.test(preview)) return "read";
  if (/^Check listeners\b/.test(preview)) return "port_check";
  if (/^Query (?:PostgreSQL|MySQL|MariaDB|SQLite)\b/.test(preview))
    return "database";
  if (/^Run .*(?:tests|check)\b/.test(preview)) return "test";
  if (/^Reload page\b/.test(preview)) return "reload_page";
  if (/^Wait for\b/.test(preview)) return "wait_for";
  if (/^Check console\b/.test(preview)) return "list_console_messages";
  if (/^Check network requests\b/.test(preview)) return "list_network_requests";
  if (/^List browser pages\b/.test(preview)) return "list_pages";
  if (/^Capture browser snapshot\b/.test(preview)) return "take_snapshot";
  if (/^Capture browser screenshot\b/.test(preview)) return "take_screenshot";
  if (/^Click browser element\b/.test(preview)) return "click";
  if (/^Upload\b/.test(preview)) return "upload_file";
  if (/^Download\b/.test(preview)) return "download_file";
  if (/^Download from browser\b/.test(preview)) return "download_file";
  if (/^Read browser\b/.test(preview)) return "read_browser";
  if (/^Scroll browser\b/.test(preview)) return "scroll_browser";
  if (/^Run browser script\b/.test(preview)) return "evaluate_script";
  if (/^List screen sessions\b/.test(preview)) return "list";
  if (/^Emulate\b/.test(preview)) return "emulate";
  if (/^Open tunnel\b/.test(preview)) return "port_check";
  if (/^(?:Navigate to|Open|Open browser)\b/.test(preview))
    return "navigate_page";
  if (/^Check processes?\b/.test(preview)) return "process_check";
  if (/^Check containers?\b/.test(preview)) return "process_check";
  if (/^Stop process(?:es)?\b/.test(preview)) return "process_end";
  if (/^Check port(?:s)?\b/.test(preview)) return "port_check";
  if (/^Delete (?:file|folder|path)\b/.test(preview)) {
    return "filesystem_delete";
  }
  if (/^Create (?:file|folder|path)\b/.test(preview)) {
    return "filesystem_create";
  }
  if (/^Fetch\b/.test(preview)) return "fetch";
  if (/^(Configure|Build) CMake\b/.test(preview)) return "cmake";
  return block?.toolName;
}

export interface VisualToolResultBadge {
  label: string;
  tone: "neutral" | "danger" | "warning" | "success";
  title: string;
}

export type VisualToolPreviewPart =
  | { kind: "text"; text: string }
  | {
      kind: "path";
      text: string;
      path: string;
      range: string;
      diffKind?: "workdir" | "staged";
    };

export interface VisualToolPreviewContext {
  snapshotUidLabels?: ReadonlyMap<string, string>;
}

export function visualSnapshotUidLabelsFromToolResult(
  toolUseBlock: MessageBlock | undefined,
  toolResultBlock: MessageBlock | undefined,
): ReadonlyMap<string, string> | undefined {
  const toolName = (toolUseBlock?.toolName ?? "").toLowerCase();
  const isNativeSnapshotTool =
    toolName === "take_snapshot" || toolName.endsWith(".take_snapshot");
  const isAgentBrowserSnapshotCommand = /^Capture browser snapshot\b/.test(
    visualToolPreviewText(toolUseBlock),
  );
  if (!isNativeSnapshotTool && !isAgentBrowserSnapshotCommand) {
    return undefined;
  }
  if (!toolResultBlock || toolResultBlock.type !== "tool_result") {
    return undefined;
  }
  const labels = parseChromeSnapshotUidLabels(toolResultBlock.text ?? "");
  parseAgentBrowserSnapshotRefLabels(toolResultBlock.text ?? "", labels);
  return labels.size > 0 ? labels : undefined;
}

function parseChromeSnapshotUidLabels(text: string): Map<string, string> {
  const labels = new Map<string, string>();
  const linePattern =
    /\buid=([A-Za-z0-9_-]+)\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+"([^"]*)")?/g;
  for (const match of text.matchAll(linePattern)) {
    const uid = match[1];
    const role = match[2];
    const name = match[3]?.trim();
    if (!uid || !role) continue;
    const readableRole = chromeSnapshotRoleLabel(role);
    labels.set(uid, name ? `${readableRole} ${name}` : readableRole);
  }
  return labels;
}

function chromeSnapshotRoleLabel(role: string): string {
  return role
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function parseAgentBrowserSnapshotRefLabels(
  text: string,
  labels: Map<string, string>,
): void {
  const linePattern =
    /(^|\s)(@[A-Za-z][A-Za-z0-9_-]*)\s+\[([^\]\n]+)\](?:\s+"([^"\n]*)")?/g;
  for (const match of text.matchAll(linePattern)) {
    const ref = match[2];
    const role = match[3]?.trim();
    const name = match[4]?.trim();
    if (!ref || !role) continue;
    const readableRole = chromeSnapshotRoleLabel(role);
    labels.set(ref, name ? `${readableRole} ${name}` : readableRole);
  }
}

export function visualToolFetchResultBadges(
  toolUseBlock: MessageBlock | undefined,
  toolResultBlock: MessageBlock | undefined,
): VisualToolResultBadge[] {
  const fetchSummaries = visualToolFetchSummaries(toolUseBlock);
  if (fetchSummaries.length === 0) return [];
  if (!toolResultBlock || toolResultBlock.type !== "tool_result") return [];
  const result = cleanVisualToolResultText(toolResultBlock.text);
  if (!result.wrappedCodexChunk) return [];
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    return [
      {
        label: `exit ${result.exitCode}`,
        tone: "danger",
        title: result.body || "Fetch command failed",
      },
    ];
  }
  const writesToOutput = fetchSummaries.some((summary) => !!summary.output);
  const bytes = fetchResultByteCount(result.body, { writesToOutput });
  if (bytes !== undefined && bytes > 0) {
    return [
      {
        label: formatHumanBytes(bytes),
        tone: "neutral",
        title: `${bytes.toLocaleString()} bytes fetched`,
      },
    ];
  }
  if (result.processRunning) return [];
  if (writesToOutput) return [];
  return [
    {
      label: "no result",
      tone: "danger",
      title: "Fetch command completed without visible response data",
    },
  ];
}

export function visualToolTestResultBadges(
  toolUseBlock: MessageBlock | undefined,
  toolResultBlock: MessageBlock | undefined,
): VisualToolResultBadge[] {
  const testSummary = visualToolTestSummary(toolUseBlock);
  if (!testSummary) return [];
  if (!toolResultBlock || toolResultBlock.type !== "tool_result") return [];
  const result = cleanVisualToolResultText(toolResultBlock.text);
  if (!result.wrappedCodexChunk) return [];
  if (testSummary.runner === "Svelte") {
    const svelteBadges = svelteCheckResultBadges(result.body);
    if (svelteBadges.length > 0) return svelteBadges;
  }
  const summary = testResultSummary(result.body);
  const counts = summary.counts;
  const badges: VisualToolResultBadge[] = [];
  if (counts.failed > 0) {
    badges.push({
      label: `✕${counts.failed}`,
      tone: "danger",
      title: testBadgeTitle(
        counts.failed,
        "test",
        "failed",
        summary.details.failed,
      ),
    });
  } else if (result.exitCode !== undefined && result.exitCode !== 0) {
    badges.push({
      label: `exit ${result.exitCode}`,
      tone: "danger",
      title: "Test command failed",
    });
  }
  if (counts.warnings > 0) {
    badges.push({
      label: `⚠${counts.warnings}`,
      tone: "warning",
      title: testBadgeTitle(
        counts.warnings,
        "warning",
        "",
        summary.details.warnings,
      ),
    });
  }
  if (counts.passed > 0) {
    badges.push({
      label: `✓${counts.passed}`,
      tone: "success",
      title: testBadgeTitle(
        counts.passed,
        "test",
        "passed",
        summary.details.passed,
      ),
    });
  }
  if (counts.skipped > 0) {
    badges.push({
      label: `skip ${counts.skipped}`,
      tone: "neutral",
      title: testBadgeTitle(
        counts.skipped,
        "test",
        "skipped",
        summary.details.skipped,
      ),
    });
  }
  if (counts.todo > 0) {
    badges.push({
      label: `todo ${counts.todo}`,
      tone: "neutral",
      title: testBadgeTitle(counts.todo, "todo test", "", summary.details.todo),
    });
  }
  return badges;
}

function svelteCheckResultBadges(body: string): VisualToolResultBadge[] {
  const summary = body.match(
    /\bsvelte-check\s+found\s+(\d+)\s+errors?\s+and\s+(\d+)\s+warnings?/i,
  );
  let errors = summary ? Number.parseInt(summary[1]!, 10) : 0;
  let warnings = summary ? Number.parseInt(summary[2]!, 10) : 0;
  if (!summary) {
    errors = matchCount(body, /^Error:/gm);
    warnings = matchCount(body, /^Warn:/gm);
  }
  if (!summary && errors === 0 && warnings === 0) return [];
  const badges: VisualToolResultBadge[] = [];
  if (errors > 0) {
    badges.push({
      label: `✕${errors}`,
      tone: "danger",
      title: `${errors} Svelte ${plural(errors, "error")}`,
    });
  }
  if (warnings > 0) {
    badges.push({
      label: `⚠${warnings}`,
      tone: "warning",
      title: `${warnings} Svelte ${plural(warnings, "warning")}`,
    });
  }
  if (errors === 0 && warnings === 0) {
    badges.push({
      label: "✓",
      tone: "success",
      title: "No Svelte diagnostics",
    });
  }
  return badges;
}

export function visualToolCommandResultBadges(
  toolUseBlock: MessageBlock | undefined,
  toolResultBlock?: MessageBlock | undefined,
): VisualToolResultBadge[] {
  const summaries = visualToolCommandSummaries(toolUseBlock);
  const consoleBadges = commandConsoleResultBadges(
    toolUseBlock,
    summaries,
    toolResultBlock,
  );
  if (consoleBadges.length > 0) return consoleBadges;
  const searchBadge = commandSearchResultBadge(summaries, toolResultBlock);
  if (searchBadge) return [searchBadge];
  const infos = summaries
    .map(commandFileBadgeInfo)
    .filter((info): info is CommandFileBadgeInfo => !!info);
  if (infos.length === 0) return [];
  const count = infos.reduce((sum, info) => sum + info.count, 0);
  if (count <= 1) return [];
  const noun = sharedInfoValue(infos, "noun") ?? "path";
  const action = sharedInfoValue(infos, "action") ?? "touched";
  return [fileCountBadge(count, noun, action)];
}

interface ConsoleMessageCounts {
  errors: number;
  warnings: number;
}

function commandConsoleResultBadges(
  toolUseBlock: MessageBlock | undefined,
  summaries: readonly VisualCommandSummary[],
  toolResultBlock: MessageBlock | undefined,
): VisualToolResultBadge[] {
  const toolName = (toolUseBlock?.toolName ?? "").toLowerCase();
  const isConsoleTool =
    toolName === "list_console_messages" ||
    toolName.endsWith(".list_console_messages");
  const isConsoleCommand = summaries.some(
    (summary) => summary.kind === "browser" && summary.action === "console",
  );
  if (!isConsoleTool && !isConsoleCommand) return [];
  if (!toolResultBlock || toolResultBlock.type !== "tool_result") return [];

  const result = cleanVisualToolResultText(toolResultBlock.text);
  const counts = countConsoleMessages(
    result.body || toolResultBlock.text || "",
  );
  const badges: VisualToolResultBadge[] = [];
  if (counts.errors > 0) {
    badges.push({
      label: `✕${counts.errors}`,
      tone: "danger",
      title: `${counts.errors} console ${plural(counts.errors, "error")}`,
    });
  }
  if (counts.warnings > 0) {
    badges.push({
      label: `⚠${counts.warnings}`,
      tone: "warning",
      title: `${counts.warnings} console ${plural(counts.warnings, "warning")}`,
    });
  }
  return badges;
}

function countConsoleMessages(text: string): ConsoleMessageCounts {
  const jsonCounts = countConsoleMessagesFromJson(text);
  if (jsonCounts.errors > 0 || jsonCounts.warnings > 0) return jsonCounts;
  const lineCounts = countConsoleMessagesFromLines(text);
  return {
    errors: lineCounts.errors,
    warnings: lineCounts.warnings,
  };
}

function countConsoleMessagesFromJson(text: string): ConsoleMessageCounts {
  const counts: ConsoleMessageCounts = { errors: 0, warnings: 0 };
  for (const value of parseJsonCandidates(text)) {
    collectConsoleMessageTypes(value, counts);
  }
  return counts;
}

function parseJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const trimmed = text.trim();
  const seen = new Set<string>();
  for (const candidate of [
    trimmed,
    ...trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") || line.startsWith("[")),
    trimmed.slice(Math.max(0, trimmed.indexOf("{"))),
  ]) {
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      candidates.push(JSON.parse(candidate));
    } catch {
      // Console payloads are often embedded below command-wrapper prose.
    }
  }
  return candidates;
}

function collectConsoleMessageTypes(
  value: unknown,
  counts: ConsoleMessageCounts,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectConsoleMessageTypes(item, counts);
    return;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "error") counts.errors += 1;
  if (type === "warn" || type === "warning") counts.warnings += 1;
  if (typeof record.text === "string") {
    const textCounts = countConsoleMessagesFromLines(record.text);
    counts.errors += textCounts.errors;
    counts.warnings += textCounts.warnings;
  }
  for (const key of ["messages", "data", "result", "results"]) {
    collectConsoleMessageTypes(record[key], counts);
  }
}

function countConsoleMessagesFromLines(text: string): ConsoleMessageCounts {
  const counts: ConsoleMessageCounts = { errors: 0, warnings: 0 };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(?:^|\s)\[(error|warn|warning)\]/i);
    if (!match) continue;
    const type = match[1]!.toLowerCase();
    if (type === "error") counts.errors += 1;
    if (type === "warn" || type === "warning") counts.warnings += 1;
  }
  return counts;
}

function commandSearchResultBadge(
  summaries: readonly VisualCommandSummary[],
  toolResultBlock: MessageBlock | undefined,
): VisualToolResultBadge | undefined {
  if (
    !summaries.some(
      (summary) =>
        summary.kind === "search" ||
        (summary.kind === "git" && summary.action === "show-file-search"),
    )
  ) {
    return undefined;
  }
  if (!toolResultBlock || toolResultBlock.type !== "tool_result") {
    return undefined;
  }
  const result = cleanVisualToolResultText(toolResultBlock.text);
  if (!result.wrappedCodexChunk) return undefined;
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    return {
      label: `exit ${result.exitCode}`,
      tone: "danger",
      title: "Search command failed",
    };
  }
  const count = countVisibleResultLines(result.body);
  if (count === 0) {
    return {
      label: "no results",
      tone: "neutral",
      title: "Search returned no visible result lines",
    };
  }
  return {
    label: `${count} ${plural(count, "result")}`,
    tone: "neutral",
    title: `${count} visible search ${plural(count, "result")}`,
  };
}

function countVisibleResultLines(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

export function visualFileEditCountBadge(
  summary: VisualFileEditSummary | undefined,
): VisualToolResultBadge | undefined {
  if (!summary || summary.files.length <= 1) return undefined;
  return fileCountBadge(summary.files.length, "file", "edited");
}

interface CommandFileBadgeInfo {
  count: number;
  noun: "file" | "folder" | "path" | "image";
  action:
    | "staged"
    | "created"
    | "deleted"
    | "copied"
    | "moved"
    | "converted"
    | "edited"
    | "written"
    | "touched";
}

function visualToolCommandSummaries(
  block: MessageBlock | undefined,
): VisualCommandSummary[] {
  if (!block || block.type !== "tool_use") return [];
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return [];
  return visualCommandPreview(command).summaries;
}

function commandFileBadgeInfo(
  summary: VisualCommandSummary,
): CommandFileBadgeInfo | undefined {
  if (summary.kind === "git" && summary.action === "add") {
    const count = countDistinctTargets(summary.targets);
    return count > 0 ? { count, noun: "file", action: "staged" } : undefined;
  }
  if (summary.kind === "filesystem") {
    const count = countDistinctTargets(summary.targets);
    if (count === 0) return undefined;
    return {
      count,
      noun: summary.targetKind,
      action:
        summary.action === "create"
          ? "created"
          : summary.action === "delete"
            ? "deleted"
            : summary.action === "copy"
              ? "copied"
              : "moved",
    };
  }
  if (summary.kind === "image-transform") {
    return { count: 2, noun: "image", action: "converted" };
  }
  if (summary.kind === "fetch" && summary.output) {
    return { count: 1, noun: "file", action: "written" };
  }
  return undefined;
}

function countDistinctTargets(targets: string[]): number {
  return new Set(targets.filter(Boolean)).size;
}

function sharedInfoValue<K extends "noun" | "action">(
  infos: CommandFileBadgeInfo[],
  key: K,
): CommandFileBadgeInfo[K] | undefined {
  const first = infos[0]?.[key];
  return first && infos.every((info) => info[key] === first)
    ? first
    : undefined;
}

function fileCountBadge(
  count: number,
  noun: CommandFileBadgeInfo["noun"],
  action: CommandFileBadgeInfo["action"],
): VisualToolResultBadge {
  const labelNoun = plural(count, noun);
  return {
    label: `${count} ${labelNoun}`,
    tone: "neutral",
    title: `${count} ${labelNoun} ${action}`,
  };
}

function visualToolTestSummary(
  block: MessageBlock | undefined,
): Extract<VisualCommandSummary, { kind: "test" }> | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return undefined;
  return visualCommandPreview(command).summaries.find(
    (summary): summary is Extract<VisualCommandSummary, { kind: "test" }> =>
      summary.kind === "test",
  );
}

interface TestResultSummary {
  counts: TestResultCounts;
  details: Record<keyof TestResultCounts, string[]>;
}

interface TestResultCounts {
  passed: number;
  failed: number;
  warnings: number;
  skipped: number;
  todo: number;
}

function testResultSummary(body: string): TestResultSummary {
  const counts: TestResultCounts = {
    passed: 0,
    failed: 0,
    warnings: 0,
    skipped: 0,
    todo: 0,
  };
  const details: TestResultSummary["details"] = {
    passed: [],
    failed: [],
    warnings: [],
    skipped: [],
    todo: [],
  };
  const normalizedBody = stripAnsiEscapes(body);
  for (const line of normalizedBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    collectTestResultDetail(trimmed, details);
    const failed = countFromLine(trimmed, [
      /\b(\d+)\s+fail(?:ed|s)?\b/i,
      /\bfailed\s+(\d+)\b/i,
      /\b(\d+)\s+failed\b/i,
    ]);
    const passed = countFromLine(trimmed, [
      /\b(\d+)\s+pass(?:ed|es)?\b/i,
      /\bpassed\s+(\d+)\b/i,
      /\b(\d+)\s+passed\b/i,
    ]);
    const warnings = countFromLine(trimmed, [
      /\b(\d+)\s+warnings?\b/i,
      /\bwarnings?\s+(\d+)\b/i,
    ]);
    const skipped = countFromLine(trimmed, [
      /\b(\d+)\s+skip(?:ped|s)?\b/i,
      /\bskipped\s+(\d+)\b/i,
    ]);
    const todo = countFromLine(trimmed, [
      /\b(\d+)\s+todo(?:s)?\b/i,
      /\btodos?\s+(\d+)\b/i,
    ]);
    if (failed !== undefined) counts.failed = Math.max(counts.failed, failed);
    if (passed !== undefined) counts.passed = Math.max(counts.passed, passed);
    if (warnings !== undefined) {
      counts.warnings = Math.max(counts.warnings, warnings);
    }
    if (skipped !== undefined) {
      counts.skipped = Math.max(counts.skipped, skipped);
    }
    if (todo !== undefined) counts.todo = Math.max(counts.todo, todo);
  }
  counts.failed = Math.max(
    counts.failed,
    matchCount(normalizedBody, /^\s*\(fail\)/gm),
    matchCount(normalizedBody, /^\s*[✘×]\s+\d+\b/gm),
  );
  counts.passed = Math.max(
    counts.passed,
    matchCount(normalizedBody, /^\s*\(pass\)/gm),
    matchCount(normalizedBody, /^\s*[✓✔]\s+\d+\b/gm),
  );
  counts.skipped = Math.max(
    counts.skipped,
    matchCount(normalizedBody, /^\s*\(skip\)/gm),
    matchCount(normalizedBody, /^\s*-\s+\d+\b/gm),
  );
  counts.todo = Math.max(
    counts.todo,
    matchCount(normalizedBody, /^\s*\(todo\)/gm),
  );
  if (counts.warnings === 0) {
    counts.warnings = matchCount(normalizedBody, /\bwarning\b/gi);
  }
  return { counts, details };
}

function collectTestResultDetail(
  line: string,
  details: TestResultSummary["details"],
): void {
  const bun = line.match(/^\((pass|fail|skip|todo)\)\s+(.+)$/i);
  if (bun) {
    addTestDetail(details, testDetailKey(bun[1]!), bun[2]!);
    return;
  }

  const playwright = line.match(/^[✓✔✘×]\s+\d+\s+(.+?)(?:\s+\([^)]*\))?$/);
  if (playwright) {
    addTestDetail(
      details,
      /^[✓✔]/.test(line) ? "passed" : "failed",
      playwright[1]!,
    );
    return;
  }

  const vitest = line.match(/^[✓✔✘×]\s+(.+?)(?:\s+\d+ms)?$/);
  if (vitest) {
    addTestDetail(
      details,
      /^[✓✔]/.test(line) ? "passed" : "failed",
      vitest[1]!,
    );
    return;
  }

  const tap = line.match(/^(not\s+ok|ok)\s+\d+\s+-\s+(.+)$/i);
  if (tap) {
    addTestDetail(
      details,
      /^ok$/i.test(tap[1]!) ? "passed" : "failed",
      tap[2]!,
    );
    return;
  }

  const pytest = line.match(
    /^(\S+::\S.*?)\s+(PASSED|FAILED|SKIPPED|XFAIL|XPASS)\b/,
  );
  if (pytest) {
    const status = pytest[2]!.toUpperCase();
    addTestDetail(
      details,
      status === "PASSED"
        ? "passed"
        : status === "FAILED"
          ? "failed"
          : "skipped",
      pytest[1]!,
    );
    return;
  }

  if (/^(warn|warning):/i.test(line)) {
    addTestDetail(
      details,
      "warnings",
      line.replace(/^(warn|warning):\s*/i, ""),
    );
  }
}

function testDetailKey(value: string): keyof TestResultCounts {
  const normalized = value.toLowerCase();
  if (normalized === "pass") return "passed";
  if (normalized === "fail") return "failed";
  if (normalized === "skip") return "skipped";
  return "todo";
}

function addTestDetail(
  details: TestResultSummary["details"],
  key: keyof TestResultCounts,
  value: string,
): void {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned || details[key].includes(cleaned)) return;
  details[key].push(cleaned);
}

function testBadgeTitle(
  count: number,
  noun: string,
  verb: string,
  details: readonly string[],
): string {
  const base =
    verb.length > 0
      ? `${count} ${plural(count, noun)} ${verb}`
      : `${count} ${plural(count, noun)}`;
  if (details.length === 0) return base;
  const shown = details.slice(0, 12).map((detail) => `- ${detail}`);
  if (details.length > shown.length) {
    shown.push(`+ ${details.length - shown.length} more`);
  }
  return `${base}\n${shown.join("\n")}`;
}

function stripAnsiEscapes(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function countFromLine(
  line: string,
  patterns: readonly RegExp[],
): number | undefined {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function matchCount(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function visualToolFetchSummaries(
  block: MessageBlock | undefined,
): Extract<VisualCommandSummary, { kind: "fetch" }>[] {
  if (!block || block.type !== "tool_use") return [];
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return [];
  return visualCommandPreview(command).summaries.filter(
    (summary): summary is Extract<VisualCommandSummary, { kind: "fetch" }> =>
      summary.kind === "fetch",
  );
}

export function visualToolMediaBlocks(
  block: MessageBlock | undefined,
  resultBlock?: MessageBlock | undefined,
): VisualMediaBlock[] {
  if (!block || block.type !== "tool_use") return [];
  const out: VisualMediaBlock[] = [];
  const seen = new Set<string>();
  const cwd = absoluteLocalWorkingDirectoryFromToolInput(block.toolInput);
  let commandRunsRemotely = false;
  const addImagePath = (
    path: string | undefined,
    title?: string,
    pathCwd = cwd,
  ) => {
    const resolved = resolveLocalImagePathForMedia(path, pathCwd, {
      remote: commandRunsRemotely,
    });
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push({
      type: "media",
      mediaKind: "image",
      path: resolved,
      title: title ?? pathBasename(resolved),
      alt: title ?? pathBasename(resolved),
      toolName: block.toolName,
      toolUseId: block.toolUseId,
    });
  };

  const toolName = (block.toolName ?? "").toLowerCase();
  if (block.toolInput && typeof block.toolInput === "object") {
    const obj = block.toolInput as Record<string, unknown>;
    if (isImageGenerationToolName(toolName)) {
      addImagePath(
        stringField(obj, "savedPath") ??
          stringField(obj, "saved_path") ??
          stringField(obj, "filePath") ??
          stringField(obj, "file_path") ??
          stringField(obj, "path") ??
          stringField(obj, "output"),
        "Generated image",
      );
    } else if (
      toolName.includes("take_screenshot") ||
      toolName.includes("screenshot")
    ) {
      addImagePath(
        stringField(obj, "filePath") ??
          stringField(obj, "file_path") ??
          stringField(obj, "path"),
        "Screenshot",
      );
    } else if (toolName === "view_image" || toolName.endsWith(".view_image")) {
      addImagePath(
        stringField(obj, "path") ?? stringField(obj, "filePath"),
        "Image",
      );
    }
  }

  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  let commandResultCwd = cwd;
  if (command) {
    const preview = visualCommandPreview(command);
    commandRunsRemotely = !!preview.remoteHost;
    const mediaSummaries = visualCommandMediaSummaries(command, cwd);
    commandResultCwd =
      mediaSummaries.at(-1)?.cwd ?? localCommandFinalCwd(command, cwd);
    for (const { summary, cwd: summaryCwd } of mediaSummaries) {
      if (summary.kind === "image-transform") {
        addImagePath(summary.input, "Input image", summaryCwd);
        addImagePath(summary.output, "Output image", summaryCwd);
      } else if (summary.kind === "fetch") {
        addImagePath(summary.output, "Fetched image", summaryCwd);
      } else if (summary.kind === "browser" && summary.action === "upload") {
        addImagePath(
          summary.detail ?? summary.target,
          "Uploaded image",
          summaryCwd,
        );
      } else if (
        summary.kind === "browser" &&
        summary.action === "screenshot"
      ) {
        addImagePath(summary.target, "Screenshot", summaryCwd);
      }
    }
  }
  const resultImageTitle = isImageGenerationToolName(toolName)
    ? "Generated image"
    : "Screenshot";
  for (const path of imagePathsFromToolResult(resultBlock, {
    allowImageGeneration: isImageGenerationToolName(toolName),
  })) {
    addImagePath(path, resultImageTitle, commandResultCwd);
  }
  return out;
}

function absoluteLocalWorkingDirectoryFromToolInput(
  input: unknown,
): string | undefined {
  if (typeof input === "string") {
    const cwd = extractStringLiteralField(input, [
      "cwd",
      "workdir",
      "workingDirectory",
    ]);
    return cwd && isAbsoluteLocalFilePath(cwd) ? cwd : undefined;
  }
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const cwd =
    stringField(obj, "cwd") ??
    stringField(obj, "workdir") ??
    stringField(obj, "workingDirectory");
  return cwd && isAbsoluteLocalFilePath(cwd) ? cwd : undefined;
}

function commandFromToolInput(
  input: unknown,
  toolName: string | undefined,
): string | undefined {
  if (typeof input !== "string") return undefined;
  const embedded = extractStringLiteralField(input, ["cmd", "command"]);
  if (embedded) return embedded;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const normalizedTool = (toolName ?? "").toLowerCase();
  if (normalizedTool.includes("exec")) return trimmed;
  return undefined;
}

function extractStringLiteralField(
  source: string,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const field = `(?:["']${escapeRegExp(key)}["']|\\b${escapeRegExp(key)}\\b)`;
    const doubleQuoted = source.match(
      new RegExp(`${field}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`),
    );
    if (doubleQuoted?.[1]) return unescapeToolLiteral(doubleQuoted[1], '"');
    const singleQuoted = source.match(
      new RegExp(`${field}\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'`),
    );
    if (singleQuoted?.[1]) return unescapeToolLiteral(singleQuoted[1], "'");
    const templateQuoted = source.match(
      new RegExp(`${field}\\s*:\\s*\`((?:[^\`\\\\]|\\\\.)*)\``),
    );
    if (templateQuoted?.[1]) return unescapeToolLiteral(templateQuoted[1], "`");
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function unescapeToolLiteral(value: string, quote: string): string {
  if (quote === "`") {
    return value.replace(/\\`/g, "`").replace(/\\\\/g, "\\");
  }
  try {
    return JSON.parse(`${quote}${value}${quote}`);
  } catch {
    return value.replace(/\\(["'\\])/g, "$1");
  }
}

function visualCommandMediaSummaries(
  command: string,
  baseCwd: string | undefined,
): { summary: VisualCommandSummary; cwd: string | undefined }[] {
  const normalized = normalizeLaunchedCommand(command);
  if (normalized.remoteHost) {
    return visualCommandPreview(command).summaries.map((summary) => ({
      summary,
      cwd: baseCwd,
    }));
  }
  const parts = splitShellCommandChain(normalized.command);
  if (parts.length === 0) {
    return visualCommandPreview(command).summaries.map((summary) => ({
      summary,
      cwd: baseCwd,
    }));
  }
  let currentCwd = baseCwd;
  const summaries: {
    summary: VisualCommandSummary;
    cwd: string | undefined;
  }[] = [];
  for (const part of parts) {
    const next = normalizeLaunchedCommand(part);
    const tokens = shellTokens(next.command);
    const name = shellLauncherName(tokens[0] ?? "");
    if (name === "cd" || name === "chdir" || name === "set-location") {
      currentCwd = resolveLocalShellCwd(currentCwd, cdTargetFromTokens(tokens));
      continue;
    }
    const summary = summarizeShellCommand(next.command);
    if (summary) summaries.push({ summary, cwd: currentCwd });
  }
  if (summaries.length > 0) return summaries;
  return visualCommandPreview(command).summaries.map((summary) => ({
    summary,
    cwd: currentCwd,
  }));
}

function localCommandFinalCwd(
  command: string,
  baseCwd: string | undefined,
): string | undefined {
  const normalized = normalizeLaunchedCommand(command);
  if (normalized.remoteHost) return baseCwd;
  let currentCwd = baseCwd;
  for (const part of splitShellCommandChain(normalized.command)) {
    const next = normalizeLaunchedCommand(part);
    const tokens = shellTokens(next.command);
    const name = shellLauncherName(tokens[0] ?? "");
    if (name === "cd" || name === "chdir" || name === "set-location") {
      currentCwd = resolveLocalShellCwd(currentCwd, cdTargetFromTokens(tokens));
    }
  }
  return currentCwd;
}

function resolveLocalShellCwd(
  cwd: string | undefined,
  target: string | undefined,
): string | undefined {
  if (!target || target === "." || target === "./") return cwd;
  if (target === ".." && cwd) {
    return cwd.replace(/[\\/]+$/g, "").replace(/[\\/][^\\/]*$/, "") || cwd;
  }
  if (isAbsoluteLocalFilePath(target)) return target;
  if (!cwd || isAbsoluteOrSpecialPath(target)) return cwd;
  return joinRemotePath(cwd, target);
}

function resolveLocalImagePathForMedia(
  path: string | undefined,
  cwd: string | undefined,
  options: { remote: boolean },
): string | undefined {
  if (!path) return undefined;
  const trimmed = cleanImagePathCandidate(path);
  if (!trimmed || !looksLikeImagePath(trimmed)) return undefined;
  if (options.remote) return undefined;
  if (isAbsoluteLocalFilePath(trimmed)) return trimmed;
  if (!cwd || isAbsoluteOrSpecialPath(trimmed)) return undefined;
  return joinRemotePath(cwd, trimmed);
}

function cleanImagePathCandidate(path: string): string {
  return path
    .trim()
    .replace(/^[`'"]+/, "")
    .replace(/[`'",.;:)\]}]+$/, "");
}

function isAbsoluteLocalFilePath(path: string): boolean {
  return (
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)
  );
}

function imagePathsFromToolResult(
  block: MessageBlock | undefined,
  opts: { allowImageGeneration?: boolean } = {},
): string[] {
  if (!block || block.type !== "tool_result" || !block.text) return [];
  const cleaned = cleanVisualToolResultText(block.text);
  const text = `${cleaned.body}\n${block.text}`;
  if (
    !/\b(?:screenshot|snapshot|image)\b/i.test(text) &&
    !opts.allowImageGeneration
  )
    return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (path: string | undefined) => {
    if (!path) return;
    const trimmed = path
      .trim()
      .replace(/^[`'"]+/, "")
      .replace(/[`'",.;:)\]}]+$/, "");
    if (!trimmed || seen.has(trimmed) || !looksLikeImagePath(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  const patterns = [
    /\b(?:screenshot|snapshot|image)\s+(?:saved|written|captured|created)\s+to\s+(.+?\.(?:png|jpe?g|webp|gif|avif))(?:\s|$|["'`),.;:\]}])/gi,
    /\bsaved\s+(?:screenshot|snapshot|image)\s+to\s+(.+?\.(?:png|jpe?g|webp|gif|avif))(?:\s|$|["'`),.;:\]}])/gi,
    /["'](?:filePath|file_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpe?g|webp|gif|avif))["']/gi,
    /["'](?:savedPath|saved_path|output)["']\s*:\s*["']([^"']+\.(?:png|jpe?g|webp|gif|avif))["']/gi,
  ] as const;

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      push(match[1]);
    }
  }
  return out;
}

function isImageGenerationToolName(toolName: string): boolean {
  return (
    toolName === "image_generation_call" ||
    toolName.endsWith(".image_generation_call") ||
    toolName.includes("image_generation") ||
    toolName.includes("imagegeneration")
  );
}

function fetchResultByteCount(
  body: string,
  opts: { writesToOutput: boolean },
): number | undefined {
  const contentLength = body.match(/^content-length:\s*(\d+)\s*$/im)?.[1];
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (opts.writesToOutput) return undefined;
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  return new TextEncoder().encode(trimmed).byteLength;
}

function formatHumanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

export function visualToolPreviewParts(
  block: MessageBlock | undefined,
  context?: VisualToolPreviewContext,
): VisualToolPreviewPart[] {
  if (!block || block.type !== "tool_use") return [];
  const name = (block.toolName ?? "").toLowerCase();
  const input = block.toolInput;
  const structuredInlineScript = inlineScriptFromStructuredTool(
    block.toolName ?? "",
    input,
  );
  if (structuredInlineScript) {
    return textPreviewParts(inlineScriptPreviewText(structuredInlineScript));
  }
  const structuredPreview = visualStructuredToolPreviewParts(
    name,
    input,
    context,
  );
  if (structuredPreview) return structuredPreview;
  const command = commandTextFromToolInput(input, block.toolName);
  const commandParts = command
    ? splitShellCommandChain(normalizeLaunchedCommand(command).command)
    : [];
  const commandHasHeredoc = command
    ? /(?:^|\s)(?:python3?|node|bun|deno|swift|ruby|perl)\b[\s\S]*?<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(
        command,
      )
    : false;
  const inlineScript = command
    ? commandHasHeredoc || commandParts.length <= 1
      ? inlineScriptFromCommandPreservingHeredoc(command)
      : undefined
    : undefined;
  if (inlineScript && command && agentBrowserEvalScriptFromCommand(command)) {
    const commandPreview = visualCommandPreview(command, context);
    if (commandPreview && commandPreview.parts.length > 0) {
      return commandPreview.parts;
    }
  }
  if (inlineScript)
    return textPreviewParts(visualToolInlineScriptPreviewText(block));
  const commandPreview = command
    ? visualCommandPreview(command, context)
    : undefined;
  if (commandPreview && commandPreview.parts.length > 0) {
    return commandPreview.parts;
  }
  const text =
    command &&
    (name.includes("bash") || name.includes("shell") || name.includes("exec"))
      ? normalizeLaunchedCommand(command).command
      : stringifyToolPayload(input);
  return textPreviewParts(text.replace(/\s+/g, " ").trim());
}

export interface VisualToolApprovalBadge {
  label: string;
  title: string;
  tone: "approved" | "denied" | "neutral";
}

export function visualToolApprovalBadge(
  block: MessageBlock | undefined,
): VisualToolApprovalBadge | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const name = (block.toolName ?? "").toLowerCase();
  if (name !== "exec_command" && name !== "apply_patch") return undefined;
  const decision =
    block.approvalDecision ??
    stringFromToolInputField(block.toolInput, "approvalDecision") ??
    stringFromToolInputField(block.toolInput, "approvalStatus") ??
    stringFromToolInputField(block.toolInput, "decision");
  const policy =
    block.approvalPolicy ??
    stringFromToolInputField(block.toolInput, "approvalPolicy") ??
    stringFromToolInputField(block.toolInput, "approval_policy");
  const sandbox =
    block.sandboxPolicy ??
    stringFromToolInputField(block.toolInput, "sandboxPolicy") ??
    stringFromToolInputField(block.toolInput, "sandbox_policy");
  const normalizedDecision = decision?.toLowerCase();
  const normalizedPolicy = policy?.toLowerCase();
  const details = [
    policy ? `Approval policy: ${policy}` : undefined,
    decision ? `Decision: ${decision}` : undefined,
    sandbox ? `Sandbox: ${sandbox}` : undefined,
  ].filter((value): value is string => !!value);
  if (
    normalizedDecision === "approved" ||
    normalizedDecision === "approve" ||
    normalizedDecision === "accept"
  ) {
    return {
      label: "approved by you",
      title: details.join("\n") || "Command approved by you",
      tone: "approved",
    };
  }
  if (
    normalizedDecision === "approved_for_session" ||
    normalizedDecision === "acceptforsession" ||
    normalizedDecision === "accept_for_session"
  ) {
    return {
      label: "approved for session",
      title: details.join("\n") || "Command approved for this session",
      tone: "approved",
    };
  }
  if (
    normalizedDecision === "denied" ||
    normalizedDecision === "declined" ||
    normalizedDecision === "decline" ||
    normalizedDecision === "reject" ||
    normalizedDecision === "rejected"
  ) {
    return {
      label: "denied by you",
      title: details.join("\n") || "Command denied by you",
      tone: "denied",
    };
  }
  if (normalizedPolicy === "never") {
    return undefined;
  }
  if (normalizedPolicy === "on-request") {
    return {
      label: "asks first",
      title: details.join("\n") || "Command approval policy: on-request",
      tone: "neutral",
    };
  }
  if (normalizedPolicy === "on-failure") {
    return {
      label: "asks on failure",
      title: details.join("\n") || "Command approval policy: on-failure",
      tone: "neutral",
    };
  }
  if (policy || decision || sandbox) {
    return {
      label: "approval noted",
      title: details.join("\n") || "Command approval metadata present",
      tone: "neutral",
    };
  }
  return undefined;
}

export function visualToolLauncherLabel(
  block: MessageBlock | undefined,
): string | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return undefined;
  return normalizeLaunchedCommand(command).launcher;
}

export function visualToolRemoteHostLabel(
  block: MessageBlock | undefined,
): string | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return undefined;
  const normalized = normalizeLaunchedCommand(command);
  if (normalized.remoteHost) return normalized.remoteHost;
  const transfer = visualCommandPreview(command).summaries.find(
    (
      summary,
    ): summary is Extract<VisualCommandSummary, { kind: "remote-transfer" }> =>
      summary.kind === "remote-transfer",
  );
  return transfer?.host;
}

export interface VisualToolEnvAssignment {
  name: string;
  value: string;
}

export interface VisualToolConfigAssignment {
  name: string;
  value: string;
}

export function visualToolEnvAssignments(
  block: MessageBlock | undefined,
): VisualToolEnvAssignment[] {
  if (!block || block.type !== "tool_use") return [];
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return [];
  return visualCommandPreview(command).env;
}

export function visualToolEnvSummaryLabel(
  block: MessageBlock | undefined,
): string {
  return visualToolEnvAssignments(block).length > 0 ? "ENV" : "";
}

export function visualToolEnvTooltipText(
  block: MessageBlock | undefined,
): string {
  return visualToolEnvAssignments(block)
    .map((item) => `${item.name}=${item.value}`)
    .join("\n");
}

export function visualToolConfigAssignments(
  block: MessageBlock | undefined,
): VisualToolConfigAssignment[] {
  if (!block || block.type !== "tool_use") return [];
  const command = commandTextFromToolInput(block.toolInput, block.toolName);
  if (!command) return [];
  return cmakeFlagAssignmentsFromCommand(command);
}

export function visualToolConfigSummaryLabel(
  block: MessageBlock | undefined,
): string {
  const count = visualToolConfigAssignments(block).length;
  return count > 0 ? `${count} ${plural(count, "FLAG").toUpperCase()}` : "";
}

export function visualToolConfigTooltipText(
  block: MessageBlock | undefined,
): string {
  return visualToolConfigAssignments(block)
    .map((item) => `${item.name}=${item.value}`)
    .join("\n");
}

export function shouldShowLiveWorkTimer(opts: {
  active: boolean;
  open: boolean;
  endedAt?: string;
  tail?: boolean;
}): boolean {
  return opts.active && opts.open && !opts.endedAt && opts.tail !== false;
}

export function shouldShowLiveToolTimer(opts: {
  active: boolean;
  open: boolean;
  endedAt?: string;
  hasFinalResult: boolean;
  canStillRun?: boolean;
}): boolean {
  return (
    opts.active &&
    opts.open &&
    !opts.endedAt &&
    !opts.hasFinalResult &&
    opts.canStillRun !== false
  );
}

export function visualToolCanStillRun(
  block: MessageBlock | undefined,
): boolean {
  if (!block || block.type !== "tool_use") return false;
  const name = (block.toolName ?? "").toLowerCase();
  if (name === "file change" || name === "file_change") return false;
  if (name === "view_image" || name.endsWith(".view_image")) return false;
  return true;
}

type VisualCommandSummary =
  | { kind: "read"; targets: string[] }
  | { kind: "directory"; targets: string[] }
  | { kind: "logs"; targets: string[]; tailLines?: number }
  | { kind: "search"; pattern: string; paths: string[] }
  | { kind: "find"; root: string; patterns: string[] }
  | { kind: "batch-files"; tool: string; targets: string[] }
  | {
      kind: "count";
      metric: "lines" | "bytes" | "words" | "chars" | "items";
      targets: string[];
    }
  | { kind: "size"; targets: string[] }
  | { kind: "json-query"; filter: string; targets: string[]; source?: string }
  | {
      kind: "text-process";
      tool: "awk";
      expression: string;
      targets: string[];
      source?: string;
    }
  | { kind: "script-file"; language: string; script: string; args: string[] }
  | { kind: "process-check"; pattern?: string; pids?: string[] }
  | { kind: "container-check"; pattern?: string }
  | {
      kind: "git";
      action:
        | "status"
        | "diff"
        | "diff-stat"
        | "diff-check"
        | "show"
        | "show-file"
        | "show-file-search"
        | "ls-files"
        | "log"
        | "branch"
        | "rev-parse"
        | "rev-list-count"
        | "check-ignore"
        | "add"
        | "commit";
      targets: string[];
      rev?: string;
      pattern?: string;
      staged?: boolean;
    }
  | {
      kind: "test";
      runner:
        | "Bun"
        | "Vitest"
        | "npm"
        | "Pytest"
        | "Playwright"
        | "Shell"
        | "TypeScript"
        | "Svelte";
      targets: string[];
      check?: boolean;
    }
  | { kind: "process-end"; pids: string[] }
  | { kind: "drive-check" }
  | { kind: "port-check"; ports: string[] }
  | { kind: "ssh-tunnel"; local: string; remote: string }
  | {
      kind: "remote-transfer";
      action: "upload" | "download";
      host: string;
      local: string;
      remotePath: string;
    }
  | { kind: "screen-sessions" }
  | { kind: "listener-check"; terms: string[] }
  | { kind: "wait"; seconds: string }
  | {
      kind: "wait-url";
      url: string;
      attempts?: number;
      intervalSeconds?: number;
    }
  | {
      kind: "database";
      engine: "PostgreSQL" | "MySQL" | "MariaDB" | "SQLite";
      database?: string;
      query?: string;
    }
  | {
      kind: "browser";
      action:
        | "open"
        | "close"
        | "snapshot"
        | "screenshot"
        | "click"
        | "upload"
        | "download"
        | "fill"
        | "press"
        | "wait"
        | "get"
        | "scroll"
        | "console"
        | "network"
        | "pages"
        | "reload"
        | "emulate"
        | "script";
      target?: string;
      targetLabel?: string;
      detail?: string;
    }
  | { kind: "fetch"; url: string; output?: string }
  | { kind: "image-transform"; input: string; output: string }
  | {
      kind: "cmake";
      action: "configure" | "build";
      source?: string;
      build?: string;
      generator?: string;
    }
  | {
      kind: "filesystem";
      action: "create" | "delete" | "copy" | "move";
      targetKind: "file" | "folder" | "path";
      targets: string[];
    };

function textPreviewParts(text: string): VisualToolPreviewPart[] {
  return text ? [{ kind: "text", text }] : [];
}

function visualStructuredToolPreviewParts(
  toolName: string,
  input: unknown,
  context?: VisualToolPreviewContext,
): VisualToolPreviewPart[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const obj = input as Record<string, unknown>;
  if (isImageGenerationToolName(toolName)) {
    return textPreviewParts("Generate image");
  }
  if (
    toolName === "read_thread_terminal" ||
    toolName.endsWith(".read_thread_terminal")
  ) {
    return textPreviewParts("Read terminal output");
  }
  if (toolName.includes("evaluate_script")) {
    const fn = stringField(obj, "function");
    if (fn) return textPreviewParts("Run browser script");
  }
  if (toolName === "list_pages" || toolName.endsWith(".list_pages")) {
    return textPreviewParts("List browser pages");
  }
  if (toolName === "emulate" || toolName.endsWith(".emulate")) {
    const mode =
      stringField(obj, "networkConditions") ??
      stringField(obj, "viewport") ??
      stringField(obj, "colorScheme") ??
      (obj.userAgent !== undefined ? "user agent" : undefined) ??
      (obj.geolocation !== undefined ? "geolocation" : undefined);
    return textPreviewParts(mode ? `Emulate ${mode}` : "Emulate browser");
  }
  if (
    toolName === "navigate_page" ||
    toolName === "new_page" ||
    toolName.endsWith(".navigate_page") ||
    toolName.endsWith(".new_page")
  ) {
    const url = stringField(obj, "url");
    const type = stringField(obj, "type");
    if (url)
      return textPreviewParts(
        `${toolName.includes("new_page") ? "Open" : "Navigate to"} ${shortUrlForPreview(url)}`,
      );
    if (type) return textPreviewParts(browserNavigationPreview(type));
  }
  if (
    toolName === "list_console_messages" ||
    toolName.endsWith(".list_console_messages")
  ) {
    return textPreviewParts(consoleMessagesPreview(obj));
  }
  if (
    toolName === "list_network_requests" ||
    toolName.endsWith(".list_network_requests")
  ) {
    return textPreviewParts(networkRequestsPreview(obj));
  }
  if (toolName === "wait_for" || toolName.endsWith(".wait_for")) {
    const textValues = Array.isArray(obj.text)
      ? obj.text.filter((value): value is string => typeof value === "string")
      : [];
    if (textValues.length > 0) {
      return textPreviewParts(`Wait for ${textValues.join(", ")}`);
    }
    const singleText = stringField(obj, "text");
    if (singleText) return textPreviewParts(`Wait for ${singleText}`);
    return textPreviewParts("Wait for page text");
  }
  if (toolName === "click" || toolName.endsWith(".click")) {
    const uid = stringField(obj, "uid");
    const dblClick =
      booleanField(obj, "dblClick") ?? booleanField(obj, "doubleClick");
    const label = dblClick ? "Double-click element" : "Click element";
    const target = uid ? context?.snapshotUidLabels?.get(uid) : undefined;
    if (target) {
      const action = dblClick ? "Double-click" : "Click";
      return textPreviewParts(`${action} ${target}`);
    }
    return textPreviewParts(uid ? `${label} ${uid}` : label);
  }
  if (toolName === "take_screenshot" || toolName.endsWith(".take_screenshot")) {
    const output =
      stringField(obj, "filePath") ?? stringField(obj, "file_path");
    if (output) {
      return [
        { kind: "text", text: "Capture screenshot " },
        ...interspersePathParts([output]),
      ];
    }
    return textPreviewParts("Capture screenshot");
  }
  if (toolName === "take_snapshot" || toolName.endsWith(".take_snapshot")) {
    const output =
      stringField(obj, "filePath") ?? stringField(obj, "file_path");
    if (output) {
      return [
        { kind: "text", text: "Capture snapshot " },
        ...interspersePathParts([output]),
      ];
    }
    return textPreviewParts("Capture snapshot");
  }
  if (toolName === "view_image" || toolName.endsWith(".view_image")) {
    const imagePath = stringField(obj, "path") ?? stringField(obj, "filePath");
    if (imagePath) {
      return [
        { kind: "text", text: "View image " },
        ...interspersePathParts([imagePath]),
      ];
    }
    return textPreviewParts("View image");
  }
  const path = stringField(obj, "file_path") ?? stringField(obj, "path");
  if (path && /\bread\b|read_file|view_file/.test(toolName)) {
    return readPreviewParts([pathWithRange(path, obj)]);
  }

  const pattern = stringField(obj, "pattern") ?? stringField(obj, "query");
  if (
    pattern &&
    (toolName.includes("grep") ||
      toolName.includes("search") ||
      toolName.includes("rg"))
  ) {
    const paths = [
      stringField(obj, "path"),
      stringField(obj, "cwd"),
      stringField(obj, "workdir"),
    ].filter((value): value is string => !!value);
    return searchPreviewParts(pattern, paths);
  }

  return undefined;
}

function browserNavigationPreview(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized === "reload") return "Reload page";
  if (normalized === "back") return "Go back";
  if (normalized === "forward") return "Go forward";
  return `Navigate ${type}`;
}

function consoleMessagesPreview(obj: Record<string, unknown>): string {
  const rawTypes = Array.isArray(obj.types)
    ? obj.types.filter((value): value is string => typeof value === "string")
    : [];
  const types = new Set(rawTypes.map((value) => value.toLowerCase()));
  if (types.size === 0) return "Check console messages";
  if (types.has("warn") && types.has("error")) {
    return "Check console for warnings and errors";
  }
  if (types.has("error")) return "Check console for errors";
  if (types.has("warn")) return "Check console for warnings";
  return `Check console ${rawTypes.join(", ")}`;
}

function networkRequestsPreview(obj: Record<string, unknown>): string {
  const rawTypes = Array.isArray(obj.resourceTypes)
    ? obj.resourceTypes.filter(
        (value): value is string => typeof value === "string" && !!value.trim(),
      )
    : [];
  if (rawTypes.length === 0) return "Check network requests";
  return `Check network requests for ${humanList(
    rawTypes.map(networkResourceLabel),
  )}`;
}

function networkResourceLabel(type: string): string {
  const normalized = type.trim().toLowerCase();
  if (normalized === "xhr") return "XHR";
  if (normalized === "websocket") return "WebSockets";
  if (normalized === "document") return "documents";
  if (normalized === "stylesheet") return "stylesheets";
  if (normalized === "script") return "scripts";
  if (normalized === "image") return "images";
  if (normalized === "font") return "fonts";
  if (normalized === "fetch") return "fetch";
  return type.trim();
}

function humanList(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = obj[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function shortUrlForPreview(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length <= 96) return trimmed;
  return `${trimmed.slice(0, 93)}...`;
}

function numberField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function pathWithRange(path: string, obj: Record<string, unknown>): string {
  const start =
    numberField(obj, "line") ??
    numberField(obj, "start_line") ??
    numberField(obj, "startLine") ??
    numberField(obj, "offset");
  const explicitEnd =
    numberField(obj, "end_line") ?? numberField(obj, "endLine");
  const limit = numberField(obj, "limit");
  const end =
    explicitEnd ??
    (start !== undefined && limit !== undefined
      ? Math.max(start, start + limit - 1)
      : undefined);
  if (start === undefined) return path;
  if (end === undefined || end === start) return `${path}:${start}`;
  return `${path}:${start}-${end}`;
}

function parsePathTarget(target: string): { path: string; range: string } {
  const trimmed = target.trim();
  const match = trimmed.match(/^(.*?)(:\d+(?:-\d+)?)$/);
  if (!match) return { path: trimmed, range: "" };
  return { path: match[1]!, range: match[2]! };
}

function pathSegments(path: string): string[] {
  const cleaned = path.replace(/[\\/]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return [cleaned];
  const segments = cleaned.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 ? segments : [cleaned];
}

function pathBasename(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? path;
}

function shortestUniquePathSuffix(
  path: string,
  peers: readonly string[],
): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return segments[0] ?? path;
  for (let depth = 2; depth <= segments.length; depth += 1) {
    const suffix = segments.slice(-depth).join("/");
    const unique = peers.every((peer) => {
      if (peer === path) return true;
      return pathSegments(peer).slice(-depth).join("/") !== suffix;
    });
    if (unique) return suffix;
  }
  return segments.join("/");
}

const PARENT_CONTEXT_BASENAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "Dockerfile",
  "package.json",
  "README.md",
  "SKILL.md",
  "tsconfig.json",
]);

function basenameNeedsParentContext(base: string): boolean {
  return (
    PARENT_CONTEXT_BASENAMES.has(base) ||
    /^\+(?:page|layout|server|error)(?:\.[^.]+)*$/.test(base)
  );
}

function parentContextPathSuffix(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return segments[0] ?? path;
  return segments.slice(-2).join("/");
}

function globContextPathSuffix(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 3) return segments.join("/");
  return segments.slice(-3).join("/");
}

interface FormattedPathTarget {
  label: string;
  path: string;
  range: string;
}

function formatPathTargetParts(
  targets: readonly string[],
): FormattedPathTarget[] {
  const parsed = targets.map(parsePathTarget);
  const distinctPathsByBase = new Map<string, Set<string>>();
  for (const item of parsed) {
    const base = pathBasename(item.path);
    if (!distinctPathsByBase.has(base))
      distinctPathsByBase.set(base, new Set());
    distinctPathsByBase.get(base)!.add(item.path);
  }
  return parsed.map((item) => {
    const base = pathBasename(item.path);
    const ambiguousPaths = [...(distinctPathsByBase.get(base) ?? [])];
    const label =
      ambiguousPaths.length > 1
        ? shortestUniquePathSuffix(item.path, ambiguousPaths)
        : /[*?[]/.test(item.path)
          ? globContextPathSuffix(item.path)
          : basenameNeedsParentContext(base)
            ? parentContextPathSuffix(item.path)
            : base;
    return {
      label: `${label}${item.range}`,
      path: item.path,
      range: item.range,
    };
  });
}

export function visualPathPreviewTargets(
  targets: readonly string[],
): Extract<VisualToolPreviewPart, { kind: "path" }>[] {
  return formatPathTargetParts(targets).map((target) => ({
    kind: "path",
    text: target.label,
    path: target.path,
    range: target.range,
  }));
}

function interspersePathParts(
  targets: readonly string[],
  options?: { diffKind?: "workdir" | "staged" },
): VisualToolPreviewPart[] {
  const formatted = visualPathPreviewTargets(targets).map((target) =>
    options?.diffKind ? { ...target, diffKind: options.diffKind } : target,
  );
  return formatted.flatMap((target, index): VisualToolPreviewPart[] => {
    const prefix: VisualToolPreviewPart[] =
      index === 0 ? [] : [{ kind: "text", text: ", " }];
    return [...prefix, target];
  });
}

function readPreviewParts(targets: readonly string[]): VisualToolPreviewPart[] {
  return [{ kind: "text", text: "Read " }, ...interspersePathParts(targets)];
}

function directoryPreviewParts(
  targets: readonly string[],
): VisualToolPreviewPart[] {
  return [
    {
      kind: "text",
      text: targets.length === 1 ? "Read directory " : "Read directories ",
    },
    ...interspersePathParts(targets),
  ];
}

function searchPreviewParts(
  pattern: string,
  paths: readonly string[],
): VisualToolPreviewPart[] {
  return [
    { kind: "text", text: "Search " },
    ...(paths.length
      ? [...interspersePathParts(paths), { kind: "text" as const, text: " " }]
      : []),
    { kind: "text", text: `for "${readableSearchPattern(pattern)}"` },
  ];
}

function findPreviewParts(summary: {
  root: string;
  patterns: string[];
}): VisualToolPreviewPart[] {
  const patterns = summary.patterns.map(readableFindPattern);
  const rootParts = interspersePathParts([summary.root]);
  if (patterns.length === 0) {
    return [{ kind: "text", text: "Read directory " }, ...rootParts];
  }
  return [
    { kind: "text", text: `Find ${patterns.join(", ")} in ` },
    ...rootParts,
  ];
}

function visualCommandPreview(
  command: string,
  context?: VisualToolPreviewContext,
): {
  text: string;
  parts: VisualToolPreviewPart[];
  launcher?: string;
  remoteHost?: string;
  env: VisualToolEnvAssignment[];
  summaries: VisualCommandSummary[];
} {
  const normalized = normalizeLaunchedCommand(command);
  const unwrapped = normalized.command;
  const env = [...normalized.env];
  const delayedCommand = splitLeadingSleepPrefix(unwrapped);
  if (delayedCommand) {
    const delayedPreview = visualCommandPreview(
      delayedCommand.command,
      context,
    );
    if (
      delayedPreview.summaries.length > 0 ||
      delayedPreview.parts.length > 0
    ) {
      const waitSummary: Extract<VisualCommandSummary, { kind: "wait" }> = {
        kind: "wait",
        seconds: delayedCommand.seconds,
      };
      const summaries = [waitSummary, ...delayedPreview.summaries];
      const parts = summaries.flatMap(
        (summary, index): VisualToolPreviewPart[] => [
          ...(index === 0 ? [] : [{ kind: "text" as const, text: " · " }]),
          ...commandSummaryParts(summary, context),
        ],
      );
      return {
        text: parts.map((part) => part.text).join(""),
        parts,
        launcher: normalized.launcher ?? delayedPreview.launcher,
        remoteHost: normalized.remoteHost ?? delayedPreview.remoteHost,
        env: [...env, ...delayedPreview.env],
        summaries,
      };
    }
  }
  const waitSummary = summarizeWaitFetchLoop(unwrapped);
  if (waitSummary) {
    const parts = commandSummaryParts(waitSummary);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries: [waitSummary],
    };
  }
  const fileLoopSummary = summarizeFileLoop(unwrapped);
  if (fileLoopSummary) {
    const parts = commandSummaryParts(fileLoopSummary);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries: [fileLoopSummary],
    };
  }
  const parts = splitShellCommandChain(unwrapped);
  if (parts.length === 0) {
    return {
      text: "",
      parts: [],
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries: [],
    };
  }
  if (parts.length === 1) {
    const pipeSummary = summarizePipeCommand(unwrapped);
    if (pipeSummary) {
      const previewParts = commandSummaryParts(pipeSummary);
      return {
        text: previewParts.map((part) => part.text).join(""),
        parts: previewParts,
        launcher: normalized.launcher,
        remoteHost: normalized.remoteHost,
        env,
        summaries: [pipeSummary],
      };
    }
  }
  const remoteContextCwd = normalized.remoteHost
    ? shellContextCwd(parts)
    : undefined;
  const meaningfulParts = parts.filter(
    (part) =>
      !isShellContextCommand(part) &&
      !(parts.length > 1 && isShellSetupWaitCommand(part)) &&
      !(parts.length > 1 && isShellSetupProbeCommand(part)),
  );
  if (meaningfulParts.length === 0) {
    return {
      text: "",
      parts: [],
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
      summaries: [],
    };
  }
  const normalizedParts = meaningfulParts.map((part) => {
    const next = normalizeLaunchedCommand(part);
    env.push(...next.env);
    return next.command;
  });
  const summaryPairs = normalizedParts.map((part) => ({
    part,
    summary: applyRemoteContextCwdToSummary(
      summarizeShellCommand(part),
      remoteContextCwd,
    ),
  }));
  const rawSummaries = summaryPairs
    .map((pair) => pair.summary)
    .filter((summary): summary is VisualCommandSummary => !!summary);
  const summaries = normalizeCommandSummaries(rawSummaries);
  if (
    rawSummaries.length > 0 &&
    rawSummaries.length !== meaningfulParts.length
  ) {
    if (rawSummaries.length === summaryPairs.length) {
      const parts = summaries.flatMap(
        (summary, index): VisualToolPreviewPart[] => [
          ...(index === 0 ? [] : [{ kind: "text" as const, text: " · " }]),
          ...commandSummaryParts(summary, context),
        ],
      );
      return {
        text: parts.map((part) => part.text).join(""),
        parts,
        launcher: normalized.launcher,
        remoteHost: normalized.remoteHost,
        env,
        summaries,
      };
    }
    const parts = summaryPairs.flatMap(
      (pair, index): VisualToolPreviewPart[] => [
        ...(index === 0 ? [] : [{ kind: "text" as const, text: " · " }]),
        ...(pair.summary
          ? commandSummaryParts(pair.summary, context)
          : textPreviewParts(pair.part.replace(/\s+/g, " ").trim())),
      ],
    );
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries: rawSummaries,
    };
  }
  if (rawSummaries.length !== meaningfulParts.length) {
    return {
      text: "",
      parts: [],
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
      summaries: [],
    };
  }

  if (summaries.every((summary) => summary.kind === "read")) {
    const parts = readPreviewParts(
      summaries.flatMap((summary) =>
        summary.kind === "read" ? summary.targets : [],
      ),
    );
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries,
    };
  }
  if (summaries.every((summary) => summary.kind === "size")) {
    const parts = sizePreviewParts(
      summaries.flatMap((summary) =>
        summary.kind === "size" ? summary.targets : [],
      ),
    );
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries,
    };
  }
  if (summaries.length === 1 && summaries[0]!.kind === "search") {
    const summary = summaries[0]!;
    const parts = searchPreviewParts(summary.pattern, summary.paths);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries,
    };
  }
  if (summaries.length === 1 && summaries[0]!.kind === "find") {
    const parts = findPreviewParts(summaries[0]!);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries,
    };
  }
  if (summaries.length === 1) {
    const parts = commandSummaryParts(summaries[0]!, context);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env,
      summaries,
    };
  }
  if (summaries.length > 1) {
    const parts = summaries.flatMap(
      (summary, index): VisualToolPreviewPart[] => [
        ...(index === 0 ? [] : [{ kind: "text" as const, text: " · " }]),
        ...commandSummaryParts(summary, context),
      ],
    );
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
      summaries,
    };
  }
  return {
    text: "",
    parts: [],
    launcher: normalized.launcher,
    remoteHost: normalized.remoteHost,
    env,
    summaries: [],
  };
}

function normalizeCommandSummaries(
  summaries: VisualCommandSummary[],
): VisualCommandSummary[] {
  const directoryTargets = new Set(
    summaries.flatMap((summary) => {
      if (summary.kind === "directory") {
        return summary.targets.map(normalizedSummaryTarget);
      }
      if (summary.kind === "find" && summary.patterns.length === 0) {
        return [normalizedSummaryTarget(summary.root)];
      }
      return [];
    }),
  );
  if (directoryTargets.size === 0) return summaries;
  return summaries.filter((summary) => {
    if (summary.kind !== "read" || summary.targets.length === 0) return true;
    return !summary.targets.every((target) =>
      directoryTargets.has(normalizedSummaryTarget(target)),
    );
  });
}

function normalizedSummaryTarget(target: string): string {
  return parsePathTarget(target).path.replace(/[\\/]+$/g, "");
}

function normalizeLaunchedCommand(command: string): {
  command: string;
  launcher?: string;
  remoteHost?: string;
  env: VisualToolEnvAssignment[];
} {
  let current = command.trim();
  let launcher: string | undefined;
  let remoteHost: string | undefined;
  const env: VisualToolEnvAssignment[] = [];
  for (let i = 0; i < 3; i += 1) {
    const setup = stripInlineEnvAssignments(current);
    if (setup.env.length > 0) {
      env.push(...setup.env);
      current = setup.command.trim();
    }
    const tokens = shellTokens(current);
    if (tokens.length < 2)
      return { command: current, launcher, remoteHost, env };
    const shell = shellLauncherName(tokens[0]!);
    const next = unwrappedShellPayload(tokens, shell);
    const unwrapped:
      | { command: string; launcher?: string; remoteHost?: string }
      | undefined =
      next ?? unwrappedSshPayload(tokens) ?? unwrappedDockerPayload(tokens);
    if (!unwrapped) return { command: current, launcher, remoteHost, env };
    if (unwrapped.launcher) launcher = unwrapped.launcher;
    if (unwrapped.remoteHost) remoteHost = unwrapped.remoteHost;
    current = unwrapped.command.trim();
  }
  const setup = stripInlineEnvAssignments(current);
  if (setup.env.length > 0) {
    env.push(...setup.env);
    current = setup.command.trim();
  }
  return { command: current, launcher, remoteHost, env };
}

function stripInlineEnvAssignments(command: string): {
  command: string;
  env: VisualToolEnvAssignment[];
} {
  const tokens = shellTokens(command);
  const env: VisualToolEnvAssignment[] = [];
  const startsWithExport = tokens[0] === "export";
  const startsWithEnv = shellLauncherName(tokens[0] ?? "") === "env";
  let commandStart = startsWithExport || startsWithEnv ? 1 : 0;
  if (startsWithEnv) {
    for (; commandStart < tokens.length; commandStart += 1) {
      const token = tokens[commandStart]!;
      if (token === "--") {
        commandStart += 1;
        break;
      }
      if (token === "-u" || token === "--unset") {
        commandStart += 1;
        continue;
      }
      if (
        token === "-i" ||
        token === "-0" ||
        token === "--ignore-environment" ||
        token === "--null" ||
        token.startsWith("--unset=")
      ) {
        continue;
      }
      break;
    }
  }
  for (const token of tokens.slice(commandStart)) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) break;
    env.push({ name: match[1]!, value: match[2] ?? "" });
    commandStart += 1;
  }
  if (env.length === 0) return { command, env };
  return { command: tokens.slice(commandStart).join(" "), env };
}

function shellLauncherName(command: string): string {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  const lower = base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
  if (lower === "pwsh") return "pwsh";
  if (lower === "powershell") return "powershell";
  return lower;
}

function unwrappedShellPayload(
  tokens: string[],
  shell: string,
): { command: string; launcher: string; remoteHost?: string } | undefined {
  if (shell === "env") {
    const envPayload = unwrapEnvShellPayload(tokens);
    if (envPayload) return envPayload;
  }
  if (/^(?:bash|dash|fish|ksh|sh|zsh)$/.test(shell)) {
    const flagIndex = tokens.findIndex(
      (token, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token),
    );
    const command = flagIndex >= 0 ? tokens[flagIndex + 1] : undefined;
    return command ? { command, launcher: shell } : undefined;
  }
  if (shell === "cmd") {
    const flagIndex = tokens.findIndex(
      (token, index) => index > 0 && /^\/c$/i.test(token),
    );
    const command = flagIndex >= 0 ? tokens[flagIndex + 1] : undefined;
    return command ? { command, launcher: shell } : undefined;
  }
  if (shell === "powershell" || shell === "pwsh") {
    const flagIndex = tokens.findIndex(
      (token, index) =>
        index > 0 && /^-(?:command|c|encodedcommand|ec)$/i.test(token),
    );
    if (flagIndex < 0) return undefined;
    const payload = tokens[flagIndex + 1];
    if (!payload || /^-(?:encodedcommand|ec)$/i.test(tokens[flagIndex]!)) {
      return undefined;
    }
    return { command: payload, launcher: shell };
  }
  return undefined;
}

function unwrapEnvShellPayload(
  tokens: string[],
): { command: string; launcher: string; remoteHost?: string } | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.includes("=") && !token.startsWith("-")) continue;
    if (token.startsWith("-")) {
      if (/^-.[^\s]*S/.test(token) || token === "-S") continue;
      continue;
    }
    const shell = shellLauncherName(token);
    return unwrappedShellPayload(tokens.slice(i), shell);
  }
  return undefined;
}

function unwrappedSshPayload(
  tokens: string[],
): { command: string; remoteHost: string } | undefined {
  const command = shellLauncherName(tokens[0] ?? "");
  if (command !== "ssh") return undefined;
  let host: string | undefined;
  let commandStart = -1;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") continue;
    if (!host && token.startsWith("-")) {
      const option = token.slice(0, 2);
      if (
        SSH_OPTIONS_WITH_VALUE.has(token) ||
        SSH_OPTIONS_WITH_VALUE.has(option)
      ) {
        if (token === option) i += 1;
      }
      continue;
    }
    if (!host) {
      host = token;
      commandStart = i + 1;
      break;
    }
  }
  if (!host || commandStart < 0 || commandStart >= tokens.length) {
    return undefined;
  }
  const remoteCommand = tokens.slice(commandStart).join(" ").trim();
  if (!remoteCommand) return undefined;
  return {
    command: remoteCommand,
    remoteHost: readableSshHost(host),
  };
}

function readableSshHost(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "").split("@").pop() ?? host;
}

function summarizeSshTunnel(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "ssh-tunnel" }> | undefined {
  const command = shellLauncherName(tokens[0] ?? "");
  if (command !== "ssh") return undefined;

  let forwardSpec: string | undefined;
  let host: string | undefined;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") continue;
    if (token === "-L") {
      forwardSpec = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("-L") && token.length > 2) {
      forwardSpec = token.slice(2);
      continue;
    }
    if (token.startsWith("-")) {
      const option = token.slice(0, 2);
      if (
        SSH_OPTIONS_WITH_VALUE.has(token) ||
        SSH_OPTIONS_WITH_VALUE.has(option)
      ) {
        if (token === option) i += 1;
      }
      continue;
    }
    host = token;
    break;
  }

  if (!forwardSpec || !host) return undefined;
  const forward = parseSshLocalForward(forwardSpec);
  if (!forward) return undefined;

  const sshHost = readableSshHost(host);
  const localHost = readableTunnelHost(forward.localHost ?? "localhost", {
    local: true,
  });
  const remoteHost = readableTunnelHost(forward.remoteHost, { local: false });
  const remote =
    remoteHost === "localhost"
      ? `${sshHost}:${forward.remotePort}`
      : `${sshHost}:${remoteHost}:${forward.remotePort}`;

  return {
    kind: "ssh-tunnel",
    local: `${localHost}:${forward.localPort}`,
    remote,
  };
}

function parseSshLocalForward(spec: string):
  | {
      localHost?: string;
      localPort: string;
      remoteHost: string;
      remotePort: string;
    }
  | undefined {
  const parts = spec.split(":");
  if (parts.length === 3) {
    const [localPort, remoteHost, remotePort] = parts;
    if (!localPort || !remoteHost || !remotePort) return undefined;
    return { localPort, remoteHost, remotePort };
  }
  if (parts.length === 4) {
    const [localHost, localPort, remoteHost, remotePort] = parts;
    if (!localHost || !localPort || !remoteHost || !remotePort) {
      return undefined;
    }
    return { localHost, localPort, remoteHost, remotePort };
  }
  return undefined;
}

function readableTunnelHost(host: string, options: { local: boolean }): string {
  const cleaned = host.replace(/^\[/, "").replace(/\]$/, "");
  if (/^(?:localhost|127\.0\.0\.1|::1)$/i.test(cleaned)) return "localhost";
  if (options.local && /^(?:0\.0\.0\.0|::|\*)$/i.test(cleaned)) return "*";
  return cleaned;
}

function summarizeScp(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "remote-transfer" }> | undefined {
  const command = shellLauncherName(tokens[0] ?? "");
  if (command !== "scp") return undefined;

  const endpoints = scpEndpointTokens(tokens.slice(1));
  if (endpoints.length < 2) return undefined;

  const source = endpoints[0]!;
  const destination = endpoints[endpoints.length - 1]!;
  const sourceRemote = parseScpRemoteEndpoint(source);
  const destinationRemote = parseScpRemoteEndpoint(destination);

  if (!!sourceRemote === !!destinationRemote) return undefined;

  if (destinationRemote) {
    return {
      kind: "remote-transfer",
      action: "upload",
      host: destinationRemote.host,
      local: source,
      remotePath: destinationRemote.path,
    };
  }

  return {
    kind: "remote-transfer",
    action: "download",
    host: sourceRemote!.host,
    local: destination,
    remotePath: sourceRemote!.path,
  };
}

function scpEndpointTokens(tokens: string[]): string[] {
  const endpoints: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") {
      endpoints.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      endpoints.push(token);
      continue;
    }
    const option = token.slice(0, 2);
    if (
      SCP_OPTIONS_WITH_VALUE.has(token) ||
      SCP_OPTIONS_WITH_VALUE.has(option)
    ) {
      if (token === option) i += 1;
      continue;
    }
  }
  return endpoints;
}

function parseScpRemoteEndpoint(
  endpoint: string,
): { host: string; path: string } | undefined {
  if (/^[A-Za-z]:[\\/]/.test(endpoint)) return undefined;
  const match = endpoint.match(/^((?:[^@:\s]+@)?[^:\s]+):(.+)$/);
  if (!match) return undefined;
  return {
    host: readableSshHost(match[1]!),
    path: match[2]!,
  };
}

const SCP_OPTIONS_WITH_VALUE = new Set([
  "-B",
  "-c",
  "-D",
  "-F",
  "-i",
  "-J",
  "-l",
  "-o",
  "-P",
  "-S",
]);

function summarizeScreenSessions(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "screen-sessions" }> | undefined {
  const command = shellLauncherName(tokens[0] ?? "");
  if (command !== "screen") return undefined;
  const listsSessions = tokens.some((token) => {
    const lower = token.toLowerCase();
    return lower === "-ls" || lower === "-list";
  });
  return listsSessions ? { kind: "screen-sessions" } : undefined;
}

const SSH_OPTIONS_WITH_VALUE = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

function unwrappedDockerPayload(
  tokens: string[],
): { command: string; remoteHost: string } | undefined {
  const command = shellLauncherName(tokens[0] ?? "");
  if (command !== "docker" && command !== "docker-compose") return undefined;

  const execIndex = dockerExecIndex(tokens, command);
  if (execIndex < 0) return undefined;

  const payload = dockerExecPayload(tokens, execIndex + 1);
  if (!payload) return undefined;
  return {
    command: payload.command,
    remoteHost: `docker ${payload.target}`,
  };
}

function dockerExecIndex(tokens: string[], command: string): number {
  if (command === "docker-compose") {
    return tokens.findIndex((token, index) => index > 0 && token === "exec");
  }
  const composeIndex = tokens.findIndex(
    (token, index) => index > 0 && token === "compose",
  );
  if (composeIndex >= 0) {
    return tokens.findIndex(
      (token, index) => index > composeIndex && token === "exec",
    );
  }
  return tokens.findIndex((token, index) => index > 0 && token === "exec");
}

function dockerExecPayload(
  tokens: string[],
  startIndex: number,
): { target: string; command: string } | undefined {
  const valueOptions = new Set([
    "-e",
    "--env",
    "--env-file",
    "--index",
    "-u",
    "--user",
    "-w",
    "--workdir",
    "--workdir-path",
  ]);
  let target: string | undefined;
  let commandStart = -1;
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") continue;
    if (!target && token.startsWith("-")) {
      const option = token.slice(0, 2);
      if (
        !token.includes("=") &&
        (valueOptions.has(token) || valueOptions.has(option))
      ) {
        if (token === option) i += 1;
      }
      continue;
    }
    if (!target) {
      target = readableDockerTarget(token);
      commandStart = i + 1;
      break;
    }
  }
  if (!target || commandStart < 0 || commandStart >= tokens.length) {
    return undefined;
  }
  const payloadTokens = tokens.slice(commandStart);
  const payloadShell = shellLauncherName(payloadTokens[0] ?? "");
  const shellPayload = unwrappedShellPayload(payloadTokens, payloadShell);
  const inner = (shellPayload?.command ?? payloadTokens.join(" ")).trim();
  if (!inner) return undefined;
  return { target, command: inner };
}

function readableDockerTarget(target: string): string {
  return target.replace(/^\/+/, "");
}

function splitShellCommandChain(command: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || (ch === "&" && command[i + 1] === "&")) {
      const part = command.slice(start, i).trim();
      if (part) parts.push(part);
      if (ch === "&") i += 1;
      start = i + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function isShellContextCommand(command: string): boolean {
  const tokens = shellTokens(command);
  const name = tokens[0]?.split("/").pop();
  const lowerName = name?.toLowerCase();
  if (tokens.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(tokens[0]!)) {
    return true;
  }
  if (name === "ls") {
    if (!lsRequestsDetails(tokens)) return true;
    const targets = positionalPathTokens(tokens.slice(1), new Set());
    return (
      targets.length === 0 ||
      (targets.length === 1 && (targets[0] === "." || targets[0] === "./"))
    );
  }
  if (name === "echo" || name === "printf") return isLabelPrintCommand(command);
  return (
    lowerName === "add-type" ||
    name === "cd" ||
    name === "pwd" ||
    name === "true" ||
    name === "set"
  );
}

function isLabelPrintCommand(command: string): boolean {
  if (/[|<>]/.test(command)) return false;
  if (/^\s*printf\s+(?:"[^"]*%[^"]*"|'[^']*%[^']*'|\S*%\S*)\s+/.test(command)) {
    return true;
  }
  const tokens = shellTokens(command);
  const name = shellLauncherName(tokens[0] ?? "");
  if (name !== "echo" && name !== "printf") return false;
  const args = tokens.slice(1).filter((token) => !token.startsWith("-"));
  if (args.length === 0) return false;
  if (name === "printf" && args.length > 1 && /%/.test(args[0]!)) {
    return args.slice(1).every((arg) => !looksLikePathToken(arg));
  }
  return args.every((arg) => !looksLikePathToken(arg));
}

function isShellSetupWaitCommand(command: string): boolean {
  const tokens = shellTokens(command);
  const name = tokens[0]?.split("/").pop()?.toLowerCase();
  if (name !== "sleep") return false;
  return tokens.length === 2 && /^\d+(?:\.\d+)?$/.test(tokens[1] ?? "");
}

function splitLeadingSleepPrefix(
  command: string,
): { seconds: string; command: string } | undefined {
  const match = command.match(
    /^\s*(?:\S*\/)?sleep\s+(\d+(?:\.\d+)?)(?:(?:\s*(?:;|&&)\s*)|\s+)([\s\S]+)$/i,
  );
  if (!match) return undefined;
  const rest = (match[2] ?? "").trim();
  if (!rest || /^\|\|/.test(rest)) return undefined;
  return { seconds: match[1]!, command: rest };
}

function isShellSetupProbeCommand(command: string): boolean {
  const probes = command
    .split(/\s+\|\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return probes.length > 0 && probes.every(isSingleShellSetupProbeCommand);
}

function isSingleShellSetupProbeCommand(command: string): boolean {
  const tokens = shellTokens(command);
  const name = shellLauncherName(tokens[0] ?? "");
  if (name === "command") {
    return tokens[1] === "-v" && !!tokens[2];
  }
  if (name === "which" || name === "where") {
    return tokens.length >= 2;
  }
  if (name === "npx" || name === "npm" || name === "bun" || name === "pnpm") {
    return tokens.includes("--version") || tokens.includes("-v");
  }
  return false;
}

function shellContextCwd(parts: readonly string[]): string | undefined {
  let cwd: string | undefined;
  for (const part of parts) {
    const tokens = shellTokens(part);
    const name = shellLauncherName(tokens[0] ?? "");
    if (name === "cd" || name === "chdir" || name === "set-location") {
      const target = cdTargetFromTokens(tokens);
      if (target) cwd = target;
    }
  }
  return cwd;
}

function cdTargetFromTokens(tokens: readonly string[]): string | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token || token === "--") continue;
    if (token.toLowerCase() === "/d") continue;
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function applyRemoteContextCwdToSummary(
  summary: VisualCommandSummary | undefined,
  cwd: string | undefined,
): VisualCommandSummary | undefined {
  if (!summary || !cwd) return summary;
  const qualifyTargets = (targets: readonly string[]) =>
    targets.map((target) => qualifyRemotePathTarget(target, cwd));
  if (summary.kind === "read") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "directory") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "logs") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "search") {
    return { ...summary, paths: qualifyTargets(summary.paths) };
  }
  if (summary.kind === "find") {
    return { ...summary, root: qualifyRemotePathTarget(summary.root, cwd) };
  }
  if (summary.kind === "count") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "size") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "json-query") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "script-file") {
    return { ...summary, script: qualifyRemotePathTarget(summary.script, cwd) };
  }
  if (summary.kind === "test") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  if (summary.kind === "fetch" && summary.output) {
    return { ...summary, output: qualifyRemotePathTarget(summary.output, cwd) };
  }
  if (summary.kind === "image-transform") {
    return {
      ...summary,
      input: qualifyRemotePathTarget(summary.input, cwd),
      output: qualifyRemotePathTarget(summary.output, cwd),
    };
  }
  if (summary.kind === "filesystem") {
    return { ...summary, targets: qualifyTargets(summary.targets) };
  }
  return summary;
}

function qualifyRemotePathTarget(target: string, cwd: string): string {
  const parsed = parsePathTarget(target);
  if (!parsed.path || isAbsoluteOrSpecialPath(parsed.path)) return target;
  return `${joinRemotePath(cwd, parsed.path)}${parsed.range}`;
}

function isAbsoluteOrSpecialPath(path: string): boolean {
  return (
    path === "." ||
    path === "./" ||
    path === ".." ||
    path.startsWith("/") ||
    path.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^\\\\/.test(path) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
  );
}

function joinRemotePath(cwd: string, path: string): string {
  const separator =
    /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

function lsRequestsDetails(tokens: string[]): boolean {
  return tokens
    .slice(1)
    .some((token) => /^-[^-]*l/.test(token) || token === "--long");
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let commandSubDepth = 0;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote !== "'" && ch === "$" && command[index + 1] === "(") {
      commandSubDepth += 1;
      current += "$(";
      index += 1;
      continue;
    }
    if (commandSubDepth > 0 && ch === ")") {
      commandSubDepth -= 1;
      current += ch;
      continue;
    }
    const next = command[index + 1];
    const shouldEscape =
      ch === "\\" &&
      quote !== "'" &&
      (quote === '"'
        ? next !== undefined && /["\\$`]/.test(next)
        : next !== undefined && /[\s"'\\|&;<>$`]/.test(next));
    if (shouldEscape) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (commandSubDepth > 0) {
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function cleanPowerShellBoundaryToken(token: string): string {
  return token.replace(/^[(&]+/, "").replace(/[);]+$/, "");
}

function summarizeShellCommand(
  command: string,
): VisualCommandSummary | undefined {
  const portCheck = summarizePortCheck(command);
  if (portCheck) return portCheck;
  const processCheck = summarizeProcessCheck(command);
  if (processCheck) return processCheck;
  const containerCheck = summarizeContainerCheck(command);
  if (containerCheck) return containerCheck;
  const gitShowSearch = summarizeGitShowSearch(command);
  if (gitShowSearch) return gitShowSearch;
  const pipeRead = summarizePipeRead(command);
  if (pipeRead) return pipeRead;
  const pipeSize = summarizePipeSize(command);
  if (pipeSize) return pipeSize;
  const tokens = shellTokens(command);
  if (tokens.length === 0) return undefined;
  const name =
    cleanPowerShellBoundaryToken(tokens[0]!).split("/").pop() ?? tokens[0]!;
  const lowerName = name.toLowerCase();
  const sshTunnel = summarizeSshTunnel(tokens);
  if (sshTunnel) return sshTunnel;
  const scpTransfer = summarizeScp(tokens);
  if (scpTransfer) return scpTransfer;
  const screen = summarizeScreenSessions(tokens);
  if (screen) return screen;
  const test = summarizeTestCommand(tokens);
  if (test) return test;
  const browser = summarizeAgentBrowser(tokens);
  if (browser) return browser;
  const database = summarizeDatabase(tokens);
  if (database) return database;
  const scriptFile = directScriptCommand(command);
  if (scriptFile) return scriptFile;
  if (lowerName === "git") return summarizeGit(tokens);
  if (name === "kill") return summarizeKill(tokens);
  if (
    lowerName === "rm" ||
    lowerName === "del" ||
    lowerName === "rmdir" ||
    lowerName === "remove-item"
  )
    return summarizeRemove(tokens);
  if (
    lowerName === "mkdir" ||
    lowerName === "md" ||
    lowerName === "touch" ||
    lowerName === "new-item"
  )
    return summarizeCreate(tokens);
  if (
    lowerName === "cp" ||
    lowerName === "copy" ||
    lowerName === "copy-item" ||
    lowerName === "mv" ||
    lowerName === "move" ||
    lowerName === "move-item"
  )
    return summarizeCopyMove(tokens);
  if (lowerName === "curl" || lowerName === "wget")
    return summarizeFetch(tokens);
  if (lowerName === "tail") return summarizeTailRead(tokens);
  if (lowerName === "du") return summarizeDu(tokens);
  if (lowerName === "wc") return summarizeWc(tokens);
  if (lowerName === "jq") return summarizeJq(tokens);
  if (lowerName === "awk" || lowerName === "gawk" || lowerName === "nawk")
    return summarizeAwk(tokens);
  if (lowerName === "magick" || lowerName === "convert") {
    return summarizeImageTransform(tokens);
  }
  if (lowerName === "cmake") return summarizeCMake(tokens);
  if (name === "sed") return summarizeSedRead(tokens);
  if (lowerName === "ls") return summarizeLs(tokens);
  if (lowerName === "dir") {
    return summarizeLs(tokens) ?? summarizeGetChildItem(tokens);
  }
  if (lowerName === "get-psdrive") return summarizeGetPsDrive(tokens);
  if (lowerName === "get-childitem" || lowerName === "gci")
    return summarizeGetChildItem(tokens);
  if (lowerName === "get-content" || lowerName === "gc") {
    return summarizeGetContentRead(tokens.map(cleanPowerShellBoundaryToken));
  }
  if (name === "cat" || name.toLowerCase() === "type") {
    return summarizeCatRead(tokens);
  }
  if (name === "rg" || name === "ripgrep" || name === "grep") {
    return summarizeSearch(tokens);
  }
  if (name === "find") return summarizeFind(tokens);
  return undefined;
}

function summarizeWaitFetchLoop(
  command: string,
): Extract<VisualCommandSummary, { kind: "wait-url" }> | undefined {
  if (
    !/\bfor\s+\w+\s+in\b/i.test(command) ||
    !/\bdo\b/i.test(command) ||
    !/\bdone\b/i.test(command) ||
    !/\bcurl\b/i.test(command)
  ) {
    return undefined;
  }
  const url = command.match(/\bcurl\b[\s\S]*?(https?:\/\/[^\s'";&|)]+)/i)?.[1];
  if (!url) return undefined;
  const attempts =
    numberFromMatch(command.match(/\{1\.\.(\d+)\}/)) ??
    numberFromMatch(command.match(/\bseq\s+1\s+(\d+)\b/i));
  const intervalSeconds = numberFromMatch(
    command.match(/\bsleep\s+(\d+(?:\.\d+)?)/i),
  );
  return { kind: "wait-url", url, attempts, intervalSeconds };
}

function summarizeFileLoop(
  command: string,
): Extract<VisualCommandSummary, { kind: "batch-files" }> | undefined {
  const match = command.match(
    /^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+?)\s*;\s*do\s+([\s\S]+?)\s*;\s*done\s*$/i,
  );
  if (!match) return undefined;
  const variable = match[1]!;
  const targets = shellTokens(match[2]!)
    .filter((token) => token !== "--")
    .filter((token) => looksLikePathToken(token));
  if (targets.length === 0) return undefined;
  const bodyTokens = shellTokens(match[3]!);
  const firstCommand = bodyTokens.find(
    (token) => !token.includes(`$${variable}`),
  );
  const tool = firstCommand?.split("/").pop() ?? "";
  if (!tool || tool === "echo" || tool === "printf") return undefined;
  if (!bodyReferencesLoopVariable(bodyTokens, variable)) return undefined;
  return { kind: "batch-files", tool, targets };
}

function bodyReferencesLoopVariable(
  tokens: readonly string[],
  variable: string,
): boolean {
  return tokens.some((token) => {
    const normalized = token.replace(/[{}]/g, "");
    return normalized === `$${variable}` || normalized.includes(`$${variable}`);
  });
}

function looksLikePathToken(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (/^\$/.test(token)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return false;
  return (
    token.includes("/") ||
    token.includes("\\") ||
    /\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(token)
  );
}

function numberFromMatch(match: RegExpMatchArray | null): number | undefined {
  const raw = match?.[1];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function summarizeGitShowSearch(
  command: string,
): VisualCommandSummary | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return undefined;
  const show = summarizeGit(shellTokens(parts[0]!));
  if (!show || show.kind !== "git" || show.action !== "show-file") {
    return undefined;
  }
  const search = summarizeSearch(shellTokens(parts[1]!));
  if (!search || search.kind !== "search") return undefined;
  return {
    kind: "git",
    action: "show-file-search",
    targets: show.targets,
    rev: show.rev,
    pattern: search.pattern,
  };
}

function summarizeGit(tokens: string[]): VisualCommandSummary | undefined {
  const subcommandIndex = gitSubcommandIndex(tokens);
  const subcommand = tokens[subcommandIndex]?.toLowerCase();
  if (!subcommand) return undefined;
  if (subcommand === "status")
    return { kind: "git", action: "status", targets: [] };
  if (subcommand === "diff") {
    const targets = gitPathArgs(tokens.slice(subcommandIndex + 1));
    const staged = tokens.includes("--cached") || tokens.includes("--staged");
    if (tokens.includes("--check")) {
      return { kind: "git", action: "diff-check", targets, staged };
    }
    if (tokens.includes("--stat") || tokens.includes("--name-status")) {
      return { kind: "git", action: "diff-stat", targets, staged };
    }
    return { kind: "git", action: "diff", targets, staged };
  }
  if (subcommand === "show") {
    const fileSpec = tokens
      .slice(subcommandIndex + 1)
      .find((token) => !token.startsWith("-") && /^[^:\s]+:.+/.test(token));
    if (fileSpec) {
      const [rev, ...pathParts] = fileSpec.split(":");
      return {
        kind: "git",
        action: "show-file",
        targets: [pathParts.join(":")],
        rev,
      };
    }
    const ref = tokens
      .slice(subcommandIndex + 1)
      .find((token) => !token.startsWith("-"));
    return { kind: "git", action: "show", targets: ref ? [ref] : [] };
  }
  if (subcommand === "ls-files") {
    return {
      kind: "git",
      action: "ls-files",
      targets: gitPathArgs(tokens.slice(subcommandIndex + 1)),
    };
  }
  if (subcommand === "log") return { kind: "git", action: "log", targets: [] };
  if (subcommand === "branch") {
    return { kind: "git", action: "branch", targets: [] };
  }
  if (subcommand === "rev-parse") {
    return { kind: "git", action: "rev-parse", targets: [] };
  }
  if (subcommand === "rev-list" && tokens.includes("--count")) {
    const range = tokens
      .slice(subcommandIndex + 1)
      .find((token) => !token.startsWith("-"));
    return {
      kind: "git",
      action: "rev-list-count",
      targets: range ? [range] : [],
    };
  }
  if (subcommand === "check-ignore") {
    return {
      kind: "git",
      action: "check-ignore",
      targets: gitPathArgs(tokens.slice(subcommandIndex + 1)),
    };
  }
  if (subcommand === "add") {
    return {
      kind: "git",
      action: "add",
      targets: gitPathArgs(tokens.slice(subcommandIndex + 1)),
    };
  }
  if (subcommand === "commit") {
    return { kind: "git", action: "commit", targets: [] };
  }
  return undefined;
}

function gitSubcommandIndex(tokens: string[]): number {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (
      token === "-C" ||
      token === "-c" ||
      token === "--git-dir" ||
      token === "--work-tree"
    ) {
      index += 1;
      continue;
    }
    if (
      token.startsWith("-C") ||
      token.startsWith("-c") ||
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=")
    ) {
      continue;
    }
    return index;
  }
  return 1;
}

function gitPathArgs(tokens: string[]): string[] {
  const optionsWithValue = new Set([
    "-C",
    "--git-dir",
    "--work-tree",
    "--diff-filter",
    "-G",
    "-S",
    "--author",
    "--grep",
    "--since",
    "--until",
    "-m",
    "--message",
  ]);
  const targets: string[] = [];
  let afterSeparator = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && token.startsWith("-")) {
      if (!token.includes("=") && optionsWithValue.has(token)) index += 1;
      continue;
    }
    if (token.includes("|") || token.includes(">")) break;
    targets.push(token);
  }
  return targets.filter((target) => target !== "." && target !== "HEAD");
}

function summarizeTestCommand(
  tokens: string[],
): VisualCommandSummary | undefined {
  const command = shellLauncherName(tokens[0] ?? "");
  if (/^(?:bash|dash|ksh|sh|zsh)$/.test(command) && tokens.includes("-n")) {
    return {
      kind: "test",
      runner: "Shell",
      targets: testPathArgs(tokens.slice(1)),
      check: true,
    };
  }
  if (command === "bun" && tokens[1] === "test") {
    return {
      kind: "test",
      runner: "Bun",
      targets: testPathArgs(tokens.slice(2)),
    };
  }
  if (
    (command === "npm" || command === "pnpm" || command === "yarn") &&
    tokens[1] === "test"
  ) {
    return {
      kind: "test",
      runner: "npm",
      targets: testPathArgs(tokens.slice(2)),
    };
  }
  if (
    (command === "npm" || command === "pnpm" || command === "yarn") &&
    tokens[1] === "run" &&
    /^test(?::|$)/.test(tokens[2] ?? "")
  ) {
    return {
      kind: "test",
      runner: "npm",
      targets: [tokens[2]!, ...testPathArgs(tokens.slice(3))],
    };
  }
  const npxOffset =
    command === "npx" || command === "bunx" ? skipNpxOptions(tokens, 1) : 0;
  const npxCommand =
    npxOffset > 0 ? shellLauncherName(tokens[npxOffset] ?? "") : "";
  if (npxCommand === "vitest") {
    const start =
      tokens[npxOffset + 1] === "run" ? npxOffset + 2 : npxOffset + 1;
    return {
      kind: "test",
      runner: "Vitest",
      targets: testPathArgs(tokens.slice(start)),
    };
  }
  if (npxCommand === "playwright" && tokens[npxOffset + 1] === "test") {
    return {
      kind: "test",
      runner: "Playwright",
      targets: testPathArgs(tokens.slice(npxOffset + 2)),
    };
  }
  if (npxCommand === "tsc" || command === "tsc") {
    return { kind: "test", runner: "TypeScript", targets: [], check: true };
  }
  if (npxCommand === "svelte-check" || command === "svelte-check") {
    return { kind: "test", runner: "Svelte", targets: [], check: true };
  }
  const pytestIndex = tokens.findIndex(
    (token) =>
      shellLauncherName(token) === "pytest" || token.endsWith("/pytest"),
  );
  if (pytestIndex >= 0) {
    return {
      kind: "test",
      runner: "Pytest",
      targets: testPathArgs(tokens.slice(pytestIndex + 1)),
    };
  }
  if (command === "python" || command === "python3") {
    const moduleIndex = tokens.findIndex((token) => token === "-m");
    if (moduleIndex >= 0 && tokens[moduleIndex + 1] === "pytest") {
      return {
        kind: "test",
        runner: "Pytest",
        targets: testPathArgs(tokens.slice(moduleIndex + 2)),
      };
    }
  }
  return undefined;
}

function skipNpxOptions(tokens: string[], start: number): number {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--yes" || token === "-y" || token === "--no-install")
      continue;
    if (token === "--package" || token === "-p") {
      index += 1;
      continue;
    }
    return index;
  }
  return 0;
}

function testPathArgs(tokens: string[]): string[] {
  const optionsWithValue = new Set([
    "--grep",
    "--test-name-pattern",
    "--project",
    "--reporter",
    "--config",
    "--timeout",
    "--testTimeout",
    "-t",
    "-c",
    "-k",
    "-m",
  ]);
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") continue;
    if (token.includes("=") && token.startsWith("-")) continue;
    if (token.startsWith("-")) {
      if (optionsWithValue.has(token)) index += 1;
      continue;
    }
    if (token.includes("|") || token.includes(">")) break;
    targets.push(token);
  }
  return targets;
}

function summarizeKill(tokens: string[]): VisualCommandSummary | undefined {
  const pids = tokens.slice(1).filter((token) => /^\d+$/.test(token));
  if (pids.length === 0) return undefined;
  return { kind: "process-end", pids };
}

function summarizePortCheck(command: string): VisualCommandSummary | undefined {
  const tokens = shellTokens(command);
  const name = tokens[0]?.split("/").pop()?.toLowerCase();
  if (name !== "lsof") return undefined;
  const ports: string[] = [];
  const addPort = (port: string | undefined) => {
    if (!port || ports.includes(port)) return;
    ports.push(port);
  };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    addPort(token.match(/^tcp:(\d+)$/i)?.[1]);
    addPort(token.match(/^-i(?:tcp)?:(\d+)$/i)?.[1]);
    addPort(token.match(/^:(\d+)$/)?.[1]);
    if (
      (token === "-i" || token.toLowerCase() === "-itcp") &&
      tokens[index + 1]
    ) {
      const next = tokens[index + 1]!;
      addPort(next.match(/^(?:tcp:)?(\d+)$/i)?.[1]);
      addPort(next.match(/^:(\d+)$/)?.[1]);
      index += 1;
    }
  }
  for (const match of command.matchAll(
    /(?:^|[^\w/])(?:tcp:|TCP:|:)(\d{2,5})/g,
  )) {
    addPort(match[1]);
  }
  const listenerTerms = lsofListenerTerms(command);
  if (listenerTerms.length > 0) {
    const numericTerms = listenerTerms.filter((term) => /^\d+$/.test(term));
    if (numericTerms.length === listenerTerms.length) {
      for (const port of numericTerms) addPort(port);
    } else {
      return { kind: "listener-check", terms: listenerTerms };
    }
  }
  if (ports.length === 0) return undefined;
  return { kind: "port-check", ports };
}

function lsofListenerTerms(command: string): string[] {
  if (!/(?:^|\s)-sTCP:LISTEN\b/i.test(command)) return [];
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return [];
  const right = shellTokens(parts[1]!);
  const filter = right[0]?.split("/").pop()?.toLowerCase();
  if (filter !== "rg" && filter !== "grep") return [];
  const pattern = right
    .slice(1)
    .find((token) => token && !token.startsWith("-"));
  if (!pattern) return [];
  const terms: string[] = [];
  return pattern
    .split("|")
    .map((term) =>
      term.trim().replace(/^\\b/, "").replace(/\\b$/, "").replace(/^:/, ""),
    )
    .filter((term) => {
      if (!term || terms.includes(term)) return false;
      terms.push(term);
      return true;
    });
}

function summarizeTailRead(tokens: string[]): VisualCommandSummary | undefined {
  const targets: string[] = [];
  let tailLines: number | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-n" || token === "--lines") {
      const value = tokens[index + 1];
      if (value && /^-?\d+$/.test(value)) tailLines = Math.abs(Number(value));
      index += 1;
      continue;
    }
    const compactLines = token.match(/^-([0-9]+)$/);
    if (compactLines) {
      tailLines = Number(compactLines[1]);
      continue;
    }
    if (token.startsWith("--lines=")) {
      const value = token.slice("--lines=".length);
      if (/^-?\d+$/.test(value)) tailLines = Math.abs(Number(value));
      continue;
    }
    if (token.startsWith("-")) continue;
    if (token.includes("|") || token.includes(">")) break;
    targets.push(token);
  }
  if (targets.length === 0) return undefined;
  return { kind: "logs", targets, tailLines };
}

function summarizeWc(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "count" }> | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  if (command !== "wc") return undefined;
  let metric: Extract<VisualCommandSummary, { kind: "count" }>["metric"] =
    "items";
  const targets: string[] = [];
  const optionsWithValue = new Set(["--files0-from"]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") continue;
    if (token === "<") {
      const target = tokens[index + 1];
      if (target) targets.push(target);
      index += 1;
      continue;
    }
    if (token === "-l" || token === "--lines" || /^-[A-Za-z]*l/.test(token)) {
      metric = "lines";
    } else if (
      token === "-c" ||
      token === "--bytes" ||
      /^-[A-Za-z]*c/.test(token)
    ) {
      metric = "bytes";
    } else if (
      token === "-w" ||
      token === "--words" ||
      /^-[A-Za-z]*w/.test(token)
    ) {
      metric = "words";
    } else if (
      token === "-m" ||
      token === "--chars" ||
      /^-[A-Za-z]*m/.test(token)
    ) {
      metric = "chars";
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && optionsWithValue.has(token)) index += 1;
      continue;
    }
    if (token.includes("|") || token === ">" || token === "2>") break;
    targets.push(token);
  }
  return { kind: "count", metric, targets };
}

function summarizeDu(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "size" }> | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  if (command !== "du") return undefined;
  const targets = positionalPathTokens(
    tokens.slice(1),
    new Set([
      "-d",
      "--max-depth",
      "--block-size",
      "-B",
      "--exclude",
      "--exclude-from",
      "--files0-from",
      "-t",
      "--threshold",
    ]),
  ).filter((target) => target !== "-" && !target.includes("|"));
  return targets.length > 0 ? { kind: "size", targets } : undefined;
}

function summarizeJq(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "json-query" }> | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  if (command !== "jq") return undefined;
  let filter = "";
  const targets: string[] = [];
  const optionsWithValue = new Set([
    "--arg",
    "--argjson",
    "--slurpfile",
    "--rawfile",
    "--argfile",
    "-L",
  ]);
  const optionsWithTwoValues = new Set([
    "--arg",
    "--argjson",
    "--slurpfile",
    "--rawfile",
    "--argfile",
  ]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (optionsWithTwoValues.has(token)) index += 2;
      else if (optionsWithValue.has(token) || token === "-f") index += 1;
      continue;
    }
    if (!filter) {
      filter = token;
      continue;
    }
    if (token.includes("|") || token === ">" || token === "2>") break;
    targets.push(token);
  }
  if (!filter && targets.length === 0) return undefined;
  return { kind: "json-query", filter, targets };
}

function summarizeAwk(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "text-process" }> | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  if (command !== "awk" && command !== "gawk" && command !== "nawk") {
    return undefined;
  }
  let expression = "";
  const targets: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") continue;
    if (token === "-F" || token === "-v") {
      index += 1;
      continue;
    }
    if (token === "-f" || token === "--file") {
      const script = tokens[index + 1];
      if (script) expression = `-f ${script}`;
      index += 1;
      continue;
    }
    if (token === "--source") {
      const source = tokens[index + 1];
      if (source) expression = source;
      index += 1;
      continue;
    }
    if (token.startsWith("--source=")) {
      expression = token.slice("--source=".length);
      continue;
    }
    if (token.startsWith("--file=")) {
      expression = `-f ${token.slice("--file=".length)}`;
      continue;
    }
    if (token.startsWith("-F") || token.startsWith("-v")) continue;
    if (token.startsWith("-")) continue;
    if (token.includes("|") || token === ">" || token === "2>") break;
    if (!expression) {
      expression = token;
      continue;
    }
    targets.push(token);
  }
  if (!expression && targets.length === 0) return undefined;
  return { kind: "text-process", tool: "awk", expression, targets };
}

function summarizeDatabase(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "database" }> | undefined {
  const command = shellLauncherName(
    cleanPowerShellBoundaryToken(tokens[0] ?? ""),
  );
  if (command === "psql") return summarizePostgres(tokens);
  if (command === "mysql") return summarizeMysql(tokens, "MySQL");
  if (command === "mariadb") return summarizeMysql(tokens, "MariaDB");
  if (command === "sqlite3") return summarizeSqlite(tokens);
  return undefined;
}

function summarizePostgres(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "database" }> {
  let database: string | undefined;
  let query: string | undefined;
  const optionsWithValue = new Set(
    [
      "-h",
      "--host",
      "-p",
      "--port",
      "-u",
      "-U",
      "--username",
      "-f",
      "--file",
      "-P",
      "--pset",
      "-v",
      "--set",
      "--variable",
    ].map((option) => option.toLowerCase()),
  );
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (token === "--") continue;
    if (lower === "-d" || lower === "--dbname") {
      database = tokens[index + 1] ?? database;
      index += 1;
      continue;
    }
    if (lower.startsWith("--dbname=")) {
      database = token.slice("--dbname=".length);
      continue;
    }
    if (/^-d\S+/.test(token)) {
      database = token.slice(2);
      continue;
    }
    if (lower === "-c" || lower === "--command") {
      query = tokens.slice(index + 1).join(" ") || query;
      index = tokens.length;
      continue;
    }
    if (lower.startsWith("--command=")) {
      query = token.slice("--command=".length);
      continue;
    }
    if (/^-[a-z]*c[a-z]*$/i.test(token)) {
      query = tokens.slice(index + 1).join(" ") || query;
      index = tokens.length;
      continue;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && optionsWithValue.has(lower)) index += 1;
      continue;
    }
    if (!database && !looksLikeSqlStatement(token)) database = token;
  }
  return {
    kind: "database",
    engine: "PostgreSQL",
    database,
    query: query ? compactSql(query) : undefined,
  };
}

function summarizeMysql(
  tokens: string[],
  engine: "MySQL" | "MariaDB",
): Extract<VisualCommandSummary, { kind: "database" }> {
  let database: string | undefined;
  let query: string | undefined;
  const optionsWithValue = new Set(
    [
      "--host",
      "-h",
      "--port",
      "-P",
      "--socket",
      "-S",
      "--user",
      "-u",
      "--password",
      "-p",
      "--defaults-file",
      "--defaults-extra-file",
    ].map((option) => option.toLowerCase()),
  );
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (token === "--") continue;
    if (lower === "-d" || lower === "--database") {
      database = tokens[index + 1] ?? database;
      index += 1;
      continue;
    }
    if (lower.startsWith("--database=")) {
      database = token.slice("--database=".length);
      continue;
    }
    if (/^-D\S+/.test(token)) {
      database = token.slice(2);
      continue;
    }
    if (lower === "-e" || lower === "--execute") {
      query = tokens.slice(index + 1).join(" ") || query;
      index = tokens.length;
      continue;
    }
    if (lower.startsWith("--execute=")) {
      query = token.slice("--execute=".length);
      continue;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && optionsWithValue.has(lower)) index += 1;
      continue;
    }
    if (!database && !looksLikeSqlStatement(token)) database = token;
  }
  return {
    kind: "database",
    engine,
    database,
    query: query ? compactSql(query) : undefined,
  };
}

function summarizeSqlite(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "database" }> {
  let database: string | undefined;
  let query: string | undefined;
  const optionsWithValue = new Set([
    "-cmd",
    "-init",
    "-separator",
    "-nullvalue",
  ]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (!token.includes("=") && optionsWithValue.has(lower)) index += 1;
      continue;
    }
    if (!database) {
      database = token;
      continue;
    }
    if (!query) query = token;
  }
  return {
    kind: "database",
    engine: "SQLite",
    database,
    query: query ? compactSql(query) : undefined,
  };
}

function looksLikeSqlStatement(value: string): boolean {
  return /^(?:select|with|insert|update|delete|create|alter|drop|show|describe|desc|pragma|vacuum|\\[a-z])/i.test(
    value.trim(),
  );
}

function compactSql(value: string): string {
  return value.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

function summarizeFetch(tokens: string[]): VisualCommandSummary | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  let output: string | undefined;
  let url: string | undefined;
  const optionsWithValue = new Set([
    "-A",
    "--user-agent",
    "-b",
    "--cookie",
    "-c",
    "--cookie-jar",
    "-d",
    "--data",
    "--data-raw",
    "--data-binary",
    "-e",
    "--referer",
    "-H",
    "--header",
    "-m",
    "--max-time",
    "--connect-timeout",
    "--retry",
    "-u",
    "--user",
    "-X",
    "--request",
  ]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") continue;
    if (token === "-o" || token === "--output" || token === "-O") {
      if (token !== "-O") {
        output = tokens[index + 1];
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--output=")) {
      output = token.slice("--output=".length);
      continue;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && optionsWithValue.has(token)) index += 1;
      continue;
    }
    if (/^https?:\/\//i.test(token)) {
      url = token;
      if (command === "wget" && !output) {
        output = undefined;
      }
    }
  }
  if (!url) return undefined;
  return { kind: "fetch", url, output };
}

function summarizeImageTransform(
  tokens: string[],
): VisualCommandSummary | undefined {
  const imagePaths = tokens
    .slice(1)
    .filter((token) => !token.startsWith("-") && looksLikeImagePath(token));
  if (imagePaths.length < 2) return undefined;
  return {
    kind: "image-transform",
    input: imagePaths[0]!,
    output: imagePaths[imagePaths.length - 1]!,
  };
}

function looksLikeImagePath(path: string): boolean {
  return /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(
    path.split(/[?#]/)[0] ?? path,
  );
}

function summarizeCMake(tokens: string[]): VisualCommandSummary | undefined {
  if ((tokens[0] ?? "").split("/").pop()?.toLowerCase() !== "cmake") {
    return undefined;
  }
  const buildIndex = tokens.indexOf("--build");
  if (buildIndex >= 0) {
    return {
      kind: "cmake",
      action: "build",
      build:
        tokens[buildIndex + 1] && !tokens[buildIndex + 1]!.startsWith("-")
          ? tokens[buildIndex + 1]
          : undefined,
    };
  }
  const flags = cmakeFlagAssignmentsFromTokens(tokens);
  if (flags.length === 0) return undefined;
  return {
    kind: "cmake",
    action: "configure",
    source: valueAfterFlag(tokens, "-S"),
    build: valueAfterFlag(tokens, "-B"),
    generator: valueAfterFlag(tokens, "-G"),
  };
}

function summarizeAgentBrowser(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "browser" }> | undefined {
  const browserCommand = agentBrowserCommand(tokens);
  if (!browserCommand) return undefined;
  const { command, args } = browserCommand;
  if (command === "open" || command === "goto" || command === "navigate") {
    return {
      kind: "browser",
      action: "open",
      target: firstPositionalArg(args),
    };
  }
  if (command === "close") return { kind: "browser", action: "close" };
  if (command === "snapshot")
    return {
      kind: "browser",
      action: "snapshot",
      detail: browserFlagDetail(args),
    };
  if (command === "screenshot") {
    return {
      kind: "browser",
      action: "screenshot",
      target: firstPositionalArg(args),
      detail: browserFlagDetail(args),
    };
  }
  if (
    command === "click" ||
    command === "dblclick" ||
    command === "doubleclick"
  ) {
    return {
      kind: "browser",
      action: "click",
      target: firstPositionalArg(args),
      detail: command === "click" ? undefined : "double",
    };
  }
  if (command === "upload") {
    const upload = agentBrowserUploadArgs(args);
    return {
      kind: "browser",
      action: "upload",
      target: upload.target,
      detail: upload.file,
    };
  }
  if (command === "download") {
    const target = firstPositionalArg(args);
    return {
      kind: "browser",
      action: "download",
      target,
      detail: target
        ? firstPositionalArg(args.slice(args.indexOf(target) + 1))
        : undefined,
    };
  }
  if (command === "fill" || command === "type" || command === "select") {
    return {
      kind: "browser",
      action: "fill",
      target: firstPositionalArg(args),
      detail: command,
    };
  }
  if (command === "press" || command === "keyboard") {
    return {
      kind: "browser",
      action: "press",
      target: firstPositionalArg(args),
      detail:
        command === "keyboard" ? firstPositionalArg(args.slice(1)) : undefined,
    };
  }
  if (command === "wait") {
    return {
      kind: "browser",
      action: "wait",
      target: browserWaitTarget(args),
    };
  }
  if (command === "get") {
    return {
      kind: "browser",
      action: "get",
      target: browserGetTarget(args),
    };
  }
  if (command === "scroll") {
    return {
      kind: "browser",
      action: "scroll",
      target: browserScrollTarget(args),
    };
  }
  if (command === "console") {
    return { kind: "browser", action: "console" };
  }
  if (command === "network") {
    const subcommand = args[0]?.toLowerCase();
    return {
      kind: "browser",
      action: "network",
      target:
        subcommand && !subcommand.startsWith("-") ? subcommand : undefined,
    };
  }
  if (command === "pages") return { kind: "browser", action: "pages" };
  if (command === "reload") return { kind: "browser", action: "reload" };
  if (
    command === "eval" ||
    command === "evaluate" ||
    command === "evaluate_script"
  ) {
    return { kind: "browser", action: "script" };
  }
  if (command === "set") {
    const target = args[0]?.toLowerCase();
    if (target === "viewport" || target === "device") {
      return {
        kind: "browser",
        action: "emulate",
        target:
          target === "viewport"
            ? args.slice(1, 3).filter(Boolean).join("x")
            : firstPositionalArg(args.slice(1)),
      };
    }
  }
  return undefined;
}

function agentBrowserUploadArgs(args: string[]): {
  target?: string;
  file?: string;
} {
  const positional = args.filter(
    (arg) => arg && arg !== "--" && !arg.startsWith("-"),
  );
  const toIndex = positional.findIndex((arg) => arg.toLowerCase() === "to");
  if (toIndex > 0) {
    return {
      file: positional[toIndex - 1],
      target: positional[toIndex + 1],
    };
  }
  const target = positional.find((arg) => /^@?e?\d+(?:_\d+)?$/i.test(arg));
  const file =
    positional.find((arg) => arg !== target && looksLikeImagePath(arg)) ??
    positional.find((arg) => arg !== target);
  return { target, file };
}

const AGENT_BROWSER_OPTIONS_WITH_VALUE = new Set([
  "--session",
  "--session-name",
  "--profile",
  "--state",
  "--download-path",
  "--screenshot-dir",
  "--screenshot-format",
  "--screenshot-quality",
  "--selector",
  "--timeout",
  "--browser",
  "--user-data-dir",
  "--cdp",
  "--cdp-url",
]);

function agentBrowserTokenIndex(tokens: readonly string[]): number {
  for (let i = 0; i < tokens.length; i += 1) {
    const name = shellLauncherName(tokens[i] ?? "");
    if (name === "agent-browser") return i;
  }
  return -1;
}

function agentBrowserCommand(
  tokens: readonly string[],
): { command: string; args: string[] } | undefined {
  const browserIndex = agentBrowserTokenIndex(tokens);
  if (browserIndex < 0) return undefined;
  let i = browserIndex + 1;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") {
      i += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    const option = token.split("=")[0]!;
    if (AGENT_BROWSER_OPTIONS_WITH_VALUE.has(option) && !token.includes("=")) {
      i += 1;
    }
  }
  const command = tokens[i]?.toLowerCase();
  if (!command) return undefined;
  return { command, args: tokens.slice(i + 1) };
}

function firstPositionalArg(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1];
    if (!arg.startsWith("-")) return arg;
    if (
      AGENT_BROWSER_OPTIONS_WITH_VALUE.has(arg.split("=")[0]!) &&
      !arg.includes("=")
    ) {
      i += 1;
    }
  }
  return undefined;
}

function browserFlagDetail(args: readonly string[]): string | undefined {
  if (args.includes("-i") || args.includes("--interactive"))
    return "interactive";
  if (args.includes("--full")) return "full page";
  if (args.includes("--annotate")) return "annotated";
  return undefined;
}

function browserWaitTarget(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--load" && args[i + 1]) return `load ${args[i + 1]}`;
    if (arg === "--url" && args[i + 1]) return `URL ${args[i + 1]}`;
    if (arg === "--text" && args[i + 1]) return args[i + 1];
    if (arg === "--fn" && args[i + 1]) return "function";
    if (/^\d+$/.test(arg)) return formatMillisecondsAsSeconds(arg);
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

function browserGetTarget(args: readonly string[]): string | undefined {
  const subject = firstPositionalArg(args);
  if (!subject) return undefined;
  const subjectIndex = args.indexOf(subject);
  const target =
    subjectIndex >= 0
      ? firstPositionalArg(args.slice(subjectIndex + 1))
      : undefined;
  if (subject === "text" && target === "body") return "body text";
  if (target) return `${target} ${subject}`;
  return subject;
}

function browserScrollTarget(args: readonly string[]): string | undefined {
  const direction = firstPositionalArg(args);
  if (!direction) return undefined;
  const directionIndex = args.indexOf(direction);
  const amount =
    directionIndex >= 0
      ? firstPositionalArg(args.slice(directionIndex + 1))
      : undefined;
  return amount ? `${direction} ${amount}` : direction;
}

function formatMillisecondsAsSeconds(value: string): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return value;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function formatSeconds(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return value;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function valueAfterFlag(
  tokens: readonly string[],
  flag: string,
): string | undefined {
  const index = tokens.indexOf(flag);
  const value = index >= 0 ? tokens[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
}

function cmakeFlagAssignmentsFromCommand(
  command: string,
): VisualToolConfigAssignment[] {
  const normalized = normalizeLaunchedCommand(command);
  const parts = splitShellCommandChain(normalized.command);
  const commands = parts.length > 0 ? parts : [normalized.command];
  const assignments: VisualToolConfigAssignment[] = [];
  for (const part of commands) {
    const next = normalizeLaunchedCommand(part);
    const tokens = shellTokens(next.command);
    if ((tokens[0] ?? "").split("/").pop()?.toLowerCase() !== "cmake") {
      continue;
    }
    assignments.push(...cmakeFlagAssignmentsFromTokens(tokens));
  }
  return assignments;
}

function cmakeFlagAssignmentsFromTokens(
  tokens: readonly string[],
): VisualToolConfigAssignment[] {
  const assignments: VisualToolConfigAssignment[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "-S" || token === "-B" || token === "-G") {
      const value = tokens[i + 1];
      if (value && !value.startsWith("-")) {
        assignments.push({
          name:
            token === "-S" ? "SOURCE" : token === "-B" ? "BUILD" : "GENERATOR",
          value,
        });
        i += 1;
      }
      continue;
    }
    if (token === "-D") {
      const value = tokens[i + 1];
      if (value) {
        assignments.push(cmakeDefinitionAssignment(value));
        i += 1;
      }
      continue;
    }
    if (token.startsWith("-D") && token.length > 2) {
      assignments.push(cmakeDefinitionAssignment(token.slice(2)));
    }
  }
  return assignments;
}

function cmakeDefinitionAssignment(value: string): VisualToolConfigAssignment {
  const eq = value.indexOf("=");
  if (eq < 0) return { name: value, value: "ON" };
  return {
    name: value.slice(0, eq),
    value: value.slice(eq + 1),
  };
}

function summarizeRemove(tokens: string[]): VisualCommandSummary | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  const targets = positionalPathTokens(
    tokens.slice(1),
    powershellOptionsWithValue(),
  );
  if (targets.length === 0) return undefined;
  const recursive = tokens.some((token) =>
    /^(?:-r|-R|-rf|-fr|--recursive|-recurse)$/i.test(token),
  );
  return {
    kind: "filesystem",
    action: "delete",
    targetKind: recursive || command === "rmdir" ? "folder" : "path",
    targets,
  };
}

function summarizeCreate(tokens: string[]): VisualCommandSummary | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  const itemType = powershellOptionValue(tokens, "-itemtype")?.toLowerCase();
  const targetKind =
    command === "mkdir" || command === "md" || itemType === "directory"
      ? "folder"
      : command === "touch" || itemType === "file"
        ? "file"
        : "path";
  const targets = positionalPathTokens(
    tokens.slice(1),
    powershellOptionsWithValue(),
  );
  if (targets.length === 0) return undefined;
  return {
    kind: "filesystem",
    action: "create",
    targetKind,
    targets,
  };
}

function summarizeCopyMove(tokens: string[]): VisualCommandSummary | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  const action =
    command === "mv" || command === "move" || command === "move-item"
      ? "move"
      : "copy";
  const targets = positionalPathTokens(
    tokens.slice(1),
    powershellOptionsWithValue(),
  );
  if (targets.length < 2) return undefined;
  return {
    kind: "filesystem",
    action,
    targetKind: "file",
    targets,
  };
}

function powershellOptionsWithValue(): Set<string> {
  return new Set([
    "-erroraction",
    "-filter",
    "-include",
    "-exclude",
    "-credential",
    "-itemtype",
    "-type",
    "-value",
    "-name",
    "-path",
    "-literalpath",
    "-destination",
  ]);
}

function powershellOptionValue(
  tokens: string[],
  optionName: string,
): string | undefined {
  const lower = optionName.toLowerCase();
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index]!.toLowerCase() === lower) return tokens[index + 1];
  }
  return undefined;
}

function positionalPathTokens(
  tokens: string[],
  optionsWithValue: Set<string>,
): string[] {
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (token === "--") continue;
    if (token === "|" || token === ">" || token === "2>") break;
    if (token.startsWith("-")) {
      if (
        (lower === "-path" || lower === "-literalpath") &&
        tokens[index + 1]
      ) {
        targets.push(tokens[index + 1]!);
        index += 1;
        continue;
      }
      if (!token.includes("=") && optionsWithValue.has(lower)) index += 1;
      continue;
    }
    targets.push(token);
  }
  return targets;
}

function summarizePipeCommand(
  command: string,
): VisualCommandSummary | undefined {
  return (
    summarizeContainerCheck(command) ??
    summarizePipeRead(command) ??
    summarizePipeJsonQuery(command) ??
    summarizePipeCount(command) ??
    summarizePipeTextProcess(command) ??
    summarizePipeSearch(command)
  );
}

function summarizePipeRead(
  command: string,
): Extract<VisualCommandSummary, { kind: "read" }> | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length !== 2) return undefined;
  const left = shellTokens(parts[0]!);
  const right = shellTokens(parts[1]!);
  const leftName = left[0]?.split("/").pop();
  const rightName = right[0]?.split("/").pop();
  if (leftName !== "nl" || rightName !== "sed") return undefined;
  const path = left.slice(1).find((token) => !token.startsWith("-"));
  if (!path) return undefined;
  const sed = summarizeSedRanges(right);
  if (!sed) return undefined;
  return {
    kind: "read",
    targets: sed.ranges.map((range) => `${path}${sedRangeSuffix(range)}`),
  };
}

function summarizePipeSearch(
  command: string,
): Extract<VisualCommandSummary, { kind: "search" }> | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return undefined;
  const left = shellTokens(parts[0]!);
  if (!isSearchCommandName(left[0])) return undefined;
  const summary = summarizeSearch(left);
  return summary?.kind === "search" ? summary : undefined;
}

function isSearchCommandName(command: string | undefined): boolean {
  if (!command) return false;
  const name = shellLauncherName(command);
  return (
    name === "rg" || name === "grep" || name === "egrep" || name === "fgrep"
  );
}

function summarizePipeJsonQuery(
  command: string,
): Extract<VisualCommandSummary, { kind: "json-query" }> | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return undefined;
  const query = summarizeJq(shellTokens(parts.at(-1)!));
  if (!query) return undefined;
  const leftSummary = summarizeShellCommand(parts.slice(0, -1).join(" | "));
  if (leftSummary?.kind === "read") {
    return { ...query, targets: leftSummary.targets };
  }
  if (leftSummary?.kind === "fetch") {
    return { ...query, source: leftSummary.url };
  }
  return query.targets.length > 0 ? query : undefined;
}

function summarizePipeCount(
  command: string,
): Extract<VisualCommandSummary, { kind: "count" }> | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return undefined;
  const count = summarizeWc(shellTokens(parts.at(-1)!));
  if (!count) return undefined;
  if (count.targets.length > 0) return count;
  const leftSummary = summarizeShellCommand(parts.slice(0, -1).join(" | "));
  if (leftSummary?.kind === "read") {
    return { ...count, targets: leftSummary.targets };
  }
  if (leftSummary?.kind === "find") {
    return { ...count, metric: "items", targets: [leftSummary.root] };
  }
  if (leftSummary?.kind === "git" && leftSummary.action === "ls-files") {
    return { ...count, metric: "items", targets: leftSummary.targets };
  }
  return count;
}

function summarizePipeSize(
  command: string,
): Extract<VisualCommandSummary, { kind: "size" }> | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return undefined;
  const size = summarizeDu(shellTokens(parts[0]!));
  return size?.targets.length ? size : undefined;
}

function summarizePipeTextProcess(
  command: string,
): Extract<VisualCommandSummary, { kind: "text-process" }> | undefined {
  const parts = splitShellPipeline(command);
  if (parts.length < 2) return undefined;
  const textProcess = summarizeAwk(shellTokens(parts.at(-1)!));
  if (!textProcess) return undefined;
  const leftSummary = summarizeShellCommand(parts.slice(0, -1).join(" | "));
  if (!leftSummary) return textProcess;
  const targets = summaryTargetsForPipeSource(leftSummary);
  if (targets.length > 0) return { ...textProcess, targets };
  if (leftSummary.kind === "fetch") {
    return { ...textProcess, source: leftSummary.url };
  }
  return textProcess;
}

function summaryTargetsForPipeSource(summary: VisualCommandSummary): string[] {
  if (summary.kind === "read" || summary.kind === "logs")
    return summary.targets;
  if (summary.kind === "search") return summary.paths;
  if (summary.kind === "find") return [summary.root];
  if (summary.kind === "git") return summary.targets;
  if (summary.kind === "json-query" || summary.kind === "count") {
    return summary.targets;
  }
  return [];
}

function splitShellPipeline(command: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "|") {
      const part = command.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

type SedLineRange = { start: string; end?: string };

function parseSedRangeScript(script: string): SedLineRange[] | undefined {
  const clauses = script
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length === 0) return undefined;
  const ranges: SedLineRange[] = [];
  for (const clause of clauses) {
    const match = clause.match(/^(\d+)(?:,(\d+))?p$/);
    if (!match) return undefined;
    ranges.push({ start: match[1]!, end: match[2] });
  }
  return ranges;
}

function summarizeSedRanges(
  tokens: string[],
): { ranges: SedLineRange[]; tokenIndex: number } | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const ranges = parseSedRangeScript(tokens[i]!);
    if (ranges) return { ranges, tokenIndex: i };
  }
  return undefined;
}

function sedRangeSuffix(range: SedLineRange): string {
  return range.end ? `:${range.start}-${range.end}` : `:${range.start}`;
}

function summarizeSedRead(tokens: string[]): VisualCommandSummary | undefined {
  const sed = summarizeSedRanges(tokens);
  const path = sed
    ? tokens
        .slice(sed.tokenIndex + 1)
        .find((candidate) => !candidate.startsWith("-"))
    : undefined;
  if (!sed || !path) return undefined;
  return {
    kind: "read",
    targets: sed.ranges.map((range) => `${path}${sedRangeSuffix(range)}`),
  };
}

function summarizeCatRead(tokens: string[]): VisualCommandSummary | undefined {
  const paths = tokens
    .slice(1)
    .filter((token) => !token.startsWith("-") && !/[|<>]/.test(token));
  if (paths.length === 0) return undefined;
  return { kind: "read", targets: paths };
}

function summarizeGetContentRead(
  tokens: string[],
): VisualCommandSummary | undefined {
  const optionsWithValue = new Set([
    ...powershellOptionsWithValue(),
    "-totalcount",
    "-tail",
    "-readcount",
    "-encoding",
    "-delimiter",
    "-stream",
    "-replace",
  ]);
  const targets = positionalPathTokens(tokens.slice(1), optionsWithValue)
    .map(cleanPowerShellBoundaryToken)
    .filter((token) => token && !/[|<>]/.test(token) && !token.startsWith("-"));
  if (targets.length === 0) return undefined;
  const totalCount = powershellOptionValue(tokens, "-totalcount");
  return {
    kind: "read",
    targets: targets.map((target) =>
      totalCount && /^\d+$/.test(totalCount)
        ? `${target}:1-${totalCount}`
        : target,
    ),
  };
}

function summarizeSearch(tokens: string[]): VisualCommandSummary | undefined {
  let pattern: string | undefined;
  const paths: string[] = [];
  const optionsWithValue = new Set([
    "-e",
    "-f",
    "-g",
    "-t",
    "-T",
    "-C",
    "-A",
    "-B",
    "--regexp",
    "--file",
    "--glob",
    "--type",
    "--type-not",
    "--context",
    "--after-context",
    "--before-context",
  ]);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") continue;
    if (optionsWithValue.has(token)) {
      const value = tokens[i + 1];
      if ((token === "-e" || token === "--regexp") && value) {
        pattern = value;
      }
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (!pattern) {
      pattern = token;
    } else {
      paths.push(token);
    }
  }
  if (!pattern) return undefined;
  return { kind: "search", pattern, paths };
}

function summarizeFind(tokens: string[]): VisualCommandSummary | undefined {
  const root = tokens.slice(1).find((token) => !token.startsWith("-"));
  if (!root) return undefined;
  const patterns: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if ((token === "-name" || token === "-iname") && tokens[i + 1]) {
      patterns.push(tokens[i + 1]!);
      i += 1;
    }
  }
  return { kind: "find", root, patterns };
}

function summarizeLs(tokens: string[]): VisualCommandSummary | undefined {
  if (!lsRequestsDetails(tokens)) return undefined;
  const targets = positionalPathTokens(tokens.slice(1), new Set());
  if (targets.length === 0) {
    return { kind: "find", root: ".", patterns: [] };
  }
  if (targets.length === 1 && (targets[0] === "." || targets[0] === "./")) {
    return { kind: "find", root: ".", patterns: [] };
  }
  return { kind: "read", targets };
}

function summarizeGetPsDrive(
  tokens: string[],
): Extract<VisualCommandSummary, { kind: "drive-check" }> | undefined {
  const provider = powershellOptionValue(tokens, "-psprovider")?.toLowerCase();
  if (provider && provider !== "filesystem") return undefined;
  return { kind: "drive-check" };
}

function summarizeGetChildItem(
  tokens: string[],
): VisualCommandSummary | undefined {
  const recursive = tokens.some((token) =>
    /^(?:-recurse|-recursive)$/i.test(token),
  );
  const wantsDirectories = tokens.some((token) =>
    /(?:^|\s)(?:-directory|-dir|-ad)(?:\s|$)/i.test(token),
  );
  const targets = positionalPathTokens(
    tokens.slice(1),
    powershellOptionsWithValue(),
  )
    .flatMap(splitPowerShellPathList)
    .filter(
      (target) => target && !/[|<>]/.test(target) && !target.startsWith("-"),
    );
  if (targets.length === 0) {
    return wantsDirectories || !recursive
      ? { kind: "directory", targets: ["."] }
      : undefined;
  }
  if (wantsDirectories || targets.every(looksLikeDirectoryTarget)) {
    return { kind: "directory", targets };
  }
  return { kind: "read", targets };
}

function splitPowerShellPathList(token: string): string[] {
  return token.split(",").map(cleanPowerShellPathToken).filter(Boolean);
}

function cleanPowerShellPathToken(token: string): string {
  return cleanPowerShellBoundaryToken(token)
    .replace(/\s+-[A-Za-z][\s\S]*$/, "")
    .trim();
}

function looksLikeDirectoryTarget(target: string): boolean {
  return (
    target === "." ||
    target === "./" ||
    target === ".\\" ||
    target.endsWith("/") ||
    target.endsWith("\\") ||
    /^[A-Za-z]:[\\/]?$/.test(target)
  );
}

function summarizeProcessCheck(
  command: string,
): VisualCommandSummary | undefined {
  const powershellProcess = summarizePowerShellProcessCheck(command);
  if (powershellProcess) return powershellProcess;
  const tokens = shellTokens(command);
  const name = tokens[0]?.split("/").pop()?.toLowerCase();
  if (name === "pgrep") {
    const pattern = tokens
      .slice(1)
      .find((token) => token && !token.startsWith("-") && token !== "||");
    return { kind: "process-check", pattern };
  }
  if (name !== "ps") return undefined;
  const pipeIndex = tokens.findIndex((token) => token === "|");
  if (pipeIndex < 0) return { kind: "process-check" };
  const filter = tokens[pipeIndex + 1]?.split("/").pop()?.toLowerCase();
  if (filter !== "rg" && filter !== "grep") return { kind: "process-check" };
  const pattern = tokens
    .slice(pipeIndex + 2)
    .find((token) => token && !token.startsWith("-"));
  return { kind: "process-check", pattern };
}

function summarizePowerShellProcessCheck(
  command: string,
): Extract<VisualCommandSummary, { kind: "process-check" }> | undefined {
  const parts = splitShellPipeline(command);
  const first = shellTokens(parts[0] ?? command).map(
    cleanPowerShellBoundaryToken,
  );
  const name = first[0]?.split("/").pop()?.toLowerCase();
  if (name === "get-process" || name === "gps") {
    return {
      kind: "process-check",
      pids: powershellProcessIds(first),
    };
  }
  if (
    name === "get-ciminstance" ||
    name === "gcim" ||
    name === "get-wmiobject" ||
    name === "gwmi"
  ) {
    const className = first
      .slice(1)
      .find((token) => token && !token.startsWith("-"));
    if (!className || !/^win32_process$/i.test(className)) return undefined;
    return {
      kind: "process-check",
      pattern: powershellProcessPattern(command),
    };
  }
  return undefined;
}

function powershellProcessIds(tokens: string[]): string[] | undefined {
  const ids = new Set<string>();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === "-id" || lower === "-pid") {
      const value = tokens[index + 1];
      if (value) {
        for (const part of value.split(",")) {
          if (/^\d+$/.test(part)) ids.add(part);
        }
        index += 1;
      }
      continue;
    }
    const inline = token.match(/^-(?:id|pid):?(\d+(?:,\d+)*)$/i);
    if (inline) {
      for (const part of inline[1]!.split(",")) ids.add(part);
    }
  }
  return ids.size > 0 ? [...ids] : undefined;
}

function powershellProcessPattern(command: string): string | undefined {
  const like = command.match(/-like\s+["']?\*?([^*"'\s)]+)\*?["']?/i)?.[1];
  if (like) return like;
  const match = command.match(
    /\b(?:rg|grep)\b\s+(?:-[A-Za-z]+\s+)*["']?([^"'\s|)]+)/i,
  );
  return match?.[1];
}

function summarizeContainerCheck(
  command: string,
): Extract<VisualCommandSummary, { kind: "container-check" }> | undefined {
  const parts = splitShellPipeline(command);
  const left = shellTokens(parts[0] ?? command);
  if (!isDockerContainerList(left)) return undefined;
  const filter = parts.length > 1 ? shellTokens(parts[1]!) : [];
  const filterName = filter[0]?.split("/").pop()?.toLowerCase();
  if (filterName !== "rg" && filterName !== "grep") {
    return { kind: "container-check" };
  }
  const pattern = filter
    .slice(1)
    .find((token) => token && !token.startsWith("-"));
  return { kind: "container-check", pattern };
}

function isDockerContainerList(tokens: string[]): boolean {
  const command = shellLauncherName(tokens[0] ?? "");
  if (command !== "docker") return false;
  const first = tokens[1]?.toLowerCase();
  if (first === "ps") return true;
  return first === "container" && tokens[2]?.toLowerCase() === "ls";
}

function commandSummaryParts(
  summary: VisualCommandSummary,
  context?: VisualToolPreviewContext,
): VisualToolPreviewPart[] {
  if (summary.kind === "read") return readPreviewParts(summary.targets);
  if (summary.kind === "directory") {
    return directoryPreviewParts(summary.targets);
  }
  if (summary.kind === "logs") {
    return [
      { kind: "text", text: "Read logs " },
      ...interspersePathParts(summary.targets),
      ...(summary.tailLines
        ? [{ kind: "text" as const, text: ` last ${summary.tailLines}` }]
        : []),
    ];
  }
  if (summary.kind === "search") {
    return searchPreviewParts(summary.pattern, summary.paths);
  }
  if (summary.kind === "batch-files") {
    return batchFilePreviewParts(summary);
  }
  if (summary.kind === "count") {
    return countPreviewParts(summary);
  }
  if (summary.kind === "size") {
    return sizePreviewParts(summary.targets);
  }
  if (summary.kind === "json-query") {
    return jsonQueryPreviewParts(summary);
  }
  if (summary.kind === "text-process") {
    return textProcessPreviewParts(summary);
  }
  if (summary.kind === "script-file") {
    return [
      ...interspersePathParts([summary.script]),
      ...(summary.args.length
        ? [{ kind: "text" as const, text: ` ${summary.args.join(" ")}` }]
        : []),
    ];
  }
  if (summary.kind === "process-check") {
    if (summary.pids?.length) {
      const label =
        summary.pids.length === 1 ? "Check process" : "Check processes";
      return [
        {
          kind: "text",
          text: `${label} ${summary.pids.join(", ")}`,
        },
      ];
    }
    return [
      {
        kind: "text",
        text: summary.pattern
          ? `Check processes for "${readableSearchPattern(summary.pattern)}"`
          : "Check processes",
      },
    ];
  }
  if (summary.kind === "container-check") {
    return [
      {
        kind: "text",
        text: summary.pattern
          ? `Check containers for "${readableSearchPattern(summary.pattern)}"`
          : "Check containers",
      },
    ];
  }
  if (summary.kind === "process-end") {
    const label = summary.pids.length === 1 ? "Stop process" : "Stop processes";
    return [{ kind: "text", text: `${label} ${summary.pids.join(", ")}` }];
  }
  if (summary.kind === "drive-check") {
    return [{ kind: "text", text: "Check Windows drives" }];
  }
  if (summary.kind === "port-check") {
    const label = summary.ports.length === 1 ? "Check port" : "Check ports";
    return [{ kind: "text", text: `${label} ${summary.ports.join(", ")}` }];
  }
  if (summary.kind === "ssh-tunnel") {
    return [
      {
        kind: "text",
        text: `Open tunnel ${summary.local} -> ${summary.remote}`,
      },
    ];
  }
  if (summary.kind === "remote-transfer") {
    return [
      {
        kind: "text",
        text: summary.action === "upload" ? "Upload " : "Download ",
      },
      ...interspersePathParts([summary.local]),
      { kind: "text", text: " " },
      { kind: "text", text: summary.action === "upload" ? "to " : "from " },
      { kind: "text", text: `${summary.host}:` },
      ...interspersePathParts([summary.remotePath]),
    ];
  }
  if (summary.kind === "screen-sessions") {
    return [{ kind: "text", text: "List screen sessions" }];
  }
  if (summary.kind === "listener-check") {
    return [
      {
        kind: "text",
        text: `Check listeners for ${summary.terms.join(", ")}`,
      },
    ];
  }
  if (summary.kind === "wait") {
    return [
      { kind: "text", text: `Wait for ${formatSeconds(summary.seconds)}` },
    ];
  }
  if (summary.kind === "wait-url") {
    return [
      { kind: "text", text: "Wait for " },
      { kind: "text", text: readableUrl(summary.url) },
    ];
  }
  if (summary.kind === "database") {
    const parts: VisualToolPreviewPart[] = [
      { kind: "text", text: `Query ${summary.engine}` },
    ];
    if (summary.database) {
      parts.push({ kind: "text", text: " " });
      if (summary.engine === "SQLite" && looksLikePathToken(summary.database)) {
        parts.push(...interspersePathParts([summary.database]));
      } else {
        parts.push({ kind: "text", text: summary.database });
      }
    }
    if (summary.query) parts.push({ kind: "text", text: ` ${summary.query}` });
    return parts;
  }
  if (summary.kind === "browser") {
    return browserSummaryParts(summary, context);
  }
  if (summary.kind === "git") {
    return gitSummaryParts(summary);
  }
  if (summary.kind === "test") {
    return testSummaryParts(summary);
  }
  if (summary.kind === "fetch") {
    return [
      { kind: "text", text: "Fetch " },
      { kind: "text", text: readableUrl(summary.url) },
      ...(summary.output
        ? [
            { kind: "text" as const, text: " to " },
            ...interspersePathParts([summary.output]),
          ]
        : []),
    ];
  }
  if (summary.kind === "image-transform") {
    return [
      { kind: "text", text: "Convert image " },
      ...interspersePathParts([summary.input]),
      { kind: "text", text: " -> " },
      ...interspersePathParts([summary.output]),
    ];
  }
  if (summary.kind === "cmake") {
    const parts: VisualToolPreviewPart[] = [
      {
        kind: "text",
        text: summary.action === "build" ? "Build CMake" : "Configure CMake",
      },
    ];
    if (summary.action === "configure" && summary.source) {
      parts.push({ kind: "text", text: " " });
      parts.push(...interspersePathParts([summary.source]));
    }
    if (summary.build) {
      parts.push({
        kind: "text",
        text: summary.action === "build" ? " " : " -> ",
      });
      parts.push(...interspersePathParts([summary.build]));
    }
    return parts;
  }
  if (summary.kind === "filesystem") {
    if (summary.action === "copy" || summary.action === "move") {
      const action = summary.action === "copy" ? "Copy" : "Move";
      const sources = summary.targets.slice(0, -1);
      const destination = summary.targets.at(-1);
      return [
        { kind: "text", text: `${action} ` },
        ...interspersePathParts(sources),
        ...(destination
          ? [
              { kind: "text" as const, text: " -> " },
              ...interspersePathParts([destination]),
            ]
          : []),
      ];
    }
    const action = summary.action === "create" ? "Create" : "Delete";
    return [
      { kind: "text", text: `${action} ${summary.targetKind} ` },
      ...interspersePathParts(summary.targets),
    ];
  }
  return findPreviewParts(summary);
}

function batchFilePreviewParts(
  summary: Extract<VisualCommandSummary, { kind: "batch-files" }>,
): VisualToolPreviewPart[] {
  const lowerTool = summary.tool.toLowerCase();
  const label =
    lowerTool === "usdchecker" || lowerTool === "usdchecker.py"
      ? "Check USD files "
      : `Run ${summary.tool} on `;
  return [
    { kind: "text", text: label },
    ...interspersePathParts(summary.targets),
  ];
}

function textProcessPreviewParts(
  summary: Extract<VisualCommandSummary, { kind: "text-process" }>,
): VisualToolPreviewPart[] {
  const parts: VisualToolPreviewPart[] = [
    { kind: "text", text: "Process text" },
  ];
  if (summary.targets.length > 0) {
    parts.push(
      { kind: "text", text: " in " },
      ...interspersePathParts(summary.targets),
    );
  } else if (summary.source) {
    parts.push({ kind: "text", text: ` from ${readableUrl(summary.source)}` });
  }
  const expression = compactAwkExpression(summary.expression);
  parts.push({
    kind: "text",
    text: expression ? ` with awk ${expression}` : " with awk",
  });
  return parts;
}

function compactAwkExpression(expression: string): string {
  return expression.replace(/\s+/g, " ").trim();
}

function countPreviewParts(
  summary: Extract<VisualCommandSummary, { kind: "count" }>,
): VisualToolPreviewPart[] {
  const metric =
    summary.metric === "lines"
      ? "lines"
      : summary.metric === "bytes"
        ? "bytes"
        : summary.metric === "words"
          ? "words"
          : summary.metric === "chars"
            ? "characters"
            : "items";
  if (summary.targets.length === 0) {
    return [{ kind: "text", text: `Count ${metric}` }];
  }
  return [
    { kind: "text", text: `Count ${metric} in ` },
    ...interspersePathParts(summary.targets),
  ];
}

function sizePreviewParts(targets: readonly string[]): VisualToolPreviewPart[] {
  if (targets.length === 0) return [{ kind: "text", text: "Check size" }];
  return [
    { kind: "text", text: "Check size of " },
    ...interspersePathParts(targets),
  ];
}

function jsonQueryPreviewParts(
  summary: Extract<VisualCommandSummary, { kind: "json-query" }>,
): VisualToolPreviewPart[] {
  const parts: VisualToolPreviewPart[] = [{ kind: "text", text: "Query JSON" }];
  if (summary.targets.length > 0) {
    parts.push(
      { kind: "text", text: " " },
      ...interspersePathParts(summary.targets),
    );
  } else if (summary.source) {
    parts.push({ kind: "text", text: ` ${readableUrl(summary.source)}` });
  }
  const filter = compactJsonQueryFilter(summary.filter);
  if (filter && filter !== ".")
    parts.push({ kind: "text", text: ` ${filter}` });
  return parts;
}

function compactJsonQueryFilter(filter: string): string {
  return filter.replace(/\s+/g, " ").trim();
}

function gitSummaryParts(
  summary: Extract<VisualCommandSummary, { kind: "git" }>,
): VisualToolPreviewPart[] {
  if (summary.action === "status") {
    return [{ kind: "text", text: "Check git status" }];
  }
  if (summary.action === "diff-check") {
    return [
      {
        kind: "text",
        text: `${summary.staged ? "Check staged" : "Check"} diff whitespace`,
      },
    ];
  }
  if (summary.action === "diff-stat") {
    return [
      {
        kind: "text",
        text: `${summary.staged ? "Review staged" : "Review"} diff stats${summary.targets.length ? " " : ""}`,
      },
      ...interspersePathParts(summary.targets, {
        diffKind: summary.staged ? "staged" : "workdir",
      }),
    ];
  }
  if (summary.action === "diff") {
    return [
      {
        kind: "text",
        text: `${summary.staged ? "Review staged diff" : "Review diff"}${summary.targets.length ? " " : ""}`,
      },
      ...interspersePathParts(summary.targets, {
        diffKind: summary.staged ? "staged" : "workdir",
      }),
    ];
  }
  if (summary.action === "show-file-search") {
    return [
      { kind: "text", text: "Search " },
      ...interspersePathParts(summary.targets),
      { kind: "text", text: ` from ${summary.rev ?? "git"} ` },
      {
        kind: "text",
        text: `for "${readableSearchPattern(summary.pattern ?? "")}"`,
      },
    ];
  }
  if (summary.action === "show-file") {
    return [
      { kind: "text", text: "Show " },
      ...interspersePathParts(summary.targets),
      { kind: "text", text: ` from ${summary.rev ?? "git"}` },
    ];
  }
  if (summary.action === "show") {
    return [
      {
        kind: "text",
        text: `Show ${summary.targets[0] ?? "HEAD"}`,
      },
    ];
  }
  if (summary.action === "ls-files") {
    return [
      { kind: "text", text: "List tracked files" },
      ...prefixedPathSuffixList(summary.targets, " in ", 2),
    ];
  }
  if (summary.action === "log") {
    return [{ kind: "text", text: "Show recent commits" }];
  }
  if (summary.action === "branch") {
    return [{ kind: "text", text: "Show current branch" }];
  }
  if (summary.action === "rev-parse") {
    return [{ kind: "text", text: "Show current commit" }];
  }
  if (summary.action === "rev-list-count") {
    return [
      {
        kind: "text",
        text: `Count commits${summary.targets.length ? ` ${summary.targets.join(", ")}` : ""}`,
      },
    ];
  }
  if (summary.action === "check-ignore") {
    return [
      { kind: "text", text: "Check git ignore" },
      ...prefixedPathList(summary.targets, " for "),
    ];
  }
  if (summary.action === "add") {
    return [
      { kind: "text", text: "Stage" },
      ...prefixedPathList(summary.targets),
    ];
  }
  if (summary.action === "commit") {
    return [{ kind: "text", text: "Commit changes" }];
  }
  return [];
}

function testSummaryParts(
  summary: Extract<VisualCommandSummary, { kind: "test" }>,
): VisualToolPreviewPart[] {
  const checkLabel =
    summary.runner === "TypeScript"
      ? "Run TypeScript check"
      : summary.runner === "Svelte"
        ? "Run Svelte check"
        : summary.runner === "Shell" && summary.check
          ? "Check shell syntax"
          : `Run ${summary.runner} tests`;
  return [
    { kind: "text", text: checkLabel },
    ...prefixedTestTargetList(summary.targets),
  ];
}

function prefixedTestTargetList(
  targets: readonly string[],
  prefix = " ",
): VisualToolPreviewPart[] {
  if (targets.length === 0) return [];
  const parts: VisualToolPreviewPart[] = [{ kind: "text", text: prefix }];
  targets.forEach((target, index) => {
    if (index > 0) parts.push({ kind: "text", text: ", " });
    if (looksLikePathTarget(target)) {
      parts.push(...interspersePathParts([target]));
    } else {
      parts.push({ kind: "text", text: target });
    }
  });
  return parts;
}

function browserSummaryParts(
  summary: Extract<VisualCommandSummary, { kind: "browser" }>,
  context?: VisualToolPreviewContext,
): VisualToolPreviewPart[] {
  if (summary.action === "open") {
    return [
      { kind: "text", text: "Open browser " },
      {
        kind: "text",
        text: summary.target ? readableUrl(summary.target) : "page",
      },
    ];
  }
  if (summary.action === "close") return textPreviewParts("Close browser");
  if (summary.action === "snapshot") {
    return textPreviewParts(
      summary.detail
        ? `Capture browser snapshot (${summary.detail})`
        : "Capture browser snapshot",
    );
  }
  if (summary.action === "screenshot") {
    const prefix = summary.detail
      ? `Capture browser screenshot (${summary.detail})`
      : "Capture browser screenshot";
    if (!summary.target) return textPreviewParts(prefix);
    return [
      { kind: "text", text: `${prefix} ` },
      ...interspersePathParts([summary.target]),
    ];
  }
  if (summary.action === "click") {
    const target = browserTargetLabel(summary, context);
    return textPreviewParts(
      `${summary.detail === "double" ? "Double-click" : "Click"} browser element${
        target ? ` ${target}` : ""
      }`,
    );
  }
  if (summary.action === "upload") {
    const target = browserTargetLabel(summary, context);
    const parts: VisualToolPreviewPart[] = [
      { kind: "text", text: "Upload " },
      ...(summary.detail
        ? interspersePathParts([summary.detail])
        : textPreviewParts("file")),
    ];
    if (target) {
      parts.push({ kind: "text", text: ` to ${target}` });
    }
    return parts;
  }
  if (summary.action === "download") {
    const parts: VisualToolPreviewPart[] = [
      { kind: "text", text: "Download from browser" },
    ];
    if (summary.detail) {
      parts.push(
        { kind: "text", text: " to " },
        ...interspersePathParts([summary.detail]),
      );
    } else if (summary.target) {
      parts.push({ kind: "text", text: ` ${summary.target}` });
    }
    return parts;
  }
  if (summary.action === "fill") {
    const target = browserTargetLabel(summary, context);
    const verb =
      summary.detail === "type"
        ? "Type into"
        : summary.detail === "select"
          ? "Select in"
          : "Fill";
    return textPreviewParts(
      `${verb} browser element${target ? ` ${target}` : ""}`,
    );
  }
  if (summary.action === "press") {
    return textPreviewParts(
      `Press browser key${summary.target ? ` ${summary.target}` : ""}`,
    );
  }
  if (summary.action === "wait") {
    return textPreviewParts(
      summary.target
        ? `Wait for browser ${summary.target}`
        : "Wait for browser",
    );
  }
  if (summary.action === "get") {
    return textPreviewParts(
      summary.target ? `Read browser ${summary.target}` : "Read browser",
    );
  }
  if (summary.action === "scroll") {
    return textPreviewParts(
      summary.target ? `Scroll browser ${summary.target}` : "Scroll browser",
    );
  }
  if (summary.action === "console") {
    return textPreviewParts("Check console messages");
  }
  if (summary.action === "network") {
    return textPreviewParts(
      summary.target === "requests"
        ? "Check network requests"
        : summary.target
          ? `Check network ${summary.target}`
          : "Check network",
    );
  }
  if (summary.action === "pages") return textPreviewParts("List browser pages");
  if (summary.action === "reload") return textPreviewParts("Reload page");
  if (summary.action === "emulate") {
    return textPreviewParts(
      summary.target ? `Emulate ${summary.target}` : "Emulate browser",
    );
  }
  if (summary.action === "script")
    return textPreviewParts("Run browser script");
  return textPreviewParts("Use browser");
}

function browserTargetLabel(
  summary: Extract<VisualCommandSummary, { kind: "browser" }>,
  context?: VisualToolPreviewContext,
): string | undefined {
  if (summary.targetLabel) return summary.targetLabel;
  if (!summary.target) return undefined;
  return context?.snapshotUidLabels?.get(summary.target) ?? summary.target;
}

function prefixedPathSuffixList(
  targets: readonly string[],
  prefix: string,
  minDepth: number,
): VisualToolPreviewPart[] {
  if (targets.length === 0) return [];
  const parts: VisualToolPreviewPart[] = [{ kind: "text", text: prefix }];
  targets.forEach((target, index) => {
    if (index > 0) parts.push({ kind: "text", text: ", " });
    const parsed = parsePathTarget(target);
    const segments = pathSegments(parsed.path);
    const depth = Math.min(Math.max(1, minDepth), segments.length);
    parts.push({
      kind: "path",
      text: `${segments.slice(-depth).join("/")}${parsed.range}`,
      path: parsed.path,
      range: parsed.range,
    });
  });
  return parts;
}

function looksLikePathTarget(target: string): boolean {
  return (
    target.includes("/") ||
    target.includes("\\") ||
    /(?:^|[.-])(?:test|spec)\./i.test(target) ||
    /\.(?:[cm]?[jt]sx?|svelte|py|rb|go|rs|java|cs|php|mjs|cjs)$/i.test(
      target,
    ) ||
    /\.(?:bash|sh|zsh|fish|ksh)$/i.test(target)
  );
}

function prefixedPathList(
  targets: readonly string[],
  prefix = " ",
): VisualToolPreviewPart[] {
  if (targets.length === 0) return [];
  return [{ kind: "text", text: prefix }, ...interspersePathParts(targets)];
}

function readableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function readableSearchPattern(pattern: string): string {
  return pattern.replace(/\\([(){}[\]])/g, "$1");
}

function readableFindPattern(pattern: string): string {
  return pattern.replace(/\\([(){}[\]])/g, "$1");
}

function inlineScriptFromStructuredTool(
  toolName: string,
  input: unknown,
): VisualToolInlineScript | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const name = toolName.toLowerCase();
  if (!name.includes("evaluate_script")) return undefined;
  const fn = stringField(input as Record<string, unknown>, "function");
  return fn ? inlineScriptDisplay("node", fn) : undefined;
}

function inlineScriptFromCommandPreservingHeredoc(
  command: string,
): VisualToolInlineScript | undefined {
  return (
    agentBrowserEvalScriptFromCommand(command) ??
    agentBrowserEvalScriptFromCommand(
      normalizeLaunchedCommand(command).command,
    ) ??
    inlineScriptFromCommand(command) ??
    inlineScriptFromCommand(normalizeLaunchedCommand(command).command)
  );
}

function agentBrowserEvalScriptFromCommand(
  command: string,
): VisualToolInlineScript | undefined {
  const browserCommand = agentBrowserCommand(shellTokens(command));
  if (!browserCommand) return undefined;
  if (
    browserCommand.command !== "eval" &&
    browserCommand.command !== "evaluate" &&
    browserCommand.command !== "evaluate_script"
  ) {
    return undefined;
  }
  const script = firstPositionalArg(browserCommand.args);
  return script ? inlineScriptDisplay("node", script) : undefined;
}

function directScriptCommand(
  command: string,
): Extract<VisualCommandSummary, { kind: "script-file" }> | undefined {
  const tokens = shellTokens(command);
  if (tokens.length < 2) return undefined;
  const runtimeIndex = tokens.findIndex((token) =>
    /^(?:python3?|node|bun|deno|swift|ruby|perl)$/.test(
      token.split("/").pop() ?? token,
    ),
  );
  if (runtimeIndex < 0) return undefined;
  const runtime =
    tokens[runtimeIndex]!.split("/").pop() ?? tokens[runtimeIndex]!;
  for (let i = runtimeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "-c" || token === "-e" || token === "--eval") {
      return undefined;
    }
    if (token.startsWith("-")) continue;
    if (!looksLikeScriptPath(token)) continue;
    return {
      kind: "script-file",
      language: inlineScriptLanguage(runtime),
      script: token,
      args: tokens.slice(i + 1),
    };
  }
  return undefined;
}

function looksLikeScriptPath(path: string): boolean {
  return /\.(?:[cm]?js|jsx|ts|tsx|mjs|cjs|py|rb|pl|swift)$/i.test(path);
}

function inlineScriptFromCommand(
  command: string,
): VisualToolInlineScript | undefined {
  const heredoc = command.match(
    /(?:^|\s)(python3?|node|bun|deno|swift|ruby|perl)\b[\s\S]*?<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?(?:[ \t]*\r?\n|[ \t]+)([\s\S]*?)\r?\n\2\b/,
  );
  if (heredoc) {
    return inlineScriptDisplay(heredoc[1]!, heredoc[3]!);
  }

  const tokens = shellTokens(command);
  if (tokens.length < 2) return undefined;
  const runtimeIndex = tokens.findIndex((token) =>
    /^(?:python3?|node|bun|deno|swift|ruby|perl)$/.test(
      token.split("/").pop() ?? token,
    ),
  );
  if (runtimeIndex < 0) return undefined;
  const runtime =
    tokens[runtimeIndex]!.split("/").pop() ?? tokens[runtimeIndex]!;
  for (let i = runtimeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "-c" || token === "-e" || token === "--eval") {
      const code = tokens[i + 1];
      return code ? inlineScriptDisplay(runtime, code) : undefined;
    }
  }
  return undefined;
}

function inlineScriptDisplay(
  runtime: string,
  code: string,
): VisualToolInlineScript {
  const language = inlineScriptLanguage(runtime);
  return {
    language,
    title: inlineScriptTitle(language),
    code: formatInlineScript(code),
  };
}

function inlineScriptLanguage(runtime: string): string {
  const lower = runtime.toLowerCase();
  if (lower === "python" || lower === "python3") return "python";
  if (lower === "node" || lower === "bun" || lower === "deno") return "js";
  if (lower === "swift") return "swift";
  if (lower === "ruby") return "ruby";
  if (lower === "perl") return "perl";
  return "text";
}

function inlineScriptTitle(language: string): string {
  return `${inlineScriptLanguageLabel(language)} script`;
}

function inlineScriptLanguageLabel(language: string): string {
  if (language === "js") return "JavaScript";
  return `${language[0]!.toUpperCase()}${language.slice(1)}`;
}

function formatInlineScript(code: string): string {
  const trimmed = code.trim();
  if (trimmed.includes("\n")) return trimmed;
  return trimmed.replace(/;\s+/g, ";\n");
}

export function visualToolIsTestCommand(
  block: MessageBlock | undefined,
): boolean {
  return !!visualToolTestSummary(block);
}

function editActionLabel(action: VisualFileEdit["action"]): string {
  if (action === "added") return "Added";
  if (action === "deleted") return "Deleted";
  return "Edited";
}

function summarizeFileEdits(
  files: VisualFileEdit[],
): VisualFileEditSummary | undefined {
  if (files.length === 0) return undefined;
  const title =
    files.length === 1
      ? `${editActionLabel(files[0]!.action)} ${files[0]!.path.split("/").pop()}`
      : `Edited ${files.length} files`;
  return { title, files };
}

function parseApplyPatchEdits(
  patch: string,
): VisualFileEditSummary | undefined {
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

function filePathFromObject(
  input: Record<string, unknown>,
): string | undefined {
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

function countUnifiedDiffLines(
  diff: unknown,
): { additions: number; deletions: number } | undefined {
  if (typeof diff !== "string") return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function rawDiffFromChange(item: Record<string, unknown>): string | undefined {
  const raw = item.unified_diff ?? item.unifiedDiff ?? item.diff ?? item.patch;
  return typeof raw === "string" ? raw : undefined;
}

function actionFromChangeKind(kind: string): VisualFileEdit["action"] {
  if (kind.includes("add") || kind === "create") return "added";
  if (kind.includes("delete") || kind.includes("remove")) return "deleted";
  return "edited";
}

function lineCountsFromChange(
  item: Record<string, unknown>,
  action: VisualFileEdit["action"],
): Pick<VisualFileEdit, "additions" | "deletions" | "raw"> {
  const raw = rawDiffFromChange(item);
  const diffCounts = countUnifiedDiffLines(raw);
  if (diffCounts) {
    return { ...diffCounts, raw };
  }
  if (typeof item.content === "string" && action === "added") {
    return { additions: changedLineCount(item.content), deletions: 0 };
  }
  return {
    additions: numberField(item, "additions") ?? numberField(item, "added"),
    deletions: numberField(item, "deletions") ?? numberField(item, "deleted"),
    raw,
  };
}

function fileChangeFromRecord(
  item: Record<string, unknown>,
  fallbackPath?: string,
): VisualFileEdit | undefined {
  const path = filePathFromObject(item) ?? fallbackPath;
  if (!path) return undefined;
  const kind = String(item.type ?? item.action ?? "edited").toLowerCase();
  const action = actionFromChangeKind(kind);
  return {
    path,
    action,
    ...lineCountsFromChange(item, action),
  };
}

function fileChangesFromInput(input: unknown): VisualFileEdit[] {
  if (Array.isArray(input)) {
    return input
      .map((change): VisualFileEdit | undefined =>
        change && typeof change === "object"
          ? fileChangeFromRecord(change as Record<string, unknown>)
          : undefined,
      )
      .filter((file): file is VisualFileEdit => !!file);
  }
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  return Object.entries(obj)
    .map(([path, change]): VisualFileEdit | undefined =>
      change && typeof change === "object"
        ? fileChangeFromRecord(change as Record<string, unknown>, path)
        : undefined,
    )
    .filter((file): file is VisualFileEdit => !!file);
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
    const rawChanges =
      Array.isArray(input) || filePathFromObject(obj)
        ? input
        : (obj.changes ?? obj.files ?? obj.edits);
    return summarizeFileEdits(fileChangesFromInput(rawChanges));
  }

  if (input && typeof input === "object") {
    return claudeEditSummary(toolName, input as Record<string, unknown>);
  }

  return undefined;
}
