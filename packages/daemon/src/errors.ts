import { join } from "node:path";
import { appendFile, readFile, access, writeFile } from "node:fs/promises";
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
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch {
      return [];
    }
    const cutoff = Date.now() - MAX_AGE_MS;
    const entries: ErrorEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as ErrorEntry;
        const t = Date.parse(entry.timestamp);
        if (Number.isFinite(t) && t < cutoff) continue;
        entries.push(entry);
      } catch {
        // skip malformed line — disk corruption or a truncated write
      }
    }
    entries.reverse();
    return entries.slice(0, limit);
  }

  async clear(): Promise<void> {
    await writeFile(this.path, "");
  }
}
