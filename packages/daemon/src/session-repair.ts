/**
 * Repair broken parent chains in Claude Code JSONL session files.
 *
 * Claude Code's JSONL format uses a linked list: each entry has a `uuid`
 * and a `parentUuid` pointing to its predecessor. When an entry is lost
 * (e.g. a tool result never written to disk), the chain breaks and
 * Claude Code's context loader can only see messages after the break —
 * which can drop a 1900-message session down to 8 messages.
 *
 * This module detects those breaks and inserts synthetic bridge nodes
 * so the chain is continuous again.
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";

export interface BrokenLink {
  /** The UUID that is referenced but missing from the file. */
  missingUuid: string;
  /** The UUID of the entry that references the missing parent. */
  referencedBy: string;
  /** 0-based line index where the referencing entry lives. */
  lineIndex: number;
}

export interface OrphanedTail {
  /** 0-based line index where the orphaned region starts. */
  startLineIndex: number;
  /** Number of lines in the orphaned tail. */
  lineCount: number;
  /** messageCount before the drop (the last healthy turn). */
  messageCountBefore: number;
  /** messageCount after the drop (the first amnesiac turn). */
  messageCountAfter: number;
}

export interface SessionDiagnosis {
  totalEntries: number;
  /** Entries with a uuid (chain participants). */
  chainEntries: number;
  brokenLinks: BrokenLink[];
  /** Post-break messages where the model had severely reduced context. */
  orphanedTail: OrphanedTail | null;
}

export interface RepairResult {
  /** Number of synthetic nodes inserted. */
  repaired: number;
  /** Path to the .bak file (empty string if nothing was repaired). */
  backupPath: string;
  /** Details of each repair. */
  repairs: BrokenLink[];
  /** Number of orphaned tail lines trimmed. */
  trimmedLines: number;
}

/**
 * Scan a Claude JSONL session for broken parent links.
 * Only examines entries that have both `uuid` and `parentUuid` —
 * metadata lines (queue-operation, last-prompt, ai-title, etc.) are
 * skipped since they don't participate in the parent chain.
 */
export function diagnoseClaudeSession(text: string): SessionDiagnosis {
  const lines = text.split("\n").filter(Boolean);
  const uuids = new Set<string>();
  const chainEntries: Array<{
    uuid: string;
    parentUuid: string;
    lineIndex: number;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.uuid === "string") {
      uuids.add(obj.uuid);
    }
    if (typeof obj.uuid === "string" && typeof obj.parentUuid === "string") {
      chainEntries.push({
        uuid: obj.uuid,
        parentUuid: obj.parentUuid,
        lineIndex: i,
      });
    }
  }

  const brokenLinks: BrokenLink[] = [];
  for (const entry of chainEntries) {
    if (!uuids.has(entry.parentUuid)) {
      brokenLinks.push({
        missingUuid: entry.parentUuid,
        referencedBy: entry.uuid,
        lineIndex: entry.lineIndex,
      });
    }
  }

  // Detect orphaned tails: sequences of messages after a dramatic
  // messageCount drop in turn_duration entries. These are messages
  // generated while the chain was broken and the model had amnesia.
  let orphanedTail: OrphanedTail | null = null;
  const turnDurations: Array<{ lineIndex: number; messageCount: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      obj.type === "system" &&
      obj.subtype === "turn_duration" &&
      typeof obj.messageCount === "number"
    ) {
      turnDurations.push({ lineIndex: i, messageCount: obj.messageCount });
    }
  }
  for (let i = 1; i < turnDurations.length; i++) {
    const prev = turnDurations[i - 1]!;
    const curr = turnDurations[i]!;
    // A drop of >80% in messageCount signals the model lost its context.
    if (prev.messageCount > 50 && curr.messageCount < prev.messageCount * 0.2) {
      // The orphaned region starts after the last healthy turn_duration.
      // Find the first non-metadata line after it.
      let startIdx = prev.lineIndex + 1;
      for (let j = startIdx; j < lines.length; j++) {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(lines[j]!) as Record<string, unknown>;
        } catch {
          continue;
        }
        const t = obj.type as string;
        if (
          t === "last-prompt" ||
          t === "ai-title" ||
          t === "permission-mode"
        ) {
          startIdx = j;
        } else {
          break;
        }
      }
      orphanedTail = {
        startLineIndex: startIdx,
        lineCount: lines.length - startIdx,
        messageCountBefore: prev.messageCount,
        messageCountAfter: curr.messageCount,
      };
      break;
    }
  }

  return {
    totalEntries: lines.length,
    chainEntries: chainEntries.length,
    brokenLinks,
    orphanedTail,
  };
}

/**
 * Repair broken parent links in a Claude JSONL file by inserting
 * synthetic bridge nodes. Creates a .bak backup before modifying.
 *
 * For each broken link, the synthetic node:
 * - Gets the missing UUID so the child can find its parent
 * - Gets parentUuid set to the most recent UUID before the break
 * - Contains a minimal tool_result placeholder (since the most common
 *   lost entry is a tool result that was never flushed to disk)
 * - Copies session metadata (sessionId, cwd, slug, etc.) from the
 *   referencing entry
 */
