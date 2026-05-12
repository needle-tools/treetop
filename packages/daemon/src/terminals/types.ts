/**
 * Public contract for the embedded-terminal subsystem. Code outside
 * `terminals/` should only depend on these types and on the `PtyBackend`
 * interface — never on the helper's wire protocol or which PTY library
 * we're using. Keeps the eventual "swap node-pty helper for a Go broker"
 * a single-file change.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalRecord {
  id: string;
  /** Optional logical owner (worktree id / session id). The daemon
   *  doesn't interpret this; it's a tag for the UI. */
  ownerId?: string;
  cmd: string[];
  cwd: string;
  /** Inferred agent name (claude / codex / shell), best-effort. */
  agent?: string;
  pid: number;
  size: TerminalSize;
  createdAt: string;
  exitedAt?: string;
  exitCode?: number;
  exitSignal?: string;
}

export interface SpawnOptions {
  cmd: string[];
  cwd: string;
  size: TerminalSize;
  ownerId?: string;
  env?: Record<string, string>;
  /** Optional override so callers can label the agent before any `bash -c`
   *  wrapping (which would otherwise make detectAgent see "bash"). */
  agent?: string;
}

export interface TerminalSubscriber {
  onData(chunk: Uint8Array): void;
  onExit(info: { code: number; signal?: string }): void;
  /** Daemon-detected state changes (e.g. agent paused on a "press
   *  enter to continue" / permission prompt). Optional so existing
   *  subscribers don't need to implement it. */
  onState?(state: { awaitingInput: boolean }): void;
}

export interface TerminalHandle {
  readonly id: string;
  readonly pid: number;
  write(data: Uint8Array | string): void;
  resize(size: TerminalSize): void;
  /** SIGTERM, then SIGKILL after 500ms if still alive. */
  kill(): Promise<void>;
  /** Subscribe to live output + exit. On subscribe, the current
   *  scrollback buffer is delivered as a single initial onData call so
   *  a re-attaching UI sees the recent context. Returns unsubscribe. */
  subscribe(sub: TerminalSubscriber): () => void;
  /** How many subscribers are currently attached. Used by the daemon
   *  to know when to start the grace-then-dispose timer. */
  subscriberCount(): number;
  /** Whether the underlying process has exited. */
  isAlive(): boolean;
}

export interface PtyBackend {
  spawn(opts: SpawnOptions): Promise<TerminalHandle>;
  get(id: string): TerminalHandle | undefined;
  list(): TerminalRecord[];
  shutdown(): Promise<void>;
}
