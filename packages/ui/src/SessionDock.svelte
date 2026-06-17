<script lang="ts">
  /**
   * Persistent bottom strip of dots, one per currently-open session.
   * Acts as a "where did I leave off?" launcher across the dashboard.
   *
   *  - Fill = repo accent color (falls back to a neutral surface).
   *  - Outline = agent brand color (orange Claude / cyan Codex / grey
   *    Copilot / dim Shell), so two attributes are encoded in one chip.
   *  - Activity state shows on top of the dot:
   *      working    -> slow rotating gradient ring (subtle, ambient).
   *      awaiting   -> stronger blinking outline + scaled dot.
   *      idle/open  -> static.
   *  - Click  -> reveal the session column (unfold the row if needed,
   *              scroll the strip, flash the column briefly).
   *  - Hover  -> tooltip with repo/branch + title + last user prompt.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import ChatPreview from "./ChatPreview.svelte";
  import DirtyGlyph from "./DirtyGlyph.svelte";
  import RepoStatusPreview, {
    type DockWorktreeStatus,
  } from "./RepoStatusPreview.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import { splitDockEntries } from "./dock-split";
  import { GIT_AHEAD, GIT_BEHIND } from "./icons";
  import {
    fetchPreviewItems,
    type PreviewAction,
    type PreviewGap,
    type PreviewMsg,
    type PreviewSummary,
  } from "./preview-action";

  /** Minimal shape this component needs per session. The host computes
   *  these from its open-sessions / agents / repos state and hands them
   *  over already merged. Keeps the component dumb. */
  export interface DockEntry {
    source: string;
    wtPath: string;
    rowKey: string;
    /** Stable repo identifier — used to detect "first dot in this
     *  repo's group" so the dock can paint a visual gap between
     *  groups. Repo names aren't safe (two repos can share a name);
     *  the id is. */
    repoId: string;
    agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
    /** Hex (e.g. "#ff8800"). Undefined → default neutral fill. */
    repoColor?: string;
    repoName: string;
    branch?: string;
    title?: string;
    manualTitle?: string;
    aiTitle?: string;
    lastUserMessage?: string;
    /** ISO timestamp of the session's most recent activity. Drives
     *  the "5 minutes ago" segment in the hover label. */
    lastActive?: string;
    /** User + assistant turns in the last ~4 hours. Drives the
     *  "hot session" activity badge in the dock label. */
    recentMessageCount?: number;
    /** ISO timestamp of the actual last user/assistant message. Set
     *  by the daemon's JSONL scan; falls back to `lastActive` (file
     *  mtime) when missing. Preferred over `lastActive` for "when
     *  was this last touched" since `--resume` can bump the mtime
     *  without appending messages. */
    lastMessageTs?: string;
    /** JSONL path the dock fetches on hover to render the last few
     *  user/assistant messages as a side preview. Undefined ⇒ no
     *  preview (shells, fresh `__new__:` columns). */
    transcriptSource?: string;
    working: boolean;
    awaiting: boolean;
    /** True once the column's PTY has exited. The row stays in
     *  the dock (hover + click still work) but the dot shrinks to
     *  signal the session is ended. */
    exited: boolean;
    /** Timestamp (ms) of the most recent working→idle transition.
     *  When set and recent (< PULSE_MAX_MS), the dock pulses the
     *  dot as an "unread" reminder until the user re-focuses the
     *  session. */
    finishedAt?: number;
    ioDebugLabel?: string;
  }

  export let entries: DockEntry[];
  /** Source of the session the user most recently focused via this
   *  dock. The matching row paints a small left-pointing triangle so
   *  the user can scan the strip and instantly see which dot maps to
   *  the column they're currently looking at. `null` ⇒ no row is
   *  marked as focused. */
  export let focusedSource: string | null = null;

  export interface DockRepoStatus {
    repoId: string;
    repoColor?: string;
    repoName: string;
    ahead: number;
    behind: number;
    staged: number;
    unstaged: number;
    untracked: number;
    /** Count of submodule entries (any kind — internal-dirt OR
     *  pointer-bump) that the host already folded into the
     *  staged/unstaged totals. Subtracted out when deciding whether
     *  to flash the dock's dirty wave so a registered submodule
     *  doing its own thing doesn't keep the parent's row lit up. */
    submoduleChanges?: number;
  }
  /** Per-repo push/pull status. Repos with ahead or behind > 0 get
   *  an animated arrow; all counts show in the hover label. */
  export let dockRepoStatuses: DockRepoStatus[] = [];

  /** Per-repo breakdown of visible worktrees with their individual
   *  push/pull/dirty counts. Feeds the arrow-row hover preview so
   *  it can render the same per-worktree sections (unpushed
   *  commits, unfetched commits, changed files) you'd see hovering
   *  the worktree row's StatusBadges. Optional — empty map ⇒ no
   *  preview opens. */
  export let dockRepoWorktrees: Record<string, DockWorktreeStatus[]> = {};
  /** Cache of per-worktree summaries keyed by absolute path. Same
   *  shape the host uses for the worktree-row tooltips
   *  (App.svelte's `wtSummaryByPath`). Threaded through here so the
   *  arrow-row preview can render commit lists + file lists without
   *  re-fetching. */
  export let wtSummaries: Record<string, unknown> = {};
  /** Trigger function — called on arrow-row hover for each worktree
   *  in the hovered repo so the host can lazy-load the summary that
   *  feeds {wtSummaries}. No-op when omitted. */
  export let loadWtSummary: ((path: string) => void) | null = null;

  /** Whether the dashboard is in zen mode. When true, inactive
   *  dots are hidden by default (the user can still override via
   *  the toggle). When zen exits, the pre-zen toggle state is
   *  restored — the zen override is purely transient. */
  export let zen = false;

  const dispatch = createEventDispatcher<{
    pick: DockEntry;
    scrollToRepo: { repoId: string };
  }>();

  /** User's persistent toggle preference (survives zen enter/exit). */
  let userShowInactive = true;
  /** Per-zen-session override. `null` means "use zen default (hide)".
   *  Set to a boolean when the user clicks the toggle during zen. */
  let zenOverride: boolean | null = null;

  // Reset the zen override whenever zen mode is entered/exited so
  // the next zen session starts fresh (hidden) and leaving zen
  // restores the user's original preference.
  let prevZen = false;
  $: if (zen !== prevZen) {
    prevZen = zen;
    zenOverride = null;
  }

  /** Effective visibility: zen forces hidden unless the user
   *  explicitly overrides via the toggle during that zen session. */
  $: showInactive = zen ? (zenOverride ?? false) : userShowInactive;

  function toggleInactive() {
    if (zen) {
      zenOverride = zenOverride === null ? true : !zenOverride;
    } else {
      userShowInactive = !userShowInactive;
    }
  }

  $: split = splitDockEntries(entries, showInactive);

  /** Non-submodule dirty count for the dock — subtracts any S-prefix
   *  entries (internal-dirt and pointer-bumps) so registered
   *  submodules don't keep the parent's dirty wave lit up. */
  function dockDirtyOf(s: DockRepoStatus): number {
    return Math.max(
      0,
      s.staged + s.unstaged + s.untracked - (s.submoduleChanges ?? 0),
    );
  }

  /** Quick lookup: repoId → status. Used in the template to render
   *  arrows at repo-group boundaries. A repo qualifies if it has any
   *  of push, pull, or uncommitted non-submodule changes. The
   *  template gates the dirty *glyph* visibility on context: a
   *  dirty-only orphan row requires showInactive (no anchor TUI),
   *  but a repo that already has visible TUI rows always shows the
   *  wave next to its boundary. */
  $: repoStatusMap = new Map(
    dockRepoStatuses
      .filter(
        (s) => s.ahead > 0 || s.behind > 0 || dockDirtyOf(s) > 0,
      )
      .map((s) => [s.repoId, s]),
  );

  /** Repos that have a status badge but no session dots — they still
   *  need a row in the dock. Built from repoStatuses minus any repoId
   *  that appears in the current split. Dirty-only orphans are
   *  suppressed in active-TUIs-only mode (no session anchors the
   *  signal, so it's just noise); push/pull orphans always show. */
  $: orphanRepoArrows = (() => {
    const inDock = new Set([
      ...split.top.map((e) => e.repoId),
      ...split.bottom.map((e) => e.repoId),
    ]);
    return dockRepoStatuses.filter(
      (s) =>
        (s.ahead > 0 || s.behind > 0 || (showInactive && dockDirtyOf(s) > 0)) &&
        !inDock.has(s.repoId),
    );
  })();

  /** How long the "unread" pulse stays on after the AI finishes
   *  a turn (working → idle). Caps the noise so a long-ignored
   *  finished session doesn't keep nagging forever. */
  const PULSE_MAX_MS = 20 * 60 * 1000;
  /** After this many ms in awaiting, escalate to the urgent
   *  animation (bigger scale, faster cadence). */
  const AWAITING_URGENT_MS = 20_000;
  /** Per-source timestamp of when the session first entered
   *  awaiting state. Used to decide mild vs. urgent animation. */
  const awaitingSince = new Map<string, number>();
  /** Track awaiting start times. Called reactively whenever
   *  entries change so new awaiting sessions get stamped and
   *  sessions that stopped awaiting are cleaned up. */
  $: {
    const currentlyAwaiting = new Set<string>();
    for (const e of entries) {
      if (e.awaiting) {
        currentlyAwaiting.add(e.source);
        if (!awaitingSince.has(e.source)) {
          awaitingSince.set(e.source, Date.now());
        }
      }
    }
    for (const src of awaitingSince.keys()) {
      if (!currentlyAwaiting.has(src)) awaitingSince.delete(src);
    }
  }
  function isAwaitingUrgent(source: string, now: number): boolean {
    const since = awaitingSince.get(source);
    if (since === undefined) return false;
    return now - since >= AWAITING_URGENT_MS;
  }
  /** Clock tick. Re-rendered every 5s so the awaiting-urgent
   *  escalation and the isPulsing expiry fire at reasonable
   *  cadence without per-row timers. */
  let nowTick = Date.now();
  let nowTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    nowTimer = setInterval(() => {
      nowTick = Date.now();
    }, 5_000);
    window.addEventListener("resize", clampPreviewTop);
  });
  onDestroy(() => {
    if (nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
    window.removeEventListener("resize", clampPreviewTop);
    previewResizeObs?.disconnect();
    previewResizeObs = null;
  });
  // Whenever the preview node mounts/unmounts, attach a
  // ResizeObserver so content growth (poll-driven new messages,
  // long bursts that expand on hover) triggers a re-clamp.
  $: if (previewEl) {
    previewResizeObs?.disconnect();
    previewResizeObs = new ResizeObserver(() => clampPreviewTop());
    previewResizeObs.observe(previewEl);
  } else if (previewResizeObs) {
    previewResizeObs.disconnect();
    previewResizeObs = null;
  }

  /** Measure the bounding box of all dock dots + toggle and size
   *  the backdrop element to cover exactly that area — one continuous
   *  surface behind the dot column, no per-row gaps. */
  function updateBackdrop(): void {
    if (!backdropEl || !dockEl) return;
    const dots = dockEl.querySelectorAll<HTMLElement>(
      ".dock-dot, .dock-toggle",
    );
    if (dots.length === 0) {
      backdropEl.style.display = "none";
      return;
    }
    const dockRect = dockEl.getBoundingClientRect();
    let minY = Infinity;
    let maxY = -Infinity;
    let maxRight = 0;
    for (const dot of dots) {
      const r = dot.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.top < minY) minY = r.top;
      if (r.bottom > maxY) maxY = r.bottom;
      if (r.right > maxRight) maxRight = r.right;
    }
    if (minY >= maxY) {
      backdropEl.style.display = "none";
      return;
    }
    const pad = 4;
    backdropEl.style.display = "block";
    backdropEl.style.top = `${minY - dockRect.top - pad}px`;
    backdropEl.style.left = "0";
    backdropEl.style.height = `${maxY - minY + pad * 2}px`;
    backdropEl.style.width = `${maxRight - dockRect.left + pad}px`;
  }

  // Re-measure backdrop whenever entries/filter change or labels toggle.
  // tick() waits for Svelte's DOM flush; rAF waits for layout/paint.
  // Reference all deps in the block body so Svelte tracks them
  // unconditionally (a comma expression would gate on the last value).
  $: {
    void split;
    void showLabels;
    void showInactive;
    if (dockEl) {
      void tick().then(() => requestAnimationFrame(updateBackdrop));
    }
  }

  function isPulsing(e: DockEntry, now: number): boolean {
    if (e.exited) return false;
    if (e.working || e.awaiting) return false;
    if (typeof e.finishedAt !== "number") return false;
    return now - e.finishedAt < PULSE_MAX_MS;
  }

  /** Suppress the hover/focus label-reveal for a short window right
   *  after a click. Without this, the focused button keeps
   *  :focus-within active (and the cursor is still over the dock),
   *  so labels stay expanded while the page scroll-and-flashes to
   *  the picked column — distracting. Long enough to outlast the
   *  smooth scroll animation, short enough that re-entering the
   *  dock immediately shows labels again. */
  let collapseAfterClick = false;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;

  function handlePick(e: DockEntry) {
    dispatch("pick", e);
    if (typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      active?.blur?.();
    }
    // Immediately tear down the hover overlay (labels + chat
    // history preview) so the user sees only the scroll-to
    // animation, not a lingering panel of the row they just left.
    cancelDismiss();
    cancelShowPreview();
    hoveredEntry = null;
    showLabels = false;
    stopPreviewPoll();
    collapseAfterClick = true;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseAfterClick = false;
      collapseTimer = null;
    }, 600);
  }

  onDestroy(() => {
    if (collapseTimer) clearTimeout(collapseTimer);
    cancelDismiss();
    cancelShowPreview();
    stopPreviewPoll();
  });

  /** Preview cache: per-transcriptSource, the items to render in
   *  the side panel. The actual list-building logic — selecting
   *  the latest user + last 3 assistant turns, walking blocks for
   *  inline tool chips, deciding when to surface a "Now:" action
   *  chip at the top, inserting "+N messages" gap pills, the
   *  typing placeholder for an in-flight latest assistant — lives
   *  in `preview-action.ts` so it can be unit-tested and ported
   *  to other agent JSONL shapes (codex, copilot, …) without
   *  touching the Svelte component. */
  type PreviewItem = PreviewMsg | PreviewGap | PreviewAction;
  let previews: Record<string, PreviewItem[]> = {};
  /** Per-source cached Ollama summary (when one already exists on
   *  disk). Shown above the messages; never generated here. */
  let previewSummaries: Record<string, PreviewSummary> = {};
  let previewLoading: Record<string, boolean> = {};
  /** Per-source latest user/assistant message timestamp, harvested
   *  on every preview fetch. Drives the "x time ago" in the dock
   *  label so the time reflects the actual most recent CHAT
   *  activity, not the session file's mtime (which can advance
   *  on tool runs or daemon side-writes that aren't real
   *  messages). Falls back to `entry.lastActive` when nothing is
   *  cached yet (e.g. before the first hover). */
  let latestMessageTs: Record<string, string> = {};

  function freshestTimestamp(entry: DockEntry): string | undefined {
    const cached = entry.transcriptSource
      ? latestMessageTs[entry.transcriptSource]
      : undefined;
    // Prefer the daemon-side last-message timestamp over the file
    // mtime — claude --resume and other side writes touch the file
    // without appending new messages, so mtime would lie about
    // "when did a human/AI last speak in this session".
    return cached ?? entry.lastMessageTs ?? entry.lastActive;
  }

  async function loadPreview(
    source: string | undefined,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!source) return;
    if (previewLoading[source]) return;
    // Use cached data on the first hover (snappy reveal). The poll
    // timer started by `onRowEnter` will then refetch every few
    // seconds with `force: true`, so a live conversation in the
    // hovered TUI keeps updating in the panel.
    if (!opts.force && previews[source]) return;
    previewLoading = { ...previewLoading, [source]: true };
    const result = await fetchPreviewItems(source);
    if (result) {
      previews = { ...previews, [source]: result.items };
      if (result.summary) {
        previewSummaries = { ...previewSummaries, [source]: result.summary };
      }
      if (result.latestTs) {
        latestMessageTs = { ...latestMessageTs, [source]: result.latestTs };
      }
    }
    previewLoading = { ...previewLoading, [source]: false };
  }

  /** While a row is hovered, refresh its preview at a snappy
   *  cadence so the side panel mirrors the live conversation in
   *  the TUI as it streams. Daemon is on localhost so the per-tick
   *  fetch is cheap. */
  const PREVIEW_POLL_MS = 750;
  let previewPoller: ReturnType<typeof setInterval> | null = null;
  function startPreviewPoll(source: string | undefined) {
    stopPreviewPoll();
    if (!source) return;
    previewPoller = setInterval(() => {
      void loadPreview(source, { force: true });
    }, PREVIEW_POLL_MS);
  }
  function stopPreviewPoll() {
    if (previewPoller) {
      clearInterval(previewPoller);
      previewPoller = null;
    }
  }

  /** Single shared preview state: which row is hovered (drives which
   *  transcript is rendered in the panel) and where to anchor the
   *  panel vertically (so it floats next to the hovered row inside
   *  the dock's fixed-position frame). One aside is rendered at
   *  the dock level — the panel's left position is constant
   *  regardless of label widths, which the user explicitly wanted. */
  let hoveredEntry: DockEntry | null = null;
  let hoveredTop = 0;
  /** Bound to the `.session-dock` root and the `.dock-preview` aside
   *  so we can clamp the preview's vertical position to the viewport
   *  — without it, hovering a row near the bottom of the screen lets
   *  the preview spill off the visible area. */
  let dockEl: HTMLElement | null = null;
  let backdropEl: HTMLElement | null = null;
  let previewEl: HTMLElement | null = null;
  let previewResizeObs: ResizeObserver | null = null;
  /** Viewport edge padding for the clamp. */
  const PREVIEW_VIEWPORT_INSET = 8;
  /** Re-clamp `hoveredTop` so the preview's full height stays in the
   *  viewport. Runs on hover change, preview content resize, and
   *  window resize. */
  function clampPreviewTop(): void {
    if (!previewEl || !dockEl) return;
    const h = previewEl.offsetHeight;
    if (h <= 0) return;
    const dockRect = dockEl.getBoundingClientRect();
    // Target viewport-y for the preview's centre is the hovered
    // button's centre in dock-local coords, projected through the
    // dock's current viewport top.
    const desiredCenterVp = dockRect.top + hoveredTop;
    const minCenterVp = PREVIEW_VIEWPORT_INSET + h / 2;
    const maxCenterVp = window.innerHeight - PREVIEW_VIEWPORT_INSET - h / 2;
    // If the preview is taller than the viewport, anchor to the top
    // instead of trying to centre — at least the user sees the head.
    let clampedCenterVp: number;
    if (minCenterVp > maxCenterVp) {
      clampedCenterVp = PREVIEW_VIEWPORT_INSET + h / 2;
    } else {
      clampedCenterVp = Math.max(
        minCenterVp,
        Math.min(maxCenterVp, desiredCenterVp),
      );
    }
    const clampedTop = clampedCenterVp - dockRect.top;
    if (Math.abs(clampedTop - hoveredTop) > 0.5) hoveredTop = clampedTop;
  }
  $: if ((hoveredEntry || hoveredRepoId) && previewEl && dockEl) {
    // After layout settles (next frame), measure + clamp. The
    // dependency on hoveredEntry / hoveredRepoId re-fires the
    // clamp whenever the user moves to a different row OR switches
    // between the session-preview and repo-status-preview asides.
    void Promise.resolve().then(() => requestAnimationFrame(clampPreviewTop));
  }
  /** Driven by JS instead of plain :hover/:focus-within so the
   *  whole dock — labels AND chat preview — can stay visible for a
   *  grace period after the cursor leaves. */
  let showLabels = false;
  /** Grace timer so the dock doesn't vanish the instant the cursor
   *  leaves — gives the user a beat to read it. */
  const DISMISS_DELAY_MS = 100;
  /** Wait this long before opening the chat history preview after a
   *  row enters hover — so brushing past rows doesn't pop preview
   *  panels (and doesn't fire `/api/session` fetches) the user
   *  never asked for. Labels still appear immediately; only the
   *  preview is gated. */
  const SHOW_PREVIEW_DELAY_MS = 500;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let showPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelDismiss() {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }
  function cancelShowPreview() {
    if (showPreviewTimer) {
      clearTimeout(showPreviewTimer);
      showPreviewTimer = null;
    }
  }

  /** Which repo's arrow row is currently hovered — opens the repo
   *  status side preview (push commits / pull commits / changed
   *  files per worktree). Mutually exclusive with `hoveredEntry`
   *  so the two side asides don't fight for the same slot. */
  let hoveredRepoId: string | null = null;

  function onArrowEnter(ev: Event, repoId: string) {
    cancelDismiss();
    cancelShowPreview();
    hoveredEntry = null;
    stopPreviewPoll();
    showLabels = true;
    const trigger = ev.currentTarget as HTMLElement | null;
    if (trigger) {
      const tRect = trigger.getBoundingClientRect();
      const dockRect = dockEl?.getBoundingClientRect();
      const dockTop = dockRect ? dockRect.top : 0;
      hoveredTop = tRect.top + tRect.height / 2 - dockTop;
    }
    hoveredRepoId = repoId;
    // Prime the per-worktree summary cache so the panel fills in
    // commit / file lists. No-op when the host didn't wire the
    // callback (e.g. tests).
    if (loadWtSummary) {
      const wts = dockRepoWorktrees[repoId] ?? [];
      for (const wt of wts) loadWtSummary(wt.path);
    }
  }

  function onRowEnter(ev: Event, entry: DockEntry) {
    cancelDismiss();
    cancelShowPreview();
    hoveredRepoId = null;
    const btn = ev.currentTarget as HTMLElement | null;
    if (btn) {
      // Compute hoveredTop in dock-local coords from viewport rects
      // rather than `btn.offsetTop`. The button now lives inside
      // `.dock-scroller` (whose offsetParent semantics + scroll
      // position would skew offsetTop), and viewport rects are
      // immune to either. The preview aside is positioned relative
      // to `.session-dock`, so we subtract the dock's viewport top.
      const btnRect = btn.getBoundingClientRect();
      const dockRect = dockEl?.getBoundingClientRect();
      const dockTop = dockRect ? dockRect.top : 0;
      hoveredTop = btnRect.top + btnRect.height / 2 - dockTop;
    }
    showLabels = true;
    // First-open is delayed so a quick brush across rows doesn't
    // pop a preview (and fire /api/session) for each one. But once
    // a preview is already on screen, switching to a different row
    // is instant — the user is clearly hovering with intent.
    if (hoveredEntry) {
      hoveredEntry = entry;
      void loadPreview(entry.transcriptSource);
      startPreviewPoll(entry.transcriptSource);
    } else {
      showPreviewTimer = setTimeout(() => {
        hoveredEntry = entry;
        void loadPreview(entry.transcriptSource);
        startPreviewPoll(entry.transcriptSource);
        showPreviewTimer = null;
      }, SHOW_PREVIEW_DELAY_MS);
    }
  }

  function onDockEnter() {
    cancelDismiss();
    showLabels = true;
  }

  function onDockLeave() {
    cancelDismiss();
    cancelShowPreview();
    dismissTimer = setTimeout(() => {
      hoveredEntry = null;
      hoveredRepoId = null;
      showLabels = false;
      stopPreviewPoll();
      dismissTimer = null;
    }, DISMISS_DELAY_MS);
  }

  function tooltipFor(e: DockEntry): string {
    const lines: string[] = [];
    lines.push(`${e.repoName}${e.branch ? ` · ${e.branch}` : ""}`);
    const t = e.manualTitle ?? e.aiTitle ?? e.title;
    if (t) lines.push(t);
    if (e.lastUserMessage) {
      const cap =
        e.lastUserMessage.length > 200
          ? e.lastUserMessage.slice(0, 199) + "…"
          : e.lastUserMessage;
      lines.push(`\n${cap}`);
    }
    if (e.awaiting) lines.push("\n⏳ waiting for your input");
    else if (e.working) lines.push("\n● working");
    return lines.join("\n");
  }

  /** Hover label is rendered as three spans:
   *    <b>repo</b> · 5 minutes ago: session title
   *  Each piece is optional — if lastActive is missing the time
   *  segment hides; if no title is known, the branch (or nothing) is
   *  shown after the colon. */
  function sessionNameFor(e: DockEntry): string {
    const t = e.manualTitle ?? e.aiTitle ?? e.title;
    if (t) return t;
    return e.branch ?? "";
  }
  /** Repo colours can land arbitrarily close to the dashboard's
   *  background (`--surface-0` ≈ #23261d) — when that happens the
   *  dot effectively disappears. This boosts any colour whose
   *  perceived luminance is below ~140/255 OR whose chroma (max
   *  channel − min channel) is low (i.e. a grey close to the bg
   *  brightness). Bright, saturated colours pass through. */
  const BRIGHTEN_LUM_MIN = 140;
  const BRIGHTEN_CHROMA_MIN = 30;
  function brightenIfDark(hex: string | undefined): string {
    if (!hex) hex = "#888888";
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    const raw = m[1];
    const hex6 =
      raw.length === 3
        ? raw
            .split("")
            .map((c) => c + c)
            .join("")
        : raw;
    const n = parseInt(hex6, 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const tooDark = lum < BRIGHTEN_LUM_MIN;
    const tooGrey = chroma < BRIGHTEN_CHROMA_MIN && lum < 200;
    if (!tooDark && !tooGrey) return hex;
    // Boost strength scales with how dark the colour is. Grey-but-
    // not-dark colours still get a small lift so they pop more
    // against the page background.
    const darknessT = Math.max(
      0,
      Math.min(1, (BRIGHTEN_LUM_MIN - lum) / BRIGHTEN_LUM_MIN),
    );
    const greynessT = tooGrey ? 0.3 : 0;
    const t = Math.min(1, darknessT * 0.65 + greynessT);
    const lift = (c: number) => Math.round(c + (255 - c) * t);
    return `#${[lift(r), lift(g), lift(b)]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function relTime(iso?: string): string {
    if (!iso) return "";
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)} days ago`;
  }

  /** Fuzzy bucketed time for the compact dock label.
   *    < 20h   — text: "just now" / "Xm ago" / "1h ago" / "Xh ago"
   *    20h-7d  — calendar sheet icon
   *    7d+     — snowflake icon
   *  Older stuff goes graphical; recent stuff stays readable. */
  function fuzzyTime(iso?: string):
    | { kind: "text"; text: string; fresh: boolean }
    | { kind: "icon"; icon: "calendar" | "snowflake" }
    | null {
    if (!iso) return null;
    const ms = Date.now() - Date.parse(iso);
    if (Number.isNaN(ms) || ms < 0) return null;
    const minutes = ms / (60 * 1000);
    const hours = ms / (60 * 60 * 1000);
    const days = ms / (24 * 60 * 60 * 1000);
    if (minutes < 1) return { kind: "text", text: "just now", fresh: true };
    if (minutes < 60) {
      return { kind: "text", text: `${Math.floor(minutes)}m`, fresh: minutes < 30 };
    }
    if (hours < 20) {
      const h = Math.floor(hours);
      return { kind: "text", text: `${h}h`, fresh: h < 2 };
    }
    if (days < 7) return { kind: "icon", icon: "calendar" };
    return { kind: "icon", icon: "snowflake" };
  }

  /** Minimum recent-message count before we show the activity badge.
   *  Below this the session isn't "hot" enough to badge. */
  const RECENT_MIN = 3;
  /** Only show badges for entries with meaningful recent activity.
   *  Uses the median of all non-zero counts as the cutoff so the
   *  badge surfaces the busier half and stays hidden for quiet
   *  sessions. Falls back to RECENT_MIN when few entries qualify. */
  $: recentThreshold = (() => {
    const counts = entries
      .map((e) => e.recentMessageCount ?? 0)
      .filter((c) => c >= RECENT_MIN)
      .sort((a, b) => a - b);
    if (counts.length === 0) return Infinity;
    const median = counts[Math.floor(counts.length / 2)] ?? RECENT_MIN;
    return Math.max(RECENT_MIN, median);
  })();
</script>

{#if entries.length > 0}
  <div
    bind:this={dockEl}
    class="session-dock"
    class:collapsed={collapseAfterClick}
    class:show-labels={showLabels}
    role="toolbar"
    aria-label="Open sessions"
    on:pointerover={(ev) => {
      // pointerover bubbles from children with pointer-events: auto
      // through the pointer-events: none shell. Only fire onDockEnter
      // when the pointer actually enters from outside the dock (not
      // when moving between children inside it).
      const related = ev.relatedTarget as Element | null;
      if (related && dockEl?.contains(related)) return;
      onDockEnter();
    }}
    on:pointerout={(ev) => {
      const related = ev.relatedTarget as Element | null;
      if (related && dockEl?.contains(related)) return;
      onDockLeave();
    }}
    on:focusin={onDockEnter}
  >
    <!-- Continuous surface behind the dot column. Sized by JS to
         cover exactly the first dot through the last dot + toggle,
         so there are no per-row gaps. Hidden when labels are off. -->
    <div
      bind:this={backdropEl}
      class="dock-backdrop"
      class:visible={showLabels}
      aria-hidden="true"
    ></div>

    <!-- Top half: dots stack from bottom-up toward the center toggle.
         flex:1 + justify-content:flex-end keeps dots hugging the
         toggle rather than the viewport top. -->
    <div class="dock-half dock-top">
      {#each split.top as e, i (e.source)}
        {#if (i === 0 || split.top[i - 1].repoId !== e.repoId) && repoStatusMap.has(e.repoId)}
          {@const rs = repoStatusMap.get(e.repoId)}
          {@const dirtyCount = rs ? dockDirtyOf(rs) : 0}
          <span
            class="dock-dot dock-repo-arrow"
            style:--arrow-color={brightenIfDark(rs?.repoColor)}
            on:mouseenter={(ev) =>
              onArrowEnter(ev, rs?.repoId ?? e.repoId)}
            on:click={() =>
              dispatch("scrollToRepo", { repoId: rs?.repoId ?? e.repoId })}
          >
            <span class="dock-dot-inner dock-arrow-inner">
              {#if rs?.ahead}<svg
                  class="dock-arrow-glyph dock-arrow-up"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  ><path d={GIT_AHEAD} /></svg
                >{/if}
              {#if rs?.behind}<svg
                  class="dock-arrow-glyph dock-arrow-down"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  ><path d={GIT_BEHIND} /></svg
                >{/if}
              {#if dirtyCount && !rs?.ahead && !rs?.behind}<DirtyGlyph />{/if}
            </span>
            <span class="dock-label">
              <span class="dock-label-repo">{rs?.repoName}</span>
              <span class="dock-label-badges">
                {#if rs?.ahead}<StatusBadge compact ahead={rs.ahead} />{/if}
                {#if rs?.behind}<StatusBadge compact behind={rs.behind} />{/if}
                {#if dirtyCount}<StatusBadge
                    compact
                    dirty={dirtyCount}
                  />{/if}
              </span>
            </span>
          </span>
        {/if}
        <button
          type="button"
          class="dock-dot agent-{e.agent}"
          class:dot-working={e.working}
          class:dot-awaiting={e.awaiting}
          class:dot-awaiting-urgent={e.awaiting &&
            isAwaitingUrgent(e.source, nowTick)}
          class:dot-exited={e.exited}
          class:dot-pulsing={isPulsing(e, nowTick)}
          class:dock-dot-focused={focusedSource === e.source}
          class:dock-dot-repo-first={i > 0 &&
            split.top[i - 1].repoId !== e.repoId &&
            !repoStatusMap.has(e.repoId)}
          style:--dot-fill={brightenIfDark(e.repoColor)}
          aria-label={tooltipFor(e)}
          on:click={() => handlePick(e)}
          on:mouseenter={(ev) => onRowEnter(ev, e)}
          on:focusin={(ev) => onRowEnter(ev, e)}
        >
          {#if focusedSource === e.source}
            <svg class="dock-dot-arrow" viewBox="0 0 5 10" aria-hidden="true">
              <polyline points="0.5,0.5 4.5,5 0.5,9.5" />
            </svg>
          {/if}
          <span class="dock-dot-inner">
            <svg
              class="dock-dot-spinner"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9.5" pathLength="100" />
            </svg>
          </span>
          <span class="dock-label">
            <span class="dock-label-repo">{e.repoName}</span>
            {#if sessionNameFor(e)}
              <span class="dock-label-title">{sessionNameFor(e)}</span>
            {/if}
            {#if e.ioDebugLabel}
              <span class="dock-io-debug-label" title="Terminal inbound throughput">
                {e.ioDebugLabel}
              </span>
            {/if}
            {#if freshestTimestamp(e)}
              {@const ft = fuzzyTime(freshestTimestamp(e))}
              {#if ft}
                <span
                  class="dock-label-time"
                  class:dock-time-fresh={ft.kind === "text" && ft.fresh}
                  class:dock-time-text={ft.kind === "text"}
                  title={relTime(freshestTimestamp(e))}
                >
                  {#if ft.kind === "text"}
                    {ft.text}
                  {:else}
                    <span class="dock-time-hover">{relTime(freshestTimestamp(e))}</span>
                    {#if ft.icon === "calendar"}
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <rect x="2.5" y="3" width="11" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5" />
                        <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" stroke-width="1.5" />
                        <line x1="6" y1="1.5" x2="6" y2="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                        <line x1="10" y1="1.5" x2="10" y2="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                      </svg>
                    {:else}
                      <!-- Snowflake: 6-arm star with side branches. -->
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none">
                          <line x1="8" y1="1.5" x2="8" y2="14.5" />
                          <line x1="2.4" y1="4.75" x2="13.6" y2="11.25" />
                          <line x1="2.4" y1="11.25" x2="13.6" y2="4.75" />
                          <line x1="8" y1="3.5" x2="6.5" y2="2.5" />
                          <line x1="8" y1="3.5" x2="9.5" y2="2.5" />
                          <line x1="8" y1="12.5" x2="6.5" y2="13.5" />
                          <line x1="8" y1="12.5" x2="9.5" y2="13.5" />
                          <line x1="4.1" y1="5.75" x2="3.1" y2="6.4" />
                          <line x1="4.1" y1="5.75" x2="3.7" y2="4.4" />
                          <line x1="11.9" y1="10.25" x2="12.9" y2="9.6" />
                          <line x1="11.9" y1="10.25" x2="12.3" y2="11.6" />
                          <line x1="11.9" y1="5.75" x2="12.3" y2="4.4" />
                          <line x1="11.9" y1="5.75" x2="12.9" y2="6.4" />
                          <line x1="4.1" y1="10.25" x2="3.7" y2="11.6" />
                          <line x1="4.1" y1="10.25" x2="3.1" y2="9.6" />
                        </g>
                      </svg>
                    {/if}
                  {/if}
                </span>
              {/if}
            {/if}
            <span class="dock-label-activity">
              {#if (e.recentMessageCount ?? 0) >= recentThreshold}
                <span
                  class="dock-activity-badge"
                  title="{e.recentMessageCount} messages in the last 4h"
                  >{e.recentMessageCount}</span
                >
              {/if}
            </span>
          </span>
        </button>
      {/each}
    </div>

    <button
      class="dock-toggle"
      type="button"
      title={showInactive ? "Hide inactive sessions" : "Show inactive sessions"}
      aria-label={showInactive
        ? "Hide inactive sessions"
        : "Show inactive sessions"}
      on:click|stopPropagation={toggleInactive}
      on:mousedown|stopPropagation
    >
      <span class="dock-toggle-inner" class:filtering={!showInactive}></span>
    </button>

    <!-- Bottom half: dots stack top-down from the toggle. -->
    <div class="dock-half dock-bottom">
      {#each split.bottom as e, i (e.source)}
        {#if (i === 0 || split.bottom[i - 1].repoId !== e.repoId) && repoStatusMap.has(e.repoId)}
          {@const rs = repoStatusMap.get(e.repoId)}
          {@const dirtyCount = rs ? dockDirtyOf(rs) : 0}
          <span
            class="dock-dot dock-repo-arrow"
            style:--arrow-color={brightenIfDark(rs?.repoColor)}
            on:mouseenter={(ev) =>
              onArrowEnter(ev, rs?.repoId ?? e.repoId)}
            on:click={() =>
              dispatch("scrollToRepo", { repoId: rs?.repoId ?? e.repoId })}
          >
            <span class="dock-dot-inner dock-arrow-inner">
              {#if rs?.ahead}<svg
                  class="dock-arrow-glyph dock-arrow-up"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  ><path d={GIT_AHEAD} /></svg
                >{/if}
              {#if rs?.behind}<svg
                  class="dock-arrow-glyph dock-arrow-down"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  ><path d={GIT_BEHIND} /></svg
                >{/if}
              {#if dirtyCount && !rs?.ahead && !rs?.behind}<DirtyGlyph />{/if}
            </span>
            <span class="dock-label">
              <span class="dock-label-repo">{rs?.repoName}</span>
              <span class="dock-label-badges">
                {#if rs?.ahead}<StatusBadge compact ahead={rs.ahead} />{/if}
                {#if rs?.behind}<StatusBadge compact behind={rs.behind} />{/if}
                {#if dirtyCount}<StatusBadge
                    compact
                    dirty={dirtyCount}
                  />{/if}
              </span>
            </span>
          </span>
        {/if}
        <button
          type="button"
          class="dock-dot agent-{e.agent}"
          class:dot-working={e.working}
          class:dot-awaiting={e.awaiting}
          class:dot-awaiting-urgent={e.awaiting &&
            isAwaitingUrgent(e.source, nowTick)}
          class:dot-exited={e.exited}
          class:dot-pulsing={isPulsing(e, nowTick)}
          class:dock-dot-focused={focusedSource === e.source}
          class:dock-dot-repo-first={i > 0 &&
            split.bottom[i - 1].repoId !== e.repoId &&
            !repoStatusMap.has(e.repoId)}
          style:--dot-fill={brightenIfDark(e.repoColor)}
          aria-label={tooltipFor(e)}
          on:click={() => handlePick(e)}
          on:mouseenter={(ev) => onRowEnter(ev, e)}
          on:focusin={(ev) => onRowEnter(ev, e)}
        >
          {#if focusedSource === e.source}
            <svg class="dock-dot-arrow" viewBox="0 0 5 10" aria-hidden="true">
              <polyline points="0.5,0.5 4.5,5 0.5,9.5" />
            </svg>
          {/if}
          <span class="dock-dot-inner">
            <svg
              class="dock-dot-spinner"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9.5" pathLength="100" />
            </svg>
          </span>
          <span class="dock-label">
            <span class="dock-label-repo">{e.repoName}</span>
            {#if sessionNameFor(e)}
              <span class="dock-label-title">{sessionNameFor(e)}</span>
            {/if}
            {#if e.ioDebugLabel}
              <span class="dock-io-debug-label" title="Terminal inbound throughput">
                {e.ioDebugLabel}
              </span>
            {/if}
            {#if freshestTimestamp(e)}
              {@const ft = fuzzyTime(freshestTimestamp(e))}
              {#if ft}
                <span
                  class="dock-label-time"
                  class:dock-time-fresh={ft.kind === "text" && ft.fresh}
                  class:dock-time-text={ft.kind === "text"}
                  title={relTime(freshestTimestamp(e))}
                >
                  {#if ft.kind === "text"}
                    {ft.text}
                  {:else}
                    <span class="dock-time-hover">{relTime(freshestTimestamp(e))}</span>
                    {#if ft.icon === "calendar"}
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <rect x="2.5" y="3" width="11" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5" />
                        <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" stroke-width="1.5" />
                        <line x1="6" y1="1.5" x2="6" y2="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                        <line x1="10" y1="1.5" x2="10" y2="4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                      </svg>
                    {:else}
                      <!-- Snowflake: 6-arm star with side branches. -->
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none">
                          <line x1="8" y1="1.5" x2="8" y2="14.5" />
                          <line x1="2.4" y1="4.75" x2="13.6" y2="11.25" />
                          <line x1="2.4" y1="11.25" x2="13.6" y2="4.75" />
                          <line x1="8" y1="3.5" x2="6.5" y2="2.5" />
                          <line x1="8" y1="3.5" x2="9.5" y2="2.5" />
                          <line x1="8" y1="12.5" x2="6.5" y2="13.5" />
                          <line x1="8" y1="12.5" x2="9.5" y2="13.5" />
                          <line x1="4.1" y1="5.75" x2="3.1" y2="6.4" />
                          <line x1="4.1" y1="5.75" x2="3.7" y2="4.4" />
                          <line x1="11.9" y1="10.25" x2="12.9" y2="9.6" />
                          <line x1="11.9" y1="10.25" x2="12.3" y2="11.6" />
                          <line x1="11.9" y1="5.75" x2="12.3" y2="4.4" />
                          <line x1="11.9" y1="5.75" x2="12.9" y2="6.4" />
                          <line x1="4.1" y1="10.25" x2="3.7" y2="11.6" />
                          <line x1="4.1" y1="10.25" x2="3.1" y2="9.6" />
                        </g>
                      </svg>
                    {/if}
                  {/if}
                </span>
              {/if}
            {/if}
            <span class="dock-label-activity">
              {#if (e.recentMessageCount ?? 0) >= recentThreshold}
                <span
                  class="dock-activity-badge"
                  title="{e.recentMessageCount} messages in the last 4h"
                  >{e.recentMessageCount}</span
                >
              {/if}
            </span>
          </span>
        </button>
      {/each}
      <!-- Orphan arrows: repos with push/pull but no session dots. -->
      {#each orphanRepoArrows as rs (rs.repoId)}
        {@const dirtyCount = dockDirtyOf(rs)}
        <span
          class="dock-dot dock-repo-arrow dock-repo-arrow-orphan"
          style:--arrow-color={brightenIfDark(rs.repoColor)}
          on:mouseenter={(ev) => onArrowEnter(ev, rs.repoId)}
          on:click={() => dispatch("scrollToRepo", { repoId: rs.repoId })}
        >
          <span class="dock-dot-inner dock-arrow-inner">
            {#if rs.ahead}<svg
                class="dock-arrow-glyph dock-arrow-up"
                viewBox="0 0 12 12"
                aria-hidden="true"
                ><path d={GIT_AHEAD} /></svg
              >{/if}
            {#if rs.behind}<svg
                class="dock-arrow-glyph dock-arrow-down"
                viewBox="0 0 12 12"
                aria-hidden="true"
                ><path d={GIT_BEHIND} /></svg
              >{/if}
            {#if dirtyCount && showInactive && !rs.ahead && !rs.behind}<DirtyGlyph />{/if}
          </span>
          <span class="dock-label">
            <span class="dock-label-repo">{rs.repoName}</span>
            <span class="dock-label-badges">
              {#if rs.ahead}<StatusBadge compact ahead={rs.ahead} />{/if}
              {#if rs.behind}<StatusBadge compact behind={rs.behind} />{/if}
              {#if dirtyCount && showInactive}<StatusBadge
                  compact
                  dirty={dirtyCount}
                />{/if}
            </span>
          </span>
        </span>
      {/each}
    </div>
    {#if hoveredEntry?.transcriptSource}
      <aside
        bind:this={previewEl}
        class="dock-preview"
        style:top="{hoveredTop}px"
        aria-hidden="true"
        on:mouseenter={onDockEnter}
        on:mouseleave={onDockLeave}
      >
        <ChatPreview
          items={previews[hoveredEntry.transcriptSource]}
          summary={previewSummaries[hoveredEntry.transcriptSource]}
          agent={hoveredEntry.agent}
          loading={previewLoading[hoveredEntry.transcriptSource] ?? false}
        />
      </aside>
    {:else if hoveredRepoId && (dockRepoWorktrees[hoveredRepoId]?.length ?? 0) > 0}
      <aside
        bind:this={previewEl}
        class="dock-preview dock-preview-repo"
        style:top="{hoveredTop}px"
        aria-hidden="true"
        on:mouseenter={onDockEnter}
        on:mouseleave={onDockLeave}
      >
        <RepoStatusPreview
          worktrees={dockRepoWorktrees[hoveredRepoId] ?? []}
          {wtSummaries}
        />
      </aside>
    {/if}
  </div>
{/if}

<style>
  /* On narrow viewports the dock would eat into the (already cramped)
     dashboard. Hide it entirely below 800px — the user can still
     reach sessions via the in-row pickers. */
  @media (max-width: 799px) {
    .session-dock {
      display: none;
    }
  }
  .session-dock {
    position: fixed;
    /* Full viewport height so the two .dock-half children split
       evenly and the toggle sits at exact viewport center. The old
       `top: 50%; translateY(-50%)` shifted when dots appeared /
       disappeared, making the toggle jump. */
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 1600;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    border-radius: var(--radius-md, 8px);
    background: transparent;
    border: 1px solid transparent;
    /* The dock spans the full viewport height for centering but only
       the dot halves / toggle / backdrop carry content — clicks on
       the empty areas must pass through to the dashboard. Children
       that need interaction re-enable via pointer-events: auto. */
    pointer-events: none;
    transition:
      background-color 160ms ease,
      border-color 160ms ease;
  }
  /* Each half owns its scrollbar independently. Top stacks from
     the bottom (dots hug the toggle); bottom stacks from the top. */
  /* Each half takes exactly 50% of the remaining height (after the
     toggle) so the toggle stays at viewport center. The halves
     themselves are transparent — only the dot buttons inside get a
     background on hover (via .show-labels). No scrollbar, no
     overflow clipping: dots stack naturally and the half just
     provides the flex-centering anchor. */
  .dock-half {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.15rem;
    padding: 0.15rem 0.5rem;
    overflow: hidden;
    pointer-events: none;
    /* Above the z-index: 0 backdrop. */
    position: relative;
    z-index: 1;
  }
  .dock-half > :global(*) {
    pointer-events: auto;
  }
  .dock-top {
    justify-content: flex-end;
  }
  .dock-bottom {
    justify-content: flex-start;
  }
  /* Faint 20%-text outline on hover so the dock's frame is
     perceptible alongside the page-bg card and revealed labels.
     Resting state stays chrome-free. */
  /* Continuous backdrop behind the dot column. Positioned absolutely
     inside the dock, sized by JS (updateBackdrop) to cover exactly
     the bounding box of all visible dots + toggle. Only visible when
     labels are shown — resting state is chrome-free. */
  .dock-backdrop {
    position: absolute;
    display: none;
    background: var(--surface-0, #23261d);
    border-radius: var(--radius-md, 8px);
    border: 1px solid
      color-mix(in oklch, var(--text-1, #e8e8e8) 15%, transparent);
    pointer-events: none;
    z-index: 0;
    transition: opacity 160ms ease;
    opacity: 0;
  }
  .dock-backdrop.visible {
    opacity: 1;
    /* Bridge the dead gaps between dots. The backdrop covers the exact
       bounding box of the dot column (gaps + repo-group margins
       included), so capturing pointer events here keeps the cursor
       "inside" the dock while sliding between dots — without it,
       crossing a gap reports a relatedTarget outside the dock and the
       100ms dismiss timer closes it mid-hover. It sits at z-index 0
       under the dots (z-index 1), so it never steals a dot click, and
       it's display:none at rest, so click-through stays intact. */
    pointer-events: auto;
  }
  /* While a click is being acted on (smooth-scroll to the picked
     session), suppress the label reveal even if hover/focus is still
     active. The flag clears on a short timer, so the labels come
     back the next time the user intentionally hovers the dock. */
  .session-dock.collapsed .dock-label {
    max-width: 0;
    opacity: 0;
    pointer-events: none;
  }

  .dock-dot {
    --agent-color: var(--text-2);
    position: relative;
    /* No fixed width any more — the button grows to fit dot + label
       on hover. Generous padding on every side enlarges the click /
       hover hit zone well past the 10px visible dot so the user
       doesn't have to pixel-hunt to trigger labels or pick a row. */
    padding: 3px 8px;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 0.5rem;
    flex: 0 0 auto;
    /* Chromium's UA stylesheet for <button> doesn't inherit font from
       the page, so without this the dock labels render in the default
       button font (Arial-ish on Windows) while the rest of the UI uses
       Segoe UI from body — letterforms visibly mismatch. */
    font: inherit;
  }
  /* Top margin on the first dot of each new repo group so the dock
     visually separates per-repo stacks. Applied via a class set in
     the markup using a prev-entry-vs-current-entry repoId compare. */
  .dock-dot.dock-dot-repo-first {
    margin-top: 0.6rem;
  }
  /* Center toggle: a small circle that sits between the top and
     bottom halves of the dock. Clicking it filters exited/read-mode
     dots on and off. Inherits the dock's button styling but has its
     own disc visual instead of a repo-coloured dot. */
  .dock-toggle {
    position: relative;
    z-index: 1;
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    /* Same padding as dock-dot (3px 8px) PLUS the dock-half's
       horizontal padding (0.5rem ≈ 8px) so the toggle-inner
       centre aligns with the dot-inner centres above/below. */
    padding: 0.2rem 8px 0.2rem calc(8px + 0.5rem);
    border: 0;
    background: transparent;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .dock-toggle,
  .dock-toggle:hover,
  .dock-toggle:focus,
  .dock-toggle:active {
    background: transparent;
  }
  /* 10px box matching dock-dot-inner so horizontal centres align.
     The visible circle is inset via border (6px visible area). */
  .dock-toggle-inner {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    border: 2px solid
      color-mix(in oklch, var(--text-muted, #9a9aa0) 50%, transparent);
    box-sizing: border-box;
    background: transparent;
    flex: 0 0 auto;
    transition:
      background-color 160ms ease,
      border-color 160ms ease;
  }
  .dock-toggle-inner.filtering {
    background: color-mix(
      in oklch,
      var(--text-muted, #9a9aa0) 50%,
      transparent
    );
  }
  .dock-toggle:hover .dock-toggle-inner {
    border-color: var(--text-1, #e8e8e8);
  }

  /* Push/pull arrow rows per repo group. Rendered as dock-dot-shaped
     rows (same padding, same alignment) so arrows sit in the list
     alongside session dots. The arrow SVGs are thick-body ↑↓ shapes
     matching the git badge style. */
  /* Arrow row: the dock-dot-inner slot holds ↑/↓ text glyphs instead
     of a coloured disc. Same 10px box as a real dot, transparent
     background so only the glyph reads. */
  .dock-arrow-inner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    background: transparent !important;
    border: 0 !important;
  }
  /* Pull ↑↓ pair tight when both are present. Split the negative
     margin equally: first glyph shifts right, second shifts left,
     so the pair stays centered in the 10px box. */
  .dock-arrow-inner .dock-arrow-glyph + .dock-arrow-glyph {
    margin-left: -1px;
  }
  .dock-arrow-inner .dock-arrow-glyph:first-child:not(:last-child) {
    margin-right: -1px;
  }
  .dock-repo-arrow {
    cursor: pointer;
    /* Arrows are the topmost element of a repo group — increase
       the gap above them so repos are visually separated. */
    margin-top: 0.6rem;
  }
  .dock-repo-arrow:first-child {
    margin-top: 0;
  }
  .dock-repo-arrow-orphan {
    margin-top: 0.3rem;
  }
  /* SVG chevrons (same paths as StatusBadge ↑/↓) so the arrows render
     consistently across platforms — the prior text glyphs ↑↓ leaned on
     a system fallback font and came out visibly smaller on Windows. */
  .dock-arrow-glyph {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
    fill: none;
    stroke: var(--arrow-color, var(--text-muted, #9a9aa0));
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* Two quick bounces in the first ~20% of the cycle, then idle for
     the remaining ~80% (~3s pause at 4s total). The 2× speed comes
     from cramming both bounces into the first 800ms of the 4s loop. */
  .dock-arrow-up {
    animation: dock-arrow-bounce-up 10s ease-in-out infinite;
  }
  .dock-arrow-down {
    animation: dock-arrow-bounce-down 10s ease-in-out infinite;
  }
  @keyframes dock-arrow-bounce-up {
    0% {
      transform: translateY(0);
    }
    2% {
      transform: translateY(-3px);
    }
    4% {
      transform: translateY(0);
    }
    6% {
      transform: translateY(-3px);
    }
    8% {
      transform: translateY(0);
    }
    100% {
      transform: translateY(0);
    }
  }
  @keyframes dock-arrow-bounce-down {
    0% {
      transform: translateY(0);
    }
    2% {
      transform: translateY(3px);
    }
    4% {
      transform: translateY(0);
    }
    6% {
      transform: translateY(3px);
    }
    8% {
      transform: translateY(0);
    }
    100% {
      transform: translateY(0);
    }
  }
  /* The dirty tilde and its wave live in DirtyGlyph.svelte — a SMIL
     <animate> morphs the path `d` (rocks the humps up↔down). Not a CSS `d:`
     keyframe: CSS `d` only interpolates in Chromium and freezes in WKWebView
     (WebKit, macOS); SMIL morphs in both. We briefly tried a composited
     translateX scroll for perf, but the F8 trace showed the real Layerize
     cost was the always-on dock spinner, not this morph — so the rock stayed.
     See that component + plans/performance.md. */
  @media (prefers-reduced-motion: reduce) {
    .dock-arrow-up,
    .dock-arrow-down {
      animation: none;
    }
  }
  /* Wrapper for the StatusBadge compact pills inside a hover label.
     Inline-flex so the pills sit on the same baseline as the repo
     name and respect the parent label's gap. */
  .dock-label-badges {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex: 0 0 auto;
  }
  /* Shell sessions render as a small terminal-styled square instead
     of the agent's round dot: dark center + repo-coloured border,
     2px rounded corners. Reads as "this is a literal terminal, not
     a conversational agent" at a glance, and `working` / `awaiting`
     are forced off in the host so log-stream output doesn't trigger
     the spinner. */
  .dock-dot.agent-shell .dock-dot-inner {
    background: var(--surface-0, #1a1a1a);
    border: 2px solid var(--dot-fill);
    border-radius: 2px;
    box-sizing: border-box;
  }
  /* Focused row: small triangle pointing right at the dot, painted in
     the button's left padding area so it doesn't push the dot
     horizontally. CSS border-trick triangle — no extra DOM. The
     button's `position: relative` (set above) anchors the ::before
     to the button's bounds. */
  .dock-dot-arrow {
    position: absolute;
    /* Negative left pulls the triangle into the dock's left padding
       (the dock itself has 0.5rem of padding to spare here), giving
       it a clear gap from the dot it points at. */
    left: -3px;
    top: 50%;
    width: 5px;
    height: 10px;
    transform: translateY(-50%);
    pointer-events: none;
    /* Pop in/out softly when focus moves between rows so the eye can
       follow the marker rather than seeing it teleport. */
    transition: opacity 140ms ease;
    /* Visible overflow so rounded line joins don't get clipped by
       the tight viewBox bounds. */
    overflow: visible;
  }
  .dock-dot-arrow polyline {
    /* Lower-contrast "you are here" chevron — open shape (no back
       edge connecting the top-left and bottom-left points) so it
       reads as a chevron mark rather than a filled arrowhead.
       text-muted at ~55% alpha keeps it from competing with the
       live working/awaiting animations. */
    fill: none;
    stroke: color-mix(in oklch, var(--text-muted, #9a9aa0) 55%, transparent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  /* The inner span IS the visible dot. Keeping the click target as the
     wrapper button means the hit area can stay larger (14px) than the
     drawn dot (10px) without needing extra padding. */
  .dock-dot-inner {
    /* Position-relative so the working state's ::before ring anchors
       to the dot's outer bounds rather than the (much larger) padded
       button. */
    position: relative;
    width: 10px;
    height: 10px;
    /* Don't let flex shrink the dot when the label appears. */
    flex: 0 0 auto;
    border-radius: 999px;
    /* Solid repo colour — both fill and any activity ring use this
       same hue, so the dot always reads as "which repo" first. */
    background: var(--dot-fill);
    box-sizing: border-box;
    transition:
      transform 160ms ease,
      opacity 160ms ease,
      background-color 220ms ease;
  }
  /* "Unread" pulse: gentle scale up/down for sessions where the
     AI just finished a turn but the user hasn't focused them yet.
     Animation runs forever in CSS — the JS side toggles the
     class off after 20 min or when the row is picked. Skipped
     when working or awaiting already cover the dot. */
  .dock-dot.dot-pulsing .dock-dot-inner {
    animation: dock-unread-pulse 0.6s ease-in-out infinite;
  }
  @keyframes dock-unread-pulse {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.25);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-dot.dot-pulsing .dock-dot-inner {
      animation: none;
    }
  }
  /* Ended / inactive session: shrink the visible dot via a transform
     so the box dimensions stay at 10×10. Keeping the box size means
     the small dot is horizontally centered on the same x as the
     big-dot rows, and the wrapping button keeps its full hit zone
     for hover + click. transform-origin: center scales around the
     dot's middle so it stays put while shrinking. */
  .dock-dot.dot-exited .dock-dot-inner {
    transform: scale(0.6);
    transform-origin: center;
    opacity: 0.55;
  }
  /* Inactive sessions also dim the session-name label to match
     the dot — bright text-1 was reserved for *live* rows. */
  .dock-dot.dot-exited .dock-label-title {
    color: var(--text-muted, #9a9aa0);
  }
  /* Inline session-name label. Hidden in resting state (no width, no
     opacity) so the dock is a thin vertical strip of dots. On
     `.session-dock:hover` (anywhere over the dock) every label fades
     in beside its dot. Background + padding on the label only — so
     the dock itself stays chrome-free per request, and labels still
     read against busy content behind the page. */
  .dock-label {
    /* Inline-flex so children (repo / title / time) align on a
       single baseline and the time segment can push to the right
       edge via margin-left: auto — that way the rightmost time
       column lines up vertically across every row, regardless of
       title width. Padding stays constant between rest / hover so
       the button never shifts vertically when labels appear. */
    display: inline-flex;
    align-items: baseline;
    gap: 0.3em;
    overflow: hidden;
    white-space: nowrap;
    max-width: 0;
    opacity: 0;
    padding: 3px 0;
    box-sizing: border-box;
    font-size: 0.72rem;
    line-height: 1;
    color: var(--text-1, #e8e8e8);
    background: transparent;
    pointer-events: none;
    transition:
      max-width 180ms ease,
      opacity 140ms ease;
  }
  .session-dock.show-labels .dock-label {
    /* Take the full width of the dock row (the parent button is
       `width: 100%` via align-items: stretch on the dock); no
       max-width cap so long titles can stretch out. */
    max-width: 100%;
    flex: 1 1 auto;
    opacity: 1;
    /* Clicks on the visible label should also fire the dot's
       on:click — the label is a child of the same <button>, so once
       pointer-events go through the click bubbles up and triggers
       the same `dispatch("pick", ...)` the dot would. */
    pointer-events: auto;
    cursor: pointer;
  }
  /* Hover state: keep the same dotted underline but no extra
     visual change — the title is already bright at rest, the
     underline already communicates "clickable". */
  /* All three label segments share `vertical-align: baseline` so
     they line up on the text baseline regardless of inline-block
     padding / borders. Default vertical-align varies between
     inline-block (baseline of last line) and inline (baseline of
     own content); explicit baseline keeps them in sync. */
  .dock-label-repo {
    display: inline-block;
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: baseline;
    color: var(--text-muted, #9a9aa0);
    font-weight: 400;
  }
  .dock-label-time {
    display: inline-flex;
    align-items: center;
    align-self: center;
    gap: 0.2em;
    color: var(--text-muted, #9a9aa0);
    margin-left: auto;
    padding-left: 1em;
  }
  .dock-label-time svg {
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    display: block;
  }
  /* Tabular numbers so 1h / 12h / 47m line up across rows. */
  .dock-label-time.dock-time-text {
    font-variant-numeric: tabular-nums;
    font-size: 0.78em;
  }
  /* Reveals a full "X days ago" text to the left of the calendar /
     snowflake icon when the row is hovered, so cold sessions still
     give an exact age on demand without crowding the dock at rest. */
  .dock-time-hover {
    font-size: 0.78em;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transition: opacity 100ms ease;
    white-space: nowrap;
  }
  .dock-dot:hover .dock-time-hover,
  .dock-dot:focus-visible .dock-time-hover {
    opacity: 1;
  }
  /* Brighten very recent sessions (< 30min / < 2h) so they pop. */
  .dock-label-time.dock-time-fresh {
    color: var(--text-1, #e8e8e8);
  }
  .dock-io-debug-label {
    display: inline-flex;
    align-items: center;
    align-self: center;
    flex: 0 0 auto;
    font-size: 0.58rem;
    font-variant-numeric: tabular-nums;
    color: color-mix(in oklch, var(--accent, #7dd3fc) 82%, var(--text-1, #e8e8e8));
    background: color-mix(in oklch, var(--accent, #7dd3fc) 14%, transparent);
    border: 1px solid
      color-mix(in oklch, var(--accent, #7dd3fc) 28%, transparent);
    border-radius: var(--radius-sm, 4px);
    padding: 0.1em 0.35em;
    line-height: 1;
    opacity: 0.9;
  }
  /* Fixed-width cell that always reserves space so the time column
     doesn't shift when the badge appears/disappears on hover
     refresh. The badge itself only renders for "hot" sessions. */
  .dock-label-activity {
    display: inline-block;
    width: 2.4em;
    text-align: right;
    vertical-align: baseline;
    flex: 0 0 auto;
  }
  .dock-activity-badge {
    font-size: 0.58rem;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--text-1, #e8e8e8);
    background: color-mix(in oklch, var(--text-1, #e8e8e8) 12%, transparent);
    border: 1px solid
      color-mix(in oklch, var(--text-1, #e8e8e8) 18%, transparent);
    border-radius: var(--radius-sm, 4px);
    padding: 0.1em 0.35em;
    line-height: 1;
    opacity: 0.75;
  }
  .dock-label-title {
    display: inline-block;
    max-width: 35ch;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: baseline;
    margin-left: 0.3em;
    /* Bright text so the session name stands out from the muted
       repo/time segments — it's the thing you're scanning for. */
    color: var(--text-1, #e8e8e8);
    font-weight: 400;
    /* Dotted underline via text-decoration (not border) so the
       box dimensions don't change between rest and hover — a
       border-bottom adds 1px of height which shifts the row's
       vertical centre. text-decoration paints inside the line box
       and doesn't affect layout. */
    text-decoration: underline dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 1px;
  }

  /* Side preview panel — positioned container around <ChatPreview>.
     Anchored to the dock container (not a specific button) so its
     x position stays constant; `top` is set inline from the hovered
     button's offsetTop so the panel slides vertically to align with
     the active row but never shifts horizontally. The bubble styles
     themselves live in ChatPreview.svelte. */
  .dock-preview {
    position: absolute;
    left: 100%;
    margin-left: 0.15rem;
    transform: translateY(-50%);
    width: 26rem;
    background: transparent;
    border-radius: var(--radius-md, 8px);
    padding: 0.55rem 0.7rem;
    /* Capture hover events so moving onto the preview keeps the
       overlay alive (the dock's mouseleave fires when the cursor
       crosses out of its bbox into the preview area — the panel's
       own mouseenter cancels the dismiss timer). */
    pointer-events: auto;
    /* Smooth vertical follow as the user moves between rows. */
    transition: top 140ms ease;
  }
  /* Repo-status variant: a tooltip-style opaque chip instead of the
     chat preview's transparent gutter. Width shrinks to content (drop
     the 26rem fixed cap) but stays inside the viewport, height fits
     content (no inner scroll — the panel itself grows; the dock's
     clamp logic keeps the whole thing on-screen). */
  .dock-preview-repo {
    width: auto;
    max-width: min(60rem, calc(100vw - var(--dock-width, 12rem) - 2rem));
    background: color-mix(in srgb, var(--surface-3, #2a2a2c) 92%, #ffffff 8%);
    color: var(--text-1, #e8e8e8);
    border: 1px solid
      color-mix(in srgb, var(--surface-3, #2a2a2c) 70%, #ffffff 30%);
    border-radius: var(--radius-sm, 0.35rem);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6);
  }
  /* Belt-and-braces: kill any user-agent / inherited hover background
     on the button itself. The dot is its own visual; the wrapper is
     just a hit zone, so it stays transparent in every state. */
  .dock-dot,
  .dock-dot:hover,
  .dock-dot:focus,
  .dock-dot:focus-visible,
  .dock-dot:active {
    background: transparent;
  }
  /* Working: hide the solid dot fill entirely and show a thick
     rotating SVG arc in its place. The arc uses `stroke-linecap:
     round` so the head and tail are clean rounded caps — the old
     conic-gradient + mask trick couldn't round its line ends.
     Anchored to .dock-dot-inner so the spinner tracks the dot
     rather than the (much larger) padded hit-zone wrapper. */
  .dock-dot.dot-working .dock-dot-inner {
    /* Solid fill dims to a faint hint of the repo colour so the ring
       is the dominant element but the dot doesn't disappear entirely.
       `color-mix(... transparent)` is the simplest way to keep the
       hue and just fade the alpha — `opacity` would also dim the
       child SVG ring. */
    background: color-mix(in oklch, var(--dot-fill) 20%, transparent);
  }
  .dock-dot-spinner {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* Round caps can extend slightly tangentially past the path's
       bounding circle; visible overflow keeps them from clipping. */
    overflow: visible;
    pointer-events: none;
    /* Hidden by default; the .dot-working modifier fades it in. */
    opacity: 0;
    transition: opacity 220ms ease;
  }
  /* Only spin while actually working. An always-running animation auto-
     promotes its element to a compositor layer — so leaving `dock-spin` on
     every (invisible) spinner kept EVERY idle dock dot on its own layer,
     inflating the Layerize walk for nothing. Gating on `.dot-working` lets
     idle dots de-promote. The tiny cost — the arc snaps from rest instead of
     already-moving when a turn starts — is imperceptible at 0.9s/rev. */
  .dock-dot.dot-working .dock-dot-spinner {
    opacity: 1;
    animation: dock-spin 0.9s linear infinite;
    /* NB: tried `will-change: transform` here (2026-06-10, 3fb231f) to
       composite the SVG rotate — it BACKFIRED. A verification trace showed
       huge 75-200ms Layerize spikes during typing/scroll/focus: forcing the
       spinner onto a permanent layer is exactly the "will-change multiplies
       Layerize cost" anti-pattern in performance.md. Reverted. If the SVG
       repaint cost matters again, swap the SVG arc for a CSS <span> spinner
       (border + border-radius + rotate on an HTML element) — that composites
       without will-change. */
  }
  .dock-dot-spinner circle {
    fill: none;
    /* Brightened repo tint so the arc is clearly visible against
       whatever's behind the dock. Bumped saturation vs. the solid
       fill so the ring reads as "this dot is doing something" at
       a glance. */
    stroke: color-mix(in oklch, var(--dot-fill) 65%, #fff 35%);
    /* Thick enough to be legible at 10px; `r=9.5` keeps the outer
       edge of the stroke flush with the dot's 10px footprint. */
    stroke-width: 5;
    stroke-linecap: round;
    /* `pathLength="100"` (set on the element) lets dash values read
       as percentages. 35/65 = a ~125° visible arc — long enough to
       read as motion, short enough that the gap is unambiguous. */
    stroke-dasharray: 35 65;
  }
  @keyframes dock-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Idle (PTY alive, nothing streaming, no prompt): no outline at
     all. The bare repo-coloured dot is the "alive" signal; the
     spinner + awaiting pulse are reserved for "something's
     happening". */

  /* Awaiting (mild): gentle pulse for the first 20s — the user
     probably noticed but hasn't acted yet. */
  /* Composited: the dot scales (transform only — GPU), and the halo is a
     pseudo-element whose OPACITY pulses over a STATIC ring. The old version
     interpolated a box-shadow color-mix(var()) which WebKit re-resolves
     every frame as a style recalc (~2/frame across awaiting dots — see
     plans/performance.md). ::before is taken by the working ring, so the
     halo uses ::after. */
  .dock-dot.dot-awaiting .dock-dot-inner {
    animation: dock-awaiting 1.1s ease-in-out infinite;
  }
  @keyframes dock-awaiting {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.35);
    }
  }
  .dock-dot.dot-awaiting .dock-dot-inner::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--dot-fill) 30%, #fff 70%);
    animation: dock-awaiting-halo 1.1s ease-in-out infinite;
  }
  /* Awaiting (urgent): after 20s without user action, escalate —
     bigger scale, faster cadence, stronger glow so the dot is
     impossible to miss. */
  .dock-dot.dot-awaiting-urgent .dock-dot-inner {
    animation: dock-awaiting-urgent 0.7s ease-in-out infinite;
  }
  @keyframes dock-awaiting-urgent {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.5);
    }
  }
  .dock-dot.dot-awaiting-urgent .dock-dot-inner::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: 0 0 0 4px color-mix(in oklch, var(--dot-fill) 40%, #fff 60%);
    animation: dock-awaiting-halo 0.7s ease-in-out infinite;
  }
  /* Shared halo: fade a static ring in/out — composited opacity only. */
  @keyframes dock-awaiting-halo {
    0%,
    100% {
      opacity: 0;
    }
    50% {
      opacity: 0.85;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-dot-spinner,
    .dock-dot.dot-awaiting .dock-dot-inner,
    .dock-dot.dot-awaiting-urgent .dock-dot-inner,
    .dock-dot.dot-awaiting .dock-dot-inner::after,
    .dock-dot.dot-awaiting-urgent .dock-dot-inner::after {
      animation: none;
    }
  }
</style>
