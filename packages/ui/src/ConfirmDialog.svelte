<script lang="ts">
  /**
   * App-wide confirm-dialog renderer. Mount once near the App root —
   * this component subscribes to `activeConfirm` and renders a modal
   * overlay whenever a `confirmDialog()` call is pending. Resolves the
   * caller's promise on Esc / Cancel / Confirm / overlay-click.
   *
   * See `confirm-dialog.ts` for the async API.
   */
  import { activeConfirm } from "./confirm-dialog";
  import { tick } from "svelte";

  let confirmButton: HTMLButtonElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;

  // When a request arrives, focus the confirm button so Enter/Space
  // commits and Esc cancels — matches the native confirm dialog's
  // keyboard model. For destructive actions we focus Cancel instead so
  // the user must deliberately move focus to the danger button.
  $: void (async () => {
    if ($activeConfirm) {
      await tick();
      if ($activeConfirm.danger) cancelButton?.focus();
      else confirmButton?.focus();
    }
  })();

  function resolve(ok: boolean) {
    const req = $activeConfirm;
    if (!req) return;
    req.resolve(ok);
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!$activeConfirm) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      resolve(false);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      resolve(true);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $activeConfirm}
  <div
    class="confirm-overlay"
    on:click={() => resolve(false)}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby={$activeConfirm.message ? "confirm-message" : undefined}
      on:click|stopPropagation
    >
      <h2 id="confirm-title" class="confirm-title">{$activeConfirm.title}</h2>
      {#if $activeConfirm.message}
        <p id="confirm-message" class="confirm-message">{$activeConfirm.message}</p>
      {/if}
      <div class="confirm-buttons">
        <button
          type="button"
          class="confirm-btn confirm-cancel"
          bind:this={cancelButton}
          on:click={() => resolve(false)}
        >{$activeConfirm.cancelLabel ?? "Cancel"}</button>
        <button
          type="button"
          class="confirm-btn confirm-ok"
          class:danger={$activeConfirm.danger}
          bind:this={confirmButton}
          on:click={() => resolve(true)}
        >{$activeConfirm.confirmLabel ?? "Confirm"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .confirm-dialog {
    min-width: 320px;
    max-width: min(440px, 90vw);
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem;
  }
  .confirm-title {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1.3;
  }
  .confirm-message {
    margin: 0 0 0.9rem;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--text-muted);
    word-break: break-all;
  }
  .confirm-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .confirm-btn {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.8rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .confirm-cancel:hover,
  .confirm-cancel:focus-visible {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
    outline: none;
  }
  .confirm-ok {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .confirm-ok:hover,
  .confirm-ok:focus-visible {
    background: color-mix(in srgb, var(--text-muted) 30%, transparent);
    outline: none;
  }
  .confirm-ok.danger {
    background: color-mix(in srgb, #c0392b 70%, transparent);
    border-color: color-mix(in srgb, #c0392b 80%, transparent);
    color: #fff;
  }
  .confirm-ok.danger:hover,
  .confirm-ok.danger:focus-visible {
    background: #c0392b;
    outline: none;
  }
</style>
