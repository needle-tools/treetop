import type { Reminder } from "../../daemon/src/reminders";
import type { AddToastOpts } from "./toast-manager";

export function createReminderAlerts(deps: {
  showToast: (options: AddToastOpts) => number;
  dismissToast: (id: number) => void;
  dismissReminder: (id: string) => Promise<void>;
  snoozeReminder: (id: string, hours: number) => Promise<void>;
  openReminder: (reminder: Reminder) => void;
  onError: (error: unknown) => void;
}) {
  const alerts = new Map<string, number>();
  const acknowledging = new Set<string>();
  const snoozing = new Set<string>();
  return {
    sync(reminders: Reminder[]): void {
      const due = new Set(reminders.filter(item => item.status === "due").map(item => item.id));
      for (const [id, toast] of alerts) {
        if (!due.has(id)) { alerts.delete(id); deps.dismissToast(toast); }
      }
      for (const id of acknowledging) if (!due.has(id)) acknowledging.delete(id);
      for (const item of reminders) {
        if (item.status !== "due" || alerts.has(item.id) || acknowledging.has(item.id)) continue;
        const toast = deps.showToast({
          kind: "info", title: item.title, message: item.message, persist: true,
          onClick: () => deps.openReminder(item),
          actions: [2, 8].map(hours => ({
            label: `Remind me later · ${hours} hours`,
            onClick: async () => {
              if (snoozing.has(item.id)) return;
              snoozing.add(item.id);
              try {
                await deps.snoozeReminder(item.id, hours);
                const toastId = alerts.get(item.id);
                alerts.delete(item.id);
                acknowledging.add(item.id);
                if (toastId !== undefined) deps.dismissToast(toastId);
              } catch (error) { deps.onError(error); }
              finally { snoozing.delete(item.id); }
            },
          })),
          onDismiss: () => {
            if (!alerts.has(item.id)) return;
            alerts.delete(item.id);
            if (snoozing.has(item.id)) return;
            acknowledging.add(item.id);
            void deps.dismissReminder(item.id).catch(error => {
              acknowledging.delete(item.id);
              deps.onError(error);
            });
          },
        });
        alerts.set(item.id, toast);
      }
    },
  };
}
