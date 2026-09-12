export type SessionContextAgent = "codex" | "claude" | "unknown";

export interface SessionContextItem {
  id: string;
  sourceLine: number;
  value: unknown;
}

export type SessionContextEvent =
  | { sourceLine: number; kind: "base"; value: unknown }
  | { sourceLine: number; kind: "turn"; value: unknown }
  | { sourceLine: number; kind: "append"; item: SessionContextItem }
  | { sourceLine: number; kind: "replace"; items: SessionContextItem[] }
  | { sourceLine: number; kind: "claude"; item: SessionContextItem; parentId?: string; include: boolean };

export interface SessionContextTimeline {
  agent: SessionContextAgent;
  events: SessionContextEvent[];
}

export function mergeSessionContextTimelines(
  previous: SessionContextTimeline | undefined,
  next: SessionContextTimeline,
): SessionContextTimeline {
  if (!previous) return next;
  return {
    agent: next.agent === "unknown" ? previous.agent : next.agent,
    events: [...previous.events, ...next.events],
  };
}

interface SessionContextTimelineMutable {
  agent: SessionContextAgent;
  events: SessionContextEvent[];
}

export interface SessionContextState {
  agent: SessionContextAgent;
  completeness: "recorded" | "partial";
  baseInstructions?: unknown;
  turnContext?: unknown;
  items: SessionContextItem[];
  compactionCount: number;
  opaqueItemCount: number;
  limitations: string[];
}

export type CodexContextRole = "developer" | "system";
export type CodexContextUpdatePhase = "set" | "changed" | "reapplied";

export interface CodexContextUpdateBlock {
  type: "context_update";
  text: string;
  contextRole: CodexContextRole;
  contextPhase: CodexContextUpdatePhase;
  contextCategory: string;
  contextCharacters: number;
  contextPreviousCharacters?: number;
  contextDeltaCharacters?: number;
  contextDiff?: string;
}

/** Canonical transcript message produced for recorded model-context changes.
 * Consumers add only source-specific identity/timestamps; they must not
 * reinterpret the block. */
export interface CodexContextUpdateMessage {
  role: "system";
  title: string;
  blocks: [CodexContextUpdateBlock];
}

export interface CodexContextUpdateNormalizer {
  (value: unknown): CodexContextUpdateMessage | undefined;
  primeBaseInstructions(value: unknown): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function codexContextCategory(value: string, role: CodexContextRole): string {
  const outerTag = value.match(/^\s*<([a-z_][\w-]*)\b/i)?.[1]?.toLowerCase();
  if (outerTag === "skills_instructions") return "Skills instructions";
  if (outerTag === "permissions") return "Permissions instructions";
  if (outerTag === "multi_agent_role" || outerTag === "multi_agent_mode") {
    return "Multi-agent instructions";
  }
  if (outerTag === "collaboration_mode") return "Collaboration instructions";
  if (outerTag === "model_switch") return "Model instructions";
  return role === "developer" ? "Developer instructions" : "System instructions";
}

type ContextDiffOperation = { kind: "same" | "add" | "remove"; line: string };

function contextLineOperations(previous: string, current: string): ContextDiffOperation[] {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;

  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  const operations: ContextDiffOperation[] = before
    .slice(0, prefix)
    .map((line) => ({ kind: "same", line }));

  if (beforeMiddle.length * afterMiddle.length <= 1_000_000) {
    const width = afterMiddle.length + 1;
    const lengths = new Uint32Array((beforeMiddle.length + 1) * width);
    for (let beforeIndex = beforeMiddle.length - 1; beforeIndex >= 0; beforeIndex--) {
      for (let afterIndex = afterMiddle.length - 1; afterIndex >= 0; afterIndex--) {
        const index = beforeIndex * width + afterIndex;
        lengths[index] = beforeMiddle[beforeIndex] === afterMiddle[afterIndex]
          ? lengths[(beforeIndex + 1) * width + afterIndex + 1]! + 1
          : Math.max(
              lengths[(beforeIndex + 1) * width + afterIndex]!,
              lengths[beforeIndex * width + afterIndex + 1]!,
            );
      }
    }
    let beforeIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < beforeMiddle.length && afterIndex < afterMiddle.length) {
      if (beforeMiddle[beforeIndex] === afterMiddle[afterIndex]) {
        operations.push({ kind: "same", line: beforeMiddle[beforeIndex]! });
        beforeIndex++;
        afterIndex++;
      } else if (
        lengths[(beforeIndex + 1) * width + afterIndex]! >=
        lengths[beforeIndex * width + afterIndex + 1]!
      ) {
        operations.push({ kind: "remove", line: beforeMiddle[beforeIndex++]! });
      } else {
        operations.push({ kind: "add", line: afterMiddle[afterIndex++]! });
      }
    }
    while (beforeIndex < beforeMiddle.length) {
      operations.push({ kind: "remove", line: beforeMiddle[beforeIndex++]! });
    }
    while (afterIndex < afterMiddle.length) {
      operations.push({ kind: "add", line: afterMiddle[afterIndex++]! });
    }
  } else {
    operations.push(...beforeMiddle.map((line) => ({ kind: "remove" as const, line })));
    operations.push(...afterMiddle.map((line) => ({ kind: "add" as const, line })));
  }

