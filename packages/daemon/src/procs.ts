/**
 * Sample CPU% and memory for a list of PIDs. Cheap enough for the handful
 * of terminals we manage; we don't pull in pidusage / systeminformation.
 *
 * macOS / Linux: shell out to `ps -o pid=,pcpu=,rss= -p PIDLIST`.
 *   pcpu is "percentage of a single CPU core" — it can exceed 100 (200 =
 *   two pegged cores). rss is resident set size, in KB.
 * Windows: PowerShell — Get-Process for WorkingSet64 + Win32_PerfFormatted
 *   Data_PerfProc_Process for PercentProcessorTime, joined by PID. That
 *   counter is ALSO per-core (summed across logical processors, max
 *   100 * coreCount) — Windows does NOT normalise it for us.
 *
 * Both sources are run through `normalizeCpuPercent` so the value we hand
 * the UI is machine-relative (0-100), matching Task Manager / Activity
 * Monitor's per-process column.
 */

import { $ } from "bun";
import { stat, readdir } from "node:fs/promises";
import { homedir, cpus } from "node:os";
import { join } from "node:path";

/** Absolute path to cmd.exe — see open.ts for why bare "cmd" breaks. */
const CMD_EXE = process.env.COMSPEC ?? "cmd.exe";

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
  // nvm / fnm / volta / n — node version managers install global npm
  // packages under their own prefix which may not be in the daemon's
  // PATH (e.g. when launched via launchd / nohup without sourcing
  // .zshrc). Probe the most common layouts.
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  try {
    const nvmVersions = await readdir(join(nvmDir, "versions", "node")).catch(
      () => [],
    );
    for (const v of nvmVersions) {
      wellKnown.push(join(nvmDir, "versions", "node", v, "bin", name));
    }
  } catch {
    /* nvm not installed */
  }
  // fnm
  try {
    const fnmDir = process.env.FNM_DIR || join(home, ".fnm");
    const fnmVersions = await readdir(join(fnmDir, "node-versions")).catch(
      () => [],
    );
    for (const v of fnmVersions) {
      wellKnown.push(
        join(fnmDir, "node-versions", v, "installation", "bin", name),
      );
    }
  } catch {
    /* fnm not installed */
  }
  // volta
  wellKnown.push(join(home, ".volta", "bin", name));
  // n (tj/n)
  wellKnown.push(join(home, "n", "bin", name));
  // npm global (default prefix)
  wellKnown.push(join(home, ".npm-global", "bin", name));
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
  // On Windows, CLI tools are installed as one of .exe / .cmd / .bat /
  // .ps1. CreateProcess (which node-pty's ConPTY backend uses) can ONLY
  // execute PE binaries — handing it a bare bash script or a .ps1 file
  // produces ERROR_BAD_EXE_FORMAT (193). npm installs codex/claude as
  // four sibling files in the same dir — a bare bash script, .cmd,
  // .ps1, and (sometimes) .exe — all sharing one mtime. If we left the
  // bare extension in the candidate set, mtime ties would pick the
  // bash script and every TUI spawn would die at error 193. Probing
  // only the spawnable extensions sidesteps that entirely.
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1"] : [""];
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

/** Wrap a Windows command so node-pty's ConPTY backend can spawn it.
 *
 *  CreateProcess (which ConPTY ultimately calls) can only execute PE
 *  binaries. A `.cmd`/`.bat` needs `cmd.exe /c`, and a `.ps1` needs
 *  `powershell.exe -File`. Without this wrap, `codex.cmd` (npm's
 *  global install of the codex CLI) blows up with
 *  `spawn failed: Cannot create process, error code: 193`
 *  (ERROR_BAD_EXE_FORMAT) the moment a user clicks "new TUI" on
 *  Windows.
 *
 *  Pure function — does NOT check `process.platform`. Callers apply
 *  it only on Windows. Returns the input array unchanged for `.exe`,
 *  extensionless commands, or an empty cmd, so it's safe to call
 *  blindly when the caller has already gated on platform.
 *
 *  Why /d /s /c:
 *  - /d: skip per-user AutoRun — avoids dragging registry-configured
 *    cmd hooks into the TUI session.
 *  - /s: makes cmd's quote-stripping rules predictable when the path
 *    after /c is itself quoted (paths with spaces, e.g.
 *    `C:\Users\Joe Bloggs\AppData\Roaming\npm\codex.cmd`).
 *  - /c: run the command and exit, so PTY lifetime tracks the CLI.
 */
