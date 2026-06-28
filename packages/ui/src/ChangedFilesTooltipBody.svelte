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
   *  per-column 3-cell subgrid so the count gutters align within a
   *  column. The three columns themselves are a flex row; non-empty
   *  buckets appear in fixed order (staged → unstaged → untracked).
   *
   *  When `worktreePath` is provided, hovering a file row spawns a
   *  nested popup that fetches and renders that one file's diff via
   *  /api/file-diff. Anchored to the row, portal'd to <body> so it
   *  isn't clipped by the parent tooltip's bounds. The popup also
   *  reaches out to the enclosing Tooltip (via Svelte context) and
   *  pins it open so moving the cursor onto the diff popup doesn't
   *  close the parent. */

  import { apiUrl } from "./api";
  import { getContext, onDestroy } from "svelte";
  import { TOOLTIP_HOVER_CTX, type TooltipHoverCtx } from "./Tooltip.svelte";
  import FileDiffTooltipBody from "./FileDiffTooltipBody.svelte";

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
  /** Retain the last successfully-loaded summary so a re-fetch (which flips
   *  `summary` back to "loading" on hover) keeps showing the existing
   *  changed-files list with a small inline spinner, instead of blanking the
   *  whole tooltip to "Loading…". Only the very first load (no prior data)
   *  shows the bare "Loading…". */
  let lastGoodSummary: WtSummaryLike | undefined;
  $: if (summary && summary !== "loading") lastGoodSummary = summary;
  $: shownSummary =
    summary && summary !== "loading" ? summary : lastGoodSummary;
  $: refreshing =
    (summary === undefined || summary === "loading") && !!lastGoodSummary;
  /** Absolute path to the worktree on disk. When provided, file rows
   *  become hover triggers for a per-file diff popup. When omitted
   *  (older callers), rows render as static text — backwards-safe. */
  export let worktreePath: string | undefined = undefined;
  /** Owning daemon for this worktree. Undefined ⇒ local daemon
   *  (byte-identical behaviour). Passed through to FileDiffTooltipBody. */
  export let daemonId: string | undefined = undefined;

  /** Per-section row cap. Past this the rest collapse into the
   *  footer message below the three columns. With horizontal
   *  layout each column reads independently, so capping per
   *  section keeps any single bucket from getting wildly taller
   *  than the others. */
  const PER_SECTION_LIMIT = 25;

  /** Bucket label → /api/file-diff kind. Centralized so we don't
   *  scatter the mapping across the template. */
  type BucketKind = "staged" | "unstaged" | "untracked";
  const DIFF_KIND: Record<BucketKind, "workdir" | "staged" | "untracked"> = {
    staged: "staged",
    unstaged: "workdir",
    untracked: "untracked",
  };

  type Row = { path: string; stat?: NumstatEntry };
  type Column = { label: string; kind: BucketKind; rows: Row[]; total: number };

  /** Sort paths by mtime descending (most-recently-touched first).
   *  Paths missing from `mtimes` (deleted file, older daemon build)
   *  go to the bottom and fall back to lexical order so the list
   *  stays stable across renders. Returns a new array — never
   *  mutates the input. */
  function sortByMtime(
    paths: string[],
    mtimes?: Record<string, number>,
  ): string[] {
    return paths.slice().sort((a, b) => {
      const ma = mtimes?.[a];
      const mb = mtimes?.[b];
      if (ma == null && mb == null) return a.localeCompare(b);
      if (ma == null) return 1;
      if (mb == null) return -1;
      return mb - ma;
    });
  }

  function plan(s: WtSummaryLike): {
    columns: Column[];
    hiddenCount: number;
    total: number;
  } {
    const buckets: Array<{
      kind: BucketKind;
      paths: string[];
      stats?: Record<string, NumstatEntry>;
    }> = [
      {
        kind: "staged",
        paths: sortByMtime(s.staged, s.mtimes),
        stats: s.stagedStats,
      },
      {
        kind: "unstaged",
        paths: sortByMtime(s.unstaged, s.mtimes),
        stats: s.stats,
      },
      {
        kind: "untracked",
        paths: sortByMtime(s.untracked, s.mtimes),
        stats: s.stats,
      },
    ];
    const columns: Column[] = [];
    let hidden = 0;
    for (const b of buckets) {
      if (b.paths.length === 0) continue;
      const slice = b.paths.slice(0, PER_SECTION_LIMIT);
      columns.push({
        label: `${b.kind} (${b.paths.length})`,
        kind: b.kind,
        rows: slice.map((p) => ({ path: p, stat: b.stats?.[p] })),
        total: b.paths.length,
      });
      if (b.paths.length > slice.length)
        hidden += b.paths.length - slice.length;
    }
    const total = s.staged.length + s.unstaged.length + s.untracked.length;
    return { columns, hiddenCount: hidden, total };
  }

  // --- per-row diff hover -------------------------------------------

  /** Reach up to the enclosing Tooltip (if any) to keep it pinned
   *  open while the user is on our portal'd diff popup. Optional —
   *  the component still works standalone. */
  const parentHover = getContext<TooltipHoverCtx | undefined>(
    TOOLTIP_HOVER_CTX,
  );

  let hovered: { kind: BucketKind; path: string; stat?: NumstatEntry } | null =
    null;
  let anchorEl: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  // Slightly longer than the outer Tooltip's defaults: gives the user
  // room to skim down the file list without each row spawning (and
  // tearing down) a diff fetch. The matching hide delay covers the
  // gap when crossing from the row to the docked popup.
  const SHOW_DELAY_MS = 300;
  const HIDE_DELAY_MS = 300;

  function clearShow() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }
  function clearHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    parentHover?.cancelHide();
  }

  function onRowEnter(
    kind: BucketKind,
    path: string,
    stat: NumstatEntry | undefined,
    el: HTMLElement,
  ) {
    if (!worktreePath) return;
    clearHide();
    // Already showing a popup → switch instantly to the new row.
    if (hovered) {
      hovered = { kind, path, stat };
      anchorEl = el;
      return;
    }
    clearShow();
    showTimer = setTimeout(() => {
      hovered = { kind, path, stat };
      anchorEl = el;
      showTimer = null;
    }, SHOW_DELAY_MS);
  }

  function onRowLeave() {
    if (!worktreePath) return;
    clearShow();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hovered = null;
      anchorEl = null;
      hideTimer = null;
    }, HIDE_DELAY_MS);
  }

  function onPopupEnter() {
    clearHide();
  }
  function onPopupLeave() {
    onRowLeave();
    parentHover?.scheduleHide();
  }

  onDestroy(() => {
    clearShow();
    clearHide();
  });

  /** Svelte action: teleport the diff popup to <body> and pin it to
   *  the current `anchorEl`'s bounding rect with position: fixed.
   *  Mirrors Tooltip.svelte's portal action but reacts to anchorEl
   *  changes so switching rows re-positions in place. */
  function diffPortal(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    document.body.appendChild(node);
    function reposition() {
      if (!anchorEl) return;
      // Dock right next to the hovered row, not the outer tooltip:
      // the popup follows the cursor as it moves down the list. The
      // row's right edge is the end of the +N / −N counts. Vertically
      // align to the row's top so the popup header sits next to the
      // file you're hovering.
      const r = anchorEl.getBoundingClientRect();
      const gap = 6;
      node.style.position = "fixed";
      const popupW = node.getBoundingClientRect().width || 0;
      const popupH = node.getBoundingClientRect().height || 0;
      const wantLeft = r.right + gap;
      // Clamp vertically so a row near the bottom doesn't push the
      // popup off-screen — but stay anchored as close to the row as
      // we can.
      const wantTop = Math.min(
        Math.max(r.top, 8),
        window.innerHeight - popupH - 8,
      );
      node.style.top = `${Math.round(wantTop)}px`;
      node.style.bottom = "auto";
      // Flip to the left of the row if docking right would overflow.
      const fitsRight = wantLeft + popupW < window.innerWidth - 8;
      if (fitsRight) {
        node.style.left = `${Math.round(wantLeft)}px`;
        node.style.right = "auto";
      } else {
        node.style.left = "auto";
        node.style.right = `${Math.round(window.innerWidth - r.left + gap)}px`;
      }
    }
    reposition();
    const scrollHandler = () => reposition();
    window.addEventListener("scroll", scrollHandler, true);
    window.addEventListener("resize", reposition);
    return {
      update: reposition,
      destroy() {
        window.removeEventListener("scroll", scrollHandler, true);
        window.removeEventListener("resize", reposition);
        node.remove();
      },
    };
  }

  // Re-position when anchorEl changes (row switch). Drive via a
  // reactive statement that touches `hovered` / `anchorEl` so the
  // action's `update` fires.
  $: (hovered, anchorEl);

  function openFileDefault(relPath: string) {
    if (!worktreePath) return;
    const abs = worktreePath.replace(/\/$/, "") + "/" + relPath;
    fetch(apiUrl("/api/open-default"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: abs }),
    }).catch(() => {});
  }
