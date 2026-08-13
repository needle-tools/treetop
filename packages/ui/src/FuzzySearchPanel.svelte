<script lang="ts">
  import { createEventDispatcher, onMount, tick } from "svelte";
  import {
    nextSearchKindsSelection,
    searchItems,
    type SearchItem,
    type SearchKind,
    type SearchResult,
  } from "./workspace-search";

  export let items: SearchItem[] = [];
  export let query = "";
  export let placeholder = "Search";
  export let mode: "popover" | "omnibar" = "popover";
  export let maxResults = 80;
  export let autofocus = true;
  export let initialKinds: SearchKind[] | null = null;
  export let activeKinds: SearchKind[] | null = initialKinds;
  export let showKindFilters = false;
  export let emptyLabel = "No matches.";

  const dispatch = createEventDispatcher<{
    pick: SearchItem;
    close: void;
  }>();

  const kindLabels: Record<SearchKind, string> = {
    action: "Actions",
    project: "Projects",
    session: "Sessions",
    snippet: "Snippets",
    note: "Notes",
    readme: "READMEs",
    proc: "Procs",
    event: "Events",
  };

  let inputEl: HTMLInputElement | null = null;
  let resultsEl: HTMLUListElement | null = null;
  let activeIndex = 0;
  let activeItemId = "";
  let previousResultsKey = "";
  let initialKindsKey = initialKinds?.join("|") ?? "";

  $: {
    const nextInitialKindsKey = initialKinds?.join("|") ?? "";
    if (nextInitialKindsKey !== initialKindsKey) {
      initialKindsKey = nextInitialKindsKey;
      activeKinds = initialKinds;
    }
  }
  $: selectedKindSet =
    activeKinds && activeKinds.length > 0 ? new Set(activeKinds) : null;
  $: kindSet = selectedKindSet ?? undefined;
  $: results = searchItems(items, query, {
    kinds: kindSet,
    limit: maxResults,
  });
  $: {
    const resultsKey = results.map((result) => result.item.id).join("\n");
    if (resultsKey !== previousResultsKey) {
      previousResultsKey = resultsKey;
      const stableIndex = activeItemId
        ? results.findIndex((result) => result.item.id === activeItemId)
        : -1;
      activeIndex =
        stableIndex >= 0
          ? stableIndex
          : Math.min(activeIndex, Math.max(0, results.length - 1));
      activeItemId = results[activeIndex]?.item.id ?? "";
    }
  }
  $: availableKinds = (
    [
      "action",
      "project",
      "session",
      "snippet",
      "note",
      "readme",
      "proc",
      "event",
    ] as SearchKind[]
  ).filter((kind) => items.some((item) => item.kind === kind));

  onMount(() => {
    if (!autofocus) return;
    void tick().then(() => inputEl?.focus());
  });

  function itemIcon(kind: SearchKind): string {
    if (kind === "action") return "M8 2.5v11M2.5 8h11";
    if (kind === "project")
      return "M3 4.5h4l1 1.5h5v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 1 11.5v-5A2 2 0 0 1 3 4.5z";
    if (kind === "session") return "M2.5 3.5h11v7h-6l-3.5 3v-3H2.5z";
    if (kind === "snippet") return "M3 3h10M3 6h10M3 9h7M3 12h5";
    if (kind === "note") return "M4 3.5h8v7.5l-2 1.5H4zM6 6h4M6 8h3";
    if (kind === "readme")
      return "M4 3h5.5L12 5.5V13H4zM9.5 3v2.5H12M6 8h4M6 10h4";
    if (kind === "proc")
      return "M5 2.5h6v11H5zM2.5 5h2.5M2.5 8h2.5M2.5 11h2.5M11 5h2.5M11 8h2.5M11 11h2.5";
    return "M8 2.5v5l3.5 2M14 8A6 6 0 1 1 8 2";
  }

  function toggleKind(kind: SearchKind): void {
    activeKinds = nextSearchKindsSelection(activeKinds, kind);
  }

  function isKindActive(kind: SearchKind): boolean {
    return selectedKindSet ? selectedKindSet.has(kind) : false;
  }

  function pick(result: SearchResult): void {
    dispatch("pick", result.item);
  }

  function resultDomId(index: number): string {
    return `fuzzy-result-${mode}-${index}`;
  }

  function moveActive(delta: number): void {
    if (results.length === 0) return;
    activeIndex = Math.max(0, Math.min(results.length - 1, activeIndex + delta));
    activeItemId = results[activeIndex]?.item.id ?? "";
    scrollActiveResultIntoView();
  }

  function scrollActiveResultIntoView(): void {
    void tick().then(() => {
      const row = resultsEl?.querySelector<HTMLElement>(
        `[data-result-index="${activeIndex}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
    });
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query.trim().length > 0) {
        query = "";
        return;
      }
      dispatch("close");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === "Enter" && results[activeIndex]) {
      e.preventDefault();
      pick(results[activeIndex]);
    }
  }
</script>

<div class="fuzzy-panel fuzzy-panel-{mode}" on:keydown={onKeydown}>
  <div class="fuzzy-input-row">
    <svg class="fuzzy-search-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM13.5 13.5l-3-3"
      />
    </svg>
    <input
      bind:this={inputEl}
      type="search"
      bind:value={query}
      {placeholder}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={results.length > 0}
      aria-activedescendant={results[activeIndex]
        ? resultDomId(activeIndex)
        : undefined}
    />
    {#if showKindFilters && availableKinds.length > 1}
      <div class="fuzzy-kind-filters" aria-label="Search type filters">
        {#each availableKinds as kind}
          <button
            type="button"
            class:active={isKindActive(kind)}
            title={kindLabels[kind]}
            aria-label={kindLabels[kind]}
            on:click={() => toggleKind(kind)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d={itemIcon(kind)}
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if results.length === 0}
    <p class="fuzzy-empty">{emptyLabel}</p>
  {:else}
    <ul bind:this={resultsEl} class="fuzzy-results" role="listbox">
      {#each results as result, i (result.item.id)}
        <li>
          <button
            id={resultDomId(i)}
            type="button"
            data-result-index={i}
            class="fuzzy-result"
            class:active={i === activeIndex}
            aria-selected={i === activeIndex}
            role="option"
            on:mouseenter={() => {
              activeIndex = i;
              activeItemId = result.item.id;
            }}
            on:click={() => pick(result)}
          >
            <span
              class="fuzzy-result-icon"
              style:--item-color={result.item.color}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d={itemIcon(result.item.kind)}
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
            <span class="fuzzy-result-text">
              <span class="fuzzy-result-title">{result.item.title}</span>
              {#if result.item.subtitle || result.item.path}
                <span class="fuzzy-result-subtitle">
                  {result.item.subtitle || result.item.path}
                </span>
              {/if}
            </span>
            <span class="fuzzy-result-meta">
              {result.relativeTime ||
                result.item.meta ||
                kindLabels[result.item.kind]}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .fuzzy-panel {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 0.45rem;
  }

  .fuzzy-panel-omnibar {
    width: min(760px, calc(100vw - 2rem));
    max-height: min(620px, calc(100vh - 5rem));
    padding: 0.6rem;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface-1) 96%, black);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.52);
  }

  .fuzzy-input-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.45rem;
    min-height: 2.2rem;
    padding: 0.22rem 0.35rem;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-0);
  }

  .fuzzy-search-icon {
    width: 0.95rem;
    height: 0.95rem;
    color: var(--text-muted);
  }

  input {
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-1);
    font: inherit;
    font-size: 0.96rem;
  }

  input::placeholder {
    color: var(--text-muted);
  }

  input::-webkit-search-cancel-button {
    appearance: none;
  }

  .fuzzy-kind-filters {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }

  .fuzzy-kind-filters button {
    width: 1.6rem;
    height: 1.6rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    padding: 0;
    cursor: pointer;
  }

  .fuzzy-kind-filters button.active {
    color: var(--text-1);
    border-color: color-mix(in srgb, var(--accent) 55%, var(--surface-2));
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .fuzzy-kind-filters svg {
    width: 0.9rem;
    height: 0.9rem;
  }

  .fuzzy-results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .fuzzy-panel-popover .fuzzy-results {
    max-height: min(56vh, 430px);
  }

  .fuzzy-panel-omnibar .fuzzy-results {
    max-height: min(500px, calc(100vh - 9rem));
  }

  .fuzzy-result {
    width: 100%;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.55rem;
    padding: 0.42rem 0.45rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .fuzzy-result:hover,
  .fuzzy-result.active,
  .fuzzy-result:focus-visible {
    outline: none;
    background: color-mix(in srgb, var(--text-muted) 12%, transparent);
  }

  .fuzzy-result-icon {
    width: 1.35rem;
    height: 1.35rem;
    display: inline-grid;
    place-items: center;
    border-radius: 999px;
    color: var(--item-color, var(--text-muted));
    background: color-mix(in srgb, currentColor 10%, transparent);
  }

  .fuzzy-result-icon svg {
    width: 0.9rem;
    height: 0.9rem;
  }

  .fuzzy-result-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.08rem;
  }

  .fuzzy-result-title,
  .fuzzy-result-subtitle,
  .fuzzy-result-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fuzzy-result-title {
    font-size: 0.88rem;
    font-weight: 650;
  }

  .fuzzy-result-subtitle,
  .fuzzy-result-meta,
  .fuzzy-empty {
    color: var(--text-muted);
    font-size: 0.76rem;
  }

  .fuzzy-result-meta {
    max-width: 12rem;
    justify-self: end;
  }

  .fuzzy-empty {
    margin: 0;
    padding: 0.4rem 0.25rem;
  }
</style>
