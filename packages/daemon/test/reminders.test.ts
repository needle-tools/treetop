import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReminderStore, handleRemindersHttp, startReminderScheduler } from "../src/reminders";

test("snooze persists the same reminder for two hours and delivers it once again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treetop-reminders-"));
  const store = new ReminderStore(directory);
  const now = Date.now();
  const item = await store.schedule({ title: "Review", message: "Logs", details: "Details", repoId: "cloud", sessionSource: "session", dueAt: new Date(now - 1000).toISOString() }, now - 2000);
  await store.takeDue(now);
  const changes: unknown[] = [];
  const before = Date.now();
  const response = await handleRemindersHttp(new Request(`http://localhost/api/reminders/${item.id}/snooze`, { method: "POST" }), store, change => changes.push(change));
  expect(response.status).toBe(200);
  const snoozed = await response.json();
  expect(snoozed).toMatchObject({ ...item, status: "scheduled", dueAt: snoozed.dueAt });
  expect(snoozed.deliveredAt).toBeUndefined();
  expect(Date.parse(snoozed.dueAt)).toBeGreaterThanOrEqual(before + 7200000);
  expect(Date.parse(snoozed.dueAt)).toBeLessThanOrEqual(Date.now() + 7200000);
  const reopened = new ReminderStore(directory);
  expect(await reopened.listInbox()).toEqual([]);
  expect(await reopened.takeDue(Date.parse(snoozed.dueAt) - 1)).toEqual([]);
  expect((await reopened.takeDue(Date.parse(snoozed.dueAt))).map(r => r.id)).toEqual([item.id]);
  expect(await reopened.takeDue(Date.parse(snoozed.dueAt))).toEqual([]);
  expect(changes).toEqual([{ kind: "reminder_changed", id: item.id }]);
});

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

