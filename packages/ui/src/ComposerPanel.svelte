<script lang="ts">
  export let kind: string;
  export let ariaLabel: string;
  export let size: "wide" | "compact" = "compact";
  export let tone: "default" | "question" = "default";
  export let list = false;
</script>

<section
  class="composer-panel"
  class:wide={size === "wide"}
  class:compact={size === "compact"}
  class:question={tone === "question"}
  class:list
  data-composer-panel={kind}
  aria-label={ariaLabel}
>
  <slot />
</section>

<!-- Shared styles live in styles/composer-panel.css. -->
