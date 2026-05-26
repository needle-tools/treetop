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
