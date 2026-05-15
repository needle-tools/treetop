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
    collapseAfterClick = true;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseAfterClick = false;
      collapseTimer = null;
    }, 600);
  }

  onDestroy(() => {
    if (collapseTimer) clearTimeout(collapseTimer);
  });

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
    role="toolbar"
    aria-label="Open sessions"
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
      >
        <span class="dock-dot-inner"></span>
        <span class="dock-label">
          <span class="dock-label-repo">{e.repoName}</span>
          {#if sessionNameFor(e)}
            <span class="dock-label-title">· {sessionNameFor(e)}</span>
          {/if}
          {#if e.lastActive}
            <span class="dock-label-time">· {relTime(e.lastActive)}</span>
          {/if}
        </span>
      </button>
    {/each}
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
    align-items: flex-start;
    gap: 0.35rem;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-md, 8px);
    background: transparent;
    transition: background-color 160ms ease;
  }
  /* On hover, paint a single page-tinted card behind the whole dock
     so the dot column + the freshly-revealed labels read as one
     cohesive panel. Uses `--surface-1` (the dashboard's main
     background) so the card blends with the rest of the UI palette. */
  .session-dock:hover,
  .session-dock:focus-within {
    background: var(--surface-0, #23261d);
  }
  /* While a click is being acted on (smooth-scroll to the picked
     session), suppress both the wrapping background and the label
     reveal even if hover/focus is still active. The flag clears on
     a short timer, so the labels come back the next time the user
     intentionally hovers the dock. */
  .session-dock.collapsed,
  .session-dock.collapsed:hover,
  .session-dock.collapsed:focus-within {
    background: transparent;
  }
  .session-dock.collapsed:hover .dock-label,
  .session-dock.collapsed:focus-within .dock-label {
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
  .session-dock:hover .dock-label,
  .session-dock:focus-within .dock-label {
    max-width: 22rem;
    opacity: 1;
    /* Clicks on the visible label should also fire the dot's
       on:click — the label is a child of the same <button>, so once
       pointer-events go through the click bubbles up and triggers
       the same `dispatch("pick", ...)` the dot would. */
    pointer-events: auto;
    cursor: pointer;
  }
  /* When the cursor is over a specific row's label, give the text a
     dotted underline so it reads as an interactive target — the
     whole row is clickable but the link affordance only shows on
     direct hover of the label text. */
  .dock-dot:hover .dock-label,
  .dock-dot:focus-visible .dock-label {
    text-decoration: underline dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  .dock-label-repo {
    color: var(--text-muted, #9a9aa0);
    font-weight: 400;
  }
  .dock-label-time {
    color: var(--text-muted, #9a9aa0);
    margin-left: 0.3em;
  }
  .dock-label-title {
    margin-left: 0.3em;
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
    /* inset -2 + padding 2 = ring sits flush against the dot's edge,
       0px gap between the solid dot and the comet sweep. */
    inset: -2px;
    border-radius: 999px;
    padding: 2px;
    /* Brightened repo tint so the comet sweep is visible against the
       same-coloured dot. The ring stays in the repo's palette but
       reads as a distinct, lit halo. */
    background: conic-gradient(
      from var(--dock-sweep-angle),
      transparent 0deg,
      transparent 240deg,
      color-mix(in srgb, var(--dot-fill) 0%, transparent) 270deg,
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
