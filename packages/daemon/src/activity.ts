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

import { createReadStream, watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { detectAgents, type AgentKind, type AgentSession } from "./agents";

export interface ActivityEvent {
  agent: AgentKind;
  cwd: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  source: string;
}

export type ActivityListener = (e: ActivityEvent) => void;

export interface CodexCliState {
  source: string;
  sessionId: string;
  working: boolean;
}

/** CLI repaint bytes never reach this reducer. Only explicit turn boundaries
 * change the state, so a quiet tool call remains working. */
export function codexCliWorkingFromEntry(entry: unknown): boolean | undefined {
  if (!entry || typeof entry !== "object") return;
  const e = entry as { type?: unknown; payload?: { type?: unknown } };
  if (e.type !== "event_msg") return;
  switch (e.payload?.type) {
    case "task_started":
      return true;
    case "task_complete":
    case "turn_aborted":
      return false;
  }
}

const codexStateListeners = new Set<() => void>();
export function onCodexCliState(listener: () => void): () => void {
  codexStateListeners.add(listener);
  return () => {
    codexStateListeners.delete(listener);
  };
}
export function getCodexCliStates(): CodexCliState[] {
  return [...tracked.values()]
    .filter((t) => t.agent === "codex")
    .map((t) => ({
      source: t.path,
      sessionId: t.sessionId,
      working: t.working ?? false,
    }));
}
function notifyCodexCliState(): void {
  for (const listener of codexStateListeners) listener();
}

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

type DetectAgents = () => Promise<AgentSession[]>;

export interface ActivityTailOptions {
  detectAgents?: DetectAgents;
  rediscoverIntervalMs?: number;
}

interface Tracked {
  path: string;
  offset: number;
  cwd: string;
  sessionId: string;
  agent: AgentKind;
  watcher?: FSWatcher;
  working?: boolean;
  partial: string;
  reading: boolean;
  pending: boolean;
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

async function rediscover(
  detect: DetectAgents,
  isStopped: () => boolean,
): Promise<void> {
  const sessions = await detect();
  if (isStopped()) return;
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
      if (t.agent === "codex") notifyCodexCliState();
    }
  }

  // Add trackers for new recent sessions.
  for (const s of recent) {
    if (isStopped()) return;
    if (tracked.has(s.source)) continue;
    const stats = await stat(s.source).catch(() => null);
    if (!stats) continue;
    const t: Tracked = {
      path: s.source,
      offset: stats.size, // start at EOF — we only care about new content
      cwd: s.cwd,
      sessionId: s.sessionId ?? "",
      agent: s.agent,
      partial: "",
      reading: true,
      pending: false,
    };
    try {
      if (isStopped()) return;
      t.watcher = watch(s.source, () => {
        void checkTail(s.source);
      });
    } catch {
      // file vanished between detectAgents() and watch() — skip
      continue;
    }
    tracked.set(s.source, t);
    // Recover the last lifecycle event, including turns started before the
    // watcher/browser connected. Stream the file without replaying old activity.
    if (s.agent === "codex" && stats.size > 0) {
      try {
        for await (const chunk of createReadStream(s.source, {
          encoding: "utf8",
          end: stats.size - 1,
        })) {
          consumeLines(t, String(chunk), false);
        }
      } catch (err) {
        console.warn(
          "supergit daemon: Codex state recovery failed",
          s.source,
          err,
        );
      }
    }
    if (isStopped() || tracked.get(s.source) !== t) return;
    t.reading = false;
    if (s.agent === "codex") notifyCodexCliState();
    // The first turn can be fully written before our next discovery pass.
    // Let the existing activity-based session linker see newly created CLIs,
    // but never replay old files into fresh columns on daemon startup.
    if (s.agent === "codex" && stats.birthtimeMs >= tailStartedAt) {
      emit({
        agent: s.agent,
        cwd: s.cwd,
        sessionId: t.sessionId,
        source: s.source,
        summary: "session discovered",
        timestamp: s.lastActive,
      });
    }
    // Catch output appended while the initial state was being recovered.
    await checkTail(s.source);
  }
}

async function checkTail(path: string): Promise<void> {
  const t = tracked.get(path);
  if (!t) return;
  if (t.reading) {
    t.pending = true;
    return;
  }
  t.reading = true;
  try {
    do {
      t.pending = false;
      const result = await readTailChunk(path, t.offset);
      if (!result || tracked.get(path) !== t) return;
      if (result.newOffset < t.offset) {
        t.partial = "";
        t.working = false;
        if (t.agent === "codex") notifyCodexCliState();
        t.offset = 0;
        t.pending = true;
        continue;
      }
      t.offset = result.newOffset;
      consumeLines(t, result.text, true);
    } while (t.pending);
  } catch (err) {
    console.warn("supergit daemon: activity tail read failed", path, err);
  } finally {
    t.reading = false;
  }
}

function consumeLines(t: Tracked, text: string, live: boolean): void {
  const lines = (t.partial + text).split("\n");
  t.partial = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (t.agent === "codex") {
      const next = codexCliWorkingFromEntry(obj);
      if (next !== undefined && t.working !== next) {
        t.working = next;
        if (live) notifyCodexCliState();
      }
    }
    if (!live) continue;
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
let tailStartedAt = 0;
let rediscoverTimer: ReturnType<typeof setInterval> | null = null;

export async function startActivityTail(
  options: ActivityTailOptions = {},
): Promise<() => void> {
  if (started) return () => {};
  started = true;
  tailStartedAt = Date.now();
  const detect = options.detectAgents ?? detectAgents;
  let stopped = false;
  let discovering = false;
  const rediscoverSafely = () => {
    if (discovering) return;
    discovering = true;
    void rediscover(detect, () => stopped)
      .catch((err) => {
        if (!stopped) {
          console.warn("supergit daemon: activity tail rediscover failed", err);
        }
      })
      .finally(() => {
        discovering = false;
      });
  };
  rediscoverSafely();
  rediscoverTimer = setInterval(() => {
    rediscoverSafely();
  }, options.rediscoverIntervalMs ?? REDISCOVER_INTERVAL_MS);
  return () => {
    stopped = true;
    if (rediscoverTimer) clearInterval(rediscoverTimer);
    rediscoverTimer = null;
    for (const t of tracked.values()) t.watcher?.close();
    tracked.clear();
    notifyCodexCliState();
    started = false;
  };
}
