<script lang="ts">
  /**
   * Search-enabled list of agent sessions used in two places:
   *
   *  1. The "+N sessions in this worktree" popover (worktree-scoped).
   *  2. The "search across this repo" popover (repo-scoped, may include
   *     orphan sessions left behind by removed worktrees).
   *
   * Pure presentation — fuzzy filtering lives in `./sessionSearch.ts`,
   * scored against fields the daemon already populates per session
   * (title, manualTitle, firstUserMessage, lastUserMessage[s]).
   *
   * The host owns:
   *   - the popover shell and head text,
   *   - the "is this session currently open as a column" predicate,
   *   - what happens on pick / close (route to a worktree, etc.).
   */
  import Popover from "./Popover.svelte";
  import { filterSessions, type AgentSession } from "./sessionSearch";

  export let sessions: AgentSession[];
  export let headText: string;
  export let extraClass = "";
  /** Sessions whose `source` is in this set render with an "orphan" tag
   *  (i.e. their cwd no longer maps to a live worktree). Empty by default. */
  export let orphanSources: Set<string> = new Set();
  /** Whether each row is already open as a column. Renders dimmed +
   *  reveals the inline close affordance. */
  export let isOpen: (s: AgentSession) => boolean = () => false;
  /** Tooltip text per row — caller knows the worktree context. */
  export let tooltipFor: (s: AgentSession) => string = (s) =>
    s.manualTitle ?? s.title ?? "(no title)";
  /** Placeholder string for the search input. */
  export let placeholder = "Search by title or message…";

  let query = "";
  $: filtered = filterSessions(sessions, query);

  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher<{
    pick: AgentSession;
    close: AgentSession;
  }>();

  function relTime(iso: string): string {
    const d = Date.now() - Date.parse(iso);
    if (Number.isNaN(d)) return "";
    const s = Math.max(0, Math.floor(d / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
  }

  // No autofocus on mount: the popover doubles as a browse view, and
  // popping it open shouldn't steal the caret. The user clicks the
  // heading text when they want to filter — that's also when the
  // placeholder hides (`:focus::placeholder`).
</script>

<Popover variant="agents" extraClass={`session-search-popover ${extraClass}`.trim()}>
  <svelte:fragment slot="head">
    <div class="session-search-head">
      <!-- The heading IS the search field: a chrome-free input whose
           placeholder is the "N sessions in this worktree" label.
           Clicking the heading and typing filters the list directly,
           with no separate search box. The match-count badge on the
           right only appears once the user starts filtering. -->
      <input
        type="search"
        class="session-search-headline"
        bind:value={query}
        placeholder={headText}
        aria-label={headText}
        on:click|stopPropagation
        on:keydown|stopPropagation
      />
      {#if query.trim().length > 0}
        <span class="session-search-count filtered">
          {filtered.length}/{sessions.length}
        </span>
      {/if}
    </div>
  </svelte:fragment>

  <ul class="agents-list">
    {#each filtered as sess (sess.source)}
      <li>
        <button
          class="agent-row brand-{sess.agent}"
          class:dimmed={isOpen(sess)}
          class:orphan-row={orphanSources.has(sess.source)}
          title={isOpen(sess) ? "Already open — click to close" : tooltipFor(sess)}
          on:click={() => dispatch("pick", sess)}
        >
          {#if sess.agent === "claude"}
            <img class="agent-row-icon" src="/agents/claude.svg" alt="" />
          {:else if sess.agent === "codex"}
            <svg
              class="agent-row-icon"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
            </svg>
          {:else}
            <span class="agent-dot agent-{sess.agent}"></span>
          {/if}
          <span class="agent-row-name">
            {sess.agent === "claude"
              ? "Claude"
              : sess.agent === "codex"
                ? "Codex"
                : sess.agent}
          </span>
          <span
            class="agent-title"
            class:manual={!!sess.manualTitle}
          >
            {sess.manualTitle ?? sess.title ?? "(no title)"}
          </span>
          {#if orphanSources.has(sess.source)}
            <span class="orphan-tag" title={`Originated in ${sess.cwd} — no live worktree matches this path anymore.`}>orphan</span>
          {/if}
          <span
            class="muted small agent-msgs"
            title={sess.messageCount
              ? `${sess.messageCount.toLocaleString()} message${sess.messageCount === 1 ? "" : "s"} in this session`
              : "no messages counted"}
          >
            {#if sess.messageCount}{sess.messageCount.toLocaleString()} msg{:else}—{/if}
          </span>
          <span class="muted small agent-time">{relTime(sess.lastActive)}</span>
          {#if sess.sessionId}
            <code class="muted small agent-sid">{sess.sessionId.slice(0, 8)}</code>
          {/if}
          <span
            class="row-close"
            aria-hidden={!isOpen(sess)}
            on:click|stopPropagation={() => {
              if (isOpen(sess)) dispatch("close", sess);
            }}
            title="Close this session"
          >×</span>
        </button>
      </li>
    {/each}
    {#if filtered.length === 0}
      <li class="session-search-empty muted small">
        {query.trim() ? "No sessions match." : "No sessions yet."}
      </li>
    {/if}
  </ul>
</Popover>

<style>
  .session-search-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }
  /* The heading-as-input. Inherits the popover head's typography
     family/weight/color and bumps the size a touch so the empty-state
     placeholder reads as a proper section heading. When focused, the
     placeholder fades so the field looks empty and ready for the
     user's query — no border, background, or outline ever. */
  .session-search-headline {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 0.88rem;
    line-height: inherit;
    outline: none;
    box-shadow: none;
    appearance: none;
    -webkit-appearance: none;
  }
  /* Hide the WebKit search clear icon — it would put chrome back into
     a deliberately chrome-free heading. */
  .session-search-headline::-webkit-search-cancel-button {
    display: none;
  }
  .session-search-headline::placeholder {
    color: inherit;
    opacity: 1;
  }
  /* On focus drop the placeholder out of sight so the user sees a
     blank field. Browsers normally only hide the placeholder once a
     character is typed; we want that "empty and ready" feeling the
     moment the field gains focus. */
  .session-search-headline:focus::placeholder {
    opacity: 0;
  }
  .session-search-count {
    flex: 0 0 auto;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .session-search-count.filtered {
    color: var(--text-1);
  }
  .session-search-empty {
    padding: 0.6rem 0.8rem;
    text-align: center;
  }
  .orphan-tag {
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    padding: 0 0.35rem;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-muted);
    border: 1px dashed var(--border-1, rgba(255, 255, 255, 0.15));
  }
  :global(.orphan-row) {
    opacity: 0.85;
  }
</style>
