/**
 * Per-agent session formats normalised into a single internal shape so the
 * UI never has to know who wrote the file. Each agent's parser is its own
 * function below — add a new agent by writing parseXJsonl + plugging it
 * into parseSessionFile().
 *
 * The on-disk formats are NOT standardised across tools. Claude Code uses
 * one JSONL schema, Codex uses another, OpenAI's older logs use yet a
 * third. We keep that mess contained here.
 */

import { readFile } from "node:fs/promises";
import type { AgentKind } from "./agents";

export type NormalizedRole = "user" | "assistant" | "system" | "tool";

export type NormalizedBlockKind =
  | "text"
  | "tool_use"
  | "tool_result"
  /** IDE state injected by the wrapper (`<ide_opened_file>`, `<ide_selection>` …). */
  | "ide_context"
  /** `<system-reminder>` … `</system-reminder>` wrappers. */
  | "system_reminder"
  /** `<command-name>` / `<command-message>` slash-command markers. */
  | "command";

export interface NormalizedBlock {
  type: NormalizedBlockKind;
  /** Free-form text. For tool_result this is the rendered output. */
  text?: string;
  /** tool_use only. */
  toolName?: string;
  toolInput?: unknown;
  /** Links a tool_result back to the tool_use that produced it. */
  toolUseId?: string;
  /** For ide_context / system_reminder / command: the tag name, e.g. "ide_opened_file". */
  tagName?: string;
}

/**
 * Claude Code injects semantic XML wrappers into raw text blocks
 * (`<ide_opened_file>...</ide_opened_file>`, `<system-reminder>...`,
 * `<command-name>...`, etc). We split those out into typed blocks so the
 * UI can render IDE context / system reminders / slash commands
 * differently from plain text. Anything outside a wrapper stays as
 * plain text. Returns at least one block.
 */
export function splitInjectedTags(text: string): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  const re =
    /<(ide_[a-z_]+|system-reminder|command-[a-z_]+|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) blocks.push({ type: "text", text: before });
    }
    const tag = match[1]!;
    const content = match[2]!.trim();
    let kind: NormalizedBlockKind = "text";
    if (tag.startsWith("ide_")) kind = "ide_context";
    else if (tag === "system-reminder") kind = "system_reminder";
    else if (tag.startsWith("command-") || tag.startsWith("local-command-"))
      kind = "command";
    blocks.push({ type: kind, text: content, tagName: tag });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex).trim();
    if (tail) blocks.push({ type: "text", text: tail });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text }];
}

export interface NormalizedMessage {
  role: NormalizedRole;
  blocks: NormalizedBlock[];
  timestamp?: string;
  /** Per-agent event id (uuid for Claude, free-form elsewhere). */
  id?: string;
}

export interface NormalizedSession {
  agent: AgentKind;
  cwd: string;
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  messages: NormalizedMessage[];
}

function emptySession(agent: AgentKind): NormalizedSession {
  return { agent, cwd: "", sessionId: "", messages: [] };
}

/** Normalize Claude Code's JSONL — entries with type: "user" | "assistant"
 * and a `message` object containing role + content (string OR block list). */
export function parseClaudeJsonl(text: string): NormalizedSession {
  const out = emptySession("claude");
  if (!text) return out;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !out.cwd) out.cwd = obj.cwd;
    if (typeof obj.sessionId === "string" && !out.sessionId)
      out.sessionId = obj.sessionId;

    const type = obj.type;
    if (type !== "user" && type !== "assistant") continue;

    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role: NormalizedRole =
      msg.role === "assistant" ? "assistant" : "user";
    const content = msg.content;
    const blocks: NormalizedBlock[] = [];

    if (typeof content === "string") {
      blocks.push(...splitInjectedTags(content));
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        if (typeof raw !== "object" || raw === null) continue;
        const b = raw as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          blocks.push(...splitInjectedTags(b.text));
        } else if (b.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            toolName: typeof b.name === "string" ? b.name : undefined,
            toolInput: b.input,
            toolUseId: typeof b.id === "string" ? b.id : undefined,
          });
        } else if (b.type === "tool_result") {
          const text =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as Array<{ text?: unknown }>)
                    .map((x) => (typeof x.text === "string" ? x.text : ""))
                    .join("\n")
                : "";
          blocks.push({
            type: "tool_result",
            text,
            toolUseId:
              typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
          });
        }
      }
    }

    if (blocks.length === 0) continue;

    const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    if (ts && !out.startedAt) out.startedAt = ts;
    if (ts) out.endedAt = ts;

    out.messages.push({
      role,
      blocks,
      timestamp: ts,
      id: typeof obj.uuid === "string" ? obj.uuid : undefined,
    });
  }
  return out;
}

/** Best-effort Codex parser. Format varies across versions; we look for
 *  `role` + string `content` and fall back to top-level `text`/`message`. */
export function parseCodexJsonl(text: string): NormalizedSession {
  const out = emptySession("codex");
  if (!text) return out;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !out.cwd) out.cwd = obj.cwd;
    if (typeof obj.sessionId === "string" && !out.sessionId)
      out.sessionId = obj.sessionId;

    const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    if (ts && !out.startedAt) out.startedAt = ts;
    if (ts) out.endedAt = ts;

    const role =
      typeof obj.role === "string"
        ? obj.role === "assistant" || obj.role === "system"
          ? (obj.role as NormalizedRole)
          : "user"
        : null;

    const text =
      typeof obj.content === "string"
        ? obj.content
        : typeof obj.text === "string"
          ? obj.text
          : typeof obj.message === "string"
            ? obj.message
            : null;

    if (role && text) {
      out.messages.push({
        role,
        blocks: [{ type: "text", text }],
        timestamp: ts,
      });
      continue;
    }

    // Tool call shape, best effort
    if (
      typeof obj.type === "string" &&
      (obj.type === "tool_call" || obj.type === "tool_use") &&
      typeof obj.name === "string"
    ) {
      out.messages.push({
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: obj.name,
            toolInput: obj.input ?? obj.arguments,
          },
        ],
        timestamp: ts,
      });
    }
  }
  return out;
}

export async function parseSessionFile(
  agent: AgentKind,
  path: string,
): Promise<NormalizedSession> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return emptySession(agent);
  }
  if (agent === "claude") return parseClaudeJsonl(text);
  if (agent === "codex") return parseCodexJsonl(text);
  // No reader for copilot yet — its data isn't a tail-friendly JSONL.
  return emptySession(agent);
}
