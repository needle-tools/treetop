/**
 * Bun-side PtyBackend that owns one `supergit-supernode` (Node) child
 * process and multiplexes many PTYs through it. The helper is launched
 * lazily on first spawn() and re-launched if it dies.
 *
 * Code outside `terminals/` only ever sees TerminalHandle / TerminalRecord
 * — the helper's wire protocol is private to this file.
 */

import { spawn as bunSpawn, type Subprocess } from "bun";
import { resolve as pathResolve } from "node:path";
import { existsSync, chmodSync, constants as fsConstants } from "node:fs";
import type {
  PtyBackend,
  SpawnOptions,
  TerminalHandle,
  TerminalRecord,
  TerminalSize,
  TerminalSubscriber,
} from "./types";
import { isZshCmd, makeZshZdotdir, cleanupZdotdir } from "./shell-init";

const REPLAY_CAP = 256 * 1024; // 256KB scrollback per terminal

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
  buffer: Uint8Array[];
  bufferBytes: number;
  subs: Set<TerminalSubscriber>;
  spawnedAck?: { resolve: (pid: number) => void; reject: (e: Error) => void };
  awaitingInput: boolean;
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

/** Strip common ANSI/terminal escape sequences from a chunk so the
 *  prompt-pattern regexes can match the plain text. We don't try to
 *  be exhaustive — just enough to neutralize colour codes and cursor
 *  positioning so the words we look for line up. */
function stripAnsi(text: string): string {
  return text
    // CSI sequences (most colours, cursor movement)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // OSC sequences (title, hyperlinks, etc.)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // bare ESC
    .replace(/\x1b/g, "");
}

function isAwaitingInput(buffer: Uint8Array[], bufferBytes: number): boolean {
  // Only look at the tail — prompts always appear at the bottom of the
  // visible terminal area. ~4KB is comfortably larger than any single
  // permission prompt block.
  const tailBytes = Math.min(4096, bufferBytes);
  if (tailBytes === 0) return false;
  const tail = new Uint8Array(tailBytes);
  let offset = 0;
  let remaining = tailBytes;
  for (let i = buffer.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = buffer[i]!;
    const take = Math.min(chunk.byteLength, remaining);
    tail.set(chunk.subarray(chunk.byteLength - take), tailBytes - offset - take);
    offset += take;
    remaining -= take;
  }
  const text = stripAnsi(new TextDecoder("utf-8", { fatal: false }).decode(tail));
  return AWAITING_INPUT_PATTERNS.some((re) => re.test(text));
}

function detectAgent(cmd: string[]): string | undefined {
  const head = cmd[0]?.split(/[\\/]/).pop()?.toLowerCase();
  if (!head) return undefined;
  if (head === "claude") return "claude";
  if (head === "codex") return "codex";
  if (head === "bash" || head === "zsh" || head === "sh" || head === "fish") return "shell";
  return undefined;
}

/** Make sure node-pty's prebuilt spawn-helper has its executable bit.
 *  Bun's package install sometimes strips it (we hit this earlier). The
 *  cost of doing this every time the backend boots is negligible. */
function fixSpawnHelperBit() {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const platform = process.platform === "darwin"
    ? `darwin-${process.arch}`
    : `linux-${process.arch}`;
  const candidates = [
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
      chmodSync(path, fsConstants.S_IRWXU | fsConstants.S_IRGRP | fsConstants.S_IXGRP | fsConstants.S_IROTH | fsConstants.S_IXOTH);
    } catch {
      // best effort
    }
  }
}

export class NodePtyBackend implements PtyBackend {
  private helper: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private helperReady: Promise<void> | null = null;
  private terms = new Map<string, InternalTerm>();
  private nextSeq = 1;
  private stdoutCarry = "";

  private helperPath(): string {
    return pathResolve(import.meta.dir, "helper.mjs");
  }

