export interface MessageBlock {
  type: string;
  text?: string;
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

export interface Message<B extends MessageBlock = MessageBlock> {
  role: string;
  blocks: B[];
  timestamp?: string;
  id?: string;
  intent?: "steer";
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
  | "failed"
  | "aborted"
  | "other";

export interface VisualWorkDisplayEntry<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> {
  kind: "entry" | "marker";
  entry: VisualWorkEntry<B, M>;
  pairedResult?: VisualWorkEntry<B, M>;
  pairedToolUse?: VisualWorkEntry<B, M>;
  markerBlock?: B;
  markerKind?: VisualMarkerKind;
  markerLabel?: string;
}

export interface VisualWorkSummary {
  steps: number;
  compactions: number;
  steerings: number;
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
  processRunning?: boolean;
  processSessionId?: number;
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
  const codexRunningChunk = trimmed.match(
    /^Chunk ID:\s+\S+\s+Wall time:\s+([\d.]+)\s+seconds\s+Process running with session ID\s+(\d+)(?:\s+Original token count:\s+(\d+))?\s+Output:\s*([\s\S]*)$/i,
  );
  const plainCommandResult = trimmed.match(
    /^Exit code:\s+(-?\d+)\s+Wall time:\s+([\d.]+)\s+seconds?\s+Output:\s*([\s\S]*)$/i,
  );
  if (!codexChunk && !codexRunningChunk && !plainCommandResult) {
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
  const command =
    stringFromToolInputField(block.toolInput, "cmd") ??
    stringFromToolInputField(block.toolInput, "command");
  if (!command) return undefined;
  return inlineScriptFromCommand(normalizeLaunchedCommand(command).command);
}

export function visualToolInlineScriptLanguageLabel(
  block: MessageBlock | undefined,
): string {
  return visualToolInlineScript(block)?.title.replace(/\s+script$/i, "") ?? "";
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
): string {
  return visualToolPreviewParts(block)
    .map((part) => part.text)
    .join("");
}

export type VisualToolPreviewPart =
  | { kind: "text"; text: string }
  | { kind: "path"; text: string; path: string; range: string };

export function visualToolPreviewParts(
  block: MessageBlock | undefined,
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
  const structuredPreview = visualStructuredToolPreviewParts(name, input);
  if (structuredPreview) return structuredPreview;
  const command =
    stringFromToolInputField(input, "cmd") ??
    stringFromToolInputField(input, "command");
  const inlineScript = command
    ? inlineScriptFromCommand(normalizeLaunchedCommand(command).command)
    : undefined;
  if (inlineScript) return textPreviewParts(visualToolInlineScriptPreviewText(block));
  const commandPreview = command ? visualCommandPreview(command) : undefined;
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
  const command =
    stringFromToolInputField(block.toolInput, "cmd") ??
    stringFromToolInputField(block.toolInput, "command");
  if (!command) return undefined;
  return normalizeLaunchedCommand(command).launcher;
}

export function visualToolRemoteHostLabel(
  block: MessageBlock | undefined,
): string | undefined {
  if (!block || block.type !== "tool_use") return undefined;
  const command =
    stringFromToolInputField(block.toolInput, "cmd") ??
    stringFromToolInputField(block.toolInput, "command");
  if (!command) return undefined;
  return normalizeLaunchedCommand(command).remoteHost;
}

export interface VisualToolEnvAssignment {
  name: string;
  value: string;
}

export function visualToolEnvAssignments(
  block: MessageBlock | undefined,
): VisualToolEnvAssignment[] {
  if (!block || block.type !== "tool_use") return [];
  const command =
    stringFromToolInputField(block.toolInput, "cmd") ??
    stringFromToolInputField(block.toolInput, "command");
  if (!command) return [];
  return normalizeLaunchedCommand(command).env;
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

type VisualCommandSummary =
  | { kind: "read"; targets: string[] }
  | { kind: "search"; pattern: string; paths: string[] }
  | { kind: "find"; root: string; patterns: string[] }
  | { kind: "process-end"; pids: string[] }
  | { kind: "port-check"; ports: string[] }
  | { kind: "fetch"; url: string; output?: string }
  | {
      kind: "filesystem";
      action: "create" | "delete";
      targetKind: "file" | "folder" | "path";
      targets: string[];
    };

function textPreviewParts(text: string): VisualToolPreviewPart[] {
  return text ? [{ kind: "text", text }] : [];
}

function visualStructuredToolPreviewParts(
  toolName: string,
  input: unknown,
): VisualToolPreviewPart[] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const obj = input as Record<string, unknown>;
  if (toolName.includes("evaluate_script")) {
    const fn = stringField(obj, "function");
    if (fn) return textPreviewParts("Run browser script");
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
    if (type) return textPreviewParts(`Navigate ${type}`);
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

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function shortestUniquePathSuffix(path: string, peers: readonly string[]): string {
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
    if (!distinctPathsByBase.has(base)) distinctPathsByBase.set(base, new Set());
    distinctPathsByBase.get(base)!.add(item.path);
  }
  return parsed.map((item) => {
    const base = pathBasename(item.path);
    const ambiguousPaths = [...(distinctPathsByBase.get(base) ?? [])];
    const label =
      ambiguousPaths.length > 1
        ? shortestUniquePathSuffix(item.path, ambiguousPaths)
        : basenameNeedsParentContext(base)
          ? parentContextPathSuffix(item.path)
          : base;
    return { label: `${label}${item.range}`, path: item.path, range: item.range };
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
): VisualToolPreviewPart[] {
  const formatted = visualPathPreviewTargets(targets);
  return formatted.flatMap((target, index): VisualToolPreviewPart[] => {
    const prefix: VisualToolPreviewPart[] =
      index === 0 ? [] : [{ kind: "text", text: ", " }];
    return [...prefix, target];
  });
}

function readPreviewParts(targets: readonly string[]): VisualToolPreviewPart[] {
  return [{ kind: "text", text: "Read " }, ...interspersePathParts(targets)];
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

function visualCommandPreview(command: string): {
  text: string;
  parts: VisualToolPreviewPart[];
  launcher?: string;
  remoteHost?: string;
  env: VisualToolEnvAssignment[];
} {
  const normalized = normalizeLaunchedCommand(command);
  const unwrapped = normalized.command;
  const pipeSummary = summarizePipeRead(unwrapped);
  if (pipeSummary) {
    const parts = readPreviewParts(pipeSummary.targets);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  const parts = splitShellCommandChain(unwrapped);
  if (parts.length === 0) {
    return {
      text: "",
      parts: [],
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  const meaningfulParts = parts.filter((part) => !isShellContextCommand(part));
  if (meaningfulParts.length === 0) {
    return {
      text: "",
      parts: [],
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  const summaryPairs = meaningfulParts.map((part) => ({
    part,
    summary: summarizeShellCommand(part),
  }));
  const summaries = summaryPairs
    .map((pair) => pair.summary)
    .filter((summary): summary is VisualCommandSummary => !!summary);
  if (summaries.length > 0 && summaries.length !== meaningfulParts.length) {
    const parts = summaryPairs.flatMap((pair, index): VisualToolPreviewPart[] => [
      ...(index === 0 ? [] : [{ kind: "text" as const, text: " · " }]),
      ...(pair.summary
        ? commandSummaryParts(pair.summary)
        : textPreviewParts(pair.part.replace(/\s+/g, " ").trim())),
    ]);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  if (summaries.length !== meaningfulParts.length) {
    return {
      text: "",
      parts: [],
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
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
      env: normalized.env,
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
      env: normalized.env,
    };
  }
  if (summaries.length === 1 && summaries[0]!.kind === "find") {
    const parts = findPreviewParts(summaries[0]!);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  if (summaries.length === 1) {
    const parts = commandSummaryParts(summaries[0]!);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  if (summaries.length > 1) {
    const parts = summaries.flatMap((summary, index): VisualToolPreviewPart[] => [
      ...(index === 0 ? [] : [{ kind: "text" as const, text: " · " }]),
      ...commandSummaryParts(summary),
    ]);
    return {
      text: parts.map((part) => part.text).join(""),
      parts,
      launcher: normalized.launcher,
      remoteHost: normalized.remoteHost,
      env: normalized.env,
    };
  }
  return {
    text: "",
    parts: [],
    launcher: normalized.launcher,
    remoteHost: normalized.remoteHost,
    env: normalized.env,
  };
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
    if (tokens.length < 2) return { command: current, launcher, remoteHost, env };
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
  let commandStart = startsWithExport ? 1 : 0;
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
        index > 0 &&
        /^-(?:command|c|encodedcommand|ec)$/i.test(token),
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
  const optionsWithValue = new Set([
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
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") continue;
    if (!host && token.startsWith("-")) {
      const option = token.slice(0, 2);
      if (optionsWithValue.has(token) || optionsWithValue.has(option)) {
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
    if (ch === ";" || (ch === "&" && command[i + 1] === "&")) {
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
  return name === "cd" || name === "pwd" || name === "true" || name === "ls";
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

function summarizeShellCommand(command: string): VisualCommandSummary | undefined {
  const portCheck = summarizePortCheck(command);
  if (portCheck) return portCheck;
  const pipeRead = summarizePipeRead(command);
  if (pipeRead) return pipeRead;
  const tokens = shellTokens(command);
  if (tokens.length === 0) return undefined;
  const name = tokens[0]!.split("/").pop() ?? tokens[0]!;
  const lowerName = name.toLowerCase();
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
  if (lowerName === "curl" || lowerName === "wget")
    return summarizeFetch(tokens);
  if (name === "sed") return summarizeSedRead(tokens);
  if (name === "cat" || name.toLowerCase() === "type") {
    return summarizeCatRead(tokens);
  }
  if (name === "rg" || name === "ripgrep" || name === "grep") {
    return summarizeSearch(tokens);
  }
  if (name === "find") return summarizeFind(tokens);
  return undefined;
}

function summarizeKill(tokens: string[]): VisualCommandSummary | undefined {
  const pids = tokens
    .slice(1)
    .filter((token) => /^\d+$/.test(token));
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
    if ((token === "-i" || token.toLowerCase() === "-itcp") && tokens[index + 1]) {
      const next = tokens[index + 1]!;
      addPort(next.match(/^(?:tcp:)?(\d+)$/i)?.[1]);
      addPort(next.match(/^:(\d+)$/)?.[1]);
      index += 1;
    }
  }
  for (const match of command.matchAll(/(?:^|[^\w/])(?:tcp:|TCP:|:)(\d{2,5})/g)) {
    addPort(match[1]);
  }
  if (ports.length === 0) return undefined;
  return { kind: "port-check", ports };
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

function summarizeRemove(tokens: string[]): VisualCommandSummary | undefined {
  const command = tokens[0]?.split("/").pop()?.toLowerCase();
  const targets = positionalPathTokens(tokens.slice(1), powershellOptionsWithValue());
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
  const targets = positionalPathTokens(tokens.slice(1), powershellOptionsWithValue());
  if (targets.length === 0) return undefined;
  return {
    kind: "filesystem",
    action: "create",
    targetKind,
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
  const sed = summarizeSedRange(right);
  if (!sed) return undefined;
  const suffix = sed.end ? `:${sed.start}-${sed.end}` : `:${sed.start}`;
  return { kind: "read", targets: [`${path}${suffix}`] };
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

function summarizeSedRange(
  tokens: string[],
): { start: string; end?: string } | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const match = tokens[i]!.match(/^(\d+)(?:,(\d+))?p$/);
    if (match) return { start: match[1]!, end: match[2] };
  }
  return undefined;
}

function summarizeSedRead(tokens: string[]): VisualCommandSummary | undefined {
  const range = summarizeSedRange(tokens);
  const rangeIndex = range
    ? tokens.findIndex((token) =>
        token === `${range.start}${range.end ? `,${range.end}` : ""}p`
      )
    : -1;
  const path =
    rangeIndex >= 0
      ? tokens.slice(rangeIndex + 1).find((candidate) => !candidate.startsWith("-"))
      : undefined;
  if (!range || !path) return undefined;
  const suffix = range.end ? `:${range.start}-${range.end}` : `:${range.start}`;
  return { kind: "read", targets: [`${path}${suffix}`] };
}

function summarizeCatRead(tokens: string[]): VisualCommandSummary | undefined {
  const paths = tokens
    .slice(1)
    .filter((token) => !token.startsWith("-") && !/[|<>]/.test(token));
  if (paths.length === 0) return undefined;
  return { kind: "read", targets: paths };
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

function commandSummaryParts(
  summary: VisualCommandSummary,
): VisualToolPreviewPart[] {
  if (summary.kind === "read")
    return readPreviewParts(summary.targets);
  if (summary.kind === "search") {
    return searchPreviewParts(summary.pattern, summary.paths);
  }
  if (summary.kind === "process-end") {
    const label = summary.pids.length === 1 ? "Stop process" : "Stop processes";
    return [{ kind: "text", text: `${label} ${summary.pids.join(", ")}` }];
  }
  if (summary.kind === "port-check") {
    const label = summary.ports.length === 1 ? "Check port" : "Check ports";
    return [{ kind: "text", text: `${label} ${summary.ports.join(", ")}` }];
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
  if (summary.kind === "filesystem") {
    const action = summary.action === "create" ? "Create" : "Delete";
    return [
      { kind: "text", text: `${action} ${summary.targetKind} ` },
      ...interspersePathParts(summary.targets),
    ];
  }
  return findPreviewParts(summary);
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

function inlineScriptFromCommand(
  command: string,
): VisualToolInlineScript | undefined {
  const heredoc = command.match(
    /(?:^|\s)(python3?|node|bun|deno|swift|ruby|perl)\b[\s\S]*?<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*?)\n\2\b/,
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
  const runtime = tokens[runtimeIndex]!.split("/").pop() ?? tokens[runtimeIndex]!;
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
  if (language === "js") return "JavaScript script";
  return `${language[0]!.toUpperCase()}${language.slice(1)} script`;
}

function formatInlineScript(code: string): string {
  const trimmed = code.trim();
  if (trimmed.includes("\n")) return trimmed;
  return trimmed.replace(/;\s+/g, ";\n");
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

function isObservedProcessOutputPair(
  toolUseEntry: VisualWorkEntry | undefined,
  resultEntry: VisualWorkEntry | undefined,
): boolean {
  return !!visualObservedProcessOutput(
    firstToolUseBlock(toolUseEntry),
    firstToolResultBlock(resultEntry),
  );
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
  if (/context window exceeded|context window full/i.test(cleaned)) {
    return "Context window full";
  }
  if (/(?:codex\s+)?turn failed/i.test(cleaned)) return "Turn failed";
  if (/(?:codex\s+)?task complete/i.test(cleaned)) return "Task complete";
  if (/(?:codex\s+)?task started/i.test(cleaned)) return "Task started";
  if (/(?:codex\s+)?context compacted/i.test(cleaned)) return "Context compacted";
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
  if (/(?:codex\s+)?turn aborted/i.test(cleaned)) return "aborted";
  return "other";
}

function isTerminalVisualMarkerKind(
  kind: VisualMarkerKind | undefined,
): boolean {
  return kind === "complete" || kind === "aborted" || kind === "failed";
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

function countUnifiedDiffLines(diff: unknown):
  | { additions: number; deletions: number }
  | undefined {
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

export function buildVisualWorkDisplayEntries<
  B extends MessageBlock,
  M extends Message<B>,
>(
  entries: readonly VisualWorkEntry<B, M>[],
): VisualWorkDisplayEntry<B, M>[] {
  const toolUseByResult = new Map<number, VisualWorkEntry<B, M>>();
  const resultByToolUse = new Map<number, VisualWorkEntry<B, M>>();
  const toolUseById = new Map<string, number>();
  const toolUseIndexes: number[] = [];
  const pairedToolUses = new Set<number>();
  const collapsedResultIndexes = new Set<number>();

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
      if (candidate !== undefined && !pairedToolUses.has(candidate)) {
        pairedToolUseIndex = candidate;
        break;
      }
    }
    pairedToolUseIndex ??= toolUseIndexes.find(
      (candidate) => !pairedToolUses.has(candidate),
    );
    if (pairedToolUseIndex === undefined) continue;

    toolUseByResult.set(
      index,
      entries[pairedToolUseIndex]!,
    );
    resultByToolUse.set(
      pairedToolUseIndex,
      withToolResultName(entry, firstToolUseName(entries[pairedToolUseIndex])),
    );
    pairedToolUses.add(pairedToolUseIndex);
    if (
      pairedToolUseIndex === index - 1 &&
      !isObservedProcessOutputPair(entries[pairedToolUseIndex], entry)
    ) {
      collapsedResultIndexes.add(index);
    }
  }

  const out: VisualWorkDisplayEntry<B, M>[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
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
      isObservedProcessOutputPair(entry, resultByToolUse.get(index))
    ) {
      continue;
    }
    if (collapsedResultIndexes.has(index)) {
      continue;
    }
    const pairedToolUse = toolUseByResult.get(index);
    out.push({
      kind: "entry",
      entry: pairedToolUse
        ? withToolResultName(entry, firstToolUseName(pairedToolUse))
        : entry,
      pairedResult: resultByToolUse.get(index),
      pairedToolUse,
    });
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
  if (!item.terminalMarkerKind || !item.terminalMarkerLabel) return entries;

  return entries.filter((entry) => {
    if (entry.kind !== "marker") return true;
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

export function visualWorkSummary<
  B extends MessageBlock,
  M extends Message<B>,
>(entries: readonly VisualWorkEntry<B, M>[]): VisualWorkSummary {
  let compactions = 0;
  let steerings = 0;
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
  }
  return {
    steps: entries.length - compactions - steerings - boundaryMarkers,
    compactions,
    steerings,
  };
}

function compactionMarkerEntry<
  B extends MessageBlock,
  M extends Message<B>,
>(entry: VisualWorkEntry<B, M>): VisualTranscriptItem<B, M> | undefined {
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

function terminalWorkMarker<
  B extends MessageBlock,
  M extends Message<B>,
>(
  entries: readonly VisualWorkEntry<B, M>[],
): Pick<
  Extract<VisualTranscriptItem<B, M>, { kind: "work" }>,
  "terminalMarkerKind" | "terminalMarkerLabel"
> {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const markerBlock = visualMarkerBlock(entries[index]);
    const kind = visualMarkerKind(markerBlock?.text);
    if (kind === "aborted" || kind === "failed") {
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

function hasSteeringEligibleWork<
  B extends MessageBlock,
  M extends Message<B>,
>(entries: readonly VisualWorkEntry<B, M>[]): boolean {
  return entries.some(
    (entry) =>
      entry.message.role !== "user" &&
      entry.blocks.some((block) => block.type !== "marker"),
  );
}

function isBoundaryMarkerOnlyWork<
  B extends MessageBlock,
  M extends Message<B>,
>(entries: readonly VisualWorkEntry<B, M>[]): boolean {
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

function withUserMessageIntent<
  B extends MessageBlock,
  M extends Message<B>,
>(message: M, intent: "steer" | undefined): M {
  if (!intent || message.intent === intent) return message;
  return { ...message, intent } as M;
}

function coalesceAdjacentVisualWorkItems<
  B extends MessageBlock,
  M extends Message<B>,
>(
  items: VisualTranscriptItem<B, M>[],
): VisualTranscriptItem<B, M>[] {
  const out: VisualTranscriptItem<B, M>[] = [];
  for (const item of items) {
    const previous = out[out.length - 1];
    if (item.kind === "work" && previous?.kind === "work") {
      out[out.length - 1] = {
        kind: "work",
        entries: [...previous.entries, ...item.entries],
        startedAt: previous.startedAt ?? item.startedAt,
        endedAt: item.endedAt ?? previous.endedAt,
        open: item.open,
        terminalMarkerKind:
          item.terminalMarkerKind ?? previous.terminalMarkerKind,
        terminalMarkerLabel:
          item.terminalMarkerLabel ?? previous.terminalMarkerLabel,
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
  const messagesWithIntent = withOptimisticUserMessageIntent(messages, overlays);
  if (overlays.length === 0)
    return withoutDuplicateOptimisticUserMessages(messagesWithIntent);
  return withoutDuplicateOptimisticUserMessages(
    [...messagesWithIntent, ...overlays].sort((a, b) => {
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
  const toolUseKey = displayEntry.pairedToolUse
    ? getVisualWorkEntryKey(displayEntry.pairedToolUse)
    : "";
  return [
    displayEntry.kind,
    getVisualWorkEntryKey(displayEntry.entry),
    resultKey,
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
      const previousEntry = previousEntriesByKey.get(getVisualWorkEntryKey(entry));
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
    return ((message?.blocks ?? []) as B[]).filter(
      (block) => block.type !== "goal",
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

  function nextDisplayUserIntent(startIndex: number): "steer" | undefined {
    for (let i = startIndex; i < messages.length; i += 1) {
      const next = messages[i];
      if (!next || displayBlocks(next).length === 0) continue;
      if (next.role !== "user") continue;
      return userMessageIntent(next);
    }
    return undefined;
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
        out.push({
          kind: "work",
          entries,
          startedAt: userTimestamp ?? firstWorkTs,
          endedAt: forcedEndedAt,
          open: forcedEndedAt ? undefined : true,
          ...terminalMarker,
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
      const pushedMarker = pushMarker(entry);
      if (!pushedMarker)
        pushMessage({ message, blocks, messageIndex: absoluteMessageIndex });
      messageIndex += 1;
      continue;
    }

    const explicitSteer = userMessageIntent(message) === "steer";
    const turnWasAlreadyOpen: boolean =
      previousTurnAcceptsSteering || explicitSteer;
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
      (turnWasAlreadyOpen || hasTurnMarker(turnEntries, "started")) &&
      !hasTurnMarker(turnEntries, "complete") &&
      !hasTurnMarker(turnEntries, "aborted");
    const acceptsSteering =
      turnStillOpen &&
      (turnWasAlreadyOpen || hasSteeringEligibleWork(turnEntries));
    if (acceptsSteering && messages[messageIndex]?.role === "user") {
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
    previousTurnAcceptsSteering = acceptsSteering;
  }

  return coalesceAdjacentVisualWorkItems(out);
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

function lastUserMessageIndexAtOrBefore<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[], index: number): number {
  for (let i = Math.min(index, messages.length - 1); i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return 0;
}

function itemIsBeforeMessageIndex<
  B extends MessageBlock,
  M extends Message<B>,
>(item: VisualTranscriptItem<B, M>, messageIndex: number): boolean {
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
}): VisualTranscriptItem<B, M>[] {
  if (opts.previousItems.length === 0) {
    return buildVisualTranscriptItems(opts.messages, {
      active: opts.active,
    });
  }
  if (opts.previousActive !== opts.active) {
    return reuseStableVisualTranscriptItems(
      opts.previousItems,
      buildVisualTranscriptItems(opts.messages, { active: opts.active }),
    );
  }

  const commonPrefix = commonMessagePrefixLength(
    opts.previousMessages,
    opts.messages,
  );
  const appendOrTailUpdate =
    commonPrefix > 0 &&
    commonPrefix <= opts.messages.length &&
    commonPrefix >= opts.previousMessages.length - 1;
  if (!appendOrTailUpdate) {
    return reuseStableVisualTranscriptItems(
      opts.previousItems,
      buildVisualTranscriptItems(opts.messages, { active: opts.active }),
    );
  }

  const appendedUser =
    commonPrefix === opts.previousMessages.length &&
    opts.messages[commonPrefix]?.role === "user";
  const previousTail = opts.previousItems[opts.previousItems.length - 1];
  const previousTailIsOpenWork =
    previousTail?.kind === "work" && previousTail.open === true;
  const rebuildStart =
    appendedUser && !previousTailIsOpenWork
      ? commonPrefix
      : lastUserMessageIndexAtOrBefore(
          opts.messages,
          Math.max(0, commonPrefix - 1),
        );
  const prefixItems = opts.previousItems.filter((item) =>
    itemIsBeforeMessageIndex(item, rebuildStart),
  );
  const tailItems = buildVisualTranscriptItems<B, M>(
    opts.messages.slice(rebuildStart),
    {
      active: opts.active,
      messageIndexOffset: rebuildStart,
    },
  );

  return reuseStableVisualTranscriptItems(opts.previousItems, [
    ...prefixItems,
    ...tailItems,
  ]);
}
