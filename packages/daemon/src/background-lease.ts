import { scheduleReconnectCleanup, type CleanupTimers } from "./orphan-cleanup";

export const BACKGROUND_GRACE_MS = 15 * 60 * 1000;

/** Only UI/native-window heartbeats renew this lease. A live daemon socket or
 * tray status poll does not: closing Treetop must eventually reap resources. */
export class BackgroundLease {
  private generation = 0;
  private cancel: (() => void) | undefined;
  private sequences = new Map<string, number>();
  private disposed = false;
  private deadline = 0;
  private lastUiHeartbeat: number | null = null;
  private lastRenewLog = -Infinity;
  constructor(
    private options: {
      timers?: CleanupTimers;
      graceMs?: number;
      expire: (generation: number) => void;
      log: (event: string) => void;
    },
  ) {
    this.arm("startup");
  }
  private now() {
    return this.options.timers?.now() ?? Date.now();
  }
  private arm(reason: string) {
    this.cancel?.();
    const generation = ++this.generation;
    const grace = this.options.graceMs ?? BACKGROUND_GRACE_MS;
    this.deadline = this.now() + grace;
    this.cancel = scheduleReconnectCleanup(
      () => {
        if (this.disposed || generation !== this.generation) return;
        this.options.log(
          `lease expired generation=${generation}; stopping background resources`,
        );
        this.options.expire(generation);
      },
      grace,
      this.options.timers,
      () => {
        this.deadline = this.now() + grace;
        this.options.log(
          `wake/pause detected generation=${generation}; restarted full reconnect grace`,
        );
      },
    );
    if (reason !== "heartbeat")
      this.options.log(
        `lease armed reason=${reason} generation=${generation} graceMs=${grace}`,
      );
  }
  renew(windowId: string, sequence: number): boolean {
    if (
      this.disposed ||
      !windowId ||
      windowId.length > 128 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      return false;
    if (sequence <= (this.sequences.get(windowId) ?? -1)) return false;
    if (!this.sequences.has(windowId)) {
      if (this.sequences.size >= 100)
        this.sequences.delete(this.sequences.keys().next().value!);
      this.options.log(
        `UI connected window=${windowId}; cancelled pending cleanup`,
      );
    }
    this.sequences.set(windowId, sequence);
    this.lastUiHeartbeat = this.now();
    this.arm("heartbeat");
    if (this.now() - this.lastRenewLog >= 60_000) {
      this.options.log(
        `UI lease renewed window=${windowId} generation=${this.generation} expiresAt=${new Date(this.deadline).toISOString()}`,
      );
      this.lastRenewLog = this.now();
    }
    return true;
  }
  status() {
    return {
      expiresAt: new Date(this.deadline).toISOString(),
      remainingMs: Math.max(0, this.deadline - this.now()),
      generation: this.generation,
    };
  }
  isCurrent(generation: number) {
    return !this.disposed && generation === this.generation;
  }
  hasFreshUi(maxAgeMs = 15_000) {
    return (
      this.lastUiHeartbeat !== null &&
      this.now() - this.lastUiHeartbeat <= maxAgeMs
    );
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cancel?.();
  }
}
