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
  toolName?: string;
  toolInput?: unknown;
}

export interface PreviewActionMessage {
  role: string;
  blocks?: PreviewActionBlock[];
}

export interface PreviewAction {
  kind: "action";
  toolName: string;
  /** A short, single-line summary of the tool's input. Undefined
   *  when no recognised field exists on the input object. */
  detail?: string;
}

const DETAIL_FIELDS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "url",
  "query",
  "notebook_path",
] as const;

const DETAIL_MAX_LEN = 60;

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
