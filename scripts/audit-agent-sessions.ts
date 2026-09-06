#!/usr/bin/env bun
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createStreamingSessionParser,
  type NormalizedBlock,
  type NormalizedMessage,
} from "../packages/daemon/src/sessions";
import {
  cleanVisualToolResultText,
  visualToolCommandNicifierCoverage,
} from "@treetop/nicifier";

export type AuditedAgent = "claude" | "codex";

export interface SessionCorpusRoot {
  agent: AuditedAgent;
  path: string;
}

export interface SessionCorpusAuditOptions {
  roots?: SessionCorpusRoot[];
  exampleLimit?: number;
  progress?: boolean;
}

interface CountRow {
  value: string;
  count: number;
}

interface AuditExample {
  file: string;
  line: number;
  shape: string;
}

interface CommandExample {
  file: string;
  line: number;
  head: string;
  command: string;
}

interface NicifierFamilyReport {
  commands: number;
  nicifiedCommands: number;
  fullyNicifiedCommands: number;
  partiallyNicifiedCommands: number;
  nicifierCoveragePct: number;
  fullNicifierCoveragePct: number;
  partialExamples: CommandExample[];
  unnicifiedExamples: CommandExample[];
}

interface ProviderReport {
  roots: string[];
  files: number;
  bytes: number;
  rows: number;
  validJsonRows: number;
  malformedRows: number;
  recognizedRows: number;
  unknownRows: number;
  renderedRows: number;
  semanticRows: number;
  messages: number;
  blocks: number;
  protocolCoveragePct: number;
  semanticRenderPct: number;
  sessions: {
    total: number;
    withMetadata: number;
    withUser: number;
    withAssistant: number;
    empty: number;
  };
  tools: {
    calls: number;
    results: number;
    matchedResults: number;
    sameIdAdditionalRecords: number;
    sameIdEquivalentRecords: number;
    sameIdOverlappingRecords: number;
    sameIdDifferentRecords: number;
    unmatchedResults: number;
    resultsWithoutId: number;
    matchPct: number;
  };
  tokens: {
    rows: number;
    messages: number;
    contextSnapshots: number;
    empty: number;
    invalid: number;
  };
  commands: number;
  nicifiedCommands: number;
  fullyNicifiedCommands: number;
  partiallyNicifiedCommands: number;
  nicifierCoveragePct: number;
  fullNicifierCoveragePct: number;
  nicifierFamilies: Record<string, NicifierFamilyReport>;
  topShapes: CountRow[];
  topNonRenderedShapes: CountRow[];
  topUnknownShapes: CountRow[];
  topBlockTypes: CountRow[];
  topTools: CountRow[];
  topNicifierKinds: CountRow[];
  topUnnicifiedCommandHeads: CountRow[];
  unnicifiedCommandExamples: CommandExample[];
  unknownExamples: AuditExample[];
  malformedExamples: AuditExample[];
  tokenInvalidExamples: AuditExample[];
}

export interface SessionCorpusAuditReport {
  generatedAt: string;
  boundedMemory: true;
  exampleLimit: number;
  totals: Omit<
    ProviderReport,
    | "roots"
    | "sessions"
    | "tools"
    | "tokens"
    | "topShapes"
    | "topNonRenderedShapes"
    | "topUnknownShapes"
    | "topBlockTypes"
    | "topTools"
    | "topNicifierKinds"
    | "topUnnicifiedCommandHeads"
    | "nicifierFamilies"
    | "unnicifiedCommandExamples"
    | "unknownExamples"
    | "malformedExamples"
    | "tokenInvalidExamples"
  >;
  providers: Record<AuditedAgent, ProviderReport>;
}

interface MutableProvider {
  roots: string[];
  files: number;
  bytes: number;
  rows: number;
  validJsonRows: number;
  malformedRows: number;
  recognizedRows: number;
  unknownRows: number;
  renderedRows: number;
  semanticRows: number;
  messages: number;
  blocks: number;
  sessions: ProviderReport["sessions"];
  tools: Omit<ProviderReport["tools"], "matchPct">;
  tokens: ProviderReport["tokens"];
  commands: number;
  nicifiedCommands: number;
  fullyNicifiedCommands: number;
  partiallyNicifiedCommands: number;
  nicifierFamilies: Map<
    string,
    Omit<
      NicifierFamilyReport,
      "nicifierCoveragePct" | "fullNicifierCoveragePct"
    >
  >;
  shapes: Map<string, number>;
  nonRenderedShapes: Map<string, number>;
  unknownShapes: Map<string, number>;
  blockTypes: Map<string, number>;
  toolNames: Map<string, number>;
  nicifierKinds: Map<string, number>;
  unnicifiedCommandHeads: Map<string, number>;
  unnicifiedCommandExamples: Map<string, CommandExample>;
  unknownExamples: AuditExample[];
  malformedExamples: AuditExample[];
  tokenInvalidExamples: AuditExample[];
}

