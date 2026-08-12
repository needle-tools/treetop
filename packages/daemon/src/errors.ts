import { join } from "node:path";
import { appendFile, access, open as openFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type ErrorKind =
  | "server"
  | "fetch"
  | "uncaught"
  | "rejection"
  | "diagnostic";
export type ErrorSource = "daemon" | "browser";

/**
 * A diagnostic record — something went wrong somewhere. We persist these
 * to <workspace>/errors.jsonl so they survive a daemon restart (which is
 * exactly the window a 502-from-portless tends to hit). Browser-side
 * errors are POSTed in via /api/errors so they end up here too.
 */
export interface ErrorEntryInput {
  kind: ErrorKind;
  source: ErrorSource;
  route?: string;
  method?: string;
  status?: number;
  message: string;
  stack?: string;
  /** Free-form per-kind context (e.g., userAgent for browser errors). */
  extra?: Record<string, unknown>;
}

export interface ErrorEntry extends ErrorEntryInput {
  id: string;
  timestamp: string;
}

const ERRORS_FILE = "errors.jsonl";
const DEFAULT_LIMIT = 1000;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_TAIL_SCAN_BYTES = 64 * 1024 * 1024;
/** Entries older than this are omitted from list() — the UI scopes the
 *  Events popover to "what went wrong recently". Matches the 24h bound
 *  the frontend store enforces in packages/ui/src/errors.ts. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class ErrorLog {
  private constructor(public readonly path: string) {}

  static async open(workspacePath: string): Promise<ErrorLog> {
    const path = join(workspacePath, ERRORS_FILE);
    try {
      await access(path);
    } catch {
      await writeFile(path, "");
    }
    return new ErrorLog(path);
  }

  async append(input: ErrorEntryInput, id?: string): Promise<ErrorEntry> {
    const entry: ErrorEntry = {
      id: id ?? randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };
    await appendFile(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  async list(opts: { limit?: number } = {}): Promise<ErrorEntry[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const cutoff = Date.now() - MAX_AGE_MS;
    const entries: ErrorEntry[] = [];
    let file: Awaited<ReturnType<typeof openFile>>;
    try {
      file = await openFile(this.path, "r");
    } catch {
      return [];
    }

    try {
      const { size } = await file.stat();
      let position = size;
      let scanned = 0;
      let carry = Buffer.alloc(0);
      while (
        position > 0 &&
        scanned < MAX_TAIL_SCAN_BYTES &&
        entries.length < limit
      ) {
        const length = Math.min(READ_CHUNK_BYTES, position);
        position -= length;
        scanned += length;
        const chunk = Buffer.alloc(length);
        await file.read(chunk, 0, length, position);
        const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
        const firstNewline = data.indexOf(0x0a);
        const start = position > 0 && firstNewline >= 0 ? firstNewline + 1 : 0;
        carry =
          position > 0
            ? firstNewline >= 0
              ? data.subarray(0, firstNewline)
              : data
            : Buffer.alloc(0);

        let lineEnd = data.length;
        while (lineEnd >= start && entries.length < limit) {
          const previousNewline = data.lastIndexOf(0x0a, lineEnd - 1);
          const lineStart =
            previousNewline >= start ? previousNewline + 1 : start;
          this.collectLine(data.subarray(lineStart, lineEnd), cutoff, entries);
          if (previousNewline < start) break;
          lineEnd = previousNewline;
        }
      }
    } finally {
      await file.close();
    }

    return entries;
  }

  async clear(): Promise<void> {
    await writeFile(this.path, "");
  }

  private collectLine(
    lineBuffer: Buffer,
    cutoff: number,
    entries: ErrorEntry[],
  ): void {
    if (lineBuffer.length === 0) return;
    try {
      const entry = JSON.parse(lineBuffer.toString("utf-8")) as ErrorEntry;
      const t = Date.parse(entry.timestamp);
      if (Number.isFinite(t) && t < cutoff) return;
      entries.push(entry);
    } catch {
      // skip malformed line — disk corruption or a truncated write
    }
  }
}