  operations.push(...before.slice(before.length - suffix).map((line) => ({ kind: "same" as const, line })));
  return operations;
}

function compactContextDiffOperations(operations: ContextDiffOperation[]): string[] {
  const rendered: string[] = [];
  for (let index = 0; index < operations.length;) {
    const kind = operations[index]!.kind;
    let end = index + 1;
    while (end < operations.length && operations[end]!.kind === kind) end++;
    const run = operations.slice(index, end);
    const keep = kind === "same" ? 3 : 80;
    if (run.length > keep * 2) {
      rendered.push(...run.slice(0, keep).map((operation) => `${kind === "same" ? " " : kind === "add" ? "+" : "-"}${operation.line}`));
      rendered.push(`@@ ${run.length - keep * 2} ${kind === "same" ? "unchanged" : kind === "add" ? "added" : "removed"} lines omitted @@`);
      rendered.push(...run.slice(-keep).map((operation) => `${kind === "same" ? " " : kind === "add" ? "+" : "-"}${operation.line}`));
    } else {
      rendered.push(...run.map((operation) => `${kind === "same" ? " " : kind === "add" ? "+" : "-"}${operation.line}`));
    }
    index = end;
  }
  if (rendered.length <= 400) return rendered;
  return [
    ...rendered.slice(0, 200),
    `@@ ${rendered.length - 400} diff lines omitted @@`,
    ...rendered.slice(-200),
  ];
}

function codexContextDiff(previous: string, current: string, category: string): string {
  return [
    `@@ ${category} changed @@`,
    ...compactContextDiffOperations(contextLineOperations(previous, current)),
  ].join("\n");
}

function codexContextUpdateParts(value: unknown): {
  role: CodexContextRole;
  category: string;
  text: string;
} | undefined {
  const item = record(value);
  if (text(item?.type) !== "message") return undefined;
  const role = text(item?.role);
  if (role !== "developer" && role !== "system") return undefined;
  const content = Array.isArray(item?.content) ? item.content : [];
  const body = content
    .map((part) => text(record(part)?.text))
    .filter((part): part is string => !!part)
    .join("\n\n")
    .trim();
  if (!body) return undefined;
  return { role, category: codexContextCategory(body, role), text: body };
}

function contextComparisonText(value: string, category: string): string {
  if (category !== "Model instructions") return value;
  const inner = value
    .replace(/^\s*<model_switch\b[^>]*>\s*/i, "")
    .replace(/\s*<\/model_switch>\s*$/i, "");
  const instructionsStart = inner.indexOf("\n\n");
  return (instructionsStart >= 0 ? inner.slice(instructionsStart + 2) : inner).trim();
}

