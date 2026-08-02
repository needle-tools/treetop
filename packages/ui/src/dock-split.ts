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

/** Repo ids that currently have at least one *live* (non-exited)
 *  session dot in the dock.
 *
 *  Gates the pull (↓ "behind") arrows: upstream commits are only
 *  actionable while you actually have a session open in that repo, so
 *  a repo you aren't working in right now just adds a nagging animated
 *  arrow to the strip. Push (↑) and dirty markers are unaffected —
 *  those are *your* unshipped work and stay visible everywhere. */
export function reposWithLiveSessions<T extends SplittableDockEntry>(
  entries: T[],
): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) if (!e.exited) ids.add(e.repoId);
  return ids;
}

/** How far (px, + = down) to nudge the dock on top of its
 *  `translateY(-50%)` so the *centre toggle* lands on the viewport
 *  centre rather than the column's midpoint.
 *
 *  The toggle sits between the live stack and the inactive one, so its
 *  position in the flow depends on how many dots are in each. Hide the
 *  inactive dots and the bottom stack empties — the "centre" toggle
 *  then dangles at the very bottom of the strip. This nudge re-pins it
 *  without splitting the column back into two scrollers.
 *
 *  `toggleCenter` is measured *relative to the dock's own box*, not
 *  the viewport, so the shift already applied cancels out of the
 *  measurement — the result is absolute and re-measuring mid-glide
 *  can't feed back on itself.
 *
 *  The nudge is clamped so the column can never run off a viewport
 *  edge, and disabled entirely once the column is taller than the
 *  viewport (then it fills the screen and the single scroll column
 *  owns the layout). That clamp has a deliberate consequence: pinning
 *  a *last-row* toggle to the centre requires the whole column to fit
 *  in the top half of the screen, so a tall dock with the inactive
 *  stack hidden ends up with the toggle below centre. That's the
 *  accepted trade — nudging further would push the top dots
 *  off-screen with nothing to scroll them back (the container is
 *  sized to content, so it never overflows). A hard 50vh pin needs
 *  the two-independently-scrolling-halves layout, which we gave up
 *  for the single scrollbar; don't reintroduce it by loosening this
 *  clamp. */
export function dockToggleOffset(opts: {
  viewportHeight: number;
  dockHeight: number;
  /** Centre of the toggle, measured from the dock's top edge. */
  toggleCenter: number;
}): number {
  const { viewportHeight, dockHeight, toggleCenter } = opts;
  if (dockHeight >= viewportHeight) return 0;
  const wanted = dockHeight / 2 - toggleCenter;
  const slack = (viewportHeight - dockHeight) / 2;
  return Math.max(-slack, Math.min(slack, wanted));
}

export function shouldMeasureDockBackdrop(
  showLabels: boolean,
  dotCount: number,
): boolean {
  return showLabels && dotCount > 0;
}
