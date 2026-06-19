<script lang="ts">
  /**
   * Inline fuzzy picker for the mention/link family. Renders as a
   * self-contained block (search input + grouped result list);
   * the parent positions it (inside a chip in edit mode today,
   * floating near a caret tomorrow). Keyboard-first: ArrowUp/Down
   * to navigate, Enter to pick, Esc to cancel.
   *
   * The component is *display only* — providers do the data work,
   * the recents store handles persistence. That keeps this file
   * small enough to read in one screen and reusable across call
   * sites without needing to know what providers are connected.
   */

  import { onMount, createEventDispatcher } from "svelte";
  import type { PickItem, Provider, SearchScope } from "./mention-types";
  import { recents } from "./mention-recents";
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";

  export let providers: Provider[];
  export let scope: SearchScope = {};
  /** How many recents per provider to show when the query is empty.
   *  4 is the consistent default across the app (per the design
   *  brief); call sites should rarely need to override. */
  export let emptyCountPerProvider: number = 4;
  /** How many search results per provider to show when typing. */
  export let resultCountPerProvider: number = 6;
  export let placeholder: string = "Search sessions, commits…";
  export let autofocus: boolean = true;
  /** Embedded mode: caller drives query + keyboard externally. Used by
   *  the note-body `@`-mention flow where the textarea stays focused
   *  and forwards typing/arrow-keys/Enter/Esc into us via bind:this.
   *  When set, the input element is hidden and `externalQuery` is the
   *  source of truth for the search string. */
  export let hideInput: boolean = false;
  export let externalQuery: string = "";

  const dispatch = createEventDispatcher<{
    pick: PickItem;
    cancel: void;
  }>();

  let inputEl: HTMLInputElement | null = null;
  let query = "";
  $: effectiveQuery = hideInput ? externalQuery : query;
  /** Flat list in render order — recomputed reactively from `query`
   *  + provider results + recents. The flat shape is what makes
   *  arrow-key navigation trivial: just index into one array. */
  let visibleItems: PickItem[] = [];
  /** Render order: each entry is a group heading followed by some
   *  items. Items reference `visibleItems` indices so the keyboard
   *  cursor and click handler agree. */
  interface Group {
    label: string;
    /** Indices into `visibleItems`. */
    indices: number[];
  }
  let groups: Group[] = [];
  let cursor = 0;
  /** Bump on every keystroke so an out-of-order async provider
   *  response can be dropped. Without this a slow /api/commits
   *  could land after the user has typed past it, wiping a fresher
   *  result set. */
  let queryEpoch = 0;
  /** Distinguish "nothing matched" from "still loading" — only
   *  paint the empty-state message once we've heard from every
   *  provider at least once for the current query. */
  let queryLoadedEpoch = -1;
  /** Are we currently waiting on at least one provider for the
   *  current query? Drives the spinner + the "Searching…" empty
   *  state. Set true synchronously when the reactive query change
   *  fires, cleared by buildEmpty/SearchView when the epoch they
   *  observed is still the latest one. Without this the spinner
   *  would flicker off briefly between user keystrokes because the
   *  intermediate epochs (whose responses we drop) wouldn't clear
   *  it themselves. */
  let loading = false;

  /** Empty-query path: ask every provider for its top-N most-recent
   *  items (search with `""` is treated as "match everything" by the
   *  scorer, so the result is each provider's data sorted by date).
   *  If localStorage has any prior picks for a provider, those are
   *  prepended to that provider's section, deduped by `value` so a
   *  recent pick never appears twice in the same group. */
  async function buildEmptyView(epoch: number): Promise<void> {
    const results = await Promise.all(
      providers.map((p) =>
        p
          .search("", scope, emptyCountPerProvider)
          .catch(() => [] as PickItem[]),
      ),
    );
    if (epoch !== queryEpoch) return;
    const flat: PickItem[] = [];
    const grp: Group[] = [];
    providers.forEach((p, i) => {
      // Filter the recents-store entries through the provider's
      // `inScope` predicate (when present). The store is global, so
      // without this a session pick from another worktree would
      // surface here as if it belonged — which then renders a link
      // that doesn't open in the current strip.
      const rawRecents = $recents[p.id] ?? [];
      const recentsForP = p.inScope
        ? rawRecents.filter((r) => p.inScope!(r, scope))
        : rawRecents;
      const fresh = results[i] ?? [];
      // Recents first (capped to half the slot), then fresh items
      // filling the rest. Dedup so a recently-picked item never
      // shows up twice in the same group.
      const recentSlice = recentsForP.slice(
        0,
        Math.max(1, Math.floor(emptyCountPerProvider / 2)),
      );
      const recentValues = new Set(recentSlice.map((it) => it.value));
      const freshFiltered = fresh.filter((it) => !recentValues.has(it.value));
      const merged = [...recentSlice, ...freshFiltered].slice(
        0,
        emptyCountPerProvider,
      );
      if (merged.length === 0) return;
      const indices: number[] = [];
      for (const it of merged) {
        indices.push(flat.length);
        flat.push(it);
      }
      grp.push({ label: `Recent ${p.label.toLowerCase()}`, indices });
    });
    visibleItems = flat;
    groups = grp;
    cursor = 0;
    queryLoadedEpoch = epoch;
    if (epoch === queryEpoch) loading = false;
  }

  /** Search path: query each provider in parallel, then assemble in
   *  `providers` order. Latest queryEpoch wins — earlier responses
   *  are dropped. */
  async function buildSearchView(q: string, epoch: number): Promise<void> {
    const results = await Promise.all(
      providers.map((p) =>
        p
          .search(q, scope, resultCountPerProvider)
          .catch(() => [] as PickItem[]),
      ),
    );
    if (epoch !== queryEpoch) return; // stale; user typed more.
    const flat: PickItem[] = [];
    const grp: Group[] = [];
    providers.forEach((p, i) => {
      const items = results[i] ?? [];
      if (items.length === 0) return;
      const indices: number[] = [];
      for (const it of items) {
        indices.push(flat.length);
        flat.push(it);
      }
      grp.push({ label: p.label, indices });
    });
    visibleItems = flat;
    groups = grp;
    cursor = 0;
    queryLoadedEpoch = epoch;
    if (epoch === queryEpoch) loading = false;
  }

  $: {
    // Reactive on `effectiveQuery`, `$recents`, providers, scope. Both
    // paths are async (the empty path also fires provider.search to fill
    // a "recent items by date" baseline), and the epoch guard
    // handles out-of-order responses uniformly.
    void $recents;
    void providers;
    void scope;
    queryEpoch++;
    const epoch = queryEpoch;
    const q = effectiveQuery.trim();
    // Loading flag flips on synchronously so the spinner appears
    // immediately when the user opens the picker / types a new
    // query — the fetch's own resolution clears it. Keeping it on
    // through the entire pending-window means the picker reads as
    // "still working" even if a stale response landed earlier.
    loading = true;
    if (q.length === 0) {
      void buildEmptyView(epoch);
    } else {
      void buildSearchView(q, epoch);
    }
  }

  function pickCurrent(): void {
    const it = visibleItems[cursor];
    if (!it) return;
    dispatch("pick", it);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (visibleItems.length === 0) return;
      cursor = (cursor + 1) % visibleItems.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (visibleItems.length === 0) return;
      cursor = (cursor - 1 + visibleItems.length) % visibleItems.length;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pickCurrent();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dispatch("cancel");
      return;
    }
  }

  /** Public handles for embedded mode. The note-body `@`-mention flow
   *  keeps focus on the textarea, then forwards arrow/enter keystrokes
   *  in via these — the picker itself never sees the keyboard. */
  export function moveCursor(delta: number): void {
    if (visibleItems.length === 0) return;
    cursor = (cursor + delta + visibleItems.length) % visibleItems.length;
  }
  export function commitCurrent(): boolean {
    if (!visibleItems[cursor]) return false;
    pickCurrent();
    return true;
  }
  export function hasResults(): boolean {
    return visibleItems.length > 0;
  }

  onMount(() => {
    if (autofocus && inputEl && !hideInput) {
      inputEl.focus();
    }
  });
