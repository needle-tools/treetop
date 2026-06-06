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

interface LineEntry {
  /** Stable identity key — `u:<uuid>` for lines with Claude's uuid,
   *  else `h:<hash>` of the raw line. */
  id: string;
  /** The line verbatim (trimmed). Preserved so a merge keeps parentUuid
   *  links and every other field intact. */
  raw: string;
}

function lineEntries(jsonl: string): LineEntry[] {
  if (!jsonl) return [];
  const out: LineEntry[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push({ id: "h:" + hash(line), raw: line });
      continue;
    }
    if (parsed && typeof parsed === "object") {
      const uuid = (parsed as { uuid?: unknown }).uuid;
      if (typeof uuid === "string" && uuid.length > 0) {
        out.push({ id: "u:" + uuid, raw: line });
        continue;
      }
    }
    out.push({ id: "h:" + hash(line), raw: line });
  }
  return out;
}

function lineIds(jsonl: string): string[] {
  return lineEntries(jsonl).map((e) => e.id);
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

/**
 * Merge two transcripts that share a common prefix into a single one:
 * the shared prefix once, then the existing copy's divergent tail, then
 * the incoming copy's divergent tail with any line already emitted
 * (by {@link LineEntry.id}) dropped.
 *
 * Lines are kept verbatim, so for Claude transcripts every `parentUuid`
 * link survives — the result is a valid branching tree where the fork
 * point gains a second child, exactly the shape Claude Code itself
 * writes when you rewind and branch a session. Renderers that follow
 * `parentUuid` reconstruct both branches; ones that read top-to-bottom
 * see the receiver's branch followed by the imported one.
 *
 * Dedup by identity means a tool result (or any line) that landed on
 * both sides past the fork appears once, not twice. Pure: no I/O, safe
 * to call before touching disk so a bad input can't corrupt a file.
 */
export function mergeTranscripts(existing: string, incoming: string): string {
  const a = lineEntries(existing);
  const b = lineEntries(incoming);

  let i = 0;
  while (i < a.length && i < b.length && a[i]!.id === b[i]!.id) i++;

  const out: string[] = [];
  const seen = new Set<string>();
  // Shared prefix, taken from the existing copy (authoritative for the
  // region both sides agree on). Emitted before dedup kicks in so a
  // legitimately repeated prefix line isn't collapsed.
  for (let k = 0; k < i; k++) {
    out.push(a[k]!.raw);
    seen.add(a[k]!.id);
  }
  // Existing tail, then incoming tail — each skipping anything already
  // emitted so overlap past the fork isn't duplicated.
  for (let k = i; k < a.length; k++) {
    if (seen.has(a[k]!.id)) continue;
    out.push(a[k]!.raw);
    seen.add(a[k]!.id);
  }
  for (let k = i; k < b.length; k++) {
    if (seen.has(b[k]!.id)) continue;
    out.push(b[k]!.raw);
    seen.add(b[k]!.id);
  }
  return out.length ? out.join("\n") + "\n" : "";
}
