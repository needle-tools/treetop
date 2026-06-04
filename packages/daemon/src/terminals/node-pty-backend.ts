/**
 * Bun-side PtyBackend that owns one `supergit-supernode` (Node) child
 * process and multiplexes many PTYs through it. The helper is launched
 * lazily on first spawn() and re-launched if it dies.
 *
 * Code outside `terminals/` only ever sees TerminalHandle / TerminalRecord
 * — the helper's wire protocol is private to this file.
 */

import { spawn as bunSpawn, type Subprocess } from "bun";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { existsSync, chmodSync, constants as fsConstants } from "node:fs";
import type {
  PtyBackend,
  SpawnOptions,
  TerminalHandle,
  TerminalRecord,
  TerminalSize,
  TerminalSubscriber,
  ExitInfo,
} from "./types";
import { isZshCmd, makeZshZdotdir, cleanupZdotdir } from "./shell-init";
import { wrapWindowsCmd } from "../procs";
import {
  UserBoxRemap,
  CLAUDE_USER_BOX_THEME,
  themeFromRepoColor,
} from "./sgr-remap";

const REPLAY_CAP = 256 * 1024; // 256KB scrollback per terminal
// A PTY is "working" while it has emitted a byte within this window. Matches
// the UI's old client-side threshold so the working→idle edge feels the same
// now that it's computed daemon-side and broadcast on the onState channel.
const WORKING_IDLE_MS = 1500;

interface InternalTerm {
  id: string;
  pid: number;
  ownerId?: string;
  cmd: string[];
  cwd: string;
  agent?: string;
  size: TerminalSize;
  createdAt: string;
  lastOutputAt: string;
  exitedAt?: string;
  exitCode?: number;
  exitSignal?: string;
  lastError?: string;
  buffer: Uint8Array[];
  bufferBytes: number;
  subs: Set<TerminalSubscriber>;
  spawnedAck?: { resolve: (pid: number) => void; reject: (e: Error) => void };
  awaitingInput: boolean;
  configError: { file: string } | null;
    /** True while the PTY is actively emitting output (within WORKING_IDLE_MS).
     *  Broadcast on the onState channel so the dock reflects activity even when
     *  terminal bytes are not painted by the browser. */
  working: boolean;
  /** Timer that lowers `working` after WORKING_IDLE_MS of output silence. */
  workingIdleTimer?: ReturnType<typeof setTimeout>;
  /** When this PTY runs an agent TUI whose user-message box we recolour
   *  (currently Claude), the stateful byte-stream filter that rewrites
   *  the box's truecolour SGR sequences. Undefined for shells and other
   *  agents — their bytes pass through unchanged. */
  remap?: UserBoxRemap;
  /** When this PTY is a zsh shell, the temp ZDOTDIR we built for it
   *  (a `.zshrc` that sources the user's real one then adds history
   *  hardening). Cleaned up on exit. Undefined for non-zsh PTYs. */
  zdotdir?: string;
  /** Subset of the env the helper actually handed to the spawned PTY,
   *  recorded for /api/debug/pty-env. Includes the TERM_PROGRAM /
   *  TERM_SESSION_ID / SHELL_SESSIONS_DISABLE / ZDOTDIR / HISTFILE
   *  values we most often need to diagnose "why does my shell behave
   *  differently than my host terminal" issues. */
  envSnapshot?: Record<string, string | null>;
}

/** Patterns that mean "the agent is paused, waiting for me to press a
 *  key". Conservative on purpose — false positives would constantly
 *  light up columns for no reason. Tested against:
 *    - Claude permission prompts (numbered "1. Allow / 2. ..." with
 *      footer "enter to submit | esc to cancel").
 *    - Codex update prompts (numbered choices ending in
 *      "Press enter to continue").
 *    - Generic shell y/n confirmations. */
const AWAITING_INPUT_PATTERNS: RegExp[] = [
  /enter to submit\s*\|\s*esc to cancel/i,
  /press enter to continue/i,
  /\(y\/n\)\s*[?:]/i,
  /\[Y\/n\]\s*$/m,
  /\[y\/N\]\s*$/m,
];

const CONFIG_ERROR_RE =
  /Configuration Error[\s\S]*?file at\s+(.+?)\s+contains invalid JSON/;

