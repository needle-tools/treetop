<script lang="ts">
  import { onMount } from "svelte";
  import { apiUrl } from "./api";
  import { createReminderAlerts } from "./reminder-alerts";
  import type { AddToastOpts } from "./toast-manager";
  import type { Reminder } from "../../daemon/src/reminders";

  export let revision = 0;
  export let addToast: (options: AddToastOpts) => number;
  export let dismissToast: (id: number) => void;
  export let focusReminder: (reminder: Reminder) => Promise<void>;
  let selected: Reminder | null = null;
  let mounted = false;
  let requestSequence = 0;
  let error = "";
  const alerts = createReminderAlerts({
    showToast: options => addToast(options), dismissToast: id => dismissToast(id),
    dismissReminder: id => change(id, "dismiss"), openReminder: showDetails,
    onError: reportError,
  });
  function reportError(reason: unknown) {
    error = reason instanceof Error ? reason.message : String(reason);
    addToast({ kind: "error", message: error });
  }
  function showDetails(reminder: Reminder): void {
    selected = reminder;
    void focusReminder(reminder).catch(reportError);
  }
  function openDialog(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
  export async function refresh(): Promise<void> {
    const sequence = ++requestSequence;
    try {
      const response = await fetch(apiUrl("/api/reminders"));
      if (!response.ok) throw new Error("Unable to load reminders");
      const items: Reminder[] = await response.json();
      if (sequence !== requestSequence || !mounted) return;
      error = "";
      alerts.sync(items);
    } catch (reason) {
      if (mounted && sequence === requestSequence) error = reason instanceof Error ? reason.message : String(reason);
    }
  }
  async function change(id: string, action: "dismiss" | "cancel"): Promise<void> {
    const response = await fetch(apiUrl(`/api/reminders/${encodeURIComponent(id)}/${action}`), { method: "POST" });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error ?? "Unable to update reminder");
    }
    await refresh();
  }
  export function view(reminder: Reminder): void {
    showDetails(reminder);
    if (reminder.status === "due") void change(reminder.id, "dismiss").catch(reportError);
  }
  $: if (mounted) { revision; void refresh(); }
  onMount(() => {
    mounted = true;
    const timer = setInterval(() => void refresh(), 30000);
    return () => { mounted = false; clearInterval(timer); };
  });
</script>

{#if selected}
  <dialog use:openDialog class="reminder-details" aria-labelledby="reminder-heading" on:cancel={() => (selected = null)}>
    <header><h2 id="reminder-heading">{selected.title}</h2><button class="reminder-close" on:click={() => (selected = null)} aria-label="Close reminder details">×</button></header>
    <p>{selected.message}</p>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if selected.details}<div class="reminder-content">{selected.details}</div>{/if}
    <p class="muted small">Scheduled for {new Date(selected.dueAt).toLocaleString()}</p>
    <footer>
      {#if selected.repoId || selected.sessionSource}<button on:click={() => { if (selected) void focusReminder(selected).catch(reportError); selected = null; }}>Go to {selected.sessionSource ? "session" : "project"}</button>{/if}
      <button on:click={() => (selected = null)}>Close</button>
    </footer>
  </dialog>
{/if}

<style>
  .reminder-details { position: fixed; inset: 0; margin: auto; box-sizing: border-box; width: min(560px, calc(100vw - 32px)); height: fit-content; max-height: calc(100dvh - 32px); overflow: auto; padding: 24px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--surface-0); color: var(--text-1); font-size: 1rem; line-height: 1.5; }
  .reminder-details::backdrop { background: #0007; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  h2 { margin: 0; min-width: 0; font-size: 1.25rem; line-height: 1.4; overflow-wrap: anywhere; }
  .reminder-close { flex: 0 0 32px; width: 32px; height: 32px; padding: 0; display: grid; place-items: center; }
  footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
  p, .reminder-content { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
