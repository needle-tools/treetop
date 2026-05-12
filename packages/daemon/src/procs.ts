/**
 * Sample CPU% and memory for a list of PIDs. Cheap enough for the handful
 * of terminals we manage; we don't pull in pidusage / systeminformation.
 *
 * macOS / Linux: shell out to `ps -o pid=,pcpu=,rss= -p PIDLIST`.
 *   pcpu is "percentage of CPU time" (0-100).
 *   rss  is resident set size, in KB.
 * Windows: not implemented yet; returns zeros so the UI degrades cleanly.
 */

import { $ } from "bun";

/** Single-quote a shell argument robustly. Empty strings are fine; any
 *  single-quote inside the value is escaped as the canonical `'\''`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Wrap `cmd[]` so the resulting PTY's argv[0] becomes `procName`. Uses
 *  bash's `exec -a` so we don't need a wrapper binary. Unix only — on
 *  Windows the caller should pass `cmd` through unchanged. */
export function renameArgv(procName: string, cmd: string[]): string[] {
  if (cmd.length === 0) return cmd;
  const quoted = cmd.map(shQuote).join(" ");
  return ["bash", "-c", `exec -a ${shQuote(procName)} ${quoted}`];
}

export interface ProcUsage {
  pid: number;
  cpuPercent: number;
  memBytes: number;
}

export async function sampleProcs(pids: number[]): Promise<Map<number, ProcUsage>> {
  const out = new Map<number, ProcUsage>();
  if (pids.length === 0) return out;
  if (process.platform === "win32") {
    for (const pid of pids) out.set(pid, { pid, cpuPercent: 0, memBytes: 0 });
    return out;
  }
  const list = pids.join(",");
  try {
    const result = await $`ps -o pid=,pcpu=,rss= -p ${list}`.quiet().nothrow();
    const text = result.stdout.toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const pcpu = Number(parts[1]);
      const rssKb = Number(parts[2]);
      if (!Number.isFinite(pid)) continue;
      out.set(pid, {
        pid,
        cpuPercent: Number.isFinite(pcpu) ? pcpu : 0,
        memBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
      });
    }
  } catch {
    // Best-effort. If ps blows up, return what we have (probably nothing)
    // so the UI just shows zeros instead of an error banner.
  }
  // Fill any PID that didn't come back with zeros — pid may have already
  // exited between the terminalBackend.list() call and our ps invocation.
  for (const pid of pids) {
    if (!out.has(pid)) out.set(pid, { pid, cpuPercent: 0, memBytes: 0 });
  }
  return out;
}
