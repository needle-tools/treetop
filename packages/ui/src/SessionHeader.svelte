<script lang="ts" context="module">
  export interface InflightRec {
    id: string;
    agent: string;
    sessionId: string;
    pid: number;
    textPreview: string;
    startedAt: string;
  }
</script>

<script lang="ts">
  /**
   * The shared per-session column header. Same 4-column grid for every
   * variant — brand-new TUI, resumed Claude/Codex session in TUI mode,
   * stored-chat read mode — so users see one consistent affordance set
   * regardless of which path got them here.
   *
   * Missing data (no sid yet, no token usage yet, ...) just hides the
   * relevant chip. The header structure stays put so the column doesn't
   * jitter as the agent's first JSONL line lands and the metadata
   * fills in.
   */
  import ManualTitle from "./ManualTitle.svelte";
  import SessionMenu, { type SessionMenuItem } from "./SessionMenu.svelte";
  import Tooltip from "./Tooltip.svelte";
  import SleepIndicationAnimation from "./SleepIndicationAnimation.svelte";
  import { contextChip } from "./context-tokens";

  export let agent: "claude" | "codex" | "copilot" | "shell";
  export let source: string;
  export let manualTitle: string = "";
  /** "read" hides Stop Session / fullscreen; "terminal" shows them. */
  export let mode: "read" | "terminal" = "terminal";
  /** Whether the column should expose a Resume button (only meaningful
   *  when mode === "read" and we have a sessionId to resume against). */
  export let canResume: boolean = false;
  /** Whether the column can be ended (Dispose) right now. */
  export let canEnd: boolean = true;
  export let disposing: boolean = false;
  export let awaitingInput: boolean = false;
  /** Whether the PTY is currently emitting output. True ⇒ a rotating
   *  conic-gradient ring sweeps the agent pill in the agent's colour.
   *  False ⇒ a solid border in the agent's colour smoothly pulses
   *  between dim and bright. Only meaningful in terminal mode (the
   *  consumer gates on `mode === "terminal" && working` before
   *  passing it through). */
  export let working: boolean = false;

  // Metadata (all optional — empty values just don't render their chip)
  export let loadedMessageCount: number | undefined = undefined;
  export let totalMessageCount: number | undefined = undefined;
  export let contextTokens: number | undefined = undefined;
  export let contextTokensExact: boolean | undefined = undefined;
  /** Authoritative cap shipped by the agent's JSONL (Codex 0.130+).
   *  Wins over the model-id heuristic inside contextChip. */
  export let contextWindow: number | undefined = undefined;
  export let model: string | undefined = undefined;
  export let lastActivityIso: string | undefined = undefined;
  /** Text of the user's most recent message in this session, surfaced
   *  in the rich hover-tooltip on the "last activity" chip. Often the
   *  user wants a quick "what did I last ask?" reminder without
   *  scrolling the column — this is that reminder. Undefined ⇒ the
   *  tooltip omits the "Your last message" section. */
  export let lastUserMessage: string | undefined = undefined;
  export let pollCount: number = 0;
  export let lastLoadedAt: number = 0;
  export let inflight: InflightRec[] = [];
  /** Placeholder text shown when `lastActivityIso` is empty. Lets
   *  brand-new TUI columns render e.g. "new session" in the activity
   *  slot instead of leaving the column blank until the agent's first
   *  JSONL line lands. Undefined ⇒ hide the slot when empty. */
  export let lastActivityFallback: string | undefined = undefined;
  /** Placeholder for the message-count slot, same idea. */
  export let messageCountFallback: string | undefined = undefined;

  export let menuItems: SessionMenuItem[] = [];

  // Callbacks
  export let onTitleSaved: (next: string) => void = () => {};
  export let onResume: () => void = () => {};
  export let onEndSession: () => void = () => {};
  export let onCancelInflight: () => void = () => {};
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};

  /** Tooltip strings for the Stop Session / Resume buttons. Default
   *  texts work for SessionView; NewSessionCol can override. */
  export let endSessionTitle: string =
    "SIGTERM the PTY and flip back to the chat view";
  export let resumeTitle: string = "Spawn a live resume PTY in this session's cwd";
  /** Tooltip for the × close button. Default reflects SessionView's
   *  semantics: the column unmounts but the JSONL stays on disk, so
   *  reopening the session from the worktree's picker resumes the
   *  full chat history. Consumers with different semantics (a fresh
   *  TUI whose PTY dies when its column unmounts) should override. */
  export let closeTitle: string =
    "Close this column.\nThe session stays saved on disk — reopen it anytime from the worktree's session picker.";

  $: ctxChip = contextChip({
    tokens: contextTokens,
    exact: contextTokensExact,
    model,
    agent: agent === "shell" ? undefined : agent,
    cap: contextWindow,
  });

  function relTimeFromNow(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 2) return "just now";
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }
  function relTimeFromIso(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)} days ago`;
  }

  /** Bound to the header element so the burger-menu "Toggle fullscreen"
   *  action can find its `.session` ancestor without an event target —
   *  the menu hands actions a bounding rect, not the clicked node. */
  let headerEl: HTMLElement | null = null;
  function toggleFullscreen() {
    const el = headerEl?.closest(".session") as HTMLElement | null;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }

  /** When the column is in TUI mode we splice a "Toggle fullscreen"
   *  entry on top of whatever the parent passed in. Keeps the action
   *  reachable for keyboard users (the burger is focusable) and trims
   *  the right-side button cluster down to just Stop Session + ×. */
  $: effectiveMenuItems = mode === "terminal"
    ? ([
        {
          kind: "action",
          label: "Toggle fullscreen",
          icon: "⛶",
          title: "Fill the viewport with this column (Esc to exit)",
          onSelect: () => toggleFullscreen(),
        },
        ...menuItems,
      ] satisfies SessionMenuItem[])
    : menuItems;
</script>

<header bind:this={headerEl} draggable="true" on:dragstart={onDragStart}>
  <div class="hdr-col col-agent">
    <span
      class="agent-pill agent-{agent}"
      class:working={mode === "terminal" && working}
      class:idle={mode === "terminal" && !working}
    >{agent}{#if mode === "terminal"}<span
        class="sleep-slot"
        title={!working ? "Idle — waiting for input" : ""}
      ><SleepIndicationAnimation visible={!working} /></span>{/if}</span>
  </div>
  <div class="hdr-col col-name">
    <ManualTitle
      {source}
      value={manualTitle}
      on:saved={(e) => onTitleSaved(e.detail.title)}
    />
    {#if ctxChip}
      <Tooltip variant="wide" placement="bottom" escapeClip>

        <span
          slot="trigger"
          class="ctx-bar"
          class:warn={ctxChip.ratio !== undefined && ctxChip.ratio > 0.6 && ctxChip.ratio <= 0.85}
          class:hot={ctxChip.ratio !== undefined && ctxChip.ratio > 0.85}
          class:unknown={ctxChip.ratio === undefined}
          aria-label={ctxChip.text}
        >
          <span
            class="ctx-bar-fill"
            style:width={ctxChip.ratio !== undefined
              ? `${Math.min(100, Math.round(ctxChip.ratio * 100))}%`
              : "100%"}
          ></span>
          <span class="ctx-bar-text muted small">
            <span class="ctx-bar-now">{ctxChip.absolute}</span><!--
            --><span class="ctx-bar-rest">
              {#if ctxChip.capText}
                {` / ${ctxChip.capText} ctx (${Math.round((ctxChip.ratio ?? 0) * 100)}%)`}
              {:else}
                {` / ??? ctx`}
              {/if}
            </span>
          </span>
        </span>
        <div slot="content" class="ctx-tt">
          <div class="ctx-tt-head">Estimated context size at the start of the next turn</div>
          <dl class="ctx-tt-kv">
            <dt>Model</dt>
            <dd>{model ?? "(unknown)"}</dd>
            <dt>Tokens</dt>
            <dd>
              {contextTokens !== undefined ? contextTokens.toLocaleString() : "—"}
              {#if ctxChip.ratio !== undefined}
                <span class="muted small">({Math.round(ctxChip.ratio * 100)}% of cap)</span>
              {/if}
            </dd>
          </dl>
          <div class="ctx-tt-section">
            <div class="ctx-tt-section-head">How it's computed</div>
            {#if contextTokensExact}
              <ul>
                <li>Read from the most recent assistant turn's <code>message.usage</code> in the session JSONL.</li>
                <li>Sum of <code>input_tokens</code> + <code>cache_read_input_tokens</code> + <code>cache_creation_input_tokens</code> — the three disjoint slices Anthropic reports for that request, so their sum is everything the model saw as input.</li>
                <li>Output tokens are excluded (they're generated, not in-context yet).</li>
                <li>Lagged by one turn: your next prompt adds a bit more on top.</li>
              </ul>
            {:else}
              <ul>
                <li>Codex's JSONL doesn't carry a usage block, so this is a rough estimate.</li>
                <li>Sum of every user/assistant message's content length ÷ 4 (OpenAI's chars-per-token rule of thumb).</li>
                <li>Developer / system / event messages are excluded.</li>
              </ul>
            {/if}
          </div>
          <div class="ctx-tt-section">
            <div class="ctx-tt-section-head">Cap (picked from model id)</div>
            <ul>
              <li>Opus / Sonnet 4.6+ → 1,000,000</li>
              <li>Haiku 4.5 → 200,000</li>
              <li>Legacy Opus / Sonnet (≤4.5) → 200,000</li>
              <li>Unknown model → shown as <code>???</code> (no fabricated denominator).</li>
            </ul>
          </div>
        </div>
      </Tooltip>
    {/if}
    {#if inflight.length > 0}
      <button
        class="inflight-pill"
        type="button"
        title={inflight
          .map(
            (r) =>
              `pid ${r.pid}: ${r.textPreview}${r.textPreview.length === 200 ? "…" : ""}`,
          )
          .join("\n")}
        on:click={onCancelInflight}
      >
        <span class="spinner" aria-hidden="true"></span>
        <span>{inflight.length} sending — click to cancel</span>
      </button>
    {/if}
  </div>
  <div class="hdr-col col-meta">
    {#if lastActivityIso}
      {#if lastUserMessage && lastUserMessage.trim().length > 0}
        <Tooltip variant="wide" placement="bottom" escapeClip>
          <span
            slot="trigger"
            class="muted small last-activity"
          >last activity {relTimeFromIso(lastActivityIso)}</span>
          <pre slot="content" class="la-tt-msg">{lastUserMessage}</pre>
        </Tooltip>
      {:else}
        <span
          class="muted small last-activity"
        >last activity {relTimeFromIso(lastActivityIso)}</span>
      {/if}
    {:else if lastActivityFallback}
      <span class="muted small last-activity placeholder">{lastActivityFallback}</span>
    {/if}
    {#if loadedMessageCount !== undefined}
      <span
        class="muted small msg-count"
        title={totalMessageCount !== undefined &&
        totalMessageCount > loadedMessageCount
          ? `Showing the last ${loadedMessageCount} of ${totalMessageCount.toLocaleString()} messages.`
          : `${loadedMessageCount} message${loadedMessageCount === 1 ? "" : "s"} in this session`}
      >
        {#if totalMessageCount !== undefined && totalMessageCount > loadedMessageCount}
          {loadedMessageCount} of {totalMessageCount.toLocaleString()} messages
        {:else}
          {loadedMessageCount} messages
        {/if}
      </span>
    {:else if totalMessageCount !== undefined}
      <span
        class="muted small msg-count"
        title={`${totalMessageCount.toLocaleString()} message${totalMessageCount === 1 ? "" : "s"} in this session`}
      >{totalMessageCount.toLocaleString()} messages</span>
    {:else if messageCountFallback}
      <span class="muted small msg-count placeholder">{messageCountFallback}</span>
    {/if}
  </div>
  <div class="hdr-col col-actions">
    {#if mode === "read" && canResume}
      <button
        class="resume-btn"
        on:click={onResume}
        title={resumeTitle}
      >Resume</button>
    {:else if mode === "terminal"}
      {#if awaitingInput}
        <span
          class="awaiting-pill"
          title="The agent is paused on a prompt — focus the terminal and respond."
        >needs input</span>
      {/if}
      {#if canEnd}
        <button
          class="resume-btn dispose-btn"
          on:click={onEndSession}
          disabled={disposing}
          title={endSessionTitle}
        >
          {disposing ? "Stopping…" : "Stop Session"}
        </button>
      {/if}
    {/if}
    {#if effectiveMenuItems.length > 0}
      <SessionMenu items={effectiveMenuItems} />
    {/if}
    <button class="close" on:click={onClose} title={closeTitle} aria-label="Close column">×</button>
  </div>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--surface-3);
    cursor: grab;
    user-select: none;
  }
  header:active {
    cursor: grabbing;
  }
  .hdr-col {
    display: flex;
    line-height: 1.1;
  }
  .col-agent {
    flex: 0 0 auto;
    align-items: center;
  }
  .col-name {
    /* Grow to fill the space col-meta + col-actions don't claim, and
       shrink (with min-width: 0) so a long title ellipsizes inside its
       own slot instead of pushing the meta/actions out of the row. */
    flex: 1 1 0;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .col-name > :global(*) {
    max-width: 100%;
  }
  .col-meta {
    /* Intrinsic size — col-meta never gets squeezed. col-name takes
       the slack via flex: 1, so the title is what ellipsizes when
       the column is tight. */
    flex: 0 0 auto;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .col-meta > * {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
  }
  .col-meta .placeholder {
    font-style: italic;
    color: var(--text-faint);
  }
  .col-actions {
    /* Sits flush right because col-name grows; we don't need this
       column to flex any further. */
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 0.35rem;
  }
  .resume-btn {
    flex: 0 0 auto;
    align-self: center;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--surface-3);
    padding: 0.25rem 0.6rem;
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .resume-btn:hover {
    color: var(--text-1);
    border-color: var(--text-faint);
  }
  .resume-btn.dispose-btn {
    color: #efaaaa;
    border-color: color-mix(in srgb, #efaaaa 30%, transparent);
    background: color-mix(in srgb, var(--error-bg) 50%, transparent);
  }
  .resume-btn.dispose-btn:hover:not(:disabled) {
    color: #ffcaca;
    border-color: color-mix(in srgb, #efaaaa 55%, transparent);
  }
  .resume-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .agent-pill {
    /* Position-relative so the .working state's ::before ring can
       anchor to the pill bounds. Inline-block keeps inline flow while
       still letting the ring extend a few px outside the padding box. */
    position: relative;
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    text-transform: lowercase;
    font-family: ui-monospace, monospace;
    /* Always-on transparent border so toggling .idle (which paints a
       real border) doesn't reflow the pill by 1px in either axis. */
    border: 1px solid transparent;
  }
  .agent-pill.agent-claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
    --agent-color: var(--chip-orange-text);
  }
  .agent-pill.agent-codex {
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
    --agent-color: var(--chip-codex-text);
  }
  .agent-pill.agent-copilot {
    background: var(--chip-default-bg);
    color: var(--chip-default-text);
    --agent-color: var(--chip-default-text);
  }
  .agent-pill.agent-shell {
    background: var(--surface-3);
    color: var(--text-2);
    --agent-color: var(--text-2);
  }
  /* Stacking context for the idle pulse pseudo below. */
  .agent-pill.idle {
    isolation: isolate;
  }
  /* Working: comet-trail conic-gradient ring. The @property-animated
     `from` angle sweeps the bright arc smoothly around the pill's
     border outline — keeping the gradient ANGLE in motion (rather
     than rotating the pseudo) is what makes the sweep follow the pill
     shape uniformly on wide rectangles. Yes this repaints the pseudo
     every frame; .working is transient (only on while an agent turn
     is in flight) so the paint cost is bounded. Transform-rotating a
     static conic was tried and produced a visibly non-uniform sweep
     on the pill's wide aspect ratio. */
  @property --pill-sweep-angle {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
  }
  .agent-pill.working::before {
    content: "";
    position: absolute;
    /* Extend 3px outside so the comet sweep hugs the pill's outer
       edge instead of sitting on top of the text. */
    inset: -3px;
    border-radius: calc(var(--radius-sm) + 3px);
    padding: 2px;
    background: conic-gradient(
      from var(--pill-sweep-angle),
      transparent 0deg,
      transparent 250deg,
      color-mix(in srgb, var(--agent-color) 0%, transparent) 270deg,
      color-mix(in srgb, var(--agent-color) 95%, transparent) 340deg,
      var(--agent-color) 360deg
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
    animation: pill-sweep 3.2s linear infinite;
  }
  @keyframes pill-sweep {
    to { --pill-sweep-angle: 360deg; }
  }
  /* Idle / waiting: a static dim border (always-visible signal) with a
     bright overlay border whose opacity pulses. Animating opacity on a
     positioned overlay is composited; previously this animated
     `border-color` directly, which is paint-time and showed up as the
     single biggest paint cost in the trace. */
  .agent-pill.idle {
    border-color: color-mix(in srgb, var(--agent-color) 30%, transparent);
  }
  .agent-pill.idle::before {
    content: "";
    position: absolute;
    /* Sit on top of the parent's 1px border so the overlay's brighter
       border lines up with it visually. */
    inset: -1px;
    border: 1px solid var(--agent-color);
    border-radius: inherit;
    pointer-events: none;
    animation: pill-idle-fade 1.6s ease-in-out infinite alternate;
    z-index: -1;
  }
  @keyframes pill-idle-fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-pill.working::before,
    .agent-pill.idle::before {
      animation: none;
    }
    .agent-pill.idle {
      border-color: color-mix(in srgb, var(--agent-color) 70%, transparent);
    }
    .agent-pill.idle::before {
      opacity: 1;
    }
  }
  /* Thin wrapper around <SleepIndicationAnimation>. The component owns
     its own layout reservation + animation; we only set the colour so
     the z-trail picks up the agent's brand colour via currentColor. */
  .sleep-slot {
    display: inline-block;
    margin-left: 0.2rem;
    color: var(--agent-color);
  }
  /* Compact horizontal "loading bar" representation of context usage.
     The track is a thin dark strip; the fill grows with `ratio`. The
     numeric label is hidden by default and slides in as a small
     adjacent caption on hover, so the resting state stays quiet in
     a busy header row. The full breakdown lives in the Tooltip popup
     that wraps this trigger. */
  /* Grid with two areas: the bar (track + fill stacked in the same
     cell via grid-area: bar) and the hover-revealed label. */
  .ctx-bar {
    display: inline-grid;
    grid-template-columns: 64px auto;
    grid-template-areas: "bar text";
    column-gap: 0.4rem;
    align-items: center;
    line-height: 1;
    /* `help` paints the OS "?" cursor — signals there's more info on
       hover (the Tooltip popup + the fade-in cap/% text). */
    cursor: help;
  }
  .ctx-bar > .ctx-bar-fill,
  .ctx-bar::before {
    height: 8px;
    border-radius: 999px;
    box-sizing: border-box;
  }
  /* `::before` is the empty track behind the fill. A 1px outline keeps
     the bar legible even when the fill is the same hue as the
     surrounding header background. */
  .ctx-bar::before {
    content: "";
    display: block;
    width: 64px;
    background: var(--surface-3);
    border: 1px solid var(--text-faint);
    grid-area: bar;
  }
  /* In warn/hot states the outline echoes the fill so the chip reads
     as one tinted unit instead of a neutral frame around a colored
     stripe. */
  .ctx-bar.warn::before {
    border-color: var(--ctx-warn);
  }
  .ctx-bar.hot::before {
    border-color: var(--ctx-hot);
  }
  .ctx-bar-fill {
    grid-area: bar;
    display: block;
    background: var(--text-faint);
    /* No own width — set inline via `style:width`. Transitions so a
       poll-cycle bump doesn't jitter the bar. */
    transition: width 200ms ease, background 200ms ease;
  }
  .ctx-bar.warn .ctx-bar-fill {
    background: var(--ctx-warn);
  }
  .ctx-bar.hot .ctx-bar-fill {
    background: var(--ctx-hot);
  }
  .ctx-bar.unknown .ctx-bar-fill {
    /* Striped indeterminate look when we don't know the cap, so the
       bar doesn't lie by showing a fixed fill level. */
    background: repeating-linear-gradient(
      45deg,
      var(--text-faint) 0 4px,
      transparent 4px 8px
    );
  }
  .ctx-bar-text {
    grid-area: text;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    font-size: 0.68rem;
    /* The "now" span sits at full opacity; the "rest" span (cap + %)
       fades in on hover so the resting state is just the current size. */
  }
  .ctx-bar-rest {
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .ctx-bar:hover .ctx-bar-rest,
  .ctx-bar:focus-within .ctx-bar-rest {
    opacity: 1;
  }
  .ctx-bar.warn .ctx-bar-text {
    color: var(--ctx-warn);
  }
  .ctx-bar.hot .ctx-bar-text {
    color: var(--ctx-hot);
  }
  /* Tooltip body for the ctx-chip. `:global` because the slot content
     is rendered inside Tooltip.svelte's DOM — Svelte's per-file scope
     class would still attach, but DCE has historically been unreliable
     about slot-nested selectors, so go global to remove the doubt. */
  :global(.ctx-tt) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--text-1);
    /* `max-content` lets the popup grow to its natural unwrapped width
       before the cap kicks in — otherwise a max-width by itself only
       caps shrink-to-fit, which can settle far below it for short
       content. The cap doubles the previous 42ch so long sentences
       wrap onto fewer rows. */
    width: max-content;
    max-width: min(84ch, 92vw);
  }
  :global(.ctx-tt-head) {
    font-weight: 600;
  }
  :global(.ctx-tt-kv) {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.6rem;
    row-gap: 0.15rem;
    margin: 0;
  }
  :global(.ctx-tt-kv dt) {
    color: var(--text-muted);
  }
  :global(.ctx-tt-kv dd) {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  :global(.ctx-tt-section-head) {
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 0.2rem;
  }
  :global(.ctx-tt ul) {
    margin: 0;
    padding-left: 1.1rem;
  }
  :global(.ctx-tt li + li) {
    margin-top: 0.15rem;
  }
  :global(.ctx-tt code) {
    font-family: ui-monospace, monospace;
    font-size: 0.95em;
    background: var(--surface-3);
    padding: 0 0.2em;
    border-radius: 2px;
  }
  /* "Last activity" hover tooltip — just the user's last message, no
     extra meta. `:global()` because the slot content renders inside
     Tooltip.svelte's DOM so scoped selectors don't reach it. */
  :global(.la-tt-msg) {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-word;
    max-width: min(72ch, 92vw);
    max-height: 40vh;
    overflow-y: auto;
  }
  .awaiting-pill {
    background: color-mix(in srgb, var(--status-dirty) 25%, transparent);
    color: var(--status-dirty);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    align-self: center;
    white-space: nowrap;
  }
  .inflight-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.05rem 0.5rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--brand) 18%, transparent);
    color: var(--text-1);
    border: 0;
    font-size: 0.68rem;
    line-height: 1;
    cursor: pointer;
  }
  .inflight-pill:hover {
    background: color-mix(in srgb, var(--brand) 28%, transparent);
  }
  .inflight-pill .spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--brand) 40%, transparent);
    border-top-color: var(--brand);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .close {
    flex: 0 0 auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    /* Transparent border at rest so the layout doesn't shift when the
       hover state's outline appears. */
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: var(--text-1);
    background: var(--surface-3);
    border-color: var(--text-faint);
  }
  .close:focus-visible {
    outline: none;
    border-color: var(--brand);
  }
</style>
