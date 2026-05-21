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
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Find the best on-disk binary for an agent CLI name.
 *
 * Why this is needed: codex's self-update command is `bun install -g
 * @openai/codex`, which writes to `~/.bun/bin/`. If the user already
 * has codex installed via Homebrew (`/opt/homebrew/bin/codex`), PATH
 * order means the OLDER homebrew copy still wins — so "Update Codex"
 * from inside the TUI installs the new version, but the next spawn
 * re-runs the old one and the update notice appears again forever.
 *
 * Strategy: probe a small list of well-known install prefixes plus
 * everything `which -a <name>` returns, then pick whichever physical
 * file has the most recent mtime (follows symlinks so `~/.bun/bin/`
 * shims pick up their target file's mtime). Falls back to null if
 * nothing's found.
 *
 * Returns absolute paths only — callers should pass to Bun.spawn so
 * PATH ordering is no longer a factor.
 */
export async function resolveAgentBinary(name: string): Promise<string | null> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const home = homedir();
  const wellKnown = [
    join(home, ".bun", "bin", name),
    join(home, ".local", "bin", name),
    "/opt/homebrew/bin/" + name,
    "/usr/local/bin/" + name,
    "/usr/bin/" + name,
  ];
  const all = [...wellKnown];
  // Scan PATH manually — Bun's built-in `which` doesn't support `-a`,
  // so we'd only see the first hit. Walking PATH lets us find every
  // copy of the binary across all install prefixes the user has.
  // Path separator is platform-specific: ";" on Windows, ":" elsewhere.
  const pathSep = process.platform === "win32" ? ";" : ":";
  const pathDirs = (process.env.PATH ?? "").split(pathSep).filter(Boolean);
  for (const dir of pathDirs) {
    all.push(join(dir, name));
  }
  // On Windows, CLI tools are often installed as .exe or .cmd — probe
  // those suffixes in addition to the bare name.
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const p of all) {
    for (const ext of exts) {
      const full = p + ext;
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        await stat(full);
        candidates.push(full);
      } catch {
        // not present
      }
    }
  }
  if (candidates.length === 0) return null;
  // Pick the path with the newest mtime (follows symlinks).
  let best: { path: string; mtimeMs: number } | null = null;
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { path: p, mtimeMs: st.mtimeMs };
      }
    } catch {
      // ignore
    }
  }
  return best?.path ?? candidates[0] ?? null;
}

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
    try {
      // Use PowerShell's Get-Process — available on all modern Windows.
      // CPU: Get-Process returns TotalProcessorTime (TimeSpan); computing a
      // delta over a sample interval is expensive. Instead, use Get-CimInstance
      // Win32_PerfFormattedData_PerfProc_Process which gives an instant %.
      // But matching by PID there is tricky. Simpler: just grab WorkingSet64
      // (private bytes) from Get-Process and skip CPU (leave 0). The UI already
      // handles 0% gracefully — it just hides the CPU badge.
      const pidFilter = pids.map((p) => `$_.Id -eq ${p}`).join(" -or ");
      const ps = `Get-Process | Where-Object { ${pidFilter} } | ForEach-Object { "$($_.Id) $($_.WorkingSet64)" }`;
      const result = await $`powershell -NoProfile -Command ${ps}`.quiet().nothrow();
      const text = result.stdout.toString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const pid = Number(parts[0]);
        const memBytes = Number(parts[1]);
        if (!Number.isFinite(pid)) continue;
        out.set(pid, {
          pid,
          cpuPercent: 0, // not cheaply available; UI degrades to hidden badge
          memBytes: Number.isFinite(memBytes) ? memBytes : 0,
        });
      }
    } catch {
      // best-effort
    }
    for (const pid of pids) {
      if (!out.has(pid)) out.set(pid, { pid, cpuPercent: 0, memBytes: 0 });
    }
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

/**
 * Read the current working directory of each given pid.
 *
 * Used to track where a shell PTY has `cd`-ed to so the dashboard can
 * surface the live cwd and respawn at the same place on restart. macOS
 * doesn't expose `/proc`; `lsof -p <pid> -d cwd -F n` is the portable
 * answer (works on macOS + Linux). Output for two PIDs:
 *
 *   p12345
 *   n/Users/me/git/foo
 *   p67890
 *   n/Users/me/git/bar
 *
 * Each `pN` line names a pid, the next `nPATH` line is that pid's cwd.
 * Pids we can't read (race with exit, permission denied on someone
 * else's process) are silently absent from the result map. Windows:
 * the OS doesn't expose per-process CWD without native API calls
 * (NtQueryInformationProcess); returns an empty map — the UI falls
 * back to the spawnCwd. */
export async function sampleCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (process.platform === "win32") return out;
  const list = pids.join(",");
  try {
    const result = await $`lsof -p ${list} -d cwd -F n`.quiet().nothrow();
    const text = result.stdout.toString();
    let curPid: number | null = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) {
        const pid = Number(line.slice(1));
        curPid = Number.isFinite(pid) ? pid : null;
      } else if (line.startsWith("n") && curPid !== null) {
        out.set(curPid, line.slice(1));
        // Reset — lsof's `n` lines are followed by another `p` for the
        // next pid, but defensively clear so a missing `n` doesn't
        // smear into a later pid's slot.
        curPid = null;
      }
    }
  } catch {
    // best-effort; UI degrades to the spawnCwd
  }
  return out;
}