interface ResultIdStats {
  count: number;
  firstText: string;
}

const CLAUDE_KNOWN_TYPES = new Set([
  "assistant",
  "agent-name",
  "ai-title",
  "atis-latch",
  "attachment",
  "bridge-session",
  "compact_boundary",
  "file-history-snapshot",
  "file-history-delta",
  "last-prompt",
  "mode",
  "permission-mode",
  "progress",
  "queue-operation",
  "summary",
  "system",
  "user",
]);

const CODEX_KNOWN_TYPES = new Set([
  "compacted",
  "event_msg",
  "inter_agent_communication_metadata",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);

const SEMANTIC_TYPES = new Set([
  "assistant",
  "compacted",
  "event_msg",
  "response_item",
  "summary",
  "user",
]);

export async function auditSessionCorpora(
  options: SessionCorpusAuditOptions = {},
): Promise<SessionCorpusAuditReport> {
  const exampleLimit = positiveInteger(options.exampleLimit, 12);
  const roots = options.roots ?? defaultRoots();
  const mutable: Record<AuditedAgent, MutableProvider> = {
    claude: emptyProvider(),
    codex: emptyProvider(),
  };

  for (const root of roots) {
    const path = resolve(expandHome(root.path));
    const rootInfo = await statOrNull(path);
    if (!rootInfo) continue;
    mutable[root.agent].roots.push(path);
    for await (const file of walkJsonl(path)) {
      await auditFile(root.agent, file, mutable[root.agent], {
        exampleLimit,
        progress: options.progress !== false,
      });
    }
  }

  const providers = {
    claude: finalizeProvider(mutable.claude),
    codex: finalizeProvider(mutable.codex),
  };
  return {
    generatedAt: new Date().toISOString(),
    boundedMemory: true,
    exampleLimit,
    totals: totalReport(providers),
    providers,
  };
}

async function auditFile(
  agent: AuditedAgent,
  file: string,
  stats: MutableProvider,
  options: { exampleLimit: number; progress: boolean },
): Promise<void> {
  const info = await statOrNull(file);
  if (!info?.isFile()) return;
  stats.files += 1;
  stats.bytes += info.size;
  stats.sessions.total += 1;
  if (options.progress && stats.files % 250 === 0) {
    console.error(
      `[session-audit] ${agent}: ${stats.files} files, ${stats.rows} rows`,
    );
  }

  const parser = createStreamingSessionParser(agent, { sourcePath: file });
  const callIds = new Set<string>();
  const resultIds = new Map<string, ResultIdStats>();
  let sessionMessages = 0;
  let hasUser = false;
  let hasAssistant = false;
  let lineNumber = 0;
  const lines = createInterface({
    input: createReadStream(file, {
      encoding: "utf8",
      start: 0,
      end: Math.max(0, info.size - 1),
    }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    stats.rows += 1;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSONL row is not an object");
      }
      row = parsed as Record<string, unknown>;
    } catch {
      stats.malformedRows += 1;
      pushExample(stats.malformedExamples, options.exampleLimit, {
        file,
        line: lineNumber,
        shape: "malformed-json",
      });
      continue;
    }

    stats.validJsonRows += 1;
    const shape = rowShape(agent, row);
    bump(stats.shapes, shape);
    const recognized = isKnownProtocolRow(agent, row);
    if (recognized) stats.recognizedRows += 1;
    else {
      stats.unknownRows += 1;
      bump(stats.unknownShapes, shape);
      pushExample(stats.unknownExamples, options.exampleLimit, {
        file,
        line: lineNumber,
        shape,
      });
    }
    if (isSemanticRow(row)) stats.semanticRows += 1;
    if (isTokenRow(agent, row)) stats.tokens.rows += 1;

    const messages = parser.ingest(line);
    if (messages.length > 0) stats.renderedRows += 1;
    else bump(stats.nonRenderedShapes, shape);
    for (const message of messages) {
      sessionMessages += 1;
      stats.messages += 1;
      if (message.role === "user") hasUser = true;
      if (message.role === "assistant") hasAssistant = true;
      inspectMessage(message, stats, callIds, resultIds, {
        file,
        line: lineNumber,
      });
    }
    if (
      isTokenRow(agent, row) &&
      !messages.some((message) => message.tokenUsage)
    ) {
      if (isContextSnapshotRow(row)) stats.tokens.contextSnapshots += 1;
      else if (isEmptyTokenRow(row)) stats.tokens.empty += 1;
      else {
        stats.tokens.invalid += 1;
        pushExample(stats.tokenInvalidExamples, options.exampleLimit, {
          file,
          line: lineNumber,
          shape: tokenRowShape(row),
        });
      }
    }
  }

  const metadata = parser.metadata();
  if (metadata.cwd || metadata.sessionId || metadata.startedAt) {
    stats.sessions.withMetadata += 1;
  }
  if (hasUser) stats.sessions.withUser += 1;
  if (hasAssistant) stats.sessions.withAssistant += 1;
  if (sessionMessages === 0) stats.sessions.empty += 1;
  for (const [id, result] of resultIds) {
    if (callIds.has(id)) stats.tools.matchedResults += result.count;
    else stats.tools.unmatchedResults += result.count;
  }
}

function inspectMessage(
  message: NormalizedMessage,
  stats: MutableProvider,
  callIds: Set<string>,
  resultIds: Map<string, ResultIdStats>,
  location: { file: string; line: number },
): void {
  if (message.tokenUsage) stats.tokens.messages += 1;
  for (const block of message.blocks) {
    stats.blocks += 1;
    bump(stats.blockTypes, block.type);
    if (block.type === "tool_use") {
      stats.tools.calls += 1;
      const toolName = block.toolName ?? "(unnamed)";
      bump(stats.toolNames, toolName);
      if (block.toolUseId) callIds.add(block.toolUseId);
      inspectCommand(block, stats, location);
    } else if (block.type === "plan" && block.toolUseId) {
      stats.tools.calls += 1;
      callIds.add(block.toolUseId);
      bump(stats.toolNames, block.toolName ?? "update_plan");
    } else if (block.type === "tool_result") {
      stats.tools.results += 1;
      if (block.toolUseId) {
        const text = block.text ?? "";
        const prior = resultIds.get(block.toolUseId);
        if (!prior) {
          resultIds.set(block.toolUseId, { count: 1, firstText: text });
        } else {
          prior.count += 1;
          stats.tools.sameIdAdditionalRecords += 1;
          const relation = resultTextRelation(prior.firstText, text);
          if (relation === "equivalent") {
            stats.tools.sameIdEquivalentRecords += 1;
          } else if (relation === "overlapping") {
            stats.tools.sameIdOverlappingRecords += 1;
          } else {
            stats.tools.sameIdDifferentRecords += 1;
          }
        }
      } else {
        stats.tools.resultsWithoutId += 1;
        stats.tools.unmatchedResults += 1;
      }
    }
  }
}

function canonicalResultText(text: string): string {
  let current = text.trim();
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const cleaned = cleanVisualToolResultText(current).body.trim();
    if (cleaned !== current) {
      current = cleaned;
      continue;
    }
    try {
      const parsed = JSON.parse(current) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).output === "string"
      ) {
        current = (parsed as { output: string }).output.trim();
        continue;
      }
    } catch {
      // The ordinary result text is not a JSON transport wrapper.
    }
    break;
  }
  return current.replace(/\r\n/g, "\n").trim();
}

