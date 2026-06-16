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
  /** ISO timestamp of the most recent byte emitted by this PTY. Equal
   *  to `createdAt` until the first output arrives. Drives "is the
   *  agent idle?" heuristics in the UI — a TUI that hasn't emitted in
   *  a few seconds is almost certainly waiting on the user or done. */
  lastOutputAt: string;
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
  /** Command lines to pre-seed the spawned zsh's HISTFILE with — one
   *  per element. Only applied to zsh PTYs (where supergit creates a
   *  per-column ZDOTDIR). Used by Resume to surface the prior column's
   *  cmd transcript in arrow-up. */
  historyPreload?: readonly string[];
  /** Accent colour (`#rrggbb`) of the repo this terminal belongs to, if
   *  the user has assigned one. For Claude TUIs it tints the user-message
   *  box so the user's turns match the repo's chip colour. Absent => the
   *  default static box theme. */
  userBoxColor?: string;
}

export interface TerminalSubscriber {
  onData(chunk: Uint8Array): void;
  onExit(info: { code: number; signal?: string }): void;
  /** Daemon-detected state changes (e.g. agent paused on a "press
   *  enter to continue" / permission prompt). Optional so existing
   *  subscribers don't need to implement it. */
  onState?(state: {
    awaitingInput: boolean;
    configError?: { file: string } | null;
    /** True while the PTY is actively producing output (it emitted a byte
     *  within the last WORKING_IDLE_MS). Rides the same control channel as
     *  `awaitingInput`; when all viewers are hidden, helper-side output pause
     *  can delay fresh working-state edges until the terminal is visible again. */
    working?: boolean;
  }): void;
}

export interface TerminalHandle {
  readonly id: string;
  readonly pid: number;
  write(data: Uint8Array | string): void;
  resize(size: TerminalSize): void;
  /** Pause helper-side output delivery while no visible client needs it.
   *  Input and PTY state continue; output resumes on unmute without dropping
   *  terminal bytes. */
  setOutputMuted?(muted: boolean): void;
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

/** Compact exit record retained after a dead terminal has been forgotten
 *  from the live map. Lets a late WS attach explain *why* the PTY is gone
 *  ("exited code 1") instead of a bare "terminal not found". */
export interface ExitInfo {
  code?: number;
  signal?: string;
  exitedAt: string;
}

export interface PtyBackend {
  spawn(opts: SpawnOptions): Promise<TerminalHandle>;
  get(id: string): TerminalHandle | undefined;
  list(): TerminalRecord[];
  /** Exit record for a terminal that has already been forgotten from the
   *  live map (returns undefined for ids that never existed or are still
   *  alive — those are reachable via `get`). */
  getExitInfo?(id: string): ExitInfo | undefined;
  shutdown(): Promise<void>;
}