export async function repairClaudeSession(
  filePath: string,
): Promise<RepairResult> {
  const text = await readFile(filePath, "utf-8");
  const diag = diagnoseClaudeSession(text);

  if (diag.brokenLinks.length === 0 && !diag.orphanedTail) {
    return { repaired: 0, backupPath: "", repairs: [], trimmedLines: 0 };
  }

  const backupPath = filePath + ".bak";
  await copyFile(filePath, backupPath);

  const lines = text.split("\n");
  // Remove trailing empty line if present (we'll re-add it)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Build a map of uuid → parsed object for lookups
  const byUuid = new Map<string, Record<string, unknown>>();
  const parsed: Array<Record<string, unknown> | null> = [];
  for (const line of lines) {
    if (!line) {
      parsed.push(null);
      continue;
    }
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      parsed.push(obj);
      if (typeof obj.uuid === "string") {
        byUuid.set(obj.uuid, obj);
      }
    } catch {
      parsed.push(null);
    }
  }

  // Process broken links in reverse order so line indices stay valid
  // during insertion.
  const sorted = [...diag.brokenLinks].sort(
    (a, b) => b.lineIndex - a.lineIndex,
  );

  for (const broken of sorted) {
    // Find the most recent entry with a uuid before the broken entry
    let parentOfMissing: string | undefined;
    for (let i = broken.lineIndex - 1; i >= 0; i--) {
      const obj = parsed[i];
      if (obj && typeof obj.uuid === "string") {
        parentOfMissing = obj.uuid;
        break;
      }
    }

    // Try to find the tool_use_id from the parent entry (the tool_use
    // that the missing tool_result was responding to)
    let toolUseId = "unknown";
    if (parentOfMissing) {
      const parentObj = byUuid.get(parentOfMissing);
      if (parentObj) {
        const msg = parentObj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              (block as Record<string, unknown>).type === "tool_use" &&
              typeof (block as Record<string, unknown>).id === "string"
            ) {
              toolUseId = (block as Record<string, unknown>).id as string;
            }
          }
        }
      }
    }

    // Copy metadata from the referencing entry
    const ref = parsed[broken.lineIndex];
    const sessionId =
      (ref && typeof ref.sessionId === "string" ? ref.sessionId : "") ||
      undefined;
    const cwd =
      (ref && typeof ref.cwd === "string" ? ref.cwd : "") || undefined;
    const slug =
      (ref && typeof ref.slug === "string" ? ref.slug : "") || undefined;
    const version =
      (ref && typeof ref.version === "string" ? ref.version : "") || undefined;
    const gitBranch =
      (ref && typeof ref.gitBranch === "string" ? ref.gitBranch : "") ||
      undefined;
    const entrypoint =
      (ref && typeof ref.entrypoint === "string" ? ref.entrypoint : "") ||
      undefined;

    // Infer a timestamp between parent and child
    let timestamp: string | undefined;
    if (ref && typeof ref.timestamp === "string") {
      const childMs = new Date(ref.timestamp).getTime();
      if (!isNaN(childMs)) {
        timestamp = new Date(childMs - 500).toISOString();
      }
    }

    const synthetic: Record<string, unknown> = {
      parentUuid: parentOfMissing,
      isSidechain: false,
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "[supergit session repair: original tool output was lost]",
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
      },
      uuid: broken.missingUuid,
      timestamp,
      toolUseResult:
        "Error: [supergit session repair: original tool output was lost]",
      userType: "external",
      entrypoint,
      cwd,
      sessionId,
      version,
      gitBranch,
      slug,
    };

    // Remove undefined values for cleaner JSON
    for (const key of Object.keys(synthetic)) {
      if (synthetic[key] === undefined) delete synthetic[key];
    }

    // Insert just before the broken entry
    lines.splice(broken.lineIndex, 0, JSON.stringify(synthetic));
    // Also update parsed array to keep indices in sync for subsequent
    // iterations (though we process in reverse, this keeps things clean)
    parsed.splice(broken.lineIndex, 0, synthetic);
  }

  // Trim orphaned tail — messages generated while the chain was broken
  // and the model had amnesia. These "I don't have history" messages
  // actively poison the context on resume.
  let trimmedLines = 0;
  if (diag.orphanedTail) {
    // Re-diagnose after chain repair to get updated line indices
    const postRepairText = lines.join("\n");
    const postDiag = diagnoseClaudeSession(postRepairText);
    if (postDiag.orphanedTail) {
      trimmedLines = lines.length - postDiag.orphanedTail.startLineIndex;
      lines.length = postDiag.orphanedTail.startLineIndex;
    }
  }

  await writeFile(filePath, lines.join("\n") + "\n");

  return {
    repaired: diag.brokenLinks.length,
    backupPath,
    repairs: diag.brokenLinks,
    trimmedLines,
  };
}
