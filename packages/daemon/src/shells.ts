/**
 * Per-shell-session JSONL transcripts.
 *
 * When the user opens a "Terminal" column in the dashboard (a `__new__:shell`
 * session), the daemon creates `<workspace>/shells/<termId>.jsonl`. The
 * file starts with a single header line capturing the (termId, worktree,
 * spawnCwd, createdAt) tuple; later steps append more entries:
 *
 *   - `kind: "header"`  one per file, written on spawn.
 *   - `kind: "cwd"`     periodic cwd snapshots from the daemon's pid poll.
 *   - `kind: "cmd"`     Enter-terminated lines captured from the WS.
 *   - `kind: "exit"`    written when the PTY ends.
 *
 * The point of the file existing: it makes the workspace (not the user's
 * browser tab's localStorage) the source of truth for "which shell columns
 * are currently open." On a UI reload we call `GET /api/shells`, get the
 * list of live `Header` records, and reattach each one — no per-browser
 * state required.
 */

import { join } from "node:path";
import {
  appendFile,
  readFile,
  readdir,
  mkdir,
  access,
  stat,
} from "node:fs/promises";

const SHELLS_DIR = "shells";

/** Header entry — one per file, on the first line. */
export interface ShellHeader {
  kind: "header";
  termId: string;
  /** The worktree path the column was opened in. Same as `spawnCwd` for
   *  V1; kept as a separate field because once we track `currentCwd` the
   *  worktree (the row this column belongs to) shouldn't drift even when
   *  the user `cd`-s elsewhere inside the shell. */
  wt: string;
  spawnCwd: string;
  createdAt: string;
}

export interface ShellExitEntry {
  kind: "exit";
  ts: string;
  /** PTY exit code; null when the PTY was killed before exit was observed. */
  code: number | null;
  signal?: string;
}

/** A single Enter-terminated command line captured from the user's
 *  keystrokes. `cwd` is the daemon's latest-known working directory for
 *  this shell at the moment the line was flushed (best-effort; may lag
 *  by up to SHELL_CWD_INTERVAL_MS). */
export interface ShellCmdEntry {
  kind: "cmd";
  ts: string;
  line: string;
  cwd: string;
}

/** Separator written when a Terminal column resumes from a prior shell.
 *  The new file starts with the carry-over: prior file's cmd entries,
 *  then this marker, then the new header. Lets the UI render a visible
 *  "--- resumed from <id> ---" divider between past and current session. */
export interface ShellResumeEntry {
  kind: "resume";
  ts: string;
  fromTermId: string;
}

export type ShellEntry =
  | ShellHeader
  | ShellExitEntry
  | ShellCmdEntry
  | ShellResumeEntry;

/** Read-side projection of a shell record. `alive` reflects whether the
 *  termId is still present in `terminalBackend` at lookup time; the daemon
 *  doesn't write an explicit "alive" field to disk. */
export interface ShellRecord extends ShellHeader {
  alive: boolean;
  /** When known (set by a later cwd-tracking step). Falls back to spawnCwd. */
  currentCwd?: string;
}

/** In-memory cache for cmdSummary() results, keyed by termId. We hit
 *  this on every GET /api/shells (once per shell file) and the dashboard
 *  refreshes it whenever anything mutates — re-parsing each JSONL line
 *  was the dominant cost when a workspace accumulated dozens of past
 *  shells × hundreds of cmd entries each. Invalidation key is
 *  `${mtimeMs}:${size}`: any append to the file bumps both, and a full
 *  rewrite would too. The stat call itself is cheap (~microseconds) vs.
 *  reading and JSON.parse-ing the whole file. */
interface CmdSummaryCacheEntry {
  key: string;
  value: { count: number; lastLine?: string; lastTs?: string };
}

export class ShellsLog {
  private cmdSummaryCache = new Map<string, CmdSummaryCacheEntry>();

  private constructor(public readonly dir: string) {}

