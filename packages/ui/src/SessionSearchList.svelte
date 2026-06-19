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
  import ChatPreview from "./ChatPreview.svelte";
  import ShellPreview from "./ShellPreview.svelte";
  import type { ShellCmd } from "./shellPreviewTypes";
  import {
    fetchPreviewItems,
    type PreviewAction,
    type PreviewGap,
    type PreviewMsg,
    type PreviewSummary,
  } from "./preview-action";
  import {
    filterSessions,
    activityRank,
    recentlyActiveSources,
    orderNoQuery,
    type AgentSession,
  } from "./sessionSearch";
  import { isLiveCodexAppSource, type SessionSurface } from "./storage";
  import { importedTooltip } from "./imported-badge";

  /** Number of trailing shell commands to show in the hover dock.
   *  Matches the chat preview's "last few turns" feel without
   *  drowning the panel in scrollback. */
  const SHELL_PREVIEW_TAIL = 10;

  export let sessions: AgentSession[];
  export let headText: string;
  export let extraClass = "";
  /** Sessions whose `source` is in this set render with an "orphan" tag
   *  (i.e. their cwd no longer maps to a live worktree). Empty by default. */
  export let orphanSources: Set<string> = new Set();
  /** Sources the user has dismissed from this list — rendered in a
   *  separate "Dismissed" group at the bottom so the active list stays
   *  clean. Persisted by the parent; we just consume the set. */
  export let dismissedSources: Set<string> = new Set();
  /** Sources the user has starred (favorited). Starred sessions float
   *  to the top of the active list when no search query is active. */
  export let starredSources: Set<string> = new Set();
  /** Whether each row is already open as a column. Rows that are NOT
   *  open render dimmed so the already-open (active) ones stand out;
   *  open rows additionally reveal the inline close affordance. */
  export let isOpen: (s: AgentSession) => boolean = () => false;
  /** Tooltip text per row — caller knows the worktree context. */
  export let tooltipFor: (s: AgentSession) => string = (s) =>
    s.manualTitle ?? s.aiTitle ?? s.title ?? "(no title)";
  /** Last remembered surface for resumable agent sessions. The parent owns
   *  this because the preference store lives alongside open-session state. */
  export let surfaceFor: (s: AgentSession) => SessionSurface | undefined = () =>
    undefined;
  /** Placeholder string for the search input. */
  export let placeholder = "Search by title or message…";

  let query = "";
  let debouncedQuery = "";
  const DEBOUNCE_MS = 200;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  $: {
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = query;
    if (!q.trim()) {
      debouncedQuery = q;
    } else {
      debounceTimer = setTimeout(() => {
        debouncedQuery = q;
      }, DEBOUNCE_MS);
    }
  }
  $: filtered = filterSessions(sessions, debouncedQuery);

  // The no-query list orders by most-recent activity, but the order is
  // snapshotted the moment the picker opens — not recomputed live.
  // `sessions` keeps updating as `lastActive` ticks (polling / SSE), and
  // re-sorting on every tick would make rows jump under the cursor
  // mid-hover. So we capture two things once (the first time a non-empty
  // list arrives, i.e. at open): the activity rank, and which sessions
  // were "recently active" (within RECENT_ACTIVITY_MS). Both are frozen,
  // so a session crossing the recency window or reshuffling its activity
  // rank afterwards holds its tier/position. See `orderNoQuery`.
  let openRank: Map<string, number> | null = null;
  let recentSources: Set<string> = new Set();
  $: if (openRank === null && sessions.length > 0) {
    openRank = activityRank(sessions);
    recentSources = recentlyActiveSources(sessions, Date.now());
  }

  /** Active rows above the divider, dismissed rows below. Computed off the
   *  same `filtered` list so search applies to both groups. With no query
   *  the active rows hold their open-time order in three tiers:
   *  recently-active (within the recency window) on top, then starred,
   *  then the rest. */
  $: activeFiltered = (() => {
    const active = filtered.filter((s) => !dismissedSources.has(s.source));
    if (debouncedQuery.trim() || !openRank) return active;
    return orderNoQuery(active, openRank, recentSources, starredSources);
  })();
  $: dismissedFiltered = filtered.filter((s) => dismissedSources.has(s.source));
  /** One flat array of `{kind, ...}` so a single each-block can
   *  `animate:flip` rows as they move between the active and
   *  dismissed groups. A sentinel header object marks where the
   *  divider goes; its key is stable so its slot doesn't churn. */
  type RowItem =
    | { kind: "row"; sess: AgentSession; dismissed: boolean; key: string }
    | { kind: "header"; count: number; key: string };
  $: rendered = ((): RowItem[] => {
    const out: RowItem[] = activeFiltered.map((s) => ({
      kind: "row",
      sess: s,
      dismissed: false,
      key: s.source,
    }));
    if (dismissedFiltered.length > 0) {
      out.push({
        kind: "header",
        count: dismissedFiltered.length,
        key: "__dismissed_header__",
      });
      for (const s of dismissedFiltered) {
        out.push({ kind: "row", sess: s, dismissed: true, key: s.source });
      }
    }
    return out;
  })();

  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import { flip } from "svelte/animate";
  const dispatch = createEventDispatcher<{
    pick: AgentSession;
    close: AgentSession;
    dismiss: AgentSession;
    restore: AgentSession;
  }>();

  // ── Hover preview ───────────────────────────────────────────────
  // Per-row hover opens a preview anchored to the right of the
  // hovered row, in a fixed-position panel. Agent sessions render a
  // ChatPreview (same fetch helper as the session dock). Shell rows
  // render a ShellPreview (last N captured commands from the shell's
  // JSONL transcript).
  type PreviewItem = PreviewMsg | PreviewGap | PreviewAction;
  let previewCache: Record<string, PreviewItem[]> = {};
  /** Cached Ollama summary per source, shown above the messages when
   *  one already exists on disk (never generated here). */
  let previewSummaryCache: Record<string, PreviewSummary> = {};
  let shellPreviewCache: Record<string, ShellCmd[]> = {};
  let previewLoading: Record<string, boolean> = {};
  let hoveredSess: AgentSession | null = null;
  let hoveredTop = 0;
  let hoveredLeft = 0;
  /** Slight delay so brushing past rows doesn't fire /api/session
   *  fetches for each one. Once a preview is on screen, switching
   *  between rows is instant — the user is hovering with intent. */
  const SHOW_DELAY_MS = 280;
  const DISMISS_DELAY_MS = 120;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  const POLL_MS = 1500;

  function cancelShow() {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
  }
  function cancelDismiss() {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }
  function stopPoll() {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  }

  /** Pull the termId out of a shell session's synthetic source token.
   *  Shells are routed via `__attached__:shell:<termId>` (alive) or
   *  `__transcript__:shell:<termId>` (dead), matching what
   *  `shellToSession` produces in App.svelte. Returns null for any
   *  source that doesn't fit those shapes. */
  function shellTermId(source: string): string | null {
    const m = source.match(/^__(?:attached|transcript)__:shell:(.+)$/);
    return m ? m[1]! : null;
  }

  async function loadShellPreview(
    sess: AgentSession,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const termId = shellTermId(sess.source);
    if (!termId) return;
    if (previewLoading[sess.source]) return;
    if (!opts.force && shellPreviewCache[sess.source]) return;
    previewLoading = { ...previewLoading, [sess.source]: true };
    try {
      const res = await fetch(
        `/api/shell-transcript?termId=${encodeURIComponent(termId)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { cmds?: ShellCmd[] };
        const all = Array.isArray(data.cmds) ? data.cmds : [];
        const tail = all.slice(-SHELL_PREVIEW_TAIL);
        shellPreviewCache = { ...shellPreviewCache, [sess.source]: tail };
      }
    } catch {
      // network blip — keep prior cache visible
    }
    previewLoading = { ...previewLoading, [sess.source]: false };
  }

  async function loadPreview(
    sess: AgentSession,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (sess.agent === "shell") {
      await loadShellPreview(sess, opts);
      return;
    }
    if (previewLoading[sess.source]) return;
    if (!opts.force && previewCache[sess.source]) return;
    previewLoading = { ...previewLoading, [sess.source]: true };
    const r = await fetchPreviewItems(sess.source);
    if (r) {
      previewCache = { ...previewCache, [sess.source]: r.items };
      if (r.summary) {
        previewSummaryCache = {
          ...previewSummaryCache,
          [sess.source]: r.summary,
        };
      }
    }
    previewLoading = { ...previewLoading, [sess.source]: false };
  }

  function onRowEnter(ev: Event, sess: AgentSession) {
    cancelDismiss();
    cancelShow();
    const el = ev.currentTarget as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    hoveredTop = r.top + r.height / 2;
    hoveredLeft = r.right + 8;
    const open = () => {
      hoveredSess = sess;
      void loadPreview(sess);
      stopPoll();
      poller = setInterval(
        () => void loadPreview(sess, { force: true }),
        POLL_MS,
      );
    };
    if (hoveredSess) open();
    else showTimer = setTimeout(open, SHOW_DELAY_MS);
  }

  function onRowLeave() {
    cancelShow();
    cancelDismiss();
    dismissTimer = setTimeout(() => {
      hoveredSess = null;
      stopPoll();
      dismissTimer = null;
    }, DISMISS_DELAY_MS);
  }

  function onPanelEnter() {
    cancelDismiss();
  }

  function sessionSurface(sess: AgentSession): SessionSurface | undefined {
    if (sess.agent !== "claude" && sess.agent !== "codex") return undefined;
    return surfaceFor(sess);
  }

  function sessionAgentLabel(sess: AgentSession): string {
    if (sess.agent === "claude") return "Claude";
    if (sess.agent === "shell") return "Terminal";
    if (sess.agent === "codex") {
      return isLiveCodexAppSource(sess.source) ? "Codex App" : "Codex CLI";
    }
    if (sess.agent === "ollama") return "Ollama";
    return sess.agent;
  }

  function sessionSurfaceLabel(sess: AgentSession): string | undefined {
    const surface = sessionSurface(sess);
    if (!surface) return undefined;
    return surface === "read" ? "Visual" : "Terminal";
  }

  onDestroy(() => {
    cancelShow();
    cancelDismiss();
    stopPoll();
  });

  function relTime(iso: string): string {
    const d = Date.now() - Date.parse(iso);
    if (Number.isNaN(d)) return "";
    const s = Math.max(0, Math.floor(d / 1000));
    if (s < 60) return "now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
  }

  // Autofocus on mount so the user can just start typing to filter.
  // The placeholder stays visible while focused-but-empty (no
  // `:focus::placeholder` rule below) so the input still reads as a
  // section heading until the first keystroke. The browser's default
  // behaviour drops the placeholder once a character is typed, which
  // is exactly the transition we want.
  let inputEl: HTMLInputElement | null = null;
  onMount(() => {
    inputEl?.focus({ preventScroll: true });
  });
</script>

<Popover
  variant="agents"
  extraClass={`session-search-popover ${extraClass}`.trim()}
>
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
        bind:this={inputEl}
        bind:value={query}
        placeholder={headText}
        aria-label={headText}
        title={placeholder}
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
    {#each rendered as item (item.key)}
      <li
        class:dismissed-header={item.kind === "header"}
        animate:flip={{ duration: 250 }}
      >
        {#if item.kind === "header"}
          <span class="dismissed-header-text">Dismissed</span>
          <span class="dismissed-header-count">{item.count}</span>
        {:else}
          {@const sess = item.sess}
          {@const importedTip = importedTooltip(sess)}
          {@const surfaceLabel = sessionSurfaceLabel(sess)}
          <button
            class="agent-row brand-{sess.agent}"
            class:dimmed={!isOpen(sess) && !item.dismissed}
            class:dismissed-row={item.dismissed}
            class:orphan-row={orphanSources.has(sess.source)}
            class:preview-open={hoveredSess?.source === sess.source}
            title={tooltipFor(sess)}
            on:click={() => dispatch("pick", sess)}
            on:mouseenter={(ev) => onRowEnter(ev, sess)}
            on:mouseleave={onRowLeave}
            on:focusin={(ev) => onRowEnter(ev, sess)}
            on:focusout={onRowLeave}
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
                <path
                  d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
                />
              </svg>
            {:else if sess.agent === "shell"}
              <svg
                class="agent-row-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="4 7 9 12 4 17" />
                <line x1="12" y1="18" x2="20" y2="18" />
              </svg>
            {:else}
              <span class="agent-dot agent-{sess.agent}"></span>
            {/if}
            <span class="agent-row-name">
              {sessionAgentLabel(sess)}
            </span>
            {#if starredSources.has(sess.source)}
              <svg
                class="row-star"
                viewBox="0 0 24 24"
                width="10"
                height="10"
                aria-hidden="true"
                aria-label="Starred"
              >
                <path
                  fill="#e8b931"
                  d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"
                />
              </svg>
            {/if}
            {#if sess.manualTitle && sess.manualTitle.trim().length > 0}
              <span class="agent-title manual">{sess.manualTitle}</span>
            {:else if sess.aiTitle && sess.aiTitle.trim().length > 0}
              <!-- No user-set title, but a cached Ollama summary produced
                 one. Show it (styled distinctly from a manual title) so
                 the row reads as something meaningful. -->
              <span class="agent-title ai" title={sess.aiTitle}
                >{sess.aiTitle}</span
              >
            {:else if sess.agent === "shell" && sess.lastUserMessage && sess.lastUserMessage.trim().length > 0}
              <!-- Shell rows don't carry an agent-side title, so the
                 1fr title cell stays empty by default. Surface the
                 most recent captured command there as a muted
                 monospace snippet — same slot the manual title would
                 occupy when set, so the grid stays 7 columns. -->
              <span
                class="agent-title agent-last-cmd"
                title={sess.lastUserMessage}
              >
                {sess.lastUserMessage}
              </span>
            {:else if sess.lastUserMessage && sess.lastUserMessage.trim().length > 0}
              <!-- Chat session without a user-set title: fall back to
                 the most recent user message so the row still says
                 something identifiable instead of being blank. Wrapped
                 to one line and clamped via .agent-last-user-msg. -->
              <span
                class="agent-title agent-last-user-msg"
                title={sess.lastUserMessage}
              >
                {sess.lastUserMessage}
              </span>
            {:else if sess.title && sess.title.trim().length > 0}
              <span class="agent-title">{sess.title}</span>
            {/if}
            {#if importedTip}
              <svg
                class="row-imported"
                viewBox="0 0 24 24"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-label={importedTip}
              >
                <title>{importedTip}</title>
                <path d="M12 3v11m0 0l-4-4m4 4l4-4" />
                <path d="M5 20h14" />
              </svg>
            {/if}
            {#if orphanSources.has(sess.source)}
              <span
                class="orphan-tag"
                title={`Originated in ${sess.cwd} — no live worktree matches this path anymore.`}
                >orphan</span
              >
            {/if}
            <span
              class="muted small agent-msgs"
              title={surfaceLabel ??
                (sess.messageCount
                  ? sess.agent === "shell"
                    ? `${sess.messageCount.toLocaleString()} command${sess.messageCount === 1 ? "" : "s"} in this session`
                    : `${sess.messageCount.toLocaleString()} message${sess.messageCount === 1 ? "" : "s"} in this session`
                  : sess.agent === "shell"
                    ? "no commands captured"
                    : "no messages counted")}
            >
              {#if surfaceLabel}{surfaceLabel}{:else if sess.messageCount}{sess.messageCount.toLocaleString()}
                {sess.agent === "shell" ? "cmd" : "msg"}{:else}—{/if}
            </span>
            <span class="muted small agent-time"
              >{relTime(sess.lastActive)}</span
            >
            {#if sess.sessionId}
              <code class="muted small agent-sid"
                >{sess.sessionId.slice(0, 8)}</code
              >
            {/if}
            <span
              class="row-close"
              aria-hidden={!isOpen(sess)}
              on:click|stopPropagation={() => {
                if (isOpen(sess)) dispatch("close", sess);
              }}
              title="Close this session">×</span
            >
            {#if item.dismissed}
              <span
                class="row-action row-restore"
                role="button"
                tabindex="0"
                title="Restore this session to the active list"
                on:click|stopPropagation={() => dispatch("restore", sess)}
                on:keydown|stopPropagation={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    dispatch("restore", sess);
                  }
                }}
                aria-label="Restore session"
              >
                <!-- Lucide rotate-ccw — the standard "undo / restore"
                   glyph; pairs visually with the archive icon used
                   for dismiss. -->
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8" />
                  <polyline points="3 3 3 8 8 8" />
                </svg>
              </span>
            {:else}
              <span
                class="row-action row-dismiss"
                role="button"
                tabindex="0"
                title="Dismiss this session — moves it to the Dismissed group at the bottom"
                on:click|stopPropagation={() => dispatch("dismiss", sess)}
                on:keydown|stopPropagation={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    dispatch("dismiss", sess);
                  }
                }}
                aria-label="Dismiss session"
              >
                <!-- Lucide archive — reads as "stash this away" without
                   implying destructive delete (a trash icon would). -->
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="18" height="5" rx="1" />
                  <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
                  <line x1="10" y1="13" x2="14" y2="13" />
                </svg>
              </span>
            {/if}
          </button>
        {/if}
      </li>
    {/each}
    {#if filtered.length === 0}
      <li class="session-search-empty muted small">
        {query.trim() ? "No sessions match." : "No sessions yet."}
      </li>
    {/if}
  </ul>
</Popover>

{#if hoveredSess}
  <aside
    class="session-search-preview"
    style:top="{hoveredTop}px"
    style:left="{hoveredLeft}px"
    aria-hidden="true"
    on:mouseenter={onPanelEnter}
    on:mouseleave={onRowLeave}
  >
    {#if hoveredSess.agent === "shell"}
      <ShellPreview
        cmds={shellPreviewCache[hoveredSess.source]}
        loading={previewLoading[hoveredSess.source] ?? false}
      />
    {:else}
      <ChatPreview
        items={previewCache[hoveredSess.source]}
        summary={previewSummaryCache[hoveredSess.source]}
        agent={hoveredSess.agent}
        loading={previewLoading[hoveredSess.source] ?? false}
      />
    {/if}
  </aside>
{/if}

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
  /* While the placeholder is showing (i.e. the user hasn't typed
     anything yet) hide the blinking caret so it doesn't strobe over
     the heading text. `:placeholder-shown` flips off the moment a
     character lands and the caret comes back. */
  .session-search-headline:placeholder-shown {
    caret-color: transparent;
  }
  /* No `:focus::placeholder { opacity: 0 }` here on purpose. We
     autofocus the input on mount but want the placeholder (which
     doubles as the section heading, e.g. "66 sessions in this
     worktree") to stay visible until the user actually starts
     typing. The browser hides the placeholder once a character is
     entered, which is exactly the transition we want. */
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

  /* Divider between the active rows and the "Dismissed" group at the
     bottom of the list. Sits in the same <ul> so animate:flip can
     move rows past it; styled to look like a section header, not
     another picker row. */
  .dismissed-header {
    list-style: none;
    margin: 0.35rem 0 0.15rem;
    padding: 0.25rem 0.6rem 0.15rem;
    border-top: 1px dashed var(--border-1, rgba(255, 255, 255, 0.12));
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    pointer-events: none;
  }
  .dismissed-header-count {
    font-variant-numeric: tabular-nums;
    color: var(--text-2, var(--text-muted));
  }

  /* Rows the user has dismissed — visually dimmed (but still clickable
     so they can be opened directly) and rendered below the divider. */
  :global(.agents-list .agent-row.dismissed-row) {
    opacity: 0.55;
    filter: saturate(0.7);
  }
  :global(.agents-list .agent-row.dismissed-row:hover) {
    opacity: 0.85;
  }

  /* Stack the session-search popover above the sticky-notes layer
     (`.sticky-host` ≈ z 900, dragged-note ≈ 1500) so notes pinned to
     a row never paint over the picker. The hover-preview panel sits
     at 2200 already; bumping the popover root past that means the
     picker also covers it correctly when both are visible. */
  :global(.session-search-popover.agents-popover) {
    z-index: 2300;
  }

  /* In this popover we want columns that align ACROSS rows — not
     just within each row — so a long title in one row doesn't push
     "msgs · time · hash" of OTHER rows around. Pattern:
       1. `.agents-list` is the actual grid (9 columns).
       2. Each `<li>` is a subgrid that spans every column.
       3. Each `.agent-row` is itself a subgrid so the button's
          children can pin to those same columns.
     Scoped to `.session-search-popover` so other `.agents-list`
     consumers (worktree picker, branch picker, etc.) are untouched.

     Columns:
       1  logo / agent dot       fixed 16px
       2  provider name          auto
       3  star indicator          fixed 10px
       4  title / last-msg       1fr (the flexible cell)
       5  message / cmd count    auto
       6  time passed            auto
       7  short sid hash         auto
       8  close × (open only)    fixed 18px
       9  dismiss / restore      fixed 18px */
  :global(.session-search-popover .agents-list) {
    display: grid;
    grid-template-columns:
      16px
      auto
      10px
      minmax(0, 1fr)
      auto
      auto
      auto
      18px
      18px;
    column-gap: 0.5rem;
    row-gap: 0.1rem;
  }
  /* Each <li> is one row of the parent grid. Subgrid lets the row's
     button (and its children) participate in the SAME column tracks
     the outer grid defined, so widths align across rows. */
  :global(.session-search-popover .agents-list > li) {
    display: grid;
    grid-template-columns: subgrid;
    grid-column: 1 / -1;
    align-items: center;
    padding: 0;
    margin: 0;
  }
  /* The Dismissed-group header is a single label across all columns.
     Override the subgrid with a plain flex layout. */
  :global(.session-search-popover .agents-list > li.dismissed-header) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  /* The agent-row button itself is also a subgrid so its children
     (icon · name · star · title · …) pin to columns 1–9. Override
     the default per-row grid-template-columns from agent-row.css. */
  :global(.session-search-popover .agent-row) {
    display: grid;
    grid-template-columns: subgrid;
    grid-column: 1 / -1;
  }
  /* Pin each .agent-row child to its column so optional cells (no
     title, no sid, no manualTitle) don't shift their neighbours. */
  :global(.session-search-popover .agent-row > .agent-row-icon),
  :global(.session-search-popover .agent-row > .agent-dot) {
    grid-column: 1;
  }
  :global(.session-search-popover .agent-row > .agent-row-name) {
    grid-column: 2;
  }
  :global(.session-search-popover .agent-row > .row-star) {
    grid-column: 3;
    justify-self: center;
  }
  /* All three occupants of column 4 (the title plus the optional
     orphan / imported markers that share the title cell) MUST be pinned
     to grid-row 1. They're explicitly placed in the same column with an
     auto row; the grid cannot overlap two auto-row items, so it spills
     the second onto an implicit row 2 — which then drags every
     source-later cell (msgs / time / sid / close / action) down with it,
     wrapping the right half of the row to a second line. (Surfaced once
     the imported download glyph started co-occurring with a title.)
     Pinning the row keeps them overlapping in one cell as intended. */
  :global(.session-search-popover .agent-row > .agent-title) {
    grid-column: 4;
    grid-row: 1;
  }
  /* Orphan tag (rare) shares the title column, pinned to the right
     edge of that cell. Inline rendering would otherwise push the
     msgs / time columns rightward and break the alignment. */
  :global(.session-search-popover .agent-row > .orphan-tag) {
    grid-column: 4;
    grid-row: 1;
    justify-self: end;
  }
  /* Imported marker (small download glyph) shares the title cell like
     the orphan tag, pinned to its right edge. An imported session is
     matched to a live local repo, so it's effectively never also an
     orphan — no practical collision with .orphan-tag. */
  :global(.session-search-popover .agent-row > .row-imported) {
    grid-column: 4;
    grid-row: 1;
    justify-self: end;
  }
  :global(.session-search-popover .agent-row > .agent-msgs) {
    grid-column: 5;
  }
  :global(.session-search-popover .agent-row > .agent-time) {
    grid-column: 6;
  }
  :global(.session-search-popover .agent-row > .agent-sid) {
    grid-column: 7;
  }
  :global(.session-search-popover .agent-row > .row-close) {
    grid-column: 8;
  }
  :global(.session-search-popover .agent-row > .row-action) {
    grid-column: 9;
  }

  /* Dismiss / restore affordances on each row. Same 18px hit-zone
     as `.row-close` so the right-side cluster reads as one column. */
  .row-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    cursor: pointer;
    line-height: 0;
    opacity: 0;
    transition:
      opacity 120ms ease,
      background-color 120ms ease,
      color 120ms ease;
  }
  .row-action > svg {
    width: 12px;
    height: 12px;
  }
  /* Reveal the icon on row hover so the user discovers the
     dismiss/restore affordance without having to know it's there. */
  :global(.agents-list .agent-row:hover) .row-action,
  :global(.agents-list .agent-row:focus-within) .row-action {
    opacity: 0.8;
  }
  .row-action:hover {
    opacity: 1 !important;
    background: var(--surface-3);
    color: var(--text-1);
  }
  /* Restore on a dismissed row stays subtly visible even when not
     hovered — it's the only way back. */
  :global(.agents-list .agent-row.dismissed-row) .row-restore {
    opacity: 0.55;
  }
  /* Single clamp for ANY .agent-title cell in this popover — manual
     title, chat last-user-message fallback, shell last-cmd fallback,
     or plain agent-side title. 30ch + ellipsis keeps the row width
     bounded so long titles don't blow out the grid's 1fr column. */
  :global(.session-search-popover .agent-row .agent-title) {
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Shell rows: most recent captured command, shown in the title
     slot as a muted monospace snippet. Retunes typography + colour;
     the max-width / ellipsis rules above already apply. */
  :global(.agent-row .agent-title.agent-last-cmd) {
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 400;
  }
  /* Chat row fallback when there's no manualTitle: render the last
     user message in the title slot. Use the same colour + weight as
     a real title so the row reads consistently — only the truncation
     rule above keeps it from running wide. */
  :global(.agent-row .agent-title.agent-last-user-msg) {
    font-weight: 400;
  }
  /* AI-generated title (no user-set name yet). Lighter + italic so it
     reads as a suggestion rather than a name the user committed to. */
  :global(.agent-row .agent-title.ai) {
    font-weight: 400;
    font-style: italic;
    color: var(--text-2, var(--text-muted));
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
  /* Muted download glyph marking a session imported from another
     machine. The provenance ("Imported from X at <date>") lives in the
     SVG <title> tooltip. */
  .row-imported {
    color: var(--text-muted);
    opacity: 0.75;
    flex: none;
  }
  :global(.orphan-row) {
    opacity: 0.85;
  }

  /* Per-row chat preview pinned to the right of the hovered row.
     Fixed positioning so the panel anchors to the viewport — the
     popover's transformed parent is not its containing block. The
     panel captures pointer events so the user can move the cursor
     onto it without dismissing. */
  .session-search-preview {
    position: fixed;
    transform: translateY(-50%);
    width: 26rem;
    max-height: 80vh;
    overflow-y: auto;
    padding: 0.55rem 0.7rem;
    background: transparent;
    /* One above the popover root (2300) so the hover preview always
       paints on top of the picker rows it's anchored to. */
    z-index: 2400;
    transition:
      top 120ms ease,
      left 120ms ease;
  }
</style>
