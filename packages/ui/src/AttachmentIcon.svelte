<script lang="ts">
  /**
   * Resolves an icon for any attachment row — session, commit, URL,
   * file — and renders it inline. Used by both the sticky-link chip
   * (view mode) and the mention-picker rows so the icon family
   * stays consistent across surfaces.
   *
   * Resolution order:
   *   - `agent`    set → AgentIcon (claude / codex / fallback dot)
   *   - `provider` set → ICONS registry lookup (github / gitlab / ...)
   *                       rendered via the same inline-svg path the
   *                       OpenInButton uses, but at the row's smaller
   *                       size and tinted with currentColor.
   *   - `glyph` fallback → ◆ / ↗ / ▤ / 🔗 — a monochrome character.
   */
  import AgentIcon from "./AgentIcon.svelte";
  import { appIconUrl } from "./app-icons";
  import { iconFor, type IconDef } from "./icons";

  export let agent: string = "";
  export let provider: string = "";
  export let appName: string = "";
  /** Monochrome character fallback when no agent/provider applies. */
  export let glyph: string = "";
  export let size: number = 14;

  $: providerDef = (provider ? iconFor(provider) : null) as IconDef | null;
</script>

{#if agent}
  <AgentIcon {agent} {size} />
{:else if appName}
  <img
    class="attachment-app-icon"
    src={appIconUrl(appName)}
    alt=""
    width={size}
    height={size}
    style={`width:${size}px;height:${size}px`}
    draggable="false"
  />
{:else if providerDef}
  <!-- Render the provider's brand path / circles via the same
       inline-SVG approach OpenInButton uses. currentColor tint so
       the icon matches the chip's text colour. -->
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill={providerDef.filled ? "currentColor" : "none"}
    stroke={providerDef.filled ? "none" : "currentColor"}
    stroke-width={providerDef.filled ? undefined : 1.8}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#each providerDef.paths ?? [] as d}
      <path {d} />
    {/each}
    {#each providerDef.circles ?? [] as c}
      <circle cx={c.cx} cy={c.cy} r={c.r} />
    {/each}
  </svg>
{:else if glyph}
  <span class="attachment-icon-glyph" aria-hidden="true">{glyph}</span>
{/if}

<style>
  .attachment-icon-glyph {
    display: inline-block;
    font-size: 13px;
    line-height: 1;
  }
  .attachment-app-icon {
    display: block;
    object-fit: contain;
  }
</style>
