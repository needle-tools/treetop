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
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import ChatPreview from "./ChatPreview.svelte";
  import {
    fetchPreviewItems,
    type PreviewAction,
    type PreviewGap,
    type PreviewMsg,
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
    lastUserMessage?: string;
    /** ISO timestamp of the session's most recent activity. Drives
     *  the "5 minutes ago" segment in the hover label. */
    lastActive?: string;
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
  }

  export let entries: DockEntry[];
  /** Source of the session the user most recently focused via this
   *  dock. The matching row paints a small left-pointing triangle so
   *  the user can scan the strip and instantly see which dot maps to
   *  the column they're currently looking at. `null` ⇒ no row is
   *  marked as focused. */
  export let focusedSource: string | null = null;

  const dispatch = createEventDispatcher<{ pick: DockEntry }>();

  /** How long the "unread" pulse stays on after the AI finishes
   *  a turn (working → idle). Caps the noise so a long-ignored
   *  finished session doesn't keep nagging forever. */
  const PULSE_MAX_MS = 20 * 60 * 1000;
  /** Clock tick. Re-rendered every minute so the per-row
   *  `isPulsing(e)` derivation expires `finishedAt` markers
   *  cleanly without a per-row timer. */
  let nowTick = Date.now();
  let nowTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    nowTimer = setInterval(() => {
      nowTick = Date.now();
    }, 60_000);
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
    return cached ?? entry.lastActive;
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
      clampedCenterVp = Math.max(minCenterVp, Math.min(maxCenterVp, desiredCenterVp));
    }
    const clampedTop = clampedCenterVp - dockRect.top;
    if (Math.abs(clampedTop - hoveredTop) > 0.5) hoveredTop = clampedTop;
  }
  $: if (hoveredEntry && previewEl && dockEl) {
    // After layout settles (next frame), measure + clamp. The
    // dependency on hoveredEntry re-fires the clamp whenever the
    // user moves to a different row.
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

  function onRowEnter(ev: Event, entry: DockEntry) {
    cancelDismiss();
    cancelShowPreview();
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
      showLabels = false;
      stopPreviewPoll();
      dismissTimer = null;
    }, DISMISS_DELAY_MS);
  }

  function tooltipFor(e: DockEntry): string {
    const lines: string[] = [];
    lines.push(`${e.repoName}${e.branch ? ` · ${e.branch}` : ""}`);
    const t = e.manualTitle ?? e.title;
    if (t) lines.push(t);
    if (e.lastUserMessage) {
      const cap = e.lastUserMessage.length > 200
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
    const t = e.manualTitle ?? e.title;
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
</script>

{#if entries.length > 0}
  <div
    bind:this={dockEl}
    class="session-dock"
    class:collapsed={collapseAfterClick}
    class:show-labels={showLabels}
    role="toolbar"
    aria-label="Open sessions"
    on:mouseenter={onDockEnter}
    on:mouseleave={onDockLeave}
    on:focusin={onDockEnter}
  >
    <!-- Scrollable list of dots. The scroller sits inside the
         positioned `.session-dock` shell so the preview aside below
         can sit at `left: 100%` without being clipped by the
         scroller's overflow rule. -->
    <div class="dock-scroller">
    {#each entries as e, i (e.source)}
      <button
        type="button"
        class="dock-dot agent-{e.agent}"
        class:dot-working={e.working}
        class:dot-awaiting={e.awaiting}
        class:dot-exited={e.exited}
        class:dot-pulsing={isPulsing(e, nowTick)}
        class:dock-dot-focused={focusedSource === e.source}
        class:dock-dot-repo-first={i > 0 && entries[i - 1].repoId !== e.repoId}
        style:--dot-fill={brightenIfDark(e.repoColor)}
        aria-label={tooltipFor(e)}
        on:click={() => handlePick(e)}
        on:mouseenter={(ev) => onRowEnter(ev, e)}
        on:focusin={(ev) => onRowEnter(ev, e)}
      >
        {#if focusedSource === e.source}
          <!-- Focus marker: tall slim outlined triangle pointing at
               the dot. SVG (rather than the older CSS border-trick)
               lets us draw a hollow shape with rounded joins; the
               border-trick can only produce filled triangles. -->
          <svg
            class="dock-dot-arrow"
            viewBox="0 0 5 10"
            aria-hidden="true"
          >
            <polyline points="0.5,0.5 4.5,5 0.5,9.5" />
          </svg>
        {/if}
        <span class="dock-dot-inner">
          <!-- Working: a thick partial-arc SVG stroke rotates around
               the dot's centre. SVG (rather than the old conic-
               gradient + mask trick) lets us use
               `stroke-linecap: round` so the visible arc's head
               and tail are clean rounded caps. Always rendered so
               the opacity can fade in/out on working state changes
               — `{#if e.working}` would snap it on/off. -->
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
          {#if freshestTimestamp(e)}
            <span class="dock-label-time">{relTime(freshestTimestamp(e))}</span>
          {/if}
        </span>
      </button>
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
          agent={hoveredEntry.agent}
          loading={previewLoading[hoveredEntry.transcriptSource] ?? false}
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
    /* Pinned to the left edge of the viewport, vertically centered.
       The sticky-notes layer sits at z 900 (notes) / 1500 (dragged
       note), so this dock takes 1600 to stay readable on top. No
       background, border, or shadow — the dock is just the row of
       dots, with labels fading in beside them on hover. */
    /* Pinned flush against the viewport's left edge. The hover
       outline keeps the right side rounded; the left side bleeds
       off-screen so the dock reads as docked. */
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1600;
    /* The shell itself doesn't lay out the dot list — the inner
       .dock-scroller does. The shell stays as a fixed-position
       wrapper so the side preview aside (position: absolute,
       left: 100%) anchors to it without being clipped by the
       scroller's overflow rule. */
    display: inline-block;
    border-radius: var(--radius-md, 8px);
    background: transparent;
    /* Always-on transparent border so the dock's bounds don't
       jitter by 1px when the hover state paints a real one. */
    border: 1px solid transparent;
    transition:
      background-color 160ms ease,
      border-color 160ms ease;
  }
  /* Scrollable inner column holding the dot list. Caps at the
     viewport height so a long dock (lots of open sessions) can't
     run off the top/bottom edge — `overflow-y: auto` only paints
     a scrollbar when actually needed; short docks stay chrome-free.
     The outer .session-dock keeps its `top: 50%` + translateY(-50%)
     centering, so when this scroller is shorter than 100vh the
     whole dock floats vertically centered. */
  .dock-scroller {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.15rem;
    padding: 0.35rem 0.5rem;
    max-height: 100vh;
    overflow-y: auto;
    /* Hide the dedicated scrollbar; reveal it only when the user is
       actually interacting with the dock. Keeps the resting strip
       chrome-free. */
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
  }
  .session-dock.show-labels .dock-scroller {
    scrollbar-color: color-mix(in oklch, var(--text-muted, #9a9aa0) 50%, transparent) transparent;
  }
  .dock-scroller::-webkit-scrollbar {
    width: 6px;
  }
  .dock-scroller::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
  }
  .session-dock.show-labels .dock-scroller::-webkit-scrollbar-thumb {
    background: color-mix(in oklch, var(--text-muted, #9a9aa0) 50%, transparent);
  }
  /* Faint 20%-text outline on hover so the dock's frame is
     perceptible alongside the page-bg card and revealed labels.
     Resting state stays chrome-free. */
  .session-dock.show-labels {
    border-color: color-mix(in oklch, var(--text-1, #e8e8e8) 20%, transparent);
  }
  /* `.show-labels` is set by JS (mouseenter on the dock, plus a
     1s grace timer on mouseleave) so labels + chat preview share
     the same lifecycle and don't vanish the moment the cursor
     drifts off. */
  .session-dock.show-labels {
    background: var(--surface-0, #23261d);
  }
  /* While a click is being acted on (smooth-scroll to the picked
     session), suppress both the wrapping background and the label
     reveal even if hover/focus is still active. The flag clears on
     a short timer, so the labels come back the next time the user
     intentionally hovers the dock. */
  .session-dock.collapsed {
    background: transparent;
  }
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
  }
  /* Top margin on the first dot of each new repo group so the dock
     visually separates per-repo stacks. Applied via a class set in
     the markup using a prev-entry-vs-current-entry repoId compare. */
  .dock-dot.dock-dot-repo-first {
    margin-top: 0.5rem;
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
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.25); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-dot.dot-pulsing .dock-dot-inner { animation: none; }
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
    vertical-align: baseline;
    color: var(--text-muted, #9a9aa0);
    /* Pushes the time chip to the right edge of the label so every
       row's time aligns in the same vertical column. */
    margin-left: auto;
    padding-left: 1em;
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
    /* Hidden by default; the .dot-working modifier fades it in. The
       spin animation runs unconditionally so the arc is already
       moving the moment it becomes visible (a freshly-mounted
       spinner doesn't snap from rest into motion). */
    opacity: 0;
    transition: opacity 220ms ease;
    animation: dock-spin 0.9s linear infinite;
  }
  .dock-dot.dot-working .dock-dot-spinner {
    opacity: 1;
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
    to { transform: rotate(360deg); }
  }

  /* Idle (PTY alive, nothing streaming, no prompt): no outline at
     all. The bare repo-coloured dot is the "alive" signal; the
     spinner + awaiting pulse are reserved for "something's
     happening". */

  /* Awaiting: stronger, attention-grabbing pulse — the dot scales up
     and its outline blinks the repo color at a faster cadence. This
     is the "come deal with me" state. */
  .dock-dot.dot-awaiting .dock-dot-inner {
    animation: dock-awaiting 1.1s ease-in-out infinite;
  }
  @keyframes dock-awaiting {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 0 0 color-mix(in oklch, var(--dot-fill) 30%, #fff 70%);
    }
    50% {
      transform: scale(1.25);
      box-shadow: 0 0 0 4px color-mix(in oklch, var(--dot-fill) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-dot-spinner,
    .dock-dot.dot-awaiting .dock-dot-inner { animation: none; }
  }
</style>