/** Strip common ANSI/terminal escape sequences from a chunk so the
 *  prompt-pattern regexes can match the plain text. We don't try to
 *  be exhaustive — just enough to neutralize colour codes and cursor
 *  positioning so the words we look for line up. */
function stripAnsi(text: string): string {
  return (
    text
      // CSI sequences (most colours, cursor movement)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // OSC sequences (title, hyperlinks, etc.)
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
      // bare ESC
      .replace(/\x1b/g, "")
  );
}

function getTailText(buffer: Uint8Array[], bufferBytes: number): string {
  const tailBytes = Math.min(4096, bufferBytes);
  if (tailBytes === 0) return "";
  const tail = new Uint8Array(tailBytes);
  let offset = 0;
  let remaining = tailBytes;
  for (let i = buffer.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = buffer[i]!;
    const take = Math.min(chunk.byteLength, remaining);
    tail.set(
      chunk.subarray(chunk.byteLength - take),
      tailBytes - offset - take,
    );
    offset += take;
    remaining -= take;
  }
  return stripAnsi(new TextDecoder("utf-8", { fatal: false }).decode(tail));
}

function isAwaitingInput(buffer: Uint8Array[], bufferBytes: number): boolean {
  const text = getTailText(buffer, bufferBytes);
  return text.length > 0 && AWAITING_INPUT_PATTERNS.some((re) => re.test(text));
}

export function detectConfigError(
  buffer: Uint8Array[],
  bufferBytes: number,
): { file: string } | null {
  const text = getTailText(buffer, bufferBytes);
  const m = CONFIG_ERROR_RE.exec(text);
  return m ? { file: m[1]!.trim() } : null;
}

/**
 * Merge a freshly-detected config error with the one we were already
 * showing. The error is STICKY: the `.claude.json` "Configuration Error"
 * dialog is modal and repaints constantly, which scrolls the matched
 * text out of the byte-tail window `detectConfigError` scans. Recomputing
 * from scratch each frame would flip the pill on, then off on the next
 * repaint. So once an error is seen, hold it until something clears it
 * (any keystroke clears it in the PTY `write` path, and a dead PTY is
 * forgotten). A newly detected error — including one naming a different
 * file — always wins.
 */
export function nextStickyConfigError(
  detected: { file: string } | null,
  previous: { file: string } | null,
): { file: string } | null {
  return detected ?? previous;
}

/** Map a PTY's argv[0] to an agent label used by the daemon for
 *  per-agent behavior (shell-transcript persistence, command-history
 *  capture, dashboard pill text). The Windows shell binaries
 *  (`powershell.exe`, `pwsh.exe`, `cmd.exe`) must map to "shell" too —
 *  otherwise on Windows `shells.writeHeader()` never runs, the column
 *  flips to ShellView on exit and shows "shell not found", and the
 *  command transcript stays empty. Exported so the test suite can
 *  exercise it without booting the full daemon (server.ts has top-level
 *  side effects we don't want firing in tests). */
export function detectAgentLabel(cmd0: string | undefined): string | undefined {
  const head = cmd0?.split(/[\\/]/).pop()?.toLowerCase();
  if (!head) return undefined;
  const base = head.endsWith(".exe") ? head.slice(0, -4) : head;
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "ollama") return "ollama";
  if (
    base === "bash" ||
    base === "zsh" ||
    base === "sh" ||
    base === "fish" ||
    base === "powershell" ||
    base === "pwsh" ||
    base === "cmd"
  ) {
    return "shell";
  }
  return undefined;
}

function detectAgent(cmd: string[]): string | undefined {
  return detectAgentLabel(cmd[0]);
}

/** Make sure node-pty's prebuilt spawn-helper has its executable bit.
 *  Bun's package install sometimes strips it (we hit this earlier). The
 *  cost of doing this every time the backend boots is negligible. */
