/** Minimal shape the splitter needs per entry. The full DockEntry
 *  extends this — the splitter only touches repoId + exited. */
export interface SplittableDockEntry {
  repoId: string;
  source: string;
  exited: boolean;
}

/** Split dock entries into two halves (above / below the center
 *  toggle button) for the vertical dock layout.
 *
 *  Rules:
 *   - Entries from the same repo stay together (never split a
 *     repo group between top and bottom).
 *   - The split point is the repo-group boundary closest to the
 *     midpoint of the total entry count, so the two halves are
 *     as balanced as possible.
 *   - When `showInactive` is false, exited entries are filtered
 *     out before splitting.
 *   - Input order is preserved within each half. */
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
  const visible = showInactive ? deduped : deduped.filter((e) => !e.exited);

  if (visible.length === 0) return { top: [], bottom: [] };

  // Build repo-group boundaries: each group is a contiguous run of
  // entries sharing the same repoId. `ends[i]` is the exclusive
  // end-index of group i.
  const ends: number[] = [];
  let prev = "";
  for (let i = 0; i < visible.length; i++) {
    if (visible[i]!.repoId !== prev) {
      if (i > 0) ends.push(i);
      prev = visible[i]!.repoId;
    }
  }
  ends.push(visible.length);

  // Only one repo group → can't split, everything goes top.
  if (ends.length <= 1) {
    return { top: [...visible], bottom: [] };
  }

  // Find the group boundary closest to the midpoint.
  const mid = visible.length / 2;
  let bestEnd = ends[0]!;
  let bestDist = Math.abs(bestEnd - mid);
  for (let i = 1; i < ends.length - 1; i++) {
    const dist = Math.abs(ends[i]! - mid);
    if (dist < bestDist) {
      bestDist = dist;
      bestEnd = ends[i]!;
    }
  }

  return {
    top: visible.slice(0, bestEnd),
    bottom: visible.slice(bestEnd),
  };
}
