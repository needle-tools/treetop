<script lang="ts">
  import { afterUpdate, onDestroy } from "svelte";
  import ContextFindBar from "./ContextFindBar.svelte";
  import {
    clearContextFindHighlights,
    collectContextFindRanges,
    installContextFindHighlights,
    registerContextFindScope,
    scrollContextFindRangeIntoView,
    type ContextFindKind,
  } from "./context-find";

  export let root: HTMLElement | null = null;
  export let kind: ContextFindKind;
  export let placeholder = "Find...";

  let registeredRoot: HTMLElement | null = null;
  let unregisterContextFind: (() => void) | null = null;
  let open = false;
  let query = "";
  let count = 0;
  let activeIndex = 0;
  let ranges: Range[] = [];
  let refreshRaf = 0;
  let previousQuery = "";

  export function openFind(): void {
    open = true;
    scheduleRefresh({ scrollActive: true });
  }

  function closeFind(): void {
    open = false;
    query = "";
    count = 0;
    activeIndex = 0;
    ranges = [];
    clearContextFindHighlights();
  }

  function ensureRegistered(): void {
    if (registeredRoot === root) return;
    unregisterContextFind?.();
    unregisterContextFind = null;
    registeredRoot = null;
    if (!root) return;
    registeredRoot = root;
    unregisterContextFind = registerContextFindScope(root, kind, openFind);
  }

  function scheduleRefresh(opts: { scrollActive?: boolean } = {}): void {
    if (refreshRaf) cancelAnimationFrame(refreshRaf);
    refreshRaf = requestAnimationFrame(() => {
      refreshRaf = 0;
      refresh(opts);
    });
  }

  function refresh(opts: { scrollActive?: boolean } = {}): void {
    if (!open || !root) return;
    const queryChanged = query !== previousQuery;
    previousQuery = query;
    ranges = collectContextFindRanges(root, query);
    count = ranges.length;
    if (queryChanged) activeIndex = 0;
    else if (activeIndex >= count) {
      activeIndex = Math.max(0, count - 1);
    }
    installContextFindHighlights(ranges, activeIndex);
    if ((opts.scrollActive || queryChanged) && ranges[activeIndex]) {
      scrollContextFindRangeIntoView(ranges[activeIndex]);
    }
  }

  function move(delta: number): void {
    if (count <= 0) return;
    activeIndex = (activeIndex + delta + count) % count;
    installContextFindHighlights(ranges, activeIndex);
    const range = ranges[activeIndex];
    if (range) scrollContextFindRangeIntoView(range);
  }

  afterUpdate(() => {
    ensureRegistered();
    if (open) scheduleRefresh();
  });

  onDestroy(() => {
    unregisterContextFind?.();
    unregisterContextFind = null;
    if (refreshRaf) cancelAnimationFrame(refreshRaf);
    if (open) clearContextFindHighlights();
  });
</script>

<ContextFindBar
  bind:open
  bind:query
  {count}
  {activeIndex}
  {placeholder}
  onPrevious={() => move(-1)}
  onNext={() => move(1)}
  onClose={closeFind}
/>
