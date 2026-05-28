<script lang="ts" context="module">
  /**
   * Item descriptor consumed by `SessionMenu`. Two kinds:
   *
   *   - "action": run a callback on click; closes the menu immediately.
   *   - "copy": copy the result of `getText()` to the clipboard; the
   *     menu shows a "✓ Copied to clipboard" confirmation for ~1.2s
   *     before closing. The flash + close timing is owned by SessionMenu
   *     so every copy item across the dashboard reads the same way.
   */
  export type SessionMenuItem =
    | {
        kind: "action";
        label: string;
        /** Called when the user picks this item. The `triggerRect`
         *  is the bounding box of the burger button that opened
         *  the menu — useful for actions that animate something
         *  away from the click origin (Save-as-link's fly). */
        onSelect: (triggerRect: DOMRect) => void;
        disabled?: boolean;
        title?: string;
        /** Optional leading glyph rendered before the label. Same
         *  vocabulary the rest of the header uses (⛶, ↻, ⎘, …) so the
         *  popover reads as part of the same visual system. */
        icon?: string;
        /** Alternate icon: array of inline SVG `path` d-strings for
         *  glyphs that don't have a clean monochrome Unicode
         *  equivalent (e.g. lucide's `external-link`). Renders inside
         *  a 24×24 viewBox at 14×14 with `currentColor`. Wins over
         *  `icon` when both are set. */
        iconSvg?: string[];
        /** Dim/neutral SVG paths drawn *behind* `iconSvg` in the same
         *  24×24 viewBox — e.g. the unfilled remainder of a gauge track.
         *  Rendered with a faint neutral fill regardless of `iconColor`. */
        iconTrackPaths?: string[];
        /** Render `iconSvg` filled (fill: currentColor, no stroke)
         *  instead of the default stroke-only outline. */
        iconFilled?: boolean;
        /** Inline colour for the icon (overrides the muted default and
         *  hover colour). Used to colour-code icons, e.g. effort levels. */
        iconColor?: string;
        /** When true, a trailing check glyph marks this item as the
         *  currently-active option (e.g. the model/effort in effect). */
        selected?: boolean;
        /** When true, the menu stays open after clicking this item.
         *  Useful for toggle-style actions (e.g. show/hide dotfiles). */
        keepOpen?: boolean;
      }
    | {
        kind: "copy";
        label: string;
        /** Lazily produces the text to copy. Called on click so the
         *  text reflects the *current* state of the parent, not the
         *  state at popover-open time. */
        getText: () => string;
        disabled?: boolean;
        title?: string;
        icon?: string;
        iconSvg?: string[];
      }
    | {
        kind: "submenu";
        label: string;
        children: SessionMenuItem[];
        disabled?: boolean;
        title?: string;
        icon?: string;
        iconSvg?: string[];
        /** Dim track paths drawn behind `iconSvg` (see action variant). */
        iconTrackPaths?: string[];
        /** Render `iconSvg` filled instead of stroke-only. */
        iconFilled?: boolean;
        /** Inline colour for the icon. */
        iconColor?: string;
      };
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Popover from "./Popover.svelte";

  /** Menu contents, top → bottom. */
  export let items: SessionMenuItem[];
  /** aria-label / hover-title on the trigger button. */
  export let triggerLabel: string = "Session menu";

  let open = false;
  /** Burger trigger element — captured so action items can read its
   *  bounding rect when they fire. Save-as-link uses that rect as
   *  the origin for its fly animation. */
  let triggerEl: HTMLButtonElement | null = null;
  /** Index of the item whose "Copied" flash is currently visible. */
  let copiedIndex: number | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Index of the submenu item whose flyout is visible. */
  let submenuIndex: number | null = null;
  let submenuTimer: ReturnType<typeof setTimeout> | null = null;

  function showSubmenu(index: number) {
    if (submenuTimer) { clearTimeout(submenuTimer); submenuTimer = null; }
    submenuIndex = index;
  }
  function hideSubmenuDelayed() {
    if (submenuTimer) clearTimeout(submenuTimer);
    submenuTimer = setTimeout(() => {
      submenuIndex = null;
      submenuTimer = null;
    }, 200);
  }
  function cancelSubmenuHide() {
    if (submenuTimer) { clearTimeout(submenuTimer); submenuTimer = null; }
  }

  function toggle() {
    open = !open;
  }

  function handleSubmenuChildClick(child: SessionMenuItem) {
    if (child.disabled || child.kind !== "action") return;
    open = false;
    submenuIndex = null;
    const rect =
      triggerEl?.getBoundingClientRect() ??
      new DOMRect(window.innerWidth / 2 - 10, window.innerHeight / 2 - 10, 20, 20);
    child.onSelect(rect);
  }

  function handleClick(item: SessionMenuItem, index: number) {
    if (item.disabled) return;
    if (item.kind === "submenu") return;
    if (item.kind === "action") {
      if (!item.keepOpen) open = false;
      const rect =
        triggerEl?.getBoundingClientRect() ??
        new DOMRect(window.innerWidth / 2 - 10, window.innerHeight / 2 - 10, 20, 20);
      item.onSelect(rect);
      return;
    }
    // kind === "copy"
    const text = item.getText();
    void navigator.clipboard.writeText(text).catch(() => {});
    copiedIndex = index;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedIndex = null;
      open = false;
      copiedTimer = null;
    }, 1200);
  }

  function handleDocClick(e: MouseEvent) {
    if (!open) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".session-menu-anchor")) open = false;
  }

  onMount(() => document.addEventListener("click", handleDocClick));
  onDestroy(() => {
    document.removeEventListener("click", handleDocClick);
    if (copiedTimer) clearTimeout(copiedTimer);
    if (submenuTimer) clearTimeout(submenuTimer);
  });
