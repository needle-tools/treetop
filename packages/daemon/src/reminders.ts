import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ReminderStatus = "scheduled" | "due" | "dismissed" | "cancelled";
export interface Reminder {
  id: string;
  title: string;
  message: string;
  details?: string;
  dueAt: string;
  createdAt: string;
  deliveredAt?: string;
  dismissedAt?: string;
  repoId?: string;
  sessionSource?: string;
  status: ReminderStatus;
}
export type ReminderInput = Pick<Reminder, "title" | "message" | "details" | "dueAt" | "repoId" | "sessionSource">;

/** Local, one-time reminders. The daemon owns the timer; due reminders remain
 * durable so a closed dashboard can surface them when it reconnects. */
export class ReminderStore {
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(directory: string) { this.file = join(directory, "reminders.json"); }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }
  private async read(): Promise<Reminder[]> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(value)) throw new Error("Invalid reminders store");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async write(items: Reminder[]): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(items, null, 2));
    await rename(temporary, this.file);
  }
  list(): Promise<Reminder[]> {
    return this.serialized(async () => (await this.read()).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)));
  }
  async listInbox(now = Date.now()): Promise<Reminder[]> {
    return (await this.list()).filter(item => item.status === "due" ||
      (item.status === "dismissed" && (!item.dismissedAt || now - Date.parse(item.dismissedAt) <= 48 * 3600000)))
      .sort((a, b) => Date.parse(b.deliveredAt ?? b.dueAt) - Date.parse(a.deliveredAt ?? a.dueAt));
  }
  schedule(input: ReminderInput, now = Date.now()): Promise<Reminder> {
    return this.serialized(async () => {
      for (const field of ["title", "message"] as const) {
        if (typeof input[field] !== "string" || !input[field].trim() || input[field].length > 4096)
          throw new Error(`${field} must be nonempty and at most 4096 characters`);
      }
      for (const field of ["details", "repoId", "sessionSource"] as const) {
        if (input[field] !== undefined && (typeof input[field] !== "string" || input[field]!.length > 16384))
          throw new Error(`${field} must be a string of at most 16384 characters`);
      }
      if (typeof input.dueAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.dueAt))
        throw new Error("dueAt must include a timezone (Z or an offset)");
      const due = Date.parse(input.dueAt);
      if (!Number.isFinite(due) || due <= now) throw new Error("dueAt must be a valid future timestamp");
      const reminder: Reminder = { ...input, title: input.title.trim(), message: input.message.trim(), dueAt: new Date(due).toISOString(), id: randomUUID(), createdAt: new Date(now).toISOString(), status: "scheduled" };
      const items = await this.read();
      items.push(reminder);
      await this.write(items);
      return reminder;
    });
  }
  updateStatus(id: string, status: "dismissed" | "cancelled", now = Date.now()): Promise<Reminder> {
    return this.serialized(async () => {
      const items = await this.read();
      const item = items.find(item => item.id === id);
      if (!item) throw new Error("Reminder not found");
      if (status === "dismissed" && item.status !== "due" && item.status !== "dismissed")
        throw new Error("Only due reminders can be dismissed");
      if (status === "cancelled" && item.status !== "scheduled" && item.status !== "cancelled")
        throw new Error("Only scheduled reminders can be cancelled");
      if (item.status !== status) {
        item.status = status;
        if (status === "dismissed") item.dismissedAt = new Date(now).toISOString();
        await this.write(items);
      }
      return item;
    });
  }
  takeDue(now = Date.now()): Promise<Reminder[]> {
    return this.serialized(async () => {
      const items = await this.read();
      const due = items.filter(item => item.status === "scheduled" && Date.parse(item.dueAt) <= now);
      for (const item of due) { item.status = "due"; item.deliveredAt = new Date(now).toISOString(); }
      if (due.length) await this.write(items);
      return due;
    });
  }
}

const stores = new Map<string, ReminderStore>();
export function remindersForWorkspace(directory: string): ReminderStore {
  let store = stores.get(directory);
  if (!store) { store = new ReminderStore(directory); stores.set(directory, store); }
  return store;
}

export function startReminderScheduler(store: ReminderStore, deliver: (reminder: Reminder) => void, onError: (error: unknown) => void): () => void {
  let stopped = false;
  const tick = async () => {
    try {
      for (const reminder of await store.takeDue()) if (!stopped) deliver(reminder);
    } catch (error) { onError(error); }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

export async function handleRemindersHttp(request: Request, store: ReminderStore, changed: (change: Record<string, unknown>) => void): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/reminders") return Response.json(await store.list());
  const match = /^\/api\/reminders\/([^/]+)\/(dismiss|cancel)$/.exec(path);
  if (!match) return Response.json({ error: "Reminder route not found" }, { status: 404 });
  if (request.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
  try {
    const reminder = await store.updateStatus(decodeURIComponent(match[1]!), match[2] === "dismiss" ? "dismissed" : "cancelled");
    changed({ kind: "reminder_changed", id: reminder.id });
    return Response.json(reminder);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
