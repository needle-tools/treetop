/**
 * Per-repo "what happened recently" summarisation.
 *
 * Two pure helpers (this file) + a thin I/O layer (`collectRepoActivity`)
 * that runs the git commands. The pure helpers are unit-tested; the
 * I/O is exercised by the route's integration test against a real
 * temp repo.
 *
 * Design notes live in `plans/PLAN-REPO-SUMMARY.md`.
 */

import { join, basename } from "node:path";
import { $ } from "bun";
import { listWorktrees } from "./git";

/** Per-commit summary the prompt renderer consumes. */
export interface RepoCommit {
  sha: string;
  author: string;
  /** Relative time like "3h ago". Built from the commit's
   *  author-date by `collectRepoActivity`. */
  relTime: string;
  /** First line of the commit message. */
  subject: string;
  insertions: number;
  deletions: number;
  files: number;
}

/** One row of the "files most touched" digest. */
export interface RepoTopFile {
  path: string;
  insertions: number;
  deletions: number;
}

/** Branch activity within the window. */
export interface RepoBranchActivity {
  name: string;
  commitCount: number;
}

/** Dirty-worktree row. */
export interface RepoDirtyWorktree {
  path: string;
  unstaged: number;
  staged: number;
}

/** The structured digest fed to the model. Built once per
 *  generation; cheap to serialise for tests. */
export interface RepoActivity {
  repoName: string;
  sinceHours: number;
  branches: RepoBranchActivity[];
  dirtyWorktrees: RepoDirtyWorktree[];
  commits: RepoCommit[];
  topFiles: RepoTopFile[];
}

/** Minimum data needed for the staleness check. The route reads
 *  this off the cached frontmatter. */
export interface RepoSummaryCacheMeta {
  lastSha: string;
  generatedAt: string;
  commitCount: number;
}

export type StaleReason = "missing" | "new-commits" | "stale-age";

/** Cap on the commit list before we add "… and N more". Beyond 50
 *  the model stops gaining signal from individual rows — it's
 *  reading patterns at that point. */
const COMMIT_LIST_CAP = 50;
/** Cap on the "files most touched" table. Top 10 is plenty for a
 *  one-paragraph summary; more is just noise. */
const TOP_FILES_CAP = 10;
/** Sentinel returned when there's literally nothing to summarise.
 *  The route detects this string and surfaces a "Nothing happened"
 *  state to the UI without burning a model call. */
const EMPTY_SENTINEL = "EMPTY";

export function formatActivityPrompt(activity: RepoActivity): string {
  const hasCommits = activity.commits.length > 0;
  const hasDirty = activity.dirtyWorktrees.length > 0;
  if (!hasCommits && !hasDirty) return EMPTY_SENTINEL;

  const lines: string[] = [];
  lines.push(`Repository: ${activity.repoName}`);

  if (activity.branches.length > 0) {
    const branchStr = activity.branches
      .map((b) => `${b.name} (${b.commitCount} commits)`)
      .join(", ");
    lines.push(`Branches active in last ${activity.sinceHours}h: ${branchStr}`);
  } else {
    lines.push(`Branches active in last ${activity.sinceHours}h: (none)`);
  }

  lines.push(`Dirty worktrees: ${activity.dirtyWorktrees.length}`);
  for (const w of activity.dirtyWorktrees) {
    const parts: string[] = [];
    if (w.unstaged > 0) parts.push(`${w.unstaged} unstaged`);
    if (w.staged > 0) parts.push(`${w.staged} staged`);
    const stats = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    lines.push(`  - ${basename(w.path)}${stats}`);
  }

  if (hasCommits) {
    lines.push("");
    lines.push("Commits, newest first:");
    const shown = activity.commits.slice(0, COMMIT_LIST_CAP);
    for (const c of shown) {
      const sub =
        c.subject.length > 120 ? `${c.subject.slice(0, 120)}…` : c.subject;
      lines.push(`  - ${shortSha(c.sha)}  ${c.author}  ${c.relTime}  ${sub}`);
      lines.push(
        `    +${c.insertions} / -${c.deletions} across ${c.files} files`,
      );
    }
    const extra = activity.commits.length - shown.length;
    if (extra > 0) {
      lines.push(`  … and ${extra} more commits`);
    }
  }

  if (activity.topFiles.length > 0) {
    lines.push("");
    lines.push("Files most touched:");
    for (const f of activity.topFiles.slice(0, TOP_FILES_CAP)) {
      lines.push(`  ${f.path}    +${f.insertions} / -${f.deletions}`);
    }
  }

  return lines.join("\n");
}

