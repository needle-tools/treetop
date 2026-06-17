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
  let dialogEl: HTMLDivElement | undefined;
  $: confirmDescriptionId =
    $activeConfirm?.message ||
    ($activeConfirm?.mode === "choice" && $activeConfirm.detail)
      ? "confirm-description"
      : undefined;

  // When a request arrives, focus the confirm button so Enter/Space
  // commits and Esc cancels — matches the native confirm dialog's
  // keyboard model. For destructive actions we focus Cancel instead so
  // the user must deliberately move focus to the danger button.
  $: void (async () => {
    if ($activeConfirm) {
      await tick();
      if ($activeConfirm.mode === "choice") {
        const choiceButton =
          dialogEl?.querySelector<HTMLButtonElement>(
            "[data-choice-recommended='true']",
          ) ?? dialogEl?.querySelector<HTMLButtonElement>(".confirm-choice-btn");
        choiceButton?.focus();
      } else if ($activeConfirm.danger) cancelButton?.focus();
      else confirmButton?.focus();
    }
  })();

  function resolveCancel() {
    const req = $activeConfirm;
    if (!req) return;
    if (req.mode === "choice") req.resolve(null);
    else req.resolve(false);
  }

  function resolveConfirm(ok: boolean) {
    const req = $activeConfirm;
    if (!req || req.mode !== "confirm") return;
    req.resolve(ok);
  }

  function resolveChoice(value: string) {
    const req = $activeConfirm;
    if (!req || req.mode !== "choice") return;
    req.resolve(value);
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!$activeConfirm) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      resolveCancel();
    } else if (ev.key === "Enter" && $activeConfirm.mode === "confirm") {
      ev.preventDefault();
      resolveConfirm(true);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $activeConfirm}
  <div
    class="confirm-overlay"
    on:click={resolveCancel}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="confirm-dialog"
      class:confirm-dialog-choice={$activeConfirm.mode === "choice"}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby={confirmDescriptionId}
      bind:this={dialogEl}
      on:click|stopPropagation
    >
      <h2 id="confirm-title" class="confirm-title">{$activeConfirm.title}</h2>
      {#if $activeConfirm.message}
        <p id="confirm-description" class="confirm-message">
          {$activeConfirm.message}
        </p>
      {/if}
      {#if $activeConfirm.mode === "choice"}
        {#if $activeConfirm.detail}
          <p
            id={$activeConfirm.message ? undefined : "confirm-description"}
            class="confirm-detail"
          >
            {$activeConfirm.detail}
          </p>
        {/if}
        <div class="confirm-choice-list">
          {#each $activeConfirm.choices as choice (choice.value)}
            <button
              type="button"
              class="confirm-choice-btn"
              class:recommended={choice.recommended}
              class:danger={choice.danger}
              class:neutral={!choice.recommended && !choice.danger}
              data-choice-recommended={choice.recommended ? "true" : undefined}
              on:click={() => resolveChoice(choice.value)}
            >
              <span class="confirm-choice-label">{choice.label}</span>
              {#if choice.hint}
                <span class="confirm-choice-hint">{choice.hint}</span>
              {/if}
            </button>
          {/each}
        </div>
      {:else}
        <div class="confirm-buttons">
          <button
            type="button"
            class="confirm-btn confirm-cancel"
            bind:this={cancelButton}
            on:click={() => resolveConfirm(false)}
            >{$activeConfirm.cancelLabel ?? "Cancel"}</button
          >
          <button
            type="button"
            class="confirm-btn confirm-ok"
            class:danger={$activeConfirm.danger}
            bind:this={confirmButton}
            on:click={() => resolveConfirm(true)}
            >{$activeConfirm.confirmLabel ?? "Confirm"}</button
          >
        </div>
      {/if}
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
    /* Above the other dialogs (all z-index 2000) — a confirm is always asked
       ON TOP of whatever opened it (e.g. the manage-daemon dialog), so at the
       same level it rendered BEHIND and looked like "no feedback". */
    z-index: 3000;
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
  .confirm-dialog-choice {
    max-width: min(560px, 92vw);
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
  .confirm-detail {
    margin: -0.25rem 0 0.9rem;
    color: var(--text-muted);
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.35;
    word-break: break-word;
  }
  .confirm-choice-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .confirm-choice-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--surface-3);
    background: var(--surface-2);
    color: var(--text-1);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .confirm-choice-btn:hover {
    background: var(--surface-3);
  }
  .confirm-choice-btn.recommended {
    border-color: color-mix(in srgb, var(--brand) 45%, var(--surface-3));
  }
  .confirm-choice-btn.recommended:hover {
    background: color-mix(in srgb, var(--brand) 12%, var(--surface-2));
  }
  .confirm-choice-btn.danger {
    border-color: color-mix(in srgb, #efaaaa 35%, transparent);
    color: #efcccc;
  }
  .confirm-choice-btn.danger:hover {
    background: color-mix(in srgb, var(--error-bg) 60%, var(--surface-2));
  }
  .confirm-choice-btn.neutral {
    background: transparent;
    color: var(--text-muted);
  }
  .confirm-choice-label {
    font-weight: 600;
  }
  .confirm-choice-hint {
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 400;
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
