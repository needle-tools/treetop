/**
 * If `picked` is the worktree root, return "" (empty = repo dir).
 * If `picked` is inside the worktree `base`, return the path relative
 * to it (so command links are portable across worktrees of the same
 * repo). Otherwise return `picked` unchanged (absolute paths outside
 * the worktree are kept as-is).
 *
 * Comparison is case-insensitive (Windows-friendly) and tolerates
 * mixed `\` and `/` separators.
 */
export function relativizeToWorktree(picked: string, base: string): string {
  if (!picked || !base) return picked;
  const normPick = picked.replace(/\\/g, "/").replace(/\/+$/, "");
  const normBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normPick.toLowerCase() === normBase.toLowerCase()) return "";
  const prefix = normBase + "/";
  if (normPick.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normPick.slice(prefix.length);
  }
  return picked;
}
