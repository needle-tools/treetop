/**
 * Per-Ollama-session JSONL files. Ollama is API-driven (see
 * plans/ollama.md "Plan: API-driven chat mode") — the daemon's
 * `/api/ollama/chat` endpoint owns the conversation, writing one
 * `kind: "turn"` entry per user/assistant turn into
 * `<workspace>/ollama/<termId>.jsonl`:
 *
 *   - `kind: "header"`  one per file, written by `POST /api/ollama/
 *                       sessions` when the chat column is created.
 *                       Carries the picked model, worktree path,
 *                       spawn cwd, and a createdAt timestamp.
 *   - `kind: "turn"`    one per user/assistant turn. Canonical
 *                       record of the conversation — read back by
 *                       `parseOllamaJsonl` and the next chat
 *                       request's `messages[]` reconstruction.
 *   - `kind: "exit"`    appended only by the now-legacy PTY-capture
 *                       path. Newer API-driven sessions don't need
 *                       it (there's no PTY to exit); kept in the
 *                       type so old files still parse.
 *
 * The model the session is bound to is what every UI surface uses
 * for labelling (the pill, the picker rows, the dock dot title).
 * It's pinned in the header at session creation and overridable
 * per-turn via the `model` field on a `turn` entry.
 */

import { join } from "node:path";
import { appendFile, readFile, readdir, mkdir, access } from "node:fs/promises";

const OLLAMA_DIR = "ollama";

export interface OllamaHeader {
  kind: "header";
  termId: string;
  /** Worktree path the column was opened in. Stable across the session's
   *  lifetime — even if the user cd-s somewhere else inside the TUI
   *  (Ollama's TUI doesn't actually let you, but `agents.ts` consumers
   *  shouldn't assume one way or the other). */
  wt: string;
  /** cwd at spawn time. Pinned alongside `wt` so a Resume action can
   *  respawn at the same location even if the worktree moved on disk. */
  spawnCwd: string;
  /** Model tag passed to `ollama run`, e.g. `qwen3-coder:30b`. The user
   *  picked this from the daemon's `/api/ollama/models` list. */
  model: string;
  createdAt: string;
}

export interface OllamaExitEntry {
  kind: "exit";
  ts: string;
  /** PTY exit code; null when the PTY was killed before exit was observed. */
  code: number | null;
  signal?: string;
}

/** Structured user/assistant turn written by the daemon's
 *  `/api/ollama/chat` endpoint — the canonical record for an
 *  Ollama session. One entry per turn, not per chunk; the endpoint
 *  buffers the streamed response and writes the complete assistant
 *  turn on stream completion (or `partial: true` if the client
 *  cancelled mid-stream). */
export interface OllamaTurnEntry {
  kind: "turn";
  ts: string;
  role: "user" | "assistant";
  /** The user's input or the model's reply, verbatim. No markdown
   *  processing — the renderer handles that. */
  content: string;
  /** Model that produced this turn. Overrides the header's model on
   *  a per-turn basis so multi-model conversations attribute each
   *  assistant bubble correctly. */
  model?: string;
  /** Set when the client disconnected before the model finished
   *  streaming. The content is whatever was received up to that
   *  point — better than losing it. */
  partial?: boolean;
}

export type OllamaEntry = OllamaHeader | OllamaExitEntry | OllamaTurnEntry;

export class OllamaSessionsLog {
  private constructor(public readonly dir: string) {}

  /** Per-termId write chain so concurrent appends serialize through
   *  the same Promise. Prevents interleaved JSONL lines when a
   *  streaming-response writer races with an abort-write. */
  private writeChains = new Map<string, Promise<void>>();

  /** Open (and lazily create) `<workspace>/ollama/`. Idempotent — call
   *  on daemon start. */
  static async open(workspacePath: string): Promise<OllamaSessionsLog> {
    const dir = join(workspacePath, OLLAMA_DIR);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
    return new OllamaSessionsLog(dir);
  }

  private pathFor(termId: string): string {
    if (
      termId.includes("/") ||
      termId.includes("\\") ||
      termId.includes("..")
    ) {
      throw new Error(`invalid termId: ${termId}`);
    }
    return join(this.dir, `${termId}.jsonl`);
  }

