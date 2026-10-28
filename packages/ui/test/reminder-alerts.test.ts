import { test, expect } from "bun:test";
import { createReminderAlerts } from "../src/reminder-alerts";
import { createToastManager } from "../src/toast-manager";
import type { Reminder } from "../../daemon/src/reminders";

test("due reminders produce persistent deduplicated toasts and click opens details then acknowledges", async () => {
  const manager = createToastManager({ onChange: () => {}, play: () => {} });
  const acknowledged: string[] = [];
  const opened: string[] = [];
  const alerts = createReminderAlerts({ showToast: manager.addToast, dismissToast: manager.dismissToast,
    snoozeReminder: async () => {},
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
    snoozeReminder: async () => {},
    dismissReminder: async () => { requests++; }, openReminder: () => {}, onError: () => {} });
  alerts.sync([{ id: "one", title: "Reminder", message: "test", dueAt: "2026-10-08T00:00:00Z", createdAt: "2026-10-07T00:00:00Z", status: "due" }]);
  alerts.sync([]);
  expect(manager.toasts()).toHaveLength(0);
  expect(requests).toBe(0);
});

test("snooze action waits for persistence, deduplicates clicks, and allows the next alert", async () => {
  const manager = createToastManager({ onChange: () => {}, play: () => {} });
  const pending = Promise.withResolvers<void>();
  let snoozes = 0, dismisses = 0, opens = 0;
  const alerts = createReminderAlerts({ showToast: manager.addToast, dismissToast: manager.dismissToast,
    snoozeReminder: async (_id, hours) => { expect(hours).toBe(2); snoozes++; await pending.promise; },
    dismissReminder: async () => { dismisses++; }, openReminder: () => { opens++; }, onError: error => { throw error; } });
  const item: Reminder = { id: "one", title: "Review", message: "Logs", createdAt: "2026-10-07T00:00:00Z", dueAt: "2026-10-08T00:00:00Z", status: "due" };
  alerts.sync([item]);
  const action = manager.toasts()[0]!.actions![0]!;
  expect(action.label).toBe("Remind me later · 2 hours");
  const first = action.onClick();
  await manager.toasts()[0]!.actions![1]!.onClick();
  expect(snoozes).toBe(1);
  expect(manager.toasts()).toHaveLength(1);
  pending.resolve(); await first;
  expect(manager.toasts()).toHaveLength(0);
  expect(dismisses).toBe(0);
  expect(opens).toBe(0);
  alerts.sync([{ ...item, status: "scheduled" }]);
  alerts.sync([item]);
  expect(manager.toasts()).toHaveLength(1);
});

test("failed snooze keeps the reminder actionable for retry", async () => {
  const manager = createToastManager({ onChange: () => {}, play: () => {} });
  let attempts = 0;
  const errors: unknown[] = [];
  const alerts = createReminderAlerts({ showToast: manager.addToast, dismissToast: manager.dismissToast,
    snoozeReminder: async () => { if (++attempts === 1) throw new Error("offline"); },
    dismissReminder: async () => { throw new Error("must not dismiss"); }, openReminder: () => {}, onError: error => errors.push(error) });
  alerts.sync([{ id: "one", title: "Review", message: "Logs", createdAt: "2026-10-07T00:00:00Z", dueAt: "2026-10-08T00:00:00Z", status: "due" }]);
  await manager.toasts()[0]!.actions![0]!.onClick();
  expect(errors).toHaveLength(1);
  expect(manager.toasts()).toHaveLength(1);
  await manager.toasts()[0]!.actions![0]!.onClick();
  expect(manager.toasts()).toHaveLength(0);
});
