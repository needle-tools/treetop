<script lang="ts">
  export let interactive = false;
  export let disabled = false;
  export let tone: "default" | "active" | "danger" = "default";
  export let density: "normal" | "compact" = "normal";
  export let extraClass = "";
  export let title: string | undefined = undefined;
  export let onActivate: (() => void) | undefined = undefined;

  $: rootClass = `composer-panel-item ${extraClass}`.trim();
  $: hasLeading = !!$$slots.leading;
  $: hasActions = !!$$slots.actions;
</script>

{#if interactive}
  <button
    type="button"
    class={rootClass}
    class:has-leading={hasLeading}
    class:has-actions={hasActions}
    class:active={tone === "active"}
    class:danger={tone === "danger"}
    class:compact={density === "compact"}
    {disabled}
    {title}
    on:click={() => onActivate?.()}
  >
    {#if hasLeading}
      <div class="composer-panel-item-leading"><slot name="leading" /></div>
    {/if}
    <div class="composer-panel-item-content"><slot /></div>
    {#if hasActions}
      <div class="composer-panel-item-actions"><slot name="actions" /></div>
    {/if}
  </button>
{:else}
  <div
    class={rootClass}
    class:has-leading={hasLeading}
    class:has-actions={hasActions}
    class:active={tone === "active"}
    class:danger={tone === "danger"}
    class:compact={density === "compact"}
    {title}
  >
    {#if hasLeading}
      <div class="composer-panel-item-leading"><slot name="leading" /></div>
    {/if}
    <div class="composer-panel-item-content"><slot /></div>
    {#if hasActions}
      <div class="composer-panel-item-actions"><slot name="actions" /></div>
    {/if}
  </div>
{/if}

<!-- Shared styles live in styles/composer-panel.css. -->
