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
  import { createEventDispatcher, onDestroy } from "svelte";
  import {
    buildPreviewItems,
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
    agent: "claude" | "codex" | "copilot" | "shell";
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
  }

  export let entries: DockEntry[];

  const dispatch = createEventDispatcher<{ pick: DockEntry }>();

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
    try {
      const res = await fetch(`/api/session?source=${encodeURIComponent(source)}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        messages?: Array<{
          role: string;
          timestamp?: string;
          blocks: Array<{
            type?: string;
            text?: string;
            toolName?: string;
            toolInput?: unknown;
          }>;
        }>;
      };
      const all = data.messages ?? [];
      previews = { ...previews, [source]: buildPreviewItems(all) };
      // Newest user/assistant message timestamp, used by the dock
      // label's "x time ago" so it reflects actual chat activity
      // rather than the session file's mtime.
      let latest: string | undefined;
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i]!;
        if (m.role !== "user" && m.role !== "assistant") continue;
        if (typeof m.timestamp === "string" && m.timestamp.length > 0) {
          latest = m.timestamp;
          break;
        }
      }
      if (latest) {
        latestMessageTs = { ...latestMessageTs, [source]: latest };
      }
    } catch {
      // ignore network blips; the poll timer will catch up
    } finally {
      previewLoading = { ...previewLoading, [source]: false };
    }
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

  function previewSnippet(text: string): string {
    if (text.length <= 240) return text;
    return text.slice(0, 239) + "…";
  }

  /** Single shared preview state: which row is hovered (drives which
   *  transcript is rendered in the panel) and where to anchor the
   *  panel vertically (so it floats next to the hovered row inside
   *  the dock's fixed-position frame). One aside is rendered at
   *  the dock level — the panel's left position is constant
   *  regardless of label widths, which the user explicitly wanted. */
  let hoveredEntry: DockEntry | null = null;
  let hoveredTop = 0;
  /** Driven by JS instead of plain :hover/:focus-within so the
   *  whole dock — labels AND chat preview — can stay visible for a
   *  grace period after the cursor leaves. */
  let showLabels = false;
  /** Grace timer so the dock doesn't vanish the instant the cursor
   *  leaves — gives the user a beat to read it. */
  const DISMISS_DELAY_MS = 1000;
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
      hoveredTop = btn.offsetTop + btn.offsetHeight / 2;
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
    class="session-dock"
    class:collapsed={collapseAfterClick}
    class:show-labels={showLabels}
    role="toolbar"
    aria-label="Open sessions"
    on:mouseenter={onDockEnter}
    on:mouseleave={onDockLeave}
    on:focusin={onDockEnter}
  >
    {#each entries as e, i (e.source)}
      <button
        type="button"
        class="dock-dot agent-{e.agent}"
        class:dot-working={e.working}
        class:dot-awaiting={e.awaiting}
        class:dock-dot-repo-first={i > 0 && entries[i - 1].repoId !== e.repoId}
        style:--dot-fill={e.repoColor ?? "var(--surface-3)"}
        aria-label={tooltipFor(e)}
        on:click={() => handlePick(e)}
        on:mouseenter={(ev) => onRowEnter(ev, e)}
        on:focusin={(ev) => onRowEnter(ev, e)}
      >
        <span class="dock-dot-inner"></span>
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
    {#if hoveredEntry?.transcriptSource}
      <aside
        class="dock-preview"
        style:top="{hoveredTop}px"
        aria-hidden="true"
        on:mouseenter={onDockEnter}
        on:mouseleave={onDockLeave}
      >
        {#if previews[hoveredEntry.transcriptSource]}
          {#if previews[hoveredEntry.transcriptSource].length === 0}
            <div class="dock-preview-empty muted">No messages yet.</div>
          {:else}
            {#each previews[hoveredEntry.transcriptSource] as item}
              {#if item.kind === "action"}
                <div class="dock-preview-action">
                  <span class="dock-preview-action-label">now</span>
                  <span class="dock-preview-action-name">{item.toolName}</span>
                  {#if item.detail}
                    <span class="dock-preview-action-detail">{item.detail}</span>
                  {/if}
                </div>
              {:else if item.kind === "msg"}
                <div class="dock-preview-msg dock-preview-role-{item.role}">
                  <span class="dock-preview-head">
                    <span class="dock-preview-role">
                      {item.role === "assistant" ? hoveredEntry.agent : item.role}
                    </span>
                    {#if item.timestamp}
                      <span class="dock-preview-time">· {relTime(item.timestamp)}</span>
                    {/if}
                  </span>
                  <span class="dock-preview-text">{previewSnippet(item.text)}</span>
                </div>
              {:else}
                <div class="dock-preview-gap">+ {item.count} message{item.count === 1 ? "" : "s"}</div>
              {/if}
            {/each}
          {/if}
        {:else if previewLoading[hoveredEntry.transcriptSource]}
          <div class="dock-preview-loading">
            <span class="dock-preview-spinner" aria-hidden="true"></span>
          </div>
        {/if}
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
    left: 0.45rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1600;
    display: inline-flex;
    flex-direction: column;
    /* Stretch so each row fills the dock's column width — when
       labels expand the dock auto-sizes to the widest one, and
       every button (and label inside) spans that same width. */
    align-items: stretch;
    gap: 0.35rem;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-md, 8px);
    background: transparent;
    transition: background-color 160ms ease;
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
  }
  /* Inline session-name label. Hidden in resting state (no width, no
     opacity) so the dock is a thin vertical strip of dots. On
     `.session-dock:hover` (anywhere over the dock) every label fades
     in beside its dot. Background + padding on the label only — so
     the dock itself stays chrome-free per request, and labels still
     read against busy content behind the page. */
  .dock-label {
    /* Inline flex child of the dot button so the dock's bounding
       box grows to enclose dots + labels when revealed on hover —
       the dock paints one rounded background behind everything,
       no per-label tile needed. Padding stays constant whether the
       label is hidden or visible so the button's height never
       shifts (preventing the column from jittering on hover). */
    overflow: hidden;
    white-space: nowrap;
    /* Buttons default to text-align: center; force left-alignment
       so the repo · title · time row reads as a normal list line
       rather than centered text. */
    text-align: left;
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
    margin-left: 0.3em;
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

  /* Side preview panel — last 2-3 user/assistant messages of the
     hovered session, fetched on demand from /api/session. Anchored
     to the right edge of the dot's button so it floats out past the
     dock without affecting any column layout. Only one is visible
     at a time (per-row :hover), so even rendering one aside per
     row in the DOM is cheap. */
  .dock-preview {
    /* Anchored to the dock container (not a specific button) so its
       x position stays constant — labels expanding or different
       per-row widths can't shift the panel. `top` is set inline from
       the hovered button's offsetTop so the panel slides vertically
       to align with the active row, but never moves horizontally. */
    position: absolute;
    left: 100%;
    margin-left: 0.15rem;
    transform: translateY(-50%);
    width: 26rem;
    /* Fully transparent — chat bubbles carry their own per-role
       tint, so the panel is just a positioned container. The drop
       shadow is gone with the background; bubbles read on their
       own against whatever's behind. */
    background: transparent;
    border-radius: var(--radius-md, 8px);
    padding: 0.55rem 0.7rem;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-1, #e8e8e8);
    text-align: left;
    /* Flex column so children (msg bubbles + the gap pill) can
       choose their own horizontal alignment via `align-self`. */
    display: flex;
    flex-direction: column;
    /* Capture hover events so moving onto the preview keeps the
       overlay alive (the dock's mouseleave fires when the cursor
       crosses out of its bbox into the preview area — the panel's
       own mouseenter cancels the dismiss timer). */
    pointer-events: auto;
    /* Smooth vertical follow as the user moves between rows.
       Opacity transitions with the panel's mount via Svelte's
       reactive {#if}, so no opacity rule here. */
    transition: top 140ms ease;
  }
  /* Chat-style preview: each message becomes a soft bubble. User
     bubbles align right (sender side); assistant bubbles align left
     (their reply lands under the user's). Each role has its own
     tint so a glance at the side panel reads as a conversation
     rather than a flat list. */
  .dock-preview-msg {
    display: flex;
    flex-direction: column;
    max-width: 85%;
    margin: 0 0 0.45rem 0;
    padding: 0.35rem 0.5rem 0.4rem 0.5rem;
    border-radius: 0.6rem;
    /* Tight inner spacing so role + text read as one bubble. */
    gap: 0.1rem;
  }
  .dock-preview-msg:last-child {
    margin-bottom: 0;
  }
  .dock-preview-role-user {
    /* Opaque tint over the page bg — no alpha — so chat bubbles
       stay readable regardless of what's behind the panel. Both
       roles align to the left; the per-role tint + caption do the
       differentiation, not horizontal position. */
    background: color-mix(in srgb, var(--brand, #60b74c) 18%, var(--surface-0, #23261d));
    border: 1px solid color-mix(in srgb, var(--brand, #60b74c) 35%, var(--surface-0, #23261d));
  }
  .dock-preview-role-assistant {
    background: color-mix(in srgb, var(--surface-2, #2b2b2c) 70%, var(--surface-0, #23261d));
    border: 1px solid color-mix(in srgb, var(--text-muted, #888) 40%, var(--surface-0, #23261d));
  }
  .dock-preview-head {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35em;
    /* Keep header pinned to the bubble's left edge in both roles so
       it reads as a caption above the text, not a trailing tag. */
    align-self: flex-start;
  }
  .dock-preview-role {
    text-transform: uppercase;
    font-size: 0.58rem;
    letter-spacing: 0.06em;
    color: var(--text-muted, #9a9aa0);
  }
  .dock-preview-time {
    font-size: 0.58rem;
    color: var(--text-faint, #666);
  }
  .dock-preview-role-user .dock-preview-role {
    color: color-mix(in srgb, var(--brand, #60b74c) 70%, white);
  }
  .dock-preview-role-assistant .dock-preview-role {
    color: var(--chip-orange-text, #ffb86b);
  }
  .dock-preview-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dock-preview-loading,
  .dock-preview-empty {
    font-style: italic;
    padding: 0.2rem 0;
  }
  .dock-preview-loading {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .dock-preview-spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--text-muted, #888) 35%, transparent);
    border-top-color: var(--text-1, #e8e8e8);
    animation: dock-preview-spin 0.8s linear infinite;
  }
  @keyframes dock-preview-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-preview-spinner { animation: none; }
  }
  /* "+ N messages" gap bubble between selected previews. Tiny pill,
     centered, neutral — reads as "there's stuff here we're hiding"
     without competing with the actual chat bubbles. */
  /* "Now:" action chip — single status line. Borrows the AI
     bubble's neutral surface tint + bright border so tool chips
     read as part of the same visual family as the assistant
     messages they sit between (or follow). */
  .dock-preview-action {
    align-self: stretch;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    margin-bottom: 0.45rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    background: color-mix(in srgb, var(--surface-2, #2b2b2c) 70%, var(--surface-0, #23261d));
    border: 1px solid color-mix(in srgb, var(--text-muted, #888) 40%, var(--surface-0, #23261d));
    font-family: ui-monospace, monospace;
    font-size: 0.66rem;
    color: var(--text-1, #e8e8e8);
  }
  .dock-preview-action-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.58rem;
    color: var(--text-muted, #9a9aa0);
  }
  .dock-preview-action-name {
    color: var(--chip-orange-text, #ffb86b);
    font-weight: 600;
  }
  .dock-preview-action-detail {
    color: var(--text-2, #d0d0d0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .dock-preview-gap {
    /* Half-width strip pinned to the left edge so the gap reads
       as a quiet in-band separator rather than a centered pill or
       a full-width banner. */
    align-self: flex-start;
    width: 50%;
    text-align: center;
    margin: 0.1rem 0 0.4rem 0;
    font-size: 0.6rem;
    color: var(--text-muted, #9a9aa0);
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm, 4px);
    background: color-mix(in srgb, var(--surface-2, #2b2b2c) 50%, var(--surface-0, #23261d));
    /* Brighter outline than the AI bubbles so the gap reads as a
       distinct in-band marker rather than another message. */
    border: 1px solid color-mix(in srgb, var(--text-muted, #888) 65%, var(--surface-0, #23261d));
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
  /* Working: slow rotating conic-gradient halo around the dot.
     Anchored on .dock-dot-inner (the visible 10px disc) so it tracks
     the dot rather than the much larger padded hit-zone wrapper. */
  @property --dock-sweep-angle {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
  }
  .dock-dot.dot-working .dock-dot-inner::before {
    content: "";
    position: absolute;
    /* inset -3 + padding 3 = 3px-thick ring flush against the dot's
       edge, 0px gap between the solid dot and the comet sweep. */
    inset: -3px;
    border-radius: 999px;
    padding: 3px;
    /* Brightened repo tint so the comet sweep is visible against the
       same-coloured dot. Visible arc now spans ~180deg from a faded
       tail at 180 to a bright head at 360 — reads as a longer
       streak rather than a short comet head. */
    background: conic-gradient(
      from var(--dock-sweep-angle),
      transparent 0deg,
      transparent 180deg,
      color-mix(in srgb, var(--dot-fill) 0%, transparent) 180deg,
      color-mix(in srgb, var(--dot-fill) 30%, #fff 70%) 360deg
    );
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
    animation: dock-sweep 2.4s linear infinite;
  }
  @keyframes dock-sweep {
    to { --dock-sweep-angle: 360deg; }
  }

  /* Idle (PTY alive, nothing streaming, no prompt): no outline at
     all. The bare repo-coloured dot is the "alive" signal; the
     comet ring + awaiting pulse are reserved for "something's
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
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--dot-fill) 30%, #fff 70%);
    }
    50% {
      transform: scale(1.25);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--dot-fill) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-dot.dot-working .dock-dot-inner::before,
    .dock-dot.dot-awaiting .dock-dot-inner { animation: none; }
  }
</style>
