<script lang="ts">
  export let label: string;
  export let tone:
    | "default"
    | "goal"
    | "subagent"
    | "question"
    | "warning" = "default";
  export let expanded = false;
  export let title: string;
  export let ariaLabel: string = title;
  export let onToggle: () => void;
  export let element: HTMLButtonElement | undefined = undefined;
</script>

<button
  bind:this={element}
  type="button"
  class="composer-badge"
  class:goal={tone === "goal"}
  class:subagent={tone === "subagent"}
  class:question={tone === "question"}
  class:warning={tone === "warning"}
  class:expanded
  on:click={onToggle}
  {title}
  aria-label={ariaLabel}
>
  {label}
</button>

<!-- Shared styles live in styles/composer-panel.css. -->
