export interface TerminalInfo {
  id: string;
  pid: number;
  isAlive: boolean;
}

export interface CleanupTimers {
  now: () => number;
  /** Returns a cancellation function. */
  schedule: (run: () => void, delayMs: number) => () => void;
}

const cleanupTimers: CleanupTimers = {
  now: () => Date.now(),
  schedule: (run, delayMs) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

const CLEANUP_CHECK_MS = 1000;
const CLEANUP_PAUSE_MS = 5000;

/** Sleeping is not evidence that a frontend abandoned its terminals. Check
 * periodically while cleanup is pending and restart its full reconnect window
 * after a suspension/long event-loop pause. The overdue callback checks for
 * itself, so safety doesn't depend on a separate wake watchdog running first.
 */
export function scheduleReconnectCleanup(
  run: () => void,
  delayMs: number,
  timers: CleanupTimers = cleanupTimers,
  onWake?: () => void,
): () => void {
  let lastCheck = timers.now();
  let deadline = lastCheck + delayMs;
  let cancelled = false;
  let cancelTimer: () => void;
  const check = () => {
    if (cancelled) return;
    const now = timers.now();
    if (now - lastCheck > CLEANUP_PAUSE_MS || now < lastCheck) {
      deadline = now + delayMs;
      onWake?.();
    }
    lastCheck = now;
    const remaining = deadline - now;
    if (remaining <= 0) {
      cancelled = true;
      run();
    } else {
      cancelTimer = timers.schedule(check, Math.min(CLEANUP_CHECK_MS, remaining));
    }
  };
  cancelTimer = timers.schedule(check, Math.min(CLEANUP_CHECK_MS, delayMs));
  return () => { cancelled = true; cancelTimer(); };
}

export interface OrphanCleanerOptions {
  cleanupTimers?: CleanupTimers;
  orphanTimeoutMs?: number;
  killGraceMs?: number;
  getTerminals: () => TerminalInfo[];
  killTerminal: (id: string) => Promise<void>;
  log: (message: string) => void;
}

const DEFAULT_ORPHAN_TIMEOUT = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE = 10_000;

export class OrphanCleaner {
  private frontendCount = 0;
  private orphanTimer: (() => void) | null = null;
  private cleanupTimers: CleanupTimers;
  private lastDisconnectAt: number | null = null;
  private orphanTimeoutMs: number;
  private killGraceMs: number;
  private getTerminals: () => TerminalInfo[];
  private killTerminal: (id: string) => Promise<void>;
  private log: (message: string) => void;

  constructor(opts: OrphanCleanerOptions) {
    this.cleanupTimers = opts.cleanupTimers ?? cleanupTimers;
    this.orphanTimeoutMs = opts.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE;
    this.getTerminals = opts.getTerminals;
    this.killTerminal = opts.killTerminal;
    this.log = opts.log;
  }

  onFrontendConnected(): void {
    this.frontendCount++;
    if (this.orphanTimer) {
      this.orphanTimer();
      this.orphanTimer = null;
      this.log("orphan cleanup: frontend reconnected, cancelled cleanup timer");
    }
    this.lastDisconnectAt = null;
  }

  onFrontendDisconnected(): void {
    this.frontendCount = Math.max(0, this.frontendCount - 1);
    if (this.frontendCount > 0) return;

    this.lastDisconnectAt = this.cleanupTimers.now();
    if (this.orphanTimer) return;

    this.log(
      `orphan cleanup: no frontend connected, will kill all terminals in ${Math.round(this.orphanTimeoutMs / 1000)}s`,
    );
    this.orphanTimer = scheduleReconnectCleanup(() => {
      this.orphanTimer = null;
      void this.doCleanup();
    }, this.orphanTimeoutMs, this.cleanupTimers, () => {
      this.lastDisconnectAt = this.cleanupTimers.now();
      this.log("orphan cleanup: wake/pause detected, restarted frontend reconnect grace");
    });
  }

  dispose(): void {
    if (this.orphanTimer) {
      this.orphanTimer();
      this.orphanTimer = null;
    }
  }

  private async doCleanup(): Promise<void> {
    const orphanedFor = this.lastDisconnectAt !== null
      ? Math.round((this.cleanupTimers.now() - this.lastDisconnectAt) / 1000)
      : "?";
    const terminals = this.getTerminals();
    const alive = terminals.filter((t) => t.isAlive);

    if (alive.length === 0) {
      this.log(
        `orphan cleanup: no live terminals to clean up (orphaned ${orphanedFor}s)`,
      );
      return;
    }

    this.log(
      `orphan cleanup: killing ${alive.length} terminal(s) after ${orphanedFor}s with no frontend`,
    );

    for (const t of alive) {
      this.log(`orphan cleanup: SIGTERM ${t.id} (pid ${t.pid})`);
      try {
        await this.killTerminal(t.id);
        this.log(`orphan cleanup: ${t.id} (pid ${t.pid}) terminated`);
      } catch (err) {
        this.log(
          `orphan cleanup: ${t.id} (pid ${t.pid}) kill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
