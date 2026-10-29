import type {
  PtyBackend,
  SpawnOptions,
  TerminalHandle,
  TerminalRecord,
  TerminalSubscriber,
  ExitInfo,
} from "./types";
import { DecPrivateModeTracker } from "../dec-private-modes";
import { BROKER_PROTOCOL } from "../background-protocol";

/** Copy only new output; materialize chronological scrollback on subscription. */
export class TerminalReplayBuffer {
  private bytes: Uint8Array;
  private end = 0;
  private length = 0;
  constructor(private capacity = 256 * 1024) {
    this.bytes = new Uint8Array(capacity);
  }
  append(input: Uint8Array): void {
    const data = input.length > this.capacity ? input.subarray(-this.capacity) : input;
    const first = Math.min(data.length, this.capacity - this.end);
    this.bytes.set(data.subarray(0, first), this.end);
    this.bytes.set(data.subarray(first), 0);
    this.end = (this.end + data.length) % this.capacity;
    this.length = Math.min(this.capacity, this.length + data.length);
  }
  clear(): void { this.end = 0; this.length = 0; }
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.length);
    const start = (this.end - this.length + this.capacity) % this.capacity;
    const first = Math.min(this.length, this.capacity - start);
    out.set(this.bytes.subarray(start, start + first));
    out.set(this.bytes.subarray(0, this.length - first), first);
    return out;
  }
}

interface CachedTerminal {
  record: TerminalRecord;
  buffer: TerminalReplayBuffer;
  modes: DecPrivateModeTracker;
  state: any;
  revision: number;
  env?: Record<string, string | null>;
  subscribers: Set<TerminalSubscriber>;
}

class BrokerReplayInterruptedError extends Error {}

