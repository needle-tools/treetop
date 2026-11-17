export interface WorkInterval {
  repoId: string;
  start: number;
  end: number;
}
export interface WorkDayInterval extends WorkInterval {
  day: string;
}
export const WORK_IDLE_MS = 300_000;

export function workDay(time = Date.now()): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function splitWorkDays(intervals: WorkInterval[]): WorkDayInterval[] {
  const result: WorkDayInterval[] = [];
  for (const row of intervals) {
    let start = row.start;
    while (start < row.end) {
      const next = new Date(start);
      next.setHours(24, 0, 0, 0);
      const end = Math.min(next.getTime(), row.end, start + 60_000);
      result.push({ ...row, start, end, day: workDay(start) });
      start = end;
    }
  }
  return result;
}

/** Keep eligible time through the idle cutoff; flushes never retract credited work. */
export class WorkActivity {
  private last: { repoId: string; at: number; credited: number } | undefined;
  private movement: { repoId: string; since: number; at: number } | undefined;
  private pending: WorkInterval[] = [];
  private credit(now: number): void {
    if (!this.last) return;
    const end = Math.min(now, this.last.at + WORK_IDLE_MS);
    if (end <= this.last.credited) return;
    const row = { repoId: this.last.repoId, start: this.last.credited, end };
    const previous = this.pending.at(-1);
    if (previous?.repoId === row.repoId && previous.end === row.start)
      previous.end = end;
    else this.pending.push(row);
    this.last.credited = end;
  }
  input(repoId: string, now: number): void {
    this.credit(now);
    this.last = { repoId, at: now, credited: now };
    this.movement = undefined;
  }
  move(repoId: string, now: number): void {
    const previous = this.movement;
    const since =
      previous?.repoId === repoId && now - previous.at <= 1000
        ? previous.since
        : now;
    this.movement = { repoId, since, at: now };
    if (now - since >= 1000) {
      this.input(repoId, now);
      this.movement = { repoId, since, at: now };
    }
  }
  active(now: number): boolean {
    return (
      !!this.last && now >= this.last.at && now - this.last.at < WORK_IDLE_MS
    );
  }
  preview(now: number): number {
    return this.last
      ? Math.max(
          0,
          Math.min(now, this.last.at + WORK_IDLE_MS) - this.last.credited,
        )
      : 0;
  }
  project(): string {
    return this.last?.repoId ?? "";
  }
  drain(now?: number): WorkInterval[] {
    if (now !== undefined) this.credit(now);
    const result = this.pending;
    this.pending = [];
    return result;
  }
  reset(): void {
    this.last = undefined;
    this.movement = undefined;
  }
}
