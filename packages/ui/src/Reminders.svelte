<script lang="ts">
  import { onMount } from "svelte";
  import Popover from "./Popover.svelte";
  import { apiUrl } from "./api";
  import { createReminderAlerts } from "./reminder-alerts";
  import type { AddToastOpts } from "./toast-manager";
  import type { Reminder } from "../../daemon/src/reminders";

  export let revision = 0;
  export let addToast: (options: AddToastOpts) => number;
  export let dismissToast: (id: number) => void;
  export let focusReminder: (reminder: Reminder) => Promise<void>;
  let reminders: Reminder[] = [];
  let open = false;
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
    open = false;
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
      reminders = items;
      error = "";
      alerts.sync(reminders);
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
  $: active = reminders.filter(item => item.status === "scheduled" || item.status === "due");
  $: dueCount = active.filter(item => item.status === "due").length;
  $: if (mounted) { revision; void refresh(); }
  onMount(() => {
    mounted = true;
    const timer = setInterval(() => void refresh(), 30000);
    return () => { mounted = false; clearInterval(timer); };
  });
</script>

<div class="actions-anchor">
  <button class="actions-btn" class:open on:click={() => { open = !open; if (open) void refresh(); }} title="Scheduled reminders">
    Reminders {#if dueCount}<span class="count">{dueCount}</span>{/if}
  </button>
  {#if open}
    <Popover variant="actions">
      <div slot="head"><strong>Reminders</strong><button on:click={() => (open = false)} aria-label="Close reminders">×</button></div>
      <div class="reminder-list">
        {#if error}<p role="alert">{error}</p>{/if}
        {#if active.length === 0}<p class="muted">No upcoming reminders. Ask your agent to remind you at a time.</p>{/if}
        {#each active as reminder (reminder.id)}
          <article class:due={reminder.status === "due"}>
            <button class="reminder-body" on:click={() => view(reminder)}>
              <strong>{reminder.title}</strong><span>{reminder.message}</span>
              <small>{reminder.status === "due" ? "Due" : new Date(reminder.dueAt).toLocaleString()}</small>
            </button>
            <button on:click={() => void change(reminder.id, reminder.status === "due" ? "dismiss" : "cancel").catch(reportError)}>
              {reminder.status === "due" ? "Dismiss" : "Cancel"}
            </button>
          </article>
        {/each}
      </div>
    </Popover>
  {/if}
</div>

{#if selected}
  <dialog use:openDialog class="reminder-details" aria-labelledby="reminder-heading" on:cancel={() => (selected = null)}>
    <header><h2 id="reminder-heading">{selected.title}</h2><button on:click={() => (selected = null)} aria-label="Close reminder details">×</button></header>
    <p>{selected.message}</p>
    {#if selected.details}<div class="reminder-content">{selected.details}</div>{/if}
    <p class="muted small">Scheduled for {new Date(selected.dueAt).toLocaleString()}</p>
    {#if selected.repoId || selected.sessionSource}<button on:click={() => { if (selected) void focusReminder(selected).catch(reportError); selected = null; }}>Go to {selected.sessionSource ? "session" : "project"}</button>{/if}
    <button on:click={() => (selected = null)}>Close</button>
  </dialog>
{/if}

<style>
  .reminder-list { padding: 12px; display: grid; gap: 12px; max-height: 420px; overflow: auto; }
  article { padding: 10px; border: 1px solid var(--border-muted); border-radius: 8px; display: flex; gap: 8px; align-items: center; }
  article.due { border-color: var(--brand); }
  .reminder-body { flex: 1; display: grid; gap: 6px; text-align: left; background: transparent; white-space: pre-wrap; overflow-wrap: anywhere; }
  .reminder-details { position: fixed; inset: 0; margin: auto; width: min(560px, 90vw); height: fit-content; max-height: 80vh; overflow: auto; padding: 24px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--surface-0); color: var(--text-1); }
  .reminder-details::backdrop { background: #0007; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  h2 { margin: 0; }
  p, .reminder-content { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
