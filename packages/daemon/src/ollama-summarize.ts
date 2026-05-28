/**
 * Sample a normalised session message stream into a compact prompt
 * suitable for a small local model. Pure function — no I/O — so the
 * shape can be unit-tested in isolation.
 *
 * The strategy: keep user + assistant *text* turns only (tool calls,
 * thinking, IDE plumbing all dropped — a 3B model wastes its context
 * trying to read a 50 KB Edit() tool input). For long sessions we
 * take a head + middle + tail slice with explicit
 * `[… N messages omitted …]` markers between them, so the model
 * knows there's a gap and can reason about coverage.
 *
 * Budget: chars-based, treated as a soft cap (we shrink and retry).
 * Token estimate is chars/4 to match the context-chip heuristic the
 * UI already uses elsewhere — being 20 % off is fine; the only
 * invariant that has to hold is "we don't blow up the model."
 */

import type { NormalizedMessage } from "./sessions";

export interface SampleOptions {
  /** Total user+assistant turns to keep. Default 30. */
  targetMessages?: number;
  /** Per-message character cap before truncation. Default 2048. */
  maxMsgChars?: number;
  /** Hard cap on the joined prompt in chars. Default 32 KB
   *  (≈ 8 K tokens). Triggers shrink-and-retry. */
  budgetChars?: number;
}

export interface Sampled {
  /** The fully rendered prompt — pass straight to Ollama. Empty
   *  when the session has no user/assistant text content. */
  prompt: string;
  /** Count of user+assistant turns with non-empty text in the
   *  source, before sampling. */
  totalMessages: number;
  /** Turns that actually appear in `prompt`. */
  includedMessages: number;
  /** Of those, how many had their body clipped. */
  truncatedMessages: number;
  /** chars/4 of the rendered prompt. Heuristic — see file doc. */
  estimatedTokens: number;
}

const DEFAULT_TARGET = 30;
const DEFAULT_MAX_MSG = 2048;
const DEFAULT_BUDGET = 32 * 1024;
/** Suffix appended to a clipped message body. The UI's "Summarized
 *  N messages → M tokens" footer reports the count of truncations,
 *  but the suffix is also visible to the model so it knows the
 *  turn was cut. */
const TRUNCATED_SUFFIX = "…<truncated>";

/** Block kinds whose text we treat as part of the user/assistant turn.
 *  Everything else is plumbing / noise for a summariser. */
const READABLE_KINDS = new Set(["text", "marker"]);

function flattenToText(msg: NormalizedMessage): string {
  const parts: string[] = [];
  for (const b of msg.blocks) {
    if (!READABLE_KINDS.has(b.type)) continue;
    if (typeof b.text !== "string") continue;
    const trimmed = b.text.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join("\n").trim();
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + TRUNCATED_SUFFIX, truncated: true };
}

interface Item {
  role: "user" | "assistant";
  text: string;
}

interface RenderedItem extends Item {
  truncated: boolean;
}

type SeqEntry =
  | {
      kind: "msg";
      role: "user" | "assistant";
      text: string;
      truncated: boolean;
    }
  | { kind: "gap"; count: number };

