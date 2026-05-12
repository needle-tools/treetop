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
  exitedAt?: string;
  exitCode?: number;
  exitSignal?: string;
  buffer: Uint8Array[];
  bufferBytes: number;
  subs: Set<TerminalSubscriber>;
  spawnedAck?: { resolve: (pid: number) => void; reject: (e: Error) => void };
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
      case "data": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        const buf = Uint8Array.from(Buffer.from(evt.dataB64 as string ?? "", "base64"));
        this.appendBuffer(t, buf);
        for (const s of t.subs) s.onData(buf);
        return;
      }
      case "exit": {
        const t = this.terms.get(evt.id as string);
        if (!t) return;
        t.exitedAt = new Date().toISOString();
        t.exitCode = (evt.code as number) ?? 0;
        t.exitSignal = evt.signal as string | undefined;
        for (const s of t.subs) s.onExit({ code: t.exitCode!, signal: t.exitSignal });
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
      agent: detectAgent(opts.cmd),
      size: opts.size,
      createdAt: new Date().toISOString(),
      buffer: [],
      bufferBytes: 0,
      subs: new Set(),
    };
    const pidPromise = new Promise<number>((resolve, reject) => {
      t.spawnedAck = { resolve, reject };
    });
    this.terms.set(id, t);
    this.send({
      op: "spawn",
      id,
      cwd: opts.cwd,
      cmd: opts.cmd,
      env: opts.env,
      cols: opts.size.cols,
      rows: opts.size.rows,
    });
    t.pid = await pidPromise;
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
