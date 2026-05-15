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
  import { contextChip } from "./context-tokens";

  export let agent: "claude" | "codex" | "copilot" | "shell";
  export let source: string;
  export let manualTitle: string = "";
  /** "read" hides End Session / fullscreen; "terminal" shows them. */
  export let mode: "read" | "terminal" = "terminal";
  /** Whether the column should expose a Resume button (only meaningful
   *  when mode === "read" and we have a sessionId to resume against). */
  export let canResume: boolean = false;
  /** Whether the column can be ended (Dispose) right now. */
  export let canEnd: boolean = true;
  export let disposing: boolean = false;
  export let awaitingInput: boolean = false;

  // Metadata (all optional — empty values just don't render their chip)
  export let loadedMessageCount: number | undefined = undefined;
  export let totalMessageCount: number | undefined = undefined;
  export let contextTokens: number | undefined = undefined;
  export let contextTokensExact: boolean | undefined = undefined;
  export let model: string | undefined = undefined;
  export let lastActivityIso: string | undefined = undefined;
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

  /** Tooltip strings for the End Session / Resume buttons. Default
   *  texts work for SessionView; NewSessionCol can override. */
  export let endSessionTitle: string =
    "SIGTERM the PTY and flip back to the chat view";
  export let resumeTitle: string = "Spawn a live resume PTY in this session's cwd";

  $: ctxChip = contextChip({
    tokens: contextTokens,
    exact: contextTokensExact,
    model,
    agent: agent === "shell" ? undefined : agent,
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

  function toggleFullscreen(e: MouseEvent) {
    const el = (e.currentTarget as HTMLElement).closest(
      ".session",
    ) as HTMLElement | null;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }
</script>

<header draggable="true" on:dragstart={onDragStart}>
  <div class="hdr-col col-agent">
    <span class="agent-pill agent-{agent}">{agent}</span>
  </div>
  <div class="hdr-col col-name">
    <ManualTitle
      {source}
      value={manualTitle}
      on:saved={(e) => onTitleSaved(e.detail.title)}
    />
    {#if ctxChip}
      <Tooltip variant="wide" placement="bottom">
        <span
          slot="trigger"
          class="ctx-chip muted small"
          class:warn={ctxChip.ratio !== undefined && ctxChip.ratio > 0.6 && ctxChip.ratio <= 0.85}
          class:hot={ctxChip.ratio !== undefined && ctxChip.ratio > 0.85}
        >
          {ctxChip.text}
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
      <span
        class="muted small last-activity"
        title={`Last message ${new Date(lastActivityIso).toLocaleString()}\nPolled ${pollCount}× since open${lastLoadedAt ? ` (most recent ${relTimeFromNow(lastLoadedAt)})` : ""}`}
      >last activity {relTimeFromIso(lastActivityIso)}</span>
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
      <button
        class="fullscreen-btn"
        on:click={toggleFullscreen}
        title="Fullscreen this terminal (Esc to exit)"
        aria-label="Fullscreen"
      >⛶</button>
      {#if canEnd}
        <button
          class="resume-btn dispose-btn"
          on:click={onEndSession}
          disabled={disposing}
          title={endSessionTitle}
        >
          {disposing ? "Ending…" : "End Session"}
        </button>
      {/if}
    {/if}
    {#if menuItems.length > 0}
      <SessionMenu items={menuItems} />
    {/if}
    <button class="close" on:click={onClose} title="Close">×</button>
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
  .fullscreen-btn {
    flex: 0 0 auto;
    align-self: center;
    background: transparent;
    color: var(--text-muted);
    border: 0;
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .fullscreen-btn:hover {
    color: var(--text-1);
    background: var(--surface-3);
    border-radius: var(--radius-sm);
  }
  .agent-pill {
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    text-transform: lowercase;
    font-family: ui-monospace, monospace;
  }
  .agent-pill.agent-claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .agent-pill.agent-codex {
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
  }
  .agent-pill.agent-copilot {
    background: var(--chip-default-bg);
    color: var(--chip-default-text);
  }
  .agent-pill.agent-shell {
    background: var(--surface-3);
    color: var(--text-2);
  }
  .ctx-chip {
    font-variant-numeric: tabular-nums;
    background: transparent;
    color: inherit;
    white-space: nowrap;
  }
  .ctx-chip.warn {
    color: var(--ctx-warn);
  }
  .ctx-chip.hot {
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
    border: 0;
    color: var(--text-muted);
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: var(--text-1);
    background: var(--surface-3);
    border-radius: var(--radius-sm);
  }
</style>
