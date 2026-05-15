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
        onSelect: () => void;
        disabled?: boolean;
        title?: string;
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
  /** Index of the item whose "Copied" flash is currently visible. */
  let copiedIndex: number | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  function toggle() {
    open = !open;
  }

  function handleClick(item: SessionMenuItem, index: number) {
    if (item.disabled) return;
    if (item.kind === "action") {
      open = false;
      item.onSelect();
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
  });
</script>

<div class="session-menu-anchor">
  <button
    class="menu-btn"
    type="button"
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
          <li>
            <button
              type="button"
              class="menu-item"
              class:copied={isCopied}
              on:click={() => handleClick(item, i)}
              disabled={item.disabled || isCopied}
              title={item.title ?? item.label}
            >
              {#if isCopied}
                <span class="check" aria-hidden="true">✓</span> Copied to clipboard
              {:else}
                {item.label}
              {/if}
            </button>
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
    display: inline-block;
    margin-right: 0.3rem;
    font-weight: 700;
  }
</style>
