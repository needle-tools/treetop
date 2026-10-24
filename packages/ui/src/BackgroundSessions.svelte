<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import {
    backgroundStatus,
    backgroundRestorePending,
    refreshBackgroundStatus,
  } from "./background-state";
  import { apiUrl } from "./api";
  const dispatch = createEventDispatcher();
  let details = false;
  let selectionId = "";
  let selected: string[] = [];
  let busy = false;
  let error = "";
  let lastRestore: any;
  $: if ($backgroundStatus.restore) lastRestore = $backgroundStatus.restore;
  $: restore =
    $backgroundStatus.restore ??
    ($backgroundRestorePending ? lastRestore : null);
  $: restoredElsewhere = !!restore && !$backgroundStatus.restore;
  $: if (restore && selectionId !== restore.id) {
    selectionId = restore.id;
    selected = restore.candidates
      .filter((row: any) => row.selected)
      .map((row: any) => row.id);
  }
  onMount(() => {
    const timer = setInterval(() => {
      if ($backgroundStatus.enabled && !busy) void refreshBackgroundStatus();
    }, 10_000);
    return () => clearInterval(timer);
  });
  function showDialog(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
  async function decide(ids: string[]) {
    busy = true;
    error = "";
    try {
      const response = await fetch(apiUrl("/api/background/restore"), {
        signal: AbortSignal.timeout(20_000),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: restore.id, selected: ids }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Restore failed");
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

{#if restore || details}
  <dialog
    class="background-dialog"
    use:showDialog
    on:cancel={(event) => {
      if (restore || busy) event.preventDefault();
      else details = false;
    }}
    aria-label={restore ? "Resume previous work" : "Background sessions"}
  >
    <h2>{restore ? "Resume previous work?" : "Background sessions"}</h2>
    {#if restore}
      <p>
        {restoredElsewhere
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
                disabled={busy || restoredElsewhere}
              /><span><strong>{row.title}</strong><small>{row.cwd}</small></span
              ><small>{row.kind === "command" ? "command" : "session"}</small
              ></label
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
      {#if restore}
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
</style>
