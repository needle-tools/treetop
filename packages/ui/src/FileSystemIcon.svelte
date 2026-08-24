<script lang="ts">
  import { ICONS, type IconDef } from "./icons";

  export let kind: "file" | "folder" = "file";
  export let title: string | undefined = undefined;

  $: icon = fileSystemIcon(kind);

  function fileSystemIcon(value: "file" | "folder"): IconDef {
    return value === "folder" ? ICONS.folder : ICONS.document;
  }
</script>

<svg
  class="file-system-icon"
  viewBox="0 0 24 24"
  fill={icon.filled ? "currentColor" : "none"}
  stroke={icon.filled ? "none" : "currentColor"}
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={title ? undefined : "true"}
  role={title ? "img" : undefined}
>
  {#if title}<title>{title}</title>{/if}
  {#each icon.paths ?? [] as d}<path {d} />{/each}
  {#each icon.circles ?? [] as c}<circle cx={c.cx} cy={c.cy} r={c.r} />{/each}
</svg>

<style>
  .file-system-icon {
    display: block;
    width: 1em;
    height: 1em;
  }
</style>
