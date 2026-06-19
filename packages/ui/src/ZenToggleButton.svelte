<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let open = false;
  export let label = "row";

  const dispatch = createEventDispatcher<{ toggle: void }>();
</script>

<button
  class="row-zen-btn"
  class:open
  title={open
    ? "Exit zen — restore the rest of the dashboard (Esc)"
    : `Zen — make \`${label}\` fill the viewport`}
  aria-label={open ? "Exit zen" : "Enter zen"}
  on:click|stopPropagation={() => dispatch("toggle")}
>
  {open ? "◱" : "▣"}
</button>
