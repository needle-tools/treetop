import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createCodexTranscriptNormalizer, type SessionAgentUsage } from "@treetop/nicifier";
import { createLimiter } from "./concurrency";
import { getSessionFileStats } from "./sessions";

interface UsageIndex {
  size: number;
  mtime: number;
  pending: string;
  childIds: Set<string>;
  normalizer: ReturnType<typeof createCodexTranscriptNormalizer>;
  startedAt?: string;
}
const indexes = new Map<string, UsageIndex>();
const serial = createLimiter(1);

/** Opt-in descendant metadata scan. Usage itself reuses the existing incremental stats scanner. */
export function getSessionAgentUsage(source: string): Promise<SessionAgentUsage> {
  return serial(async () => {
    const info = await stat(source);
    let index = indexes.get(source);
    if (!index || info.size < index.size || (info.size === index.size && info.mtimeMs !== index.mtime)) {
      index = { size: 0, mtime: 0, pending: "", childIds: new Set(), normalizer: createCodexTranscriptNormalizer() };
      indexes.set(source, index);
      if (indexes.size > 64) indexes.delete(indexes.keys().next().value!);
    }
    const ingest = (line: string) => {
      // No media/user text parsing, and no retaining messages from large child files.
      if (!/"type"\s*:\s*"(?:session_meta|function_call|function_call_output|custom_tool_call|custom_tool_call_output|agent_message|SubAgentActivity|subAgentActivity)"/.test(line)) return;
      let row: unknown;
      try { row = JSON.parse(line); } catch { return; }
      if (row && typeof row === "object" && (row as { type?: string }).type === "session_meta") {
        const meta = row as { timestamp?: string; payload?: { timestamp?: string } };
        index.startedAt ??= meta.payload?.timestamp ?? meta.timestamp;
      }
      for (const message of index.normalizer.ingest(row).messages) {
        for (const block of message.blocks) {
          if (block.subagentId && !block.subagentIsParent) index.childIds.add(block.subagentId);
        }
      }
    };
    if (info.size > index.size) {
      for await (const chunk of createReadStream(source, { start: index.size, end: info.size - 1, encoding: "utf8" })) {
        const rows = (index.pending + chunk).split("\n");
        index.pending = rows.pop()!;
        for (const row of rows) ingest(row);
      }
      if (index.pending) ingest(index.pending);
      index.size = info.size;
      index.mtime = info.mtimeMs;
    }
    const stats = await getSessionFileStats(source);
    return { segments: stats.pricingUsage ?? [], complete: stats.pricingUsageExact === true, childIds: [...index.childIds], ...(index.startedAt ? { startedAt: index.startedAt } : {}) };
  });
}
