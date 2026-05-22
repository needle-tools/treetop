/**
 * Pure function for the "have we seen this session before?" question
 * on accept. Two JSONL transcripts come in; we report how many lines
 * they share as a common prefix and what each side has past that.
 *
 * Identity per line: prefer the top-level `uuid` (Claude's
 * convention) when present; otherwise fall back to a stable hash of
 * the raw line so we can still spot identical-vs-different lines in
 * formats without a uuid (Codex's older flat shapes, fixtures).
 *
 * This is not a 3-way merge tool — just enough signal for the UI to
 * pick between "update from N→M" copy and "diverged, three buttons"
 * copy. See plans/PLAN-SESSION-SHARE.md → Conflict handling.
 */

export interface Divergence {
  commonPrefix: number;
  existingAfter: number;
  incomingAfter: number;
  /** True when every existing line is also in incoming in order —
   *  i.e. incoming is a strict (or equal) extension. Drives the
   *  "Update from N to M messages" path. */
  supersetOfExisting: boolean;
  /** True when there is at least one existing line not present in
   *  incoming at the same position. Drives the three-button choice. */
  diverged: boolean;
}

function lineIds(jsonl: string): string[] {
  if (!jsonl) return [];
  const ids: string[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      ids.push("h:" + hash(line));
      continue;
    }
    if (parsed && typeof parsed === "object") {
      const uuid = (parsed as { uuid?: unknown }).uuid;
      if (typeof uuid === "string" && uuid.length > 0) {
        ids.push("u:" + uuid);
        continue;
      }
    }
    ids.push("h:" + hash(line));
  }
  return ids;
}

/** Tiny FNV-1a 32-bit hash. Cryptographically meaningless — we only
 *  need a stable per-line key, not collision resistance. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function findDivergence(existing: string, incoming: string): Divergence {
  const a = lineIds(existing);
  const b = lineIds(incoming);

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;

  const commonPrefix = i;
  const existingAfter = a.length - i;
  const incomingAfter = b.length - i;
  const supersetOfExisting = existingAfter === 0;
  const diverged = existingAfter > 0;

  return {
    commonPrefix,
    existingAfter,
    incomingAfter,
    supersetOfExisting,
    diverged,
  };
}
