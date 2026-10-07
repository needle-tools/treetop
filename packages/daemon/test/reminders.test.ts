import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReminderStore, handleRemindersHttp, startReminderScheduler } from "../src/reminders";

test("reminders survive reopening, become due once, and stay until acknowledged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treetop-reminders-"));
  const store = new ReminderStore(directory);
  const reminder = await store.schedule({ title: "Review cloud", message: "Check deployment", details: "Inspect logs", dueAt: "2026-10-08T12:00:00Z", repoId: "cloud", sessionSource: "session.jsonl" }, Date.parse("2026-10-08T11:00:00Z"));
  const reopened = new ReminderStore(directory);
  expect((await reopened.list())[0]).toEqual(reminder);
  expect(await reopened.takeDue(Date.parse("2026-10-08T11:59:59Z"))).toEqual([]);
  const due = await reopened.takeDue(Date.parse("2026-10-08T12:00:00Z"));
  expect(due[0]!.status).toBe("due");
  expect(due[0]!.sessionSource).toBe("session.jsonl");
  expect(await reopened.takeDue(Date.parse("2026-10-08T13:00:00Z"))).toEqual([]);
  expect((await store.list())[0]!.status).toBe("due");
  expect((await reopened.updateStatus(reminder.id, "dismissed")).status).toBe("dismissed");
  expect((await store.list())[0]!.status).toBe("dismissed");
});

test("startup delivers overdue reminders and HTTP acknowledgement persists across clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treetop-reminders-"));
  const store = new ReminderStore(directory);
  const reminder = await store.schedule({ title: "Review", message: "Ready", dueAt: new Date(Date.now() - 1000).toISOString() }, Date.now() - 2000);
  const delivered = Promise.withResolvers<string>();
  const stop = startReminderScheduler(new ReminderStore(directory), item => delivered.resolve(item.id), delivered.reject);
  try {
    expect(await delivered.promise).toBe(reminder.id);
    const changes: Record<string, unknown>[] = [];
    const request = (path: string, method = "GET") => handleRemindersHttp(new Request(`http://localhost/api/reminders${path}`, { method }), store, change => changes.push(change));
    const listed = await request("");
    expect((await listed.json())[0].status).toBe("due");
    expect((await request(`/${reminder.id}/dismiss`)).status).toBe(405);
    const dismissed = await request(`/${reminder.id}/dismiss`, "POST");
    expect(dismissed.status).toBe(200);
    expect((await new ReminderStore(directory).list())[0]!.status).toBe("dismissed");
    expect(changes).toEqual([{ kind: "reminder_changed", id: reminder.id }]);
    expect((await request("/missing/dismiss", "POST")).status).toBe(400);
    expect((await request(`/${reminder.id}/cancel`, "POST")).status).toBe(400);
  } finally { stop(); }
});

test("invalid persistence is reported without overwriting existing data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treetop-reminders-"));
  const file = join(directory, "reminders.json");
  await writeFile(file, "broken JSON");
  const store = new ReminderStore(directory);
  await expect(store.schedule({ title: "Review", message: "Ready", dueAt: "2026-10-08T12:00:00Z" }, 0)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("broken JSON");
});

test("concurrent scheduling and ticking preserve all reminders; cancelled reminders never fire", async () => {
  const store = new ReminderStore(await mkdtemp(join(tmpdir(), "treetop-reminders-")));
  const items = await Promise.all(["one", "two"].map(title => store.schedule({ title, message: title, dueAt: "2026-10-08T12:00:00Z" }, Date.parse("2026-10-08T11:00:00Z"))));
  await store.updateStatus(items[0]!.id, "cancelled");
  const ticks = await Promise.all([store.takeDue(Date.parse("2026-10-08T13:00:00Z")), store.takeDue(Date.parse("2026-10-08T13:00:00Z"))]);
  expect(ticks.flat().map(item => item.id)).toEqual([items[1]!.id]);
  expect(await store.list()).toHaveLength(2);
  await expect(store.updateStatus("missing", "dismissed")).rejects.toThrow("not found");
  await expect(store.schedule({ title: "", message: "test", dueAt: "2026-10-08T12:00:00Z" }, 0)).rejects.toThrow();
  await expect(store.schedule({ title: "test", message: "test", dueAt: "2026-10-08T12:00:00" }, 0)).rejects.toThrow("timezone");
  await expect(store.schedule({ title: "test", message: "test", dueAt: "2026-10-08T12:00:00Z" }, Date.parse("2026-10-09T00:00:00Z"))).rejects.toThrow("future");
});
