/**
 * Tee the daemon's stdout + stderr into `<workspace>/daemon.log` so
 * the running daemon's instrumentation (`[usage] …`, error stacks,
 * startup banners) is always recoverable from disk — no matter how
 * the daemon was launched (electrobun-spawned, `nohup`, `bun dev`,
 * IDE runner). Without this, headless prod runs had logs scattered
 * across whatever shell happened to spawn the daemon.
 *
 *   <workspace>/daemon.log       ← current run, append-mode
 *   <workspace>/daemon.log.prev  ← previous run, rotated at startup
 *
 * A run that exceeds MAX_BYTES while running will NOT be auto-rotated
 * — the rotation only happens at startup. That keeps the open file
 * descriptor stable; deal with mid-run rotation when it actually
 * becomes a problem (a daemon that logs 50 MB / day is fine for now).
 */

import { existsSync } from "node:fs";
import { rename, stat, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
let stream: WriteStream | null = null;

function ts(): string {
  const d = new Date();
  return d.toISOString();
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function writeLine(level: "info" | "warn" | "error", args: unknown[]): void {
  if (!stream) return;
  const line = `${ts()} ${level} ${args.map(formatArg).join(" ")}\n`;
  // Best-effort: if the file descriptor blows up we just stop logging
  // there; the original console still emits to the inherited stream.
  try {
    stream.write(line);
  } catch {
    /* ignore */
  }
}

async function rotateIfLarge(logPath: string): Promise<void> {
  try {
    const st = await stat(logPath);
    if (st.size <= MAX_BYTES) return;
    const prev = `${logPath}.prev`;
    // Best-effort rename — Windows can be flaky here; just keep going.
    await rename(logPath, prev).catch(() => {});
  } catch {
    // Doesn't exist yet — nothing to rotate.
  }
}

/** Open `<workspace>/daemon.log` and tee console.* into it. Safe to
 *  call once at startup; subsequent calls are no-ops. */
export async function initDaemonLog(workspacePath: string): Promise<string> {
  if (stream) return ""; // already initialised
  try {
    if (!existsSync(workspacePath)) {
      await mkdir(workspacePath, { recursive: true }).catch(() => {});
    }
    const logPath = join(workspacePath, "daemon.log");
    await rotateIfLarge(logPath);
    // touch so the file exists even if no writes happen
    if (!existsSync(logPath)) await writeFile(logPath, "");
    stream = createWriteStream(logPath, { flags: "a" });

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.log = (...args: unknown[]) => {
      origLog(...args);
      writeLine("info", args);
    };
    console.warn = (...args: unknown[]) => {
      origWarn(...args);
      writeLine("warn", args);
    };
    console.error = (...args: unknown[]) => {
      origError(...args);
      writeLine("error", args);
    };

    // Banner so a tail of the log makes it obvious which run is current.
    writeLine("info", [
      `--- daemon log opened at ${ts()} (pid=${process.pid}) ---`,
    ]);
    return logPath;
  } catch (e) {
    // Logging is best-effort: if we can't open the file, fall back to
    // console-only. Don't break the daemon over a stat() error.
    return "";
  }
}
