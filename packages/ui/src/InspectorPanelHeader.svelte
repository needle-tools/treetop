<script lang="ts">
  export let title: string;
  export let subtitle = "";
  export let draggable = false;
  export let onDragStart: ((event: DragEvent) => void) | undefined = undefined;
</script>

<header class="inspector-panel-header" role="group" {draggable} on:dragstart={(event) => onDragStart?.(event)}>
  <div class="inspector-panel-header-copy">
    <strong>{title}</strong>
    {#if subtitle}<span>{subtitle}</span>{/if}
  </div>
  <div class="inspector-panel-header-actions"><slot /></div>
</header>

<style>
  .inspector-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    min-height: 3.1rem;
    box-sizing: border-box;
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid var(--surface-3, var(--border, #303030));
  }
  .inspector-panel-header-copy {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }
  .inspector-panel-header-copy strong {
    color: var(--text-1, var(--text, #f0f0f0));
    font-size: 0.9rem;
  }
  .inspector-panel-header-copy span {
    color: var(--text-muted, var(--muted, #999));
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .inspector-panel-header-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 0.35rem;
  }
  .inspector-panel-header-actions :global(button) {
    display: inline-grid;
    place-items: center;
    min-height: 1.75rem;
    padding: 0 0.6rem;
    border: 1px solid var(--surface-3, var(--border, #3a3a3a));
    border-radius: 999px;
    color: inherit;
    background: var(--surface-2, var(--button-bg, #252525));
    font: inherit;
    font-size: 0.75rem;
    line-height: 1;
    cursor: pointer;
  }
  .inspector-panel-header-actions :global(button.icon-only) {
    width: 1.75rem;
    padding: 0;
    font-size: 1rem;
  }
  .inspector-panel-header-actions :global(button:disabled) {
    opacity: 0.5;
    cursor: default;
  }
</style>
