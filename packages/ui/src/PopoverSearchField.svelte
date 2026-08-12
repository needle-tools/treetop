<script lang="ts">
  import { tick } from "svelte";

  export let open = false;
  export let value = "";
  export let placeholder = "Search...";
  export let title = "Search";
  export let ariaLabel = title;

  let inputEl: HTMLInputElement | null = null;

  $: if (open) {
    void tick().then(() => inputEl?.focus());
  }

  function toggle(e: MouseEvent): void {
    e.stopPropagation();
    open = !open;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    open = false;
  }
</script>

{#if open}
  <span class="popover-search-field">
    <svg
      class="popover-search-field-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
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
      bind:value
      {placeholder}
      aria-label={ariaLabel}
      on:keydown={onKeydown}
    />
    <button
      type="button"
      class="popover-search-close"
      title="Close search"
      aria-label="Close search"
      on:click|stopPropagation={() => (open = false)}
    >
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
  </span>
{:else}
  <button
    type="button"
    class="popover-search-toggle"
    {title}
    aria-label={ariaLabel}
    on:click={toggle}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM13.5 13.5l-3-3"
      />
    </svg>
  </button>
{/if}

<style>
  .popover-search-field {
    min-width: 9rem;
    width: min(15rem, 42vw);
    display: inline-grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.35rem;
    min-height: 1.55rem;
    padding: 0.08rem 0.12rem 0.08rem 0.4rem;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-1);
  }

  .popover-search-toggle {
    width: 2.25rem;
    height: 1.55rem;
    display: inline-grid;
    place-items: center end;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 0.34rem;
    flex: 0 0 auto;
  }

  .popover-search-toggle:hover,
  .popover-search-toggle:focus-visible {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    border-color: var(--surface-2);
    outline: none;
  }

  .popover-search-toggle svg,
  .popover-search-close svg {
    width: 0.88rem;
    height: 0.88rem;
  }

  .popover-search-field-icon {
    width: 0.85rem;
    height: 0.85rem;
    color: var(--text-muted);
  }

  .popover-search-close {
    width: 1.32rem;
    height: 1.32rem;
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
  }

  .popover-search-close:hover,
  .popover-search-close:focus-visible {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    outline: none;
  }

  input {
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.76rem;
    line-height: 1.2;
  }

  input::placeholder {
    color: var(--text-muted);
  }

  input::-webkit-search-cancel-button {
    appearance: none;
  }
</style>