function fixSpawnHelperBit() {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const platform =
    process.platform === "darwin"
      ? `darwin-${process.arch}`
      : `linux-${process.arch}`;
  const candidates = [
    // Compiled binary: prebuilds live next to the executable.
    pathResolve(
      pathDirname(process.execPath),
      "node-pty-prebuilds",
      platform,
      "spawn-helper",
    ),
    pathResolve(
      import.meta.dir,
      "../../../../node_modules/node-pty/prebuilds",
      platform,
      "spawn-helper",
    ),
    pathResolve(
      import.meta.dir,
      "../../node_modules/node-pty/prebuilds",
      platform,
      "spawn-helper",
    ),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      chmodSync(
        path,
        fsConstants.S_IRWXU |
          fsConstants.S_IRGRP |
          fsConstants.S_IXGRP |
          fsConstants.S_IROTH |
          fsConstants.S_IXOTH,
      );
    } catch {
      // best effort
    }
  }
}

/**
 * Mint a terminal id. The time prefix + per-daemon sequence keep it readable
 * and roughly time-ordered; the random suffix makes it GLOBALLY unique across
 * daemons. Each daemon has its own `seq` starting at 1, so `t_<ms>_<seq>`
 * alone could be minted identically by two daemons that spawn a terminal in
 * the same millisecond — and the UI keys per-shell state (manual title
 * `shell:<termId>`, dismissed flag, command-source) by termId, so a remote
 * shell could then collide with a local one in the merged window. The random
 * suffix removes that.
 */
export function makeTerminalId(seq: number): string {
  return `t_${Date.now().toString(36)}_${seq}_${crypto.randomUUID().slice(0, 8)}`;
}

export class NodePtyBackend implements PtyBackend {
  private helper: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private helperReady: Promise<void> | null = null;
  private terms = new Map<string, InternalTerm>();
  /** Exit records for terminals that have been forgotten from `terms`.
   *  Insertion-ordered + bounded so a late WS attach can still report the
   *  exit code instead of a bare "terminal not found". */
  private recentExits = new Map<string, ExitInfo>();
  private nextSeq = 1;
  private stdoutCarry = "";

  private helperCmd(): string[] {
    // Prefer the Go binary (no Node dependency).
    const goBinary =
      process.platform === "win32" ? "pty-helper.exe" : "pty-helper";
    const goCandidates = [
      pathResolve(pathDirname(process.execPath), goBinary),
      pathResolve(import.meta.dir, "helper-go", goBinary),
    ];
    for (const p of goCandidates) {
      if (existsSync(p)) return [p];
    }
    // Fall back to Node + helper.mjs.
    const mjsCandidates = [
      pathResolve(pathDirname(process.execPath), "helper.mjs"),
      pathResolve(import.meta.dir, "helper.mjs"),
    ];
    for (const p of mjsCandidates) {
      if (existsSync(p)) return ["node", p];
    }
    return ["node", pathResolve(import.meta.dir, "helper.mjs")];
  }

