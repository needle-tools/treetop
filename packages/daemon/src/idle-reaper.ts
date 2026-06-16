/**
 * Idle reaper for backgrounded ssh terminals.
 *
 * The per-terminal grace timer (`server.ts`) kills a PTY once its last WS
 * subscriber detaches. But a *backgrounded* terminal keeps a hidden,
 * output-muted subscriber alive so the dock can still show its activity —
 * so the grace timer never fires and the PTY lives indefinitely. For an
 * interactive `ssh` login that means an authenticated channel to a remote
 * host stays open (and re-attachable) long after the user closed its panel.
 *
 * This reaper closes that gap. Every sweep it kills terminals that are
 *   (a) running an ssh login (`isSsh`),
 *   (b) not on screen (`visibleCount === 0` — nobody is looking), and
 *   (c) idle: no PTY output for at least `idleMs`.
 *
 * Scope is deliberately ssh-only. Agent TUIs (Claude/Codex) are parked for
 * hours on purpose, and supergit spawns long-running dev servers (Vite, …)
 * as shell PTYs that also sit quiet — reaping either by a blanket "idle
 * shell" rule would be a regression. An ssh login is unambiguously the
 * security-relevant case, so that's the only thing we touch.
 *
 * The on-screen signal is `visibleTerminalSockets` and the idle signal is
 * the PTY's `lastOutputAt`. When all viewers are hidden, helper-side output
 * pause may stop `lastOutputAt` from advancing; that is acceptable for this
 * ssh-only cleanup because nobody is looking at the session, and active agent
 * TUIs are deliberately out of scope.
 */

export interface IdleCandidate {
  id: string;
  pid: number;
  /** False once the PTY has exited. */
  isAlive: boolean;
  /** True only for terminals running an ssh login. Non-ssh PTYs are never reaped. */
  isSsh: boolean;
  /** On-screen sockets attached to this terminal. >0 ⇒ someone is looking. */
  visibleCount: number;
  /** ISO timestamp of the PTY's most recent output byte. */
  lastOutputAt: string;
}

/** Pure: which candidate ids are due for reaping at `now`. */
export function selectIdleTerminals(
  candidates: IdleCandidate[],
  opts: { now: number; idleMs: number },
): string[] {
  const due: string[] = [];
  for (const c of candidates) {
    if (!c.isAlive || !c.isSsh || c.visibleCount > 0) continue;
    const last = Date.parse(c.lastOutputAt);
    if (!Number.isFinite(last)) continue;
    if (opts.now - last >= opts.idleMs) due.push(c.id);
  }
  return due;
}

export interface IdleReaperOptions {
  idleMs?: number;
  sweepMs?: number;
  getCandidates: () => IdleCandidate[];
  killTerminal: (id: string) => Promise<void>;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  log: (message: string) => void;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60_000;

export class IdleReaper {
  private idleMs: number;
  private sweepMs: number;
  private getCandidates: () => IdleCandidate[];
  private killTerminal: (id: string) => Promise<void>;
  private now: () => number;
  private log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: IdleReaperOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;
    this.getCandidates = opts.getCandidates;
    this.killTerminal = opts.killTerminal;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<void> {
    const due = selectIdleTerminals(this.getCandidates(), {
      now: this.now(),
      idleMs: this.idleMs,
    });
    if (due.length === 0) return;
    const mins = Math.round(this.idleMs / 60_000);
    for (const id of due) {
      this.log(
        `idle reaper: killing ssh terminal ${id} (no on-screen view, idle ≥${mins}m)`,
      );
      try {
        await this.killTerminal(id);
      } catch (err) {
        this.log(
          `idle reaper: ${id} kill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