  /** Open (and lazily create) `<workspace>/shells/`. Idempotent — call on
   *  daemon start. */
  static async open(workspacePath: string): Promise<ShellsLog> {
    const dir = join(workspacePath, SHELLS_DIR);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
    return new ShellsLog(dir);
  }

  private pathFor(termId: string): string {
    // Defensive: termId comes from our own backend (UUID-shaped); we still
    // refuse anything with a path separator so a malicious caller can't
    // escape the shells/ directory.
    if (termId.includes("/") || termId.includes("\\") || termId.includes("..")) {
      throw new Error(`invalid termId: ${termId}`);
    }
    return join(this.dir, `${termId}.jsonl`);
  }

  /** Write the header line. Called once per shell, on spawn.
   *
   *  When `previousTermId` is provided, the new file is pre-seeded with
   *  the prior session's `cmd` entries (so the user's command history
   *  carries over across a Resume), then a `resume` separator, then the
   *  new header. The prior file is left on disk untouched — keeps
   *  history-of-history if the user ever wants to dig back.
   *
   *  Resume chains: if the prior file ALSO carries entries from its own
   *  predecessor (because it too was a resume), those are already in
   *  the prior file's body and get carried forward, so the chain stays
   *  unbroken across N resumes.
   *
   *  cwd entries are not carried because they'd be misleading — a `cwd`
   *  line from a past shell session doesn't describe the new PTY. */
  async writeHeader(header: ShellHeader, previousTermId?: string): Promise<void> {
    const target = this.pathFor(header.termId);
    if (previousTermId) {
      const carry = await this.collectCarryOver(previousTermId);
      if (carry.length > 0) {
        const body =
          carry.map((e) => JSON.stringify(e)).join("\n") + "\n" +
          JSON.stringify({
            kind: "resume",
            ts: new Date().toISOString(),
            fromTermId: previousTermId,
          } satisfies ShellResumeEntry) + "\n";
        await appendFile(target, body);
      }
    }
    await appendFile(target, JSON.stringify(header) + "\n");
  }

  /** Return only the `cmd` lines from a prior shell's JSONL, in order.
   *  Used to seed the new column's per-shell HISTFILE on Resume so
   *  zsh arrow-up shows the prior session's commands. */
  async getCarryOverCmdLines(prevTermId: string): Promise<string[]> {
    const entries = await this.collectCarryOver(prevTermId);
    return entries.filter((e): e is ShellCmdEntry => e.kind === "cmd").map((e) => e.line);
  }