function buildSequence(
  all: Item[],
  target: number,
  maxMsg: number,
): { sequence: SeqEntry[]; included: number; truncated: number } {
  const N = all.length;
  let items: RenderedItem[] = [];
  const sequence: SeqEntry[] = [];

  if (N <= target) {
    items = all.map((m) => {
      const c = clip(m.text, maxMsg);
      return { role: m.role, text: c.text, truncated: c.truncated };
    });
    for (const it of items) {
      sequence.push({ kind: "msg", ...it });
    }
  } else {
    // 40 / 20 / 40 split. Floor + a guard so degenerate small
    // targets still produce at least one item per slice.
    const headN = Math.max(1, Math.floor(target * 0.4));
    const tailN = Math.max(1, Math.floor(target * 0.4));
    const midN = Math.max(1, target - headN - tailN);

    const middleIdx = Math.floor(N / 2);
    let midStart = middleIdx - Math.floor(midN / 2);
    // Keep the middle slice disjoint from head and tail.
    midStart = Math.max(headN, midStart);
    midStart = Math.min(N - tailN - midN, midStart);
    const midEnd = midStart + midN;

    const head = all.slice(0, headN);
    const mid = all.slice(midStart, midEnd);
    const tail = all.slice(N - tailN);

    const renderSlice = (slice: Item[]): RenderedItem[] =>
      slice.map((m) => {
        const c = clip(m.text, maxMsg);
        return { role: m.role, text: c.text, truncated: c.truncated };
      });

    const headR = renderSlice(head);
    const midR = renderSlice(mid);
    const tailR = renderSlice(tail);

    const gap1 = midStart - head.length;
    const gap2 = N - tailN - midEnd;

    for (const it of headR) sequence.push({ kind: "msg", ...it });
    if (gap1 > 0) sequence.push({ kind: "gap", count: gap1 });
    for (const it of midR) sequence.push({ kind: "msg", ...it });
    if (gap2 > 0) sequence.push({ kind: "gap", count: gap2 });
    for (const it of tailR) sequence.push({ kind: "msg", ...it });

    items = [...headR, ...midR, ...tailR];
  }

  const truncated = items.filter((it) => it.truncated).length;
  return { sequence, included: items.length, truncated };
}

function renderSequence(seq: SeqEntry[]): string {
  const lines: string[] = [];
  for (const entry of seq) {
    if (entry.kind === "gap") {
      lines.push(`[… ${entry.count} messages omitted …]`);
    } else {
      const role = entry.role === "user" ? "User" : "Assistant";
      lines.push(`${role}: ${entry.text}`);
    }
  }
  return lines.join("\n\n");
}

export function sampleSessionForSummary(
  messages: NormalizedMessage[],
  opts: SampleOptions = {},
): Sampled {
  const budgetChars = opts.budgetChars ?? DEFAULT_BUDGET;
  let target = opts.targetMessages ?? DEFAULT_TARGET;
  let maxMsg = opts.maxMsgChars ?? DEFAULT_MAX_MSG;

  const all: Item[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = flattenToText(m);
    if (!text) continue;
    all.push({ role: m.role, text });
  }
  const totalMessages = all.length;
  if (totalMessages === 0) {
    return {
      prompt: "",
      totalMessages: 0,
      includedMessages: 0,
      truncatedMessages: 0,
      estimatedTokens: 0,
    };
  }

  // Shrink-and-retry to fit the budget. Prefer trimming per-message
  // size before dropping turn count — the model benefits more from
  // seeing 30 short turns than 6 long ones.
  let prompt = "";
  let included = 0;
  let truncated = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const built = buildSequence(all, target, maxMsg);
    prompt = renderSequence(built.sequence);
    included = built.included;
    truncated = built.truncated;
    if (prompt.length <= budgetChars) break;
    if (maxMsg > 256) {
      maxMsg = Math.max(256, Math.floor(maxMsg * 0.6));
    } else if (target > 6) {
      target = Math.max(6, Math.floor(target * 0.7));
    } else {
      break;
    }
  }
  if (prompt.length > budgetChars) {
    // Hard cap — last resort if shrink-retry couldn't fit. Leave
    // room for the suffix so the final length is still <= budget;
    // individual messages already carry their own truncation
    // suffix from `clip`, so this global one is informational.
    const room = Math.max(0, budgetChars - TRUNCATED_SUFFIX.length);
    prompt = prompt.slice(0, room) + TRUNCATED_SUFFIX;
  }

  return {
    prompt,
    totalMessages,
    includedMessages: included,
    truncatedMessages: truncated,
    estimatedTokens: Math.ceil(prompt.length / 4),
  };
}
