<script lang="ts">
  /** Render the staged / unstaged / untracked file lists that appear in
   *  the worktree-row hover tooltip. Lives as its own component so the
   *  same body can be reused by:
   *    1) the visible `row-status` tooltip on an expanded row, and
   *    2) the equivalent fold-row signal-pill tooltip,
   *  without keeping two identical template blocks in sync.
   *
   *  Layout: three side-by-side columns (one per bucket). Each column
   *  has its own header + file rows. Path / added / removed are a
   *  per-column 3-cell grid so the count gutters align within a
   *  column. The three columns themselves are a flex row; non-empty
   *  buckets appear in fixed order (staged → unstaged → untracked). */

  interface NumstatEntry {
    added: number;
    removed: number;
    binary: boolean;
  }
  interface WtSummaryLike {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    stats?: Record<string, NumstatEntry>;
    stagedStats?: Record<string, NumstatEntry>;
    /** Per-path mtime in epoch ms. Missing entries (deleted files,
     *  older daemon builds) sort to the bottom. */
    mtimes?: Record<string, number>;
  }

  export let summary: WtSummaryLike | "loading" | undefined;

  /** Per-section row cap. Past this the rest collapse into the
   *  footer message below the three columns. With horizontal
   *  layout each column reads independently, so capping per
   *  section keeps any single bucket from getting wildly taller
   *  than the others. */
  const PER_SECTION_LIMIT = 25;

  type Row = { path: string; stat?: NumstatEntry };
  type Column = { label: string; rows: Row[]; total: number };

  /** Sort paths by mtime descending (most-recently-touched first).
   *  Paths missing from `mtimes` (deleted file, older daemon build)
   *  go to the bottom and fall back to lexical order so the list
   *  stays stable across renders. Returns a new array — never
   *  mutates the input. */
  function sortByMtime(paths: string[], mtimes?: Record<string, number>): string[] {
    return paths.slice().sort((a, b) => {
      const ma = mtimes?.[a];
      const mb = mtimes?.[b];
      if (ma == null && mb == null) return a.localeCompare(b);
      if (ma == null) return 1;
      if (mb == null) return -1;
      return mb - ma;
    });
  }

  function plan(s: WtSummaryLike): { columns: Column[]; hiddenCount: number; total: number } {
    const buckets: Array<{ label: string; paths: string[]; stats?: Record<string, NumstatEntry> }> = [
      { label: "staged", paths: sortByMtime(s.staged, s.mtimes), stats: s.stagedStats },
      { label: "unstaged", paths: sortByMtime(s.unstaged, s.mtimes), stats: s.stats },
      { label: "untracked", paths: sortByMtime(s.untracked, s.mtimes), stats: s.stats },
    ];
    const columns: Column[] = [];
    let hidden = 0;
    for (const b of buckets) {
      if (b.paths.length === 0) continue;
      const slice = b.paths.slice(0, PER_SECTION_LIMIT);
      columns.push({
        label: `${b.label} (${b.paths.length})`,
        rows: slice.map((p) => ({ path: p, stat: b.stats?.[p] })),
        total: b.paths.length,
      });
      if (b.paths.length > slice.length) hidden += b.paths.length - slice.length;
    }
    const total = s.staged.length + s.unstaged.length + s.untracked.length;
    return { columns, hiddenCount: hidden, total };
  }
</script>

{#if summary === undefined || summary === "loading"}
  <span class="muted small">Loading…</span>
{:else if summary.staged.length === 0 && summary.unstaged.length === 0 && summary.untracked.length === 0}
  <span class="muted small">clean</span>
{:else}
  {@const p = plan(summary)}
  <div class="wt-tt-cols">
    {#each p.columns as col}
      <div class="wt-tt-col">
        <div class="wt-tt-section-head">{col.label}</div>
        <div class="wt-tt-files">
          {#each col.rows as row}
            <span class="wt-tt-path" title={row.path}>{row.path}</span>
            <span class="wt-tt-added">{row.stat ? (row.stat.binary ? "bin" : `+${row.stat.added}`) : ""}</span>
            <span class="wt-tt-removed">{row.stat && !row.stat.binary ? `−${row.stat.removed}` : ""}</span>
          {/each}
        </div>
      </div>
    {/each}
  </div>
  {#if p.hiddenCount > 0}
    <div class="wt-tt-more-files">
      + {p.hiddenCount} change{p.hiddenCount === 1 ? "" : "s"} (in total {p.total} files touched)?
    </div>
  {/if}
{/if}
