<script lang="ts">
  import { onDestroy } from "svelte";
  import InspectorPanelHeader from "./InspectorPanelHeader.svelte";
  import SparseArtifactTree from "./SparseArtifactTree.svelte";
  import { apiUrl } from "./api";
  import {
    parseSessionContextBlob,
    sessionContextTreeArtifacts,
  } from "./session-context-source";
  import {
    estimateSessionContextTokens,
    mergeSessionContextTimelines,
    sessionContextItemLabel,
    sessionContextStateAtLine,
    type SessionContextItem,
    type SessionContextState,
    type SessionContextTimeline,
  } from "@treetop/nicifier";

  export let source = "";
  export let sourceBlob: Blob | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let sourceLine = Number.POSITIVE_INFINITY;
  export let onClose: (() => void) | undefined = undefined;
  export let onDragStart: ((event: DragEvent) => void) | undefined = undefined;

  let timeline: SessionContextTimeline | undefined;
  let state: SessionContextState | undefined;
  let loading = false;
  let error = "";
  let progress = 0;
  let loadedKey = "";
  let loadedBlob: Blob | undefined;
  let loadGeneration = 0;
  let loadedBytes = 0;
  let loadedLineCount = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let query = "";
  let visibleLimit = 300;
  let displayedSourceLine = sourceLine;
  let pendingSourceLine = sourceLine;
  let sourceLineTimer: ReturnType<typeof setTimeout> | undefined;
  let pinnedLine: number | undefined;

  function queueSourceLine(next: number): void {
    pendingSourceLine = next;
    if (sourceLineTimer !== undefined || next === displayedSourceLine) return;
    sourceLineTimer = setTimeout(() => {
      sourceLineTimer = undefined;
      displayedSourceLine = pendingSourceLine;
    }, 100);
  }

  async function loadContext(): Promise<void> {
    if ((!sourceBlob && !source) || (sourceBlob ? sourceBlob === loadedBlob : source === loadedKey && !loadedBlob)) return;
    loadedBlob = sourceBlob;
    loadedKey = source;
    const generation = ++loadGeneration;
    loading = true;
    error = "";
    progress = 0;
    loadedBytes = 0;
    loadedLineCount = 0;
    timeline = undefined;
    try {
      let blob: Pick<Blob, "size" | "stream">;
      if (sourceBlob) {
        blob = sourceBlob;
      } else {
        const response = await fetch(apiUrl(`/api/session/source?source=${encodeURIComponent(source)}`, daemonId));
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Could not read session context (${response.status})`);
        }
        const size = Number(response.headers.get("content-length")) || 0;
        const stream = response.body;
        blob = { size, stream: () => stream };
      }
      const parsed = await parseSessionContextBlob(blob, (read, total) => {
        if (generation === loadGeneration && total > 0) progress = read / total;
      });
      if (generation !== loadGeneration) return;
      timeline = parsed.timeline;
      loadedBytes = blob.size;
      loadedLineCount = parsed.lineCount;
      if (!sourceBlob) scheduleRefresh(generation);
    } catch (cause) {
      if (generation === loadGeneration) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function scheduleRefresh(generation: number): void {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshContext(generation), 2000);
  }

  async function refreshContext(generation: number): Promise<void> {
    if (generation !== loadGeneration || sourceBlob || !source) return;
    try {
      const response = await fetch(apiUrl(`/api/session/source?source=${encodeURIComponent(source)}&offset=${loadedBytes}`, daemonId));
      if (!response.ok || !response.body) return;
      const totalSize = Number(response.headers.get("x-session-size")) || loadedBytes;
      if (totalSize < loadedBytes) {
        loadedKey = "";
        loadedBlob = undefined;
        await loadContext();
        return;
      }
      const addedBytes = totalSize - loadedBytes;
      if (addedBytes > 0) {
        const stream = response.body;
        const parsed = await parseSessionContextBlob(
          { size: addedBytes, stream: () => stream },
          undefined,
          loadedLineCount,
        );
        timeline = mergeSessionContextTimelines(timeline, parsed.timeline);
        loadedBytes = totalSize;
        loadedLineCount = parsed.lineCount;
      }
    } finally {
      if (generation === loadGeneration) scheduleRefresh(generation);
    }
  }

  function searchable(item: SessionContextItem): string {
    try {
      return `${sessionContextItemLabel(item)}\n${JSON.stringify(item.value)}`.toLowerCase();
    } catch {
      return sessionContextItemLabel(item).toLowerCase();
    }
  }

  function pinContextLine(event: Event): void {
    pinnedLine = Number((event.currentTarget as HTMLInputElement).value);
  }

  $: void loadContext();
  $: queueSourceLine(sourceLine);
  $: latestSourceLine = timeline?.events.at(-1)?.sourceLine ?? 0;
  $: contextLine = pinnedLine ?? displayedSourceLine;
  $: resolvedContextLine = Number.isFinite(contextLine) ? contextLine : latestSourceLine;
  $: state = timeline ? sessionContextStateAtLine(timeline, resolvedContextLine) : undefined;
  $: matchingItems = state
    ? query.trim()
      ? state.items.filter((item) => searchable(item).includes(query.trim().toLowerCase()))
      : state.items
    : [];
  $: hiddenItemCount = Math.max(0, matchingItems.length - visibleLimit);
  $: visibleItems = hiddenItemCount > 0 ? matchingItems.slice(hiddenItemCount) : matchingItems;
  $: treeArtifacts = state
    ? sessionContextTreeArtifacts(state, visibleItems, hiddenItemCount)
    : [];
  $: estimatedTokens = state ? estimateSessionContextTokens(state) : 0;

  onDestroy(() => {
    loadGeneration += 1;
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    if (sourceLineTimer !== undefined) clearTimeout(sourceLineTimer);
  });
</script>

<section class="session-context-panel">
  <InspectorPanelHeader
    title="Context"
    subtitle={state ? `${state.items.length.toLocaleString()} items · ~${estimatedTokens.toLocaleString()} tokens` : loading ? `${Math.round(progress * 100)}%` : ""}
    draggable={!!onDragStart}
    {onDragStart}
  >
    {#if onClose}<button type="button" class="icon-only" on:click={onClose} aria-label="Close context view">×</button>{/if}
  </InspectorPanelHeader>

  {#if loading}
    <div class="context-state"><progress value={progress} max="1"></progress><span>Reading recorded context…</span></div>
  {:else if error}
    <div class="context-state context-error">{error}</div>
  {:else if state}
    <div class="context-toolbar">
      <input bind:value={query} type="search" placeholder="Search current context" aria-label="Search current context" />
      <span>line {resolvedContextLine.toLocaleString()}</span>
      <input class="context-timeline" type="range" min="0" max={latestSourceLine} value={resolvedContextLine} on:input={pinContextLine} aria-label="Context point in session" />
      {#if pinnedLine !== undefined}<button type="button" on:click={() => (pinnedLine = undefined)}>{Number.isFinite(displayedSourceLine) ? "Follow replay" : "Latest"}</button>{/if}
    </div>
    <div class="context-body">
      <p class="context-scope">
        {state.completeness === "recorded" ? "Recorded request input" : "Reconstructable conversation context"}
        {#if state.compactionCount} · after {state.compactionCount} {state.compactionCount === 1 ? "compaction" : "compactions"}{/if}
      </p>
      {#if state.limitations.length}
        <details class="context-limitations"><summary>What the log cannot show</summary><ul>{#each state.limitations as limitation}<li>{limitation}</li>{/each}</ul></details>
      {/if}
      {#if hiddenItemCount > 0}
        <button type="button" class="show-earlier" on:click={() => (visibleLimit += 300)}>Show {Math.min(300, hiddenItemCount)} earlier items</button>
      {/if}
      <SparseArtifactTree artifacts={treeArtifacts} showActions={false} lazyContent={true} />
    </div>
  {:else}
    <div class="context-state">No transcript source is available for this replay.</div>
  {/if}
</section>

<style>
  .session-context-panel { display: grid; grid-template-rows: auto auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: var(--text-1); background: var(--surface-1); }
  .context-state { display: grid; gap: 0.6rem; place-content: center; height: 100%; padding: 1rem; color: var(--text-muted); font-size: 0.78rem; text-align: center; }
  .context-error { color: var(--danger, #ef7777); }
  .context-toolbar { display: grid; grid-template-columns: auto minmax(3.5rem, 1fr) auto; align-items: center; gap: 0.45rem; padding: 0.5rem 0.65rem; border-bottom: 1px solid var(--surface-3); }
  .context-toolbar input[type="search"] { grid-column: 1 / -1; min-width: 0; padding: 0.35rem 0.5rem; border: 1px solid var(--surface-3); border-radius: 0.35rem; color: inherit; background: var(--surface-2); font: inherit; }
  .context-toolbar .context-timeline { width: 100%; min-width: 3.5rem; }
  .context-toolbar button { padding: 0.25rem 0.4rem; border: 1px solid var(--surface-3); border-radius: 0.3rem; color: var(--text-2); background: transparent; font: inherit; font-size: 0.65rem; white-space: nowrap; cursor: pointer; }
  .context-toolbar span { color: var(--text-muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .context-body { min-height: 0; overflow: auto; padding: 0.65rem; }
  .context-scope { margin: 0 0 0.55rem; color: var(--text-muted); font-size: 0.72rem; }
  details { border-bottom: 1px solid var(--surface-3); }
  summary { padding: 0.45rem 0; color: var(--text-2); font-size: 0.75rem; cursor: pointer; }
  .context-limitations { color: var(--text-muted); font-size: 0.68rem; }
  .context-limitations ul { margin: 0 0 0.55rem; padding-left: 1.15rem; }
  .show-earlier { width: 100%; margin: 0.45rem 0; padding: 0.4rem; border: 1px solid var(--surface-3); border-radius: 0.35rem; color: var(--text-muted); background: transparent; cursor: pointer; }
</style>