function resultTextRelation(
  first: string,
  additional: string,
): "equivalent" | "overlapping" | "different" {
  if (first === additional) return "equivalent";
  const canonicalFirst = canonicalResultText(first);
  const canonicalAdditional = canonicalResultText(additional);
  if (canonicalFirst === canonicalAdditional) return "equivalent";
  if (
    canonicalFirst &&
    canonicalAdditional &&
    (canonicalFirst.includes(canonicalAdditional) ||
      canonicalAdditional.includes(canonicalFirst))
  ) {
    return "overlapping";
  }
  return "different";
}

function inspectCommand(
  block: NormalizedBlock,
  stats: MutableProvider,
  location: { file: string; line: number },
): void {
  const coverage = visualToolCommandNicifierCoverage(block);
  if (!coverage) return;
  stats.commands += 1;
  for (const family of coverage.families) {
    const familyStats = stats.nicifierFamilies.get(family) ?? {
      commands: 0,
      nicifiedCommands: 0,
      fullyNicifiedCommands: 0,
      partiallyNicifiedCommands: 0,
      partialExamples: [],
      unnicifiedExamples: [],
    };
    familyStats.commands += 1;
    if (coverage.kinds.length > 0) familyStats.nicifiedCommands += 1;
    if (coverage.fullyNicified) familyStats.fullyNicifiedCommands += 1;
    else if (coverage.kinds.length > 0) {
      familyStats.partiallyNicifiedCommands += 1;
      pushExample(familyStats.partialExamples, 12, {
        ...location,
        head: family,
        command:
          coverage.command.length > 500
            ? `${coverage.command.slice(0, 500)}…`
            : coverage.command,
      });
    } else {
      pushExample(familyStats.unnicifiedExamples, 12, {
        ...location,
        head: family,
        command:
          coverage.command.length > 500
            ? `${coverage.command.slice(0, 500)}…`
            : coverage.command,
      });
    }
    stats.nicifierFamilies.set(family, familyStats);
  }
  if (coverage.kinds.length > 0) {
    stats.nicifiedCommands += 1;
    if (coverage.fullyNicified) stats.fullyNicifiedCommands += 1;
    else stats.partiallyNicifiedCommands += 1;
    for (const kind of coverage.kinds) bump(stats.nicifierKinds, kind);
    if (coverage.fullyNicified) return;
  }
  for (const command of coverage.unnicifiedParts) {
    const head = commandHead(command);
    bump(stats.unnicifiedCommandHeads, head);
    if (
      stats.unnicifiedCommandExamples.size < 500 &&
      !stats.unnicifiedCommandExamples.has(head)
    ) {
      stats.unnicifiedCommandExamples.set(head, {
        ...location,
        head,
        command: command.length > 500 ? `${command.slice(0, 500)}…` : command,
      });
    }
  }
}

