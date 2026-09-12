import {
  createSessionContextTimelineBuilder,
  type SessionContextTimeline,
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