export function wrapWindowsCmd(cmd: string[]): string[] {
  if (cmd.length === 0) return cmd;
  const head = cmd[0]!;
  const dot = head.lastIndexOf(".");
  const ext = dot >= 0 ? head.slice(dot).toLowerCase() : "";
  if (ext === ".cmd" || ext === ".bat") {
    return [CMD_EXE, "/d", "/s", "/c", head, ...cmd.slice(1)];
  }
  if (ext === ".ps1") {
    return [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      head,
      ...cmd.slice(1),
    ];
  }
  return cmd;
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

export interface ExternalProc {
  pid: number;
  comm: string;
  args: string;
  cwd: string;
  cpuPercent: number;
  memBytes: number;
}

/** Logical-processor count (counts SMT / hyperthreads), read once at module
 *  load — it doesn't change at runtime. Floored at 1 so we never divide by
 *  zero on an exotic host. */
const LOGICAL_CPU_COUNT = Math.max(1, cpus().length);

/**
 * Convert a per-process CPU reading into a machine-relative percentage
 * (0-100), matching what Task Manager / Activity Monitor show.
 *
 * Both data sources report "% of a SINGLE core": `ps -o pcpu` and Windows'
 * `Win32_PerfFormattedData_PerfProc_Process.PercentProcessorTime` sum CPU
 * time across all logical processors, so a process pegging two cores reads
 * 200 and the ceiling is 100 * coreCount — NOT 0-100. Dividing by the
 * logical-processor count gives the whole-machine fraction the dashboard's
 * CPU column means to show.
 */
export function normalizeCpuPercent(perCore: number, cpuCount: number): number {
  if (!Number.isFinite(perCore) || perCore <= 0) return 0;
  if (!Number.isFinite(cpuCount) || cpuCount < 1) return perCore;
  return perCore / cpuCount;
}

/**
 * Wrap an expensive async producer so calls within `ttlMs` of the last
 * successful run reuse its cached value instead of re-running, and
 * concurrent callers share a single in-flight run. A rejected run is not
 * cached — the next call retries. Injected `clock` keeps it testable.
 *
 * Used to stop the /api/processes external-process scan (a full-machine
 * process enumeration plus a `git worktree list` per repo) from running on
 * every fast UI poll: the repo-resident process set changes far more slowly
 * than the panel's poll cadence.
 */
export function throttleAsync<T>(
  producer: () => Promise<T>,
  ttlMs: number,
  clock: () => number = Date.now,
): () => Promise<T> {
  let last = 0;
  let hasValue = false;
  let cache: T;
  let inflight: Promise<T> | null = null;
  return () => {
    const now = clock();
    if (hasValue && now - last < ttlMs) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = producer().then(
      (v) => {
        cache = v;
        hasValue = true;
        last = clock();
        inflight = null;
        return v;
      },
      (e) => {
        inflight = null;
        throw e;
      },
    );
    return inflight;
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export async function discoverRepoProcesses(
  repoPaths: string[],
  excludePids: Set<number>,
): Promise<ExternalProc[]> {
  if (repoPaths.length === 0) return [];
  if (process.platform === "win32") {
    return discoverRepoProcessesWindows(repoPaths, excludePids);
  }
  const allCwds = await allProcessCwds();
  const matched: { pid: number; cwd: string }[] = [];
  for (const [pid, cwd] of allCwds) {
    if (excludePids.has(pid)) continue;
    if (repoPaths.some((rp) => cwd === rp || cwd.startsWith(rp + "/"))) {
      matched.push({ pid, cwd });
    }
  }
  if (matched.length === 0) return [];
  const pids = matched.map((m) => m.pid);
  const list = pids.join(",");
  const info = new Map<
    number,
    { comm: string; args: string; cpu: number; mem: number }
  >();
  try {
    const result = await $`ps -o pid=,pcpu=,rss=,args= -p ${list}`
      .quiet()
      .nothrow();
    for (const line of result.stdout.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!Number.isFinite(pid)) continue;
      const args = m[4]!;
      const comm =
        args.split(/\s/)[0]!.split("/").pop() || args.split(/\s/)[0]!;
      info.set(pid, {
        comm,
        args,
        cpu: normalizeCpuPercent(Number(m[2]) || 0, LOGICAL_CPU_COUNT),
        mem: (Number(m[3]) || 0) * 1024,
      });
    }
  } catch {
    /* best-effort */
  }
  return matched
    .filter((m) => info.has(m.pid))
    .map((m) => {
      const i = info.get(m.pid)!;
      return {
        pid: m.pid,
        comm: i.comm,
        args: i.args,
        cwd: m.cwd,
        cpuPercent: i.cpu,
        memBytes: i.mem,
      };
    });
}

/**
 * Windows external-process discovery.
 *
 * Windows doesn't expose per-process CWD via standard tooling (the value
 * lives in the PEB and reading it needs NtQueryInformationProcess +
 * cross-process memory reads — admin-only in many configs). We approximate
 * "in this repo" by matching against the process's CommandLine and
 * ExecutablePath via WMI (Win32_Process). For dev work this catches
 * most of what you'd actually want: `node C:\…\repo\script.js`, vite
 * children of npm scripts, cargo/python with script paths, etc.
 *
 * It misses processes whose cmdline doesn't reference the repo path
 * (e.g. a `node` REPL launched from inside the repo dir). That's a
 * documented limitation, not a bug — fixing it requires PInvoke into
 * NtQueryInformationProcess from PowerShell, which is heavy.
 *
 * Output format from PowerShell uses RS (\x1e) as delimiter so command
 * lines containing `|` or `\t` parse cleanly.
 */
async function discoverRepoProcessesWindows(
  repoPaths: string[],
  excludePids: Set<number>,
): Promise<ExternalProc[]> {
  const RS = "";
  const escapedPaths = repoPaths.map((p) =>
    p.replace(/`/g, "``").replace(/'/g, "''"),
  );
  const pathsLiteral = `@(${escapedPaths.map((p) => `'${p}'`).join(",")})`;
  const ps =
    `$ErrorActionPreference='SilentlyContinue';` +
    `$rp = ${pathsLiteral};` +
    `Get-CimInstance Win32_Process | ForEach-Object {` +
    ` $p = $_;` +
    ` $cmd = if ($p.CommandLine) { $p.CommandLine } else { '' };` +
    ` $exe = if ($p.ExecutablePath) { $p.ExecutablePath } else { '' };` +
    ` $hit = $null;` +
    ` foreach ($r in $rp) {` +
    `   if ($cmd -and $cmd.IndexOf($r,[System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $r; break }` +
    `   if ($exe -and $exe.StartsWith($r,[System.StringComparison]::OrdinalIgnoreCase)) { $hit = $r; break }` +
    ` };` +
    ` if (-not $hit) { return };` +
    `"$($p.ProcessId)$hit$exe$cmd"` +
    `}`;
  const matches: { pid: number; cwd: string; exe: string; args: string }[] = [];
  try {
    const result = await $`powershell -NoProfile -Command ${ps}`
      .quiet()
      .nothrow();
    for (const line of result.stdout.toString().split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split(RS);
      if (parts.length < 4) continue;
      const pid = Number(parts[0]);
      if (!Number.isFinite(pid) || excludePids.has(pid)) continue;
      matches.push({
        pid,
        cwd: parts[1]!,
        exe: parts[2]!,
        args: parts.slice(3).join(RS).trim(),
      });
    }
  } catch {
    /* best-effort */
  }
  if (matches.length === 0) return [];
  const samples = await sampleProcs(matches.map((m) => m.pid));
  return matches.map((m) => {
    const s = samples.get(m.pid);
    const comm =
      m.exe.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "") ||
      m.args.split(/\s/)[0] ||
      "process";
    return {
      pid: m.pid,
      comm,
      args: m.args || m.exe,
      cwd: m.cwd,
      cpuPercent: s?.cpuPercent ?? 0,
      memBytes: s?.memBytes ?? 0,
    };
  });
}

async function allProcessCwds(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (process.platform === "win32") return out;
  try {
    const result = await $`lsof -d cwd -Fn`.quiet().nothrow();
    const text = result.stdout.toString();
    let curPid: number | null = null;
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) {
        const pid = Number(line.slice(1));
        curPid = Number.isFinite(pid) ? pid : null;
      } else if (line.startsWith("n") && curPid !== null) {
        out.set(curPid, line.slice(1));
        curPid = null;
      }
    }
  } catch {
    /* best-effort */
  }
  return out;
}

export async function sampleProcs(
  pids: number[],
): Promise<Map<number, ProcUsage>> {
  const out = new Map<number, ProcUsage>();
  if (pids.length === 0) return out;
  if (process.platform === "win32") {
    try {
      // Memory + CPU in one PowerShell pass. Memory comes from Get-Process
      // (WorkingSet64 = private bytes). CPU comes from Win32_PerfFormattedData
      // _PerfProc_Process.PercentProcessorTime, which is per-core (summed
      // across logical processors, so it can read up to 100 * coreCount —
      // Windows does NOT normalise it). We join the two by PID, emit
      // "pid mem cpu" per line, and divide cpu by the core count below via
      // normalizeCpuPercent. Falls back to mem-only if perf counters fail.
      const pidArr = `@(${pids.join(",")})`;
      const ps =
        `$m = @{}; Get-Process -Id ${pidArr} -ErrorAction SilentlyContinue | ForEach-Object { $m[$_.Id] = $_.WorkingSet64 }; ` +
        `$c = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue | Where-Object { $m.ContainsKey([int]$_.IDProcess) } | ForEach-Object { $c[[int]$_.IDProcess] = $_.PercentProcessorTime }; ` +
        // NB: the loop variable is `$procId`, NOT `$pid`. `$PID` is a
        // read-only automatic variable in PowerShell (case-insensitive),
        // so `foreach ($pid in …)` throws "Cannot overwrite variable PID
        // because it is read-only or constant", aborting the whole script
        // block → no output → every pid fell back to zeros (no CPU/mem on
        // Windows).
        `foreach ($procId in $m.Keys) { $cpu = if ($c.ContainsKey($procId)) { $c[$procId] } else { 0 }; "$procId $($m[$procId]) $cpu" }`;
      const result = await $`powershell -NoProfile -Command ${ps}`
        .quiet()
        .nothrow();
      const text = result.stdout.toString();
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const memBytes = Number(parts[1]);
        const cpuPercent = Number(parts[2]);
        if (!Number.isFinite(pid)) continue;
        out.set(pid, {
          pid,
          cpuPercent: normalizeCpuPercent(cpuPercent, LOGICAL_CPU_COUNT),
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
        cpuPercent: normalizeCpuPercent(pcpu, LOGICAL_CPU_COUNT),
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