/** Stateful canonical conversion for model-visible Codex context messages. */
export function createCodexContextUpdateNormalizer(): CodexContextUpdateNormalizer {
  const previousByCategory = new Map<string, { text: string; characters: number }>();
  const normalize = ((value: unknown) => {
    const update = codexContextUpdateParts(value);
    if (!update) return undefined;
    const contextKey = `${update.role}:${update.category}`;
    const previous = previousByCategory.get(contextKey);
    const comparisonText = contextComparisonText(update.text, update.category);
    const phase: CodexContextUpdatePhase = previous === undefined
      ? "set"
      : previous.text === comparisonText
        ? "reapplied"
        : "changed";
    previousByCategory.set(contextKey, {
      text: comparisonText,
      characters: update.text.length,
    });
    const roleLabel = update.role === "developer" ? "Developer" : "System";
    const block: CodexContextUpdateBlock = {
      type: "context_update",
      text: update.text,
      contextRole: update.role,
      contextPhase: phase,
      contextCategory: update.category,
      contextCharacters: update.text.length,
      ...(previous !== undefined
        ? {
            contextPreviousCharacters: previous.characters,
            contextDeltaCharacters: update.text.length - previous.characters,
            ...(phase === "changed"
              ? { contextDiff: codexContextDiff(previous.text, comparisonText, update.category) }
              : {}),
          }
        : {}),
    };
    return {
      role: "system",
      title: `${roleLabel} context ${phase}`,
      blocks: [block],
    };
  }) as CodexContextUpdateNormalizer;
  normalize.primeBaseInstructions = (value: unknown) => {
    const base = typeof value === "string" ? value : text(record(value)?.text);
    if (!base) return;
    previousByCategory.set("developer:Model instructions", {
      text: base,
      characters: base.length,
    });
  };
  return normalize;
}

function codexItem(value: unknown, sourceLine: number, suffix = ""): SessionContextItem {
  const item = record(value);
  const id = text(item?.id) ?? text(item?.call_id) ?? `codex-${sourceLine}${suffix}`;
  return { id, sourceLine, value };
}

function ingestSessionContextRow(
  timeline: SessionContextTimelineMutable,
  value: unknown,
  sourceLine: number,
): void {
    const row = record(value);
    if (!row) return;
    const type = text(row.type);
    const payload = record(row.payload);

    if (type === "session_meta" || type === "turn_context" || type === "response_item" || type === "compacted") {
      timeline.agent = "codex";
      if (type === "session_meta" && payload && "base_instructions" in payload) {
        timeline.events.push({ sourceLine, kind: "base", value: payload.base_instructions });
      } else if (type === "turn_context" && payload) {
        timeline.events.push({ sourceLine, kind: "turn", value: payload });
      } else if (type === "response_item" && payload) {
        timeline.events.push({ sourceLine, kind: "append", item: codexItem(payload, sourceLine) });
      } else if (type === "compacted" && payload) {
        const history = Array.isArray(payload.replacement_history)
          ? payload.replacement_history
          : [];
        timeline.events.push({
          sourceLine,
          kind: "replace",
          items: history.map((item, itemIndex) => codexItem(item, sourceLine, `-${itemIndex + 1}`)),
        });
      }
      return;
    }

    if (
      type === "user" ||
      type === "assistant" ||
      (typeof row.uuid === "string" && "parentUuid" in row)
    ) {
      timeline.agent = timeline.agent === "unknown" ? "claude" : timeline.agent;
      if (row.isSidechain === true || row.isMeta === true) return;
      const id = text(row.uuid) ?? `claude-${sourceLine}`;
      const parentId = text(row.parentUuid);
      const include = type === "user" || type === "assistant" || type === "attachment";
      const itemValue = row.message ?? row.attachment ?? {
        type,
        subtype: row.subtype,
        content: row.content,
      };
      timeline.events.push({
        sourceLine,
        kind: "claude",
        item: { id, sourceLine, value: itemValue },
        include,
        ...(parentId ? { parentId } : {}),
      });
    }
}