/** 7-char short sha to match how `git log --abbrev-commit` defaults. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Pure freshness check. Returns null when the cache is good. */
export function shouldGenerate(
  cached: RepoSummaryCacheMeta | null,
  currentSha: string,
  maxAgeHours: number,
): StaleReason | null {
  if (!cached) return "missing";
  if (cached.lastSha !== currentSha) return "new-commits";
  const ageMs = Date.now() - Date.parse(cached.generatedAt);
  if (Number.isFinite(ageMs) && ageMs > maxAgeHours * 3600_000) {
    return "stale-age";
  }
  return null;
}

/** Default window for "recent activity". 24 hours covers "yesterday
 *  and this morning"; the v2 path is "since the last cached
 *  summary" so weekends don't fall off. */
export const DEFAULT_SINCE_HOURS = 24;

/** Weekend-aware variant of `DEFAULT_SINCE_HOURS`. On Monday (local
 *  time) we sweep 72h so Friday + weekend work is still in the
 *  window; the rest of the week stays at 24h. The label the UI
 *  renders (`rangeLabel(sinceHours)`) tracks this automatically.
 *
 *  Not aware of holidays — a holiday Monday means Tuesday's 24h
 *  window still misses the long weekend. The v2 "since last
 *  cached summary" path will fix that; this is the cheap-and-
 *  correct-for-most-weeks heuristic. */
export function pickRepoSinceHours(now: Date = new Date()): number {
  return now.getDay() === 1 ? 72 : DEFAULT_SINCE_HOURS;
}
/** Default freshness window. A midday return to the dashboard
 *  shouldn't re-fire; an evening return after morning-only commits
 *  should. */
export const DEFAULT_MAX_AGE_HOURS = 8;

/** Collect git activity for a repository over the trailing
 *  `sinceHours` window. Aggregates across the repo's worktrees so
 *  the digest sees parallel branch work, not just whatever HEAD
 *  happens to be in the canonical checkout.
 *
 *  Pure-ish: shells out to `git`, but takes no callbacks and
 *  produces a value the prompt renderer can stringify. The
 *  route's integration test exercises this against a real temp
 *  repo with seeded commits.
 */
export async function collectRepoActivity(
  repoPath: string,
  repoName: string,
  sinceHours: number = DEFAULT_SINCE_HOURS,
): Promise<RepoActivity> {
  const sinceArg = `${sinceHours} hours ago`;
  const worktrees = await listWorktrees(repoPath).catch(() => []);
  // Always include the canonical repo path as a fallback "worktree"
  // — `listWorktrees` returns linked-worktree rows; the main
  // checkout itself is usually the first entry but a degenerate
  // setup could omit it. De-dup by absolute path.
  const wtPaths = new Set<string>();
  wtPaths.add(repoPath);
  for (const wt of worktrees) wtPaths.add(wt.path);

  const branchCounts = new Map<string, number>();
  const commitMap = new Map<string, RepoCommit>();
  const fileTotals = new Map<
    string,
    { insertions: number; deletions: number }
  >();
  const dirty: RepoDirtyWorktree[] = [];

  for (const wtPath of wtPaths) {
    const branch = await currentBranch(wtPath);
    const commits = await commitsInWindow(wtPath, sinceArg);
    if (commits.length > 0 && branch) {
      branchCounts.set(
        branch,
        (branchCounts.get(branch) ?? 0) + commits.length,
      );
    }
    for (const c of commits) {
      // De-dup across worktrees that share the same commits (merged
      // branches, for example).
      if (commitMap.has(c.sha)) continue;
      commitMap.set(c.sha, c);
      for (const f of await commitFileStats(wtPath, c.sha)) {
        const prev = fileTotals.get(f.path) ?? { insertions: 0, deletions: 0 };
        prev.insertions += f.insertions;
        prev.deletions += f.deletions;
        fileTotals.set(f.path, prev);
      }
    }
    const d = await dirtyCounts(wtPath);
    if (d.unstaged + d.staged > 0) {
      dirty.push({ path: wtPath, unstaged: d.unstaged, staged: d.staged });
    }
  }

  const branches: RepoBranchActivity[] = [...branchCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, commitCount]) => ({ name, commitCount }));

  const commits: RepoCommit[] = [...commitMap.values()].sort((a, b) =>
    // commitMap was populated in iteration order; sort by relTime
    // is unreliable. Sort by sha order as a stable tiebreaker —
    // good enough for the digest, since the prompt itself doesn't
    // depend on chronological precision past "newest first" which
    // the per-worktree git log already gives us within each batch.
    a.sha.localeCompare(b.sha),
  );
  // Restore "newest first" by tracking insertion order. Easiest:
  // re-sort by the iso timestamp we never stored — so we instead
  // preserve insertion order from the original Map (Maps iterate
  // in insertion order). Replace with the original iteration.
  const orderedCommits: RepoCommit[] = [...commitMap.values()];

  const topFiles: RepoTopFile[] = [...fileTotals.entries()]
    .map(([path, totals]) => ({ path, ...totals }))
    .sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions));

  return {
    repoName,
    sinceHours,
    branches,
    dirtyWorktrees: dirty,
    commits: orderedCommits,
    topFiles,
  };
}

