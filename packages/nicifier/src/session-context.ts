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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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