</script>

{#if !shownSummary}
  <span class="muted small">Loading…</span>
{:else if shownSummary.staged.length === 0 && shownSummary.unstaged.length === 0 && shownSummary.untracked.length === 0}
  <span class="muted small">clean</span>
  {#if refreshing}
    <span
      class="popover-spinner wt-tt-refresh-spinner"
      aria-label="Refreshing"
    ></span>
  {/if}
{:else}
  {@const p = plan(shownSummary)}
  <div class="wt-tt-cols">
    {#if refreshing}
      <span
        class="popover-spinner wt-tt-refresh-spinner wt-tt-refresh-spinner-float"
        aria-label="Refreshing"
      ></span>
    {/if}
    {#each p.columns as col}
      <div class="wt-tt-col">
        <div class="wt-tt-section-head">{col.label}</div>
        <div class="wt-tt-files">
          {#each col.rows as row}
            {@const interactive = !!worktreePath}
            <!-- Each row is a subgrid item so the three cells (path /
                 +added / −removed) stay aligned to the parent's three
                 columns while still being a single DOM box that can
                 receive mouseenter/mouseleave for the diff popup. -->
            <span
              class="wt-tt-row"
              class:wt-tt-row-interactive={interactive}
              role={interactive ? "button" : undefined}
              tabindex={interactive ? -1 : undefined}
              on:mouseenter={(e) =>
                onRowEnter(
                  col.kind,
                  row.path,
                  row.stat,
                  e.currentTarget as HTMLElement,
                )}
              on:mouseleave={onRowLeave}
              on:dblclick={() => openFileDefault(row.path)}
            >
              <span class="wt-tt-path" title={row.path}>{row.path}</span>
              <span class="wt-tt-added"
                >{row.stat
                  ? row.stat.binary
                    ? "bin"
                    : `+${row.stat.added}`
                  : ""}</span
              >
              <span class="wt-tt-removed"
                >{row.stat && !row.stat.binary
                  ? `−${row.stat.removed}`
                  : ""}</span
              >
            </span>
          {/each}
        </div>
      </div>
    {/each}
  </div>
  {#if p.hiddenCount > 0}
    <div class="wt-tt-more-files">
      + {p.hiddenCount} change{p.hiddenCount === 1 ? "" : "s"} (in total {p.total}
      files touched)?
    </div>
  {/if}
{/if}

{#if hovered && worktreePath}
  <div
    class="file-diff-popup"
    use:diffPortal
    on:mouseenter={onPopupEnter}
    on:mouseleave={onPopupLeave}
    role="tooltip"
  >
    <div class="file-diff-head">
      <span class="file-diff-head-path">{hovered.path}</span>
      {#if hovered.stat}
        {#if hovered.stat.binary}
          <span class="file-diff-head-bin">bin</span>
        {:else}
          <span class="file-diff-head-added">+{hovered.stat.added}</span>
          <span class="file-diff-head-removed">−{hovered.stat.removed}</span>
        {/if}
      {/if}
    </div>
    <FileDiffTooltipBody
      {worktreePath}
      file={hovered.path}
      kind={DIFF_KIND[hovered.kind]}
      {daemonId}
    />
  </div>
{/if}

<style>
  /* Row wrapper: subgrid so the three cells line up with the parent
     `.wt-tt-files` 3-col grid, while the row itself is a real DOM box
     (needed so mouseenter/mouseleave fire reliably for the diff popup). */
  .wt-tt-row {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    column-gap: inherit;
    align-items: baseline;
    border-radius: 3px;
  }
  .wt-tt-row-interactive {
    cursor: default;
  }
  .wt-tt-row-interactive:hover {
    background: color-mix(in srgb, var(--text-1, #e8e8e8) 8%, transparent);
  }

  /* Portal'd per-file diff popup. Sits above almost everything (1100
     vs Tooltip's 1000) since it's logically a child of the outer
     tooltip and should render on top of it if they overlap. */
  .file-diff-popup {
    z-index: 1100;
    min-width: 18rem;
    max-width: min(64rem, 92vw);
    /* Just barely lighter than the parent .tt (surface-3) — enough
       lift to read as a separate layer, but not so much it washes
       out the colored +/- lines. The stronger border + shadow do
       most of the "elevated" work here. */
    background: color-mix(in srgb, var(--surface-3, #2a2a2c) 92%, #ffffff 8%);
    color: var(--text-1, #e8e8e8);
    border: 1px solid
      color-mix(in srgb, var(--surface-3, #2a2a2c) 70%, #ffffff 30%);
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius-sm, 0.35rem);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6);
    pointer-events: auto;
  }
  .file-diff-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    color: var(--text-3, #b8b8b8);
    margin-bottom: 0.3rem;
    border-bottom: 1px solid
      color-mix(in srgb, var(--text-muted, #8a8a8a) 30%, transparent);
    padding-bottom: 0.2rem;
  }
  .file-diff-head-path {
    flex: 1 1 auto;
    min-width: 0;
    word-break: break-all;
  }
  .file-diff-head-added,
  .file-diff-head-removed,
  .file-diff-head-bin {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
  .file-diff-head-added {
    color: #7ee493;
  }
  .file-diff-head-removed {
    color: #ff8a8a;
  }
  .file-diff-head-bin {
    color: var(--text-muted, #8a8a8a);
    font-style: italic;
  }
</style>
