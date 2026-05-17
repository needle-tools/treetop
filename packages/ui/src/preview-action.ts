/**
 * Helpers for the session-dock chat preview's "Now:" action chip —
 * the small status line above the message bubbles showing the
 * latest tool the agent invoked. Pulled out of SessionDock.svelte
 * so the parsing can be unit-tested without rendering Svelte.
 *
 * The shape we accept is the normalised message tree that comes
 * out of the daemon's `/api/session` endpoint: each message has a
 * `role` and an array of `blocks`, where a block is one of
 * `text` / `tool_use` / `tool_result` / etc. We only care about
 * the most recent `tool_use` block of the most recent assistant
 * message — that's the agent's current action.
 */

export interface PreviewActionBlock {
  type?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface PreviewActionMessage {
  role: string;
  timestamp?: string;
  blocks?: PreviewActionBlock[];
}

export interface PreviewAction {
  kind: "action";
  toolName: string;
  /** A short, single-line summary of the tool's input. Undefined
   *  when no recognised field exists on the input object. */
  detail?: string;
}

export interface PreviewMsg {
  kind: "msg";
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface PreviewGap {
  kind: "gap";
  count: number;
}

export type PreviewItem = PreviewMsg | PreviewGap | PreviewAction;

/** How many assistant turns the dock preview keeps in view. Older
 *  ones collapse into the "+N messages" gap pill. */
export const PREVIEW_MAX_ASSISTANTS = 3;

/** Consecutive user messages sent within this many ms of each other
 *  are collapsed into a single newline-joined preview bubble. Catches
 *  rapid-fire "5 quick prompts" sequences so the bubble shows the
 *  full thread of intent, not just the last fragment. */
const USER_BURST_GAP_MS = 30_000;

/** Hard cap on the merged-burst text rendered in a single user
 *  preview bubble. The bubble is a glance, not a full transcript —
 *  beyond this the reader should be opening the column. */
const USER_BURST_CHAR_CAP = 300;

function clampUserBurst(text: string): string {
  if (text.length <= USER_BURST_CHAR_CAP) return text;
  return text.slice(0, USER_BURST_CHAR_CAP - 1) + "…";
}

/** Placeholder used when the latest assistant message has neither
 *  text nor a tool_use block yet (mid-stream). Guarantees the user
 *  always sees a row for the latest AI turn. */
const ASSISTANT_TYPING_PLACEHOLDER = "…";

const DETAIL_FIELDS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "notebook_path",
] as const;

const DETAIL_MAX_LEN = 90;

/** Pick the most informative single-line summary from a tool's
 *  input. Walks a small allowlist of common field names — file
 *  paths, commands, patterns, URLs — and returns the first one
 *  that's a non-empty string. Truncates with an ellipsis if too
 *  long. Returns undefined if nothing recognisable is found,
 *  signalling the caller should show just the tool name. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of DETAIL_FIELDS) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > DETAIL_MAX_LEN
        ? v.slice(0, DETAIL_MAX_LEN - 1) + "…"
        : v;
    }
  }
  return undefined;
}

/** Find the most recent tool_use block across the message list.
 *  Walks from the end backwards so the FIRST match wins, which
 *  matches "what's the agent doing right now". Returns null when:
 *    - there are no assistant messages with tool_use blocks, or
 *    - the latest tool_use block has no `toolName`. */
export function extractLatestAction(
  messages: PreviewActionMessage[],
): PreviewAction | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const blocks = m.blocks;
    if (!Array.isArray(blocks)) continue;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type !== "tool_use") continue;
      if (typeof b.toolName !== "string" || b.toolName.length === 0) continue;
      return {
        kind: "action",
        toolName: b.toolName,
        detail: summarizeToolInput(b.toolInput),
      };
    }
  }
  return null;
}

/** Walk an assistant message's blocks in source order and emit
 *  text bubbles + tool chips as encountered. Adjacent text blocks
 *  are coalesced into a single bubble so a flurry of small text
 *  blocks doesn't render as a wall of micro-bubbles. */
