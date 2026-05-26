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

export const processStore = writable<ProcEntry[]>([]);

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
