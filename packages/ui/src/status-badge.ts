/**
 * StatusBadge logic — pulled out of `StatusBadge.svelte` so the
 * priority-pick can be unit-tested without standing up the component
 * + DOM. The Svelte template still owns the actual rendering; it
 * just calls `pickBadgeKind` once and switches on the result.
 */

export type BadgeKind = "ahead" | "behind" | "dirty" | null;

/**
 * Priority-pick of the single signal to surface when a worktree has
 * multiple non-zero counts at once. Matches the long-standing
 * convention used across the dashboard:
 *
 *   1. unpushed commits  ↑N  (highest — "your work, ship it")
 *   2. behind upstream   ↓N  ("pull or merge before you push")
 *   3. dirty workdir     ~N  ("uncommitted changes")
 *
 * Negative counts are treated the same as zero — guards against
 * silly inputs from upstream callers, since git itself never
 * surfaces negative ahead/behind/dirty counts.
 */
export function pickBadgeKind(
  ahead: number,
  behind: number,
  dirty: number,
): BadgeKind {
  if (ahead > 0) return "ahead";
  if (behind > 0) return "behind";
  if (dirty > 0) return "dirty";
  return null;
}
