import { writable, derived } from "svelte/store";

export interface ProcEntry {
  id: string;
  pid: number;
  agent?: string;
  cmd: string[];
  cwd: string;
  ownerId?: string;
  createdAt?: string;
  lastOutputAt?: string;
  cpuPercent: number;
  memBytes: number;
  kind?: "tui" | "external";
  comm?: string;
}

export interface ProcSample {
  ts: number;
  cpuPercent: number;
  memBytes: number;
}

const MAX_HISTORY_MS = 5 * 60 * 1000;

const history = new Map<string, ProcSample[]>();

export function recordSamples(procs: ProcEntry[]): void {
  const now = Date.now();
  const cutoff = now - MAX_HISTORY_MS;
  const liveIds = new Set<string>();
  for (const p of procs) {
    liveIds.add(p.id);
    let buf = history.get(p.id);
    if (!buf) {
      buf = [];
      history.set(p.id, buf);
    }
    buf.push({ ts: now, cpuPercent: p.cpuPercent, memBytes: p.memBytes });
    while (buf.length > 0 && buf[0]!.ts < cutoff) buf.shift();
  }
  for (const id of history.keys()) {
    if (!liveIds.has(id)) history.delete(id);
  }
  procHistory.set(new Map(history));
}

export function getHistory(id: string): ProcSample[] {
  return history.get(id) ?? [];
}

/** Default smoothing window for the displayed CPU%. A single Windows
 *  perf-counter sample reads 0 for most idle/bursty processes, so the
 *  raw per-poll value flickers between 0 and a spike. Averaging the
 *  collected samples over this window gives a stable, representative
 *  number. */
export const CPU_AVG_WINDOW_MS = 30_000;

/**
 * Average each process's `cpuPercent` over the trailing `windowMs`.
 *
 * Pure (takes the history map + `now` explicitly so it's testable and
 * reactive in Svelte): pass the `procHistory` store value and a fresh
 * `Date.now()`. Samples in each buffer are time-ordered ascending, so
 * we walk from the newest backward and stop at the first one older than
 * the cutoff. A process with no in-window samples is omitted from the
 * result (callers fall back to the raw `cpuPercent`).
 */
export function averagedCpuFromHistory(
  hist: Map<string, ProcSample[]>,
  windowMs: number,
  now: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const cutoff = now - windowMs;
  for (const [id, buf] of hist) {
    let sum = 0;
    let n = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const s = buf[i]!;
      if (s.ts < cutoff) break;
      sum += s.cpuPercent;
      n++;
    }
    if (n > 0) out.set(id, sum / n);
  }
  return out;
}

/**
 * Sort processes by usage: CPU% descending (using the trailing average
 * when available, falling back to the raw sample), with memory as the
 * tiebreaker. Returns a new array — does not mutate the input. Pure so
 * the component can use it both for the live ordering and for the
 * frozen snapshot it captures while the cursor hovers a group.
 */
export function sortProcsByUsage<
  T extends { id: string; cpuPercent: number; memBytes: number },
>(procs: T[], avgCpu: Map<string, number>): T[] {
  const cpu = (p: T): number => avgCpu.get(p.id) ?? p.cpuPercent;
  return [...procs].sort((a, b) => {
    const byCpu = cpu(b) - cpu(a);
    if (byCpu !== 0) return byCpu;
    return b.memBytes - a.memBytes;
  });
}

export const processStore = writable<ProcEntry[]>([]);
export const procHistory = writable<Map<string, ProcSample[]>>(new Map());

export const procByOwnerId = derived(processStore, ($procs) => {
  const map = new Map<string, ProcEntry>();
  for (const p of $procs) {
    if (p.ownerId) map.set(p.ownerId, p);
  }
  return map;
});

export const procByPid = derived(processStore, ($procs) => {
  const map = new Map<number, ProcEntry>();
  for (const p of $procs) map.set(p.pid, p);
  return map;
});
