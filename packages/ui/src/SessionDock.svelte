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
  import { createEventDispatcher } from "svelte";

  /** Minimal shape this component needs per session. The host computes
   *  these from its open-sessions / agents / repos state and hands them
   *  over already merged. Keeps the component dumb. */
  export interface DockEntry {
    source: string;
    wtPath: string;
    rowKey: string;
    agent: "claude" | "codex" | "copilot" | "shell";
    /** Hex (e.g. "#ff8800"). Undefined → default neutral fill. */
    repoColor?: string;
    repoName: string;
    branch?: string;
    title?: string;
    manualTitle?: string;
    lastUserMessage?: string;
    working: boolean;
    awaiting: boolean;
  }

  export let entries: DockEntry[];

  const dispatch = createEventDispatcher<{ pick: DockEntry }>();

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

  /** Short, single-line label shown next to the dot when the user
   *  hovers the dock. Picks the most identifying name we have:
   *  user-set title beats the parsed title beats `repo · branch`. */
  function labelFor(e: DockEntry): string {
    const t = e.manualTitle ?? e.title;
    if (t) return t;
    return `${e.repoName}${e.branch ? ` · ${e.branch}` : ""}`;
  }
</script>

{#if entries.length > 0}
  <div class="session-dock" role="toolbar" aria-label="Open sessions">
    {#each entries as e (e.source)}
      <button
        type="button"
        class="dock-dot agent-{e.agent}"
        class:dot-working={e.working}
        class:dot-awaiting={e.awaiting}
        style:--dot-fill={e.repoColor ?? "var(--surface-3)"}
        title={tooltipFor(e)}
        on:click={() => dispatch("pick", e)}
      >
        <span class="dock-dot-inner"></span>
        <span class="dock-label">{labelFor(e)}</span>
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
    gap: 0;
    padding: 0.2rem 0;
    max-height: 90vh;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
  }
  .session-dock::-webkit-scrollbar { display: none; }

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
    /* Absolutely positioned so the label can host padding +
       backdrop-filter without changing the dot's vertical slot. The
       button stays as the dot's hit-zone; the label floats out to
       the right of it on hover. */
    position: absolute;
    left: 100%;
    top: 50%;
    transform: translateY(-50%);
    overflow: hidden;
    white-space: nowrap;
    max-width: 0;
    opacity: 0;
    padding: 3px 8px;
    box-sizing: border-box;
    border-radius: var(--radius-sm, 4px);
    font-size: 0.72rem;
    line-height: 1;
    color: var(--text-1, #e8e8e8);
    background: transparent;
    pointer-events: none;
    transition:
      max-width 180ms ease,
      opacity 140ms ease,
      backdrop-filter 140ms ease,
      -webkit-backdrop-filter 140ms ease;
  }
  .session-dock:hover .dock-label,
  .session-dock:focus-within .dock-label {
    max-width: 22rem;
    opacity: 1;
    /* Soft blurred frosting behind the text on hover — keeps labels
       legible against any busy dashboard content (terminal output,
       sticky notes) without painting a hard background colour. */
    backdrop-filter: blur(8px) saturate(140%);
    -webkit-backdrop-filter: blur(8px) saturate(140%);
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
    inset: -3px;
    border-radius: 999px;
    padding: 2px;
    background: conic-gradient(
      from var(--dock-sweep-angle),
      transparent 0deg,
      transparent 240deg,
      color-mix(in srgb, var(--dot-fill) 0%, transparent) 270deg,
      var(--dot-fill) 360deg
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

  /* Awaiting: stronger, attention-grabbing pulse — the dot scales up
     and its outline blinks the repo color at a faster cadence. This
     is the "come deal with me" state. */
  .dock-dot.dot-awaiting .dock-dot-inner {
    animation: dock-awaiting 1.1s ease-in-out infinite;
  }
  @keyframes dock-awaiting {
    0%, 100% {
      transform: scale(1);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--dot-fill) 60%, transparent);
    }
    50% {
      transform: scale(1.25);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--dot-fill) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dock-dot.dot-working .dock-dot-inner::before { animation: none; }
    .dock-dot.dot-awaiting .dock-dot-inner { animation: none; }
  }
</style>
