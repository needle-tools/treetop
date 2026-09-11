<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Readable } from "svelte/store";
  import SparseArtifactTree from "./SparseArtifactTree.svelte";
  import InspectorPanelHeader from "./InspectorPanelHeader.svelte";
  import { buildSparseArtifactRows } from "./sparse-artifact-tree";
  import {
    createSessionArtifactEvolutionTracker,
    filterSessionArtifactEvolution,
    sessionArtifactTurnCounts,
    type SessionArtifactFilter,
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
  let artifactFilter: SessionArtifactFilter = "all";

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
  $: filteredEvolution = filterSessionArtifactEvolution(evolution, artifactFilter);
  $: fileCount = buildSparseArtifactRows(
    filteredEvolution.artifacts,
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
  <InspectorPanelHeader
    title="Artifact Map"
    subtitle={`${fileCount} files`}
    draggable={!!onDragStart}
    {onDragStart}
  >
    {#if onClose}
      <button type="button" class="icon-only" on:click={onClose} aria-label="Close artifact map">×</button>
    {/if}
  </InspectorPanelHeader>

  <div class="artifact-map-summary">
    <div class="artifact-map-filters" role="group" aria-label="Filter artifact activity">
      <button type="button" class:selected={artifactFilter === "all"} on:click={() => (artifactFilter = "all")}>All</button>
      <button type="button" class:selected={artifactFilter === "reads"} on:click={() => (artifactFilter = "reads")}>Reads {evolution.totals.reads}</button>
      <button type="button" class:selected={artifactFilter === "writes"} on:click={() => (artifactFilter = "writes")}>Writes {evolution.totals.writes}</button>
    </div>
    <div class="artifact-map-filter-details">
      {#if artifactFilter !== "writes"}<span>{filteredEvolution.totals.partialReads} ranged</span>{/if}
      {#if artifactFilter !== "reads"}<span>{filteredEvolution.totals.partialWrites} partial writes</span>{/if}
      {#if filteredEvolution.totals.additions || filteredEvolution.totals.deletions}
        <span class="artifact-map-lines">+{filteredEvolution.totals.additions} −{filteredEvolution.totals.deletions}</span>
      {/if}
    </div>
  </div>

  <div class="artifact-map-body">
    {#if filteredEvolution.artifacts.length === 0}
      <p class="artifact-map-empty">No {artifactFilter === "all" ? "file activity" : artifactFilter} yet.</p>
    {:else}
      <section class="artifact-map-overall">
        <h3>Overall</h3>
        <SparseArtifactTree
          artifacts={filteredEvolution.artifacts}
          {worktreePath}
          {daemonId}
        />
      </section>

      <section class="artifact-map-timeline">
        <h3>Evolution</h3>
        {#each filteredEvolution.turns as turn (turn.turnNumber)}
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
  .artifact-map-summary,
  .artifact-map-turn span,
  .artifact-map-turn time {
    color: var(--text-muted);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .artifact-map-summary {
    display: grid;
    gap: 0.4rem;
    padding: 0.42rem 0.7rem;
    border-bottom: 1px solid var(--surface-3);
  }
  .artifact-map-filters,
  .artifact-map-filter-details {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .artifact-map-filters button {
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--surface-3);
    border-radius: 999px;
    color: var(--text-muted);
    background: transparent;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .artifact-map-filters button.selected {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--surface-3));
    color: var(--text-1);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .artifact-map-filter-details {
    gap: 0.65rem;
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
