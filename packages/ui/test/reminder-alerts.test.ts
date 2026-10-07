import { test, expect } from "bun:test";
import { createReminderAlerts } from "../src/reminder-alerts";
import { createToastManager } from "../src/toast-manager";
import type { Reminder } from "../../daemon/src/reminders";

test("due reminders produce persistent deduplicated toasts and click opens details then acknowledges", async () => {
  const manager = createToastManager({ onChange: () => {}, play: () => {} });
  const acknowledged: string[] = [];
  const opened: string[] = [];
  const alerts = createReminderAlerts({ showToast: manager.addToast, dismissToast: manager.dismissToast,
    dismissReminder: async id => { acknowledged.push(id); }, openReminder: item => { opened.push(item.sessionSource!); }, onError: error => { throw error; } });
  const reminder: Reminder = { id: "one", title: "Cloud", message: "Review logs", details: "Full details", repoId: "cloud", sessionSource: "session.jsonl", createdAt: "2026-10-07T00:00:00Z", dueAt: "2026-10-08T00:00:00Z", status: "due" };
  alerts.sync([reminder]);
  alerts.sync([reminder]);
  expect(manager.toasts()).toHaveLength(1);
  const toast = manager.toasts()[0]!;
  expect(toast.persist).toBe(true);
  toast.onClick!();
  manager.dismissToast(toast.id);
  await Promise.resolve();
  expect(opened).toEqual(["session.jsonl"]);
  expect(acknowledged).toEqual(["one"]);
  alerts.sync([{ ...reminder, status: "dismissed" }]);
  expect(manager.toasts()).toHaveLength(0);
});

test("acknowledging from another window removes the toast without acknowledging again", () => {
  const manager = createToastManager({ onChange: () => {}, play: () => {} });
  let requests = 0;
  const alerts = createReminderAlerts({ showToast: manager.addToast, dismissToast: manager.dismissToast,
    dismissReminder: async () => { requests++; }, openReminder: () => {}, onError: () => {} });
  alerts.sync([{ id: "one", title: "Reminder", message: "test", dueAt: "2026-10-08T00:00:00Z", createdAt: "2026-10-07T00:00:00Z", status: "due" }]);
  alerts.sync([]);
  expect(manager.toasts()).toHaveLength(0);
  expect(requests).toBe(0);
});