function commandHead(command: string): string {
  const normalized = command.replace(/^\s*(?:env\s+)?/, "").trim();
  const token = normalized.split(/\s+/)[0] ?? "(empty)";
  return token.replace(/\\/g, "/").split("/").pop() || token;
}

function isKnownProtocolRow(
  agent: AuditedAgent,
  row: Record<string, unknown>,
): boolean {
  if (typeof row.role === "string") return true;
  const type = typeof row.type === "string" ? row.type : "";
  return agent === "claude"
    ? CLAUDE_KNOWN_TYPES.has(type)
    : CODEX_KNOWN_TYPES.has(type);
}

function isSemanticRow(row: Record<string, unknown>): boolean {
  return (
    typeof row.role === "string" ||
    (typeof row.type === "string" && SEMANTIC_TYPES.has(row.type))
  );
}

function rowShape(agent: AuditedAgent, row: Record<string, unknown>): string {
  const type = typeof row.type === "string" ? row.type : "(no-type)";
  if (agent !== "codex") return type;
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : undefined;
  const payloadType =
    payload && typeof payload.type === "string" ? payload.type : "";
  return payloadType ? `${type}/${payloadType}` : type;
}

function isTokenRow(
  agent: AuditedAgent,
  row: Record<string, unknown>,
): boolean {
  if (agent !== "codex") return false;
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : undefined;
  return row.type === "event_msg" && payload?.type === "token_count";
}

function isContextSnapshotRow(row: Record<string, unknown>): boolean {
  const payload = objectField(row, "payload");
  const info = objectField(payload, "info");
  const last = objectField(info, "last_token_usage");
  const total = objectField(info, "total_token_usage");
  if (!last || !total) return false;
  const contextWindow = numberField(
    info ?? {},
    "model_context_window",
    "modelContextWindow",
  );
  const reportedTotal = numberField(total, "total_tokens", "totalTokens") ?? 0;
  const lastReportedTotal =
    numberField(last, "total_tokens", "totalTokens") ?? 0;
  const lastComponentsAreZero =
    (numberField(last, "input_tokens", "inputTokens") ?? 0) === 0 &&
    (numberField(last, "output_tokens", "outputTokens") ?? 0) === 0 &&
    (numberField(last, "reasoning_output_tokens", "reasoningOutputTokens") ??
      0) === 0;
  return (
    lastComponentsAreZero &&
    (lastReportedTotal > 0 ||
      (contextWindow !== undefined &&
        reportedTotal === contextWindow &&
        !hasPositiveTokenValue(last)))
  );
}