  private async startHelper(): Promise<void> {
    if (this.helperReady) return this.helperReady;
    fixSpawnHelperBit();
    this.helperReady = new Promise<void>((resolve, reject) => {
      const cmd = this.helperCmd();
      const path = cmd[cmd.length - 1]!;
      if (!existsSync(path)) {
        reject(new Error(`helper not found at ${path}`));
        return;
      }
      const proc = bunSpawn({
        cmd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      this.helper = proc;

      let acked = false;
      const onReady = () => {
        if (acked) return;
        acked = true;
        resolve();
      };
      void this.pumpStdout(proc.stdout, onReady);

      void proc.exited.then((code) => {
        // Helper died; mark all in-flight terminals as exited and reset.
        for (const t of this.terms.values()) {
          if (!t.exitedAt) {
            t.exitedAt = new Date().toISOString();
            t.exitCode = code ?? 1;
            for (const s of t.subs) s.onExit({ code: code ?? 1 });
          }
          if (t.zdotdir) {
            void cleanupZdotdir(t.zdotdir);
            t.zdotdir = undefined;
          }
          this.scheduleForget(t.id);
        }
        this.helper = null;
        this.helperReady = null;
        if (!acked)
          reject(new Error(`helper exited before ready (code ${code})`));
      });
    });
    return this.helperReady;
  }

  private async pumpStdout(
    stream: ReadableStream<Uint8Array>,
    onReady: () => void,
  ) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      this.stdoutCarry += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = this.stdoutCarry.indexOf("\n")) >= 0) {
        const line = this.stdoutCarry.slice(0, nl);
        this.stdoutCarry = this.stdoutCarry.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          this.handleEvent(evt, onReady);
        } catch {
          // ignore garbage
        }
      }
    }
  }

  private handleEvent(
    evt: { ev: string; [k: string]: unknown },
    onReady: () => void,
  ) {
    switch (evt.ev) {
      case "ready":
        onReady();
        return;
      case "spawned": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        t.pid = evt.pid as number;
        t.spawnedAck?.resolve(t.pid);
        return;
      }
      case "env-snapshot": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        t.envSnapshot = evt.env as Record<string, string | null>;
        return;
      }
      case "data": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        let buf: Uint8Array = Uint8Array.from(
          Buffer.from((evt.dataB64 as string) ?? "", "base64"),
        );
        // Recolour the agent's user-message box (Claude) before it lands
        // in the replay buffer or reaches any client, so the rewrite is
        // applied exactly once and identically for every subscriber.
        if (t.remap) buf = t.remap.transform(buf);
        t.lastOutputAt = new Date().toISOString();
        this.appendBuffer(t, buf);
        for (const s of t.subs) s.onData(buf);
        // "Working" = produced output recently. Raise the flag on every
        // chunk; a timer lowers it after WORKING_IDLE_MS of silence. Both
        // edges go out on the onState channel (below) so the dock tracks
        // hidden agent activity without waiting for the browser column to
        // become visible again.
        const workingFlipped = !t.working;
        t.working = true;
        if (t.workingIdleTimer) clearTimeout(t.workingIdleTimer);
        t.workingIdleTimer = setTimeout(() => {
          t.working = false;
          this.notifyState(t);
        }, WORKING_IDLE_MS);
        // Recompute awaiting-input state after each output chunk. If
        // the flag flips, notify subscribers so the UI can outline.
        const nextAwaiting = isAwaitingInput(t.buffer, t.bufferBytes);
        // Sticky so the pill doesn't flicker off when the modal repaints
        // and scrolls the matched text out of the scanned tail.
        const nextConfigErr = nextStickyConfigError(
          detectConfigError(t.buffer, t.bufferBytes),
          t.configError,
        );
        const configFlipped =
          (nextConfigErr === null) !== (t.configError === null) ||
          nextConfigErr?.file !== t.configError?.file;
        const awaitingFlipped = nextAwaiting !== t.awaitingInput;
        t.awaitingInput = nextAwaiting;
        t.configError = nextConfigErr;
        if (awaitingFlipped || configFlipped || workingFlipped)
          this.notifyState(t);
        return;
      }
      case "exit": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        t.exitedAt = new Date().toISOString();
        t.exitCode = (evt.code as number) ?? 0;
        t.exitSignal = evt.signal as string | undefined;
        if (t.workingIdleTimer) {
          clearTimeout(t.workingIdleTimer);
          t.workingIdleTimer = undefined;
        }
        t.working = false;
        for (const s of t.subs)
          s.onExit({ code: t.exitCode!, signal: t.exitSignal });
        if (t.zdotdir) {
          void cleanupZdotdir(t.zdotdir);
          t.zdotdir = undefined;
        }
        this.scheduleForget(evt.id as string);
        return;
      }
      case "error": {
        const id = evt.id as string | undefined;
        const message = (evt.message as string) ?? "helper error";
        if (id) {
          const t = this.terms.get(id);
          t?.spawnedAck?.reject(new Error(message));
        } else {
          console.error("[pty helper]", message);
        }
        return;
      }
    }
  }

  /** Broadcast the current daemon-detected state (awaiting / config-error /
   *  working) to every subscriber. The single place the onState shape is
   *  built, so the live-flip path, the working-idle timer, and the
   *  subscribe-time snapshot can't drift. */
  private notifyState(t: InternalTerm) {
    for (const s of t.subs)
      s.onState?.({
        awaitingInput: t.awaitingInput,
        configError: t.configError,
        working: t.working,
      });
  }

  private appendBuffer(t: InternalTerm, chunk: Uint8Array) {
    t.buffer.push(chunk);
    t.bufferBytes += chunk.byteLength;
    while (t.bufferBytes > REPLAY_CAP && t.buffer.length > 1) {
      const dropped = t.buffer.shift();
      t.bufferBytes -= dropped?.byteLength ?? 0;
    }
    if (t.bufferBytes > REPLAY_CAP && t.buffer.length === 1) {
      const only = t.buffer[0]!;
      t.buffer[0] = only.subarray(only.byteLength - REPLAY_CAP);
      t.bufferBytes = REPLAY_CAP;
    }
  }

  private send(obj: Record<string, unknown>) {
    const stdin = this.helper?.stdin as unknown as
      | { write: (s: string) => unknown }
      | undefined;
    if (!stdin) throw new Error("helper not running");
    stdin.write(JSON.stringify(obj) + "\n");
  }

  async spawn(opts: SpawnOptions): Promise<TerminalHandle> {
    await this.startHelper();
    const id = makeTerminalId(this.nextSeq++);
    const t: InternalTerm = {
      id,
      pid: 0,
      ownerId: opts.ownerId,
      cmd: opts.cmd,
      cwd: opts.cwd,
      agent: opts.agent ?? detectAgent(opts.cmd),
      size: opts.size,
      createdAt: new Date().toISOString(),
      lastOutputAt: new Date().toISOString(),
      buffer: [],
      bufferBytes: 0,
      subs: new Set(),
      awaitingInput: false,
      configError: null,
      working: false,
    };
    // Claude paints its user-message box with truecolour SGR the xterm
    // theme can't reach (see sgr-remap.ts) — attach a stream filter that
    // recolours it so the user's own turns stand out. When the repo has
    // an accent colour, tint the box with it (auto-contrast text) so the
    // user's turns match the repo's chip; otherwise use the default theme.
    if (t.agent === "claude") {
      t.remap = new UserBoxRemap(
        opts.userBoxColor
          ? themeFromRepoColor(opts.userBoxColor)
          : CLAUDE_USER_BOX_THEME,
      );
    }
    // For zsh shells, build a temp ZDOTDIR whose .zshrc sources the
    // user's real ~/.zshrc and then forces INC_APPEND_HISTORY /
    // SHARE_HISTORY. Without this, stock-macOS users get arrow-up
    // history that shows nothing (HISTSIZE defaults to 10) and any
    // command typed before the PTY is killed never reaches the
    // histfile. Cleaned up on PTY exit.
    let env: Record<string, string> | undefined = opts.env;
    // SUPERGIT_DISABLE_ZSH_HARDENING=1 bypasses our temp-ZDOTDIR wrapper
    // (sources user's rc + appends INC_APPEND_HISTORY/SHARE_HISTORY).
    // Toggle for A/B-ing whether our injection is to blame for input bugs.
    if (
      isZshCmd(opts.cmd) &&
      process.env.SUPERGIT_DISABLE_ZSH_HARDENING !== "1"
    ) {
      const zdotdir = await makeZshZdotdir(opts.historyPreload ?? []);
      t.zdotdir = zdotdir;
      env = { ...(opts.env ?? {}), ZDOTDIR: zdotdir };
    }
    const pidPromise = new Promise<number>((resolve, reject) => {
      t.spawnedAck = { resolve, reject };
    });
    this.terms.set(id, t);
    // On Windows, node-pty's ConPTY backend calls CreateProcess, which
    // only handles PE binaries — wrap `.cmd`/`.bat`/`.ps1` in their
    // respective launchers. We keep `t.cmd` as the *original* (so the
    // dashboard still shows `codex.cmd`, agent detection still labels
    // it `codex`, etc.) and only wrap the cmd we hand to the helper.
    const cmdForHelper =
      process.platform === "win32" ? wrapWindowsCmd(opts.cmd) : opts.cmd;
    this.send({
      op: "spawn",
      id,
      cwd: opts.cwd,
      cmd: cmdForHelper,
      env,
      cols: opts.size.cols,
      rows: opts.size.rows,
    });
    try {
      t.pid = await pidPromise;
    } catch (e) {
      t.exitedAt = new Date().toISOString();
      t.exitCode = 1;
      t.lastError = e instanceof Error ? e.message : String(e);
      this.scheduleForget(id);
      if (t.zdotdir) void cleanupZdotdir(t.zdotdir);
      throw e;
    }
    return this.handleFor(t);
  }

  private concatBuffer(t: InternalTerm): Uint8Array {
    if (t.bufferBytes === 0) return new Uint8Array(0);
    const out = new Uint8Array(t.bufferBytes);
    let off = 0;
    for (const chunk of t.buffer) {
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    return out;
  }

  private handleFor(t: InternalTerm): TerminalHandle {
    return {
      get id() {
        return t.id;
      },
      get pid() {
        return t.pid;
      },
      write: (data) => {
        const buf =
          typeof data === "string"
            ? Buffer.from(data, "utf-8")
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        this.send({ op: "write", id: t.id, dataB64: buf.toString("base64") });
        // Any keystroke clears the awaiting-input flag eagerly. The
        // detector will re-arm it on the next matching prompt; this
        // just stops the UI outlining the panel between the user
        // typing and the next render arriving.
        //
        // configError is deliberately NOT cleared here: the .claude.json
        // "Configuration Error" dialog is modal and stays on screen until
        // the PTY actually exits, so clicking or typing in the TUI must
        // not make the Repair/Open pill vanish while the config is still
        // broken. It clears when the term exits (and the respawned term
        // is fresh).
        if (t.awaitingInput) {
          t.awaitingInput = false;
          for (const s of t.subs)
            s.onState?.({ awaitingInput: false, configError: t.configError });
        }
      },
      resize: (size) => {
        t.size = size;
        this.send({ op: "resize", id: t.id, cols: size.cols, rows: size.rows });
      },
      setOutputMuted: (muted) => {
        this.send({ op: "set-muted", id: t.id, muted });
      },
      kill: async () => {
        this.send({ op: "kill", id: t.id, signal: "SIGTERM" });
        setTimeout(() => {
          if (!t.exitedAt) {
            try {
              this.send({ op: "kill", id: t.id, signal: "SIGKILL" });
            } catch {
              // ignore
            }
          }
        }, 500);
      },
      subscribe: (sub) => {
        t.subs.add(sub);
        // Replay the recent scrollback first so a re-attaching client
        // sees the agent's recent output before live frames stream in.
        if (t.bufferBytes > 0) sub.onData(this.concatBuffer(t));
        // Deliver current state so a freshly-attached client immediately
        // knows whether to outline the panel AND whether a config-error
        // pill is live. Sending configError here is what makes the pill
        // show up in EVERY tui that attaches to a broken session — a
        // reload, or several broken TUIs each mounting after the error
        // already streamed (the live `data` flip only reaches whoever was
        // already subscribed).
        sub.onState?.({
          awaitingInput: t.awaitingInput,
          configError: t.configError,
          working: t.working,
        });
        if (t.exitedAt)
          sub.onExit({ code: t.exitCode ?? 0, signal: t.exitSignal });
        return () => {
          t.subs.delete(sub);
        };
      },
      subscriberCount: () => t.subs.size,
      isAlive: () => !t.exitedAt,
    };
  }

  get(id: string): TerminalHandle | undefined {
    const t = this.terms.get(id);
    return t ? this.handleFor(t) : undefined;
  }

  /** Exit record for a terminal already removed from the live map. */
  getExitInfo(id: string): ExitInfo | undefined {
    return this.recentExits.get(id);
  }

  /** Returns the env snapshot the helper recorded for this PTY (the
   *  set of well-known env keys after the scrub + injection dance).
   *  Used by /api/debug/pty-env to verify what really got through to
   *  the shell. Returns undefined for unknown ids or terminals
   *  spawned before the helper started emitting env-snapshot
   *  (legacy helper running across an upgrade). */
  getEnvSnapshot(id: string): Record<string, string | null> | undefined {
    return this.terms.get(id)?.envSnapshot;
  }

  list(): TerminalRecord[] {
    return [...this.terms.values()].map((t) => ({
      id: t.id,
      ownerId: t.ownerId,
      cmd: t.cmd,
      cwd: t.cwd,
      agent: t.agent,
      pid: t.pid,
      size: t.size,
      createdAt: t.createdAt,
      lastOutputAt: t.lastOutputAt,
      awaitingInput: t.awaitingInput,
      exitedAt: t.exitedAt,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal,
      lastError: t.lastError,
    }));
  }

  /** Removes a terminated terminal from the in-memory map, retaining a
   *  compact exit record so a WS attach arriving after this point can
   *  still report *why* the PTY is gone. */
  forget(id: string) {
    const t = this.terms.get(id);
    if (t?.exitedAt) {
      this.recentExits.set(id, {
        code: t.exitCode,
        signal: t.exitSignal,
        exitedAt: t.exitedAt,
      });
      // Bound the retention map; Map iterates in insertion order so the
      // first key is the oldest.
      while (this.recentExits.size > 200) {
        const oldest = this.recentExits.keys().next().value;
        if (oldest === undefined) break;
        this.recentExits.delete(oldest);
      }
    }
    this.terms.delete(id);
  }

  /** Schedule auto-removal of a dead terminal after a grace period so
   *  the UI has time to read the exit status before it disappears. */
  private scheduleForget(id: string, delayMs = 30_000) {
    setTimeout(() => this.forget(id), delayMs);
  }

  /**
   * Drain live PTYs gracefully before the daemon exits. Sends each live
   * terminal a *soft* kill (SIGTERM on unix; a ConPTY close on Windows,
   * which delivers a CTRL_CLOSE_EVENT so the child can flush) and waits up
   * to `graceMs` for them to exit on their own. Any straggler still alive
   * when the window closes is force-killed (SIGKILL). Finally tears the
   * helper down.
   *
   * This exists so a daemon restart stops hard-killing Claude mid-write to
   * its `.claude.json` (the dominant cause of the corrupt-config dialog on
   * Windows). The startup repair (repairAllClaudeJson) is still the
   * correctness backstop; this just makes the corruption rare instead of
   * routine.
   *
   * TODO(windows-graceful): the graceful soft-kill on Windows only applies
   * under the Go pty-helper (signal_windows.go closes the ConPTY). The
   * `helper.mjs` fallback can't soft-close — node-pty's kill() always
   * TerminateProcess on Windows — and `bun run start` from source resolves
   * to helper.mjs, so prod gets no Windows benefit yet. Follow-up: make
   * prod prefer the Go helper (ship/locate pty-helper.exe so helperCmd()
   * picks it up), and empirically confirm ClosePseudoConsole actually gives
   * Claude time to flush before exit.
   */
  async gracefulShutdown(graceMs = 2000): Promise<void> {
    const live = [...this.terms.values()].filter((t) => !t.exitedAt);
    if (this.helper && live.length > 0) {
      // Resolve as soon as each live term reports its exit. Attach the
      // listener BEFORE sending the signal so we can't miss a fast exit.
      const exited = live.map(
        (t) =>
          new Promise<void>((resolve) => {
            if (t.exitedAt) return resolve();
            t.subs.add({ onData() {}, onExit: () => resolve() });
          }),
      );
      for (const t of live) {
        try {
          this.send({ op: "kill", id: t.id, signal: "SIGTERM" });
        } catch {}
      }
      await Promise.race([
        Promise.all(exited),
        new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
      ]);
      // Anything that ignored the soft signal gets force-terminated.
      const stragglers = [...this.terms.values()].filter((t) => !t.exitedAt);
      for (const t of stragglers) {
        try {
          this.send({ op: "kill", id: t.id, signal: "SIGKILL" });
        } catch {}
      }
      // Give the force-kill a beat to land so exit codes propagate before
      // we close the helper's stdin (which would hard-reap them anyway).
      if (stragglers.length > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    await this.shutdown();
  }

  async shutdown() {
    if (this.helper) {
      try {
        this.helper.kill();
      } catch {}
    }
    this.helper = null;
    this.helperReady = null;
    this.terms.clear();
  }
}

/** WebSocket close reason for a terminal that's no longer in the live
 *  map. When we have a retained exit record, encode the code/signal so the
 *  UI can explain *why* the PTY is gone ("terminal exited code 1");
 *  otherwise fall back to the generic "terminal not found". Kept short — WS
 *  close reasons are capped at ~123 bytes. */
export function terminalGoneReason(exit: ExitInfo | undefined): string {
  if (exit) {
    if (typeof exit.code === "number") {
      return `terminal exited code ${exit.code}`;
    }
    if (exit.signal) return `terminal exited signal ${exit.signal}`;
  }
  return "terminal not found";
}

/** Module-level singleton. server.ts imports this and re-exports as
 *  the daemon-wide terminal manager. */
export const terminalBackend = new NodePtyBackend();