test("inbox keeps overdue reminders and retains dismissed ones for 48 hours after acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "treetop-reminders-"));
  const store = new ReminderStore(directory);
  const start = Date.parse("2026-10-08T00:00:00Z");
  const due = await store.schedule({ title: "Review", message: "Ready", dueAt: new Date(start + 1000).toISOString() }, start);
  const cancelled = await store.schedule({ title: "Cancelled", message: "Unused", dueAt: new Date(start + 2000).toISOString() }, start);
  expect(await store.listInbox(start)).toEqual([]);
  await store.updateStatus(cancelled.id, "cancelled");
  await store.takeDue(start + 3000);
  const dismissedAt = start + 7 * 86400000;
  expect((await store.listInbox(dismissedAt)).map(item => item.id)).toEqual([due.id]);
  await store.updateStatus(due.id, "dismissed", dismissedAt);
  const reopened = new ReminderStore(directory);
  expect((await reopened.listInbox(dismissedAt + 48 * 3600000))[0]?.dismissedAt).toBe(new Date(dismissedAt).toISOString());
  await reopened.updateStatus(due.id, "dismissed", dismissedAt + 3600000);
  expect(await reopened.listInbox(dismissedAt + 48 * 3600000 + 1)).toEqual([]);
  expect((await reopened.list())[0]?.status).toBe("dismissed");
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

 test('snooze accepts eight hours and rejects unsupported durations', async () => {
 const store = new ReminderStore(await mkdtemp(join(tmpdir(), 'treetop-snooze-')));
 const now=Date.now();
 const item=await store.schedule({title:'Review',message:'Logs',dueAt:new Date(now-1000).toISOString()},now-2000);
 await store.takeDue(now);
 const send=(hours:number)=>handleRemindersHttp(new Request('http://localhost/api/reminders/'+item.id+'/snooze',{method:'POST',body:JSON.stringify({hours})}),store,()=>{});
 expect((await send(3)).status).toBe(400);
 expect((await store.list()).find(r=>r.id===item.id)?.status).toBe('due');
 const before=Date.now();const response=await send(8);expect(response.status).toBe(200);
 const result=await response.json();expect(Date.parse(result.dueAt)).toBeGreaterThanOrEqual(before+8*3600000);
 expect(Date.parse(result.dueAt)).toBeLessThanOrEqual(Date.now()+8*3600000);
 });


test("MCP reminder subscribers receive creation, cancellation, due delivery and dismissal updates", async () => {
  const { Workspace } = await import("../src/workspace");
  const { EventLog } = await import("../src/events");
  const { handleMcpHttp, notifyMcpChange } = await import("../src/mcp");
  const { remindersForWorkspace } = await import("../src/reminders");
  const workspace = await Workspace.open(await mkdtemp(join(tmpdir(), "reminder-events-")));
  const events = await EventLog.open(workspace.path);
  const store = remindersForWorkspace(workspace.path);
  const changed = (change: Record<string, unknown>) => notifyMcpChange(workspace, change);
  const ctx = { workspace, events, changed };
  let session: string | undefined;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handleMcpHttp(new Request("http://localhost/mcp", {
      method: "POST", headers: session ? { "Mcp-Session-Id": session } : {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), ctx);
    session ??= response.headers.get("Mcp-Session-Id") ?? undefined;
    return await response.json() as any;
  };
  await call("initialize", { protocolVersion: "2025-11-25" });
  const uri = "treetop://reminders";
  expect((await call("resources/list")).result.resources).toContainEqual(expect.objectContaining({ uri }));
  expect((await call("resources/subscribe", { uri })).error).toBeUndefined();
  const response = await handleMcpHttp(new Request("http://localhost/mcp", { headers: { Accept: "text/event-stream", "Mcp-Session-Id": session! } }), ctx);
  const reader = response.body!.getReader();
  await reader.read(); await reader.read(); // opening comment and reconnect invalidation
  const notification = async () => {
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain('"method":"notifications/resources/updated"');
    expect(frame).toContain(uri);
    expect(frame).not.toContain("private reminder message");
  };
  const read = async () => JSON.parse((await call("resources/read", { uri })).result.contents[0].text);
  let stop = () => {};
  try {
    const scheduled = await call("tools/call", { name: "schedule_reminder", arguments: { title: "Review", message: "private reminder message", delay_seconds: 60 } });
    const item = JSON.parse(scheduled.result.content[0].text);
    await notification();
    expect(await read()).toContainEqual(expect.objectContaining({ id: item.id, status: "scheduled" }));
    await call("tools/call", { name: "cancel_reminder", arguments: { id: item.id } });
    await notification();
    expect(await read()).toContainEqual(expect.objectContaining({ id: item.id, status: "cancelled" }));
    const now = Date.now();
    const overdue = await store.schedule({ title: "Due", message: "private reminder message", dueAt: new Date(now - 1000).toISOString() }, now - 2000);
    stop = startReminderScheduler(store, reminder => changed({ kind: "reminder_due", reminder }), error => { throw error; });
    await notification();
    expect(await read()).toContainEqual(expect.objectContaining({ id: overdue.id, status: "due" }));
    expect((await handleRemindersHttp(new Request(`http://localhost/api/reminders/${overdue.id}/dismiss`, { method: "POST" }), store, changed)).status).toBe(200);
    await notification();
    expect(await read()).toContainEqual(expect.objectContaining({ id: overdue.id, status: "dismissed" }));
    stop();
    const snoozable = await store.schedule({ title: "Snooze", message: "private reminder message", dueAt: new Date(now - 1000).toISOString() }, now - 2000);
    stop = startReminderScheduler(store, reminder => changed({ kind: "reminder_due", reminder }), error => { throw error; });
    await notification();
    expect((await handleRemindersHttp(new Request(`http://localhost/api/reminders/${snoozable.id}/snooze`, { method: "POST" }), store, changed)).status).toBe(200);
    await notification();
    expect(await read()).toContainEqual(expect.objectContaining({ id: snoozable.id, status: "scheduled" }));
  } finally { stop(); await reader.cancel(); }
});
