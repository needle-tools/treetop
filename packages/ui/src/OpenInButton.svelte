<script lang="ts">
  /**
   * Small "open in <X>" button used in the worktree row-actions strip
   * for editors (VSCode, Cursor, Rider...), system apps (Fork, Terminal,
   * Finder/Explorer), and remote providers (GitHub, GitLab, ...).
   *
   * Props:
   *   - icon: registry key in icons.ts (`cursor`, `code`, `fork`,
   *           `github`, `git` fallback...). Pass null to render text-only.
   *   - label: button text.
   *   - title: hover title (defaults to label).
   *   - onClick: click handler.
   */
  import { iconFor, type IconDef } from "./icons";

  export let icon: string | null = null;
  export let label: string;
  export let title: string = "";
  export let onClick: () => void;
  /** When true (default), use the icon's brand colour where one is
   *  defined. Set to false to render the glyph in the surrounding text
   *  colour. */
  export let color: boolean = true;
  /** Render the icon only — used by the folded-row action strip where
   *  we cluster open-in buttons right-aligned with no labels. */
  export let iconOnly: boolean = false;

  let def: IconDef | null;
  $: def = iconFor(icon);
  $: tint = color && def?.brand ? def.brand : null;
</script>

<button
  class="tiny open-in-btn"
  class:icon-only={iconOnly}
  on:click={onClick}
  title={title || label}
  type="button"
>
  {#if def}
    {#if color && def.svg}
      <!-- Multi-colour brand mark. The SVG body brings its own fills so
           we clear the stroke/fill defaults via the `.brand` modifier. -->
      <svg
        class="open-in-icon brand"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
      >
        {@html def.svg}
      </svg>
    {:else}
      <svg
        class="open-in-icon"
        class:filled={def.filled}
        viewBox="0 0 24 24"
        width="13"
        height="13"
        aria-hidden="true"
        style={tint ? `color: ${tint}` : null}
      >
        {#each def.paths ?? [] as d}
          <path {d} />
        {/each}
        {#each def.circles ?? [] as c}
          <circle cx={c.cx} cy={c.cy} r={c.r} />
        {/each}
      </svg>
    {/if}
  {/if}
  {#if !iconOnly}
    <span>{label}</span>
  {/if}
</button>

<style>
  .open-in-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    line-height: 1;
    white-space: nowrap;
    outline: 1px solid transparent;
    outline-offset: -1px;
    transition: outline-color 0.15s;
  }
  .open-in-btn:hover:not(:disabled) {
    outline-color: color-mix(in srgb, var(--text-muted) 60%, transparent);
  }
  .open-in-icon {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .open-in-icon.filled {
    fill: currentColor;
    stroke: none;
  }
  /* Multi-colour brand SVGs bring their own fills. Reset our defaults
     so the inner shapes win, and let them poke past the 13px box a bit
     since brand marks are usually edge-to-edge. */
  .open-in-icon.brand {
    fill: initial;
    stroke: none;
  }
  /* Icon-only variant — used in the folded row-head action strip.
     Round, transparent chip so just the (coloured) brand mark shows,
     with a subtle hover wash for affordance. */
  .open-in-btn.icon-only {
    padding: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: transparent;
    border-color: transparent;
    justify-content: center;
  }
  .open-in-btn.icon-only:hover {
    background: color-mix(in srgb, var(--chip-default-bg) 55%, transparent);
  }
</style>