  private async startHelper(): Promise<void> {
    if (this.helperReady) return this.helperReady;
    fixSpawnHelperBit();
    this.helperReady = new Promise<void>((resolve, reject) => {
      const path = this.helperPath();
      if (!existsSync(path)) {
        reject(new Error(`helper not found at ${path}`));
        return;
      }
      const proc = bunSpawn({
        cmd: ["node", path],
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
        }
        this.helper = null;
        this.helperReady = null;
        if (!acked) reject(new Error(`helper exited before ready (code ${code})`));
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

  private handleEvent(evt: { ev: string; [k: string]: unknown }, onReady: () => void) {
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
        const buf = Uint8Array.from(Buffer.from(evt.dataB64 as string ?? "", "base64"));
        t.lastOutputAt = new Date().toISOString();
        this.appendBuffer(t, buf);
        for (const s of t.subs) s.onData(buf);
        // Recompute awaiting-input state after each output chunk. If
        // the flag flips, notify subscribers so the UI can outline.
        const nextAwaiting = isAwaitingInput(t.buffer, t.bufferBytes);
        if (nextAwaiting !== t.awaitingInput) {
          t.awaitingInput = nextAwaiting;
          for (const s of t.subs) s.onState?.({ awaitingInput: nextAwaiting });
        }
        return;
      }
      case "exit": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        t.exitedAt = new Date().toISOString();
        t.exitCode = (evt.code as number) ?? 0;
        t.exitSignal = evt.signal as string | undefined;
        for (const s of t.subs) s.onExit({ code: t.exitCode!, signal: t.exitSignal });
        if (t.zdotdir) {
          void cleanupZdotdir(t.zdotdir);
          t.zdotdir = undefined;
        }
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
    const stdin = this.helper?.stdin as unknown as { write: (s: string) => unknown } | undefined;
    if (!stdin) throw new Error("helper not running");
    stdin.write(JSON.stringify(obj) + "\n");
  }

  async spawn(opts: SpawnOptions): Promise<TerminalHandle> {
    await this.startHelper();
    const id = `t_${Date.now().toString(36)}_${this.nextSeq++}`;
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
    };
    // For zsh shells, build a temp ZDOTDIR whose .zshrc sources the
    // user's real ~/.zshrc and then forces INC_APPEND_HISTORY /
    // SHARE_HISTORY. Without this, stock-macOS users get arrow-up
    // history that shows nothing (HISTSIZE defaults to 10) and any
    // command typed before the PTY is killed never reaches the
    // histfile. Cleaned up on PTY exit.
    let env: Record<string, string> | undefined = opts.env;
    if (isZshCmd(opts.cmd)) {
      const zdotdir = await makeZshZdotdir();
      t.zdotdir = zdotdir;
      env = { ...(opts.env ?? {}), ZDOTDIR: zdotdir };
    }
    const pidPromise = new Promise<number>((resolve, reject) => {
      t.spawnedAck = { resolve, reject };
    });
    this.terms.set(id, t);
    this.send({
      op: "spawn",
      id,
      cwd: opts.cwd,
      cmd: opts.cmd,
      env,
      cols: opts.size.cols,
      rows: opts.size.rows,
    });
    try {
      t.pid = await pidPromise;
    } catch (e) {
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
      get id() { return t.id; },
      get pid() { return t.pid; },
      write: (data) => {
        const buf = typeof data === "string"
          ? Buffer.from(data, "utf-8")
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        this.send({ op: "write", id: t.id, dataB64: buf.toString("base64") });
        // Any keystroke clears the awaiting-input flag eagerly. The
        // detector will re-arm it on the next matching prompt; this
        // just stops the UI outlining the panel between the user
        // typing and the next render arriving.
        if (t.awaitingInput) {
          t.awaitingInput = false;
          for (const s of t.subs) s.onState?.({ awaitingInput: false });
        }
      },
      resize: (size) => {
        t.size = size;
        this.send({ op: "resize", id: t.id, cols: size.cols, rows: size.rows });
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
        // Deliver current awaiting-input state so a freshly-attached
        // client immediately knows whether to outline the panel.
        sub.onState?.({ awaitingInput: t.awaitingInput });
        if (t.exitedAt) sub.onExit({ code: t.exitCode ?? 0, signal: t.exitSignal });
        return () => { t.subs.delete(sub); };
      },
      subscriberCount: () => t.subs.size,
      isAlive: () => !t.exitedAt,
    };
  }

  get(id: string): TerminalHandle | undefined {
    const t = this.terms.get(id);
    return t ? this.handleFor(t) : undefined;
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
      exitedAt: t.exitedAt,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal,
    }));
  }

  /** Removes a terminated terminal from the in-memory map. Called by the
   *  daemon after dispatching the exit event. */
  forget(id: string) {
    this.terms.delete(id);
  }

  async shutdown() {
    if (this.helper) {
      try { this.helper.kill(); } catch {}
    }
    this.helper = null;
    this.helperReady = null;
    this.terms.clear();
  }
}

/** Module-level singleton. server.ts imports this and re-exports as
 *  the daemon-wide terminal manager. */
export const terminalBackend = new NodePtyBackend();
