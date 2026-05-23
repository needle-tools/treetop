/**
 * Live tail of agent session files (Claude + Codex JSONL). Watches files
 * whose mtime is within the last RECENT_WINDOW so we don't blow through
 * the file-descriptor budget on machines with hundreds of historical
 * sessions. Periodically rediscovers new sessions.
 *
 * Each new JSON line is summarised into a short human-readable string
 * ("Edit(src/foo.ts)", "← user prompt …", "→ assistant reply …") and
 * emitted to subscribers. The server forwards these via SSE.
 *
 * Read-only. We never write to the session file.
 */

import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { detectAgents, type AgentKind } from "./agents";

export interface ActivityEvent {
  agent: AgentKind;
  cwd: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  source: string;
}

export type ActivityListener = (e: ActivityEvent) => void;

/** Read new bytes from `path` starting at `offset`. Returns the text
 *  of the new chunk and the updated offset (= file size after read).
 *  Returns null when there's nothing new to read: file is gone, hasn't
 *  grown, or shrank (truncation). Exported for testing — the crash
 *  this guards against is a race where `offset` advances past `size`
 *  between two concurrent calls. */
export async function readTailChunk(
  path: string,
  offset: number,
): Promise<{ text: string; newOffset: number } | null> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return null;
  if (stats.size <= offset) {
    return { text: "", newOffset: stats.size };
  }
  const readFrom = offset;
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return null;
  try {
    const length = stats.size - readFrom;
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, readFrom);
    return { text: buf.toString("utf-8"), newOffset: stats.size };
  } finally {
    await fh.close();
  }
}

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const REDISCOVER_INTERVAL_MS = 30_000;
const MAX_TRACKED = 64;

interface Tracked {
  path: string;
  offset: number;
  cwd: string;
  sessionId: string;
  agent: AgentKind;
  watcher?: FSWatcher;
}

const tracked = new Map<string, Tracked>();
const listeners = new Set<ActivityListener>();

export function onActivity(l: ActivityListener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function emit(e: ActivityEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      // listener exceptions don't break the tail
    }
  }
}

export function summarize(agent: AgentKind, entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;

  // Claude Code JSONL — message events
  if (agent === "claude") {
    const type = e.type;
    if (type === "user") {
      const msg = e.message as { content?: unknown } | undefined;
      const content = msg?.content;
      if (typeof content === "string") return truncated("← " + content);
      if (Array.isArray(content)) {
        const text = content
          .map((b) =>
            typeof b === "object" && b && "text" in (b as object)
              ? (b as { text?: unknown }).text
              : "",
          )
          .filter((t) => typeof t === "string")
          .join(" ");
        if (text) return truncated("← " + text);
      }
      return null;
    }
    if (type === "assistant") {
      const msg = e.message as { content?: unknown } | undefined;
      const blocks = msg?.content;
      if (!Array.isArray(blocks)) return null;
      for (const raw of blocks) {
        if (typeof raw !== "object" || raw === null) continue;
        const b = raw as Record<string, unknown>;
        if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "tool";
          const input = (b.input as Record<string, unknown> | undefined) ?? {};
          const target =
            (typeof input.file_path === "string" && input.file_path) ||
            (typeof input.path === "string" && input.path) ||
            (typeof input.command === "string" && input.command) ||
            "";
          return target ? `${name}(${shortPath(String(target))})` : name;
        }
        if (b.type === "text" && typeof b.text === "string") {
          return truncated("→ " + b.text);
        }
      }
      return null;
    }
    return null;
  }

  // Codex: best-effort. The format isn't as fixed as Claude's; we look for
  // common shapes (role/content, tool calls).
  if (agent === "codex") {
    if (typeof e.role === "string" && typeof e.content === "string") {
      const prefix = e.role === "user" ? "← " : "→ ";
      return truncated(prefix + e.content);
    }
    if (typeof e.type === "string") {
      return String(e.type);
    }
    return null;
  }

  return null;
}

function truncated(s: string, n = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}

function shortPath(p: string, n = 48): string {
  if (p.length <= n) return p;
  return "…" + p.slice(-(n - 1));
}

async function rediscover(): Promise<void> {
  const sessions = await detectAgents();
  const now = Date.now();
  const recent = sessions
    .filter((s) => now - Date.parse(s.lastActive) < RECENT_WINDOW_MS)
    .sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive))
    .slice(0, MAX_TRACKED);
  const keepKeys = new Set(recent.map((s) => s.source));

  // Drop trackers for sessions that aren't recent anymore.
  for (const [key, t] of tracked) {
    if (!keepKeys.has(key)) {
      t.watcher?.close();
      tracked.delete(key);
    }
  }

  // Add trackers for new recent sessions.
  for (const s of recent) {
    if (tracked.has(s.source)) continue;
    const stats = await stat(s.source).catch(() => null);
    if (!stats) continue;
    const t: Tracked = {
      path: s.source,
      offset: stats.size, // start at EOF — we only care about new content
      cwd: s.cwd,
      sessionId: s.sessionId ?? "",
      agent: s.agent,
    };
    try {
      t.watcher = watch(s.source, () => {
        void checkTail(s.source);
      });
    } catch {
      // file vanished between detectAgents() and watch() — skip
      continue;
    }
    tracked.set(s.source, t);
  }
}

async function checkTail(path: string): Promise<void> {
  const t = tracked.get(path);
  if (!t) return;
  const result = await readTailChunk(path, t.offset);
  if (!result) return;
  t.offset = result.newOffset;
  if (!result.text) return;

  for (const line of result.text.split("\n")) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const summary = summarize(t.agent, obj);
    if (!summary) continue;
    emit({
      agent: t.agent,
      cwd: t.cwd,
      sessionId: t.sessionId,
      summary,
      timestamp: new Date().toISOString(),
      source: t.path,
    });
  }
}

let started = false;
let rediscoverTimer: ReturnType<typeof setInterval> | null = null;

export async function startActivityTail(): Promise<() => void> {
  if (started) return () => {};
  started = true;
  await rediscover();
  rediscoverTimer = setInterval(() => {
    void rediscover();
  }, REDISCOVER_INTERVAL_MS);
  return () => {
    if (rediscoverTimer) clearInterval(rediscoverTimer);
    for (const t of tracked.values()) t.watcher?.close();
    tracked.clear();
    started = false;
  };
}