function isEmptyTokenRow(row: Record<string, unknown>): boolean {
  const payload = objectField(row, "payload");
  const info = objectField(payload, "info");
  if (!info) return true;
  const last = objectField(info, "last_token_usage");
  const total = objectField(info, "total_token_usage");
  return !hasPositiveTokenValue(last) && !hasPositiveTokenValue(total);
}

function tokenRowShape(row: Record<string, unknown>): string {
  const payload = objectField(row, "payload");
  const info = objectField(payload, "info");
  const fields = (usage: Record<string, unknown> | undefined) =>
    usage
      ? Object.keys(usage)
          .filter((key) => /tokens/i.test(key))
          .sort()
          .join(",")
      : "none";
  return `token_count last=[${fields(
    objectField(info, "last_token_usage"),
  )}] total=[${fields(objectField(info, "total_token_usage"))}]`;
}

function hasPositiveTokenValue(
  usage: Record<string, unknown> | undefined,
): boolean {
  if (!usage) return false;
  return Object.entries(usage).some(
    ([key, value]) =>
      /tokens/i.test(key) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0,
  );
}

function objectField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function emptyProvider(): MutableProvider {
  return {
    roots: [],
    files: 0,
    bytes: 0,
    rows: 0,
    validJsonRows: 0,
    malformedRows: 0,
    recognizedRows: 0,
    unknownRows: 0,
    renderedRows: 0,
    semanticRows: 0,
    messages: 0,
    blocks: 0,
    sessions: {
      total: 0,
      withMetadata: 0,
      withUser: 0,
      withAssistant: 0,
      empty: 0,
    },
    tools: {
      calls: 0,
      results: 0,
      matchedResults: 0,
      sameIdAdditionalRecords: 0,
      sameIdEquivalentRecords: 0,
      sameIdOverlappingRecords: 0,
      sameIdDifferentRecords: 0,
      unmatchedResults: 0,
      resultsWithoutId: 0,
    },
    tokens: {
      rows: 0,
      messages: 0,
      contextSnapshots: 0,
      empty: 0,
      invalid: 0,
    },
    commands: 0,
    nicifiedCommands: 0,
    fullyNicifiedCommands: 0,
    partiallyNicifiedCommands: 0,
    nicifierFamilies: new Map(),
    shapes: new Map(),
    nonRenderedShapes: new Map(),
    unknownShapes: new Map(),
    blockTypes: new Map(),
    toolNames: new Map(),
    nicifierKinds: new Map(),
    unnicifiedCommandHeads: new Map(),
    unnicifiedCommandExamples: new Map(),
    unknownExamples: [],
    malformedExamples: [],
    tokenInvalidExamples: [],
  };
}

function finalizeProvider(stats: MutableProvider): ProviderReport {
  return {
    roots: stats.roots,
    files: stats.files,
    bytes: stats.bytes,
    rows: stats.rows,
    validJsonRows: stats.validJsonRows,
    malformedRows: stats.malformedRows,
    recognizedRows: stats.recognizedRows,
    unknownRows: stats.unknownRows,
    renderedRows: stats.renderedRows,
    semanticRows: stats.semanticRows,
    messages: stats.messages,
    blocks: stats.blocks,
    protocolCoveragePct: percent(stats.recognizedRows, stats.validJsonRows),
    semanticRenderPct: percent(stats.renderedRows, stats.semanticRows),
    sessions: stats.sessions,
    tools: {
      ...stats.tools,
      matchPct: percent(stats.tools.matchedResults, stats.tools.results),
    },
    tokens: stats.tokens,
    commands: stats.commands,
    nicifiedCommands: stats.nicifiedCommands,
    fullyNicifiedCommands: stats.fullyNicifiedCommands,
    partiallyNicifiedCommands: stats.partiallyNicifiedCommands,
    nicifierCoveragePct: percent(stats.nicifiedCommands, stats.commands),
    fullNicifierCoveragePct: percent(
      stats.fullyNicifiedCommands,
      stats.commands,
    ),
    nicifierFamilies: Object.fromEntries(
      [...stats.nicifierFamilies.entries()].map(([family, data]) => [
        family,
        {
          ...data,
          nicifierCoveragePct: percent(data.nicifiedCommands, data.commands),
          fullNicifierCoveragePct: percent(
            data.fullyNicifiedCommands,
            data.commands,
          ),
        },
      ]),
    ),
    topShapes: top(stats.shapes),
    topNonRenderedShapes: top(stats.nonRenderedShapes),
    topUnknownShapes: top(stats.unknownShapes),
    topBlockTypes: top(stats.blockTypes),
    topTools: top(stats.toolNames),
    topNicifierKinds: top(stats.nicifierKinds),
    topUnnicifiedCommandHeads: top(stats.unnicifiedCommandHeads, 100),
    unnicifiedCommandExamples: top(stats.unnicifiedCommandHeads, 100)
      .map((row) => stats.unnicifiedCommandExamples.get(row.value))
      .filter((example): example is CommandExample => !!example),
    unknownExamples: stats.unknownExamples,
    malformedExamples: stats.malformedExamples,
    tokenInvalidExamples: stats.tokenInvalidExamples,
  };
}

