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

export interface VisualWorkSummary {
  steps: number;
  compactions: number;
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

export function visualToolPreviewText(
  block: MessageBlock | undefined,
): string {
  if (!block || block.type !== "tool_use") return "";
  const name = (block.toolName ?? "").toLowerCase();
  const input = block.toolInput;
  const structuredPreview = visualStructuredToolPreview(name, input);
  if (structuredPreview) return structuredPreview;
  const command =
    stringFromToolInputField(input, "cmd") ??
    stringFromToolInputField(input, "command");
  const commandPreview = command ? visualCommandPreview(command).text : undefined;
  if (commandPreview) return commandPreview;
  const text =
    command &&
    (name.includes("bash") || name.includes("shell") || name.includes("exec"))
      ? normalizeLaunchedCommand(command).command
      : stringifyToolPayload(input);
  return text.replace(/\s+/g, " ").trim();
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

type VisualCommandSummary =
  | { kind: "read"; target: string }
  | { kind: "search"; pattern: string; paths: string[] };

function visualStructuredToolPreview(
  toolName: string,
  input: unknown,
): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const obj = input as Record<string, unknown>;
  const path = stringField(obj, "file_path") ?? stringField(obj, "path");
  if (path && /\bread\b|read_file|view_file/.test(toolName)) {
    return `Read ${pathWithRange(path, obj)}`;
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
    return searchLabel(pattern, paths);
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

function visualCommandPreview(command: string): { text: string; launcher?: string } {
  const normalized = normalizeLaunchedCommand(command);
  const unwrapped = normalized.command;
  const pipeSummary = summarizePipeRead(unwrapped);
  if (pipeSummary) return { text: `Read ${pipeSummary.target}`, launcher: normalized.launcher };
  const parts = splitShellCommandChain(unwrapped);
  if (parts.length === 0) return { text: "", launcher: normalized.launcher };
  const summaries = parts
    .map((part) => summarizeShellCommand(part))
    .filter((summary): summary is VisualCommandSummary => !!summary);
  if (summaries.length !== parts.length)
    return { text: "", launcher: normalized.launcher };

  if (summaries.every((summary) => summary.kind === "read")) {
    return {
      text: `Read ${summaries.map((summary) => summary.target).join(", ")}`,
      launcher: normalized.launcher,
    };
  }
  if (summaries.length === 1 && summaries[0]!.kind === "search") {
    const summary = summaries[0]!;
    return {
      text: searchLabel(summary.pattern, summary.paths),
      launcher: normalized.launcher,
    };
  }
  return { text: "", launcher: normalized.launcher };
}

function normalizeLaunchedCommand(command: string): {
  command: string;
  launcher?: string;
} {
  let current = command.trim();
  let launcher: string | undefined;
  for (let i = 0; i < 3; i += 1) {
    const tokens = shellTokens(current);
    if (tokens.length < 2) return { command: current, launcher };
    const shell = shellLauncherName(tokens[0]!);
    const next = unwrappedShellPayload(tokens, shell);
    if (!next) return { command: current, launcher };
    launcher = next.launcher;
    current = next.command.trim();
  }
  return { command: current, launcher };
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
): { command: string; launcher: string } | undefined {
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
): { command: string; launcher: string } | undefined {
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

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!;
    if (escaped) {
      current += ch;
      escaped = false;
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
  const tokens = shellTokens(command);
  if (tokens.length === 0) return undefined;
  const name = tokens[0]!.split("/").pop() ?? tokens[0]!;
  if (name === "sed") return summarizeSedRead(tokens);
  if (name === "cat" || name.toLowerCase() === "type") {
    return summarizeCatRead(tokens);
  }
  if (name === "rg" || name === "ripgrep" || name === "grep") {
    return summarizeSearch(tokens);
  }
  return undefined;
}

function summarizePipeRead(command: string): VisualCommandSummary | undefined {
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
  return { kind: "read", target: `${path}${suffix}` };
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
  return { kind: "read", target: `${path}${suffix}` };
}

function summarizeCatRead(tokens: string[]): VisualCommandSummary | undefined {
  const paths = tokens
    .slice(1)
    .filter((token) => !token.startsWith("-") && !/[|<>]/.test(token));
  if (paths.length === 0) return undefined;
  return { kind: "read", target: paths.join(", ") };
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

function searchLabel(pattern: string, paths: string[]): string {
  const where = paths.length ? `${paths.join(", ")} ` : "";
  return `Search ${where}for "${readableSearchPattern(pattern)}"`;
}

function readableSearchPattern(pattern: string): string {
  return pattern.replace(/\\([(){}[\]])/g, "$1");
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
  for (const entry of entries) {
    const markerBlock = visualMarkerBlock(entry);
    if (markerBlock && visualMarkerKind(markerBlock.text) === "compacted") {
      compactions += 1;
    }
  }
  return {
    steps: entries.length - compactions,
    compactions,
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

function withUserMessageIntent<
  B extends MessageBlock,
  M extends Message<B>,
>(message: M, intent: "steer" | undefined): M {
  if (!intent || message.intent === intent) return message;
  return { ...message, intent } as M;
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
  opts: { active?: boolean } = {},
): VisualTranscriptItem<B, M>[] {
  const out: VisualTranscriptItem<B, M>[] = [];
  let messageIndex = 0;
  let pendingTurnPrefixEntries: VisualWorkEntry<B, M>[] = [];
  let previousTurnAcceptsSteering: boolean = false;

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

  function pushTurnWorkAndResponse(
    rawEntries: VisualWorkEntry<B, M>[],
    userTimestamp: string | undefined,
    active: boolean,
  ): void {
    let entries: VisualWorkEntry<B, M>[] = [];
    let segmentStartedAt = userTimestamp;
    let lastCompactionMs: number | undefined;

    for (const entry of rawEntries) {
      const markerBlock = visualMarkerBlock(entry);
      const markerKind = visualMarkerKind(markerBlock?.text);
      if (markerKind === "aborted") {
        entries.push(entry);
        pushWorkAndResponse(
          entries,
          segmentStartedAt,
          false,
          entry.message.timestamp,
        );
        entries = [];
        segmentStartedAt = entry.message.timestamp;
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

    pushWorkAndResponse(entries, segmentStartedAt, active);
  }

  function pushWorkAndResponse(
    entries: VisualWorkEntry<B, M>[],
    userTimestamp: string | undefined,
    active: boolean,
    forcedEndedAt?: string,
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
          endedAt: forcedEndedAt,
          open: forcedEndedAt ? undefined : true,
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
        endedAt: finalResponse.message.timestamp ?? forcedEndedAt,
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
      const entry = { message, blocks, messageIndex };
      const markerBlock = blocks.find((block) => block.type === "marker");
      if (
        out.length === 0 &&
        markerBlock &&
        visualMarkerKind(markerBlock.text) === "started"
      ) {
        pendingTurnPrefixEntries.push(entry);
        messageIndex += 1;
        continue;
      }
      const pushedMarker = pushMarker(entry);
      if (!pushedMarker) pushMessage({ message, blocks, messageIndex });
      messageIndex += 1;
      continue;
    }

    const turnWasAlreadyOpen: boolean = previousTurnAcceptsSteering;
    const messageForDisplay = withUserMessageIntent(
      message,
      userMessageIntent(message) ??
        (turnWasAlreadyOpen ? "steer" : undefined),
    );
    out.push({
      kind: "message",
      message: messageForDisplay,
      blocks,
      messageIndex,
    });
    previousTurnAcceptsSteering = false;
    const userTimestamp = message.timestamp;
    const turnEntries: VisualWorkEntry<B, M>[] = pendingTurnPrefixEntries;
    pendingTurnPrefixEntries = [];
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
    previousTurnAcceptsSteering =
      (turnWasAlreadyOpen || hasTurnMarker(turnEntries, "started")) &&
      !hasTurnMarker(turnEntries, "complete") &&
      !hasTurnMarker(turnEntries, "aborted");
  }

  return out;
}
