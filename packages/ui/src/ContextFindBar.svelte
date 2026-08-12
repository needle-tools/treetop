<script lang="ts">
  import { tick } from "svelte";

  export let open = false;
  export let query = "";
  export let count = 0;
  export let activeIndex = 0;
  export let placeholder = "Find...";
  export let onPrevious: () => void = () => {};
  export let onNext: () => void = () => {};
  export let onClose: () => void = () => {};

  let inputEl: HTMLInputElement | null = null;

  $: if (open) {
    void tick().then(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrevious();
      else onNext();
    }
  }
</script>

{#if open}
  <div class="context-find-bar" data-context-find-ignore>
    <svg class="context-find-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM13.5 13.5l-3-3"
      />
    </svg>
    <input
      bind:this={inputEl}
      type="search"
      bind:value={query}
      {placeholder}
      aria-label={placeholder}
      data-context-find-input
      on:keydown={onKeydown}
    />
    <span class="context-find-count" aria-live="polite">
      {#if query.trim()}
        {count === 0 ? "0" : `${activeIndex + 1}/${count}`}
      {/if}
    </span>
    <button type="button" title="Previous match" aria-label="Previous match" on:click={onPrevious}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M4 10l4-4 4 4"
        />
      </svg>
    </button>
    <button type="button" title="Next match" aria-label="Next match" on:click={onNext}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M4 6l4 4 4-4"
        />
      </svg>
    </button>
    <button type="button" title="Close search" aria-label="Close search" on:click={onClose}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          d="M4 4l8 8M12 4l-8 8"
        />
      </svg>
    </button>
  </div>
{/if}

<style>
  :global(::highlight(supergit-context-find)) {
    background: color-mix(in srgb, var(--status-dirty) 50%, transparent);
    color: inherit;
  }

  :global(::highlight(supergit-context-find-active)) {
    background: color-mix(in srgb, var(--brand) 70%, transparent);
    color: var(--text-1);
  }

  .context-find-bar {
    position: absolute;
    top: calc(var(--session-head-height, 3.25rem) + 0.45rem);
    right: 0.65rem;
    z-index: 12;
    display: grid;
    grid-template-columns: auto minmax(8rem, 15rem) auto auto auto auto;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem;
    border: 1px solid color-mix(in srgb, var(--surface-3) 88%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--surface-2) 96%, transparent);
    box-shadow: 0 14px 34px -24px rgba(0, 0, 0, 0.95);
    pointer-events: auto;
  }

  :global(.sticky-layer > .context-find-bar) {
    position: fixed;
    top: 4.5rem;
    right: 1rem;
    z-index: 2300;
  }

  :global(.session-head-stack > .context-find-bar) {
    top: calc(100% + 0.35rem);
  }

  .context-find-icon {
    width: 0.82rem;
    height: 0.82rem;
    color: var(--text-muted);
    margin-left: 0.15rem;
  }

  input {
    min-width: 0;
    height: 1.45rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-1);
    font: inherit;
    font-size: 0.76rem;
    outline: none;
  }

  input::-webkit-search-cancel-button {
    display: none;
  }

  .context-find-count {
    min-width: 3.2rem;
    color: var(--text-muted);
    font-size: 0.68rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  button {
    width: 1.35rem;
    height: 1.35rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    padding: 0;
    cursor: pointer;
  }

  button:hover,
  button:focus-visible {
    color: var(--text-1);
    border-color: var(--surface-3);
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    outline: none;
  }

  button svg {
    width: 0.82rem;
    height: 0.82rem;
  }
</style>