export function createSessionContextTimeline(
  rows: readonly unknown[],
): SessionContextTimeline {
  const timeline: SessionContextTimelineMutable = { agent: "unknown", events: [] };
  rows.forEach((value, index) => ingestSessionContextRow(timeline, value, index + 1));

  return timeline;
}

export function createSessionContextTimelineBuilder(): {
  ingest(value: unknown, sourceLine: number): void;
  finish(): SessionContextTimeline;
} {
  const timeline: SessionContextTimelineMutable = { agent: "unknown", events: [] };
  return {
    ingest(value, sourceLine) {
      ingestSessionContextRow(timeline, value, sourceLine);
    },
    finish() {
      return timeline;
    },
  };
}

function isOpaqueCodexItem(value: unknown): boolean {
  const item = record(value);
  return !!item && (
    typeof item.encrypted_content === "string" ||
    typeof item.encryptedContent === "string"
  );
}

export function sessionContextStateAtLine(
  timeline: SessionContextTimeline,
  sourceLine = Number.POSITIVE_INFINITY,
): SessionContextState {
  let baseInstructions: unknown;
  let turnContext: unknown;
  let items: SessionContextItem[] = [];
  let compactionCount = 0;
  const claudeItems = new Map<string, { item: SessionContextItem; parentId?: string; include: boolean }>();
  let claudeLeaf: string | undefined;

  for (const event of timeline.events) {
    if (event.sourceLine > sourceLine) break;
    if (event.kind === "base") baseInstructions = event.value;
    else if (event.kind === "turn") turnContext = event.value;
    else if (event.kind === "append") items.push(event.item);
    else if (event.kind === "replace") {
      items = [...event.items];
      compactionCount += 1;
    } else {
      claudeItems.set(event.item.id, { item: event.item, parentId: event.parentId, include: event.include });
      claudeLeaf = event.item.id;
    }
  }

  if (timeline.agent === "claude" && claudeLeaf) {
    const chain: SessionContextItem[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = claudeLeaf;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = claudeItems.get(cursor);
      if (!node) break;
      if (node.include) chain.push(node.item);
      cursor = node.parentId;
    }
    items = chain.reverse();
  }

  const opaqueItemCount = items.filter((item) => isOpaqueCodexItem(item.value)).length;
  const limitations = [
    "Provider tool schemas and other runtime-managed prompt state are not present in the session log.",
    ...(opaqueItemCount > 0
      ? ["Opaque provider-managed items are shown as recorded but cannot be decrypted."]
      : []),
  ];
  return {
    agent: timeline.agent,
    completeness: timeline.agent === "codex" ? "recorded" : "partial",
    ...(baseInstructions !== undefined ? { baseInstructions } : {}),
    ...(turnContext !== undefined ? { turnContext } : {}),
    items,
    compactionCount,
    opaqueItemCount,
    limitations,
  };
}

export function sessionContextItemLabel(item: SessionContextItem): string {
  const value = record(item.value);
  const role = text(value?.role);
  const type = text(value?.type);
  const name = text(value?.name) ?? text(value?.tool_name);
  return [role, type, name].filter(Boolean).join(" · ") || "Context item";
}

export function estimateSessionContextTokens(state: SessionContextState): number {
  let chars = 0;
  for (const value of [state.baseInstructions, state.turnContext, ...state.items.map((item) => item.value)]) {
    if (value === undefined) continue;
    if (value && typeof value === "object") {
      const cached = sessionContextValueLengthCache.get(value as object);
      if (cached !== undefined) {
        chars += cached;
        continue;
      }
      try {
        const length = JSON.stringify(value).length;
        sessionContextValueLengthCache.set(value as object, length);
        chars += length;
      } catch {}
    } else {
      try {
        chars += JSON.stringify(value).length;
      } catch {}
    }
  }
  return Math.ceil(chars / 4);
}

const sessionContextValueLengthCache = new WeakMap<object, number>();
