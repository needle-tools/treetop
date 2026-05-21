/**
 * Per-Ollama-session JSONL headers.
 *
 * Ollama doesn't write its own conversation transcripts to disk the way
 * Claude Code and Codex do — the chat lives only in the running PTY's
 * scrollback. To still expose "past Ollama sessions in this worktree"
 * in the dashboard picker (and to support a read-only column after
 * stopping a session), the daemon writes a minimal header file per
 * spawned Ollama PTY at `<workspace>/ollama/<termId>.jsonl`:
 *
 *   - `kind: "header"`  one per file, written on spawn. Carries the
 *                       picked model, the worktree path, the spawn cwd
 *                       and a createdAt timestamp.
 *   - `kind: "exit"`    appended when the PTY ends.
 *
 * The model picked at spawn is what every UI surface uses to identify
 * the session (the pill, the picker rows, the dock dot title). It's
 * essential metadata that nothing else on disk records, so we record
 * it ourselves.
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

/** Raw PTY output captured while the session is live. Ollama's TUI
 *  emits both echoed user input and streaming model output as ANSI-
 *  formatted bytes; we record the raw bytes (base64-free, just stored
 *  as a string field) so a read-only view after the session ends can
 *  reconstruct the conversation. Periodic flush — every ~3s during
 *  active output — keeps the file growing instead of holding the
 *  whole transcript in RAM. */
export interface OllamaOutputEntry {
  kind: "output";
  ts: string;
  /** Concatenated raw PTY data covering everything emitted since the
   *  last flush. Stored as a UTF-8 string; control sequences are kept
   *  verbatim so the reader can decide whether to strip them. */
  data: string;
}

/** Marker entry written when the session's active model changes
 *  mid-stream. Not emitted today (the spawn path only ever runs one
 *  model per PTY), but the on-disk format reserves it so a future
 *  "switch model and continue" action can mark the cut-over point.
 *  The parser respects it: assistant turns after this marker get
 *  attributed to the new model, earlier turns keep the prior one. */
export interface OllamaModelChangeEntry {
  kind: "model";
  ts: string;
  model: string;
}

/** Structured user/assistant turn written by the daemon's
 *  `/api/ollama/chat` endpoint — the canonical record for
 *  API-driven sessions. One entry per turn, not per chunk; the
 *  endpoint buffers the streamed response and writes the complete
 *  assistant turn on stream completion (or `partial: true` if the
 *  client cancelled mid-stream).
 *
 *  When any `turn` entries exist in a file, the parser uses only
 *  those and ignores `output` chunks (see `parseOllamaJsonl`). */
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

export type OllamaEntry =
  | OllamaHeader
  | OllamaExitEntry
  | OllamaOutputEntry
  | OllamaModelChangeEntry
  | OllamaTurnEntry;

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
    if (termId.includes("/") || termId.includes("\\") || termId.includes("..")) {
      throw new Error(`invalid termId: ${termId}`);
    }
    return join(this.dir, `${termId}.jsonl`);
  }

  /** Serialize an append-to-this-termId through a per-termId promise
   *  chain. Ensures two callers writing to the same file end up with
   *  whole lines in order, not interleaved bytes. */
  private async serialize(termId: string, op: () => Promise<void>): Promise<void> {
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

  /** Append an exit record when the PTY ends. */
  async appendExit(termId: string, entry: OllamaExitEntry): Promise<void> {
    await this.serialize(termId, () =>
      appendFile(this.pathFor(termId), JSON.stringify(entry) + "\n"),
    );
  }

  /** Append a chunk of captured PTY output. Called by the periodic
   *  flush in the spawn handler; not in the hot path of every PTY
   *  byte. The caller is responsible for buffering between flushes. */
  async appendOutput(termId: string, entry: OllamaOutputEntry): Promise<void> {
    await this.serialize(termId, () =>
      appendFile(this.pathFor(termId), JSON.stringify(entry) + "\n"),
    );
  }

  /** Append a structured user/assistant turn. Used by `/api/ollama/chat`
   *  for API-driven sessions — one entry per turn (not per chunk),
   *  written on stream completion or abort. */
  async appendTurn(termId: string, entry: OllamaTurnEntry): Promise<void> {
    await this.serialize(termId, () =>
      appendFile(this.pathFor(termId), JSON.stringify(entry) + "\n"),
    );
  }

  /** Reconstruct the messages[] array for an /api/chat request from
   *  the on-disk transcript. Handles both formats:
   *   - Pure API-driven (turn entries only) — direct mapping.
   *   - Legacy PTY-capture (output entries only) — defers to
   *     `parseOllamaJsonl` to recover turns from the PTY transcript.
   *   - Mixed file — turn entries win (same rule the parser uses),
   *     output chunks are silently dropped.
   *
   *  Returns the model the session is bound to as well, so callers
   *  don't have to read the header separately. Model precedence:
   *  latest turn entry's `model` → most recent `kind: "model"`
   *  marker → header model.
   */
  async readMessagesForChat(
    termId: string,
  ): Promise<{
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
    let sawTurn = false;
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
      } else if (kind === "model" && typeof obj.model === "string") {
        activeModel = obj.model;
      } else if (kind === "turn") {
        const role = obj.role;
        const content = obj.content;
        if ((role === "user" || role === "assistant") && typeof content === "string") {
          sawTurn = true;
          turns.push({ role, content });
          if (typeof obj.model === "string") activeModel = obj.model;
        }
      }
    }
    if (!header) return null;
    if (sawTurn) {
      return { model: activeModel ?? header.model, messages: turns };
    }
    // No structured turns — fall back to the PTY-capture parser.
    // Import lazily to avoid pulling sessions.ts at module load (it
    // has its own dependency surface). Top-level `import` would
    // create a cycle since sessions.ts may import from us in future.
    const { parseOllamaJsonl } = await import("./sessions");
    const parsed = parseOllamaJsonl(raw);
    const ptyTurns: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of parsed.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = m.blocks
        .map((b) => (typeof b.text === "string" ? b.text : ""))
        .join("\n")
        .trim();
      if (!text) continue;
      ptyTurns.push({ role: m.role, content: text });
    }
    return { model: activeModel ?? header.model, messages: ptyTurns };
  }

  /** Read the full transcript: header + every `output` chunk in order,
   *  joined into a single string. Used by the read-only view to
   *  reconstruct the conversation after the session ends.
   *
   *  Returns `null` when the file is missing. Returns an empty `text`
   *  string when no output was ever captured (e.g. the session ended
   *  before the first flush). */
  async readTranscript(termId: string): Promise<
    | { header: OllamaHeader; text: string; exit?: OllamaExitEntry }
    | null
  > {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(termId), "utf-8");
    } catch {
      return null;
    }
    let header: OllamaHeader | null = null;
    let exit: OllamaExitEntry | undefined;
    const chunks: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as OllamaEntry;
        if (obj.kind === "header") {
          // First header wins. Defensive: header validation already
          // happens in `parseHeader`, but we accept here without
          // re-validating since we wrote it ourselves.
          if (!header) header = obj;
        } else if (obj.kind === "output") {
          chunks.push(obj.data);
        } else if (obj.kind === "exit") {
          exit = obj;
        }
      } catch {
        // skip malformed lines
      }
    }
    if (!header) return null;
    return { header, text: chunks.join(""), exit };
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