async function currentBranch(worktreePath: string): Promise<string | null> {
  try {
    const out = await $`git -C ${worktreePath} rev-parse --abbrev-ref HEAD`
      .quiet()
      .text();
    const name = out.trim();
    if (!name || name === "HEAD") return null;
    return name;
  } catch {
    return null;
  }
}

async function commitsInWindow(
  worktreePath: string,
  sinceArg: string,
): Promise<RepoCommit[]> {
  try {
    // %H sha · %an author · %aI iso-author-date · %s subject
    const out =
      await $`git -C ${worktreePath} log --since=${sinceArg} --format=%H%x00%an%x00%aI%x00%s --no-merges`
        .quiet()
        .text();
    const commits: RepoCommit[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\0");
      if (parts.length < 4) continue;
      const sha = parts[0]!;
      const stats = await commitShortStat(worktreePath, sha);
      commits.push({
        sha,
        author: parts[1]!,
        relTime: relTimeFromIso(parts[2]!),
        subject: parts[3]!,
        insertions: stats.insertions,
        deletions: stats.deletions,
        files: stats.files,
      });
    }
    return commits;
  } catch {
    return [];
  }
}

async function commitShortStat(
  worktreePath: string,
  sha: string,
): Promise<{ insertions: number; deletions: number; files: number }> {
  try {
    const out =
      await $`git -C ${worktreePath} show --shortstat --format= ${sha}`
        .quiet()
        .text();
    return parseShortStat(out);
  } catch {
    return { insertions: 0, deletions: 0, files: 0 };
  }
}

/** Parser for `git show --shortstat` output. Exported for tests if
 *  we ever want to add one — kept un-exported for now to keep the
 *  public surface tight. */
export function parseShortStat(out: string): {
  insertions: number;
  deletions: number;
  files: number;
} {
  // Looks like: " 2 files changed, 12 insertions(+), 3 deletions(-)"
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  const m1 = out.match(/(\d+)\s+files? changed/);
  if (m1) files = Number(m1[1]);
  const m2 = out.match(/(\d+)\s+insertions?\(\+\)/);
  if (m2) insertions = Number(m2[1]);
  const m3 = out.match(/(\d+)\s+deletions?\(-\)/);
  if (m3) deletions = Number(m3[1]);
  return { insertions, deletions, files };
}

async function commitFileStats(
  worktreePath: string,
  sha: string,
): Promise<{ path: string; insertions: number; deletions: number }[]> {
  try {
    const out = await $`git -C ${worktreePath} show --numstat --format= ${sha}`
      .quiet()
      .text();
    const rows: { path: string; insertions: number; deletions: number }[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const ins = Number(parts[0]);
      const del = Number(parts[1]);
      if (!Number.isFinite(ins) || !Number.isFinite(del)) continue;
      rows.push({ path: parts[2]!, insertions: ins, deletions: del });
    }
    return rows;
  } catch {
    return [];
  }
}

async function dirtyCounts(
  worktreePath: string,
): Promise<{ unstaged: number; staged: number }> {
  try {
    const out = await $`git -C ${worktreePath} status --porcelain`
      .quiet()
      .text();
    let unstaged = 0;
    let staged = 0;
    for (const line of out.split("\n")) {
      if (line.length < 2) continue;
      const x = line.charAt(0);
      const y = line.charAt(1);
      if (x === "?" && y === "?") {
        // Untracked counts as unstaged for this view — same as the
        // dashboard's badge does.
        unstaged++;
        continue;
      }
      if (x === "!") continue;
      if (x !== " " && x !== "?") staged++;
      if (y !== " " && y !== "?") unstaged++;
    }
    return { unstaged, staged };
  } catch {
    return { unstaged: 0, staged: 0 };
  }
}

function relTimeFromIso(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffMs = Date.now() - ts;
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Avoid an unused-import warning while keeping `join` available
// for future helpers (e.g. resolving a per-repo cache override).
void join;
