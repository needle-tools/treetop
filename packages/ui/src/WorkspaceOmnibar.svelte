<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import FuzzySearchPanel from "./FuzzySearchPanel.svelte";
  import type { SearchItem, SearchKind } from "./workspace-search";

  export let open = false;
  export let items: SearchItem[] = [];
  export let query = "";
  export let initialKinds: SearchKind[] | null = null;
  export let activeKinds: SearchKind[] | null = initialKinds;

  const dispatch = createEventDispatcher<{
    pick: SearchItem;
    close: void;
  }>();
</script>

{#if open}
  <div
    class="omnibar-backdrop"
    role="presentation"
    on:mousedown|self={() => dispatch("close")}
  >
    <FuzzySearchPanel
      mode="omnibar"
      showKindFilters
      {items}
      bind:query
      {initialKinds}
      bind:activeKinds
      placeholder="Search projects, sessions, messages, notes, READMEs, dates..."
      emptyLabel="No matches."
      on:pick={(e) => dispatch("pick", e.detail)}
      on:close={() => dispatch("close")}
    />
  </div>
{/if}

<style>
  .omnibar-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    align-items: start;
    justify-items: center;
    padding-top: min(18vh, 8rem);
    background: rgba(0, 0, 0, 0.22);
  }
</style>