</script>

<div class="session-menu-anchor">
  <button
    class="menu-btn"
    type="button"
    bind:this={triggerEl}
    on:click|stopPropagation={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={triggerLabel}
    title={triggerLabel}
  >☰</button>
  {#if open}
    <Popover variant="actions" extraClass="session-menu-popover">
      <ul class="menu-list">
        {#each items as item, i}
          {@const isCopied = copiedIndex === i}
          <li
            class:has-submenu={item.kind === "submenu"}
            on:mouseenter={() => item.kind === "submenu" && !item.disabled ? showSubmenu(i) : undefined}
            on:mouseleave={() => item.kind === "submenu" ? hideSubmenuDelayed() : undefined}
          >
            <button
              type="button"
              class="menu-item"
              class:copied={isCopied}
              on:click={() => handleClick(item, i)}
              disabled={item.disabled || isCopied}
              title={item.title ?? item.label}
            >
              {#if isCopied}
                <span class="check" aria-hidden="true">✓</span>
                <span class="label">Copied to clipboard</span>
              {:else}
                {#if item.iconSvg && item.iconSvg.length > 0}
                  <span
                    class="icon icon-svg"
                    class:icon-filled={item.iconFilled}
                    style={item.iconColor ? `color:${item.iconColor}` : undefined}
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14">
                      {#each item.iconTrackPaths ?? [] as d}
                        <path {d} class="gauge-track" />
                      {/each}
                      {#each item.iconSvg as d}
                        <path {d} />
                      {/each}
                    </svg>
                  </span>
                {:else if item.icon}
                  <span class="icon" aria-hidden="true">{item.icon}</span>
                {:else}
                  <span class="icon icon-empty" aria-hidden="true"></span>
                {/if}
                <span class="label">{item.label}</span>
                {#if item.kind === "action" && item.selected}
                  <span class="trailing-check" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="13" height="13"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                {/if}
                {#if item.kind === "submenu"}
                  <span class="chevron" aria-hidden="true">▸</span>
                {/if}
              {/if}
            </button>
            {#if item.kind === "submenu" && submenuIndex === i}
              <ul
                class="submenu-list"
                on:mouseenter={cancelSubmenuHide}
                on:mouseleave={hideSubmenuDelayed}
              >
                {#each item.children as child}
                  <li>
                    <button
                      type="button"
                      class="menu-item"
                      disabled={child.disabled}
                      title={child.title ?? child.label}
                      on:click={() => handleSubmenuChildClick(child)}
                    >
                      {#if child.iconSvg && child.iconSvg.length > 0}
                        <span
                          class="icon icon-svg"
                          class:icon-filled={child.iconFilled}
                          style={child.iconColor ? `color:${child.iconColor}` : undefined}
                          aria-hidden="true"
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14">
                            {#each child.iconTrackPaths ?? [] as d}
                              <path {d} class="gauge-track" />
                            {/each}
                            {#each child.iconSvg as d}
                              <path {d} />
                            {/each}
                          </svg>
                        </span>
                      {:else if child.icon}
                        <span class="icon" aria-hidden="true">{child.icon}</span>
                      {:else}
                        <span class="icon icon-empty" aria-hidden="true"></span>
                      {/if}
                      <span class="label">{child.label}</span>
                      {#if child.kind === "action" && child.selected}
                        <span class="trailing-check" aria-hidden="true">
                          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M20 6 9 17l-5-5" /></svg>
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    </Popover>
  {/if}
</div>

<style>
  .session-menu-anchor {
    position: relative;
    flex: 0 0 auto;
    align-self: center;
  }
  .menu-btn {
    flex: 0 0 auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text-muted);
    border: 0;
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .menu-btn:hover {
    color: var(--text-1);
    background: var(--surface-3);
    border-radius: var(--radius-sm);
  }
  .menu-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .menu-item {
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text-1);
    border: 0;
    padding: 0.4rem 0.55rem;
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .menu-item .icon {
    /* Fixed-width gutter so item labels line up even when one row's
       icon is wider (⛶) than the next (↻). The empty span keeps the
       alignment when an item has no icon. Bumped to 1.05rem so the
       Unicode glyphs (⧉, ⛶, ↻, ⤴) sit visually similar to the 0.82rem
       label — the project uses sub-1rem font-sizes throughout, but
       these monochrome glyphs render quite slim, so they need a bit
       more pixel weight than the text to feel "the same size." */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    color: var(--text-muted);
    font-size: 1.05rem;
    line-height: 1;
    flex: 0 0 auto;
  }
  .menu-item:hover:not(:disabled) .icon {
    color: var(--text-1);
  }
  .menu-item .icon.icon-svg svg {
    display: block;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* Filled variant — for solid glyphs (the AI sparkle, the effort
     bolt/bars) the painted body reads better at 14px than an outline. */
  .menu-item .icon.icon-svg.icon-filled svg {
    fill: currentColor;
    stroke: none;
  }
  /* Gauge track: the dim/neutral remainder of the sweep drawn behind the
     coloured fill. Neutral (not the effort colour) and faded so the
     coloured portion is what draws the eye. */
  .menu-item .icon.icon-svg svg .gauge-track {
    fill: var(--text-faint);
    stroke: none;
    opacity: 0.45;
  }
  /* Trailing check marking the currently-active option in a group
     (e.g. the model/effort in effect). Pushed flush-right past the
     label; coloured with the clean/confirm accent so it reads as
     "this one's on" rather than another decorative glyph. */
  .menu-item .trailing-check {
    flex: 0 0 auto;
    margin-left: auto;
    padding-left: 0.4rem;
    display: inline-flex;
    align-items: center;
    color: var(--status-clean);
  }
  .menu-item .trailing-check svg {
    display: block;
    stroke: currentColor;
    fill: none;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .menu-item .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-item:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .menu-item:disabled {
    color: var(--text-faint);
    cursor: not-allowed;
  }
  .menu-item.copied,
  .menu-item.copied:disabled {
    color: var(--status-clean);
    cursor: default;
    opacity: 1;
  }
  .menu-item .check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    font-weight: 700;
    color: var(--status-clean);
    flex: 0 0 auto;
  }
  .menu-item .chevron {
    flex: 0 0 auto;
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-left: auto;
  }
</style>
