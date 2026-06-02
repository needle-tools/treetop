<script lang="ts">
  /** Side-panel hover preview for the dock's per-repo arrow rows
   *  (push / pull / dirty). Mirrors the worktree-row tooltips that
   *  hang off the StatusBadge: each visible worktree gets a block
   *  with up to three sections — unpushed commits, unfetched
   *  commits, and changed files. Repos with a single worktree read
   *  identically to hovering its row tooltips; multi-worktree repos
   *  stack one block per worktree so the user sees everything the
   *  aggregated dock arrow represents.
   *
   *  Triggers `loadWtSummary(path)` per worktree the first time the
   *  preview opens for a repo, and re-renders as `wtSummaries` fills
   *  in. Uses ChangedFilesTooltipBody for the dirty section to keep
   *  the per-row diff-hover popup behaviour identical to the
   *  worktree row. */

  import ChangedFilesTooltipBody from "./ChangedFilesTooltipBody.svelte";
  import { GIT_AHEAD, GIT_BEHIND, GIT_DIRTY } from "./icons";

  interface WtCommit {
    sha: string;
    subject: string;
    author?: string;
    date?: string;
  }
  interface WtSummaryLike {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    unpushedCommits?: WtCommit[];
    unfetchedCommits?: WtCommit[];
    stats?: Record<string, unknown>;
    stagedStats?: Record<string, unknown>;
    mtimes?: Record<string, number>;
  }

  export interface DockWorktreeStatus {
    path: string;
    branch: string;
    ahead: number;
    behind: number;
    dirty: number;
    upstream: string | null;
    daemonId: string | undefined;
  }

  export let worktrees: DockWorktreeStatus[] = [];
  export let wtSummaries: Record<string, WtSummaryLike | "loading"> = {};

  /** Same subject clamp as App.svelte's worktree-row tooltip so
   *  long commit subjects don't blow out the column. */
  const COMMIT_SUBJECT_MAX = 400;
  function clampSubject(s: string): string {
    if (s.length <= COMMIT_SUBJECT_MAX) return s;
    return s.slice(0, COMMIT_SUBJECT_MAX - 1) + "…";
  }
  /** Per-tooltip commit row cap — same as the row tooltip. */
  const COMMIT_TOOLTIP_LIMIT = 10;

  /** Minimal relative-time formatter used by the commit rows. The
   *  full version lives in App.svelte and elsewhere; duplicated
   *  here to keep this preview self-contained without dragging a
   *  full shared util in. */
  function relTime(iso?: string): string {
    if (!iso) return "";
    // The daemon hands back "2 hours ago"-style strings AS WELL as
    // ISO timestamps depending on origin; pass through anything that
    // doesn't parse as a Date.
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return "now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
    if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w`;
    return `${Math.floor(diff / (86400 * 30))}mo`;
  }

  function summaryOf(path: string): WtSummaryLike | "loading" | undefined {
    return wtSummaries[path];
  }
</script>

<div class="dock-rsp">
  {#each worktrees as wt (wt.path)}
    {@const s = summaryOf(wt.path)}
    <section class="dock-rsp-wt">
      {#if worktrees.length > 1}
        <header class="dock-rsp-wt-head">
          <span class="dock-rsp-wt-branch">{wt.branch || "(detached)"}</span>
        </header>
      {/if}

      {#if wt.ahead > 0}
        <div class="dock-rsp-section">
          <div class="dock-rsp-section-head">
            <svg class="dock-rsp-glyph dock-rsp-glyph-ahead" viewBox="0 0 12 12" aria-hidden="true"><path d={GIT_AHEAD}/></svg>
            <span>{wt.ahead} commit{wt.ahead === 1 ? "" : "s"} to push to {wt.upstream ?? "upstream"}</span>
          </div>
          {#if s === undefined || s === "loading"}
            <span class="muted small">Loading commits…</span>
          {:else if s.unpushedCommits && s.unpushedCommits.length > 0}
            <div class="dock-rsp-commits">
              {#each s.unpushedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
                <span class="dock-rsp-sha">{c.sha.slice(0, 7)}</span>
                <span class="dock-rsp-author" title={c.author ?? ""}>{c.author ?? ""}</span>
                <span class="dock-rsp-date">{c.date ? relTime(c.date) : ""}</span>
                <span class="dock-rsp-subject" title={c.subject}>{clampSubject(c.subject)}</span>
              {/each}
            </div>
            {#if s.unpushedCommits.length > COMMIT_TOOLTIP_LIMIT}
              <div class="dock-rsp-more">+{s.unpushedCommits.length - COMMIT_TOOLTIP_LIMIT} more</div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if wt.behind > 0}
        <div class="dock-rsp-section">
          <div class="dock-rsp-section-head">
            <svg class="dock-rsp-glyph dock-rsp-glyph-behind" viewBox="0 0 12 12" aria-hidden="true"><path d={GIT_BEHIND}/></svg>
            <span>{wt.behind} commit{wt.behind === 1 ? "" : "s"} to pull from {wt.upstream ?? "upstream"}</span>
          </div>
          {#if s === undefined || s === "loading"}
            <span class="muted small">Loading commits…</span>
          {:else if s.unfetchedCommits && s.unfetchedCommits.length > 0}
            <div class="dock-rsp-commits">
              {#each s.unfetchedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
                <span class="dock-rsp-sha">{c.sha.slice(0, 7)}</span>
                <span class="dock-rsp-author" title={c.author ?? ""}>{c.author ?? ""}</span>
                <span class="dock-rsp-date">{c.date ? relTime(c.date) : ""}</span>
                <span class="dock-rsp-subject" title={c.subject}>{clampSubject(c.subject)}</span>
              {/each}
            </div>
            {#if s.unfetchedCommits.length > COMMIT_TOOLTIP_LIMIT}
              <div class="dock-rsp-more">+{s.unfetchedCommits.length - COMMIT_TOOLTIP_LIMIT} more</div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if wt.dirty > 0}
        <div class="dock-rsp-section dock-rsp-section-files">
          <div class="dock-rsp-section-head">
            <svg class="dock-rsp-glyph dock-rsp-glyph-dirty" viewBox="0 0 12 12" aria-hidden="true"><path d={GIT_DIRTY}/></svg>
            <span>Uncommitted changes</span>
          </div>
          <ChangedFilesTooltipBody
            summary={s}
            worktreePath={wt.path}
            daemonId={wt.daemonId}
          />
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  /* Same wt-tt-* family of styles is used by ChangedFilesTooltipBody
     globally (defined in App.svelte's <style> block + worktree-row.css).
     Local rules below just wrap each worktree in a block with its own
     header — single-worktree repos omit the header so the layout reads
     exactly like the worktree-row tooltip. */
  .dock-rsp {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    color: var(--text-1, #e8e8e8);
    font-size: 0.75rem;
    line-height: 1.35;
  }
  .dock-rsp-wt {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .dock-rsp-wt + .dock-rsp-wt {
    border-top: 1px solid
      color-mix(in srgb, var(--text-muted, #8a8a8a) 25%, transparent);
    padding-top: 0.5rem;
  }
  .dock-rsp-wt-head {
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--text-muted, #9a9aa0);
  }
  .dock-rsp-wt-branch {
    color: var(--text-1, #e8e8e8);
    font-weight: 600;
  }
  .dock-rsp-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .dock-rsp-section-head {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.7rem;
    color: var(--text-muted, #9a9aa0);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    /* "2 COMMITS TO PULL FROM ORIGIN/DEV" must read on one line —
       the panel is content-sized so this also widens it enough that
       the commit rows below get room for author + subject. */
    white-space: nowrap;
  }
  /* Same chevrons as the dock dot glyphs (StatusBadge paths) so the
     section heads mirror the icons the user clicked through to get
     here. Stroke-coloured per-signal: green for push, cyan for
     pull, muted neutral for dirty — matching the row badges. */
  .dock-rsp-glyph {
    width: 0.85em;
    height: 0.85em;
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .dock-rsp-glyph-ahead {
    color: var(--chip-green-text, #7ee493);
  }
  .dock-rsp-glyph-behind {
    color: var(--chip-cyan-text, #7ec7e4);
  }
  .dock-rsp-glyph-dirty {
    color: var(--text-3, #b8b8b8);
  }
  .dock-rsp-commits {
    display: grid;
    /* sha | author | date | subject. Author and subject get real
       minimums so a long username / commit message isn't crushed to
       a single ellipsised glyph — `min-width: 0` on the cells alone
       lets them collapse to nothing when the panel is narrow. */
    grid-template-columns: auto minmax(10ch, max-content) auto minmax(24ch, 1fr);
    column-gap: 0.6rem;
    row-gap: 0.15rem;
    align-items: baseline;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .dock-rsp-sha {
    color: var(--text-muted, #9a9aa0);
  }
  .dock-rsp-author {
    color: var(--text-3, #b8b8b8);
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dock-rsp-date {
    color: var(--text-muted, #9a9aa0);
    font-variant-numeric: tabular-nums;
  }
  .dock-rsp-subject {
    color: var(--text-1, #e8e8e8);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Grid cells default to `min-width: auto` (≈ min-content), so a
       single long subject word would otherwise blow the track past
       its `1fr` allocation and the ellipsis would never trigger.
       Forcing 0 lets the cell honor the track's 24ch min and
       ellipsise the rest. */
    min-width: 0;
  }
  .dock-rsp-more {
    font-size: 0.65rem;
    color: var(--text-muted, #9a9aa0);
    margin-top: 0.1rem;
  }
  .muted {
    color: var(--text-muted, #9a9aa0);
  }
  .small {
    font-size: 0.7rem;
  }
</style>
