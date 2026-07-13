/** Minimal shape the splitter needs per entry. The full DockEntry
 *  extends this — the splitter only touches repoId + exited. */
export interface SplittableDockEntry {
  repoId: string;
  source: string;
  exited: boolean;
}

/** Split dock entries into active/inactive buckets around the center
 *  toggle button for the vertical dock layout.
 *
 *  Rules:
 *   - Active entries stay above the centre toggle.
 *   - Inactive entries stay below the centre toggle when shown.
 *   - Each bucket preserves the caller's lane order exactly. */
export function splitDockEntries<T extends SplittableDockEntry>(
  entries: T[],
  showInactive: boolean,
): { top: T[]; bottom: T[] } {
  // Drop dupes by source before anything else — the dock template keys
  // `{#each split.top/bottom as e (e.source)}`, and Svelte's keyed each
  // throws `each_key_duplicate` if it ever sees the same key twice.
  // Upstream callers can leak dupes (the same real source filed under
  // two worktrees in `openSessionsByWt`, agent+shell with a colliding
  // source in pickerSessionsByWt, …); keeping the first occurrence
  // preserves the user's manual ordering.
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const e of entries) {
    if (seen.has(e.source)) continue;
    seen.add(e.source);
    deduped.push(e);
  }
  const active = deduped.filter((e) => !e.exited);
  const inactive = showInactive ? deduped.filter((e) => e.exited) : [];

  return { top: active, bottom: inactive };
}

export function shouldMeasureDockBackdrop(
  showLabels: boolean,
  dotCount: number,
): boolean {
  return showLabels && dotCount > 0;
}
