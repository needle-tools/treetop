<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Readable } from "svelte/store";
  import SparseArtifactTree from "./SparseArtifactTree.svelte";
  import InspectorPanelHeader from "./InspectorPanelHeader.svelte";
  import { buildSparseArtifactRows } from "./sparse-artifact-tree";
  import {
    createSessionArtifactEvolutionTracker,
    analyzeSessionArtifactOverbooking,
    filterSessionArtifactEvolution,
    scopeSessionArtifactEvolution,
    sessionArtifactJuiceTransition,
    sessionArtifactTurnCounts,
    sessionArtifactTurnWindow,
    type SessionArtifactFilter,
    type SessionArtifactEvolution,
    type SessionArtifactScope,
  } from "./session-artifacts";
  import type { VisualTranscriptItem } from "./last-user-message";

  const ARTIFACT_MAP_UPDATE_MS = 100;

  export let items: readonly VisualTranscriptItem[] = [];
  export let itemStore: Readable<readonly VisualTranscriptItem[]> | undefined =
    undefined;
  export let worktreePath: string | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let onClose: (() => void) | undefined = undefined;
  export let onDragStart: ((event: DragEvent) => void) | undefined = undefined;
  export let juiceEnabled = false;

  const tracker = createSessionArtifactEvolutionTracker();
  const emptyEvolution: SessionArtifactEvolution = {
    artifacts: [],
    turns: [],
    totals: {
      reads: 0,
      references: 0,
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
  let displayedItems: readonly VisualTranscriptItem[] = [];
  let pendingItems: readonly VisualTranscriptItem[] = [];
  let itemUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  let expandedTurn = 0;
  let evolutionOpen = false;
  let visibleTurnLimit = 200;
  let artifactFilter: SessionArtifactFilter = "all";
  let artifactScope: SessionArtifactScope = "consolidated";
  let previousJuiceTotals: SessionArtifactEvolution["totals"] | undefined;
  let readImpactCount = 0;
  let writeImpactCount = 0;

  function updateJuiceImpact(next: SessionArtifactEvolution["totals"]): void {
    const impact = sessionArtifactJuiceTransition(previousJuiceTotals, next, juiceEnabled);
    previousJuiceTotals = { ...next };
    if (impact.readImpact) readImpactCount += 1;
    if (impact.writeImpact) writeImpactCount += 1;
  }

  function queueDisplayedItems(next: readonly VisualTranscriptItem[]): void {
    pendingItems = next;
    if (displayedItems.length === 0 || next.length === 0) {
      displayedItems = next;
      return;
    }
    if (itemUpdateTimer !== undefined) return;
    itemUpdateTimer = setTimeout(() => {
      itemUpdateTimer = undefined;
      displayedItems = pendingItems;
    }, ARTIFACT_MAP_UPDATE_MS);
  }

  $: if (itemStore !== subscribedStore) {
    unsubscribeStore?.();
    subscribedStore = itemStore;
    storedItems = [];
    unsubscribeStore = itemStore?.subscribe((next) => {
      storedItems = next;
    });
  }
  $: effectiveItems = itemStore ? storedItems : items;
  $: queueDisplayedItems(effectiveItems);
  $: evolution = displayedItems.length
    ? tracker.update(displayedItems)
    : emptyEvolution;
  $: updateJuiceImpact(evolution.totals);
  $: scopedEvolution = scopeSessionArtifactEvolution(evolution, artifactScope);
  $: filteredEvolution = filterSessionArtifactEvolution(scopedEvolution, artifactFilter);
  $: overbooking = analyzeSessionArtifactOverbooking(scopedEvolution.turns);
  $: artifactRows = buildSparseArtifactRows(filteredEvolution.artifacts, worktreePath);
  $: fileCount = artifactRows.filter((row) => row.kind === "file").length;
  $: evolutionWindow = sessionArtifactTurnWindow(filteredEvolution.turns, visibleTurnLimit);

  function turnCounts(turn: (typeof evolution.turns)[number]): string {
    const { reads, references, writes } = sessionArtifactTurnCounts(turn);
    return [reads ? `${reads} read${reads === 1 ? "" : "s"}` : "", references ? `${references} ref${references === 1 ? "" : "s"}` : "", writes ? `${writes} write${writes === 1 ? "" : "s"}` : ""]
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

  onDestroy(() => {
    unsubscribeStore?.();
    if (itemUpdateTimer !== undefined) clearTimeout(itemUpdateTimer);
  });
</script>

<section
  class="artifact-map-panel"
  class:artifact-juice={juiceEnabled}
  class:artifact-read-impact-a={juiceEnabled && readImpactCount > 0 && readImpactCount % 2 === 1}
  class:artifact-read-impact-b={juiceEnabled && readImpactCount > 0 && readImpactCount % 2 === 0}
  class:artifact-write-impact-a={juiceEnabled && writeImpactCount > 0 && writeImpactCount % 2 === 1}
  class:artifact-write-impact-b={juiceEnabled && writeImpactCount > 0 && writeImpactCount % 2 === 0}
>
  <InspectorPanelHeader
    title="Artifact Map"
    subtitle={`${fileCount} files`}
    draggable={!!onDragStart}
    {onDragStart}
  >
    <button
      type="button"
      class="artifact-scope"
      class:selected={artifactScope === "consolidated"}
      on:click={() => (artifactScope = "consolidated")}
    >Consolidated</button>
    <button
      type="button"
      class="artifact-scope"
      class:selected={artifactScope === "current"}
      on:click={() => (artifactScope = "current")}
    >Current turn</button>
    {#if onClose}
      <button type="button" class="icon-only" on:click={onClose} aria-label="Close artifact map">×</button>
    {/if}
  </InspectorPanelHeader>

  <div class="artifact-map-summary">
    <div class="artifact-map-filters" role="group" aria-label="Filter artifact activity">
      <button type="button" class:selected={artifactFilter === "all"} on:click={() => (artifactFilter = "all")}>All</button>
      <button type="button" class:selected={artifactFilter === "reads"} on:click={() => (artifactFilter = "reads")}>Reads {scopedEvolution.totals.reads}</button>
      <button type="button" class:selected={artifactFilter === "references"} on:click={() => (artifactFilter = "references")}>References {scopedEvolution.totals.references}</button>
      <button type="button" class:selected={artifactFilter === "writes"} on:click={() => (artifactFilter = "writes")}>Writes {scopedEvolution.totals.writes}</button>
      <button type="button" class:selected={artifactFilter === "partial-writes"} on:click={() => (artifactFilter = "partial-writes")}>Partial {scopedEvolution.totals.partialWrites}</button>
      <button type="button" class:selected={artifactFilter === "repeated"} on:click={() => (artifactFilter = "repeated")}>Repeated {overbooking.repeatedReads}</button>
    </div>
    <div class="artifact-map-filter-details">
      {#if artifactFilter !== "writes"}<span>{filteredEvolution.totals.partialReads} ranged</span>{/if}
      {#if artifactFilter !== "reads" && artifactFilter !== "partial-writes"}<span>{filteredEvolution.totals.partialWrites} partial writes</span>{/if}
      {#if filteredEvolution.totals.additions || filteredEvolution.totals.deletions}
        <span class="artifact-map-lines">+{filteredEvolution.totals.additions} −{filteredEvolution.totals.deletions}</span>
      {/if}
    </div>
    {#if overbooking.repeatedReads > 0}
      <details class="artifact-map-overbooking">
        <summary>{overbooking.repeatedReads} potentially redundant {overbooking.repeatedReads === 1 ? "read" : "reads"}</summary>
        <p>Same file range read again in a later turn without an intervening write.</p>
        <ol>
          {#each overbooking.files as file (file.path)}
            <li>
              <span title={file.path}>{file.path}</span>
              <strong>{file.repeatedReads}× repeated</strong>
              <small>{file.ranges.filter((range) => range.repeatedReads > 0).map((range) => `${range.range} (${range.repeatedReads}×)`).join(" · ")}</small>
            </li>
          {/each}
        </ol>
      </details>
    {/if}
  </div>

  <div class="artifact-map-body">
    {#if filteredEvolution.artifacts.length === 0}
      <p class="artifact-map-empty">No {artifactFilter === "all" ? "file activity" : artifactFilter === "repeated" ? "potentially redundant reads" : artifactFilter.replace("-", " ")} yet.</p>
    {:else}
      <section class="artifact-map-overall">
        <h3>{artifactScope === "consolidated" ? "Consolidated" : "Current turn"}</h3>
        <SparseArtifactTree
          artifacts={filteredEvolution.artifacts}
          rows={artifactRows}
          lazyContent={true}
          {worktreePath}
          {daemonId}
        />
      </section>

      {#if artifactScope === "consolidated"}
        <details class="artifact-map-timeline" bind:open={evolutionOpen}>
          <summary>Evolution</summary>
          {#if evolutionOpen}
            {#if evolutionWindow.hiddenTurnCount > 0}
              <button class="artifact-map-show-earlier" type="button" on:click={() => (visibleTurnLimit += 200)}>
                Show {Math.min(200, evolutionWindow.hiddenTurnCount)} earlier turns
              </button>
            {/if}
            {#each evolutionWindow.turns as turn (turn.turnNumber)}
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
          {/if}
        </details>
      {/if}
    {/if}
  </div>
</section>

<style>
  .artifact-map-panel {
    position: relative;
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
  .artifact-map-panel.artifact-juice {
    box-shadow: inset 0 0 22px rgb(255 139 42 / 7%);
  }
  .artifact-map-panel.artifact-juice::after {
    content: "";
    position: absolute;
    inset: 0;
    border: 1px solid rgb(255 178 69 / 22%);
    pointer-events: none;
  }
  :global(.artifact-scope.selected) {
    border-color: var(--accent, #6aa9ff);
    color: var(--text-1);
    background: color-mix(in srgb, var(--accent, #6aa9ff) 18%, var(--surface-2));
  }
  .artifact-read-impact-a,
  .artifact-read-impact-b {
    animation: artifact-read-impact 260ms ease-out;
  }
  .artifact-write-impact-a,
  .artifact-write-impact-b {
    animation: artifact-write-impact 360ms cubic-bezier(0.2, 0.9, 0.3, 1.3);
  }
  @keyframes artifact-read-impact {
    45% { box-shadow: inset 0 0 34px rgb(100 204 255 / 24%); }
  }
  @keyframes artifact-write-impact {
    40% { transform: translateX(2px); box-shadow: inset 0 0 44px rgb(255 128 35 / 32%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .artifact-read-impact-a,
    .artifact-read-impact-b,
    .artifact-write-impact-a,
    .artifact-write-impact-b { animation: none; }
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
  .artifact-map-overbooking {
    color: var(--text-2);
  }
  .artifact-map-overbooking > summary {
    color: var(--warning, #e7ad55);
    cursor: pointer;
  }
  .artifact-map-overbooking p {
    margin: 0.35rem 0;
    line-height: 1.35;
  }
  .artifact-map-overbooking ol {
    display: grid;
    gap: 0.3rem;
    max-height: 11rem;
    margin: 0.4rem 0 0;
    padding-left: 1.2rem;
    overflow: auto;
  }
  .artifact-map-overbooking li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.1rem 0.5rem;
  }
  .artifact-map-overbooking li > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artifact-map-overbooking li > small {
    grid-column: 1 / -1;
    color: var(--text-muted);
  }
  .artifact-map-lines {
    color: var(--success, #58d68d);
  }
  .artifact-map-body {
    min-height: 0;
    overflow: auto;
    padding: 0.65rem;
  }
  .artifact-map-body h3,
  .artifact-map-timeline > summary {
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
  .artifact-map-timeline > summary {
    cursor: pointer;
  }
  .artifact-map-show-earlier {
    width: 100%;
    margin: 0.4rem 0;
    padding: 0.35rem;
    border: 1px solid var(--surface-3);
    border-radius: 0.35rem;
    color: var(--text-muted);
    background: transparent;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
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
