<script lang="ts">
  /**
   * Drag-to-reorder dialog for the workspace's repos. Reached from the
   * repo-edit popover ("Reorder repos…"). Reorders the *global* repo
   * display order — the dashboard derives its row order straight from
   * the `repos` array, so persisting a new order here reorders every
   * worktree row.
   *
   * The list can be rearranged two ways: drag a row to a new slot
   * (mirrors the custom-link reorder in OpenInActions.svelte) or use the
   * ↑/↓ buttons for single-step / keyboard moves. Each committed change
   * persists via `onReorder` immediately; the daemon's `repos_reorder`
   * SSE round-trips a fresh `/api/repos` that updates the `repos` prop.
   */
  import { flip } from "svelte/animate";
  import { onDestroy } from "svelte";

  interface RepoItem {
    id: string;
    name: string;
    color?: string;
  }

  export let open = false;
  export let repos: RepoItem[] = [];
  export let onReorder: (orderedIds: string[]) => void | Promise<void>;
  export let defaultColor = "#1a3a5a";
  /** Repo the dialog was opened from — outlined in the list. Keyed by
   *  repo id, so a repo with multiple worktree rows still resolves to
   *  its single entry here. */
  export let highlightId: string | null = null;

  // Local working order, as a list of repo ids. Snapshotted from `repos`
  // each time the dialog opens; names/colours are looked up live from
  // `byId` so an edit elsewhere stays in sync without disturbing order.
  let order: string[] = [];
  let prevOpen = false;
  $: if (open !== prevOpen) {
    prevOpen = open;
    if (open) {
      order = repos.map((r) => r.id);
      dialogOffset = 0;
    }
  }

  // The dialog slides opposite to an arrow-driven move so the button you
  // clicked stays put under the cursor: moving a repo *up* shifts the
  // dialog *down* by one row pitch (and vice-versa). Reset on open.
  let listEl: HTMLUListElement | undefined;
  let dialogOffset = 0;

  // After the cursor leaves the dialog for 2s, glide it back to centre
  // (the transform transition animates the reset). Re-entering cancels.
  let recenterTimer: ReturnType<typeof setTimeout> | undefined;
  function cancelRecenter() {
    if (recenterTimer) {
      clearTimeout(recenterTimer);
      recenterTimer = undefined;
    }
  }
  function onDialogLeave() {
    cancelRecenter();
    recenterTimer = setTimeout(() => {
      dialogOffset = 0;
    }, 2000);
  }
  $: if (!open) cancelRecenter();
  onDestroy(cancelRecenter);

  $: byId = new Map(repos.map((r) => [r.id, r]));
  // Resolve the working id order to repo records for rendering, dropping
  // any id that's no longer present (repo removed elsewhere while open).
  $: orderedRepos = order
    .map((id) => byId.get(id))
    .filter((r): r is RepoItem => r !== undefined);

  let dragId: string | null = null;

  function persist() {
    const original = repos.map((r) => r.id);
    if (order.join() === original.join()) return;
    void onReorder([...order]);
  }

  function startDrag(id: string, ev: DragEvent) {
    if (!ev.dataTransfer) return;
    dragId = id;
    ev.dataTransfer.effectAllowed = "move";
    // Safari won't fire `dragover` without a payload.
    try {
      ev.dataTransfer.setData("text/plain", id);
    } catch {
      /* IE-only quirk */
    }
  }

  function onDragOver(targetId: string, ev: DragEvent) {
    if (!dragId || dragId === targetId) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    const el = ev.currentTarget as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    const draggedIdx = order.indexOf(dragId);
    const targetIdx = order.indexOf(targetId);
    if (draggedIdx < 0 || targetIdx < 0) return;
    let insertIdx = before ? targetIdx : targetIdx + 1;
    if (draggedIdx < insertIdx) insertIdx--;
    if (insertIdx === draggedIdx) return;
    const next = [...order];
    const [moved] = next.splice(draggedIdx, 1);
    next.splice(insertIdx, 0, moved!);
    order = next;
  }

  function onDragEnd() {
    const moved = dragId;
    dragId = null;
    if (moved) persist();
  }

  /** Row pitch (height + inter-row gap) in px, measured live so it
   *  tracks whatever the rendered row height actually is. */
  function rowPitch(): number {
    const row = listEl?.querySelector<HTMLElement>(".reorder-row");
    if (!row || !listEl) return 0;
    const gap = parseFloat(getComputedStyle(listEl).rowGap || "0") || 0;
    return row.offsetHeight + gap;
  }

  function move(id: string, dir: -1 | 1) {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    // Shift the dialog opposite to the row's travel so the clicked
    // arrow stays under the cursor. Measure pitch before the reorder.
    dialogOffset += dir === -1 ? rowPitch() : -rowPitch();
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    order = next;
    persist();
  }

  function close() {
    open = false;
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!open) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <div
    class="reorder-overlay"
    on:click={close}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="reorder-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reorder-title"
      style={`transform: translateY(${dialogOffset}px)`}
      on:click|stopPropagation
      on:mouseenter={cancelRecenter}
      on:mouseleave={onDialogLeave}
    >
      <h2 id="reorder-title" class="reorder-title">Reorder repos</h2>
      <p class="reorder-blurb">
        Drag a repo to a new position, or use the arrows. The order is saved as
        you go and applies across the dashboard.
      </p>

      {#if orderedRepos.length === 0}
        <p class="reorder-empty">No repos in this workspace.</p>
      {:else}
        <ul class="reorder-list" bind:this={listEl}>
          {#each orderedRepos as repo, i (repo.id)}
            <li
              class="reorder-row"
              class:dragging={dragId === repo.id}
              class:highlighted={repo.id === highlightId}
              draggable="true"
              animate:flip={{ duration: 200 }}
              on:dragstart={(ev) => startDrag(repo.id, ev)}
              on:dragover={(ev) => onDragOver(repo.id, ev)}
              on:dragend={onDragEnd}
              on:drop|preventDefault={onDragEnd}
            >
              <span class="reorder-grip" aria-hidden="true">⠿</span>
              <span
                class="reorder-dot"
                style={`--dot: ${repo.color ?? defaultColor}`}
              ></span>
              <span class="reorder-name">{repo.name}</span>
              <span class="reorder-arrows">
                <button
                  class="reorder-arrow"
                  title="Move up"
                  aria-label="Move up"
                  disabled={i === 0}
                  on:click={() => move(repo.id, -1)}
                >
                  <svg
                    class="reorder-arrow-icon"
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg
                  >
                </button>
                <button
                  class="reorder-arrow"
                  title="Move down"
                  aria-label="Move down"
                  disabled={i === orderedRepos.length - 1}
                  on:click={() => move(repo.id, 1)}
                >
                  <svg
                    class="reorder-arrow-icon"
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" /></svg
                  >
                </button>
              </span>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="reorder-buttons">
        <button type="button" class="reorder-btn" on:click={close}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .reorder-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .reorder-dialog {
    min-width: 340px;
    max-width: min(440px, 92vw);
    max-height: 80vh;
    overflow-y: auto;
    /* Glide when the dialog follows an arrow-driven move, matching the
       row flip duration so the clicked button tracks the cursor. */
    transition: transform 0.2s ease;
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .reorder-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .reorder-blurb {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .reorder-empty {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .reorder-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .reorder-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border-radius: 5px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 22%, transparent);
    background: color-mix(in srgb, var(--surface-2) 35%, transparent);
    cursor: grab;
  }
  .reorder-row:hover {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  }
  .reorder-row.dragging {
    opacity: 0.55;
    cursor: grabbing;
  }
  /* The repo the dialog was opened from — outlined so the user can spot
     where they started in a long list. */
  .reorder-row.highlighted {
    border-color: var(--brand, #4a9eff);
    box-shadow: 0 0 0 1px var(--brand, #4a9eff);
    background: color-mix(in srgb, var(--brand, #4a9eff) 14%, transparent);
  }
  .reorder-grip {
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1;
    flex: 0 0 auto;
  }
  .reorder-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: var(--dot);
    border: 1px solid rgba(0, 0, 0, 0.25);
  }
  .reorder-name {
    flex: 1 1 auto;
    font-size: 0.85rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reorder-arrows {
    display: inline-flex;
    gap: 0.2rem;
    flex: 0 0 auto;
  }
  .reorder-arrow {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
    color: inherit;
    cursor: pointer;
    font-size: 0.8rem;
    line-height: 1;
  }
  .reorder-arrow:hover:not(:disabled) {
    background: color-mix(in srgb, var(--surface-2) 80%, transparent);
  }
  .reorder-arrow:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .reorder-arrow-icon {
    display: block;
    /* Without this the SVG is a shrinkable flex child and collapses to
       width:0 inside the centered button — the icon vanishes. */
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .reorder-buttons {
    display: flex;
    justify-content: flex-end;
  }
  .reorder-btn {
    padding: 0.4rem 0.9rem;
    border-radius: 5px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
    color: inherit;
    font: inherit;
    font-size: 0.83rem;
    cursor: pointer;
  }
  .reorder-btn:hover {
    background: color-mix(in srgb, var(--surface-2) 80%, transparent);
  }
</style>