  /** Read prior file and return entries worth carrying forward on a
   *  resume: only `cmd` lines and prior `resume` separators (so the
   *  ordered chain across N resumes stays intact). Headers and exits
   *  are dropped — header would confuse `readTranscript` (which picks
   *  the first header it sees as "the session's header"), and exit
   *  would make a live resumed shell appear already-exited. */
  private async collectCarryOver(prevTermId: string): Promise<ShellEntry[]> {
    let text: string;
    try {
      text = await readFile(this.pathFor(prevTermId), "utf-8");
    } catch {
      return [];
    }
    const out: ShellEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as ShellEntry;
        if (obj.kind === "cmd" || obj.kind === "resume") {
          out.push(obj);
        }
      } catch {
        // skip malformed lines
      }
    }
    return out;
  }

  /** Append an arbitrary entry to a shell's JSONL. */
  async append(termId: string, entry: ShellEntry): Promise<void> {
    await appendFile(this.pathFor(termId), JSON.stringify(entry) + "\n");
  }

  /** Read the header line of a single shell file. Returns null if the file
   *  is missing or the first line doesn't parse as a header. */
  async readHeader(termId: string): Promise<ShellHeader | null> {
    let text: string;
    try {
      text = await readFile(this.pathFor(termId), "utf-8");
    } catch {
      return null;
    }
    const firstLine = text.split("\n", 1)[0];
    if (!firstLine) return null;
    try {
      const obj = JSON.parse(firstLine) as Partial<ShellHeader>;
      if (
        obj.kind === "header" &&
        typeof obj.termId === "string" &&
        typeof obj.wt === "string" &&
        typeof obj.spawnCwd === "string" &&
        typeof obj.createdAt === "string"
      ) {
        return obj as ShellHeader;
      }
    } catch {
      // bad line — skip
    }
    return null;
  }

  /** Enumerate every shell file under `<workspace>/shells/`, returning the
   *  parsed header for each. Files whose first line isn't a valid header
   *  are silently skipped (covers truncation / corruption). */
  async listHeaders(): Promise<ShellHeader[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: ShellHeader[] = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const termId = name.slice(0, -".jsonl".length);
      const h = await this.readHeader(termId);
      if (h) out.push(h);
    }
    return out;
  }

  /** Summarise the `kind: "cmd"` entries of a shell's JSONL in a single
   *  file read: total count plus the latest captured line and its
   *  timestamp. The picker uses this to filter out "saved with no
   *  commands" shells (count === 0) and to render the most recent
   *  command inline under each surviving shell row. Returns
   *  `{ count: 0 }` when the file is missing or unreadable. */
  async cmdSummary(termId: string): Promise<{
    count: number;
    lastLine?: string;
    lastTs?: string;
  }> {
    const path = this.pathFor(termId);
    let key: string | null = null;
    try {
      const st = await stat(path);
      key = `${st.mtimeMs}:${st.size}`;
      const cached = this.cmdSummaryCache.get(termId);
      if (cached && cached.key === key) return cached.value;
    } catch {
      // file missing — drop any stale cache entry and return empty.
      this.cmdSummaryCache.delete(termId);
      return { count: 0 };
    }
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      this.cmdSummaryCache.delete(termId);
      return { count: 0 };
    }
    let count = 0;
    let lastLine: string | undefined;
    let lastTs: string | undefined;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as {
          kind?: unknown;
          line?: unknown;
          ts?: unknown;
        };
        if (obj.kind !== "cmd") continue;
        count++;
        if (typeof obj.line === "string") lastLine = obj.line;
        if (typeof obj.ts === "string") lastTs = obj.ts;
      } catch {
        // skip malformed
      }
    }
    const value = { count, lastLine, lastTs };
    if (key !== null) this.cmdSummaryCache.set(termId, { key, value });
    return value;
  }

  /** Read the full transcript of a shell: header, every command, and the
   *  exit entry if the PTY has ended. Returns null when the file is
   *  missing or the header line is invalid (we treat that as "no real
   *  transcript"; the read-mode view doesn't surface those). */
  async readTranscript(termId: string): Promise<{
    header: ShellHeader;
    cmds: ShellCmdEntry[];
    exit: ShellExitEntry | null;
    /** Most recent `cwd` from any cmd entry, falling back to spawnCwd.
     *  Used by the UI's "Resume" button to spawn the new shell where the
     *  user actually left off, not where the PTY originally started. */
    lastCwd: string;
  } | null> {
    let text: string;
    try {
      text = await readFile(this.pathFor(termId), "utf-8");
    } catch {
      return null;
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    let header: ShellHeader | null = null;
    const cmds: ShellCmdEntry[] = [];
    let exit: ShellExitEntry | null = null;
    for (const line of lines) {
      let obj: { kind?: unknown };
      try {
        obj = JSON.parse(line) as { kind?: unknown };
      } catch {
        continue;
      }
      if (obj.kind === "header" && header === null) {
        header = obj as ShellHeader;
      } else if (obj.kind === "cmd") {
        cmds.push(obj as ShellCmdEntry);
      } else if (obj.kind === "exit") {
        exit = obj as ShellExitEntry;
      }
    }
    if (!header) return null;
    const lastCwd = cmds.length > 0
      ? (cmds[cmds.length - 1]!.cwd || header.spawnCwd)
      : header.spawnCwd;
    return { header, cmds, exit, lastCwd };
  }
}
