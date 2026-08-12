<script lang="ts">
  export let active = false;
  export let title = "Search";
  export let ariaLabel = title;
</script>

<button
  type="button"
  class="search-icon-button"
  class:active
  {title}
  aria-label={ariaLabel}
  on:click
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

<style>
  .search-icon-button {
    width: 1.55rem;
    height: 1.55rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    flex: 0 0 auto;
  }

  .search-icon-button:hover,
  .search-icon-button:focus-visible,
  .search-icon-button.active {
    color: var(--text-1);
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
    border-color: var(--surface-2);
    outline: none;
  }

  .search-icon-button svg {
    width: 0.88rem;
    height: 0.88rem;
  }
</style>
