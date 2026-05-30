/**
 * Shared "save this session as a link" helper. Used by every surface
 * that displays a single session and wants to pin it: SessionView's
 * burger menu (chat sessions), NewSessionCol's burger menu (active
 * TUIs), and any future surface that knows a session's source.
 *
 * The helper assembles the display snapshot (label / agent /
 * msgCount / age) from /api/agents and routes the POST + fly
 * animation through StickyNotesLayer's shared `spawnLinkWithTarget`
 * — the same code path the picker uses. That means every spawn
 * origin gets the same staging-then-fly motion and the same z-order
 * (always brought to front).
 */

import { relativeAge } from "./mention-providers";
import { spawnLinkWithTarget } from "./StickyNotesLayer.svelte";
import { apiUrl } from "./api";

interface AgentRow {
  source: string;
  agent: string;
  title?: string;
  manualTitle?: string;
  firstUserMessage?: string;
  sessionId?: string;
  messageCount?: number;
  lastActive: string;
}

export interface SaveSessionAsLinkOpts {
  /** Worktree the link should pin to (= `worktree:<path>` anchor). */
  wtPath: string;
  /** Session source path or synthetic `__new__:` id — whatever the
   *  caller's column currently identifies the session by. Live
   *  label resolution in the chip will pick up the canonical title
   *  once the session writes to disk and the path migrates. */
  source: string;
  /** Fallback agent ("claude" | "codex" | "shell"). Used only when
   *  /api/agents doesn't yet know about this source (e.g. a fresh
   *  TUI that hasn't written JSONL yet). */
  fallbackAgent: string;
  /** Fallback display label — typically the user's manually-typed
   *  title for the column. Used when /api/agents has no row yet. */
  fallbackLabel?: string;
  /** Bounding rect of the trigger element (e.g. the burger button
   *  the user clicked). The fly animation launches from here. */
  triggerRect: DOMRect;
}

export async function saveSessionAsLink(
  opts: SaveSessionAsLinkOpts,
): Promise<void> {
  if (!opts.wtPath) return;
  let label = opts.fallbackLabel?.trim() || "(session)";
  let agentName: string = opts.fallbackAgent;
  let msgCount = 0;
  let lastActive = new Date().toISOString();
  try {
    const res = await fetch(apiUrl("/api/agents"));
    if (res.ok) {
      const all = (await res.json()) as AgentRow[];
      const found = all.find((s) => s.source === opts.source);
      if (found) {
        agentName = found.agent;
        label =
          (found.manualTitle && found.manualTitle.trim()) ||
          (found.title && found.title.trim()) ||
          (found.firstUserMessage && found.firstUserMessage.trim()) ||
          (found.sessionId ? `session ${found.sessionId.slice(0, 8)}` : label);
        msgCount = found.messageCount ?? 0;
        lastActive = found.lastActive;
      }
    }
  } catch {
    // Snapshot is best-effort — falling through with defaults still
    // produces a valid (less-rich) link chip.
  }
  await spawnLinkWithTarget({
    anchor: `worktree:${opts.wtPath}`,
    originRect: opts.triggerRect,
    target: {
      type: "session",
      value: opts.source,
      label,
      agent: agentName,
      subtitle: msgCount > 0 ? `${msgCount} msg` : "",
      meta: relativeAge(lastActive),
    },
  });
}
