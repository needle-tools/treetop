import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface WorkSpan {
  repoId: string;
  day: string;
  start: number;
  end: number;
}
interface Adjustment {
  id: string;
  day: string;
  repoId: string;
  deltaMs: number;
}
interface WorkState {
  spans: WorkSpan[];
  adjustments: Adjustment[];
  paused: boolean;
}
export class WorkTimeStore {
  private queue: Promise<unknown> = Promise.resolve();
  private path: string;
  private state: WorkState;
  private constructor(path: string, state: WorkState) {
    this.path = path;
    this.state = state;
  }
  static async open(root: string): Promise<WorkTimeStore> {
    const path = join(root, "work-time.json");
    let state: WorkState = { spans: [], adjustments: [], paused: false };
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return new WorkTimeStore(path, state);
  }
  paused(): boolean {
    return this.state.paused;
  }
  summary() {
    const totals = new Map<
      string,
      { day: string; repoId: string; ms: number }
    >();
    const put = (day: string, repoId: string, ms: number) => {
      const key = JSON.stringify([day, repoId]);
      const row = totals.get(key) ?? { day, repoId, ms: 0 };
      row.ms += ms;
      totals.set(key, row);
    };
    for (const s of this.state.spans) put(s.day, s.repoId, s.end - s.start);
    for (const a of this.state.adjustments) put(a.day, a.repoId, a.deltaMs);
    return [...totals.values()].sort(
      (a, b) => a.day.localeCompare(b.day) || a.repoId.localeCompare(b.repoId),
    );
  }
  private change(update: (state: WorkState) => void): Promise<void> {
    const job = this.queue.then(async () => {
      const next = structuredClone(this.state);
      update(next);
      const temporary = this.path + ".tmp";
      await writeFile(temporary, JSON.stringify(next));
      await rename(temporary, this.path);
      this.state = next;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  pause(paused: boolean) {
    return this.change((state) => {
      state.paused = paused;
    });
  }
  add(spans: WorkSpan[]) {
    return this.change((state) => {
      if (state.paused) return;
      for (const span of spans) {
        let pieces = [span];
        for (const existing of state.spans) {
          pieces = pieces.flatMap((piece) => {
            if (existing.end <= piece.start || existing.start >= piece.end)
              return [piece];
            const kept: WorkSpan[] = [];
            if (piece.start < existing.start)
              kept.push({ ...piece, end: existing.start });
            if (piece.end > existing.end)
              kept.push({ ...piece, start: existing.end });
            return kept;
          });
          if (!pieces.length) break;
        }
        state.spans.push(...pieces);
      }
      state.spans.sort((a, b) => a.start - b.start);
      state.spans = state.spans.reduce<WorkSpan[]>((all, row) => {
        const prev = all.at(-1);
        if (
          prev?.repoId === row.repoId &&
          prev.day === row.day &&
          prev.end === row.start
        )
          prev.end = row.end;
        else all.push(row);
        return all;
      }, []);
    });
  }
  adjust(adjustment: Adjustment) {
    return this.change((state) => {
      if (state.adjustments.some((a) => a.id === adjustment.id)) return;
      const same = (s: { day: string; repoId: string }) =>
        s.day === adjustment.day && s.repoId === adjustment.repoId;
      const total =
        state.spans.filter(same).reduce((n, s) => n + s.end - s.start, 0) +
        state.adjustments.filter(same).reduce((n, a) => n + a.deltaMs, 0);
      if (total + adjustment.deltaMs < 0)
        throw new Error("Work time cannot be negative");
      state.adjustments.push(adjustment);
    });
  }
}

export async function handleWorkTimeRequest(
  req: Request,
  store: WorkTimeStore,
  now = Date.now(),
): Promise<Response> {
  const snapshot = () =>
    Response.json({ rows: store.summary(), paused: store.paused() });
  if (req.method === "GET") return snapshot();
  if (req.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  const body = await req.json().catch(() => null);
  // Remote rows and removed projects also have valid IDs, even though their
  // inventory is not present in this daemon's repos.json.
  const validProject = (id: unknown) =>
    typeof id === "string" && id.length <= 256;
  const validDay = (day: unknown) =>
    typeof day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    !Number.isNaN(Date.parse(day));
  const bad = () =>
    Response.json({ error: "Invalid work-time request" }, { status: 400 });
  if (!body) return bad();
  if (body.action === "pause") {
    if (typeof body.paused !== "boolean") return bad();
    await store.pause(body.paused);
  } else if (body.action === "adjust") {
    if (
      !validProject(body.repoId) ||
      !validDay(body.day) ||
      typeof body.id !== "string" ||
      body.id.length > 100 ||
      !Number.isSafeInteger(body.deltaMs) ||
      Math.abs(body.deltaMs) > 86400_000
    )
      return bad();
    try {
      await store.adjust({
        id: body.id,
        repoId: body.repoId,
        day: body.day,
        deltaMs: body.deltaMs,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("negative"))
        return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
  } else if (body.action === "activity") {
    if (
      !Array.isArray(body.spans) ||
      body.spans.length > 2000 ||
      body.spans.some(
        (s: WorkSpan) =>
          !s ||
          !validProject(s.repoId) ||
          !validDay(s.day) ||
          !Number.isSafeInteger(s.start) ||
          !Number.isSafeInteger(s.end) ||
          s.start >= s.end ||
          s.end - s.start > 120_000 ||
          s.start < now - 7 * 86400_000 ||
          s.end > now + 5000,
      )
    )
      return bad();
    await store.add(
      body.spans.map((s: WorkSpan) => ({
        repoId: s.repoId,
        day: s.day,
        start: s.start,
        end: s.end,
      })),
    );
  } else return bad();
  return snapshot();
}
