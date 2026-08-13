import { join } from "node:path";
import {
  appendFile,
  access,
  open as openFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
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
const MAX_TAIL_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const PRUNE_TARGET_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 8 * 1024;
const MAX_STACK_CHARS = 24 * 1024;
const MAX_EXTRA_BYTES = 24 * 1024;
/** Entries older than this are omitted from list() — the UI scopes the
 *  Events popover to "what went wrong recently". Matches the 24h bound
 *  the frontend store enforces in packages/ui/src/errors.ts. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ErrorLogOptions {
  defaultLimit?: number;
  readChunkBytes?: number;
  maxTailScanBytes?: number;
  maxBytes?: number;
  pruneTargetBytes?: number;
  maxEntryBytes?: number;
  maxMessageChars?: number;
  maxStackChars?: number;
  maxExtraBytes?: number;
}

interface NormalizedErrorLogOptions {
  defaultLimit: number;
  readChunkBytes: number;
  maxTailScanBytes: number;
  maxBytes: number;
  pruneTargetBytes: number;
  maxEntryBytes: number;
  maxMessageChars: number;
  maxStackChars: number;
  maxExtraBytes: number;
}

export class ErrorLog {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    public readonly path: string,
    private readonly options: NormalizedErrorLogOptions,
  ) {}

  static async open(
    workspacePath: string,
    options: ErrorLogOptions = {},
  ): Promise<ErrorLog> {
    const path = join(workspacePath, ERRORS_FILE);
    try {
      await access(path);
    } catch {
      await writeFile(path, "");
    }
    const log = new ErrorLog(path, normalizeOptions(options));
    await log.pruneIfNeeded();
    return log;
  }

  async append(input: ErrorEntryInput, id?: string): Promise<ErrorEntry> {
    const entry = this.sanitizeEntry({
      id: id ?? randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    });
    await this.enqueueWrite(async () => {
      await appendFile(this.path, JSON.stringify(entry) + "\n");
      await this.pruneIfNeeded();
    });
    return entry;
  }

  async list(opts: { limit?: number } = {}): Promise<ErrorEntry[]> {
    const limit = clampLimit(opts.limit, this.options.defaultLimit);
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
        scanned < this.options.maxTailScanBytes &&
        entries.length < limit
      ) {
        const length = Math.min(this.options.readChunkBytes, position);
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
    await this.enqueueWrite(async () => {
      await writeFile(this.path, "");
    });
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private collectLine(
    lineBuffer: Buffer,
    cutoff: number,
    entries: ErrorEntry[],
  ): void {
    if (lineBuffer.length === 0) return;
    if (lineBuffer.length > this.options.maxEntryBytes) return;
    try {
      const entry = JSON.parse(lineBuffer.toString("utf-8")) as ErrorEntry;
      const t = Date.parse(entry.timestamp);
      if (Number.isFinite(t) && t < cutoff) return;
      entries.push(entry);
    } catch {
      // skip malformed line — disk corruption or a truncated write
    }
  }

  private sanitizeEntry(entry: ErrorEntry): ErrorEntry {
    let sanitized: ErrorEntry = {
      ...entry,
      message: truncateText(entry.message, this.options.maxMessageChars),
      stack: entry.stack
        ? truncateText(entry.stack, this.options.maxStackChars)
        : undefined,
      extra: sanitizeExtra(entry.extra, this.options.maxExtraBytes),
    };

    while (
      Buffer.byteLength(JSON.stringify(sanitized), "utf8") >
      this.options.maxEntryBytes
    ) {
      const nextMessageLength = Math.max(
        128,
        Math.floor(sanitized.message.length / 2),
      );
      const nextStackLength = sanitized.stack
        ? Math.max(0, Math.floor(sanitized.stack.length / 2))
        : 0;
      sanitized = {
        ...sanitized,
        message: truncateText(sanitized.message, nextMessageLength),
        stack: nextStackLength
          ? truncateText(sanitized.stack ?? "", nextStackLength)
          : undefined,
        extra: sanitized.extra
          ? {
              truncated: true,
              reason: "entry exceeded persisted diagnostics size limit",
            }
          : undefined,
      };
      if (nextMessageLength === 128 && nextStackLength === 0) break;
    }

    return sanitized;
  }

  private async pruneIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return;
    }
    if (size <= this.options.maxBytes) return;

    const keepBytes = Math.min(this.options.pruneTargetBytes, size);
    const file = await openFile(this.path, "r");
    try {
      const buffer = Buffer.alloc(keepBytes);
      await file.read(buffer, 0, keepBytes, size - keepBytes);
      let start = 0;
      if (size > keepBytes) {
        const firstNewline = buffer.indexOf(0x0a);
        start = firstNewline >= 0 ? firstNewline + 1 : buffer.length;
      }
      const kept = buffer.subarray(start);
      const tmpPath = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmpPath, kept);
      await rename(tmpPath, this.path);
    } finally {
      await file.close();
    }
  }
}

function normalizeOptions(options: ErrorLogOptions): NormalizedErrorLogOptions {
  const maxBytes = positiveInteger(options.maxBytes, MAX_FILE_BYTES);
  const maxEntryBytes = positiveInteger(options.maxEntryBytes, MAX_ENTRY_BYTES);
  return {
    defaultLimit: positiveInteger(options.defaultLimit, DEFAULT_LIMIT),
    readChunkBytes: positiveInteger(options.readChunkBytes, READ_CHUNK_BYTES),
    maxTailScanBytes: positiveInteger(
      options.maxTailScanBytes,
      MAX_TAIL_SCAN_BYTES,
    ),
    maxBytes,
    pruneTargetBytes: Math.min(
      positiveInteger(options.pruneTargetBytes, PRUNE_TARGET_BYTES),
      maxBytes,
    ),
    maxEntryBytes,
    maxMessageChars: positiveInteger(options.maxMessageChars, MAX_MESSAGE_CHARS),
    maxStackChars: positiveInteger(options.maxStackChars, MAX_STACK_CHARS),
    maxExtraBytes: Math.min(
      positiveInteger(options.maxExtraBytes, MAX_EXTRA_BYTES),
      maxEntryBytes,
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function clampLimit(value: number | undefined, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return max;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = `… [truncated ${value.length - maxChars} chars]`;
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function sanitizeExtra(
  extra: Record<string, unknown> | undefined,
  maxBytes: number,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const json = safeJson(extra);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return extra;
  return {
    truncated: true,
    originalBytes: bytes,
    preview: json.slice(0, Math.min(2048, maxBytes)),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}