  /** Serialize an append-to-this-termId through a per-termId promise
   *  chain. Ensures two callers writing to the same file end up with
   *  whole lines in order, not interleaved bytes. */
  private async serialize(
    termId: string,
    op: () => Promise<void>,
  ): Promise<void> {
    const prev = this.writeChains.get(termId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.writeChains.set(termId, next);
    try {
      await next;
    } finally {
      // Clean up if we're the tail of the chain.
      if (this.writeChains.get(termId) === next) {
        this.writeChains.delete(termId);
      }
    }
  }

  /** Write the header line. Called once per ollama session, on spawn. */
  async writeHeader(header: OllamaHeader): Promise<void> {
    await this.serialize(header.termId, () =>
      appendFile(this.pathFor(header.termId), JSON.stringify(header) + "\n"),
    );
  }

  /** Append an exit record. Only legacy PTY-capture sessions emit
   *  these; API-driven sessions never exit (the JSONL is open-ended
   *  until the user explicitly drops the session). Kept for
   *  back-compat with old files. */
  async appendExit(termId: string, entry: OllamaExitEntry): Promise<void> {
    await this.serialize(termId, () =>
      appendFile(this.pathFor(termId), JSON.stringify(entry) + "\n"),
    );
  }

  /** Append a structured user/assistant turn. Used by `/api/ollama/chat`
   *  — one entry per turn (not per chunk), written on stream
   *  completion or abort. */
  async appendTurn(termId: string, entry: OllamaTurnEntry): Promise<void> {
    await this.serialize(termId, () =>
      appendFile(this.pathFor(termId), JSON.stringify(entry) + "\n"),
    );
  }

  /** Reconstruct the messages[] array for an /api/chat request from
   *  the on-disk transcript. Walks the JSONL once, picking up
   *  `header` (for the bound model) and `turn` entries (the user/
   *  assistant log). Returns the active model alongside — latest
   *  turn's `model` field wins, falling back to the header.
   *
   *  Returns `null` when the file is missing or has no header. A
   *  header-only file (no turns yet) returns an empty messages[]. */
  async readMessagesForChat(termId: string): Promise<{
    model: string;
    messages: { role: "user" | "assistant"; content: string }[];
  } | null> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(termId), "utf-8");
    } catch {
      return null;
    }
    let header: OllamaHeader | null = null;
    let activeModel: string | undefined;
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const kind = obj.kind;
      if (kind === "header") {
        const h = parseHeader(line);
        if (h) {
          header = h;
          activeModel = h.model;
        }
      } else if (kind === "turn") {
        const role = obj.role;
        const content = obj.content;
        if (
          (role === "user" || role === "assistant") &&
          typeof content === "string"
        ) {
          turns.push({ role, content });
          if (typeof obj.model === "string") activeModel = obj.model;
        }
      }
    }
    if (!header) return null;
    return { model: activeModel ?? header.model, messages: turns };
  }

  /** Read the header line of a single file. Returns null if the file is
   *  missing or the first line doesn't parse as a header. */
  async readHeader(termId: string): Promise<OllamaHeader | null> {
    let text: string;
    try {
      text = await readFile(this.pathFor(termId), "utf-8");
    } catch {
      return null;
    }
    const firstLine = text.split("\n", 1)[0];
    if (!firstLine) return null;
    return parseHeader(firstLine);
  }

  /** Enumerate every ollama session file, returning parsed headers. */
  async listHeaders(): Promise<OllamaHeader[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: OllamaHeader[] = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const termId = name.slice(0, -".jsonl".length);
      const h = await this.readHeader(termId).catch(() => null);
      if (h) out.push(h);
    }
    return out;
  }
}

/** Parse a single header line. Exported for tests. */
export function parseHeader(line: string): OllamaHeader | null {
  try {
    const obj = JSON.parse(line) as Partial<OllamaHeader>;
    if (
      obj.kind === "header" &&
      typeof obj.termId === "string" &&
      typeof obj.wt === "string" &&
      typeof obj.spawnCwd === "string" &&
      typeof obj.model === "string" &&
      typeof obj.createdAt === "string"
    ) {
      return obj as OllamaHeader;
    }
  } catch {
    // bad line
  }
  return null;
}