function expandAssistant(
  m: PreviewActionMessage,
  out: PreviewItem[],
): { emittedTextBubble: boolean; emittedAction: boolean } {
  const blocks = Array.isArray(m.blocks) ? m.blocks : [];
  let textBuf: string[] = [];
  let emittedTextBubble = false;
  let emittedAction = false;
  const flushText = () => {
    const joined = textBuf.join(" ").replace(/\s+/g, " ").trim();
    textBuf = [];
    if (joined.length === 0) return;
    out.push({
      kind: "msg",
      role: "assistant",
      text: joined,
      timestamp: m.timestamp,
    });
    emittedTextBubble = true;
  };
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      textBuf.push(b.text);
    } else if (b?.type === "tool_use" && typeof b.toolName === "string") {
      flushText();
      out.push({
        kind: "action",
        toolName: b.toolName,
        detail: summarizeToolInput(b.toolInput),
      });
      emittedAction = true;
    }
  }
  flushText();
  return { emittedTextBubble, emittedAction };
}

function plainText(blocks: PreviewActionBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    // Strictly text blocks. The daemon also fills `text` on
    // tool_result, marker, thinking — including those here would
    // mean a user-role tool_result message shadows the actual
    // typed user input (Claude routes tool_result under
    // role: "user" and they happen to carry the result string in
    // the same `text` field).
    if (b?.type !== "text") continue;
    if (typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Find the index in `all` of the assistant message that owns the
 *  most recent tool_use block. Used to decide whether the top "Now:"
 *  chip is redundant with an inline tool chip that's about to land
 *  in the displayed message stream. */
/** Walk back to find the most recent assistant message that
 *  contains at least one non-empty text block. Used to enforce the
 *  "always show a real AI reply, not just tool chips" guarantee. */
function findLatestAiTextIdx(all: PreviewActionMessage[]): number {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (!m || m.role !== "assistant") continue;
    if (!Array.isArray(m.blocks)) continue;
    const hasText = m.blocks.some(
      (b) =>
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.trim().length > 0,
    );
    if (hasText) return i;
  }
  return -1;
}

function latestActionHostIdx(all: PreviewActionMessage[]): number {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (!m || m.role !== "assistant") continue;
    if (!Array.isArray(m.blocks)) continue;
    if (
      m.blocks.some(
        (b) => b?.type === "tool_use" && typeof b.toolName === "string",
      )
    ) {
      return i;
    }
  }
  return -1;
}

/** Compose the chat-preview render list from a full /api/session
 *  message stream. The output is what `SessionDock.svelte` walks
 *  to paint the side panel:
 *    - an optional top "Now:" action chip when the latest tool
 *      call belongs to a message outside the displayed window
 *    - the latest user turn + the last N assistant turns in strict
 *      chronological order (so a brand-new user message lands at
 *      the bottom, not pinned on top)
 *    - "+N messages" gap pills between visible items when one or
 *      more user/assistant turns were skipped between them
 *    - assistant turns expanded into text bubbles + inline tool
 *      chips in block order
 *    - a "…" placeholder for the latest assistant turn when it has
 *      neither text nor a tool call yet — guarantees the user
 *      always sees at least one row for the latest AI message,
 *      even mid-stream. */
