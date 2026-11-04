<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import {
    backgroundStatus,
    backgroundRestorePending,
    refreshBackgroundStatus,
  } from "./background-state";
  import { apiUrl } from "./api";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  const dispatch = createEventDispatcher();
  let details = false;
  let selectionId = "";
  let selected: string[] = [];
  let busy = false;
  let error = "";
  let lastRestore: any;
  let mounted = false;
  let automaticAttempt = "";
  let hidden = false;
  let complete = false;
  let phase = "Starting processes";
  let results: Record<string, any> = {};
  $: if ($backgroundStatus.restore) lastRestore = $backgroundStatus.restore;
  $: restore =
    $backgroundStatus.restore ??
    ($backgroundRestorePending || details ? lastRestore : null);
  $: restoredElsewhere = !!restore && !$backgroundStatus.restore && !complete;
  $: progress = { ...Object.fromEntries((restore?.progress ?? []).map((row: any) => [row.id, row])), ...results };
  $: finished = Object.values(progress).filter((row: any) => row.state === "resumed" || row.state === "failed").length;
  $: current = restore?.candidates.find((row: any) => progress[row.id]?.state === "resuming")?.title;
  $: if (restore && selectionId !== restore.id) {
    selectionId = restore.id;
    hidden = false;
    complete = false;
    results = {};
    selected = restore.candidates
      .filter((row: any) => row.selected)
      .map((row: any) => row.id);
  }
  onMount(() => {
    mounted = true;
    const timer = setInterval(() => {
      if ($backgroundStatus.enabled && !busy) void refreshBackgroundStatus();
    }, 10_000);
    return () => { mounted = false; clearInterval(timer); };
  });
  // Only an explicitly requested planned restart may start this set without
  // a new selection. Crash recovery retains the existing opt-in dialog.
  $: if (mounted && restore?.automatic && !busy && automaticAttempt !== restore.id) {
    automaticAttempt = restore.id;
    void decide(restore.candidates.filter((row: any) => row.selected).map((row: any) => row.id));
  }
  function showDialog(node: HTMLDialogElement) {
    node.show();
    return { destroy: () => node.close() };
  }
  async function decide(ids: string[]) {
    busy = true;
    hidden = true;
    details = false;
    complete = false;
    phase = "Starting processes";
    results = {};
    error = "";
    try {
      const response = await fetch(apiUrl("/api/background/restore"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: restore.id, selected: ids }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Restore failed");
      results = Object.fromEntries(result.results.map((row: any) => [row.id, {...row,state:row.ok ? "resumed" : "failed"}]));
      phase = "Connecting sessions";
      // Parent reconciles old terminal IDs before any automatic spawning resumes.
      await new Promise<void>((resolve, reject) =>
        dispatch("restored", {
          candidates: restore.candidates,
          results: result.results,
          done: (error?: unknown) => (error ? reject(error) : resolve()),
        }),
      );
      const acknowledged = await fetch(apiUrl("/api/background/restore-ack"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: restore.id }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!acknowledged.ok)
        throw new Error(
          "Restore is complete but confirmation failed; retry to reconnect safely",
        );
      const failures = result.results.filter((row: any) => !row.ok);
      complete = true;
      error = failures.map((row: any) => row.error).join("\n");
      await refreshBackgroundStatus();
      backgroundRestorePending.set(false);
      if (failures.length) details = true;
    } catch (caught) {
      error = String(caught);
    } finally {
      busy = false;
    }
  }
</script>

{#if hidden && (busy || (restore && !complete))}
  <div class="resume-notification" role="status">
    {#if busy}<LoadingSpinner label="Resuming work" />{/if}
    <span>{error ? "Some work could not resume" : busy ? `${phase} · ${finished}/${selected.length}` : "Resume previous work"}{#if current}<small>{current}</small>{/if}</span>
    <button on:click={() => { hidden = false; details = true; }} aria-label="Show resume details">Details</button>
  </div>
{/if}
{#if (restore || details) && !hidden}
  <dialog
    class="background-dialog"
    use:showDialog
    on:keydown={(event) => { if (event.key === "Escape") { event.preventDefault(); hidden = true; details = false; } }}
    on:cancel={(event) => {
      event.preventDefault(); hidden = true; details = false;
    }}
    aria-label={restore ? "Resume previous work" : "Background sessions"}
  >
    <div class="dialog-heading">{#if busy}<LoadingSpinner label="Resuming work" />{/if}<h2>{complete ? "Work resumed" : busy ? "Resuming work" : restore ? "Resume previous work?" : "Background sessions"}</h2><button aria-label="Hide resume progress" on:click={() => { hidden = true; details = false; }}>×</button></div>
    {#if restore}
      <p>
        {busy ? `${phase} · ${finished}/${selected.length}` : complete ? "Your selected processes have started." : restoredElsewhere
          ? "Recovery finished in another window. Continue to connect to the same selection."
          : "These processes have stopped. Choose what to start again."}
      </p>
      {#if !restoredElsewhere}
        <div class="restore-rows">
          {#each restore.candidates as row (row.id)}
            <label
              ><input
                type="checkbox"
                value={row.id}
                bind:group={selected}
                disabled={busy || complete || restoredElsewhere}
              /><span><strong>{row.title}</strong><small>{row.cwd}</small></span
              ><small class="row-progress">{#if progress[row.id]?.state === "resuming"}<LoadingSpinner label="Resuming" />{/if}{progress[row.id]?.state === "resumed" ? "Resumed" : progress[row.id]?.state === "failed" ? "Failed" : progress[row.id]?.state === "resuming" ? "Resuming" : busy && selected.includes(row.id) ? "Waiting" : row.kind === "command" ? "command" : "session"}{#if progress[row.id]?.error}<small class="error">{progress[row.id].error}</small>{/if}</small></label
            >
          {/each}
        </div>
        <p class="hint">
          Unselected sessions stay in history. Commands and terminals start only
          when selected.
        </p>
      {/if}
    {:else}
      <p>
        Live sessions and managed commands stay running when the window closes.
        They stop after 15 minutes without an open Treetop window.
      </p>
      <p>
        Use the system tray or macOS menu bar to reopen Treetop or stop
        everything.
      </p>
      <p>External terminals and apps are managed separately.</p>
      <small>Diagnostic log: {$backgroundStatus.logPath ?? "unavailable"}</small
      >
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      {#if restore && !complete}
        {#if !restoredElsewhere}<button
            disabled={busy}
            on:click={() => decide([])}>Skip all</button
          >{/if}
        <button
          class="primary"
          disabled={busy}
          on:click={() => decide(selected)}
          >{busy
            ? "Resuming..."
            : restoredElsewhere
              ? "Connect to restored work"
              : `Resume selected (${selected.length})`}</button
        >
      {:else}
        <button
          on:click={() => {
            details = false;
            error = "";
          }}>Close</button
        >
        {#if !$backgroundStatus.connected}<button
            on:click={() => refreshBackgroundStatus(true)}>Reconnect</button
          >{/if}
      {/if}
    </footer>
  </dialog>
{/if}

<style>
  .background-dialog::backdrop {
    background: #0008;
  }
  .background-dialog {
    position: fixed;
    top: 50%; left: 50%; margin: 0;
    transform: translate(-50%, -50%);
    z-index: 1000;
    box-sizing: border-box;
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--border-muted);
    border-radius: 8px;
    padding: 20px;
    width: min(540px, calc(100% - 32px));
    max-height: 80vh;
    overflow: auto;
    box-shadow: 0 12px 50px #0006;
  }
  h2 {
    font-size: 18px;
    margin: 0 0 8px;
  }
  p {
    font-size: 13px;
    line-height: 1.5;
  }
  .restore-rows {
    max-height: 40vh;
    overflow: auto;
    margin: 16px 0;
  }
  label {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid var(--border-muted);
  }
  label span {
    flex: 1;
    min-width: 0;
  }
  strong,
  small {
    display: block;
  }
  strong {
    font-size: 13px;
    font-weight: 600;
  }
  small,
  .hint {
    font-size: 11px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  button {
    padding: 6px 10px;
  }
  .primary {
    border-color: var(--brand);
  }
  .error {
    white-space: pre-wrap;
  }
  .dialog-heading { display: flex; align-items: start; gap: 12px; }
  .dialog-heading h2 { flex: 1; }
  .resume-notification { position: fixed; bottom: 20px; right: 20px; z-index: 999; display: flex; align-items: center; gap: 10px; padding: 12px; max-width: min(440px, calc(100vw - 40px)); background: var(--surface-1); color: var(--text-1); border: 1px solid var(--border-muted); border-radius: 8px; box-shadow: 0 8px 30px #0004; }
  .resume-notification span { min-width: 0; overflow-wrap: anywhere; }
  .row-progress { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
</style>