/** Detaching a daemon only closes this transport. The broker owns the PTYs. */
export class BrokerBackend implements PtyBackend {
  readonly persistent = true;
  private socket: WebSocket | undefined;
  private ready = false;
  private disposed = false;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private terminals = new Map<string, CachedTerminal>();
  private interrupted = new Set<(ownerId: string) => void>();
  private changes = new Set<(change: any) => void>();
  private nativeListeners = new Set<(value: any) => void>();
  private nativeSnapshot: any = { kind: "state", activeTurns: [], events: [] };
  private running: any[] = [];
  private untracked: any[] = [];
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private lastStatus: any = {};
  private operationLocks = new Set<string>();
  private viewerCounts = new Map<string, number>();
  private log: (event: string) => void;
  readonly projectCommands = {
    list: () => this.running.map((record) => ({ ...record })),
    untracked: () => this.untracked.map((record) => ({ ...record })),
    control: async (
      action: "start" | "stop" | "restart",
      repoId: string,
      commandId: string,
      repoPath?: string,
      onReady?: (result: Record<string, unknown>) => Promise<void>,
    ) => {
      const key = `${repoId}\0${commandId}`;
      if (this.operationLocks.has(key))
        throw new Error("Command operation already in progress");
      this.operationLocks.add(key);
      try {
        const result = await this.request("command", {
          action,
          repoId,
          commandId,
          repoPath,
        });
        if (action !== "stop") await onReady?.(result);
        return result;
      } finally {
        this.operationLocks.delete(key);
      }
    },
  };
  private constructor(
    private url: string,
    private token: string,
    log?: (event: string) => void,
  ) {
    this.log = log ?? ((message) => console.log(`terminal broker: ${message}`));
  }
  static async connect(
    url: string,
    token: string,
    log?: (event: string) => void,
  ) {
    const backend = new BrokerBackend(url, token, log);
    try {
      await backend.open();
    } catch (error) {
      if (!(error instanceof BrokerReplayInterruptedError)) {
        await backend.shutdown();
        throw error;
      }
      // Older live brokers can close during replay. Keep the HTTP daemon
      // available and let the scheduled reconnect run; never replace the
      // broker or its PTYs just because its initial replay was interrupted.
      backend.log("initial replay interrupted; sessions retained while reconnecting");
    }
    return backend;
  }
  private async open() {
    this.disposed = false;
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        ws.close();
        rejectReady(new Error("Broker connection timed out"));
      }, 10_000);
      const ws = new WebSocket(
        this.url.replace(/^http/, "ws") +
          "/io?token=" +
          encodeURIComponent(this.token),
      );
      this.socket = ws;
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (typeof message.reply === "number") {
            const pending = this.pending.get(message.reply);
            if (!pending) return;
            this.pending.delete(message.reply);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.value);
            return;
          }
          if (message.event === "hello") {
            if (message.protocol !== BROKER_PROTOCOL) {
              clearTimeout(timeout);
              this.disposed = true;
              rejectReady(
                new Error(
                  "Broker protocol is incompatible; live sessions were left untouched",
                ),
              );
              ws.close();
              return;
            }
            const present = new Set(message.recordIds);
            for (const [id, terminal] of this.terminals)
              if (present.has(id)) {
                terminal.buffer.clear();
                terminal.modes = new DecPrivateModeTracker();
                for (const sub of terminal.subscribers)
                  sub.onData(new TextEncoder().encode("\x1bc"));
              }
            for (const [id, terminal] of this.terminals)
              if (!present.has(id)) {
                if (!terminal.record.exitedAt)
                  for (const sub of terminal.subscribers)
                    sub.onExit({ code: 1 });
                this.terminals.delete(id);
              }
            this.running = message.running;
            this.untracked = message.untracked;
            if (message.native) {
              this.nativeSnapshot = message.native;
              for (const listener of this.nativeListeners)
                listener(message.native);
            }
          } else if (message.event === "native") {
            for (const listener of this.nativeListeners)
              listener(message.value);
          } else if (message.event === "record") {
            const previous = this.terminals.get(message.record.id);
            if (previous) {
              previous.record = message.record;
              previous.revision = Math.max(
                previous.revision,
                message.revision ?? 0,
              );
            } else
              this.terminals.set(message.record.id, {
                record: message.record,
                buffer: new TerminalReplayBuffer(),
                modes: new DecPrivateModeTracker(),
                state: { working: false, awaitingInput: false },
                revision: message.revision ?? 0,
                env: message.env,
                subscribers: new Set(),
              });
          } else if (message.event === "data") {
            const terminal = this.terminals.get(message.id);
            if (!terminal) return;
            const bytes = new Uint8Array(Buffer.from(message.data, "base64"));
            terminal.buffer.append(bytes);
            terminal.modes.observe(bytes);
            terminal.record.lastOutputAt = message.at;
            for (const sub of terminal.subscribers) sub.onData(bytes);
          } else if (message.event === "state") {
            const terminal = this.terminals.get(message.id);
            if (terminal) {
              terminal.state = message.state;
              for (const sub of terminal.subscribers)
                sub.onState?.(message.state);
            }
          } else if (message.event === "revision") {
            const terminal = this.terminals.get(message.id);
            if (terminal)
              terminal.revision = Math.max(terminal.revision, message.revision);
          } else if (message.event === "exit") {
            const terminal = this.terminals.get(message.id);
            if (terminal) {
              terminal.record = {
                ...terminal.record,
                exitedAt: new Date().toISOString(),
                exitCode: message.exit.code,
                exitSignal: message.exit.signal,
              };
              for (const sub of terminal.subscribers) sub.onExit(message.exit);
              const dead = [...this.terminals].filter(
                ([, value]) => value.record.exitedAt,
              );
              while (dead.length > 200) this.terminals.delete(dead.shift()![0]);
            }
          } else if (message.event === "commands") {
            this.running = message.running;
            this.untracked = message.untracked;
            for (const listener of this.changes) listener(message.change);
          } else if (message.event === "interrupted") {
            for (const listener of this.interrupted) listener(message.ownerId);
          } else if (message.event === "ready") {
            this.ready = true;
            this.lastStatus = message.status;
            clearTimeout(timeout);
            this.log(
              `connected generation=${message.status.generation} terminals=${this.terminals.size}`,
            );
            for (const [id, count] of this.viewerCounts)
              if (this.terminals.has(id)) this.notify("viewers", { id, count });
            resolveReady();
          }
        } catch (error) {
          this.log(
            `invalid broker response: ${error instanceof Error ? error.message : "parse failed"}`,
          );
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        rejectReady(new Error("Broker connection failed"));
      };
      ws.onclose = (event) => {
        clearTimeout(timeout);
        this.ready = false;
        rejectReady(event.code === 1013
          ? new BrokerReplayInterruptedError("Broker replay interrupted before ready")
          : new Error("Broker disconnected before ready"));
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error(
              "Broker disconnected; operation outcome must be checked before retry",
            ),
          );
        }
        this.pending.clear();
        if (!this.disposed && !event.reason.startsWith("broker stopped")) {
          this.log(
            "disconnected; keeping session identities while reconnecting",
          );
          this.reconnect = setTimeout(() => {
            void this.open().catch((error) => this.log(String(error)));
          }, 1000);
        }
      };
    });
  }
  request(method: string, args: unknown = {}): Promise<any> {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error(
          "Background session broker is offline; reconnect before retrying",
        ),
      );
    if (this.pending.size >= 200)
      return Promise.reject(new Error("Broker request queue is full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error("Broker request timed out; verify state before retrying"),
          );
        },
        method === "stopAll" || method === "shutdown" ? 120_000 : 15_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, args }));
    });
  }
  private notify(method: string, args: unknown) {
    void this.request(method, args).catch((error) =>
      this.log(`operation failed method=${method}: ${error}`),
    );
  }
  async spawn(options: SpawnOptions) {
    const record = await this.request("spawn", options);
    return this.get(record.id)!;
  }
  list(): TerminalRecord[] {
    return [...this.terminals.values()].map((value) => ({ ...value.record }));
  }
  get(id: string): TerminalHandle | undefined {
    const terminal = this.terminals.get(id);
    if (!terminal) return undefined;
    return {
      id,
      pid: terminal.record.pid,
      write: (data) => {
        if (!this.ready)
          throw new Error("Broker is reconnecting; input was not sent");
        terminal.revision++;
        this.notify("write", {
          id,
          data: Buffer.from(
            typeof data === "string" ? new TextEncoder().encode(data) : data,
          ).toString("base64"),
        });
      },
      inputRevision: () => terminal.revision,
      bindSessionOwner: async (ownerId) => {
        await this.request("bind", { id, ownerId });
      },
      resize: (size) => this.notify("resize", { id, size }),
      setOutputMuted: (muted) => this.notify("muted", { id, muted }),
      kill: async () => {
        await this.request("kill", { id });
      },
      subscribe: (sub) => {
        terminal.subscribers.add(sub);
        const replay = terminal.buffer.snapshot();
        if (replay.length) sub.onData(replay);
        const modes = terminal.modes.reassertBytes();
        if (modes.length) sub.onData(modes);
        sub.onState?.(terminal.state);
        if (terminal.record.exitedAt)
          sub.onExit({
            code: terminal.record.exitCode ?? 0,
            signal: terminal.record.exitSignal,
          });
        return () => {
          terminal.subscribers.delete(sub);
        };
      },
      subscriberCount: () => terminal.subscribers.size,
      isAlive: () => !terminal.record.exitedAt,
    };
  }
  getExitInfo(id: string): ExitInfo | undefined {
    const record = this.terminals.get(id)?.record;
    return record?.exitedAt
      ? {
          code: record.exitCode,
          signal: record.exitSignal,
          exitedAt: record.exitedAt,
        }
      : undefined;
  }
  getEnvSnapshot(id: string) {
    return this.terminals.get(id)?.env;
  }
  onNative(listener: (value: any) => void) {
    this.nativeListeners.add(listener);
    listener(this.nativeSnapshot);
    return () => {
      this.nativeListeners.delete(listener);
    };
  }
  async sendNative(req: unknown) {
    const exitedJobs = new Map<string, any>();
    let finish: ((value: unknown) => void) | undefined;
    let id: string | undefined;
    const unsubscribe = this.onNative((value) => {
      if (value.kind === "state" && id) {
        const job = value.jobs?.find((job: any) => job.id === id);
        if (!job?.running) {
          finish?.(
            job ?? { error: "Native job outcome unavailable after reconnect" },
          );
          queueMicrotask(() => unsubscribe());
        }
      }
      if (value.kind === "jobExit") {
        if (id === value.id) {
          finish?.(value);
          unsubscribe();
        } else {
          exitedJobs.set(value.id, value);
          if (exitedJobs.size > 200)
            exitedJobs.delete(exitedJobs.keys().next().value!);
        }
      }
    });
    try {
      const job = await this.request("nativeSend", req);
      id = job.id;
      const exited = new Promise((resolve) => {
        finish = resolve;
        if (exitedJobs.has(job.id)) {
          resolve(exitedJobs.get(job.id));
          unsubscribe();
        }
      });
      return {
        pid: job.pid,
        exited,
        kill: (signal?: string) =>
          this.notify("nativeKill", { id: job.id, signal }),
      };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }
  onCodexInterrupted(listener: (ownerId: string) => void) {
    this.interrupted.add(listener);
    return () => {
      this.interrupted.delete(listener);
    };
  }
  onCommandChange(listener: (change: any) => void) {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }
  status() {
    return {
      enabled: true,
      ...this.lastStatus,
      connected: this.ready,
      remainingMs:
        Math.max(0, Date.parse(this.lastStatus.expiresAt ?? "") - Date.now()) ||
        0,
    };
  }
  async renew(windowId: string, sequence: number) {
    this.lastStatus = await this.request("lease", { windowId, sequence });
    return this.status();
  }
  async stopAll() {
    return this.request("stopAll");
  }
  setViewers(id: string, count: number) {
    this.viewerCounts.set(id, count);
    this.notify("viewers", { id, count });
  }
  async releaseTerminal(id: string) {
    return this.request("release", { id });
  }
  async reconnectTo(url: string, token: string) {
    await this.shutdown();
    this.url = url;
    this.token = token;
    await this.open();
    for (const listener of this.changes)
      listener({ kind: "broker_reconnected" });
    return this;
  }
  async gracefulShutdown(_graceMs?: number) {
    await this.shutdown();
  }
  async shutdown() {
    this.disposed = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.ready = false;
    this.socket?.close(
      1000,
      "daemon detached; resources retained by bounded lease",
    );
    this.log("daemon detached; broker owns all remaining resources");
  }
}