export function buildPreviewItems(
  all: PreviewActionMessage[],
): PreviewItem[] {
  const out: PreviewItem[] = [];
  if (!Array.isArray(all) || all.length === 0) return out;

  type Indexed = {
    idx: number;
    role: "user" | "assistant";
    text: string;
    timestamp?: string;
  };
  const items: Indexed[] = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = plainText(m.blocks);
    // Claude's JSONL routes tool_result payloads under role: "user",
    // since the model "sees" them as if the user delivered them.
    // Those are not user-typed input — filter them out so
    // `lastUser` picks the actual most recent typed message, not a
    // synthetic tool-result entry that would shadow it.
    if (m.role === "user" && text.length === 0) continue;
    items.push({
      idx: i,
      role: m.role,
      text,
      timestamp: m.timestamp,
    });
  }

  const lastAssistants = items
    .filter((x) => x.role === "assistant")
    .slice(-PREVIEW_MAX_ASSISTANTS);
  // Most recent user-side burst: walk back from the latest user
  // message and keep collecting consecutive earlier user messages
  // (no assistant in between) whose timestamps are within
  // USER_BURST_GAP_MS of the next-kept one. The burst is rendered
  // as a single merged bubble; the individual messages remain in
  // `includedIdxs` so they don't get counted as skipped in the
  // "+N messages" gap pill math.
  let latestUserItemsIdx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.role === "user") {
      latestUserItemsIdx = i;
      break;
    }
  }
  const burstUsers: Indexed[] = [];
  if (latestUserItemsIdx >= 0) {
    let prevTs: number | null = null;
    for (let i = latestUserItemsIdx; i >= 0; i--) {
      const u = items[i]!;
      if (u.role !== "user") break;
      const tsRaw = u.timestamp ? Date.parse(u.timestamp) : NaN;
      const ts = Number.isNaN(tsRaw) ? null : tsRaw;
      if (burstUsers.length > 0 && prevTs !== null && ts !== null) {
        if (prevTs - ts > USER_BURST_GAP_MS) break;
      }
      burstUsers.unshift(u);
      if (ts !== null) prevTs = ts;
    }
  }
  const burstIdxs = new Set<number>(burstUsers.map((u) => u.idx));
  const burstAnchor = burstUsers[burstUsers.length - 1];
  const burstMergedText = clampUserBurst(
    burstUsers.map((u) => u.text).join("\n"),
  );
  const includedIdxs = new Set<number>([
    ...lastAssistants.map((x) => x.idx),
    ...burstIdxs,
  ]);
  // Guarantee: always include the most recent assistant message
  // that actually contains text (not just tool_use blocks). Tool
  // chips alone aren't a "reply" — the user wants at least one
  // honest AI text response visible, even when the last 3
  // assistants happen to be tool-only mid-edit.
  const latestAiTextIdx = findLatestAiTextIdx(all);
  if (latestAiTextIdx >= 0) includedIdxs.add(latestAiTextIdx);
  const included = items.filter((x) => includedIdxs.has(x.idx));

  const action = extractLatestAction(all);
  if (action) {
    const hostIdx = latestActionHostIdx(all);
    if (hostIdx === -1 || !includedIdxs.has(hostIdx)) {
      out.push(action);
    }
  }

  const latestAssistantIdx = lastAssistants.length
    ? lastAssistants[lastAssistants.length - 1]!.idx
    : -1;

  let burstEmitted = false;
  for (let i = 0; i < included.length; i++) {
    if (i > 0) {
      const prev = included[i - 1]!;
      const cur = included[i]!;
      let skipped = 0;
      for (const it of items) {
        if (includedIdxs.has(it.idx)) continue;
        if (it.idx > prev.idx && it.idx < cur.idx) skipped++;
      }
      if (skipped > 0) out.push({ kind: "gap", count: skipped });
    }
    const it = included[i]!;
    const fullMessage = all[it.idx]!;
    if (it.role === "user") {
      // All burst user messages are in `included`; emit one merged
      // bubble at the first occurrence and silently skip the rest so
      // they don't render as duplicates.
      if (burstIdxs.has(it.idx)) {
        if (burstEmitted) continue;
        out.push({
          kind: "msg",
          role: "user",
          text: burstMergedText,
          timestamp: burstAnchor?.timestamp,
        });
        burstEmitted = true;
        continue;
      }
      out.push({
        kind: "msg",
        role: "user",
        text: it.text,
        timestamp: it.timestamp,
      });
      continue;
    }
    const { emittedTextBubble, emittedAction } = expandAssistant(
      fullMessage,
      out,
    );
    // Guarantee the latest assistant turn is always represented in
    // the visible stream, even when it hasn't produced any text or
    // tool calls yet (mid-stream first frame). Without this an
    // in-flight reply could render as nothing and the panel would
    // look like it's missing the freshest message.
    if (
      it.idx === latestAssistantIdx &&
      !emittedTextBubble &&
      !emittedAction
    ) {
      out.push({
        kind: "msg",
        role: "assistant",
        text: ASSISTANT_TYPING_PLACEHOLDER,
        timestamp: it.timestamp,
      });
    }
  }

  return out;
}

/** Fetch a session's transcript from the daemon and produce both the
 *  preview render list and the timestamp of the most recent user/
 *  assistant message. Two callers want this: the session dock (for
 *  its hover panel) and the future linked-session / worktree-sessions
 *  hover preview. Returns `null` on network or HTTP errors so callers
 *  can leave previous state in place. */
export async function fetchPreviewItems(
  source: string,
): Promise<{ items: PreviewItem[]; latestTs?: string } | null> {
  try {
    const res = await fetch(`/api/session?source=${encodeURIComponent(source)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      messages?: PreviewActionMessage[];
    };
    const all = data.messages ?? [];
    const items = buildPreviewItems(all);
    let latestTs: string | undefined;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i]!;
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (typeof m.timestamp === "string" && m.timestamp.length > 0) {
        latestTs = m.timestamp;
        break;
      }
    }
    return { items, latestTs };
  } catch {
    return null;
  }
}