</script>

<div
  class="mention-picker"
  role="combobox"
  aria-controls="mention-picker-list"
  aria-expanded="true"
>
  <!-- Input + inline spinner. The spinner only renders while a
       provider fetch is in flight, sits absolute over the input's
       right edge, and disappears the moment results land. This is
       the affordance the user was missing — the picker used to look
       "broken" on first open because the empty-state message
       appeared before /api/agents and /api/commits returned.
       Hidden in embedded mode — the host (e.g. note textarea
       `@`-mention flow) keeps its own focus and feeds us the query
       via `externalQuery`. -->
  {#if !hideInput}
    <div class="mention-picker-input-wrap">
      <input
        bind:this={inputEl}
        bind:value={query}
        on:keydown={onKey}
        type="text"
        {placeholder}
        spellcheck="false"
        autocomplete="off"
        class="mention-picker-input"
        aria-label="Search"
      />
      {#if loading}
        <span class="mention-picker-spinner-slot">
          <LoadingSpinner size="14px" label="Searching" />
        </span>
      {/if}
    </div>
  {/if}
  <div id="mention-picker-list" class="mention-picker-list" role="listbox">
    {#if visibleItems.length === 0}
      <div class="mention-picker-empty">
        {#if loading}
          <span class="mention-picker-empty-spinner">
            <LoadingSpinner size="12px" label="Loading" />
          </span>
          Loading recent picks…
        {:else if query.trim().length === 0}
          No recent picks yet — start typing to search.
        {:else}
          No matches.
        {/if}
      </div>
    {:else}
      {#each groups as g (g.label)}
        <div class="mention-picker-group-label">{g.label}</div>
        {#each g.indices as idx}
          {@const it = visibleItems[idx]}
          {#if it}
            <!-- `.attach-row` is the shared layout class — same one the
                 sticky-link chip uses in view mode. `.mention-picker-row`
                 only adds the dropdown's active/focus highlight. Any
                 layout tweak ("widen meta", "shrink icon", etc.) goes
                 into `.attach-row` and lands in both surfaces. -->
            <button
              type="button"
              class="mention-picker-row attach-row"
              class:active={idx === cursor}
              on:mouseenter={() => (cursor = idx)}
              on:mousedown|preventDefault={() => dispatch("pick", it)}
              role="option"
              aria-selected={idx === cursor}
            >
              <span class="attach-row-icon" aria-hidden="true">
                <AttachmentIcon
                  agent={it.agent ?? ""}
                  provider={it.provider ?? ""}
                  glyph={it.providerId === "commits" ? "◆" : "·"}
                  size={14}
                />
              </span>
              <span class="attach-row-label">{it.label}</span>
              {#if it.meta || it.subtitle}
                <!-- Trailing meta slot — collapses subtitle + meta into
                     one span so the title column gets the rest of the
                     row width. Matches the saved chip's .attach-card
                     layout so picker rows + saved chips read the same. -->
                <span class="attach-row-meta">
                  {#if it.meta}{it.meta}{/if}
                  {#if it.meta && it.subtitle}
                    ·
                  {/if}
                  {#if it.subtitle}{it.subtitle}{/if}
                </span>
              {/if}
            </button>
          {/if}
        {/each}
      {/each}
    {/if}
  </div>
</div>