function totalReport(
  providers: Record<AuditedAgent, ProviderReport>,
): SessionCorpusAuditReport["totals"] {
  const values = Object.values(providers);
  const sum = (key: keyof ProviderReport) =>
    values.reduce((total, provider) => {
      const value = provider[key];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
  const validJsonRows = sum("validJsonRows");
  const recognizedRows = sum("recognizedRows");
  const semanticRows = sum("semanticRows");
  const renderedRows = sum("renderedRows");
  const commands = sum("commands");
  const nicifiedCommands = sum("nicifiedCommands");
  const fullyNicifiedCommands = sum("fullyNicifiedCommands");
  return {
    files: sum("files"),
    bytes: sum("bytes"),
    rows: sum("rows"),
    validJsonRows,
    malformedRows: sum("malformedRows"),
    recognizedRows,
    unknownRows: sum("unknownRows"),
    renderedRows,
    semanticRows,
    messages: sum("messages"),
    blocks: sum("blocks"),
    protocolCoveragePct: percent(recognizedRows, validJsonRows),
    semanticRenderPct: percent(renderedRows, semanticRows),
    commands,
    nicifiedCommands,
    fullyNicifiedCommands,
    partiallyNicifiedCommands: sum("partiallyNicifiedCommands"),
    nicifierCoveragePct: percent(nicifiedCommands, commands),
    fullNicifierCoveragePct: percent(fullyNicifiedCommands, commands),
  };
}

async function* walkJsonl(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) yield* walkJsonl(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function defaultRoots(): SessionCorpusRoot[] {
  return [
    { agent: "codex", path: `${homedir()}/.codex/sessions` },
    { agent: "claude", path: `${homedir()}/.claude/projects` },
  ];
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, limit = 25): CountRow[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function pushExample<T>(target: T[], limit: number, value: T): void {
  if (target.length < limit) target.push(value);
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return Math.round((numerator / denominator) * 1_000_000) / 10_000;
}

interface CliOptions extends SessionCorpusAuditOptions {
  json: boolean;
  thresholds: SessionAuditThresholds;
}

export interface SessionAuditThresholds {
  protocol?: number;
  nicifier?: number;
  maxMalformed?: number;
  maxUnknown?: number;
}

export function sessionAuditThresholdFailures(
  report: SessionCorpusAuditReport,
  thresholds: SessionAuditThresholds,
): string[] {
  const failures: string[] = [];
  if (
    thresholds.protocol !== undefined &&
    report.totals.protocolCoveragePct < thresholds.protocol
  ) {
    failures.push(
      `protocol coverage ${report.totals.protocolCoveragePct}% is below ${thresholds.protocol}%`,
    );
  }
  if (
    thresholds.nicifier !== undefined &&
    report.totals.fullNicifierCoveragePct < thresholds.nicifier
  ) {
    failures.push(
      `complete nicifier coverage ${report.totals.fullNicifierCoveragePct}% is below ${thresholds.nicifier}%`,
    );
  }
  if (
    thresholds.maxMalformed !== undefined &&
    report.totals.malformedRows > thresholds.maxMalformed
  ) {
    failures.push(
      `malformed rows ${report.totals.malformedRows} exceed ${thresholds.maxMalformed}`,
    );
  }
  if (
    thresholds.maxUnknown !== undefined &&
    report.totals.unknownRows > thresholds.maxUnknown
  ) {
    failures.push(
      `unknown rows ${report.totals.unknownRows} exceed ${thresholds.maxUnknown}`,
    );
  }
  return failures;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, roots: [], thresholds: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.progress = false;
    else if (arg === "--examples") {
      options.exampleLimit = Number(argv[++index]);
    } else if (arg.startsWith("--examples=")) {
      options.exampleLimit = Number(arg.slice("--examples=".length));
    } else if (arg === "--root") {
      options.roots!.push(parseRoot(argv[++index] ?? ""));
    } else if (arg.startsWith("--root=")) {
      options.roots!.push(parseRoot(arg.slice("--root=".length)));
    } else if (arg === "--fail-under-protocol") {
      options.thresholds.protocol = Number(argv[++index]);
    } else if (arg === "--fail-under-nicifier") {
      options.thresholds.nicifier = Number(argv[++index]);
    } else if (arg === "--max-malformed") {
      options.thresholds.maxMalformed = Number(argv[++index]);
    } else if (arg === "--max-unknown") {
      options.thresholds.maxUnknown = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.roots?.length === 0) delete options.roots;
  return options;
}

function parseRoot(value: string): SessionCorpusRoot {
  const match = value.match(/^(claude|codex)=(.+)$/);
  if (!match) throw new Error("--root must be claude=PATH or codex=PATH");
  return { agent: match[1] as AuditedAgent, path: match[2]! };
}

function printHelp(): void {
  console.log(`audit-agent-sessions.ts

Stream all local Codex and Claude JSONL sessions through Supergit's production
parsers and command nicifiers. Memory is bounded to one line, parser context,
per-session tool ids, counters, and a small example budget.

Options:
  --root AGENT=PATH  Add/replace roots (claude=... or codex=...; repeatable)
  --examples N       Keep at most N unknown/malformed examples (default: 12)
  --json             Emit machine-readable JSON
  --quiet            Disable progress on stderr
  --fail-under-protocol P  Exit 1 below protocol coverage P
  --fail-under-nicifier P  Exit 1 below command nicifier coverage P
  --max-malformed N        Exit 1 above N malformed JSONL rows
  --max-unknown N          Exit 1 above N unknown protocol rows
`);
}

function printHuman(report: SessionCorpusAuditReport): void {
  const sizeGiB = report.totals.bytes / 1024 ** 3;
  console.log(
    `Audited ${report.totals.files.toLocaleString()} files, ${report.totals.rows.toLocaleString()} rows, ${sizeGiB.toFixed(2)} GiB`,
  );
  console.log(
    `Protocol ${report.totals.protocolCoveragePct.toFixed(2)}% · semantic render ${report.totals.semanticRenderPct.toFixed(2)}% · command nicifiers ${report.totals.nicifierCoveragePct.toFixed(2)}% any / ${report.totals.fullNicifierCoveragePct.toFixed(2)}% complete`,
  );
  for (const agent of ["codex", "claude"] as const) {
    const data = report.providers[agent];
    console.log(`\n${agent.toUpperCase()}`);
    console.log(
      `  ${data.files.toLocaleString()} files · ${data.rows.toLocaleString()} rows · ${data.protocolCoveragePct.toFixed(2)}% protocol · ${data.semanticRenderPct.toFixed(2)}% rendered`,
    );
    console.log(
      `  ${data.commands.toLocaleString()} commands · ${data.nicifierCoveragePct.toFixed(2)}% nicified · ${data.tools.matchPct.toFixed(2)}% tool results paired`,
    );
    console.log(
      `  empty sessions ${data.sessions.empty.toLocaleString()} · malformed rows ${data.malformedRows.toLocaleString()} · unknown rows ${data.unknownRows.toLocaleString()} · token anomalies ${data.tokens.invalid.toLocaleString()}`,
    );
    if (data.topUnnicifiedCommandHeads.length > 0) {
      console.log(
        `  top unsupported: ${data.topUnnicifiedCommandHeads
          .slice(0, 10)
          .map((row) => `${row.value} (${row.count})`)
          .join(", ")}`,
      );
    }
  }
}

if (import.meta.main) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await auditSessionCorpora(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    const failures = sessionAuditThresholdFailures(report, options.thresholds);
    for (const failure of failures) console.error(`[session-audit] ${failure}`);
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
