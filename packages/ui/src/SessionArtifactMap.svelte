<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Readable } from "svelte/store";
  import SparseArtifactTree from "./SparseArtifactTree.svelte";
  import { buildSparseArtifactRows } from "./sparse-artifact-tree";
  import {
    createSessionArtifactEvolutionTracker,
    sessionArtifactTurnCounts,
    type SessionArtifactEvolution,
  } from "./session-artifacts";
  import type { VisualTranscriptItem } from "./last-user-message";

  export let items: readonly VisualTranscriptItem[] = [];
  export let itemStore: Readable<readonly VisualTranscriptItem[]> | undefined =
    undefined;
  export let worktreePath: string | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let onClose: (() => void) | undefined = undefined;
  export let onDragStart: ((event: DragEvent) => void) | undefined = undefined;

  const tracker = createSessionArtifactEvolutionTracker();
  const emptyEvolution: SessionArtifactEvolution = {
    artifacts: [],
    turns: [],
    totals: {
      reads: 0,
      partialReads: 0,
      writes: 0,
      partialWrites: 0,
      additions: 0,
      deletions: 0,
    },
  };
  let subscribedStore: typeof itemStore;
  let unsubscribeStore: (() => void) | undefined;
  let storedItems: readonly VisualTranscriptItem[] = [];
  let expandedTurn = 0;

  $: if (itemStore !== subscribedStore) {
    unsubscribeStore?.();
    subscribedStore = itemStore;
    storedItems = [];
    unsubscribeStore = itemStore?.subscribe((next) => {
      storedItems = next;
    });
  }
  $: effectiveItems = itemStore ? storedItems : items;
  $: evolution = effectiveItems.length
    ? tracker.update(effectiveItems)
    : emptyEvolution;
  $: fileCount = buildSparseArtifactRows(
    evolution.artifacts,
    worktreePath,
  ).filter((row) => row.kind === "file").length;

  function turnCounts(turn: (typeof evolution.turns)[number]): string {
    const { reads, writes } = sessionArtifactTurnCounts(turn);
    return [reads ? `${reads} read${reads === 1 ? "" : "s"}` : "", writes ? `${writes} write${writes === 1 ? "" : "s"}` : ""]
      .filter(Boolean)
      .join(" · ");
  }

  function turnTime(turn: (typeof evolution.turns)[number]): string {
    const value = turn.endedAt ?? turn.startedAt;
    if (!value) return "";
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "";
  }

  onDestroy(() => unsubscribeStore?.());
</script>

<section class="artifact-map-panel">
  <header
    class="artifact-map-header"
    role="group"
    draggable={!!onDragStart}
    on:dragstart={(event) => onDragStart?.(event)}
  >
    <div>
      <strong>Artifact Map</strong>
      <span>{fileCount} files · {evolution.turns.length} turns</span>
    </div>
    {#if onClose}
      <button type="button" class="artifact-map-close" on:click={onClose} aria-label="Close artifact map">×</button>
    {/if}
  </header>

  <div class="artifact-map-summary">
    <span>{evolution.totals.reads} reads</span>
    <span>{evolution.totals.partialReads} ranged</span>
    <span>{evolution.totals.writes} writes</span>
    <span>{evolution.totals.partialWrites} partial</span>
    {#if evolution.totals.additions || evolution.totals.deletions}
      <span class="artifact-map-lines">+{evolution.totals.additions} −{evolution.totals.deletions}</span>
    {/if}
  </div>

  <div class="artifact-map-body">
    {#if evolution.artifacts.length === 0}
      <p class="artifact-map-empty">No file reads or writes yet.</p>
    {:else}
      <section class="artifact-map-overall">
        <h3>Overall</h3>
        <SparseArtifactTree
          artifacts={evolution.artifacts}
          {worktreePath}
          {daemonId}
        />
      </section>

      <section class="artifact-map-timeline">
        <h3>Evolution</h3>
        {#each evolution.turns as turn (turn.turnNumber)}
          <div class="artifact-map-turn">
            <button
              type="button"
              class:expanded={expandedTurn === turn.turnNumber}
              on:click={() => (expandedTurn = expandedTurn === turn.turnNumber ? 0 : turn.turnNumber)}
            >
              <strong>Turn {turn.turnNumber}</strong>
              <span>{turnCounts(turn)}</span>
              {#if turnTime(turn)}<time>{turnTime(turn)}</time>{/if}
            </button>
            {#if expandedTurn === turn.turnNumber}
              <div class="artifact-map-turn-tree">
                <SparseArtifactTree
                  artifacts={turn.artifacts}
                  {worktreePath}
                  {daemonId}
                />
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/if}
  </div>
</section>

<style>
  .artifact-map-panel {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    color: var(--text-1);
    background: var(--surface-1);
  }
  .artifact-map-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    min-height: 3.1rem;
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid var(--surface-3);
  }
  .artifact-map-header > div {
    display: grid;
    gap: 0.1rem;
    min-width: 0;
  }
  .artifact-map-header strong {
    font-size: 0.9rem;
  }
  .artifact-map-header span,
  .artifact-map-summary,
  .artifact-map-turn span,
  .artifact-map-turn time {
    color: var(--text-muted);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .artifact-map-close {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.3rem;
    cursor: pointer;
  }
  .artifact-map-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.65rem;
    padding: 0.42rem 0.7rem;
    border-bottom: 1px solid var(--surface-3);
  }
  .artifact-map-lines {
    color: var(--success, #58d68d);
  }
  .artifact-map-body {
    min-height: 0;
    overflow: auto;
    padding: 0.65rem;
  }
  .artifact-map-body h3 {
    margin: 0 0 0.45rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .artifact-map-timeline {
    margin-top: 1rem;
  }
  .artifact-map-turn {
    border-top: 1px solid color-mix(in srgb, var(--surface-3) 70%, transparent);
  }
  .artifact-map-turn > button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    padding: 0.42rem 0.15rem;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .artifact-map-turn > button.expanded strong {
    color: var(--accent);
  }
  .artifact-map-turn time {
    white-space: nowrap;
  }
  .artifact-map-turn-tree {
    padding: 0.2rem 0 0.55rem 0.45rem;
  }
  .artifact-map-empty {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.78rem;
  }
</style>
