import {
  createSessionContextTimelineBuilder,
  sessionContextItemLabel,
  type SessionContextItem,
  type SessionContextState,
  type SessionContextTimeline,
  type VisualWorkArtifact,
} from "@treetop/nicifier";

export const CONTEXT_VIEW_SOURCE_PREFIX = "__context_view__:";

export function contextViewPanelSource(ownerSource: string, contextSource = ownerSource): string {
  return `${CONTEXT_VIEW_SOURCE_PREFIX}${encodeURIComponent(ownerSource)}|${encodeURIComponent(contextSource)}`;
}

export function contextViewOwnerSource(panelSource: string): string | undefined {
  if (!panelSource.startsWith(CONTEXT_VIEW_SOURCE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(panelSource.slice(CONTEXT_VIEW_SOURCE_PREFIX.length).split("|", 1)[0]!);
  } catch {
    return undefined;
  }
}

export function contextViewSessionSource(panelSource: string): string | undefined {
  if (!panelSource.startsWith(CONTEXT_VIEW_SOURCE_PREFIX)) return undefined;
  const encoded = panelSource.slice(CONTEXT_VIEW_SOURCE_PREFIX.length).split("|")[1];
  try {
    return encoded ? decodeURIComponent(encoded) : contextViewOwnerSource(panelSource);
  } catch {
    return undefined;
  }
}

export function insertContextViewPanel<T extends { agent: string; source: string }>(
  sessions: readonly T[],
  ownerSource: string,
  contextSource = ownerSource,
): { sessions: readonly T[]; inserted: boolean } {
  const existingSource = sessions.find((session) => contextViewOwnerSource(session.source) === ownerSource)?.source;
  if (existingSource) return { sessions, inserted: false };
  const source = contextViewPanelSource(ownerSource, contextSource);
  const ownerIndex = sessions.findIndex((session) => session.source === ownerSource);
  const next = [...sessions];
  next.splice(Math.max(0, ownerIndex), 0, { agent: "context", source } as T);
  return { sessions: next, inserted: true };
}

export interface ParsedSessionContextSource {
  timeline: SessionContextTimeline;
  lineCount: number;
  invalidLineCount: number;
}

const contextPreviewCache = new WeakMap<object, string>();

function contextPreview(value: unknown): string {
  if (value && typeof value === "object") {
    const cached = contextPreviewCache.get(value as object);
    if (cached !== undefined) return cached;
    const preview = JSON.stringify(value, null, 2);
    contextPreviewCache.set(value as object, preview);
    return preview;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

function contextItemGroup(item: SessionContextItem): string {
  const value = item.value && typeof item.value === "object"
    ? item.value as Record<string, unknown>
    : {};
  const role = typeof value.role === "string" ? value.role : "";
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "function_call" || type === "custom_tool_call") return "Tools/Calls";
  if (type === "function_call_output" || type === "custom_tool_call_output") return "Tools/Results";
  if (type.includes("reasoning")) return "Reasoning";
  if (role) return `Messages/${role[0]!.toUpperCase()}${role.slice(1)}`;
  return "Other";
}

function contextTreeArtifact(
  id: string,
  path: string,
  title: string,
  value: unknown,
): VisualWorkArtifact {
  const preview = contextPreview(value);
  return {
    id,
    kind: "other",
    action: "referenced",
    label: path.split("/").at(-1) ?? title,
    path,
    previewTitle: title,
    preview,
  };
}

export function sessionContextTreeArtifacts(
  state: SessionContextState,
  items: readonly SessionContextItem[] = state.items,
  startIndex = 0,
): VisualWorkArtifact[] {
  const artifacts: VisualWorkArtifact[] = [];
  if (state.baseInstructions !== undefined) {
    artifacts.push(contextTreeArtifact(
      "context-base-instructions",
      "Instructions/Base instructions",
      "Base instructions",
      state.baseInstructions,
    ));
  }
  if (state.turnContext !== undefined) {
    artifacts.push(contextTreeArtifact(
      "context-turn-settings",
      "Settings/Current turn",
      "Current turn settings",
      state.turnContext,
    ));
  }
  items.forEach((item, index) => {
    const label = sessionContextItemLabel(item);
    const safeLabel = label.replaceAll("/", "∕");
    artifacts.push(contextTreeArtifact(
      `context-${item.sourceLine}-${item.id}`,
      `${contextItemGroup(item)}/${String(startIndex + index + 1).padStart(4, "0")} · ${safeLabel}`,
      `${label} · transcript line ${item.sourceLine.toLocaleString()}`,
      item.value,
    ));
  });
  return artifacts;
}

export async function parseSessionContextBlob(
  blob: Pick<Blob, "size" | "stream">,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
  startingLine = 0,
): Promise<ParsedSessionContextSource> {
  const builder = createSessionContextTimelineBuilder();
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let bytesRead = 0;
  let lineCount = startingLine;
  let invalidLineCount = 0;

  const ingestLine = (line: string) => {
    lineCount += 1;
    if (!line.trim()) return;
    try {
      builder.ingest(JSON.parse(line), lineCount);
    } catch {
      invalidLineCount += 1;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      ingestLine(line);
      newline = pending.indexOf("\n");
    }
    onProgress?.(bytesRead, blob.size);
  }
  pending += decoder.decode();
  if (pending.length > 0) ingestLine(pending.replace(/\r$/, ""));
  onProgress?.(blob.size, blob.size);
  return { timeline: builder.finish(), lineCount, invalidLineCount };
}
