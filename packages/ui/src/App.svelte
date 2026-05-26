<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { flip } from "svelte/animate";
  import { DismissedSessionsStore, ExpandedStore, StarredSessionsStore } from "./storage";
  import { getDaemonKV } from "./daemon-kv";
  import { openUrl } from "./open-url";
  import { singleFlight } from "./single-flight";
  import DiffViewer from "./DiffViewer.svelte";
  import SessionView from "./SessionView.svelte";
  import ShellView from "./ShellView.svelte";
  import OllamaTranscriptView from "./OllamaTranscriptView.svelte";
  import Popover from "./Popover.svelte";
  import Tooltip from "./Tooltip.svelte";
  import ChangedFilesTooltipBody from "./ChangedFilesTooltipBody.svelte";
  import NewSessionCol from "./NewSessionCol.svelte";
  import FileBrowser from "./FileBrowser.svelte";
  import GitHistory from "./GitHistory.svelte";
  import ProcessList from "./ProcessList.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import { aheadAged, BLINK_AHEAD_MINUTES } from "./ahead-age";
  import { statusSummary, type FileStatus } from "./status-summary";
  import { planReveal, type RevealMode } from "./reveal-session";
  import StickyNotesLayer from "./StickyNotesLayer.svelte";
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import NoteIcon from "./NoteIcon.svelte";
  import AgentIcon from "./AgentIcon.svelte";
  import AgentUsageChip from "./AgentUsageChip.svelte";
  import { spawnNote, flyRestoreNote } from "./StickyNotesLayer.svelte";
  import { notesCountByAnchor, notesAll, type NoteShape } from "./notes-counts";
  import { sessionFocusRequest } from "./session-focus-store";
  import EmojiPicker from "./EmojiPicker.svelte";
  import AnchorPicker from "./AnchorPicker.svelte";
  import OpenInButton from "./OpenInButton.svelte";
  import OpenInActions from "./OpenInActions.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { confirmDialog } from "./confirm-dialog";
  import SummarizeDialog from "./SummarizeDialog.svelte";
  import ShareSessionDialog from "./ShareSessionDialog.svelte";
  import ReceiveInviteDialog from "./ReceiveInviteDialog.svelte";
  import CopySessionDialog from "./CopySessionDialog.svelte";
  import RepairSessionDialog from "./RepairSessionDialog.svelte";
  import { openInvite } from "./receive-invite-dialog";
  import MessagesInbox from "./MessagesInbox.svelte";
  import { refreshMessages } from "./messages-store";
  import RepoRecentSummary from "./RepoRecentSummary.svelte";
  import { marked } from "marked";
  import OnboardingWalkthrough from "./OnboardingWalkthrough.svelte";
  import {
    WALKTHROUGH_STEPS,
    walkthroughSeen,
    markWalkthroughSeen,
    clearWalkthroughSeen,
  } from "./onboarding-walkthrough";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import SessionSearchList from "./SessionSearchList.svelte";
  import SessionDock from "./SessionDock.svelte";
  import { filterSessions } from "./sessionSearch";
  import { updateTabIndicator } from "./awaitingBadge";
  import {
    OpenSessionsStore,
    VisibleWorktreesStore,
    SYNTHETIC_SOURCE_PREFIXES,
    cmdForOpenSession,
    effectiveVisibleWorktrees,
    filterToExistingSessions,
    setSessionMode,
    stampDiscoveredSessionIdWithDetail,
    resolveTitleSource,
  } from "./storage";
  import {
    installFetchTracking,
    installGlobalErrorHandlers,
    subscribeErrors,
    hydrateFromServer,
    pushError,
    clearErrors,
    type FrontendErrorEntry,
  } from "./errors";

  // Wire fetch + global handlers as early as possible — before the first
  // load() fires — so even the initial /api/repos failure ends up in
  // the Events popover.
  installFetchTracking();
  installGlobalErrorHandlers();

  interface BranchStatus {
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    aheadOldestTime: string | null;
  }
  interface LastCommit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
  }
  interface AgentSession {
    /** "shell" is synthetic — produced client-side from `/api/shells`
     *  so we can render Terminal sessions in the same worktree picker
     *  alongside Claude/Codex/Copilot. "ollama" is also synthetic —
     *  live PTYs only, no on-disk JSONL scan. The daemon only ever
     *  returns "claude" / "codex" / "copilot" here. */
    agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
    cwd: string;
    lastActive: string;
    sessionId?: string;
    source: string;
    title?: string;
    lastUserMessage?: string;
    manualTitle?: string;
    firstUserMessage?: string;
    lastUserMessages?: string[];
    userMessageCount?: number;
    messageCount?: number;
    recentMessageCount?: number;
    contextTokens?: number;
    contextTokensExact?: boolean;
    contextWindow?: number;
    model?: string;
  }
  interface ShellRecord {
    termId: string;
    wt: string;
    spawnCwd: string;
    currentCwd?: string;
    createdAt: string;
    alive: boolean;
    /** Number of Enter-terminated command lines captured for this shell.
     *  Drives the "hide empty saved shells" filter in the picker. */
    cmdCount?: number;
    /** Most recent Enter-terminated command line captured for this
     *  shell, surfaced as a muted inline snippet on the picker row. */
    lastCmd?: string;
    /** Timestamp of `lastCmd` (ISO string). Used as the row's
     *  `lastActive` so shells age by their most recent use, not by
     *  spawn time. */
    lastCmdTs?: string;
    /** User-set title keyed by `shell:<termId>` in the workspace's
     *  session-title store; takes precedence over the inline last-cmd. */
    manualTitle?: string;
  }
  interface ActivityEvent {
    agent: "claude" | "codex" | "copilot";
    cwd: string;
    sessionId: string;
    summary: string;
    timestamp: string;
    source: string;
  }
  interface Worktree {
    path: string;
    branch: string;
    head: string;
    bare: boolean;
    detached: boolean;
    fileStatus: FileStatus;
    branchStatus: BranchStatus | null;
    lastCommit: LastCommit | null;
    agents?: AgentSession[];
    nonGit?: boolean;
  }
  interface RemoteRef {
    name: string;
    url: string;
    webUrl: string | null;
    provider: string | null;
    host: string | null;
  }
  /** A user-defined "open in" link. URL links open in a new browser
   *  tab; file / folder links go through `/api/open-default` which
   *  hands the path to the platform's default app (Finder, Explorer,
   *  xdg-open). */
  type CommandRunMode = "internal" | "external" | "shell";
  type CustomLink =
    | { id: string; kind?: "url"; url: string; name?: string }
    | { id: string; kind: "file"; path: string; name?: string }
    | { id: string; kind: "folder"; path: string; name?: string }
    | { id: string; kind: "command"; cmd: string; cwd?: string; runMode: CommandRunMode; name?: string };
  interface Repo {
    id: string;
    path: string;
    name: string;
    addedAt: string;
    /** Optional accent colour (#rrggbb) — applied wherever the repo
     *  name renders so the user can tell repos apart at a glance. */
    color?: string;
    worktrees: Worktree[];
    /** Git remotes for this repo (empty for non-git folders). */
    remotes?: RemoteRef[];
    /** User-defined "open in <X>" links (Coolify dashboards, staging
     *  URLs, anything web). Render as extra chips alongside the
     *  editor / Fork / remote buttons in the worktree row's action
     *  strip. */
    customLinks?: CustomLink[];
  }
  interface Event {
    id: string;
    timestamp: string;
    type: string;
    actor: "user" | "agent" | "supergit";
    payload: any;
    inverse?: any;
    undone: boolean;
    reversible: boolean;
    redoable: boolean;
  }
  interface EditorDescriptor {
    name: string;
    cmd: string;
  }

  let repos: Repo[] = [];
  let events: Event[] = [];
  let editors: EditorDescriptor[] = [];
  let runningCommandIds: Set<string> = new Set();
  let commandUrls: Record<string, string[]> = {};
  /** Shells (Terminal columns the daemon is hosting / has hosted). Used
   *  by the worktree session picker so past + live shells appear next
   *  to Claude/Codex agent sessions instead of hiding under a separate
   *  affordance. Refreshed alongside /api/repos in `load()`. */
  let allShells: ShellRecord[] = [];
  let loading = false;
  let loadingSlow = false;
  let loadingSlowTimer: ReturnType<typeof setTimeout> | null = null;
  // Legacy single-string error slot — kept for code paths that still set
  // it directly. New code should call `addToast({ kind: "error", ... })`
  // instead. Anything assigned to `error` is mirrored into the toast
  // stack via a reactive watcher below.
  let error = "";

  /** Toast stack. Errors and notices both render as floating cards in
   *  the bottom-right; each auto-dismisses on its own timer and can be
   *  closed manually. Designed to coexist with the stash banner that
   *  was wired earlier (which now uses this same machinery). */
  interface Toast {
    id: number;
    kind: "error" | "info" | "success" | "invite";
    message: string;
    title?: string;
    /** When set, clicking the toast body fires this callback (and also
     *  dismisses the toast). Used by the session-share invite toast to
     *  open the accept/decline dialog. */
    onClick?: () => void;
    /** When true, the toast does NOT auto-dismiss on a timer. The user
     *  has to click the body (which fires onClick) or the close button.
     *  Used for invite toasts that should persist until acted on. */
    persist?: boolean;
  }
  let toasts: Toast[] = [];
  let toastSeq = 0;
  const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Svelte action: focus the element as soon as it mounts. Used so an
   *  expanding search input grabs the caret without a follow-up click. */
  function focusOnMount(node: HTMLInputElement) {
    queueMicrotask(() => node.focus());
  }

  function addToast(opts: {
    kind: Toast["kind"];
    message: string;
    title?: string;
    ttlMs?: number;
    onClick?: () => void;
    persist?: boolean;
  }): number {
    if (!opts.message) return -1;
    const id = ++toastSeq;
    toasts = [
      ...toasts,
      {
        id,
        kind: opts.kind,
        message: opts.message,
        title: opts.title,
        onClick: opts.onClick,
        persist: opts.persist,
      },
    ];
    if (!opts.persist) {
      const ttl = opts.ttlMs ?? (opts.kind === "error" ? 12_000 : 7_000);
      toastTimers.set(
        id,
        setTimeout(() => dismissToast(id), ttl),
      );
    }
    return id;
  }
  function dismissToast(id: number) {
    const t = toastTimers.get(id);
    if (t) {
      clearTimeout(t);
      toastTimers.delete(id);
    }
    toasts = toasts.filter((x) => x.id !== id);
  }
  // Mirror any direct `error = "…"` assignment into the toast stack so
  // we don't have to chase every call site at once. Cleared as soon as
  // it's surfaced.
  $: if (error) {
    addToast({ kind: "error", message: error });
    error = "";
  }
  let streamConnected = false;

  /** Source of the session the user most recently focused via the
   *  side dock (or a direct session-column click). Drives the small
   *  triangle marker in SessionDock — purely a visual indicator of
   *  "the column you just navigated to is this one". Resets to null
   *  when that session is closed, and stays in memory only (a reload
   *  starts unfocused). */
  let focusedSource: string | null = null;

  // The unique row key (repoId + worktree path) currently being renamed.
  // Was just editingRepoId — but repos with multiple worktrees produce
  // multiple rows for the same repo, so a repo-id match would render two
  // inputs at once and the bind:value + focus() race breaks typing.
  let editingRowKey: string | null = null;
  let editingRepoId: string | null = null;
  let editRepoName = "";

  let actionsOpen = false;
  let eventsOpen = false;
  /** Orphan-notes tray: header button + popover listing notes whose
   *  anchor doesn't match any currently-registered repo or worktree.
   *  Only renders the button when there's at least one orphan. */
  let notesTrayOpen = false;
  let orphanReanchorFor: string | null = null;
  /** Per-row "notes hidden" toggle state. When true, all notes
   *  anchored to that row vanish via `.row-notes-hidden` (CSS
   *  display: none) — the StickyNote components stay mounted so
   *  their local edit state survives a hide/show round-trip. Keyed
   *  by the row's stable key (worktree path or "<repoId>|none"). */
  let notesHiddenByRow: Record<string, boolean> = {};
  {
    try {
      const raw = getDaemonKV().getItem("supergit:notesHidden");
      if (raw) notesHiddenByRow = JSON.parse(raw) ?? {};
    } catch {
      notesHiddenByRow = {};
    }
  }
  $: {
    try {
      getDaemonKV().setItem(
        "supergit:notesHidden",
        JSON.stringify(notesHiddenByRow),
      );
    } catch {}
  }
  function toggleNotesHidden(key: string): void {
    notesHiddenByRow = { ...notesHiddenByRow, [key]: !notesHiddenByRow[key] };
  }
  /** Per-row "notes list" popover. Keyed by the same row.key the rest
   *  of the row state uses. Opens off the small count badge sitting to
   *  the left of the `notes` toggle and lists everything pinned to
   *  this anchor plus recently-deleted notes (from events.jsonl) so
   *  the user can undo a delete without hunting the global Undo
   *  tray. */
  let notesListOpen: Record<string, boolean> = {};
  /** Per-row "zen" focus — one worktree row takes over the viewport,
   *  hiding the top bar and all other rows. `null` = no row focused.
   *  Toggled from the row-head; Esc exits. Purely cosmetic, no state
   *  persisted to workspace. */
  let zenRowKey: string | null = null;
  /** Zen-mode override for notes visibility. Notes hide by default in
   *  zen (the whole point of zen is a clean focus surface) regardless
   *  of `notesHiddenByRow`; this flag lets the user explicitly show
   *  them again via the row's `notes` toggle while in zen. Resets to
   *  `false` on every zen entry/exit so the next zen session starts
   *  clean. */
  let notesShownInZen = false;
  function toggleZenRow(key: string) {
    const exiting = zenRowKey === key;
    zenRowKey = exiting ? null : key;
    notesShownInZen = false;
    if (exiting) {
      const wtPath = key.split("|").slice(1).join("|");
      if (wtPath) tick().then(() => jumpToWorktreeRow(wtPath));
    }
  }
  // toggleFullscreen() lives in NewSessionCol.svelte now (it's only
  // called from inside the new-session-column header).
  /** Recent diagnostics: daemon 5xx, frontend fetch failures, browser
   *  uncaught/unhandledrejection. Populated reactively via the
   *  errors store (which is the source of truth — this is just a
   *  Svelte-reactive mirror). */
  let errorEntries: FrontendErrorEntry[] = [];
  /** id -> true when the user has expanded its stack trace inline. */
  let errorExpanded: Record<string, boolean> = {};
  function toggleErrorExpanded(id: string) {
    errorExpanded = { ...errorExpanded, [id]: !errorExpanded[id] };
  }
  function errorKindLabel(e: FrontendErrorEntry): string {
    if (e.kind === "server") return "server";
    if (e.kind === "fetch") return "fetch";
    if (e.kind === "rejection") return "unhandled";
    return "uncaught";
  }
  async function clearAllErrors() {
    await clearErrors();
  }

  let systemMemBytes: number | null = null;
  let processListRef: ProcessList;
  /** Force the folded-row StatusBadge area to render BOTH the push
   *  (↑) and pull (↓) variants at every folded row, so you can
   *  preview both border-ring animations side-by-side without
   *  needing the worktree to actually be ahead or behind. Set
   *  `?badgeanim=1` in the URL. */
  const badgeAnimDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("badgeanim") === "1";
  /** Apply the `.pulsate` modifier to every push StatusBadge so the
   *  stale-unpushed opacity oscillation can be eyeballed without
   *  wiring it up to the real staleness threshold yet. Pairs with
   *  `?badgeanim=1` (so both ↑ and ↓ render); the pulsate effect
   *  only shows on the ↑ badge by design. */
  const pulsateDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("pulsate") === "1";
  /** Force-render the "no repos registered yet" empty state even when
   *  repos are loaded — for previewing the onboarding CTA. Set
   *  `?emptyrepos=1` in the URL. */
  const emptyReposDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("emptyrepos") === "1";
  // Per worktree: is the "all sessions" popover next to the agent badge open?
  let agentsPopoverOpen: Record<string, boolean> = {};
  /** Per worktree: is the badge's "active TUIs" popover open? Distinct
   *  from `agentsPopoverOpen` (the count-chip picker over every known
   *  session) — this one lists only sessions currently mounted as
   *  columns, used as a fast jumper when several TUIs are live. */
  let activeTuisPopoverOpen: Record<string, boolean> = {};
  // Per worktree: inline session-strip search. `open` controls whether
  // the search input is expanded next to the count badge; `query` is
  // the current text. Closed + empty query = strip renders unfiltered.
  let stripSearchOpen: Record<string, boolean> = {};
  let stripSearchQuery: Record<string, string> = {};
  // Per row.key: did opening the strip search auto-unfold this row?
  // We re-fold on close *only* if no session was picked while open;
  // picking clears the flag so the row stays expanded around the now-
  // visible session column.
  let stripSearchAutoUnfolded: Record<string, boolean> = {};
  // Per wt.path: the last query the user *committed* (by clicking a
  // matched column in the strip). Re-opening the search restores this
  // text so the user can re-find what they were looking at; an
  // explicit cancel (× / ESC) drops it.
  let lastStripSearchQuery: Record<string, string> = {};

  /** Open the inline strip search for a worktree. If the row is
   *  currently folded we unfold it and remember (so close-without-pick
   *  re-folds it). The search input itself is rendered in the row
   *  head, which is visible regardless of fold state — only the strip
   *  below is hidden when folded, so unfolding is what reveals the
   *  matches the search is filtering for. */
  function openStripSearch(rowKey: string, wtPath: string): void {
    if (rowFolded[rowKey]) {
      stripSearchAutoUnfolded = {
        ...stripSearchAutoUnfolded,
        [rowKey]: true,
      };
      rowFolded = { ...rowFolded, [rowKey]: false };
    }
    stripSearchOpen = { ...stripSearchOpen, [wtPath]: true };
    // Restore the last committed query so re-opening picks up where
    // the user left off; absent / empty entry = blank input.
    const restore = lastStripSearchQuery[wtPath];
    if (restore) {
      stripSearchQuery = { ...stripSearchQuery, [wtPath]: restore };
    }
  }
  /** Close the inline strip search. Clears the query, hides the input,
   *  and re-folds the row iff opening the search was what unfolded it
   *  AND no session pick has cleared the flag in the meantime. */
  function closeStripSearch(rowKey: string, wtPath: string): void {
    stripSearchOpen = { ...stripSearchOpen, [wtPath]: false };
    stripSearchQuery = { ...stripSearchQuery, [wtPath]: "" };
    // Explicit cancel (× / ESC) → drop the saved query so the next
    // open starts blank. A commit (`commitStripSearch`) takes the
    // opposite path: it saves the query first, then closes.
    if (lastStripSearchQuery[wtPath]) {
      lastStripSearchQuery = {
        ...lastStripSearchQuery,
        [wtPath]: "",
      };
    }
    if (stripSearchAutoUnfolded[rowKey]) {
      rowFolded = { ...rowFolded, [rowKey]: true };
      stripSearchAutoUnfolded = {
        ...stripSearchAutoUnfolded,
        [rowKey]: false,
      };
    }
  }
  /** Commit the active strip search by clicking a matched session
   *  column. Saves the typed query (so re-opening restores it), pins
   *  the row open, hides the search input, and flashes/scrolls to the
   *  picked column — same "look here" cue the synthetic-column pick
   *  produces. No-op when search isn't open or the source isn't in
   *  the matched set (defensive — filtered-out columns are display:
   *  none and shouldn't receive clicks anyway). */
  function commitStripSearch(
    rowKey: string,
    wtPath: string,
    source: string,
  ): void {
    if (!stripSearchOpen[wtPath]) return;
    const filter = stripFilterByWt[wtPath];
    if (!filter || !filter.matched.has(source)) return;
    const q = stripSearchQuery[wtPath] ?? "";
    if (q.trim()) {
      lastStripSearchQuery = { ...lastStripSearchQuery, [wtPath]: q };
    }
    pinRowOpenAfterPick(rowKey);
    stripSearchOpen = { ...stripSearchOpen, [wtPath]: false };
    stripSearchQuery = { ...stripSearchQuery, [wtPath]: "" };
    void scrollToAndFlashSession(wtPath, source);
  }
  /** Cancel the auto-re-fold for this row. Called as soon as the user
   *  picks a session from the synthetic "matches not in strip" column
   *  (or presses Enter on the top match): from that point on, closing
   *  the search must leave the row expanded so the just-opened column
   *  stays in view. */
  function pinRowOpenAfterPick(rowKey: string): void {
    if (stripSearchAutoUnfolded[rowKey]) {
      stripSearchAutoUnfolded = {
        ...stripSearchAutoUnfolded,
        [rowKey]: false,
      };
    }
  }

  // clampToViewport (the popover-viewport-edge Svelte action) lives in
  // packages/ui/src/popover.ts now; Popover.svelte applies it
  // automatically unless the caller passes `unclamped`.

  // Per repo id: is the "new worktree" inline form open? (legacy — kept
  // for the createWorktree() flow which still reads/writes
  // newWtBranch[repo.id]; the inline-form rendering has been replaced
  // by the worktree-picker popover.)
  let newWtOpen: Record<string, boolean> = {};
  // Per wt.path (or repo.id when no worktrees exist yet): is the
  // unified worktree picker open? The picker lets you jump to a
  // worktree row, remove one, or create a new one.
  let wtPickerOpen: Record<string, boolean> = {};
  // Per-row: is the emoji sticker picker open?
  let emojiPickerOpen: Record<string, boolean> = {};
  // Agent CLIs we detected on PATH at the daemon. Loaded once on mount.
  let installedAgents: { name: string; path: string }[] = [];
  // Per-worktree: is the "+ new agent" popover open?
  let newAgentPopoverOpen: Record<string, boolean> = {};
  // Per-worktree: is the Ollama models submenu inside the picker expanded?
  // Reset when the picker closes so the next open starts collapsed.
  let ollamaSubmenuOpen: Record<string, boolean> = {};
  // Cached list of installed Ollama models for the picker submenu.
  // Lazy-loaded the first time the user expands the Ollama row.
  let ollamaModels: { name: string; size?: number; parameterSize?: string }[] = [];
  let ollamaModelsLoaded = false;
  let ollamaModelsLoading = false;
  let ollamaModelsError: string | null = null;

  async function ensureOllamaModelsLoaded(force = false) {
    if (ollamaModelsLoading) return;
    if (ollamaModelsLoaded && !force) return;
    ollamaModelsLoading = true;
    ollamaModelsError = null;
    try {
      const res = await fetch("/api/ollama/models");
      if (!res.ok) {
        ollamaModelsError = `daemon returned ${res.status}`;
        ollamaModels = [];
      } else {
        const body = (await res.json()) as {
          models?: { name: string; size?: number; parameterSize?: string }[];
        };
        ollamaModels = body.models ?? [];
      }
      ollamaModelsLoaded = true;
    } catch (e) {
      ollamaModelsError = e instanceof Error ? e.message : String(e);
      ollamaModels = [];
    } finally {
      ollamaModelsLoading = false;
    }
  }

  // Per transient session source: is the agent paused on a prompt
  // waiting for user input? Surfaced as an outlined column + a small
  // "needs input" pill in the header. Cleared when the agent emits
  // any output that no longer matches the prompt pattern, or when
  // the user types something.
  let transientAwaiting: Record<string, boolean> = {};
  /** Mirror of `transientAwaiting` for the live "working" flag. Driven
   *  by NewSessionCol's on:workingChange (which TerminalView raises on
   *  PTY frames). Drives the rotating-gradient border on the agent pill. */
  let transientWorking: Record<string, boolean> = {};
  /** Sources being promoted from `__new__:*` to a real JSONL path.
   *  Checked by `closeColumn` to skip the outro — the column isn't
   *  closing, it's upgrading to SessionView. */
  const promotedSources = new Set<string>();
  /** Sources whose ManualTitle is currently being edited. Promotions
   *  are deferred while the user is mid-edit so the input isn't ripped
   *  away. Queued promotions fire when editing stops. */
  const editingTitleSources = new Set<string>();
  type DeferredPromotion = { stampedSource: string; realSource: string; cwd: string };
  let deferredPromotions: DeferredPromotion[] = [];

  function executePromotion(stampedSource: string, realSource: string, cwd: string) {
    promotedSources.add(stampedSource);
    const termId = newTermIds[stampedSource];
    openSessionsByWt = {
      ...openSessionsByWt,
      [cwd]: (openSessionsByWt[cwd] ?? []).map((x) =>
        x.source === stampedSource
          ? {
              ...x,
              source: realSource,
              mode: "terminal" as const,
              attachTermId: termId,
            }
          : x,
      ),
    };
    {
      const w = { ...transientWorking };
      if (w[stampedSource] !== undefined) { w[realSource] = w[stampedSource]; delete w[stampedSource]; }
      transientWorking = w;
    }
    {
      const a = { ...transientAwaiting };
      if (a[stampedSource] !== undefined) { a[realSource] = a[stampedSource]; delete a[stampedSource]; }
      transientAwaiting = a;
    }
    if (transientExited[stampedSource] !== undefined) {
      const e = { ...transientExited };
      e[realSource] = e[stampedSource]; delete e[stampedSource];
      transientExited = e;
    }
    if (transientFinishedAt[stampedSource] !== undefined) {
      const f = { ...transientFinishedAt };
      f[realSource] = f[stampedSource]; delete f[stampedSource];
      transientFinishedAt = f;
    }
    if (workingStartedAt[stampedSource] !== undefined) {
      workingStartedAt[realSource] = workingStartedAt[stampedSource];
      workingStartedAt[stampedSource] = undefined;
    }
    void migrateSessionTitleOnServer(stampedSource, realSource);
  }

  function flushDeferredPromotions(source: string) {
    const pending = deferredPromotions.filter((p) => p.stampedSource === source);
    deferredPromotions = deferredPromotions.filter((p) => p.stampedSource !== source);
    for (const p of pending) {
      executePromotion(p.stampedSource, p.realSource, p.cwd);
    }
  }
  /** ms timestamp of when each source last entered the "working" state.
   *  Used to filter out brief PTY output bursts (status-bar redraws,
   *  resize-triggered re-renders) that don't represent real agent work
   *  — only working periods longer than MIN_WORKING_FOR_PULSE_MS arm
   *  the "unread" pulse in the dock. */
  let workingStartedAt: Record<string, number | undefined> = {};
  const MIN_WORKING_FOR_PULSE_MS = 3_000;
  /** Sources whose PTY has exited (TerminalView.onExit fired). The
   *  column stays in the page in read mode; the side dock uses this
   *  to render the row's dot smaller so the user can see at a
   *  glance which TUIs are still live vs which have wound down. */
  let transientExited: Record<string, boolean> = {};
  /** ms timestamp of the working→idle transition for each TUI.
   *  Drives the dock's "unread" pulse on the row's dot — a quiet
   *  reminder that the AI just finished and you haven't looked
   *  at it yet. Cleared when the user re-focuses the session
   *  (handlePick / revealSession) or when the PTY exits; the
   *  dock also auto-clears the pulse after 20 min so a long-
   *  ignored finish doesn't keep nagging. */
  let transientFinishedAt: Record<string, number | undefined> = {};
  /** Per-source debounce timers for `transientFinishedAt`. PTY
   *  `working` oscillates many times within a single agent turn
   *  (each tool call flips it), so we wait for a sustained idle
   *  period before stamping the row as unread — otherwise the
   *  dock would pulse on every tool-call boundary and clicking
   *  to dismiss would never feel sticky. */
  const FINISH_DEBOUNCE_MS = 8_000;
  const finishedTimers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
  function scheduleFinished(source: string): void {
    cancelFinishedTimer(source);
    finishedTimers[source] = setTimeout(() => {
      finishedTimers[source] = undefined;
      // If the user is currently focused inside the column when
      // the AI finishes, they don't need the dock to remind them
      // about an "unread" turn — they're already looking. Skip.
      if (isSessionFocused(source)) return;
      transientFinishedAt = {
        ...transientFinishedAt,
        [source]: Date.now(),
      };
    }, FINISH_DEBOUNCE_MS);
  }
  function handleFocusInForUnread(ev: FocusEvent): void {
    const t = ev.target as Element | null;
    if (!t) return;
    const col = t.closest?.(".session-col[data-session-source]") as
      | HTMLElement
      | null;
    if (!col) return;
    const src = col.getAttribute("data-session-source");
    if (!src) return;
    clearFinishedFor(src);
  }
  function isSessionFocused(source: string): boolean {
    if (typeof document === "undefined") return false;
    const col = document.querySelector(
      `.session-col[data-session-source="${CSS.escape(source)}"]`,
    );
    if (!col) return false;
    return col.contains(document.activeElement);
  }
  function cancelFinishedTimer(source: string): void {
    const t = finishedTimers[source];
    if (t) {
      clearTimeout(t);
      finishedTimers[source] = undefined;
    }
  }
  function clearFinishedFor(source: string): void {
    cancelFinishedTimer(source);
    if (transientFinishedAt[source] !== undefined) {
      transientFinishedAt = {
        ...transientFinishedAt,
        [source]: undefined,
      };
    }
  }
  /** `__new__:<agent>:<id>` source → daemon-assigned termId. Set by
   *  NewSessionCol's `on:spawn` for every agent (shell, claude, codex,
   *  copilot). Used by the Dispose button to DELETE /api/terminals/:id.
   *  Shell columns additionally flip to `__transcript__:` so ShellView
   *  takes over; claude/codex/copilot just kill the PTY and leave the
   *  column showing final output until the user clicks ×. */
  let newTermIds: Record<string, string> = {};

  /** Resolve the daemon termId for a `__new__:` or `__attached__:`
   *  column. `__attached__:` sources carry it directly in the suffix;
   *  `__new__:` sources are looked up in `newTermIds` (populated by
   *  NewSessionCol's on:spawn after the daemon assigns one). */
  function resolveTermId(s: { source: string }): string | undefined {
    if (s.source.startsWith("__attached__:")) return s.source.split(":").pop();
    if (s.source.startsWith("__new__:")) return newTermIds[s.source];
    return undefined;
  }

  /** Unified Dispose handler for live new-session columns.
   *
   *  Shell flips to a `__transcript__:shell:` source so ShellView takes
   *  over (command history + Resume).
   *
   *  Claude / Codex / Copilot flip to the canonical activity source
   *  (the on-disk JSONL path) when the activity tail has already
   *  surfaced this session's sid — so the column transitions to the
   *  read-only chat view (SessionView initialMode="read"). When the
   *  sid hasn't been surfaced yet (very early dispose, JSONL not on
   *  disk), we leave the column as-is so the user can still read the
   *  final TUI output until they × the column. */
  async function disposeNewSessionColumn(
    wtPath: string,
    s: OpenSession,
    agents: AgentSession[],
  ): Promise<void> {
    const termId = resolveTermId(s);
    if (!termId) {
      // PTY hasn't been spawned yet (no daemon termId to DELETE). Fall
      // back to plain close — the grace timer disposes the half-spawned
      // PTY soon enough.
      closeSessionInWt(wtPath, s);
      return;
    }
    try {
      await fetch(`/api/terminals/${encodeURIComponent(termId)}`, {
        method: "DELETE",
      }).catch(() => {});
    } finally {
      // Drop the now-stale termId mapping.
      const next = { ...newTermIds };
      delete next[s.source];
      newTermIds = next;
      if (s.agent === "shell") {
        // Command PTYs (spawned via custom-link commands) have no
        // shell header on disk — skip the transcript flip and just
        // close the column.
        let isCommandPty = false;
        for (const [, entry] of commandTermSources) {
          if (entry.source === s.source) { isCommandPty = true; break; }
        }
        if (isCommandPty) {
          closeSessionInWt(wtPath, s);
          return;
        }
        // Shell: replace the source in place so the column survives
        // and flips to ShellView (command history + Resume).
        const transcriptSource = `__transcript__:shell:${termId}`;
        promotedSources.add(s.source);
        openSessionsByWt = {
          ...openSessionsByWt,
          [wtPath]: (openSessionsByWt[wtPath] ?? []).map((x) =>
            x.source === s.source
              ? { agent: "shell", source: transcriptSource }
              : x,
          ),
        };
        void migrateSessionTitleOnServer(s.source, transcriptSource);
        dismissShellSource(`__attached__:shell:${termId}`);
      } else {
        // Claude / Codex / Copilot: flip to the read-only chat view by
        // adopting the source the activity-tail entry uses (the JSONL
        // path). The `:else` render branch then picks SessionView with
        // initialMode="read". Requires that resumeSessionId has been
        // stamped (the activity SSE has surfaced this sid) — without
        // it we have no way to map `__new__:claude:<random>` to a real
        // session on disk, so keep the dead xterm visible as before.
        const sid = s.resumeSessionId;
        const match = sid
          ? agents.find((a) => a.agent === s.agent && a.sessionId === sid)
          : undefined;
        if (match) {
          promotedSources.add(s.source);
          openSessionsByWt = {
            ...openSessionsByWt,
            [wtPath]: (openSessionsByWt[wtPath] ?? []).map((x) =>
              x.source === s.source
                ? {
                    agent: s.agent as OpenSession["agent"],
                    source: match.source,
                  }
                : x,
            ),
          };
          // Move the user's manual title from the synthetic source to
          // the real JSONL path so SessionView's header (which reads
          // titles[realPath] via /api/repos) keeps showing it.
          void migrateSessionTitleOnServer(s.source, match.source);
        }
      }
    }
  }

  // Per-worktree branch picker state (the dropdown that opens when the
  // user clicks the branch chip).
  interface BranchListing {
    current: string | null;
    local: string[];
    remote: string[];
  }
  let branchPickerOpen: Record<string, boolean> = {};
  let branchesByWt: Record<string, BranchListing> = {};
  let branchesLoading: Record<string, boolean> = {};
  let branchSortMode: "recency" | "alpha" = "recency";

  function sortBranches(list: string[], mode: "recency" | "alpha"): string[] {
    if (mode === "alpha") return [...list].sort((a, b) => a.localeCompare(b));
    // Recency: daemon already returns these in committerdate-desc order.
    return list;
  }

  async function loadBranchesFor(repoId: string, wtPath: string) {
    branchesLoading = { ...branchesLoading, [wtPath]: true };
    try {
      const res = await fetch(
        `/api/repos/${repoId}/branches?path=${encodeURIComponent(wtPath)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BranchListing;
      branchesByWt = { ...branchesByWt, [wtPath]: body };
    } catch {
      branchesByWt = {
        ...branchesByWt,
        [wtPath]: { current: null, local: [], remote: [] },
      };
    } finally {
      branchesLoading = { ...branchesLoading, [wtPath]: false };
    }
  }

  // Dirty-state checkout dialog: the user clicked a branch, the daemon
  // refused because the worktree is dirty; we surface a modal with
  // explicit Stash / Force / Cancel choices.
  let dirtyCheckout:
    | null
    | {
        repoId: string;
        wtPath: string;
        branch: string;
        message: string;
      } = null;

  /** Surface a successful "stash & switch" as a toast. Uses the generic
   *  toast stack so dismiss + ttl behave consistently with errors. */
  function showStashToast(_wtPath: string, message: string) {
    addToast({
      kind: "info",
      title: "Stashed.",
      message,
      ttlMs: 12_000,
    });
  }

  async function doCheckout(
    repoId: string,
    wtPath: string,
    branch: string,
    options: { force?: boolean; preStash?: boolean } = {},
  ): Promise<{ ok: boolean; dirty?: boolean; error?: string; stashed?: boolean }> {
    try {
      const res = await fetch(`/api/repos/${repoId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wtPath, branch, ...options }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { stashed?: boolean };
        return { ok: true, stashed: body.stashed };
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        dirty?: boolean;
      };
      return { ok: false, dirty: body.dirty, error: body.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Branch-picker entrypoint: try a clean checkout; if it fails because
   *  of dirty state, surface the dirty-checkout dialog so the user
   *  picks Stash / Force / Cancel. */
  async function tryCheckout(repoId: string, wtPath: string, branch: string) {
    branchPickerOpen = { ...branchPickerOpen, [wtPath]: false };
    const result = await doCheckout(repoId, wtPath, branch);
    if (result.ok) {
      if (result.stashed) {
        showStashToast(
          wtPath,
          "Your changes are stashed. Run `git stash pop` (or use Fork) to restore.",
        );
      }
      await load();
      return;
    }
    if (result.dirty) {
      dirtyCheckout = {
        repoId,
        wtPath,
        branch,
        message: result.error ?? "worktree has uncommitted changes",
      };
      return;
    }
    error = result.error ?? "checkout failed";
  }

  async function resolveDirty(action: "stash" | "force" | "cancel") {
    if (!dirtyCheckout) return;
    const ctx = dirtyCheckout;
    dirtyCheckout = null;
    if (action === "cancel") return;
    if (action === "force") {
      const confirmed = confirm(
        `Force-checkout will discard your uncommitted changes in\n  ${ctx.wtPath}\n\nThis cannot be undone. Continue?`,
      );
      if (!confirmed) return;
    }
    const result = await doCheckout(ctx.repoId, ctx.wtPath, ctx.branch, {
      preStash: action === "stash",
      force: action === "force",
    });
    if (result.ok) {
      if (result.stashed) {
        showStashToast(
          ctx.wtPath,
          `Stashed your changes before switching to \`${ctx.branch}\`. Run \`git stash pop\` to restore.`,
        );
      }
      await load();
    } else {
      error = result.error ?? "checkout failed";
    }
  }

  /** Per-worktree busy flags for the pull/push badges. Keyed by wt
   *  path; presence means "request in flight" — used to disable the
   *  badge buttons so a double-click can't queue a second pull. */
  let pullBusy: Record<string, boolean> = {};
  let pushBusy: Record<string, boolean> = {};

  /** Dirty-pull dialog: surfaced when `git pull --ff-only` failed
   *  because the worktree has local changes that overlap the incoming
   *  commits. Same shape as `dirtyCheckout` — explicit Stash & pull /
   *  Cancel choices. */
  let dirtyPull:
    | null
    | { repoId: string; wtPath: string; message: string } = null;

  async function doPull(
    repoId: string,
    wtPath: string,
    options: { preStash?: boolean } = {},
  ): Promise<
    { ok: boolean; kind?: string; stashed?: boolean; error?: string }
  > {
    try {
      const res = await fetch(`/api/repos/${repoId}/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wtPath, ...options }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        kind?: string;
        stashed?: boolean;
        error?: string;
      };
      if (res.ok && body.ok) {
        return { ok: true, kind: body.kind, stashed: body.stashed };
      }
      return {
        ok: false,
        kind: body.kind,
        error: body.error ?? `HTTP ${res.status}`,
      };
    } catch (e) {
      const msg = e instanceof DOMException && e.name === "TimeoutError"
        ? "Pull timed out — the remote may be unreachable."
        : e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  /** Behind-badge click entrypoint. Tries a fast-forward pull; on
   *  kind=dirty surfaces a Stash & pull dialog; on kind=diverged or
   *  any other failure, surfaces an error toast (the user has to
   *  resolve diverged branches in Fork / their editor — supergit
   *  doesn't try to drive an interactive rebase/merge). */
  async function tryPull(repoId: string, wtPath: string) {
    if (pullBusy[wtPath]) return;
    pullBusy = { ...pullBusy, [wtPath]: true };
    try {
      const result = await doPull(repoId, wtPath);
      if (result.ok) {
        if (result.kind === "up_to_date") {
          addToast({
            kind: "info",
            message: "Already up to date.",
            ttlMs: 4_000,
          });
        } else {
          addToast({
            kind: "success",
            message: "Pulled latest from upstream.",
            ttlMs: 6_000,
          });
        }
        await load();
        await load();
        return;
      }
      if (result.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      if (result.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      if (result.kind === "dirty") {
        dirtyPull = {
          repoId,
          wtPath,
          message: result.error ?? "worktree has uncommitted changes",
        };
        return;
      }
      if (result.kind === "diverged") {
        addToast({
          kind: "error",
          title: "Branch has diverged.",
          message:
            "Local commits aren't on upstream — resolve in Fork / your editor (rebase or merge), then try again.",
          ttlMs: 12_000,
        });
        return;
      }
      if (result.kind === "no_upstream") {
        addToast({
          kind: "error",
          title: "No upstream.",
          message: "This branch has no remote tracking ref.",
          ttlMs: 8_000,
        });
        return;
      }
      addToast({
        kind: "error",
        title: "Pull failed.",
        message: result.error ?? "git pull failed",
        ttlMs: 12_000,
      });
    } finally {
      pullBusy = { ...pullBusy, [wtPath]: false };
    }
  }

  async function resolveDirtyPull(action: "stash" | "cancel") {
    if (!dirtyPull) return;
    const ctx = dirtyPull;
    dirtyPull = null;
    if (action === "cancel") return;
    pullBusy = { ...pullBusy, [ctx.wtPath]: true };
    try {
      const result = await doPull(ctx.repoId, ctx.wtPath, { preStash: true });
      if (result.ok) {
        if (result.stashed) {
          showStashToast(
            ctx.wtPath,
            "Stashed your local changes before pulling. Run `git stash pop` to restore.",
          );
        } else {
          addToast({
            kind: "success",
            message: "Pulled latest from upstream.",
            ttlMs: 6_000,
          });
        }
        await load();
        await load();
      } else {
        addToast({
          kind: "error",
          title: "Pull failed.",
          message: result.error ?? "git pull failed",
          ttlMs: 12_000,
        });
      }
    } finally {
      pullBusy = { ...pullBusy, [ctx.wtPath]: false };
    }
  }

  /** Ahead-badge click entrypoint. Plain `git push` to the tracked
   *  upstream. Never forces; failures (non-fast-forward, hook abort,
   *  auth) surface as an error toast with the git error verbatim so
   *  the user can decide what to do (usually: pull first, then push). */
  async function tryPush(repoId: string, wtPath: string) {
    if (pushBusy[wtPath]) return;
    pushBusy = { ...pushBusy, [wtPath]: true };
    try {
      const res = await fetch(`/api/repos/${repoId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wtPath }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        kind?: string;
      };
      if (res.ok && body.ok) {
        addToast({
          kind: "success",
          message: "Pushed to upstream.",
          ttlMs: 6_000,
        });
        await load();
        await load();
        return;
      }
      if (body.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      if (body.kind === "auth") {
        addToast({
          kind: "error",
          title: "Git can't authenticate.",
          message:
            "Run `git config --global credential.helper osxkeychain` then `git fetch` in a terminal to store your credentials.",
          ttlMs: 20_000,
        });
        return;
      }
      addToast({
        kind: "error",
        title: "Push failed.",
        message: body.error ?? `HTTP ${res.status}`,
        ttlMs: 14_000,
      });
    } catch (e) {
      const msg = e instanceof DOMException && e.name === "TimeoutError"
        ? "Push timed out — the remote may be unreachable."
        : e instanceof Error ? e.message : String(e);
      addToast({
        kind: "error",
        title: "Push failed.",
        message: msg,
        ttlMs: 12_000,
      });
    } finally {
      pushBusy = { ...pushBusy, [wtPath]: false };
    }
  }

  async function loadInstalledAgents() {
    try {
      const res = await fetch("/api/agents/installed");
      if (!res.ok) return;
      const body = (await res.json()) as {
        installed: { name: string; path: string }[];
      };
      installedAgents = body.installed ?? [];
    } catch {
      installedAgents = [];
    }
  }

  /** Find the array index, in the worktree's current open-sessions list,
   *  where a new session should be inserted so it lands in a visible
   *  spot. If the leftmost visible column is cut off on the left edge,
   *  insert *after* it (so the new column appears between the cutoff
   *  column and the next fully visible one). Otherwise insert at that
   *  column's index. Falls back to 0 when the strip isn't laid out yet
   *  (e.g. row currently folded). */
  function visibleLeftInsertIndex(
    wtPath: string,
    list: OpenSession[],
  ): number {
    const strip = document.querySelector(
      `[data-wt-strip="${CSS.escape(wtPath)}"]`,
    ) as HTMLElement | null;
    if (!strip) return 0;
    const scrollLeft = strip.scrollLeft;
    const cols = strip.querySelectorAll<HTMLElement>(".session-col");
    for (const col of cols) {
      const colRight = col.offsetLeft + col.offsetWidth;
      if (colRight - scrollLeft >= 50) {
        const targetSource = col.dataset.sessionSource;
        if (targetSource) {
          const u = list.findIndex((x) => x.source === targetSource);
          if (u >= 0) {
            // If this column's left edge is before the scroll offset,
            // it's partially cut off — insert after it so the new
            // session lands in the visible area, not off-screen.
            if (col.offsetLeft < scrollLeft) return u + 1;
            return u;
          }
        }
        break;
      }
    }
    return 0;
  }

  /** After inserting `source` into the strip, smooth-scroll the strip so
   *  the new column sits at the viewport's left edge, AND vertically
   *  scroll the page so the row is visible (centered when possible,
   *  closest-edge when not — e.g. row is already partially visible).
   *  Without the vertical bit, creating a new session on a row below the
   *  fold gives no feedback: the column exists, but the user can't see it.
   *
   *  Delay before measuring: two concurrent CSS animations distort the
   *  column geometry for ~250ms after insert —
   *    1. `animate:flip` on `.session-col` (220ms) — existing siblings
   *       slide to their new positions when the new column splices in.
   *    2. `.session-col` width transitions on flex-basis/min/max-width
   *       (250ms) — read-mode siblings can snap to their narrower size
   *       when a live TUI is added.
   *  Measuring at the next rAF lands on mid-animation offsets, which
   *  parks the strip / page on a target that drifts under it as the
   *  animation finishes. Wait ~280ms so layout has settled before we
   *  compute scrollTo()'s target. */
  const NEW_COL_SCROLL_DELAY_MS = 280;
  function scrollNewColIntoView(wtPath: string, source: string): void {
    setTimeout(() => {
      const strip = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip) return;
      const newCol = strip.querySelector<HTMLElement>(
        `.session-col[data-session-source="${CSS.escape(source)}"]`,
      );
      if (!newCol) return;
      // Skip BOTH axes when the column is already in view: TerminalView's
      // xterm.focus() (fired from the WS-onopen handler) already triggers
      // the browser's built-in "scroll focused element into view" — it
      // typically lands the column nicely centered. Issuing our own
      // strip.scrollTo + scrollIntoView on top of that competes with
      // xterm's scroll and the user sees a second jump that yanks the
      // column off the position xterm just put it in.
      //
      // Per-axis skips so each axis only moves if it actually needs to:
      //   - horizontal: only flush-left the strip if the column isn't
      //     fully inside the strip's visible width.
      //   - vertical: only scrollIntoView if the column isn't fully in
      //     the viewport's vertical extent.
      //
      // When we do step in vertically, anchor on the column itself (not
      // the row-body): centering a tall row-body parks its middle in the
      // viewport and pushes the column off-screen, which was the prior
      // bug. `block: "center"` centers when the column fits, falls back
      // to nearest-edge for columns taller than the viewport — that's
      // the "center if possible / closest view" semantics.
      const r = newCol.getBoundingClientRect();
      const stripR = strip.getBoundingClientRect();
      const vh = window.innerHeight;
      const horizontallyVisible =
        r.left >= stripR.left && r.right <= stripR.right;
      const verticallyVisible = r.top >= 0 && r.bottom <= vh;
      if (!horizontallyVisible) {
        strip.scrollTo({ left: newCol.offsetLeft, behavior: "smooth" });
      }
      if (!verticallyVisible) {
        newCol.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "smooth",
        });
      }
    }, NEW_COL_SCROLL_DELAY_MS);
  }

  /** Open a brand-new agent session in this worktree. Adds a transient
   *  open-session entry whose source is sentinel-prefixed with
   *  `__new__:` — the column rendering branches on that to render
   *  TerminalView directly instead of the read-mode SessionView. */
  function openNewAgentSession(
    wtPath: string,
    agent: "claude" | "codex",
  ) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:${agent}:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    // Preassign a UUID for Claude so we can pass `--session-id <uuid>`
    // on spawn. Without it, recent Claude versions auto-load the cwd's
    // most-recent conversation when invoked as bare `claude`, which
    // makes "+ new session" silently resume the wrong thing. Codex has
    // no equivalent flag and isn't affected.
    const entry: {
      agent: "claude" | "codex";
      source: string;
      preassignedSessionId?: string;
    } = { agent, source: synthetic };
    if (agent === "claude") {
      entry.preassignedSessionId = crypto.randomUUID();
    }
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  /** Source-path fallback for freshly-created Ollama chat sessions,
   *  keyed by `__transcript__:ollama:<termId>` source. Set in
   *  `openNewOllamaChat` from the POST response so OllamaTranscriptView
   *  has a sourcePath before the next /api/repos rescan picks the new
   *  file up into `wt.agents`. Cleared on close. */
  let ollamaSourcePathOverride: Record<string, string> = {};

  /** Open a fresh API-driven Ollama chat column. POSTs to
   *  /api/ollama/sessions to create the JSONL with header, then routes
   *  through the same `__transcript__:ollama:<termId>` rendering path
   *  the picker already uses for past sessions — except now there's a
   *  composer at the bottom of SessionView and the conversation is
   *  driven via /api/ollama/chat instead of a PTY. See
   *  plans/ollama.md "Plan: API-driven chat mode". */
  async function openNewOllamaChat(wtPath: string, model: string): Promise<void> {
    try {
      const res = await fetch("/api/ollama/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, wt: wtPath, cwd: wtPath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.error(
          `openNewOllamaChat: daemon returned ${res.status} ${body?.error ?? ""}`,
        );
        return;
      }
      const body = (await res.json()) as {
        termId?: string;
        source?: string;
        model?: string;
      };
      const termId = body.termId;
      const sourcePath = body.source;
      if (!termId) return;
      const transcriptSource = `__transcript__:ollama:${termId}`;
      if (sourcePath) {
        ollamaSourcePathOverride = {
          ...ollamaSourcePathOverride,
          [transcriptSource]: sourcePath,
        };
      }
      const existing = openSessionsByWt[wtPath] ?? [];
      const insertAt = visibleLeftInsertIndex(wtPath, existing);
      const next = [...existing];
      next.splice(insertAt, 0, {
        agent: "ollama",
        source: transcriptSource,
        ollamaModel: model,
      });
      openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
      scrollNewColIntoView(wtPath, transcriptSource);
      // Refresh /api/repos so wt.agents picks up the new JSONL — needed
      // by the OllamaTranscriptView render branch's ollamaMeta lookup
      // on a subsequent reload (the immediate render uses the override
      // above).
      void load();
    } catch (e) {
      console.error("openNewOllamaChat:", e);
    }
  }

  /** Open a brand-new "Terminal" column in this worktree — a plain PTY
   *  running the user's $SHELL. Mirrors `openNewAgentSession` but uses
   *  agent="shell"; the render branch picks `defaultShell` as the cmd. */
  function openNewTerminalInWt(wtPath: string) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:shell:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    const entry: OpenSession = { agent: "shell", source: synthetic };
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  // --- Onboarding: "Get Started" inline AI description ----------------

  const newlyAddedRepoPaths = new Set<string>();

  interface OnboardingState {
    status: "loading" | "streaming" | "done" | "error";
    text: string;
    provider?: string;
    model?: string;
    error?: string;
  }
  let onboardingByWt: Record<string, OnboardingState> = {};
  let walkthroughByWt: Record<string, number | null> = {};

  $: tourRunning = Object.values(walkthroughByWt).some((v) => v != null);

  async function restartTutorial(): Promise<void> {
    if (tourRunning) {
      walkthroughByWt = {};
      return;
    }
    const ok = await confirmDialog({
      title: "Start the UI walkthrough?",
      message: "Highlights each part of the dashboard step by step.",
      confirmLabel: "Start tour",
    });
    if (!ok) return;
    const firstWt = rows.find((r) => r.wt && !r.wt.nonGit)?.wt;
    if (!firstWt) return;
    clearWalkthroughSeen(firstWt.path);
    walkthroughByWt = { [firstWt.path]: 0 };
  }

  async function startOnboarding(wtPath: string): Promise<void> {
    newlyAddedRepoPaths.delete(wtPath);
    onboardingByWt = {
      ...onboardingByWt,
      [wtPath]: { status: "loading", text: "" },
    };
    try {
      const res = await fetch("/api/onboarding/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wtPath }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body as { error?: string })?.error ?? `HTTP ${res.status}`,
        );
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let collected = "";
      let provider = "";
      let model = "";

      onboardingByWt = {
        ...onboardingByWt,
        [wtPath]: { status: "streaming", text: "" },
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let frameEnd: number;
        while ((frameEnd = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, frameEnd);
          buf = buf.slice(frameEnd + 2);
          let event = "message";
          let dataLine = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === "meta") {
            provider = (payload.provider as string) ?? "";
            model = (payload.model as string) ?? "";
            onboardingByWt = {
              ...onboardingByWt,
              [wtPath]: { status: "streaming", text: collected, provider, model },
            };
          } else if (event === "chunk" && typeof payload.delta === "string") {
            collected += payload.delta;
            onboardingByWt = {
              ...onboardingByWt,
              [wtPath]: { status: "streaming", text: collected, provider, model },
            };
          } else if (event === "error") {
            throw new Error(
              (payload.message as string) ?? "stream error",
            );
          } else if (event === "done") {
            // done
          }
        }
      }

      onboardingByWt = {
        ...onboardingByWt,
        [wtPath]: { status: "done", text: collected, provider, model },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onboardingByWt = {
        ...onboardingByWt,
        [wtPath]: { status: "error", text: "", error: msg },
      };
    }
  }

  async function continueSessionWith(
    wtPath: string,
    sessionSource: string,
    targetAgent: "claude" | "codex" | "ollama",
    ollamaModel?: string,
  ): Promise<void> {
    let contextPath: string;
    let contextText: string | undefined;
    try {
      const res = await fetch(
        `/api/session/context?source=${encodeURIComponent(sessionSource)}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { contextPath?: string; context?: string };
      contextPath = body.contextPath ?? "";
      contextText = body.context;
    } catch {
      return;
    }
    if (!contextPath) return;

    if (targetAgent === "ollama") {
      await ensureOllamaModelsLoaded();
      const model = ollamaModel ?? ollamaModels[0]?.name ?? "gemma3:4b";
      await openNewOllamaChat(wtPath, model);
      const lastWt = openSessionsByWt[wtPath] ?? [];
      const ollamaEntry = [...lastWt].reverse().find(
        (s) => s.agent === "ollama" && s.source.startsWith("__transcript__:ollama:"),
      );
      if (ollamaEntry) {
        const termId = ollamaEntry.source.replace("__transcript__:ollama:", "");
        const prompt =
          "I'm continuing a conversation from another agent. " +
          "Pick up where it left off:\n\n" +
          (contextText ?? `(see ${contextPath})`);
        void fetch("/api/ollama/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ termId, content: prompt }),
        });
      }
      return;
    }

    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:${targetAgent}:${id}`;
    const entry: OpenSession = {
      agent: targetAgent,
      source: synthetic,
      contextFilePath: contextPath,
    };
    if (targetAgent === "claude") {
      (entry as { preassignedSessionId?: string }).preassignedSessionId =
        crypto.randomUUID();
    }
    const existing = openSessionsByWt[wtPath] ?? [];
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  function openFileBrowser(wtPath: string) {
    const id = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__files__:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    const entry: OpenSession = { agent: "files", source: synthetic };
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  function openGitHistory(wtPath: string) {
    const id = `gh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__history__:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    const entry: OpenSession = { agent: "history", source: synthetic };
    const insertAt = visibleLeftInsertIndex(wtPath, existing);
    const next = [...existing];
    next.splice(insertAt, 0, entry);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, synthetic);
  }

  async function loadDefaultShell() {
    try {
      const res = await fetch("/api/shell-default");
      if (!res.ok) return;
      const body = (await res.json()) as { shell?: unknown; args?: unknown };
      if (typeof body.shell === "string" && body.shell.length > 0) {
        defaultShell = body.shell;
      }
      if (Array.isArray(body.args)) {
        defaultShellArgs = body.args as string[];
      }
    } catch {
      // best-effort — keeps the platform fallback
    }
  }

  /** Per-source cwd override for shell columns spawned via Resume.
   *  When the user Resumes a past shell, we want the new PTY at the
   *  *last* known cwd of that shell, not the worktree root. Keyed by
   *  the `__new__:shell:<id>` source the Resume action created. */
  let shellResumeCwd: Record<string, string> = {};

  /** Restore shell columns from the workspace. Live shells (PTY still
   *  alive) get an `__attached__:shell:<termId>` source so TerminalView
   *  reattaches via WS. Dead shells get `__transcript__:shell:<termId>`
   *  — ShellView fetches the JSONL and renders the command history with
   *  a Resume button. */
  /** Sources the user explicitly closed (× on a shell column, or toggled-
   *  off via the picker). Persisted so the close decision survives a
   *  reload — otherwise `restoreLiveShells` would re-add any live PTY
   *  inside the grace window and the close button would feel broken. */
  const DISMISSED_KEY = "supergit:dismissedShells";
  let dismissedShells: Set<string> = (() => {
    try {
      const raw = getDaemonKV().getItem(DISMISSED_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  })();
  function saveDismissedShells() {
    try {
      getDaemonKV().setItem(DISMISSED_KEY, JSON.stringify([...dismissedShells]));
    } catch {}
  }
  function dismissShellSource(source: string): void {
    if (!source.startsWith("__attached__:shell:") && !source.startsWith("__transcript__:shell:")) return;
    if (dismissedShells.has(source)) return;
    dismissedShells = new Set([...dismissedShells, source]);
    saveDismissedShells();
  }
  function undismissShellSource(source: string): void {
    if (!dismissedShells.has(source)) return;
    const next = new Set(dismissedShells);
    next.delete(source);
    dismissedShells = next;
    saveDismissedShells();
  }

  async function restoreLiveShells() {
    try {
      const res = await fetch("/api/shells");
      if (!res.ok) return;
      const list = (await res.json()) as Array<{
        termId: string;
        wt: string;
        spawnCwd: string;
        currentCwd?: string;
        alive: boolean;
      }>;
      const liveTermIds = new Set(
        list.filter((sh) => sh.alive).map((sh) => sh.termId),
      );
      const next = { ...openSessionsByWt };
      // Step 1: drop `__attached__:shell:<termId>` entries whose termId
      // is no longer live. After a daemon restart the PTY ids change,
      // so the persisted attachment from before the restart points at a
      // dead id — keeping it AND adding the new live one shows the user
      // two duplicate columns ("i had one, reloaded now i have two"
      // bug). Stale attachments without a live counterpart get dropped
      // entirely; the worktree session picker can still reopen the
      // past-shell transcript if the user wants it.
      for (const wt of Object.keys(next)) {
        const before = next[wt] ?? [];
        const after = before.filter((s) => {
          if (!s.source.startsWith("__attached__:shell:")) return true;
          const termId = s.source.split(":").pop();
          return !!termId && liveTermIds.has(termId);
        });
        if (after.length !== before.length) next[wt] = after;
      }
      // Step 2: add live shells that aren't already in the list.
      for (const sh of list) {
        if (!sh.alive) continue;
        const source = `__attached__:shell:${sh.termId}`;
        // Skip terminals the user explicitly closed before reload.
        if (dismissedShells.has(source)) continue;
        const existing = next[sh.wt] ?? [];
        if (existing.some((s) => s.source === source)) continue;
        next[sh.wt] = [{ agent: "shell", source }, ...existing];
      }
      openSessionsByWt = next;
    } catch {
      // best-effort — failing to restore just means the user has to
      // re-open their Terminal columns manually after a reload.
    }
  }

  /** Click handler for a past-shell's "Resume" button. Replaces the
   *  `__transcript__:` column with a `__new__:shell:<id>` one and
   *  remembers `lastCwd` so the render branch can pass it to TerminalView
   *  as the spawn cwd. */
  function resumePastShell(
    wtPath: string,
    transcriptSource: string,
    lastCwd: string,
  ) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const newSource = `__new__:shell:${id}`;
    shellResumeCwd = { ...shellResumeCwd, [newSource]: lastCwd };
    // Extract the prior termId from the `__transcript__:shell:<termId>`
    // source so the daemon can carry the prior cmd history forward
    // into the resumed shell's JSONL. ShellView mounts at this format
    // (see App.svelte's __transcript__: branch), so the termId is the
    // last colon-separated chunk.
    const previousTermId = transcriptSource.startsWith("__transcript__:shell:")
      ? transcriptSource.slice("__transcript__:shell:".length)
      : undefined;
    if (previousTermId) {
      shellResumeFromTermId = {
        ...shellResumeFromTermId,
        [newSource]: previousTermId,
      };
    }
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((x) =>
        x.source === transcriptSource
          ? { agent: "shell", source: newSource }
          : x,
      ),
    };
  }
  /** Synthetic-source → prior termId map. Populated by `resumePastShell`
   *  and consumed by NewSessionCol via the `resumeFromTermId` prop
   *  (which it forwards to TerminalView's spawn POST). Pruned in
   *  `disposeNewSessionColumn` when the column finally closes. */
  let shellResumeFromTermId: Record<string, string> = {};

  /** Restart a transient `__new__:` session IN PLACE. Replaces its
   *  entry with a fresh synthetic source so Svelte's {#each (s.source)}
   *  key change unmounts the old TerminalView (closing its WS, which
   *  triggers the daemon's grace-then-dispose for the dead PTY) and
   *  mounts a new one with the same cmd[]. Used when an agent
   *  self-updates and exits — codex prints "restart Codex" and we
   *  want a one-click rerun without losing the user's column slot. */
  function restartNewAgentSession(wtPath: string, current: { agent: string; source: string }) {
    const existing = openSessionsByWt[wtPath] ?? [];
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const replacement: {
      agent: "claude" | "codex" | "copilot";
      source: string;
      preassignedSessionId?: string;
    } = {
      agent: current.agent as "claude" | "codex" | "copilot",
      source: `__new__:${current.agent}:${id}`,
    };
    // Restart means a fresh conversation, not a continuation — mint a
    // new UUID for Claude so `--session-id` lands on a new file rather
    // than colliding with the dying PTY's id.
    if (current.agent === "claude") {
      replacement.preassignedSessionId = crypto.randomUUID();
    }
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: existing.map((x) =>
        x.source === current.source ? replacement : x,
      ),
    };
  }

  /** Per-synthetic-source manual title (the saved value). Edit-buffer
   *  state + the editing/draft flags moved into NewSessionCol.svelte;
   *  this map is the persistence-facing side that survives column
   *  remounts and the flip to the real SessionView once the JSONL
   *  appears on disk. */
  let newSessionTitles: Record<string, string> = {};

  /** Update the local `newSessionTitles` map after NewSessionCol's
   *  ManualTitle component POSTed successfully. The POST itself lives
   *  inside ManualTitle.svelte; this callback just mirrors the
   *  server-confirmed value into the in-memory map so the prop
   *  binding re-renders the header, and triggers a /api/repos refresh
   *  so the worktree row reflects the title once its real JSONL takes
   *  over from the synthetic source. */
  function saveNewSessionTitle(source: string, next: string) {
    newSessionTitles = next
      ? { ...newSessionTitles, [source]: next }
      : (({ [source]: _, ...rest }) => rest)(newSessionTitles);
    void load();
  }

  /** Ask the daemon to rename a saved title's key from `oldSource` to
   *  `newSource`, and update `newSessionTitles` to match. Called on every
   *  source-flip a transient column can undergo: shell spawn (`__new__:shell:`
   *  → `__attached__:shell:`) and agent dispose (`__new__:<agent>:` → real
   *  JSONL path). Without it the user's typed title is silently orphaned
   *  the moment the column's source changes. */
  async function migrateSessionTitleOnServer(
    oldSource: string,
    newSource: string,
  ): Promise<void> {
    if (oldSource === newSource) return;
    const existing = newSessionTitles[oldSource];
    try {
      const res = await fetch("/api/session/title/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldSource, newSource }),
      });
      if (!res.ok) return;
      const next = { ...newSessionTitles };
      delete next[oldSource];
      if (existing && !next[newSource]) next[newSource] = existing;
      newSessionTitles = next;
    } catch {
      // best-effort
    }
  }

  /** Faster poll cadence while a transient new-agent TUI is open — the
   *  agent is in the process of writing its first JSONL line, and we
   *  want it to surface in the worktree's agent strip within a few
   *  seconds rather than waiting for the next manual refresh.
   *  Stops itself as soon as no `__new__:` sessions remain.
   *
   *  Why bound the lifetime to "has transient sessions" instead of just
   *  always-polling: the rest of the time the SSE 'change' stream is
   *  enough; we don't want a 3s heartbeat for no reason. */
  let newSessionPollTimer: ReturnType<typeof setInterval> | null = null;
  $: hasTransientSessions = Object.values(openSessionsByWt).some((arr) =>
    arr.some((s) => s.source.startsWith("__new__:")),
  );
  $: if (hasTransientSessions && !newSessionPollTimer) {
    newSessionPollTimer = setInterval(() => {
      void load();
    }, 3_000);
  } else if (!hasTransientSessions && newSessionPollTimer) {
    clearInterval(newSessionPollTimer);
    newSessionPollTimer = null;
  }

  $: void promoteTransientSessions(hasTransientSessions, repos);
  function promoteTransientSessions(hasTransient: boolean, repoList: Repo[]) {
    if (!hasTransient || repoList.length === 0) return;
    let promoted = false;
    let next = openSessionsByWt;
    for (const [wtPath, sessions] of Object.entries(next)) {
      for (const s of sessions) {
        if (!s.source.startsWith("__new__:") || !s.resumeSessionId) continue;
        for (const repo of repoList) {
          for (const wt of repo.worktrees ?? []) {
            if (wt.path !== wtPath) continue;
            const match = (wt.agents ?? []).find(
              (a: { agent: string; sessionId?: string; source: string }) =>
                a.agent === s.agent && a.sessionId === s.resumeSessionId,
            );
            if (!match) continue;
            const termId = newTermIds[s.source];
            next = {
              ...next,
              [wtPath]: next[wtPath]!.map((x) =>
                x.source === s.source
                  ? { ...x, source: match.source, mode: "terminal" as const, attachTermId: termId }
                  : x,
              ),
            };
            if (transientWorking[s.source] !== undefined) {
              transientWorking = { ...transientWorking, [match.source]: transientWorking[s.source] };
            }
            if (transientAwaiting[s.source] !== undefined) {
              transientAwaiting = { ...transientAwaiting, [match.source]: transientAwaiting[s.source] };
            }
            void migrateSessionTitleOnServer(s.source, match.source);
            promoted = true;
          }
        }
      }
    }
    if (promoted) openSessionsByWt = next;
  }

  function repoName(repo: Repo): string {
    return (repo as { name?: string }).name ?? repo.path.split("/").filter(Boolean).pop() ?? repo.path;
  }

  /** Smooth-scroll the dashboard to the row representing this worktree
   *  and pulse it briefly so the user can locate it. */
  function jumpToWorktreeRow(path: string) {
    const sel = `[data-wt-row="${CSS.escape(path)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("wt-row-pulse");
    setTimeout(() => el.classList.remove("wt-row-pulse"), 1200);
  }
  let newWtBranch: Record<string, string> = {};
  let newWtBusy: Record<string, boolean> = {};

  async function createWorktree(repoId: string) {
    const branch = (newWtBranch[repoId] ?? "").trim();
    if (!branch) return;
    error = "";
    newWtBusy = { ...newWtBusy, [repoId]: true };
    try {
      const res = await fetch(`/api/repos/${repoId}/worktrees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        branch?: string;
        path?: string;
        created?: boolean;
      };
      // Tell the user whether we created a fresh branch or reused an
      // existing one. (Daemon's createWorktree now auto-detects.)
      addToast({
        kind: "success",
        title: body.created ? "Worktree created." : "Worktree for existing branch.",
        message: body.created
          ? `New branch \`${body.branch ?? branch}\` and worktree at ${body.path ?? ""}`
          : `Checked out existing \`${body.branch ?? branch}\` into ${body.path ?? ""}`,
      });
      newWtBranch = { ...newWtBranch, [repoId]: "" };
      newWtOpen = { ...newWtOpen, [repoId]: false };
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      newWtBusy = { ...newWtBusy, [repoId]: false };
    }
  }

  // Live activity stream keyed by the agent's cwd (≈ worktree path).
  // Capped to MAX_ACTIVITY entries per cwd; newest first.
  const MAX_ACTIVITY = 8;
  let activityByCwd: Record<string, ActivityEvent[]> = {};

  // Sessions live anchored to their worktree (so the connection to the
  // repo stays visually obvious) but can be opened side-by-side as a
  // horizontal strip below the row.
  interface OpenSession {
    /** Includes `"shell"` for plain-terminal columns (no JSONL transcript;
     *  the daemon spawns the user's $SHELL as a PTY). */
    agent: AgentSession["agent"] | "shell" | "files" | "history";
    source: string;
    /** Optional. Stamped on `__new__:claude:` / `__new__:codex:` columns
     *  by the activity-SSE handler once the daemon surfaces a real
     *  agent-side session id for this (cwd, agent). Survives reload via
     *  `OpenSessionsStore`. On remount, `cmdForOpenSession` uses it to
     *  spawn `claude --resume <sid>` instead of bare `claude`. */
    resumeSessionId?: string;
    /** Optional. UUID generated when this column was opened via the
     *  "+ new session" button, passed as `claude --session-id <uuid>`
     *  on spawn to force a fresh conversation. Once `resumeSessionId`
     *  is stamped (the activity tail surfaced the real agent-side id —
     *  same UUID, just observed via JSONL) the resume path takes
     *  over. Claude-only; codex has no equivalent flag. */
    preassignedSessionId?: string;
    /** Optional. `"terminal"` means SessionView should hydrate in
     *  terminal mode on remount (i.e. immediately spawn the resume PTY
     *  instead of showing the read-only chat view). Absent ⇒ read. */
    mode?: "terminal";
    /** Optional. For ollama columns: the model tag picked at spawn
     *  time (e.g. `qwen3-coder:30b`). Persisted so a reload re-spawns
     *  `ollama run <model>`, and surfaced in the agent pill. */
    ollamaModel?: string;
    /** Absolute path to the context handoff file written by the daemon.
     *  Claude gets `--append-system-prompt-file <path>`, Codex gets it
     *  as a positional prompt reference. Ephemeral — not persisted. */
    contextFilePath?: string;
    /** Daemon-side PTY id to reattach to when a `__new__:` column
     *  migrates to SessionView mid-flight. Set during the source swap
     *  so SessionView reattaches instead of spawning a duplicate. */
    attachTermId?: string;
  }
  let openSessionsByWt: Record<string, OpenSession[]> = {};

  /** The user's default login shell + args, fetched once on mount from
   *  /api/shell-default. The daemon resolves $SHELL / COMSPEC with
   *  platform-appropriate flags so the UI doesn't need to know about
   *  powershell vs zsh vs cmd. */
  let defaultShell: string =
    navigator.platform?.startsWith("Win") ? "powershell.exe" : "/bin/zsh";
  let defaultShellArgs: string[] =
    navigator.platform?.startsWith("Win") ? ["-NoLogo"] : ["-l"];

  function isOpenInWt(wtPath: string, source: string): boolean {
    return (openSessionsByWt[wtPath] ?? []).some((s) => s.source === source);
  }
  /** Rewrite a picker-supplied OpenSession when needed. Ollama sessions
   *  surface from `/api/agents` with `source` set to the JSONL header
   *  path under `<workspace>/ollama/`; opening one directly would land
   *  it in the SessionView render branch (which only parses Claude/
   *  Codex JSONLs and would render blank). Translate to a
   *  `__transcript__:ollama:<termId>` source — that's the shape
   *  OllamaTranscriptView mounts on — and stash the model from the
   *  matching AgentSession so the read-only view knows what to label
   *  the pill and what to Resume into. */
  function normalizeSessionForOpen(
    wtPath: string,
    s: OpenSession,
  ): OpenSession {
    if (
      s.agent !== "ollama" ||
      s.source.startsWith("__transcript__:") ||
      s.source.startsWith("__new__:") ||
      s.source.startsWith("__attached__:")
    ) {
      return s;
    }
    // Header path is `<workspace>/ollama/<termId>.jsonl`. The termId is
    // the basename without the extension.
    const base = s.source.split(/[\\/]/).pop() ?? "";
    const termId = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
    if (!termId) return s;
    const wt = repos.flatMap((r) => r.worktrees ?? []).find((w) => w.path === wtPath);
    const agents = wt?.agents ?? [];
    const match = agents.find(
      (a) => a.agent === "ollama" && (a.sessionId === termId || a.source === s.source),
    );
    return {
      agent: "ollama",
      source: `__transcript__:ollama:${termId}`,
      ollamaModel: match?.model ?? match?.title,
    };
  }

  function toggleOpenSessionInWt(wtPath: string, s: OpenSession): void {
    s = normalizeSessionForOpen(wtPath, s);
    const list = openSessionsByWt[wtPath] ?? [];
    const i = list.findIndex((x) => x.source === s.source);
    if (i >= 0) {
      // Already open — close it. Same dismiss semantics as ×.
      dismissIfShell(s);
      openSessionsByWt = {
        ...openSessionsByWt,
        [wtPath]: [...list.slice(0, i), ...list.slice(i + 1)],
      };
      return;
    }
    // Opening (or re-opening) — undo any prior dismissal so the column
    // sticks across the next reload.
    if (s.agent === "shell") undismissShellSource(s.source);

    // Opening a new session: insert it just left of the column the user is
    // currently looking at, so it appears on the left of their *visible*
    // strip (not just the array order). Then smooth-scroll so the new
    // column sits at the viewport's left edge.
    const insertAt = visibleLeftInsertIndex(wtPath, list);
    const next = [...list];
    next.splice(insertAt, 0, s);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
    scrollNewColIntoView(wtPath, s.source);
  }
  /** Mark a shell column as user-dismissed so `restoreLiveShells` won't
   *  re-add it on the next page load. Handles both the synthetic
   *  `__new__:` and the termId-based `__attached__:` forms: if the user
   *  × a fresh column, we also dismiss the attached-form (looked up via
   *  newTermIds) so the live PTY's own listing entry stays away. */
  function dismissIfShell(s: OpenSession): void {
    if (s.agent !== "shell") return;
    if (s.source.startsWith("__attached__:shell:") || s.source.startsWith("__transcript__:shell:")) {
      dismissShellSource(s.source);
    } else if (s.source.startsWith("__new__:shell:")) {
      const termId = newTermIds[s.source];
      if (termId) dismissShellSource(`__attached__:shell:${termId}`);
    }
  }

  function closeSessionInWt(wtPath: string, s: OpenSession): void {
    dismissIfShell(s);
    for (const [linkId, entry] of commandTermSources) {
      if (entry.source === s.source) {
        commandTermSources.delete(linkId);
        if (runningCommandIds.has(linkId)) {
          const next = new Set(runningCommandIds);
          next.delete(linkId);
          runningCommandIds = next;
        }
        break;
      }
    }
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: (openSessionsByWt[wtPath] ?? []).filter(
        (x) => x.source !== s.source,
      ),
    };
    if (focusedSource === s.source) focusedSource = null;
    if (ollamaSourcePathOverride[s.source]) {
      const next = { ...ollamaSourcePathOverride };
      delete next[s.source];
      ollamaSourcePathOverride = next;
    }
  }

  // Drag-to-reorder for sessions inside one worktree's strip. We don't
  // (yet) move sessions between worktrees — that's a bigger UX choice.
  let dragSource: { wtPath: string; index: number } | null = null;
  /** Live drop preview — drives the dashed insertion-line on the
   *  hovered column. `side: "left"` means the dragged column will
   *  land BEFORE this column; `"right"` means AFTER. Cleared on
   *  drop, dragend, and dragleave-from-strip. */
  let dragOverTarget: { wtPath: string; index: number; side: "left" | "right" } | null = null;

  function handleSessionDragStart(
    e: DragEvent,
    wtPath: string,
    index: number,
  ): void {
    dragSource = { wtPath, index };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Must set some data for Firefox to honour the drag.
      e.dataTransfer.setData("text/plain", `${wtPath}|${index}`);
    }
  }

  /** Called on dragover of a `.session-col`. Computes which side of
   *  the hovered column the cursor sits on so the dashed preview
   *  line lands on that edge — and so the drop math knows whether
   *  the user is aiming BEFORE or AFTER the target column. */
  function handleSessionDragOver(
    e: DragEvent,
    wtPath: string,
    index: number,
  ): void {
    if (!dragSource || dragSource.wtPath !== wtPath) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const side: "left" | "right" =
      e.clientX < r.left + r.width / 2 ? "left" : "right";
    if (
      !dragOverTarget ||
      dragOverTarget.wtPath !== wtPath ||
      dragOverTarget.index !== index ||
      dragOverTarget.side !== side
    ) {
      dragOverTarget = { wtPath, index, side };
    }
  }

  /** Strip-level dragleave so the dashed preview disappears only
   *  when the cursor leaves the whole strip, not on per-column
   *  dragleaves (which fire as the cursor crosses between
   *  neighbouring columns). */
  function handleStripDragLeave(e: DragEvent, wtPath: string): void {
    if (!dragOverTarget || dragOverTarget.wtPath !== wtPath) return;
    const strip = e.currentTarget as HTMLElement | null;
    const rel = e.relatedTarget as Node | null;
    if (strip && rel && strip.contains(rel)) return;
    dragOverTarget = null;
  }

  function handleSessionDragEnd(): void {
    dragSource = null;
    dragOverTarget = null;
  }

  function handleSessionDrop(
    e: DragEvent,
    wtPath: string,
    targetIndex: number,
  ): void {
    e.preventDefault();
    const src = dragSource;
    const hover = dragOverTarget;
    dragSource = null;
    dragOverTarget = null;
    if (!src || src.wtPath !== wtPath) return;
    // Translate "drop on column N, left/right half" into an
    // insertion index. Without this the drop always lands AT the
    // target column's index — surprising when the user aimed for
    // the gap on the other side.
    let insertAt = targetIndex;
    if (hover && hover.wtPath === wtPath && hover.index === targetIndex) {
      insertAt = hover.side === "right" ? targetIndex + 1 : targetIndex;
    }
    // Splicing the source out shifts everything after src.index down
    // by one, so adjust the post-source insertion index accordingly.
    if (insertAt > src.index) insertAt--;
    if (insertAt === src.index) return;
    const list = openSessionsByWt[wtPath] ?? [];
    const item = list[src.index];
    if (!item) return;
    const next = [...list];
    next.splice(src.index, 1);
    next.splice(insertAt, 0, item);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
  }

  // Source-control state per worktree moved into SourceControlPane.svelte
  // (Phase 2 of the App.svelte refactor). The only piece that stays here
  // is `commitsExpanded`, since it persists to localStorage.
  let commitsExpanded: Record<string, boolean> = {};
  /** Bumped per-worktree by the SSE handler when the daemon's FS watcher
   *  broadcasts a `fs_change` event. SourceControlPane reads this as a
   *  prop and refetches its cached diff when the value increments. */
  let fsChangeKey: Record<string, number> = {};

  /** Bumped every time the daemon broadcasts a note_create / note_update
   *  / note_delete SSE event. Passed to <StickyNotesLayer> so it
   *  refetches /api/notes — picks up notes created in another tab or
   *  edited by hand on disk. */
  let notesChangeKey = 0;

  const expandedStore = new ExpandedStore(
    getDaemonKV(),
    "supergit:commitsExpanded",
  );
  const dismissedSessionsStore = new DismissedSessionsStore(
    getDaemonKV(),
    "supergit:dismissedSessions",
  );
  /** Sources the user has dismissed from session pickers. Mutated via
   *  `dismissSession` / `restoreSession` — both reassign a new Set so
   *  Svelte triggers reactivity and the persisted JSON stays in sync. */
  let dismissedSessions: Set<string> = dismissedSessionsStore.load();
  function dismissSession(source: string): void {
    if (dismissedSessions.has(source)) return;
    const next = new Set(dismissedSessions);
    next.add(source);
    dismissedSessions = next;
    dismissedSessionsStore.save(next);
  }
  function restoreSession(source: string): void {
    if (!dismissedSessions.has(source)) return;
    const next = new Set(dismissedSessions);
    next.delete(source);
    dismissedSessions = next;
    dismissedSessionsStore.save(next);
  }
  const starredSessionsStore = new StarredSessionsStore(
    getDaemonKV(),
    "supergit:starredSessions",
  );
  let starredSessions: Set<string> = starredSessionsStore.load();
  function toggleStarSession(source: string): void {
    const next = new Set(starredSessions);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    starredSessions = next;
    starredSessionsStore.save(next);
  }
  const openSessionsPersistence = new OpenSessionsStore(
    getDaemonKV(),
    "supergit:openSessions",
  );
  const visibleWorktreesPersistence = new VisibleWorktreesStore(
    getDaemonKV(),
    "supergit:visibleWorktrees",
  );
  let visibleWorktreesByRepo: Record<string, string[]> = {};
  let visibleHydrated = false;

  // Per-row "fold this worktree row to a minimal one-line format". Keyed
  // by row.key (`${repo.id}|${wt.path}`) so each worktree of a multi-
  // worktree repo can be folded independently. Persisted in localStorage
  // so a folded row stays folded across reloads. Reuses ExpandedStore —
  // it's just a Set<string>.
  // Storage key was renamed from `foldedRepos` (repo-keyed) so stale
  // repo-id entries don't accidentally collapse rows on first load.
  const foldedRowsStore = new ExpandedStore(
    getDaemonKV(),
    "supergit:foldedRows",
  );
  let rowFolded: Record<string, boolean> = {};
  let foldedHydrated = false;
  /** Per-row latch: true once a row's session columns have been
   *  shown with real layout at least once this page load. Drives the
   *  first-unfold scroll-to-bottom in toggleRowFolded — rows that
   *  started expanded already had their SessionView mount-time scroll
   *  work, rows that started folded got `clientHeight = 0` and need
   *  a re-scroll on first unfold. Subsequent fold/unfold cycles
   *  preserve whatever scroll position the user left. */
  let rowHasBeenShown: Record<string, boolean> = {};
  let initialShownDone = false;
  /** Wall-clock tick (ms). Bumped every 3s in onMount. Used by the
   *  folded-row activity indicator to re-evaluate "any agent in this
   *  worktree had output in the last 10s?" without needing the daemon
   *  to push a discrete "still active" signal. */
  let nowMs = Date.now();
  const ACTIVITY_WINDOW_MS = 10_000;
  function wtHasRecentActivity(
    w: { agents?: Array<{ lastActive?: string }> } | undefined | null,
    now: number,
  ): boolean {
    if (!w?.agents?.length) return false;
    for (const a of w.agents) {
      if (!a.lastActive) continue;
      const t = Date.parse(a.lastActive);
      if (Number.isFinite(t) && now - t < ACTIVITY_WINDOW_MS) return true;
    }
    return false;
  }
  // Don't persist until the initial restore has run, otherwise the first
  // reactive write wipes saved state with our empty starting value.
  let sessionsHydrated = false;

  function restoreExpanded() {
    const paths = expandedStore.load();
    if (paths.size === 0) return;
    const next: Record<string, boolean> = {};
    for (const p of paths) next[p] = true;
    commitsExpanded = next;
  }
  function persistExpanded() {
    const paths = Object.entries(commitsExpanded)
      .filter(([, v]) => v)
      .map(([k]) => k);
    expandedStore.save(paths);
  }

  function restoreOpenSessions() {
    openSessionsByWt = openSessionsPersistence.load();
    sessionsHydrated = true;
  }
  $: if (sessionsHydrated) openSessionsPersistence.save(openSessionsByWt);

  function restoreVisibleWorktrees() {
    visibleWorktreesByRepo = visibleWorktreesPersistence.load();
    visibleHydrated = true;
  }
  $: if (visibleHydrated) visibleWorktreesPersistence.save(visibleWorktreesByRepo);

  function restoreFoldedRepos() {
    const keys = foldedRowsStore.load();
    if (keys.size > 0) {
      const next: Record<string, boolean> = {};
      for (const k of keys) next[k] = true;
      rowFolded = next;
    }
    foldedHydrated = true;
  }
  $: if (foldedHydrated) {
    foldedRowsStore.save(
      Object.entries(rowFolded)
        .filter(([, v]) => v)
        .map(([k]) => k),
    );
  }
  /** Once hydration + the first `rows` snapshot are both in hand,
   *  seed rowHasBeenShown for rows that are already unfolded:
   *  SessionView's mount-time scroll-to-bottom worked for those, so
   *  later fold→unfold toggles should preserve whatever scroll
   *  position the user left. Rows that were folded at load time
   *  stay un-marked, so their first unfold triggers a scroll-to-
   *  bottom. One-shot via `initialShownDone`. */
  $: if (foldedHydrated && rows.length > 0 && !initialShownDone) {
    const next = { ...rowHasBeenShown };
    for (const row of rows) {
      if (!rowFolded[row.key]) next[row.key] = true;
    }
    rowHasBeenShown = next;
    initialShownDone = true;
  }
  function toggleRowFolded(rowKey: string, wtPath?: string | null) {
    const wasFolded = !!rowFolded[rowKey];
    rowFolded = { ...rowFolded, [rowKey]: !wasFolded };
    // First-time unfold of a row that started folded at page load:
    // any session columns inside it mounted with `display: none`, so
    // their initial scroll-to-bottom ran against `clientHeight = 0`
    // and parked at the top. Force-stick each .messages to its
    // scrollHeight now that the row has real layout. Subsequent
    // toggles see rowHasBeenShown = true and leave scroll alone.
    if (wasFolded && wtPath && !rowHasBeenShown[rowKey]) {
      rowHasBeenShown = { ...rowHasBeenShown, [rowKey]: true };
      void stickAllSessionsInWtToBottom(wtPath);
    }
  }
  /** Auto-expand a folded row. Called from any session-opening
   *  affordance (new agent, new terminal, latest-session button,
   *  picker entries) so the resulting session column has room to
   *  render instead of being hidden behind the folded chrome.
   *  No-op if the row is already expanded. */
  function unfoldRowIfFolded(rowKey: string) {
    if (rowFolded[rowKey]) {
      rowFolded = { ...rowFolded, [rowKey]: false };
    }
  }
  /** Apply a plan from `planReveal()`: drives the imperative helpers
   *  off the boolean fields. The decision matrix itself lives in
   *  `./reveal-session` so it's unit-testable. `toggleOpenSessionInWt`
   *  handles both directions, so when the plan asks for either `open`
   *  or `close` we call it; pre-state guards in `planReveal` ensure we
   *  never ask for a no-op direction. */
  function applyRevealPlan(
    rowKey: string,
    wtPath: string,
    s: OpenSession,
    mode: RevealMode,
  ): void {
    const plan = planReveal({
      rowFolded: !!rowFolded[rowKey],
      isOpen: isOpenInWt(wtPath, s.source),
      mode,
    });
    if (plan.unfold) {
      unfoldRowIfFolded(rowKey);
      // Reveal-from-folded counts as the row's first showing — mark it
      // so later chevron-toggle fold/unfold cycles preserve the user's
      // scroll position instead of re-snapping every session to the
      // bottom. scrollToAndFlashSession below handles the *clicked*
      // column's scroll; this latch covers any sibling columns the
      // user later reveals via toggle.
      if (!rowHasBeenShown[rowKey]) {
        rowHasBeenShown = { ...rowHasBeenShown, [rowKey]: true };
      }
    }
    if (plan.open || plan.close) toggleOpenSessionInWt(wtPath, s);
    if (plan.scrollAndFlash) void scrollToAndFlashSession(wtPath, s.source);
  }
  /** Click handler for picker entries. Folded rows: never close on
   *  first click (the user can't see what's open); expanded rows:
   *  classic toggle. */
  function revealOrToggleSession(
    rowKey: string,
    wtPath: string,
    s: OpenSession,
  ): void {
    applyRevealPlan(rowKey, wtPath, s, "reveal-or-toggle");
  }
  /** Click handler for the row-head "most recent session" badge. Never
   *  closes the session — always brings it into view. The `×` on the
   *  session column is the only path to close it; the badge is a
   *  one-way "show me this" affordance. */
  function revealSession(
    rowKey: string,
    wtPath: string,
    s: OpenSession,
  ): void {
    applyRevealPlan(rowKey, wtPath, normalizeSessionForOpen(wtPath, s), "reveal");
  }

  /** Dock click handler. The scroll-and-flash path silently returns
   *  when its `[data-wt-strip]` / `.session-col` queries miss, so we
   *  first force-clear every condition that could hide the target
   *  row from the DOM (hidden worktree, zen-mask on another row, a
   *  folded row — the existing reveal plan already handles folded).
   *  Then we attempt the reveal.
   *
   *  If the column STILL can't be located after a tick, the dock
   *  entry is pointing at something the rest of the UI can't render.
   *  We only treat that as "stale, clean up" when the daemon is
   *  reachable AND confirms the source/worktree is gone — an
   *  unreachable daemon could just be a restart in progress and
   *  must not trigger any state mutation. */
  async function onDockPick(entry: {
    rowKey: string;
    wtPath: string;
    agent: OpenSession["agent"];
    source: string;
    repoId: string;
    title?: string;
    manualTitle?: string;
  }): Promise<void> {
    const repo = repos.find((r) => r.id === entry.repoId);
    if (repo) {
      const diskPaths = (repo.worktrees ?? []).map((w) => w.path);
      const visible = effectiveVisibleWorktrees(
        repo.id,
        diskPaths,
        visibleWorktreesByRepo,
      );
      if (!visible.includes(entry.wtPath)) {
        // Worktree row is hidden from the dashboard — the strip
        // element won't exist in the DOM until we restore it.
        visibleWorktreesByRepo = {
          ...visibleWorktreesByRepo,
          [repo.id]: [...visible, entry.wtPath],
        };
      }
    }
    if (zenRowKey && zenRowKey !== entry.rowKey) {
      zenRowKey = entry.rowKey;
      notesShownInZen = false;
    }
    revealSession(entry.rowKey, entry.wtPath, {
      agent: entry.agent,
      source: entry.source,
    });
    clearFinishedFor(entry.source);
    focusedSource = entry.source;

    // After one Svelte flush + a paint, check whether the column
    // actually landed in the DOM. If not, the dock entry is genuinely
    // unreachable and we should clean it up — but only if the daemon
    // confirms the underlying source is gone, never on a network blip.
    await tick();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const stripEl = document.querySelector(
      `[data-wt-strip="${CSS.escape(entry.wtPath)}"]`,
    );
    const colEl = stripEl?.querySelector(
      `.session-col[data-session-source="${CSS.escape(entry.source)}"]`,
    );
    if (colEl) return;
    let daemonReachable = false;
    let stillExists = false;
    try {
      // Drain the NDJSON stream into a full array — we don't need
      // progressive rendering for this verification path, just the
      // final list.
      const fresh = await fetchReposNDJSON();
      daemonReachable = true;
      const isSynthetic = SYNTHETIC_SOURCE_PREFIXES.some((p) =>
        entry.source.startsWith(p),
      );
      if (isSynthetic) {
        // Synthetic sources (__new__:, __attached__:, __transcript__:)
        // are managed client-side — they "exist" so long as their
        // owning worktree still exists on disk. The agents list
        // wouldn't carry them.
        stillExists = fresh.some((rr) =>
          (rr.worktrees ?? []).some((w) => w.path === entry.wtPath),
        );
      } else {
        stillExists = fresh.some((rr) =>
          (rr.worktrees ?? []).some((w) =>
            (w.agents ?? []).some((a) => a.source === entry.source),
          ),
        );
      }
    } catch {
      daemonReachable = false;
    }
    if (daemonReachable && !stillExists) {
      const label = entry.manualTitle ?? entry.title ?? "this session";
      addToast({
        kind: "info",
        title: "Stale session removed",
        message: `${label} no longer exists on disk; closing its dock entry.`,
      });
      closeSessionInWt(entry.wtPath, {
        agent: entry.agent,
        source: entry.source,
      } as OpenSession);
    }
    // daemonReachable === false → daemon is down or restarting; leave
    // openSessionsByWt untouched so the entry is still there once the
    // daemon comes back up.
  }
  /** After unfold (and any state mutation), wait for Svelte to flush
   *  DOM + one rAF for `.row-body` to flip from `display:none` to
   *  laid-out, then scroll the strip so the target column is horizontally
   *  *centered* in the visible strip (the user reads its messages in the
   *  middle, not pushed against the left edge). When the column is wider
   *  than the strip we fall back to aligning its left edge inside the
   *  leading pad so the start of the column is still on screen.
   *  Also adds `.session-col-flash` for ~2s so the eye lands on it.
   *
   *  Uses bounding-rect math (not `col.offsetLeft`) because the column's
   *  offsetParent isn't reliably the strip — the row's positioned
   *  ancestors threw offsets off by ~50–100px and parked the leftmost
   *  column under the viewport edge. */
  async function scrollToAndFlashSession(
    wtPath: string,
    source: string,
  ): Promise<void> {
    await tick();
    requestAnimationFrame(() => {
      const strip = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip) return;
      const col = strip.querySelector<HTMLElement>(
        `.session-col[data-session-source="${CSS.escape(source)}"]`,
      );
      if (!col) return;
      const stripRect = strip.getBoundingClientRect();
      const colRect = col.getBoundingClientRect();
      const colOffsetInStrip =
        strip.scrollLeft + (colRect.left - stripRect.left);
      let target: number;
      if (colRect.width >= stripRect.width) {
        // Column is wider than the visible strip: keep its left edge
        // just inside the strip's `padding-left` so the user sees the
        // beginning with the same breathing room a normal column gets.
        const padW = parseFloat(getComputedStyle(strip).paddingLeft) || 0;
        target = colOffsetInStrip - padW;
      } else {
        // Center horizontally in the visible strip.
        target = colOffsetInStrip - (stripRect.width - colRect.width) / 2;
      }
      strip.scrollTo({
        left: Math.max(0, Math.min(target, strip.scrollWidth - strip.clientWidth)),
        behavior: "smooth",
      });
      // Also vertically center the column in the viewport so a click
      // on a side-dock dot brings the row into view, not just the
      // (already laid out but possibly off-screen) column. `inline:
      // "nearest"` keeps the browser from re-doing the horizontal
      // scroll we already handled above. Use the column's row-body
      // ancestor as the scroll anchor when present so a short column
      // doesn't park the row's chrome (header, etc.) above the fold.
      const anchor =
        (col.closest(".row-body") as HTMLElement | null) ?? col;
      anchor.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
      col.classList.add("session-col-flash");
      setTimeout(() => col.classList.remove("session-col-flash"), 2000);
      const messages = col.querySelector<HTMLElement>(".messages");
      if (messages) stickMessagesToBottom(messages);
    });
  }
  /** Park a SessionView's messages list at the bottom, then re-stick
   *  as markdown / code-block renders flow in.
   *
   *  SessionView's first-render scroll-to-bottom runs with
   *  `clientHeight = 0` when the row is `display:none` at the time
   *  the column mounts, so the list stays parked at scrollTop=0. Once
   *  the row has real layout we force scrollTop = scrollHeight, but
   *  async markdown rendering keeps growing scrollHeight for a few
   *  hundred ms — so we also observe each .msg child and re-stick on
   *  every resize, then disconnect after 1.5s so we don't fight the
   *  user once they start scrolling manually. ResizeObserver on
   *  `.messages` itself wouldn't fire (the container is capped at
   *  max-height: 50vh); the children are where the height changes
   *  actually land. */
  function stickMessagesToBottom(messages: HTMLElement): void {
    const stick = () => {
      messages.scrollTop = messages.scrollHeight;
    };
    stick();
    const ro = new ResizeObserver(stick);
    for (const child of Array.from(messages.children)) {
      ro.observe(child as Element);
    }
    setTimeout(() => ro.disconnect(), 1500);
  }
  /** First-unfold-after-load path: scroll every session column in
   *  this worktree's strip to the bottom. Used by `toggleRowFolded`
   *  when the row transitions from folded → unfolded for the first
   *  time this page load. Same `stickMessagesToBottom` trick as
   *  the single-session reveal path; covers every column at once. */
  async function stickAllSessionsInWtToBottom(wtPath: string): Promise<void> {
    await tick();
    requestAnimationFrame(() => {
      const strip = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip) return;
      const cols = strip.querySelectorAll<HTMLElement>(".session-col");
      for (const col of cols) {
        const messages = col.querySelector<HTMLElement>(".messages");
        if (messages) stickMessagesToBottom(messages);
      }
    });
  }

  /** Hide a worktree row from the dashboard. Disk is untouched; the
   *  worktree still exists, just not displayed. Re-show via the
   *  worktrees picker. */
  function hideWorktreeRow(repoId: string, wtPath: string, diskPaths: string[]) {
    const current = effectiveVisibleWorktrees(repoId, diskPaths, visibleWorktreesByRepo);
    const next = current.filter((p) => p !== wtPath);
    visibleWorktreesByRepo = { ...visibleWorktreesByRepo, [repoId]: next };
  }

  /** Toggle a worktree's visibility in the dashboard from the picker. */
  function toggleWorktreeVisibility(repoId: string, wtPath: string, diskPaths: string[]) {
    const current = effectiveVisibleWorktrees(repoId, diskPaths, visibleWorktreesByRepo);
    const isVisible = current.includes(wtPath);
    const next = isVisible
      ? current.filter((p) => p !== wtPath)
      : [...current, wtPath];
    visibleWorktreesByRepo = { ...visibleWorktreesByRepo, [repoId]: next };
  }

  /** Refetch only `/api/events` and republish. Same effect on the
   *  reactive `events` array as a full `load()`, but skips the
   *  `/api/repos` git-status scan that dominates `load()`'s wall
   *  time (especially on workspaces with many worktrees or slow
   *  drives). Called from the SSE handler when a `change` event
   *  arrives so the per-row notes-list popover ("Recently deleted"
   *  + reactive undo) and the global Undo tray pick up the new
   *  event within one network round-trip instead of waiting on the
   *  full repos refresh. */
  async function refreshEvents(): Promise<void> {
    try {
      const e = await fetch("/api/events");
      if (!e.ok) return;
      events = await e.json();
    } catch {
      // Network errors are non-fatal — the next load() catches up.
    }
  }

  /** Stream /api/repos as NDJSON: one manifest line listing repo
   *  skeletons (id + name + path + color, no worktrees yet) followed
   *  by one full enriched-repo line as each repo's git fan-out
   *  completes on the server. Callers usually use `onManifest` to
   *  paint placeholder rows and `onRepo` to fill them in as each
   *  arrives — that way the dashboard stops blocking on the slowest
   *  worktree before showing anything. The returned promise resolves
   *  with the full final array, in the original workspace order. */
  async function fetchReposNDJSON(opts?: {
    onManifest?: (skeletons: Repo[]) => void;
    onRepo?: (repo: Repo) => void;
  }): Promise<Repo[]> {
    const r = await fetch("/api/repos", { cache: "no-cache" });
    if (!r.ok) throw new Error(`/api/repos: ${r.status}`);
    if (!r.body) throw new Error("/api/repos: response had no body");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const out: Repo[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          // Per-line parse failures shouldn't kill the whole stream
          // — drop the bad line and keep going so a single corrupt
          // entry can't blank the dashboard.
          try {
            const msg = JSON.parse(line) as
              | {
                  type: "manifest";
                  repos: {
                    id: string;
                    path: string;
                    name: string;
                    addedAt: string;
                    color?: string;
                  }[];
                }
              | { type: "repo"; repo: Repo };
            if (msg.type === "manifest" && Array.isArray(msg.repos)) {
              const skeletons: Repo[] = msg.repos.map((m) => ({
                id: m.id,
                path: m.path,
                name: m.name,
                addedAt: m.addedAt,
                color: m.color,
                worktrees: [],
                remotes: [],
              }));
              opts?.onManifest?.(skeletons);
            } else if (msg.type === "repo" && msg.repo) {
              out.push(msg.repo);
              opts?.onRepo?.(msg.repo);
            }
          } catch {
            // skip malformed line
          }
        }
        nl = buf.indexOf("\n");
      }
    }
    return out;
  }

  /** Coalesced via singleFlight: the dashboard's many refresh paths
   *  (initial mount, SSE change/error bursts, the new-session poll
   *  timer, every mutation's optimistic refresh) all funnel through
   *  here. Without the wrapper an `fs_change` storm or two mutations
   *  landing in the same tick would issue concurrent /api/repos NDJSON
   *  streams that race each other writing into `repos`. */
  const load = singleFlight(async () => {
    loading = true;
    loadingSlow = false;
    if (loadingSlowTimer) clearTimeout(loadingSlowTimer);
    loadingSlowTimer = setTimeout(() => { loadingSlow = true; }, 5000);
    error = "";
    // Browser-side timing for the initial dashboard load. Pair with the
    // daemon's `/api/repos total=…` line — together they tell you
    // whether a slow load is server-side (git fan-out) or client-side
    // (rendering / network).
    const tStart = performance.now();
    let tManifest = 0;
    let tFirstRepo = 0;
    let repoCount = 0;
    try {
      // Kick off /api/repos NDJSON first so its manifest lands and
      // paints skeleton rows before the other fetches resolve. The
      // sibling fetches still run in parallel — we just don't await
      // them inside the stream pump.
      const reposStream = fetchReposNDJSON({
        onManifest: (skel) => {
          tManifest = performance.now() - tStart;
          const filtered = pendingRemoval.size > 0
            ? skel.filter((s) => !pendingRemoval.has(s.id))
            : skel;
          if (repos.length === 0) {
            repos = filtered;
          } else {
            const existingById = new Map(repos.map((r) => [r.id, r]));
            repos = filtered.map((s) => existingById.get(s.id) ?? s);
          }
          loading = false;
        },
        onRepo: (full) => {
          repoCount += 1;
          if (tFirstRepo === 0) tFirstRepo = performance.now() - tStart;
          // If a color save is still in flight for this repo, the
          // daemon's snapshot of `color` is stale (the POST hasn't
          // persisted yet). Preserve the optimistic local value so the
          // UI doesn't flicker back to the old color.
          if (pendingRemoval.has(full.id)) return;
          if (pendingRepoColor.has(full.id)) {
            const pending = pendingRepoColor.get(full.id);
            if (pending === null) delete (full as { color?: string }).color;
            else full.color = pending;
          }
          const idx = repos.findIndex((x) => x.id === full.id);
          if (idx >= 0) {
            const next = repos.slice();
            next[idx] = full;
            repos = next;
          }
        },
      });
      const [e, s, t] = await Promise.all([
        fetch("/api/events"),
        fetch("/api/shells"),
        fetch("/api/session-titles"),
      ]);
      if (!e.ok) throw new Error(`/api/events: ${e.status}`);
      // Wait for the stream to finish before reading sibling responses,
      // but DON'T reassign `repos` from the stream's return value — that
      // array is in completion order, while `repos` is already in
      // canonical workspace order (manifest seeds order, `onRepo` does
      // in-place updates by id). Reassigning would reorder the dashboard
      // on every refresh.
      await reposStream;
      events = await e.json();
      // /api/shells failing is non-fatal — empty list just means no
      // shell entries surface in the worktree picker this cycle.
      if (s.ok) allShells = (await s.json()) as ShellRecord[];
      // Pre-populate `newSessionTitles` for every saved synthetic-source
      // title. Titles for real JSONL sources already flow through
      // /api/repos -> agent.manualTitle, so we only adopt the entries
      // whose key matches a synthetic prefix — keeps the in-memory map
      // tight and avoids confusing two state sources for the same source.
      if (t.ok) {
        const allTitles = (await t.json()) as Record<string, string>;
        const synthetic: Record<string, string> = {};
        for (const [src, title] of Object.entries(allTitles)) {
          if (SYNTHETIC_SOURCE_PREFIXES.some((p) => src.startsWith(p))) {
            synthetic[src] = title;
          }
        }
        // Merge: anything the user just typed locally wins over the
        // server snapshot (they may have an unflushed save in flight).
        newSessionTitles = { ...synthetic, ...newSessionTitles };
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      loadingSlow = false;
      if (loadingSlowTimer) { clearTimeout(loadingSlowTimer); loadingSlowTimer = null; }
      const totalMs = performance.now() - tStart;
      if (totalMs > 200) {
        console.log(
          `[load] slow: ${totalMs.toFixed(0)}ms ` +
          `(manifest=${tManifest.toFixed(0)}ms firstRepo=${tFirstRepo.toFixed(0)}ms repos=${repoCount})`
        );
      }
    }
  });

  /** Scroll to the bottom of the page so the just-added repo (which
   *  appends to the end of the list) AND the footer CTAs below it are
   *  in view. `load()` returns when its NDJSON stream finishes, but
   *  Svelte still has to render the new row and the daemon may stream
   *  one more enrichment frame after. The 150ms delay lets all of
   *  that settle before we measure `scrollHeight`. */
  async function scrollToNewRepo() {
    await tick();
    setTimeout(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "smooth",
      });
    }, 150);
  }

  let addFolderBusy = false;

  async function pickAndAdd() {
    error = "";
    addFolderBusy = true;
    try {
      const pick = await fetch("/api/pick-folder", { method: "POST" });
      if (pick.status === 204) return;
      if (!pick.ok) {
        const body = await pick.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${pick.status}`);
      }
      const { path } = (await pick.json()) as { path: string };
      const add = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!add.ok) {
        const body = await add.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${add.status}`);
      }
      newlyAddedRepoPaths.add(path);
      await load();
      await scrollToNewRepo();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      addFolderBusy = false;
    }
  }

  /** Suggestion returned by /api/sessions/folder-suggestions — a folder
   *  the user might want to import as a repo, derived from cwds the
   *  agents (Claude, Codex, Copilot, Ollama) have been observed in.
   *  Sorted newest-first by the daemon; already-registered repos +
   *  their worktrees are filtered out server-side. */
  interface FolderSuggestion {
    path: string;
    name: string;
    repoUrl?: string;
    sessionCount: number;
    lastActive: string;
    agents: string[];
    exists: boolean;
  }

  /** "Import from sessions" popover state. Anchored from the trigger
   *  button (one of two CTAs depending on whether the dashboard is in
   *  the empty-onboarding view or the populated-with-footer view).
   *  Outside clicks close it via `handleDocClick`, keyed off the
   *  `.import-sessions-anchor` ancestor. */
  let importSessionsOpen = false;
  let importSuggestions: FolderSuggestion[] = [];
  let importLoading = false;
  let importError = "";
  let importQuery = "";
  $: importFiltered = (() => {
    const q = importQuery.trim().toLowerCase();
    if (!q) return importSuggestions;
    return importSuggestions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q) ||
        (s.repoUrl && s.repoUrl.toLowerCase().includes(q)) ||
        s.agents.some((a) => a.toLowerCase().includes(q)),
    );
  })();
  /** Paths currently being added — prevents double-clicks from spamming
   *  the daemon and lets the row render a spinner while the request is
   *  in flight. */
  let importAdding = new Set<string>();
  /** When the trigger button sits in the lower half of the viewport,
   *  flip the popover above the button so the dropdown doesn't extend
   *  past the bottom of the screen. Decided once on each open, from
   *  the click event's currentTarget — works equally for the empty-
   *  state CTA (top of screen) and the footer CTA (bottom of long
   *  list). */
  let importFlipUp = false;

  async function openImportSessions() {
    importSessionsOpen = true;
    if (importLoading) return;
    importLoading = true;
    importError = "";
    try {
      const r = await fetch("/api/sessions/folder-suggestions");
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      importSuggestions = (await r.json()) as FolderSuggestion[];
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
      importSuggestions = [];
    } finally {
      importLoading = false;
    }
  }

  function toggleImportSessions(e: MouseEvent) {
    if (importSessionsOpen) {
      importSessionsOpen = false;
    } else {
      // Decide flip direction from the click event's button before
      // we render the popover, so the dropdown opens upward if the
      // button is in the lower half of the viewport.
      const btn = e.currentTarget as HTMLElement | null;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        importFlipUp =
          rect.top + rect.height / 2 > window.innerHeight / 2;
      }
      importQuery = "";
      void openImportSessions();
    }
  }

  async function addRepoFromSuggestion(path: string) {
    if (importAdding.has(path)) return;
    importAdding = new Set(importAdding).add(path);
    importError = "";
    try {
      const r = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      // Drop the just-added entry from the suggestions list so the
      // popover reflects the new state without a refetch round-trip,
      // then refresh the dashboard so the new row appears.
      importSuggestions = importSuggestions.filter((s) => s.path !== path);
      newlyAddedRepoPaths.add(path);
      await load();
      // Close the popover when the list is empty — nothing left to do.
      if (importSuggestions.length === 0) importSessionsOpen = false;
      await scrollToNewRepo();
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
    } finally {
      const next = new Set(importAdding);
      next.delete(path);
      importAdding = next;
    }
  }

  /** Human-friendly relative time for a session's `lastActive`. Mirrors
   *  the format used elsewhere in the dashboard so the import popover
   *  reads like the rest of the UI. */
  function formatRelativeTime(iso: string): string {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return "";
    const delta = Date.now() - then;
    const s = Math.round(delta / 1000);
    if (s < 60) return s <= 5 ? "just now" : `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.round(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.round(mo / 12)}y ago`;
  }

  function startRenameRepo(repo: Repo, rowKey: string) {
    editingRowKey = rowKey;
    editingRepoId = repo.id;
    editRepoName = repo.name;
  }
  function cancelRenameRepo() {
    editingRowKey = null;
    editingRepoId = null;
    editRepoName = "";
  }
  async function commitRenameRepo(id: string) {
    const name = editRepoName.trim();
    if (!name) {
      cancelRenameRepo();
      return;
    }
    error = "";
    try {
      const res = await fetch(`/api/repos/${id}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      editingRowKey = null;
      editingRepoId = null;
      editRepoName = "";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Default colour shown in the swatch (and used to seed the picker)
   *  when a repo has no accent set. Read live from --chip-default-bg
   *  on :root so a theme change to that token automatically flows
   *  here — no second source of truth to keep in sync. Falls back to
   *  the historical blue while the DOM is still booting. */
  let defaultChipHex = "#1a3a5a";
  onMount(() => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--chip-default-bg")
      .trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) defaultChipHex = v.toLowerCase();
  });

  /** Pick a readable foreground for a `#rrggbb` chip background. Uses
   *  OKLCH lightness (perceptually uniform) instead of sRGB YIQ luma,
   *  so the flip-point between dark/light text matches what the eye
   *  actually sees — saturated yellows + cyans correctly read as
   *  "light" and get dark text, while mid blues correctly read as
   *  "dark" and get white text. Pipeline: sRGB → linear-sRGB → LMS
   *  (Björn Ottosson's matrix) → cbrt → OKLab L. Threshold 0.62 is
   *  the standard accessibility hinge. */
  function repoChipFg(hex: string): string {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return "#ffffff";
    const v = parseInt(m[1]!, 16);
    const r8 = ((v >> 16) & 0xff) / 255;
    const g8 = ((v >> 8) & 0xff) / 255;
    const b8 = (v & 0xff) / 255;
    const lin = (c: number) =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const r = lin(r8);
    const g = lin(g8);
    const b = lin(b8);
    const lL = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const mL = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const sL = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const L =
      0.2104542553 * Math.cbrt(lL) +
      0.793617785 * Math.cbrt(mL) -
      0.0040720468 * Math.cbrt(sL);
    return L >= 0.6 ? "#1a1a1a" : "#ffffff";
  }

  /** Per-repo "color save in flight" guard. Any SSE-triggered
   *  /api/repos refresh that lands while a POST /color is still in
   *  flight (or before the daemon has persisted + rebroadcast) would
   *  otherwise overwrite the user's just-picked color with the stale
   *  on-disk value. `fetchReposNDJSON.onRepo` checks this set and
   *  preserves the local optimistic color for repos it contains. */
  const pendingRepoColor = new Map<string, string | null>();

  /** Repo IDs whose DELETE is in flight. Stale NDJSON streams (started
   *  before the deletion) would otherwise re-inject the removed repo via
   *  onManifest / onRepo because singleFlight coalesces the post-delete
   *  load() with the pre-delete one. Same guard pattern as pendingRepoColor. */
  const pendingRemoval = new Set<string>();

  /** Push a new accent colour for the given repo to the daemon. The
   *  optimistic local mutation here is just for snappy UI; the SSE
   *  `change → repo_color` broadcast triggers a full /api/repos
   *  refresh which re-syncs whatever the daemon now has on disk. */
  async function setRepoColor(id: string, color: string | null) {
    const repo = repos.find((r) => r.id === id);
    if (repo) {
      if (color === null) delete repo.color;
      else repo.color = color;
      repos = repos;
    }
    pendingRepoColor.set(id, color);
    try {
      const res = await fetch(`/api/repos/${id}/color`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      // Clear the guard only if no newer save has superseded it. If a
      // second setRepoColor for the same id ran while we were awaiting,
      // its entry is the one that should outlive ours — leave it alone.
      if (pendingRepoColor.get(id) === color) pendingRepoColor.delete(id);
    }
  }

  /** Append a user-defined "open in" link to a repo. The daemon
   *  validates the URL and assigns the link id; on success we splice
   *  the returned link into the local repo so the UI updates without
   *  waiting for the SSE-triggered refresh. */
  async function addCustomLink(
    repoId: string,
    input:
      | { url: string; name?: string }
      | { kind: "url"; url: string; name?: string }
      | { kind: "file"; path: string; name?: string }
      | { kind: "folder"; path: string; name?: string }
      | { kind: "command"; cmd: string; cwd?: string; runMode?: string; name?: string },
  ): Promise<boolean> {
    try {
      const res = await fetch(`/api/repos/${repoId}/custom-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { link: CustomLink };
      const repo = repos.find((r) => r.id === repoId);
      if (repo) {
        repo.customLinks = [...(repo.customLinks ?? []), body.link];
        repos = repos;
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** Rewrite the repo's custom-link order to match `orderedIds`.
   *  Optimistic: we splice the local array immediately so animate:flip
   *  in OpenInActions can run its transition without waiting for the
   *  SSE round-trip. The daemon validates the permutation and emits a
   *  `change` broadcast on success. */
  async function reorderCustomLinks(
    repoId: string,
    orderedIds: string[],
  ): Promise<void> {
    const repo = repos.find((r) => r.id === repoId);
    if (repo && repo.customLinks) {
      const byId = new Map(repo.customLinks.map((l) => [l.id, l]));
      const reordered: CustomLink[] = [];
      for (const lid of orderedIds) {
        const link = byId.get(lid);
        if (link) reordered.push(link);
      }
      if (reordered.length === repo.customLinks.length) {
        repo.customLinks = reordered;
        repos = repos;
      }
    }
    try {
      const res = await fetch(`/api/repos/${repoId}/custom-links/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderedIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Edit an existing custom link's URL and/or label. Same optimistic
   *  pattern as add/remove — we splice the updated link into the
   *  local repo immediately so the chip's favicon + label update
   *  without waiting for the SSE round-trip. */
  async function updateCustomLink(
    repoId: string,
    linkId: string,
    input: {
      url?: string;
      path?: string;
      cmd?: string;
      cwd?: string;
      runMode?: string;
      kind?: "url" | "file" | "folder" | "command";
      name?: string;
    },
  ): Promise<boolean> {
    try {
      const res = await fetch(
        `/api/repos/${repoId}/custom-links/${linkId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { link: CustomLink };
      const repo = repos.find((r) => r.id === repoId);
      if (repo && repo.customLinks) {
        repo.customLinks = repo.customLinks.map((l) =>
          l.id === linkId ? body.link : l,
        );
        repos = repos;
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async function removeCustomLink(repoId: string, linkId: string): Promise<void> {
    try {
      const res = await fetch(
        `/api/repos/${repoId}/custom-links/${linkId}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const repo = repos.find((r) => r.id === repoId);
      if (repo && repo.customLinks) {
        repo.customLinks = repo.customLinks.filter((l) => l.id !== linkId);
        repos = repos;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const commandTermSources = new Map<string, { wtPath: string; source: string }>();

  async function handleCommandClick(wtPath: string, link: CustomLink) {
    if (link.kind !== "command") return;
    const cmdLink = link as { cmd: string; cwd?: string; runMode: string; id: string };
    const isRunning = runningCommandIds.has(link.id);

    if (isRunning && cmdLink.runMode === "shell") {
      void fetch("/api/command/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: link.id }),
      });
      return;
    }

    if (cmdLink.runMode === "internal") {
      const prev = commandTermSources.get(link.id);
      if (prev) {
        const existing = openSessionsByWt[prev.wtPath] ?? [];
        const colOpen = existing.some((s) => s.source === prev.source);
        if (colOpen) {
          const termId = prev.source.replace("__attached__:shell:", "");
          let alive = false;
          try {
            const r = await fetch("/api/terminals");
            if (r.ok) {
              const list = (await r.json()) as { id: string; exitedAt?: string }[];
              alive = list.some((t) => t.id === termId && !t.exitedAt);
            }
          } catch {}
          if (alive) {
            scrollNewColIntoView(prev.wtPath, prev.source);
            return;
          }
          const next = existing.filter((s) => s.source !== prev.source);
          openSessionsByWt = { ...openSessionsByWt, [prev.wtPath]: next };
        }
        commandTermSources.delete(link.id);
        if (runningCommandIds.has(link.id)) {
          const nextSet = new Set(runningCommandIds);
          nextSet.delete(link.id);
          runningCommandIds = nextSet;
        }
      }
    }

    const repoId = repos.find((r) =>
      (r.customLinks ?? []).some((l) => l.id === link.id),
    )?.id;

    try {
      const res = await fetch("/api/command/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: link.id, repoId, repoPath: wtPath }),
      });
      const body = await res.json();
      if (!res.ok) {
        addToast({ kind: "error", message: `Command failed: ${body.error ?? `HTTP ${res.status}`}` });
        return;
      }

      if (body.mode === "internal" && body.termId) {
        const source = `__attached__:shell:${body.termId}`;
        commandTermSources.set(link.id, { wtPath, source });
        runningCommandIds = new Set([...runningCommandIds, link.id]);
        undismissShellSource(source);
        const title = link.name?.trim() || cmdLink.cmd;
        void fetch("/api/session/title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, title }),
        });
        newSessionTitles = { ...newSessionTitles, [source]: title };
        const existing = openSessionsByWt[wtPath] ?? [];
        if (!existing.some((s) => s.source === source)) {
          const entry: OpenSession = { agent: "shell", source };
          const insertAt = visibleLeftInsertIndex(wtPath, existing);
          const next = [...existing];
          next.splice(insertAt, 0, entry);
          openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };
          scrollNewColIntoView(wtPath, source);
        }
      } else if (body.mode === "shell") {
        void refreshRunningCommands();
      }
    } catch (e) {
      addToast({ kind: "error", message: `Command failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function removeRepo(id: string) {
    error = "";
    pendingRemoval.add(id);
    repos = repos.filter((r) => r.id !== id);
    try {
      const res = await fetch(`/api/repos/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      pendingRemoval.delete(id);
    }
  }

  /** Remove a worktree (the directory + git's per-worktree state slot).
   *  Defaults to refusing on dirty state — the daemon returns
   *  {dirty: true} in that case so we can offer a forced retry behind
   *  an extra confirm. Branch itself is never deleted; just the
   *  on-disk working tree. */
  async function removeWorktreeInRow(repoId: string, wt: { path: string; branch: string }) {
    error = "";
    if (!confirm(`Remove worktree on branch \`${wt.branch}\`?\n\n${wt.path}\n\nThe directory will be deleted. The branch ref is kept and can be checked out again later.`)) {
      return;
    }
    async function call(force: boolean) {
      const res = await fetch(`/api/repos/${repoId}/worktrees`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: wt.path, force }),
      });
      if (res.ok) return { ok: true as const };
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        dirty?: boolean;
      };
      return { ok: false as const, ...body };
    }
    try {
      let result = await call(false);
      if (!result.ok && result.dirty) {
        if (
          !confirm(
            `${result.error}\n\nDiscard uncommitted/untracked changes and remove anyway?`,
          )
        ) {
          return;
        }
        result = await call(true);
      }
      if (!result.ok) throw new Error(result.error ?? "remove failed");
      // Drop any session columns / terminal state pointed at this worktree
      // from local state so the UI doesn't try to resume into a path that
      // no longer exists. (The reactive watcher persists this back to
      // storage; we don't need to call .save directly.)
      const next = { ...openSessionsByWt };
      delete next[wt.path];
      openSessionsByWt = next;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Cmd+Z / Cmd+Shift+Z target lookup. Pulls a fresh `/api/events`
   *  snapshot before picking, so a Ctrl+Z pressed in the gap between
   *  a POST/DELETE response and the SSE-triggered refresh still hits
   *  the latest event instead of an older sibling. */
  async function runWorkspaceUndoRedo(direction: "undo" | "redo"): Promise<void> {
    let liveEvents: Event[];
    try {
      const res = await fetch("/api/events");
      if (!res.ok) return;
      liveEvents = (await res.json()) as Event[];
    } catch {
      liveEvents = events;
    }
    const target = direction === "redo"
      ? liveEvents.find((ev) => ev.reversible && ev.undone)
      : liveEvents.find((ev) => ev.reversible && !ev.undone);
    if (!target) return;
    await toggleEvent(target.id, direction);
  }

  async function toggleEvent(id: string, toggle: "undo" | "redo") {
    error = "";
    try {
      const res = await fetch(`/api/events/${id}/${toggle}`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Fast path: refresh just the events array (the "Recently
      // deleted" filter + Undo tray both read from it). Then kick
      // the full `load()` for repos/shells/titles in the
      // background — no need to await it before returning to the
      // caller, the SSE handler does the same thing redundantly.
      await refreshEvents();
      void load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Restore a deleted note from a `remove_note` event and fly it
   *  back into its pin slot. Two cooperating moves: this function
   *  prepares App-level state (un-hide the destination row, capture
   *  the trigger button's rect), then hands off to the layer's
   *  `flyRestoreNote` so the same staging→pinned animation that
   *  powers `+ note` / `+ link` plays in reverse-of-delete. The
   *  origin rect is the Undo button itself, so the user's eye
   *  follows the chip from the popover row down to its pin. */
  async function undoNoteDelete(ev: Event, triggerEl: HTMLElement): Promise<void> {
    const note = ev.inverse?.note as
      | { id?: string; anchors?: string[] }
      | undefined;
    const noteId = note?.id;
    const anchor = note?.anchors?.[0];
    if (anchor) {
      const wtPath = anchor.startsWith("worktree:")
        ? anchor.slice("worktree:".length)
        : null;
      const repoPath = anchor.startsWith("repo:")
        ? anchor.slice("repo:".length)
        : null;
      for (const r of rows) {
        const matches = wtPath
          ? r.wt?.path === wtPath
          : repoPath
            ? !r.wt && r.repo.path === repoPath
            : false;
        if (!matches) continue;
        if (notesHiddenByRow[r.key]) {
          notesHiddenByRow = { ...notesHiddenByRow, [r.key]: false };
        }
        if (zenRowKey === r.key && !notesShownInZen) {
          notesShownInZen = true;
        }
        break;
      }
    }
    // Snapshot the trigger's rect *before* the await — the popover
    // may close (or reflow) by the time toggleEvent + the SSE
    // refetch resolve, at which point the live element's rect would
    // be wrong or zero. Then register the fly-in intent *before*
    // toggleEvent so the layer's refresh (driven by the same SSE
    // round-trip we're about to kick off) can stage the note at
    // this rect in the first render pass — otherwise the note
    // renders at its pin slot, the await chain unblocks 1-2s later,
    // and the fly teleports back to origin before animating.
    const originRect = triggerEl.getBoundingClientRect();
    if (noteId) {
      flyRestoreNote({ id: noteId, originRect });
    }
    await toggleEvent(ev.id, "undo");
  }

  /** Apps that count as a "git client" — when the user clicks one,
   *  remember it as their preferred client so commit-link chips
   *  reuse it. Today this is just Fork (the single dedicated git
   *  GUI in OpenInActions); SourceTree / Tower / GitKraken slot in
   *  here when they're added, no commit-chip code changes needed. */
  const GIT_CLIENT_APPS = new Set(["fork"]);
  const GIT_CLIENT_PREF_KEY = "supergit:preferred-git-client";

  async function openIn(path: string, app: string) {
    error = "";
    // Side-effect: remember the user's last git-client choice. The
    // commit-link chip's openTarget reads the same key.
    if (GIT_CLIENT_APPS.has(app)) {
      try {
        localStorage.setItem(GIT_CLIENT_PREF_KEY, app);
      } catch {
        // Quota / private mode — non-essential, ignore.
      }
    }
    try {
      const res = await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, app }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function fileManagerLabel(): string {
    if (typeof navigator === "undefined") return "Files";
    const ua = navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(ua)) return "Finder";
    if (/Win/.test(ua)) return "Explorer";
    return "Files";
  }

  /** Pair of `fileManagerLabel`: pick the matching icon-registry key
   *  so the button shows the Finder face on macOS, the Explorer folder
   *  on Windows, and the generic folder elsewhere. */
  function fileManagerIcon(): string {
    if (typeof navigator === "undefined") return "files";
    const ua = navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(ua)) return "finder";
    if (/Win/.test(ua)) return "explorer";
    return "files";
  }

  const PROVIDER_LABELS: Record<string, string> = {
    github: "GitHub",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    azure: "Azure",
    codeberg: "Codeberg",
    sourcehut: "sourcehut",
    gitea: "Gitea",
  };

  /** Button label for a remote: provider name when known, else the host.
   *  Suffixes the remote name when it's not the default `origin` so users
   *  with multiple remotes can tell `origin` from `upstream` at a glance. */
  function remoteButtonLabel(remote: RemoteRef): string {
    const base =
      (remote.provider ? PROVIDER_LABELS[remote.provider] : null) ??
      remote.host ??
      remote.name;
    return remote.name === "origin" ? base : `${base} (${remote.name})`;
  }

  function openRemote(remote: RemoteRef) {
    if (!remote.webUrl) return;
    openUrl(remote.webUrl);
  }

  /** Toggle the persisted "is the source-control foldout open" flag for
   *  a worktree. Loading the actual diffs + commits is the
   *  SourceControlPane's job — it reacts to the `expanded` prop. */
  function toggleCommits(wtPath: string) {
    error = "";
    commitsExpanded = { ...commitsExpanded, [wtPath]: !commitsExpanded[wtPath] };
    persistExpanded();
  }

  async function loadEditors() {
    try {
      const res = await fetch("/api/editors");
      if (!res.ok) return;
      editors = await res.json();
    } catch {
      // ignore
    }
  }

  async function refreshRunningCommands(): Promise<void> {
    try {
      const res = await fetch("/api/commands/running");
      if (!res.ok) return;
      const body = (await res.json()) as { running: { linkId: string }[] };
      runningCommandIds = new Set(body.running.map((r) => r.linkId));
    } catch {}
  }

  async function refreshCommandUrls(): Promise<void> {
    try {
      const res = await fetch("/api/commands/urls");
      if (!res.ok) return;
      const body = (await res.json()) as { urls: Record<string, string[]> };
      commandUrls = body.urls;
    } catch {}
  }

  function subscribeToStream(): () => void {
    const es = new EventSource("/api/stream");
    es.addEventListener("change", (rawEvt: MessageEvent) => {
      // Fire the cheap events-only refetch first so the per-row
      // notes-list popover ("Recently deleted" + Undo) and the Undo
      // tray pick up the new event within ~one network round-trip.
      // `load()` bundles `/api/repos` (slow on big workspaces) into
      // the same Promise.all that reassigns `events`, which is what
      // made the popover lag 1-2s behind a delete/undo.
      void refreshEvents();
      // Always refresh /api/repos so worktree-row counters (unstaged /
      // staged / untracked) reflect the change.
      void load();

      // Daemon-side FS-change broadcast: `{ kind: "fs_change", path }`.
      // SourceControlPane owns the diff cache per row; we just bump the
      // worktree's fsChangeKey counter so it reacts and refetches.
      const data = rawEvt?.data;
      if (typeof data !== "string") return;
      let payload: { kind?: string; path?: string };
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      if (
        payload.kind === "note_create" ||
        payload.kind === "note_update" ||
        payload.kind === "note_delete"
      ) {
        notesChangeKey++;
        return;
      }
      // Undo / redo toggles re-broadcast as `{ kind: "undo"|"redo",
      // eventId }`. We don't know from the payload whether the
      // underlying event was a note operation, so just bump the
      // change key on every toggle — re-fetching /api/notes is cheap
      // and avoids the "undo works after reload but UI doesn't
      // update" bug where a restored note stayed invisible until
      // the next page load.
      if (payload.kind === "undo" || payload.kind === "redo") {
        notesChangeKey++;
        return;
      }
      if (payload.kind === "session_invite_received") {
        // Persistent toast — stays until the user clicks the body
        // (which opens the accept/decline dialog) or the × close button.
        const offerId = (payload as { offerId?: unknown }).offerId;
        if (typeof offerId === "string") {
          addToast({
            kind: "invite",
            title: "Session invite",
            message: "click to review",
            onClick: () => openInvite(offerId),
            persist: true,
          });
        }
        return;
      }
      if (payload.kind === "message_received") {
        // Refresh the inbox snapshot, then surface a toast unless the
        // sender is currently muted. The toast is auto-dismiss so it
        // doesn't pile up; the badge on the Inbox pill is the
        // persistent surface.
        const muted = (payload as { muted?: unknown }).muted === true;
        const from = (payload as { from?: { label?: unknown } }).from;
        const label =
          from && typeof from.label === "string" ? from.label : "a peer";
        void refreshMessages();
        if (!muted) {
          addToast({
            kind: "info",
            title: `Message from ${label}`,
            message: "click the Inbox pill to read",
          });
        }
        return;
      }
      if (payload.kind === "message_mute" || payload.kind === "message_unmute" || payload.kind === "message_deleted") {
        void refreshMessages();
        return;
      }
      if (payload.kind === "command_start" || payload.kind === "command_exit") {
        void refreshRunningCommands();
        return;
      }
      if (payload.kind === "command_url") {
        const { linkId, urls } = payload as { linkId?: string; urls?: string[] };
        if (linkId && urls) {
          commandUrls = { ...commandUrls, [linkId]: urls };
        }
        return;
      }
      if (payload.kind === "session_copied" || payload.kind === "session_imported") {
        void load();
        return;
      }
      if (payload.kind !== "fs_change" || typeof payload.path !== "string") return;
      const wtPath = payload.path;
      fsChangeKey = { ...fsChangeKey, [wtPath]: (fsChangeKey[wtPath] ?? 0) + 1 };
      // Refresh the tooltip cache in place if we have data for this
      // worktree. Without this the row badge updates (load() refetches
      // /api/repos) but the tooltip body keeps showing the file list
      // from whenever the user first hovered.
      if (wtSummaryByPath[wtPath] && wtSummaryByPath[wtPath] !== "loading") {
        void loadWtSummary(wtPath, { force: true });
      }
    });
    es.addEventListener("activity", (rawEvt: MessageEvent) => {
      try {
        const ev = JSON.parse(rawEvt.data) as ActivityEvent;
        const existing = activityByCwd[ev.cwd] ?? [];
        const next = [ev, ...existing].slice(0, MAX_ACTIVITY);
        activityByCwd = { ...activityByCwd, [ev.cwd]: next };
        // Stamp the real agent-side session id onto any matching
        // `__new__:` column so a subsequent reload spawns
        // `claude --resume <sid>` (resp. `codex resume <sid>`) instead
        // of bare `claude`. No-op when the column is already stamped or
        // the cwd has no transient column for this agent.
        const { byWt: stamped, stampedSource } =
          stampDiscoveredSessionIdWithDetail(openSessionsByWt, ev);
        if (stamped !== openSessionsByWt) openSessionsByWt = stamped;
        // Once stamped AND we have a real JSONL source, promote the
        // column from `__new__:` to the real source so it renders as
        // SessionView. Carry the daemon termId so SessionView
        // reattaches to the live PTY via attachTermId.
        if (stampedSource && ev.source) {
          const realSource = ev.source!;
          if (editingTitleSources.has(stampedSource)) {
            deferredPromotions.push({ stampedSource, realSource, cwd: ev.cwd });
          } else {
            executePromotion(stampedSource, realSource, ev.cwd);
          }
        }
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener("error", (rawEvt: MessageEvent) => {
      // Custom "error" event from the daemon (a recorded ErrorEntry).
      // EventSource also fires `error` for transport errors but those
      // arrive as plain Events without a `data` field, so the try/parse
      // guards us either way.
      const data = (rawEvt as MessageEvent).data;
      if (typeof data !== "string") return;
      try {
        const entry = JSON.parse(data) as FrontendErrorEntry;
        if (entry?.id && entry?.message) pushError(entry);
      } catch {
        // ignore malformed
      }
    });
    es.addEventListener("error_clear", () => {
      errorEntries = [];
      errorExpanded = {};
    });
    es.onopen = () => {
      streamConnected = true;
      // After a daemon restart (bun --watch, crash, prod upgrade) the
      // FS watchers were torn down and any git changes during the gap
      // were missed. Re-fetch everything on reconnect so the UI always
      // catches up to reality.
      void load();
    };
    es.onerror = () => {
      streamConnected = false;
    };
    return () => es.close();
  }

  function eventLabel(ev: Event): string {
    if (ev.type === "add_repo") {
      const inv = ev.inverse as
        | { repo?: { name?: string; path?: string } }
        | undefined;
      const name =
        inv?.repo?.name ??
        (ev.payload?.path as string | undefined)
          ?.split("/")
          .filter(Boolean)
          .pop();
      return `Added ${name ?? "(unknown)"}`;
    }
    if (ev.type === "remove_repo") {
      const inv = ev.inverse as
        | { repo?: { name?: string; path?: string } }
        | undefined;
      const name = inv?.repo?.name ?? inv?.repo?.path;
      return `Removed ${name ?? "(unknown)"}`;
    }
    if (ev.type === "rename_repo") {
      const p = ev.payload as { newName?: string };
      const inv = ev.inverse as { oldName?: string };
      return `Renamed ${inv?.oldName ?? "?"} → ${p?.newName ?? "?"}`;
    }
    if (ev.type === "create_note" || ev.type === "remove_note") {
      const inv = ev.inverse as
        | { note?: { body?: string; anchors?: string[] } }
        | undefined;
      const excerpt = noteExcerpt(inv?.note?.body);
      const where = anchorLabel(inv?.note?.anchors?.[0]);
      const verb = ev.type === "create_note" ? "Created note" : "Deleted note";
      const head = excerpt ? `${verb} “${excerpt}”` : verb;
      return where ? `${head} · ${where}` : head;
    }
    return ev.type;
  }

  /** Type → glyph mapping for the per-row notes-list popover. Mirrors
   *  the same monochrome unicode set StickyNote uses for the link
   *  chip so the two surfaces stay visually consistent. */
  function targetGlyph(type: string | undefined): string {
    switch (type) {
      case "url":
        return "↗";
      case "commit":
        return "◆";
      case "session":
        return "▶";
      case "file":
        return "▤";
      default:
        return "";
    }
  }

  /** Display info for the per-row notes-list popover. Returns `text`
   *  empty when the row has nothing meaningful to show — link kind
   *  with no usable target *and* no body — so the caller can drop
   *  the row entirely instead of rendering a confusing "(empty)". */
  function notesListDisplay(n: {
    body: string;
    kind?: "note" | "link";
    target?: {
      type?: string;
      value?: string;
      label?: string;
      agent?: string;
      provider?: string;
    };
  }): {
    kind: "note" | "link";
    text: string;
    title: string;
    agent: string;
    provider: string;
    glyph: string;
  } {
    const kind = n.kind === "link" ? "link" : "note";
    const excerpt = noteExcerpt(n.body);
    if (kind === "link") {
      const t = n.target ?? {};
      const text = (excerpt || t.label || t.value || "").trim();
      const title = [t.label, t.value, n.body].filter((s) => !!s).join("\n");
      return {
        kind,
        text,
        title,
        agent: t.agent ?? "",
        provider: t.provider ?? "",
        glyph: targetGlyph(t.type),
      };
    }
    return { kind, text: excerpt, title: n.body, agent: "", provider: "", glyph: "" };
  }

  /** First non-empty line of a note's body, trimmed to a length that
   *  fits comfortably inside the events popover's row. Falls back to
   *  empty string so the caller can decide between "Removed note" and
   *  "Removed note "blah"". */
  function noteExcerpt(body: string | undefined): string {
    if (!body) return "";
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    const trimmed = firstLine.trim();
    if (trimmed.length <= 40) return trimmed;
    return trimmed.slice(0, 39) + "…";
  }

  /** Pretty-print an anchor string for the events list. Maps a
   *  `worktree:<path>` anchor back to `<repo>/<branch>` by looking up
   *  the current `repos` snapshot. Falls back to the basename of the
   *  raw path when the repo's been removed since the event was logged
   *  (events are historical; repos may have changed). */
  function anchorLabel(anchor: string | undefined): string {
    if (!anchor) return "";
    if (anchor.startsWith("worktree:")) {
      const path = anchor.slice("worktree:".length);
      for (const r of repos) {
        const wt = r.worktrees?.find((w) => w.path === path);
        if (wt) return `${r.name ?? "?"} · ${wt.branch}`;
      }
      return path.split("/").filter(Boolean).pop() ?? path;
    }
    if (anchor.startsWith("repo:")) {
      const path = anchor.slice("repo:".length);
      const r = repos.find((r) => r.path === path);
      if (r) return r.name ?? path;
      return path.split("/").filter(Boolean).pop() ?? path;
    }
    if (anchor.startsWith("commit:")) {
      return `commit ${anchor.slice("commit:".length).slice(0, 8)}`;
    }
    return anchor;
  }

  /** Notes whose first usable anchor doesn't resolve to any
   *  currently-registered repo / worktree. These are the rows that
   *  show up in the orphan-notes tray so the user can re-anchor or
   *  delete them. */
  $: orphanNotes = $notesAll.filter((n) => {
    const a = n.anchors[0];
    if (!a) return true;
    if (a.startsWith("worktree:")) {
      const path = a.slice("worktree:".length);
      return !repos.some((r) =>
        r.worktrees?.some((w) => w.path === path),
      );
    }
    if (a.startsWith("repo:")) {
      const path = a.slice("repo:".length);
      return !repos.some((r) => r.path === path);
    }
    return false;
  });

  async function reassignOrphan(noteId: string, anchor: string): Promise<void> {
    const note = $notesAll.find((n) => n.id === noteId);
    if (!note) return;
    // Keep auxiliary anchors (commit:..., session:...) when rewriting
    // the primary placement.
    const others = note.anchors.filter(
      (a) => !a.startsWith("worktree:") && !a.startsWith("repo:"),
    );
    const nextAnchors = [anchor, ...others];
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anchors: nextAnchors }),
      });
      if (!res.ok) return;
      orphanReanchorFor = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function deleteOrphan(noteId: string): Promise<void> {
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}`, {
        method: "DELETE",
      });
      if (!res.ok) return;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function relTime(iso: string): string {
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (Number.isNaN(d)) return "";
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  // BLINK_AHEAD_MINUTES + aheadAged() live in ./ahead-age (imported
  // above) so the threshold math is unit-testable without standing up
  // the component.

  function aheadTooltip(b: BranchStatus): string {
    const count = b.ahead;
    const noun = count === 1 ? "commit" : "commits";
    const base = `${count} ${noun} to push → ${b.upstream}`;
    if (!b.aheadOldestTime) return base;
    return `${base} · oldest ${relTime(b.aheadOldestTime)}`;
  }

  /** Per-worktree fetched detail for the row-status / ↑N hover
   *  tooltips. Populated lazily on first hover via /api/wt-summary.
   *  Sentinel `"loading"` is set synchronously when the request goes
   *  out so a second hover during the round-trip doesn't re-fire. */
  interface WtCommit {
    sha: string;
    subject: string;
    /** Author name (`%an`). Empty string when the daemon couldn't read it
     *  (e.g. legacy-format response from a stale prod build). */
    author?: string;
    /** Relative date string (`%ar`, e.g. "2 hours ago"). Empty string in
     *  the same legacy/error case as `author`. */
    date?: string;
  }
  interface NumstatEntry {
    added: number;
    removed: number;
    binary: boolean;
  }
  interface WtSummary {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    /** Local commits ahead of upstream (↑N tooltip). */
    unpushedCommits: WtCommit[];
    /** Upstream commits ahead of local (↓N tooltip). Capped server-side
     *  at 20; the tooltip further caps display at the first 10. Optional
     *  for backwards-compat with older daemon builds. */
    unfetchedCommits?: WtCommit[];
    /** Per-path added/removed line counts for working-tree files
     *  (unstaged + synthesised untracked). Misses render as no count.
     *  Optional for back-compat with older daemon builds. */
    stats?: Record<string, NumstatEntry>;
    /** Per-path added/removed line counts for staged files (index vs
     *  HEAD). Optional for back-compat. */
    stagedStats?: Record<string, NumstatEntry>;
  }
  /** Hard cap on commits rendered per tooltip. The daemon already caps at
   *  20; this trims further to keep the hover overlay glanceable. */
  const COMMIT_TOOLTIP_LIMIT = 10;
  /** Per-subject character clamp inside the unpushed / unfetched
   *  commit tooltip. Pairs with `.tt-wide`'s `max-width: 96vw` so a
   *  long subject can use whatever horizontal room the viewport has
   *  before the CSS-side ellipsis on `.wt-tt-subject` kicks in.
   *  400 ≈ 2× the prior 200 cap — verbose conventional-commit
   *  subjects round-trip without getting cut short by the JS clamp
   *  before CSS even gets a chance to lay them out. */
  const COMMIT_SUBJECT_MAX = 400;
  function clampSubject(s: string): string {
    if (s.length <= COMMIT_SUBJECT_MAX) return s;
    return s.slice(0, COMMIT_SUBJECT_MAX - 1) + "…";
  }
  let wtSummaryByPath: Record<string, WtSummary | "loading"> = {};

  async function loadWtSummary(
    path: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    // Without `force`, skip if we already have data (or a fetch in
    // flight). With `force`, refetch in place: keep the existing data
    // visible — don't flip to "loading" — so an open tooltip refreshes
    // contents without flickering through an empty state. The
    // fs_change SSE handler is what passes `force`; first-hover paths
    // go through the cached fast path.
    if (!opts.force && wtSummaryByPath[path]) return;
    if (!wtSummaryByPath[path]) {
      wtSummaryByPath = { ...wtSummaryByPath, [path]: "loading" };
    }
    try {
      const qs = new URLSearchParams({ path });
      const res = await fetch(`/api/wt-summary?${qs.toString()}`);
      if (!res.ok) {
        // Drop the "loading" sentinel so the next hover retries. Don't
        // wipe real cached data on a transient failure — better to
        // show slightly-stale numbers than nothing.
        if (wtSummaryByPath[path] === "loading") {
          const next = { ...wtSummaryByPath };
          delete next[path];
          wtSummaryByPath = next;
        }
        return;
      }
      const data = (await res.json()) as WtSummary;
      wtSummaryByPath = { ...wtSummaryByPath, [path]: data };
    } catch {
      if (wtSummaryByPath[path] === "loading") {
        const next = { ...wtSummaryByPath };
        delete next[path];
        wtSummaryByPath = next;
      }
    }
  }

  /** Build the multi-line tooltip for a session row in the agents
   *  popover: title → first user prompt → "[… N more messages …]" →
   *  last 3 (oldest-first). Falls back to the simple "last user
   *  message" shape when the daemon hasn't filled the richer fields
   *  yet (e.g. for codex, which doesn't expose them). */
  function sessionTooltip(sess: AgentSession): string {
    const headline = sess.manualTitle ?? sess.title ?? "(no title)";
    const first = sess.firstUserMessage;
    const last = sess.lastUserMessages ?? [];
    const count = sess.userMessageCount ?? 0;
    if (!first && last.length === 0) {
      // Codex / partial data: legacy single-message tooltip.
      return sess.lastUserMessage
        ? `${headline}\n\nMost recent user message:\n${sess.lastUserMessage}`
        : headline;
    }
    // Show first + last 3 without duplicating when they overlap. For
    // count ≤ 4 the first IS one of the "last 3", so we just print the
    // messages in order. For count > 4 we insert a [… N more …]
    // separator between the first and the tail.
    const tailExcludingFirst = first
      ? last.filter((m) => m !== first)
      : last;
    const lines: string[] = [headline];
    if (count <= 4) {
      // Print every captured message once, oldest-first.
      const all = first ? [first, ...tailExcludingFirst] : last;
      for (const m of all) lines.push("", m);
    } else {
      if (first) lines.push("", first);
      const skipped = count - 1 - tailExcludingFirst.length;
      if (skipped > 0) {
        lines.push("", `[… ${skipped} more message${skipped === 1 ? "" : "s"} …]`);
      }
      for (const m of tailExcludingFirst) lines.push("", m);
    }
    return lines.join("\n");
  }

  // Flat list of rendered rows. Each repo contributes ONE row per
  // worktree the user has chosen to show (via the worktrees picker),
  // not one per worktree on disk. A repo with no checked worktrees
  // still appears as a placeholder so the user can find it via its
  // picker. Placeholder also covers the "registered path has no
  // worktrees yet" edge case.
  $: rows = repos.flatMap((repo) => {
    const diskPaths = repo.worktrees.map((w) => w.path);
    const visiblePaths = effectiveVisibleWorktrees(
      repo.id,
      diskPaths,
      visibleWorktreesByRepo,
    );
    if (visiblePaths.length === 0) {
      // Non-git folders only ever have a single synthetic worktree — the
      // folder itself. Hiding it via the picker would leave the user with
      // no row to start a terminal/agent from (and no way to un-hide it
      // since the picker lives on a worktree row). Always render the
      // synthetic so the row stays interactive.
      const synthetic = repo.worktrees.find((w) => w.nonGit);
      if (synthetic) {
        return [{ repo, wt: synthetic, key: `${repo.id}|${synthetic.path}` }];
      }
      return [{ repo, wt: null as Worktree | null, key: `${repo.id}|none` }];
    }
    return visiblePaths.map((path) => {
      const wt = repo.worktrees.find((w) => w.path === path)!;
      return { repo, wt, key: `${repo.id}|${wt.path}` };
    });
  });

  // Only "real" actions in the dropdown; toggle events are hidden.
  $: visibleEvents = events.filter(
    (e) => e.type !== "undo" && e.type !== "redo",
  );

  /** Reactive index of pending (not-yet-undone) `remove_note` events
   *  bucketed by their first anchor. Drives the per-row notes-list
   *  popover's "Recently deleted" section. Computed at script scope
   *  rather than inline `{@const}` inside the popover so Svelte's
   *  dep tracking on `events` is unambiguous — the inline version
   *  was losing reactivity on certain SSE round-trips. */
  $: removeNoteEventsByAnchor = (() => {
    const out: Record<string, Event[]> = {};
    for (const e of events) {
      if (e.type !== "remove_note") continue;
      if (e.undone) continue;
      if (!e.reversible) continue;
      const anchor = (e.inverse?.note?.anchors as string[] | undefined)?.[0];
      if (!anchor) continue;
      (out[anchor] ??= []).push(e);
    }
    return out;
  })();

  /** Map shell records into the same shape as AgentSession so the picker
   *  can iterate one merged list. The `source` is the synthetic
   *  attached/transcript token openSessionsByWt expects, so clicking a
   *  picker row routes through `toggleOpenSessionInWt` unchanged. */
  function shellToSession(sh: ShellRecord): AgentSession {
    return {
      agent: "shell",
      cwd: sh.wt,
      // Age by most recent activity, not spawn time, so a shell the
      // user touched five minutes ago ranks above one they spawned an
      // hour ago and abandoned.
      lastActive: sh.lastCmdTs ?? sh.createdAt,
      source: sh.alive
        ? `__attached__:shell:${sh.termId}`
        : `__transcript__:shell:${sh.termId}`,
      title: sh.currentCwd ?? sh.spawnCwd,
      sessionId: sh.termId,
      // Feed the last command through `lastUserMessage` so it both
      // renders inline on the row and participates in fuzzy search
      // ("which shell did I run `bun test` in?").
      lastUserMessage: sh.lastCmd,
      messageCount: sh.cmdCount,
      manualTitle: sh.manualTitle,
    };
  }

  /** Per worktree: which session sources are currently matched by the
   *  inline strip search, and which matches are *not* yet open as a
   *  column (those become the synthetic "more matches" pseudo-column).
   *  Absent entry / empty query → strip renders without filtering. */
  interface StripFilter {
    matched: Set<string>;
    notOpen: AgentSession[];
  }
  $: stripFilterByWt = ((): Record<string, StripFilter> => {
    const m: Record<string, StripFilter> = {};
    for (const wtPath of Object.keys(stripSearchQuery)) {
      const q = stripSearchQuery[wtPath] ?? "";
      if (!q.trim()) continue;
      const all = pickerSessionsByWt[wtPath] ?? [];
      const ranked = filterSessions(all, q);
      const matched = new Set(ranked.map((s) => s.source));
      const openSet = new Set(
        (openSessionsByWt[wtPath] ?? []).map((o) => o.source),
      );
      const notOpen = ranked.filter((s) => !openSet.has(s.source));
      m[wtPath] = { matched, notOpen };
    }
    return m;
  })();

  /** wt.path → agents + shells merged, sorted by lastActive desc.
   *  Drives the "+N sessions in this worktree" picker. Dead shells with
   *  zero captured commands are hidden — they're empty terminals that
   *  were opened and closed without typing anything, just visual noise.
   *  Alive shells are always kept (user may be mid-type). */
  $: pickerSessionsByWt = ((): Record<string, AgentSession[]> => {
    const m: Record<string, AgentSession[]> = {};
    for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        const merged: AgentSession[] = [...(wt.agents ?? [])];
        for (const sh of allShells) {
          if (sh.wt !== wt.path) continue;
          if (!sh.alive && (sh.cmdCount ?? 0) === 0) continue;
          merged.push(shellToSession(sh));
        }
        merged.sort(
          (a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive),
        );
        m[wt.path] = merged;
      }
    }
    return m;
  })();

  /** Currently-active TUIs per worktree: the subset of
   *  `pickerSessionsByWt` whose source is mounted as a column AND not
   *  a `__transcript__:` read-only view (which has no live PTY).
   *  Drives the agent-badge → "jump to TUI" popover so the user can
   *  hop between multiple running TUIs from a single click. */
  $: activeTuisByWt = ((): Record<string, AgentSession[]> => {
    const m: Record<string, AgentSession[]> = {};
    for (const wtPath of Object.keys(pickerSessionsByWt)) {
      const openSources = new Set(
        (openSessionsByWt[wtPath] ?? [])
          .filter((o) => !o.source.startsWith("__transcript__:"))
          .map((o) => o.source),
      );
      if (openSources.size === 0) {
        m[wtPath] = [];
        continue;
      }
      m[wtPath] = (pickerSessionsByWt[wtPath] ?? []).filter((s) =>
        openSources.has(s.source),
      );
    }
    return m;
  })();

  /** Side-dock entries: one per currently-open session column that
   *  hosts a live PTY (an "active TUI"), with the colors / metadata
   *  SessionDock needs to render the dot + its hover tooltip. Pulls
   *  `working`/`awaiting` from the per-source transient maps so dots
   *  track the live PTY state.
   *
   *  An "active TUI" is a column whose mounted tree contains a live
   *  TerminalView. In practice that's:
   *    - any `__new__:` source (NewSessionCol always renders a fresh
   *      TerminalView while the column exists),
   *    - any `__attached__:shell:<termId>` source (NewSessionCol
   *      reattaches to a still-alive PTY).
   *  Resumed SessionView columns in read-only chat mode are excluded
   *  — those have no PTY. */
  $: dockEntries = ((): Array<{
    source: string;
    wtPath: string;
    rowKey: string;
    repoId: string;
    agent: OpenSession["agent"];
    repoColor?: string;
    repoName: string;
    branch?: string;
    title?: string;
    manualTitle?: string;
    lastUserMessage?: string;
    lastActive?: string;
    /** JSONL path the dock can fetch via `/api/session?source=…` to
     *  show the last few user/assistant messages on hover. Undefined
     *  for shells and for `__new__:` columns that haven't been
     *  stamped with a `resumeSessionId` yet. */
    transcriptSource?: string;
    working: boolean;
    awaiting: boolean;
    /** True once this column's PTY has exited. Drives the smaller
     *  "ended" dot in the side dock. */
    exited: boolean;
    /** ms timestamp of the most recent working→idle transition.
     *  Drives the dock dot's "unread" pulse — set when the AI
     *  just finished a turn the user hasn't focused yet. Cleared
     *  by the dock's 20-min auto-expiry or by App's on:pick
     *  handler when the user opens the session. */
    finishedAt?: number;
  }> => {
    const out: ReturnType<typeof Array> = [] as any;
    for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        const opens = openSessionsByWt[wt.path];
        if (!opens || opens.length === 0) continue;
        const known = pickerSessionsByWt[wt.path] ?? [];
        const bySource = new Map<string, (typeof known)[number]>();
        for (const a of known) bySource.set(a.source, a);
        const rowKey = `${repo.id}|${wt.path}`;
        for (const s of opens) {
          // Live TUI ⇔ the column currently hosts a running PTY:
          //   - any `__new__:` source (NewSessionCol always spawns one),
          //   - any `__attached__:shell:<termId>` source (reattach to
          //     a still-alive shell PTY),
          //   - a resumed SessionView in terminal mode (`s.mode ===
          //     "terminal"` is persisted by SessionView's onModeChange).
          // …but if the PTY has exited (transientExited), the column
          // is no longer live even though its source still looks
          // like a TUI source. Every other open session (read-mode
          // chat columns) is non-live and gets the small dot.
          const isTuiSource =
            s.source.startsWith("__new__:") ||
            s.source.startsWith("__attached__:") ||
            s.mode === "terminal";
          const isLiveTui = isTuiSource && !transientExited[s.source];
          // Utility panels (file browser, git history) are browsing
          // views, not sessions — skip them in the activity dock.
          // Agent and shell sessions appear regardless of mode
          // (terminal or read-only).
          if (
            s.source.startsWith("__files__:") ||
            s.source.startsWith("__history__:")
          ) continue;
          // Same lookup precedence as the NewSessionCol render: once a
          // sid is stamped onto a `__new__:` column, prefer the matched
          // real-source agent's metadata so the dock shows the title
          // bound to the live conversation rather than whatever landed
          // on the disposable synthetic key.
          const realMeta = s.resumeSessionId
            ? known.find(
                (a) =>
                  a.agent === s.agent && a.sessionId === s.resumeSessionId,
              )
            : undefined;
          const meta = realMeta ?? bySource.get(s.source);
          const titleSource = resolveTitleSource(s, known);
          out.push({
            source: s.source,
            wtPath: wt.path,
            rowKey,
            repoId: repo.id,
            agent: s.agent,
            repoColor: repo.color,
            repoName: repo.name ?? repoName(repo),
            branch: wt.branch,
            title: meta?.title,
            manualTitle:
              meta?.manualTitle ??
              newSessionTitles[titleSource] ??
              newSessionTitles[s.source],
            lastUserMessage: meta?.lastUserMessage,
            lastActive: meta?.lastActive,
            recentMessageCount: meta?.recentMessageCount,
            transcriptSource:
              meta?.source && !meta.source.startsWith("__") ? meta.source : undefined,
            // Shells emit output continuously (log tails, dev-server
            // streams, REPLs) — none of that is "thinking", so we
            // never surface a working/awaiting state for them in the
            // dock. The shell dot stays static; its live-PTY state
            // is conveyed by its dedicated terminal-style square
            // (vs. the round agent dot) and the `exited` shrink.
            working:
              s.agent === "shell" ? false : !!transientWorking[s.source],
            awaiting:
              s.agent === "shell" ? false : !!transientAwaiting[s.source],
            // "Small dot" mode covers everything that isn't a live
            // TUI right now: PTYs that exited, plus read-mode chat
            // columns (SessionView in mode !== "terminal").
            exited: !isLiveTui,
            finishedAt: transientFinishedAt[s.source],
          });
        }
      }
    }
    // No sort — the iteration order (repos × worktrees × open
    // sessions) already mirrors the dashboard's vertical layout and
    // the user's manual session ordering. Reordering within a repo
    // group causes the dock dots to jump around and is disorienting.
    return out as any;
  })();

  /** Browser-tab indicator: animates the favicon (pulsing dot when
   *  waiting, rotating arc when working) and sets the title + meta
   *  description to a per-session breakdown (with names + agents)
   *  that the hover tooltip can show. Picks up changes via the
   *  reactive dependency on `dockEntries`. Exited columns don't
   *  count — they're closed PTYs, not live TUIs. */
  $: updateTabIndicator(
    dockEntries
      .filter((e) => !e.exited)
      .map((e) => ({
        // Priority: awaiting > working > unread (= AI finished a turn
        // the user hasn't focused yet, signalled by `finishedAt`) > idle.
        state: e.awaiting
          ? ("awaiting" as const)
          : e.working
            ? ("working" as const)
            : e.finishedAt !== undefined
              ? ("unread" as const)
              : ("idle" as const),
        name: (e.manualTitle || e.title || e.branch || "").trim(),
        agent: e.agent,
      })),
  );
  function handleDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (actionsOpen && !target?.closest(".actions-anchor")) {
      actionsOpen = false;
    }
    if (eventsOpen && !target?.closest(".events-anchor")) {
      eventsOpen = false;
    }
    if (!target?.closest(".tuis-anchor")) {
      processListRef?.closeIfOpen();
    }
    if (importSessionsOpen && !target?.closest(".import-sessions-anchor")) {
      importSessionsOpen = false;
    }
    // Close any open "new agent" picker the click landed outside of.
    for (const key of Object.keys(newAgentPopoverOpen)) {
      if (!newAgentPopoverOpen[key]) continue;
      const anchor = target?.closest(`[data-new-agent-anchor="${CSS.escape(key)}"]`);
      if (!anchor) {
        newAgentPopoverOpen = { ...newAgentPopoverOpen, [key]: false };
      }
    }
    // Close any open branch picker the click landed outside of.
    for (const key of Object.keys(branchPickerOpen)) {
      if (!branchPickerOpen[key]) continue;
      const anchor = target?.closest(`[data-branch-anchor="${CSS.escape(key)}"]`);
      if (!anchor) {
        branchPickerOpen = { ...branchPickerOpen, [key]: false };
      }
    }
    // Close any open worktree-picker popover the click landed outside of.
    for (const key of Object.keys(wtPickerOpen)) {
      if (!wtPickerOpen[key]) continue;
      const anchor = target?.closest(`[data-wt-picker-anchor="${CSS.escape(key)}"]`);
      if (!anchor) {
        wtPickerOpen = { ...wtPickerOpen, [key]: false };
      }
    }
    // Per-row notes-list popover — close on outside click. Treat
    // clicks on any sticky note (including its delete X button) as
    // "in flow" so the popover stays open while the user is acting on
    // notes; otherwise the 3-second delete grace + SSE round-trip
    // races the popover close and the deleted entry never appears
    // until the user re-opens.
    for (const key of Object.keys(notesListOpen)) {
      if (!notesListOpen[key]) continue;
      const anchor = target?.closest(`[data-notes-list-anchor="${CSS.escape(key)}"]`);
      const inSticky = target?.closest(".sticky");
      if (!anchor && !inSticky) {
        notesListOpen = { ...notesListOpen, [key]: false };
      }
    }
    // Close any open emoji picker the click landed outside of.
    for (const key of Object.keys(emojiPickerOpen)) {
      if (!emojiPickerOpen[key]) continue;
      const anchor = target?.closest(`[data-emoji-picker-anchor="${CSS.escape(key)}"]`);
      if (!anchor) {
        emojiPickerOpen = { ...emojiPickerOpen, [key]: false };
      }
    }
    // Any open agents popovers that the click landed outside of: close them.
    for (const key of Object.keys(agentsPopoverOpen)) {
      if (!agentsPopoverOpen[key]) continue;
      const anchor = target?.closest(`[data-agents-anchor="${CSS.escape(key)}"]`);
      if (!anchor) {
        agentsPopoverOpen = { ...agentsPopoverOpen, [key]: false };
      }
    }
    // Same dance for the badge's active-TUIs jump popover.
    for (const key of Object.keys(activeTuisPopoverOpen)) {
      if (!activeTuisPopoverOpen[key]) continue;
      const anchor = target?.closest(`[data-active-tuis-anchor="${CSS.escape(key)}"]`);
      if (!anchor) {
        activeTuisPopoverOpen = { ...activeTuisPopoverOpen, [key]: false };
      }
    }
  }

  /** Svelte out-transition for `.session-col`. Two-phase:
   *
   *   1. Hold full width, fade opacity 1 → 0 over the first half.
   *   2. Hold opacity 0, shrink width + horizontal margin to 0 over
   *      the second half, then remove.
   *
   *  This only fires when a column actually leaves the each-block,
   *  i.e. when the user clicks **close** (`closeSessionInWt` removes
   *  the entry from `openSessionsByWt`). Clicking **dispose** flips
   *  SessionView's mode back to read without unmounting the column,
   *  so the transition is skipped — exactly what we want.
   *
   *  Width is captured in px from the live element so the column
   *  doesn't snap to a flex-default at the start of phase 2.
   *  `prefers-reduced-motion: reduce` short-circuits to a 0-duration
   *  removal — instant, but still semantically a transition. */
  function closeColumn(node: HTMLElement) {
    const src = node.dataset.sessionSource ?? "";
    if (promotedSources.delete(src)) {
      return { duration: 0 };
    }
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return { duration: 0 };
    }
    const rect = node.getBoundingClientRect();
    const fullWidth = rect.width;
    const cs = getComputedStyle(node);
    const ml = parseFloat(cs.marginLeft) || 0;
    const mr = parseFloat(cs.marginRight) || 0;
    return {
      duration: 360,
      css: (t: number) => {
        // Svelte out-transitions run `t` from 1 (start) -> 0 (gone).
        // Convert to forward progress so the phase boundaries read
        // naturally.
        const p = 1 - t;
        const opacity = p < 0.5 ? 1 - p * 2 : 0;
        const sizeT = p < 0.5 ? 1 : 1 - (p - 0.5) * 2;
        const w = sizeT * fullWidth;
        return `
          opacity: ${opacity};
          width: ${w}px;
          min-width: ${w}px;
          max-width: ${w}px;
          flex: 0 0 ${w}px;
          margin-left: ${sizeT * ml}px;
          margin-right: ${sizeT * mr}px;
          overflow: hidden;
        `;
      },
    };
  }

  // Svelte action: focus + select the node when it's mounted. Used on the
  // rename input so clicking the repo chip drops you straight into typing.
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
    return {};
  }

  /** Visibility-driven per-repo fetch loop.
   *
   *  Daemon also runs a 5-minute auto-fetch for the whole workspace.
   *  This loop layers on top: while a repo's row is visible in the
   *  viewport, the dashboard tells the daemon to re-fetch that repo
   *  every 30 s so ahead/behind stays current for the rows you can
   *  actually see. Repos scrolled off-screen drop out of the loop.
   *
   *  Debounce: when a row first becomes visible we wait 3 s before the
   *  first fetch. That keeps a quick scroll past 20 repos from firing
   *  20 fetches; only the ones the user lingers on count.
   *
   *  Granularity is per-repo (not per-row): a repo with multiple
   *  worktrees has multiple rows, and we want one fetch loop shared
   *  across them. We track the set of visible rows per repo and only
   *  stop the loop when *every* row for that repo goes off-screen. */
  const VISIBLE_FETCH_DEBOUNCE_MS = 3_000;
  const VISIBLE_FETCH_INTERVAL_MS = 30_000;
  type RepoVisibleFetchState = {
    visibleRows: Set<string>;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    intervalTimer: ReturnType<typeof setInterval> | null;
  };
  const repoFetchStates = new Map<string, RepoVisibleFetchState>();
  const rowNodeMeta = new WeakMap<
    Element,
    { repoId: string; rowKey: string }
  >();

  async function fetchVisibleRepo(repoId: string): Promise<void> {
    try {
      await fetch("/api/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repos: [repoId] }),
      });
      // Daemon broadcasts `change { kind: "fetch_complete" }` on
      // success and the SSE handler already triggers load() — no
      // explicit refresh needed here.
    } catch {
      // Network blip; the next 30 s tick (or the daemon's own 5-min
      // cycle) will try again.
    }
  }

  function ensureRepoFetchState(repoId: string): RepoVisibleFetchState {
    let s = repoFetchStates.get(repoId);
    if (!s) {
      s = { visibleRows: new Set(), debounceTimer: null, intervalTimer: null };
      repoFetchStates.set(repoId, s);
    }
    return s;
  }

  function startVisibleFetchLoop(repoId: string): void {
    const s = ensureRepoFetchState(repoId);
    if (s.debounceTimer !== null || s.intervalTimer !== null) return;
    s.debounceTimer = setTimeout(() => {
      s.debounceTimer = null;
      void fetchVisibleRepo(repoId);
      s.intervalTimer = setInterval(
        () => void fetchVisibleRepo(repoId),
        VISIBLE_FETCH_INTERVAL_MS,
      );
    }, VISIBLE_FETCH_DEBOUNCE_MS);
  }

  function stopVisibleFetchLoop(repoId: string): void {
    const s = repoFetchStates.get(repoId);
    if (!s) return;
    if (s.debounceTimer !== null) {
      clearTimeout(s.debounceTimer);
      s.debounceTimer = null;
    }
    if (s.intervalTimer !== null) {
      clearInterval(s.intervalTimer);
      s.intervalTimer = null;
    }
  }

  function noteRowVisible(repoId: string, rowKey: string): void {
    const s = ensureRepoFetchState(repoId);
    const wasEmpty = s.visibleRows.size === 0;
    s.visibleRows.add(rowKey);
    if (wasEmpty) startVisibleFetchLoop(repoId);
  }

  function noteRowHidden(repoId: string, rowKey: string): void {
    const s = repoFetchStates.get(repoId);
    if (!s) return;
    s.visibleRows.delete(rowKey);
    if (s.visibleRows.size === 0) stopVisibleFetchLoop(repoId);
  }

  const rowVisibilityObserver: IntersectionObserver | null =
    typeof window !== "undefined" && "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const meta = rowNodeMeta.get(entry.target);
              if (!meta) continue;
              if (entry.isIntersecting) {
                noteRowVisible(meta.repoId, meta.rowKey);
              } else {
                noteRowHidden(meta.repoId, meta.rowKey);
              }
            }
          },
          // Any sliver visible is enough; users often see ahead/behind
          // peeking at the edge of the viewport while scrolling.
          { threshold: 0 },
        )
      : null;

  /** Svelte action — attach to each row <li>. Registers the node with
   *  the IntersectionObserver and feeds (repoId, rowKey) into the
   *  per-repo visibility tracker. When the bound repo changes (rare —
   *  rows are keyed by `${repo.id}|${wt.path}` so the same DOM node
   *  shouldn't host two different repos, but Svelte's keyed-each isn't
   *  guaranteed across rerenders), we mark the old repo as hidden so
   *  its loop drains cleanly. */
  function rowVisibility(
    node: HTMLElement,
    params: { repoId: string; rowKey: string },
  ) {
    if (!rowVisibilityObserver) return {};
    rowNodeMeta.set(node, params);
    rowVisibilityObserver.observe(node);
    return {
      update(next: { repoId: string; rowKey: string }) {
        const prev = rowNodeMeta.get(node);
        if (
          prev &&
          (prev.repoId !== next.repoId || prev.rowKey !== next.rowKey)
        ) {
          noteRowHidden(prev.repoId, prev.rowKey);
        }
        rowNodeMeta.set(node, next);
      },
      destroy() {
        rowVisibilityObserver?.unobserve(node);
        const prev = rowNodeMeta.get(node);
        if (prev) noteRowHidden(prev.repoId, prev.rowKey);
        rowNodeMeta.delete(node);
      },
    };
  }

  onDestroy(() => {
    rowVisibilityObserver?.disconnect();
    for (const repoId of repoFetchStates.keys()) stopVisibleFetchLoop(repoId);
    repoFetchStates.clear();
  });

  /** URL teammates / other machines on the LAN should hit when they
   *  receive a Share-locally invite from this dashboard. Resolved
   *  from /api/health (localIp + port) on mount. Null while the
   *  request is in flight or when the host has no usable private
   *  IPv4 (laptop offline). Shown right-aligned next to the tagline. */
  let localLanUrl: string | null = null;

  /** Fetch system memory from the daemon (via /api/health) so the TUI
   *  hot/warm thresholds scale to a fraction of total RAM. Static for
   *  the lifetime of the daemon; one fetch on mount is enough. Also
   *  reads localIp + port so the tagline can show the LAN URL. */
  async function loadSystemInfo() {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return;
      const body = (await res.json()) as {
        totalMemBytes?: unknown;
        localIp?: unknown;
        port?: unknown;
      };
      if (typeof body.totalMemBytes === "number" && body.totalMemBytes > 0) {
        systemMemBytes = body.totalMemBytes;
      }
      if (typeof body.localIp === "string" && typeof body.port === "number") {
        localLanUrl = `http://${body.localIp}:${body.port}`;
      }
    } catch {
      // best-effort — we fall back to TUI_*_MEM_FALLBACK byte ceilings.
    }
  }

  onMount(() => {
    restoreExpanded();
    restoreOpenSessions();
    restoreVisibleWorktrees();
    restoreFoldedRepos();
    void loadInstalledAgents();
    void loadEditors();
    void loadDefaultShell();
    void loadSystemInfo();
    void refreshRunningCommands();
    void refreshCommandUrls();
    void restoreLiveShells();
    // Global focus listener — whenever the user puts focus into a
    // session column (typing, clicking into the terminal, etc.)
    // clear that column's "unread" pulse so it doesn't keep
    // blinking while they're already looking at it.
    document.addEventListener("focusin", handleFocusInForUnread);
    void load();
    // Note: SourceControlPane handles its own initial commits-load via
    // a `$: onExpandedChange(expanded, wt.path)` reactive when its
    // `expanded` prop is true on mount, so the parent doesn't (and
    // can't, post-refactor) drive that.
    const unsubErrors = subscribeErrors((list) => {
      errorEntries = list;
    });
    void hydrateFromServer();
    document.addEventListener("click", handleDocClick);
    // Esc exits zen mode. We don't preventDefault — the browser's own
    // fullscreen-exit-on-Esc still works independently because the API
    // fires Esc against fullscreen before document keydown ever sees it.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && zenRowKey && !document.fullscreenElement) {
        const el = document.activeElement as HTMLElement | null;
        const inInput =
          el?.tagName === "INPUT" ||
          el?.tagName === "TEXTAREA" ||
          el?.isContentEditable ||
          !!el?.closest(".xterm");
        if (inInput) return;
        const wtPath = zenRowKey.split("|").slice(1).join("|");
        zenRowKey = null;
        notesShownInZen = false;
        if (wtPath) tick().then(() => jumpToWorktreeRow(wtPath));
      }
      // Cmd/Ctrl+Z → undo the most recent reversible workspace event;
      // Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) → redo. Skipped when an input
      // / textarea / contentEditable is focused so the user's local
      // text-undo still works while editing a sticky note or a form.
      // `e.code === "KeyZ"` instead of `e.key` so non-QWERTY layouts
      // and Caps-Lock states still trigger reliably.
      const mod = e.metaKey || e.ctrlKey;
      const isUndo = mod && !e.altKey && !e.shiftKey && e.code === "KeyZ";
      const isRedo =
        (mod && !e.altKey && e.shiftKey && e.code === "KeyZ") ||
        (mod && !e.altKey && !e.shiftKey && e.code === "KeyY");
      if (!isUndo && !isRedo) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      void runWorkspaceUndoRedo(isRedo ? "redo" : "undo");
    };
    // Window-level capture so this fires before any descendant handlers
    // can stopPropagation the keydown — which used to happen when a
    // popover swallowed Cmd+Z on its way to the document listener.
    window.addEventListener("keydown", handleKey, { capture: true });
    // Cmd+R / Ctrl+R / tab close — surface the browser's confirm dialog
    // when the user has open sessions (claude/codex chats, terminals).
    // No prompt on an empty dashboard so a fresh reload stays silent.
    // The dialog text is browser-controlled; setting `returnValue` is
    // enough to trigger it. Live TUI PTYs survive the reload on the
    // daemon (reattach via /api/shells + activity-tail), but the user
    // still loses in-page scroll position and any unsaved UI state.
    //
    // Dev (`import.meta.env.DEV`): never install the listener. HMR-driven
    // reloads happen constantly while editing CSS / Svelte and the
    // prompt is pure friction there.
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasOpen = Object.values(openSessionsByWt).some(
        (arr) => arr && arr.length > 0,
      );
      if (!hasOpen) return;
      e.preventDefault();
      e.returnValue = "";
    };
    if (!import.meta.env.DEV) {
      window.addEventListener("beforeunload", handleBeforeUnload);
    }
    const unsubStream = subscribeToStream();
    const nowTimer = setInterval(() => { nowMs = Date.now(); }, 3000);
    // Click-on-saved-session-link → bring the session into view.
    // The chip writes a {source, ts} request into the focus store;
    // we locate which worktree it belongs to (via the live
    // repos[].worktrees[].agents data), open the column if it's not
    // already in the strip, scroll it into view, and apply a brief
    // outline-highlight so the user sees where the link landed.
    const unsubFocus = sessionFocusRequest.subscribe((req) => {
      if (!req) return;
      void focusSessionBySource(req.source);
    });
    return () => {
      document.removeEventListener("click", handleDocClick);
      window.removeEventListener("keydown", handleKey, { capture: true });
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unsubStream();
      unsubErrors();
      unsubFocus();
      clearInterval(nowTimer);
    };
  });

  /** Imperative side of "click a session sticky-link → focus the
   *  matching column in its worktree strip". Adds the session to
   *  openSessionsByWt if it isn't already open, then on the next
   *  tick scrolls the column into view and toggles a brief outline
   *  highlight via `.session-col-focused`. */
  async function focusSessionBySource(source: string): Promise<void> {
    const findInRepos = () => {
      let targetWtPath: string | null = null;
      let agentName: OpenSession["agent"] | null = null;
      for (const repo of repos) {
        for (const wt of repo.worktrees ?? []) {
          const found = (wt.agents ?? []).find((a) => a.source === source);
          if (found) {
            targetWtPath = wt.path;
            agentName = found.agent;
            break;
          }
        }
        if (targetWtPath) break;
      }
      return { targetWtPath, agentName };
    };

    let { targetWtPath, agentName } = findInRepos();
    if (!targetWtPath || !agentName) {
      // The session may have just been created (e.g. a freshly
      // imported session from session-share — we get the focus
      // request before `load()` has had time to refetch /api/repos).
      // Force one refresh and try again.
      await load();
      ({ targetWtPath, agentName } = findInRepos());
    }
    if (!targetWtPath || !agentName) {
      // On Windows the JSONL may not be visible to scanClaude
      // immediately after writeFile returns (NTFS journal flush,
      // antivirus scan-on-write). One more attempt after a short
      // delay covers this without a heavy polling loop.
      await new Promise((r) => setTimeout(r, 1500));
      await load();
      ({ targetWtPath, agentName } = findInRepos());
    }
    if (!targetWtPath || !agentName) return;
    const existing = openSessionsByWt[targetWtPath] ?? [];
    if (!existing.some((s) => s.source === source)) {
      openSessionsByWt = {
        ...openSessionsByWt,
        [targetWtPath]: [{ agent: agentName, source }, ...existing],
      };
    }
    // Wait for the {#each} to commit the new column to the DOM, then
    // scroll + flash the outline. Two ticks because scrollIntoView is
    // a sync read that needs the layout pass after the reactivity
    // update.
    await tick();
    await tick();
    const el = document.querySelector(
      `.session-col[data-session-source="${CSS.escape(source)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    el.classList.add("session-col-focused");
    setTimeout(() => el.classList.remove("session-col-focused"), 1800);
  }
</script>

<main class:zen-row={zenRowKey !== null}>
  <header>
    <h1>
      <img src="/needle-logo.svg" alt="" class="brand-mark" />
      supergit
      <span
        class="live"
        class:on={streamConnected}
        title={streamConnected ? "connected (SSE stream live)" : "offline (SSE disconnected)"}
      >
        {streamConnected ? "● connected" : "○ offline"}
      </span>
    </h1>
    <p class="muted tagline-text">multi-repo, multi-agent, worktree-first dashboard</p>
    {#if localLanUrl}
      <p
        class="tagline-lan"
        title="Teammates on your LAN can reach this dashboard at this URL — use it as the peer address when accepting a 'Share session in local network' invite."
      >
        <code>{localLanUrl}</code>
      </p>
    {/if}
  </header>

  <!-- Fixed top-right menubar. Always visible (including while the
       page is scrolled). Anchored containers stay `position: relative`
       so the existing actions-popover (top-right anchored) keeps
       working unchanged. -->
  <nav class="menubar" aria-label="Workspace actions">
    <!-- Per-agent usage buttons live leftmost — one icon-only button
         per detected coding agent (Claude / Codex / Ollama / Copilot),
         each with its own hover tooltip. Claude renders the real
         /api/oauth/usage bars; others fall back to local JSONL
         counts. AgentUsageChip iterates and emits the buttons here. -->
    <AgentUsageChip />

    <ProcessList
      bind:this={processListRef}
      {repos}
      {activityByCwd}
      {systemMemBytes}
      on:focusSession={(e) => void focusSessionBySource(e.detail.source)}
    />

    <!-- Notes tray. Pinned in the menubar (no longer conditional on
         `orphanNotes.length > 0`) so the affordance stays put across
         the initial-load race where notes finish loading before
         repos do — that gap used to make the button flash in and
         out. Count badge only renders when there are orphans to
         action, but the button is always reachable. -->
    <div class="actions-anchor notes-tray-anchor">
      <button
        class="actions-btn"
        class:open={notesTrayOpen}
        on:click={() => (notesTrayOpen = !notesTrayOpen)}
        title={orphanNotes.length > 0
          ? `${orphanNotes.length} note${orphanNotes.length === 1 ? "" : "s"} whose repo/worktree was removed — click to re-anchor or delete`
          : "Notes whose repo/worktree was removed appear here for re-anchoring."}
      >
        Notes
        {#if orphanNotes.length > 0}
          <span class="count">{orphanNotes.length}</span>
        {/if}
      </button>
      {#if notesTrayOpen}
        <Popover variant="actions" extraClass="notes-tray-popover" unclamped>
          <span slot="head">Orphaned notes</span>
          {#if orphanNotes.length === 0}
            <p class="muted small nopad">
              No orphaned notes. When a repo or worktree gets removed,
              any notes anchored there land in this tray so you can
              re-anchor or delete them.
            </p>
          {:else}
            <ul class="orphan-list">
              {#each orphanNotes as n (n.id)}
                <li class="orphan-row">
                  <div class="orphan-summary">
                    <span class="orphan-body" title={n.body}>
                      {noteExcerpt(n.body) || "(empty)"}
                    </span>
                    <span class="orphan-anchor" title={n.anchors.join("\n")}>
                      ⚓ {n.anchors[0] ?? "no anchor"}
                    </span>
                  </div>
                  <div class="orphan-actions">
                    <button
                      class="undo"
                      on:click={() =>
                        (orphanReanchorFor =
                          orphanReanchorFor === n.id ? null : n.id)}
                    >Re-anchor…</button>
                    <button
                      class="undo"
                      on:click={() => void deleteOrphan(n.id)}
                      title="Delete (an Undo toast lets you bring it back)"
                    >Delete</button>
                  </div>
                  {#if orphanReanchorFor === n.id}
                    <AnchorPicker
                      {repos}
                      currentAnchor={n.anchors[0] ?? null}
                      on:pick={(e) =>
                        void reassignOrphan(n.id, e.detail.anchor)}
                      on:cancel={() => (orphanReanchorFor = null)}
                    />
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </Popover>
      {/if}
    </div>

    <MessagesInbox />

    <div class="actions-anchor">
      <button
        class="actions-btn"
        class:open={actionsOpen}
        on:click={() => (actionsOpen = !actionsOpen)}
        title="Reversible workspace actions (undo / redo)"
      >
        Undo
        {#if visibleEvents.length > 0}
          <span class="count">{visibleEvents.length}</span>
        {/if}
      </button>
      {#if actionsOpen}
        <Popover variant="actions" unclamped>
          <span slot="head">Recent actions</span>
          {#if visibleEvents.length === 0}
            <p class="muted small nopad">No actions yet.</p>
          {:else}
            <ul class="events">
              {#each visibleEvents.slice(0, 50) as ev (ev.id)}
                <li class:undone={ev.undone}>
                  <div class="ev-row">
                    <span class="ev-type">{eventLabel(ev)}</span>
                    <span class="muted ev-time">{relTime(ev.timestamp)}</span>
                  </div>
                  <div class="ev-meta">
                    <span class="actor actor-{ev.actor}">{ev.actor}</span>
                    {#if ev.reversible}
                      {#if ev.undone}
                        <button
                          class="undo"
                          on:click={() => toggleEvent(ev.id, "redo")}>Redo</button
                        >
                      {:else}
                        <button
                          class="undo"
                          on:click={() => toggleEvent(ev.id, "undo")}>Undo</button
                        >
                      {/if}
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </Popover>
      {/if}
    </div>

    <div class="actions-anchor events-anchor">
      <button
        class="actions-btn"
        class:open={eventsOpen}
        class:has-errors={errorEntries.length > 0}
        on:click={() => (eventsOpen = !eventsOpen)}
        title="Diagnostics — daemon 5xx, fetch failures, uncaught browser errors"
      >
        Events
        {#if errorEntries.length > 0}
          <span class="count">{errorEntries.length}</span>
        {/if}
      </button>
      {#if eventsOpen}
        <Popover variant="actions" extraClass="events-popover" unclamped>
          <svelte:fragment slot="head">
            Events
            {#if errorEntries.length > 0}
              <button
                class="undo events-clear"
                on:click={clearAllErrors}
                title="Clear the recorded error log"
              >Clear</button>
            {/if}
          </svelte:fragment>
          {#if errorEntries.length === 0}
            <p class="muted small nopad">No errors. 🎉</p>
          {:else}
            <ul class="events err-list">
              {#each errorEntries.slice(0, 50) as e (e.id)}
                <li>
                  <button
                    class="err-row"
                    class:expanded={errorExpanded[e.id]}
                    on:click={() => toggleErrorExpanded(e.id)}
                  >
                    <span class="err-kind err-kind-{e.kind}">{errorKindLabel(e)}</span>
                    <span class="err-msg" title={e.message}>
                      {e.message}
                      {#if e.count && e.count > 1}
                        <span class="err-count" title={`${e.count} occurrences in the coalesce window`}>× {e.count}</span>
                      {/if}
                    </span>
                    <span class="muted ev-time">{relTime(e.timestamp)}</span>
                  </button>
                  {#if errorExpanded[e.id]}
                    <div class="err-detail">
                      <div class="err-meta">
                        <span class="actor actor-{e.source === 'daemon' ? 'supergit' : 'user'}">{e.source}</span>
                        {#if e.method || e.route}
                          <code class="err-route">{e.method ?? ""} {e.route ?? ""}</code>
                        {/if}
                        {#if e.status !== undefined}
                          <span class="err-status">{e.status}</span>
                        {/if}
                      </div>
                      {#if e.stack}
                        <pre class="err-stack">{e.stack}</pre>
                      {/if}
                      {#if e.extra && Object.keys(e.extra).length > 0}
                        <pre class="err-stack">{JSON.stringify(e.extra, null, 2)}</pre>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </Popover>
      {/if}
    </div>

    <button
      class="actions-btn tutorial-btn"
      class:tour-active={tourRunning}
      on:click={restartTutorial}
      title={tourRunning ? "Stop the walkthrough" : "Start the UI walkthrough"}
    ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></button>
  </nav>

  {#if loading && repos.length === 0}
    <div class="loading-screen">
      <div class="loading-inline">
        <LoadingSpinner size="0.85rem" label="Loading" />
        <span>loading…</span>
      </div>
      {#if loadingSlow}
        <p class="loading-slow">daemon is busy — scanning worktrees and agent sessions</p>
      {/if}
    </div>
  {:else if rows.length === 0 || emptyReposDebug}
    <div class="empty-repos">
      <div class="add-folder-actions">
        <button
          class="add-folder-cta"
          on:click={pickAndAdd}
          disabled={addFolderBusy}
          title="Pick a folder to register as a repo"
        >
          {#if addFolderBusy}
            <LoadingSpinner size="0.85rem" />
            <span>Adding…</span>
          {:else}
            <svg
              class="add-folder-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <path d="M12 11v6" />
              <path d="M9 14h6" />
            </svg>
            <span>Add folder</span>
          {/if}
        </button>
        <div class="import-sessions-anchor" class:flip-up={importFlipUp}>
          <button
            class="add-folder-cta"
            on:click|stopPropagation={toggleImportSessions}
            aria-haspopup="menu"
            aria-expanded={importSessionsOpen}
            title="Suggest folders to add based on detected AI agent sessions"
          >
            <svg
              class="add-folder-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            <span>Import from sessions</span>
          </button>
          {#if importSessionsOpen}
            <Popover variant="actions" extraClass="import-sessions-popover">
              <svelte:fragment slot="head">
                <div class="import-search-head">
                  <input
                    type="search"
                    class="import-search-input"
                    bind:value={importQuery}
                    placeholder="Folders from detected sessions"
                    aria-label="Filter folders from detected sessions"
                    use:focusOnMount
                    on:click|stopPropagation
                    on:keydown|stopPropagation
                  />
                  {#if importQuery.trim()}
                    <span class="import-search-count">{importFiltered.length}/{importSuggestions.length}</span>
                  {/if}
                </div>
              </svelte:fragment>
              {#if importLoading}
                <div class="import-empty">
                  <LoadingSpinner size="0.85rem" label="Scanning sessions" />
                  <span>scanning sessions…</span>
                </div>
              {:else if importError}
                <div class="import-empty import-error">{importError}</div>
              {:else if importFiltered.length === 0}
                <div class="import-empty muted">
                  {#if importQuery.trim()}
                    No folders match.
                  {:else}
                    No new folders to suggest — every detected session's cwd is
                    already in the dashboard.
                  {/if}
                </div>
              {:else}
                <ul class="import-list">
                  {#each importFiltered as sug (sug.path)}
                    {@const busy = importAdding.has(sug.path)}
                    <li>
                      <button
                        type="button"
                        class="import-row"
                        class:busy
                        disabled={busy}
                        on:click={() => addRepoFromSuggestion(sug.path)}
                        title={`Add ${sug.path} to the dashboard`}
                      >
                        <span class="import-row-main">
                          {#if busy}
                            <span class="import-row-name"><LoadingSpinner size="0.75rem" /> Importing…</span>
                          {:else}
                            <span class="import-row-name">{sug.name}</span>
                          {/if}
                          <span class="import-row-path muted small">{sug.path}</span>
                          {#if sug.repoUrl}
                            <span class="import-row-url muted small">{sug.repoUrl}</span>
                          {/if}
                        </span>
                        <span class="import-row-meta">
                          <span class="import-row-count">
                            <span class="import-row-agents-icons" aria-hidden="true">
                              {#each sug.agents as agent (agent)}
                                <AgentIcon {agent} size={14} />
                              {/each}
                            </span>
                            <span>
                              {sug.sessionCount} session{sug.sessionCount === 1 ? "" : "s"}
                            </span>
                          </span>
                          <span class="import-row-time muted small">
                            {formatRelativeTime(sug.lastActive)}
                          </span>
                          <span class="import-row-agents-names muted small">
                            {sug.agents.join(", ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </Popover>
          {/if}
        </div>
      </div>
      <p class="add-folder-sub muted small">
        Pick any folder on disk — git repo or not — to start tracking it.
      </p>
    </div>
  {:else}
    <ul class="rows">
      {#each rows as row, rowIdx (row.key)}
        {@const { repo, wt } = row}
        {@const summary = wt ? statusSummary(wt.fileStatus, wtSummaryByPath[wt.path]) : null}
        {@const noteAnchor = wt ? `worktree:${wt.path}` : `repo:${repo.path}`}
        {@const noteCount = $notesCountByAnchor[noteAnchor] ?? 0}
        {@const isFirstOfRepo =
          rowIdx === 0 || rows[rowIdx - 1].repo.id !== repo.id}
        <li
          class="row"
          class:row-folded={rowFolded[row.key]}
          class:row-zen={zenRowKey === row.key}
          class:row-notes-hidden={zenRowKey !== null
            ? zenRowKey !== row.key || !notesShownInZen
            : !!notesHiddenByRow[row.key]}
          data-wt-row={wt ? wt.path : `${repo.id}|none`}
          use:rowVisibility={{ repoId: repo.id, rowKey: row.key }}
        >
          <div class="row-content">
          <div class="row-head">
            <button
              class="chevron fold-toggle"
              class:open={!rowFolded[row.key]}
              title={rowFolded[row.key]
                ? `Expand \`${repo.name}${wt ? ` · ${wt.branch}` : ""}\``
                : `Fold \`${repo.name}${wt ? ` · ${wt.branch}` : ""}\` to a minimal row`}
              aria-label={rowFolded[row.key] ? "Expand row" : "Fold row"}
              on:click|stopPropagation={() => toggleRowFolded(row.key, wt?.path)}
            >
              <span class="arrow">▸</span>
            </button>
            {#if editingRowKey === row.key}
              <input
                class="name-edit"
                use:focusAndSelect
                bind:value={editRepoName}
                on:keydown={(e) => {
                  if (e.key === "Enter") commitRenameRepo(repo.id);
                  if (e.key === "Escape") cancelRenameRepo();
                }}
                on:blur={() => commitRenameRepo(repo.id)}
              />
            {:else}
              <!-- Swatch + chip live inside a flex stack so they read as
                   a single docked element — same idiom as `.agent-add`
                   docked to the agent badges below. The swatch is a
                   native <input type=color> on the LEFT, rounded only
                   on its left side; the chip's left corners are
                   squared by `.repo-chip-stacked` so the two visually
                   fuse. `input` fires continuously while dragging (live
                   chip preview), `change` fires once on commit (when
                   we persist to the daemon). Right-click clears. -->
              <span class="repo-chip-stack">
                <input
                  class="repo-color-swatch"
                  type="color"
                  aria-label="Repo accent color"
                  title={repo.color
                    ? `Repo color (${repo.color}) — right-click to clear`
                    : "Set a repo accent color (right-click to clear)"}
                  value={repo.color ?? defaultChipHex}
                  style={repo.color
                    ? `--swatch-bg: ${repo.color}`
                    : `--swatch-bg: ${defaultChipHex}`}
                  on:input={(e) => {
                    const v = (e.currentTarget as HTMLInputElement).value;
                    repo.color = v;
                    repos = repos;
                  }}
                  on:change={(e) =>
                    setRepoColor(repo.id, (e.currentTarget as HTMLInputElement).value)}
                  on:contextmenu|preventDefault={() => setRepoColor(repo.id, null)}
                />
                <button
                  class="repo-chip repo-chip-stacked"
                  class:repo-chip-colored={!!repo.color}
                  title="Rename repo"
                  style={repo.color
                    ? `--repo-bg: ${repo.color}; --repo-fg: ${repoChipFg(repo.color)}`
                    : ""}
                  on:click={() => startRenameRepo(repo, row.key)}
                >
                  {repo.name}
                  <span class="chip-tail">
                    <span class="pencil">✎</span>
                  </span>
                </button>
              </span>
            {/if}

            {#if wt}
              {#if wt.nonGit}
                <span class="branch muted">folder</span>
              {:else if wt.detached}
                <span class="branch detached">detached @ {wt.head.slice(0, 7)}</span>
              {:else if wt.bare}
                <span class="branch bare">bare</span>
              {:else}
                <span class="branch-anchor" data-branch-anchor={wt.path}>
                  <button
                    class="branch branch-button"
                    title={`Click to switch this worktree to another branch.\nDirty state opens a dialog with Stash / Force / Cancel.`}
                    on:click|stopPropagation={() => {
                      const opening = !branchPickerOpen[wt.path];
                      branchPickerOpen = { ...branchPickerOpen, [wt.path]: opening };
                      if (opening) void loadBranchesFor(repo.id, wt.path);
                    }}
                  ><svg class="branch-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 4-4 6-12 6"/></svg>{wt.branch} <span class="branch-caret" aria-hidden="true">▾</span></button>
                  {#if branchPickerOpen[wt.path]}
                    <Popover variant="agents" extraClass="branch-popover" headClass="branch-popover-head">
                      <svelte:fragment slot="head">
                        <span>Switch branch in {wt.branch}</span>
                        <button
                          class="branch-sort-toggle"
                          title="Toggle branch sort order"
                          on:click|stopPropagation={() => {
                            branchSortMode = branchSortMode === "recency" ? "alpha" : "recency";
                          }}
                        >
                          sort: {branchSortMode === "recency" ? "recency" : "A–Z"} ↻
                        </button>
                      </svelte:fragment>
                      {#if branchesLoading[wt.path]}
                        <p class="muted small nopad">Loading branches…</p>
                      {:else}
                        {@const b = branchesByWt[wt.path]}
                        {#if !b || (b.local.length === 0 && b.remote.length === 0)}
                          <p class="muted small nopad">No branches found.</p>
                        {:else}
                          {@const sortedLocal = sortBranches(b.local, branchSortMode)}
                          {@const sortedRemote = sortBranches(b.remote, branchSortMode)}
                          <ul class="agents-list">
                            {#each sortedLocal as bname (bname)}
                              <li>
                                <button
                                  class="agent-row branch-row"
                                  class:branch-row-current={bname === b.current}
                                  disabled={bname === b.current}
                                  on:click={() => tryCheckout(repo.id, wt.path, bname)}
                                  title={bname === b.current
                                    ? "Currently checked out"
                                    : `Run \`git checkout ${bname}\` here`}
                                >
                                  <span class="branch-tick" aria-hidden="true">
                                    {bname === b.current ? "●" : ""}
                                  </span>
                                  <span class="agent-row-name">{bname}</span>
                                  <span class="agent-title muted">local</span>
                                </button>
                              </li>
                            {/each}
                            {#each sortedRemote as bname (bname)}
                              <li>
                                <button
                                  class="agent-row branch-row"
                                  on:click={() => tryCheckout(repo.id, wt.path, bname)}
                                  title={`Create local tracking branch from \`${bname}\` and check it out`}
                                >
                                  <span class="branch-tick" aria-hidden="true"></span>
                                  <span class="agent-row-name">{bname}</span>
                                  <span class="agent-title muted">remote</span>
                                </button>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      {/if}
                    </Popover>
                  {/if}
                </span>
              {/if}
              {#if wt && badgeAnimDebug}
                <span class="status-badge-debug-row">
                  <StatusBadge ahead={1} behind={0} dirty={0} pulsate={pulsateDebug} />
                  <StatusBadge ahead={0} behind={1} dirty={0} />
                </span>
              {:else if wt && !wt.nonGit}
                {@const fAhead = wt.branchStatus?.ahead ?? 0}
                {@const fBehind = wt.branchStatus?.behind ?? 0}
                {@const fDirty = wt.fileStatus.staged + wt.fileStatus.unstaged + wt.fileStatus.untracked}
                {@const fDirtyWarn = fDirty > 3 || (wt.fileStatus.dirtyLines ?? 0) > 200}
                {#if fAhead > 0}
                  <Tooltip variant="wide" onShow={() => loadWtSummary(wt.path)}>
                    <span slot="trigger" class="status-badge-trigger">
                      <StatusBadge
                        ahead={fAhead}
                        pulsate={wt.branchStatus ? aheadAged(wt.branchStatus) : false}
                        onClick={() => tryPush(repo.id, wt.path)}
                        busy={!!pushBusy[wt.path]}
                        title={`Push ${fAhead} commit${fAhead === 1 ? "" : "s"} to ${wt.branchStatus?.upstream ?? "upstream"}`}
                      />
                    </span>
                    <span slot="content" class="wt-tt-content">
                      <div class="wt-tt-section-head">{aheadTooltip(wt.branchStatus)}</div>
                      {#if wtSummaryByPath[wt.path] === undefined || wtSummaryByPath[wt.path] === "loading"}
                        <span class="muted small">Loading commits…</span>
                      {:else}
                        {@const s = wtSummaryByPath[wt.path]}
                        {#if s !== "loading" && s !== undefined && s.unpushedCommits.length > 0}
                          <div class="wt-tt-commits">
                            {#each s.unpushedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
                              <span class="wt-tt-sha">{c.sha.slice(0, 7)}</span>
                              <span class="wt-tt-author" title={c.author ?? ""}>{c.author ?? ""}</span>
                              <span class="wt-tt-date">{c.date ? relTime(c.date) : ""}</span>
                              <span class="wt-tt-subject" title={c.subject}>{clampSubject(c.subject)}</span>
                            {/each}
                          </div>
                          {#if s.unpushedCommits.length > COMMIT_TOOLTIP_LIMIT}
                            <div class="wt-tt-more">
                              +{s.unpushedCommits.length - COMMIT_TOOLTIP_LIMIT} more
                            </div>
                          {/if}
                        {/if}
                      {/if}
                    </span>
                  </Tooltip>
                {/if}
                {#if fBehind > 0}
                  <Tooltip variant="wide" onShow={() => loadWtSummary(wt.path)}>
                    <span slot="trigger" class="status-badge-trigger">
                      <StatusBadge
                        behind={fBehind}
                        onClick={() => tryPull(repo.id, wt.path)}
                        busy={!!pullBusy[wt.path]}
                        title={`Pull ${fBehind} commit${fBehind === 1 ? "" : "s"} from ${wt.branchStatus?.upstream ?? "upstream"}`}
                      />
                    </span>
                    <span slot="content" class="wt-tt-content">
                      <div class="wt-tt-section-head">
                        {fBehind} commit{fBehind === 1 ? "" : "s"} to pull from {wt.branchStatus?.upstream ?? "upstream"}
                      </div>
                      {#if wtSummaryByPath[wt.path] === undefined || wtSummaryByPath[wt.path] === "loading"}
                        <span class="muted small">Loading commits…</span>
                      {:else}
                        {@const s = wtSummaryByPath[wt.path]}
                        {#if s !== "loading" && s !== undefined && s.unfetchedCommits && s.unfetchedCommits.length > 0}
                          <div class="wt-tt-commits">
                            {#each s.unfetchedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
                              <span class="wt-tt-sha">{c.sha.slice(0, 7)}</span>
                              <span class="wt-tt-author" title={c.author ?? ""}>{c.author ?? ""}</span>
                              <span class="wt-tt-date">{c.date ? relTime(c.date) : ""}</span>
                              <span class="wt-tt-subject" title={c.subject}>{clampSubject(c.subject)}</span>
                            {/each}
                          </div>
                          {#if s.unfetchedCommits.length > COMMIT_TOOLTIP_LIMIT}
                            <div class="wt-tt-more">
                              +{s.unfetchedCommits.length - COMMIT_TOOLTIP_LIMIT} more
                            </div>
                          {/if}
                        {/if}
                      {/if}
                    </span>
                  </Tooltip>
                {/if}
                {#if fDirty > 0}
                  <Tooltip variant="wide" onShow={() => loadWtSummary(wt.path)}>
                    <span slot="trigger" class="status-badge-trigger">
                      <StatusBadge dirty={fDirty} warn={fDirtyWarn} />
                    </span>
                    <span slot="content" class="wt-tt-content">
                      <ChangedFilesTooltipBody summary={wtSummaryByPath[wt.path]} worktreePath={wt.path} />
                    </span>
                  </Tooltip>
                {/if}
                {#if fAhead === 0 && fBehind === 0 && fDirty === 0 && wt.branchStatus?.upstream}
                  <span class="status-badge status-badge-sync" title="In sync with {wt.branchStatus.upstream}">
                    <svg class="sync-check-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5 8.5 6.5 11.5 12.5 5"/></svg>
                  </span>
                {/if}
              {/if}
              {#if wt}
                {@const a = (wt.agents && wt.agents.length > 0) ? wt.agents[0] : null}
                {@const pickerSessions = pickerSessionsByWt[wt.path] ?? wt.agents ?? []}
                {@const activeTuis = activeTuisByWt[wt.path] ?? []}
                <span
                  class="agent-wrap"
                  style={repo.color ? `--repo-bg: ${repo.color}` : ""}
                  data-agents-anchor={wt.path}
                  data-active-tuis-anchor={wt.path}
                  data-new-agent-anchor={wt.path}
                >
                  <button
                    class="agent-add {a ? `agent-${a.agent}` : 'agent-empty'}"
                    title="Start a new session in this worktree"
                    on:click|stopPropagation={() => {
                      newAgentPopoverOpen = {
                        ...newAgentPopoverOpen,
                        [wt.path]: !newAgentPopoverOpen[wt.path],
                      };
                    }}
                  >+</button>
                  {#if newAgentPopoverOpen[wt.path]}
                    <Popover variant="agents" extraClass="new-agent-popover">
                      <svelte:fragment slot="head">Start a new session</svelte:fragment>
                      <ul class="agents-list">
                        {#each installedAgents as ag (ag.name)}
                          <li>
                            {#if ag.name === "ollama"}
                              <button
                                class="agent-row new-agent-row"
                                on:click={() => {
                                  ollamaSubmenuOpen = {
                                    ...ollamaSubmenuOpen,
                                    [wt.path]: !ollamaSubmenuOpen[wt.path],
                                  };
                                  if (ollamaSubmenuOpen[wt.path]) {
                                    void ensureOllamaModelsLoaded();
                                  }
                                }}
                                title={`Pick an Ollama model to spawn \`ollama run <model>\` in ${wt.path}`}
                              >
                                <img class="agent-row-icon" src="/agents/ollama.svg" alt="" />
                                <span class="agent-row-name">Ollama</span>
                                <span class="agent-title muted">
                                  {ollamaSubmenuOpen[wt.path] ? "▾" : "▸"} pick model
                                </span>
                              </button>
                              {#if ollamaSubmenuOpen[wt.path]}
                                <ul class="agents-list ollama-models-list">
                                  {#if ollamaModelsLoading}
                                    <li class="muted ollama-models-info">loading models…</li>
                                  {:else if ollamaModelsError}
                                    <li class="muted ollama-models-info">
                                      couldn't load models ({ollamaModelsError}).
                                      <button
                                        class="link-btn"
                                        on:click={() => void ensureOllamaModelsLoaded(true)}
                                      >retry</button>
                                    </li>
                                  {:else if ollamaModels.length === 0}
                                    <li class="muted ollama-models-info">
                                      no models found. Run <code>ollama pull &lt;model&gt;</code> first.
                                    </li>
                                  {:else}
                                    {#each ollamaModels as m (m.name)}
                                      <li>
                                        <button
                                          class="agent-row new-agent-row ollama-model-row"
                                          on:click={() => {
                                            newAgentPopoverOpen = { ...newAgentPopoverOpen, [wt.path]: false };
                                            ollamaSubmenuOpen = { ...ollamaSubmenuOpen, [wt.path]: false };
                                            unfoldRowIfFolded(row.key);
                                            void openNewOllamaChat(wt.path, m.name);
                                          }}
                                          title={`Open a chat with ${m.name} in ${wt.path} (API-driven, full memory)`}
                                        >
                                          <img class="agent-row-icon" src="/agents/ollama.svg" alt="" />
                                          <span class="agent-row-name">{m.name}</span>
                                          <span class="agent-title muted">
                                            {m.parameterSize ?? ""}
                                          </span>
                                        </button>
                                      </li>
                                    {/each}
                                  {/if}
                                </ul>
                              {/if}
                            {:else}
                              <button
                                class="agent-row new-agent-row"
                                on:click={() => {
                                  newAgentPopoverOpen = { ...newAgentPopoverOpen, [wt.path]: false };
                                  unfoldRowIfFolded(row.key);
                                  openNewAgentSession(wt.path, ag.name as "claude" | "codex");
                                }}
                                title={`Spawn \`${ag.name}\` (no --resume) in ${wt.path}`}
                              >
                                {#if ag.name === "claude"}
                                  <img class="agent-row-icon" src="/agents/claude.svg" alt="" />
                                {:else if ag.name === "codex"}
                                  <img class="agent-row-icon" src="/agents/codex.svg" alt="" />
                                {:else}
                                  <span class="agent-dot agent-shell"></span>
                                {/if}
                                <span class="agent-row-name">
                                  {ag.name === "claude" ? "Claude"
                                    : ag.name === "codex" ? "Codex"
                                    : ag.name}
                                </span>
                                <span class="agent-title muted">{ag.path}</span>
                              </button>
                            {/if}
                          </li>
                        {/each}
                        <!-- Always-present Terminal entry. Spawns the user's
                             $SHELL (resolved server-side via /api/shell-default)
                             as a plain PTY in this worktree — no JSONL
                             transcript, just an interactive shell column. -->
                        <li>
                          <button
                            class="agent-row new-agent-row"
                            on:click={() => {
                              newAgentPopoverOpen = { ...newAgentPopoverOpen, [wt.path]: false };
                              unfoldRowIfFolded(row.key);
                              openNewTerminalInWt(wt.path);
                            }}
                            title={`Spawn ${defaultShell} as a plain terminal in ${wt.path}`}
                          >
                            <svg class="agent-row-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l5-5-5-5"/><path d="M11 19h8"/></svg>
                            <span class="agent-row-name">Terminal</span>
                            <span class="agent-title muted">{defaultShell}</span>
                          </button>
                        </li>
                        <li>
                          <button
                            class="agent-row new-agent-row"
                            on:click={() => {
                              newAgentPopoverOpen = { ...newAgentPopoverOpen, [wt.path]: false };
                              unfoldRowIfFolded(row.key);
                              openFileBrowser(wt.path);
                            }}
                            title={`Browse files in ${wt.path}`}
                          >
                            <svg class="agent-row-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                            <span class="agent-row-name">Files</span>
                            <span class="agent-title muted">browse</span>
                          </button>
                        </li>
                        <li>
                          <button
                            class="agent-row new-agent-row"
                            on:click={() => {
                              newAgentPopoverOpen = { ...newAgentPopoverOpen, [wt.path]: false };
                              unfoldRowIfFolded(row.key);
                              openGitHistory(wt.path);
                            }}
                            title={`Git commit history for ${wt.path}`}
                          >
                            <svg class="agent-row-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="9"/><line x1="12" y1="15" x2="12" y2="21"/></svg>
                            <span class="agent-row-name">History</span>
                            <span class="agent-title muted">commits</span>
                          </button>
                        </li>
                      </ul>
                    </Popover>
                  {/if}
                  {#if a}
                  <button
                    class="agent-badge agent-{a.agent}"
                    class:active={isOpenInWt(wt.path, a.source)}
                    title={activeTuis.length > 1
                      ? `Jump to one of ${activeTuis.length} active TUIs in this worktree`
                      : `${a.manualTitle ?? `Show the latest ${a.agent} session`}\nLast active ${relTime(a.lastActive)}`}
                    on:click|stopPropagation={() => {
                      // With several live TUIs, the badge becomes a
                      // jumper popover — listing only sessions whose
                      // PTY is mounted right now — so the user can hop
                      // between them in one click instead of cycling
                      // via revealSession. With ≤1 active TUI the
                      // popover would be empty/redundant, so fall
                      // through to the classic reveal behavior.
                      if (activeTuis.length > 1) {
                        // Mutually exclusive with the count-chip's
                        // "all sessions" popover — only one of the two
                        // row-head popovers should be open at a time.
                        agentsPopoverOpen = {
                          ...agentsPopoverOpen,
                          [wt.path]: false,
                        };
                        activeTuisPopoverOpen = {
                          ...activeTuisPopoverOpen,
                          [wt.path]: !activeTuisPopoverOpen[wt.path],
                        };
                        return;
                      }
                      revealSession(row.key, wt.path, {
                        agent: a.agent,
                        source: a.source,
                      });
                    }}
                  >
                    {#if a.manualTitle}
                      <span class="agent-manual-title">{a.manualTitle}</span>
                      <span class="muted small">{relTime(a.lastActive)}</span>
                    {:else if a.title}
                      <span class="agent-manual-title">{a.title}</span>
                      <span class="muted small">{relTime(a.lastActive)}</span>
                    {:else}
                      {a.agent} {relTime(a.lastActive)}
                    {/if}
                  </button>
                  {#if activeTuisPopoverOpen[wt.path] && activeTuis.length > 1}
                    <SessionSearchList
                      sessions={activeTuis}
                      headText={`${activeTuis.length} active TUIs in this worktree`}
                      dismissedSources={dismissedSessions}
                      starredSources={starredSessions}
                      isOpen={(s) => isOpenInWt(wt.path, s.source)}
                      tooltipFor={(s) => sessionTooltip(s)}
                      on:pick={(e) => {
                        activeTuisPopoverOpen = {
                          ...activeTuisPopoverOpen,
                          [wt.path]: false,
                        };
                        revealSession(row.key, wt.path, {
                          agent: e.detail.agent,
                          source: e.detail.source,
                        });
                      }}
                      on:close={(e) => {
                        toggleOpenSessionInWt(wt.path, {
                          agent: e.detail.agent,
                          source: e.detail.source,
                        });
                      }}
                      on:dismiss={(e) => dismissSession(e.detail.source)}
                      on:restore={(e) => restoreSession(e.detail.source)}
                    />
                  {/if}
                  {/if}
                  {#if a && pickerSessions.length > 1}
                    <button
                      class="agent-more agent-{a.agent}"
                      class:has-search={stripSearchOpen[wt.path]}
                      title={`Pick from ${pickerSessions.length} sessions in this worktree`}
                      on:click|stopPropagation={() => {
                        // Mutually exclusive with the agent-badge's
                        // active-TUIs jumper — only one of the two
                        // row-head popovers should be open at a time.
                        activeTuisPopoverOpen = {
                          ...activeTuisPopoverOpen,
                          [wt.path]: false,
                        };
                        agentsPopoverOpen = {
                          ...agentsPopoverOpen,
                          [wt.path]: !agentsPopoverOpen[wt.path],
                        };
                      }}
                    >{pickerSessions.length}</button>
                    <button
                      class="agent-search agent-{a.agent}"
                      class:active={stripSearchOpen[wt.path]}
                      title="Filter this row's sessions by title or message"
                      aria-label="Filter sessions"
                      on:click|stopPropagation={() => {
                        if (stripSearchOpen[wt.path]) {
                          closeStripSearch(row.key, wt.path);
                        } else {
                          openStripSearch(row.key, wt.path);
                        }
                      }}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true" width="11" height="11">
                        <path
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM13.5 13.5l-3-3"
                        />
                      </svg>
                    </button>
                    {#if stripSearchOpen[wt.path]}
                      <input
                        class="agent-search-input"
                        type="search"
                        placeholder="filter…"
                        bind:value={stripSearchQuery[wt.path]}
                        on:click|stopPropagation
                        on:keydown|stopPropagation={(e) => {
                          if (e.key === "Escape") {
                            closeStripSearch(row.key, wt.path);
                          } else if (e.key === "Enter") {
                            // Enter picks the top "not in strip" match —
                            // matches users typing to find a chat, then
                            // hitting return to open it without grabbing
                            // the mouse. No-op when there's no such match.
                            const top =
                              stripFilterByWt[wt.path]?.notOpen[0];
                            if (top) {
                              pinRowOpenAfterPick(row.key);
                              revealSession(row.key, wt.path, {
                                agent: top.agent,
                                source: top.source,
                              });
                            }
                          }
                        }}
                        use:focusOnMount
                      />
                    {/if}
                    {#if agentsPopoverOpen[wt.path]}
                      <SessionSearchList
                        sessions={pickerSessions}
                        headText={`${pickerSessions.length} sessions in this worktree`}
                        dismissedSources={dismissedSessions}
                        starredSources={starredSessions}
                        isOpen={(s) => isOpenInWt(wt.path, s.source)}
                        tooltipFor={(s) => sessionTooltip(s)}
                        on:pick={(e) => {
                          agentsPopoverOpen = {
                            ...agentsPopoverOpen,
                            [wt.path]: false,
                          };
                          // `revealSession` (mode "reveal") forces the
                          // scroll-to-center + flash cue even when the
                          // column is already open. The user's just
                          // pointed at a row in the picker — they need
                          // a clear visual confirmation of which one
                          // they chose, same affordance the synthetic
                          // not-in-strip list uses.
                          revealSession(row.key, wt.path, {
                            agent: e.detail.agent,
                            source: e.detail.source,
                          });
                        }}
                        on:close={(e) => {
                          toggleOpenSessionInWt(wt.path, {
                            agent: e.detail.agent,
                            source: e.detail.source,
                          });
                        }}
                        on:dismiss={(e) => dismissSession(e.detail.source)}
                        on:restore={(e) => restoreSession(e.detail.source)}
                      />
                    {/if}
                  {/if}
                </span>
              {/if}
              {#if rowFolded[row.key] && wtHasRecentActivity(wt, nowMs)}
                <!-- Lives right of the agent-wrap (sessions dropdown +
                     "+ new" cluster) and just before the wt-path, so
                     when an agent is mid-output the spinner sits with
                     the other agent UI instead of squeezing between
                     the branch chip and the dropdown. -->
                <span
                  class="popover-spinner row-activity-spinner"
                  title="An agent in this row had output in the last 10s"
                  aria-label="agent activity"
                ></span>
              {/if}
              <code class="wt-path">{wt.path}</code>
            {:else}
              <code class="wt-path">{repo.path}</code>
              <span class="branch warn">no worktrees</span>
            {/if}

            <!-- Three-piece notes tag, fused via flex like the
                 repo-chip + color-swatch pair: count attachment on
                 the LEFT (only when there's at least one note),
                 `notes` toggle in the MIDDLE (CSS-only hide of this
                 row's notes — components stay mounted), `+` add on
                 the RIGHT. Same .new-wt dashed-tag styling as the
                 worktrees button so the row's action group reads as
                 a single family. -->
            {#if !rowFolded[row.key]}
            <span class="note-add-stack">
              {#if noteCount > 0}
                <span
                  class="row-note-count-anchor"
                  data-notes-list-anchor={row.key}
                >
                  <button
                    type="button"
                    class="row-note-count"
                    class:open={!!notesListOpen[row.key]}
                    title={`${noteCount} sticky note${noteCount === 1 ? "" : "s"} pinned to this ${wt ? "worktree" : "repo"} — click to list / undo deletes`}
                    on:click|stopPropagation={() => {
                      notesListOpen = {
                        ...notesListOpen,
                        [row.key]: !notesListOpen[row.key],
                      };
                    }}
                  >{noteCount}</button>
                  {#if notesListOpen[row.key]}
                    {@const anchorStr = noteAnchor}
                    {@const rowNotes = $notesAll.filter((n) =>
                      n.anchors.some((a) => a === anchorStr),
                    )}
                    {@const rowDeletes = removeNoteEventsByAnchor[anchorStr] ?? []}
                    {@const visibleNotes = rowNotes
                      .map((n) => ({ n, display: notesListDisplay(n) }))
                      .filter((row) => row.display.text.length > 0)}
                    {@const visibleDeletes = rowDeletes
                      .slice(0, 20)
                      .map((ev) => ({
                        ev,
                        display: notesListDisplay({
                          body: (ev.inverse?.note?.body as string | undefined) ?? "",
                          kind: ev.inverse?.note?.kind,
                          target: ev.inverse?.note?.target,
                        }),
                      }))
                      .filter((r) => r.display.text.length > 0)}
                    <Popover variant="agents" extraClass="notes-list-popover">
                      <svelte:fragment slot="head">
                        Notes on {wt ? `${repo.name ?? repoName(repo)} · ${wt.branch ?? "?"}` : (repo.name ?? repoName(repo))}
                      </svelte:fragment>
                      <div class="notes-list-section">
                        {#if visibleNotes.length === 0}
                          <p class="muted small nopad">No notes with content.</p>
                        {:else}
                          <ul class="notes-list">
                            {#each visibleNotes as row (row.n.id)}
                              {@const n = row.n}
                              <li class="notes-list-row" class:is-link={row.display.kind === "link"}>
                                <span class="notes-list-body" title={row.display.title}>
                                  <span class="notes-list-kind" aria-hidden="true">
                                    {#if row.display.kind === "link"}
                                      {#if row.display.agent || row.display.provider || row.display.glyph}
                                        <AttachmentIcon
                                          agent={row.display.agent}
                                          provider={row.display.provider}
                                          glyph={row.display.glyph}
                                          size={14}
                                        />
                                      {:else}
                                        <svg
                                          viewBox="0 0 24 24"
                                          width="12"
                                          height="12"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="2.2"
                                          stroke-linecap="round"
                                          stroke-linejoin="round"
                                          aria-hidden="true"
                                        >
                                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                      {/if}
                                    {:else}
                                      <NoteIcon size={13} />
                                    {/if}
                                  </span>
                                  {row.display.text}
                                </span>
                                <span class="muted ev-time">{relTime(n.updatedAt)}</span>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      </div>
                      <div class="notes-list-section">
                        <div class="notes-list-section-head">
                          Recently deleted ({visibleDeletes.length})
                        </div>
                        {#if visibleDeletes.length === 0}
                          <p class="muted small nopad">None.</p>
                        {:else}
                          <ul class="notes-list">
                            {#each visibleDeletes as r (r.ev.id)}
                              <li class="notes-list-row deleted" class:is-link={r.display.kind === "link"}>
                                <span class="notes-list-body" title={r.display.title}>
                                  <span class="notes-list-kind" aria-hidden="true">
                                    {#if r.display.kind === "link"}
                                      {#if r.display.agent || r.display.provider || r.display.glyph}
                                        <AttachmentIcon
                                          agent={r.display.agent}
                                          provider={r.display.provider}
                                          glyph={r.display.glyph}
                                          size={14}
                                        />
                                      {:else}
                                        <svg
                                          viewBox="0 0 24 24"
                                          width="12"
                                          height="12"
                                          fill="none"
                                          stroke="currentColor"
                                          stroke-width="2.2"
                                          stroke-linecap="round"
                                          stroke-linejoin="round"
                                          aria-hidden="true"
                                        >
                                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                        </svg>
                                      {/if}
                                    {:else}
                                      <NoteIcon size={13} />
                                    {/if}
                                  </span>
                                  {r.display.text}
                                </span>
                                <span class="muted ev-time">{relTime(r.ev.timestamp)}</span>
                                <button
                                  class="undo"
                                  on:click={(e) =>
                                    void undoNoteDelete(
                                      r.ev,
                                      e.currentTarget as HTMLElement,
                                    )}
                                  title="Restore this deleted note"
                                >Undo</button>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                      </div>
                    </Popover>
                  {/if}
                </span>
              {/if}
              <button
                class="new-wt notes-toggle"
                class:active={zenRowKey === row.key
                  ? notesShownInZen
                  : !notesHiddenByRow[row.key]}
                title={(zenRowKey === row.key ? notesShownInZen : !notesHiddenByRow[row.key])
                  ? "Hide this row's sticky notes"
                  : "Show this row's sticky notes"}
                on:click|stopPropagation={() => {
                  if (zenRowKey === row.key) notesShownInZen = !notesShownInZen;
                  else toggleNotesHidden(row.key);
                }}
              >notes</button>
              <button
                class="new-wt notes-add"
                title={wt
                  ? `Pin a sticky note to this worktree (\`${wt.branch}\`)`
                  : `Pin a sticky note to \`${repo.name ?? repo.path}\``}
                on:click|stopPropagation={(e) => {
                  // Un-hide first so the freshly-spawned note is visible.
                  if (zenRowKey === row.key) {
                    notesShownInZen = true;
                  } else if (notesHiddenByRow[row.key]) {
                    notesHiddenByRow = { ...notesHiddenByRow, [row.key]: false };
                  }
                  const btn = e.currentTarget as HTMLButtonElement;
                  const anchor = wt ? `worktree:${wt.path}` : `repo:${repo.path}`;
                  void spawnNote({ anchor, originRect: btn.getBoundingClientRect() });
                }}
              >+</button>
              <!-- Link companion — same spawn machinery, kind: "link"
                   instead. Docked to + so the action group reads as
                   one family (count · notes · + · ⛓); the chip vs
                   paper-sticky render decision happens inside
                   StickyNote based on the note.kind discriminator.

                   Icon is inline SVG (not 🔗 emoji) so it inherits
                   the surrounding `color: var(--text-muted)` via
                   `stroke: currentColor` — same rendering hook every
                   other muted text glyph in this toolbar uses. The
                   emoji renders as a colour bitmap on every modern OS
                   and ignores `color`, which is why the previous
                   text-shadow workaround looked off-weight next to
                   the "+". -->
              <button
                class="new-wt notes-add notes-add-link"
                title={wt
                  ? `Pin a link to this worktree (\`${wt.branch}\`) — URL, commit SHA, session, or file path`
                  : `Pin a link to \`${repo.name ?? repo.path}\` — URL, commit SHA, session, or file path`}
                on:click|stopPropagation={(e) => {
                  if (zenRowKey === row.key) {
                    notesShownInZen = true;
                  } else if (notesHiddenByRow[row.key]) {
                    notesHiddenByRow = { ...notesHiddenByRow, [row.key]: false };
                  }
                  const btn = e.currentTarget as HTMLButtonElement;
                  const anchor = wt ? `worktree:${wt.path}` : `repo:${repo.path}`;
                  void spawnNote({
                    anchor,
                    originRect: btn.getBoundingClientRect(),
                    kind: "link",
                  });
                }}
                aria-label="Add link"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="11"
                  height="11"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </button>
              <span class="emoji-picker-anchor" data-emoji-picker-anchor={row.key}>
                <button
                  class="new-wt notes-add notes-add-emoji"
                  title="Add an emoji sticker"
                  on:click|stopPropagation={() => {
                    emojiPickerOpen = { ...emojiPickerOpen, [row.key]: !emojiPickerOpen[row.key] };
                  }}
                  aria-label="Add emoji sticker"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="11"
                    height="11"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="9" cy="9" r="1" />
                    <circle cx="15" cy="9" r="1" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  </svg>
                </button>
                {#if emojiPickerOpen[row.key]}
                  <EmojiPicker
                    on:pick={(e) => {
                      emojiPickerOpen = { ...emojiPickerOpen, [row.key]: false };
                      if (zenRowKey === row.key) {
                        notesShownInZen = true;
                      } else if (notesHiddenByRow[row.key]) {
                        notesHiddenByRow = { ...notesHiddenByRow, [row.key]: false };
                      }
                      const anchor = wt ? `worktree:${wt.path}` : `repo:${repo.path}`;
                      const btn = document.querySelector(`[data-wt-row="${CSS.escape(wt?.path ?? repo.id)}"] .notes-add-emoji`) as HTMLElement | null;
                      const rect = btn?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
                      void spawnNote({
                        anchor,
                        originRect: rect,
                        kind: "emoji",
                        body: e.detail,
                      });
                    }}
                    on:cancel={() => {
                      emojiPickerOpen = { ...emojiPickerOpen, [row.key]: false };
                    }}
                  />
                {/if}
              </span>
            </span>
            {/if}
            {#if !rowFolded[row.key]}
            <span class="wt-picker-anchor" data-wt-picker-anchor={wt ? wt.path : repo.id}>
              <button
                class="new-wt"
                title="Worktrees of this repo (switch to / remove / create new)"
                on:click|stopPropagation={() => {
                  const key = wt ? wt.path : repo.id;
                  wtPickerOpen = { ...wtPickerOpen, [key]: !wtPickerOpen[key] };
                }}
              >worktrees ({repo.worktrees.length})</button>
              {#if wtPickerOpen[wt ? wt.path : repo.id]}
                {@const diskPaths = repo.worktrees.map((w) => w.path)}
                {@const visibleSet = new Set(
                  effectiveVisibleWorktrees(repo.id, diskPaths, visibleWorktreesByRepo),
                )}
                <Popover variant="agents" extraClass="wt-picker-popover">
                  <svelte:fragment slot="head">Worktrees of {repo.name ?? repoName(repo)}</svelte:fragment>
                  <ul class="agents-list">
                    {#each repo.worktrees as wOption (wOption.path)}
                      <li>
                        <div
                          class="agent-row wt-pick-row"
                          class:wt-pick-visible={visibleSet.has(wOption.path)}
                          role="button"
                          tabindex="0"
                          on:click={() => {
                            toggleWorktreeVisibility(repo.id, wOption.path, diskPaths);
                          }}
                          on:keydown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleWorktreeVisibility(repo.id, wOption.path, diskPaths);
                            }
                          }}
                          title={visibleSet.has(wOption.path)
                            ? `${wOption.path}\n\nVisible in the dashboard. Click to hide this row. The worktree itself stays on disk.`
                            : `${wOption.path}\n\nHidden. Click to show as a row in the dashboard.`}
                        >
                          <span class="wt-pick-tick" aria-hidden="true">
                            {visibleSet.has(wOption.path) ? "✓" : ""}
                          </span>
                          <span class="agent-row-name">{wOption.nonGit ? "—" : wOption.branch}</span>
                          <span class="agent-title">{wOption.path}</span>
                          {#if !wOption.nonGit}
                            <button
                              class="row-close wt-pick-kill"
                              on:click|stopPropagation={() => {
                                wtPickerOpen = { ...wtPickerOpen, [wt ? wt.path : repo.id]: false };
                                void removeWorktreeInRow(repo.id, {
                                  path: wOption.path,
                                  branch: wOption.branch,
                                });
                              }}
                              title="Remove this worktree's directory from disk (branch ref is kept)"
                              aria-label="Remove worktree from disk"
                            >×</button>
                          {/if}
                        </div>
                      </li>
                    {/each}
                  </ul>
                  {#if !repo.worktrees.some((w) => w.nonGit)}
                    <form
                      class="wt-pick-create-row"
                      on:submit|preventDefault={() => {
                        const branch = (newWtBranch[repo.id] ?? "").trim();
                        if (!branch) return;
                        const key = wt ? wt.path : repo.id;
                        wtPickerOpen = { ...wtPickerOpen, [key]: false };
                        void createWorktree(repo.id);
                      }}
                    >
                      <input
                        type="text"
                        placeholder="new branch — creates worktree on it"
                        bind:value={newWtBranch[repo.id]}
                        on:click|stopPropagation
                        class="wt-pick-create-input"
                        title={`Runs \`git worktree add ~/wt/${repoName(repo)}/<branch> -b <branch>\` — creates BOTH the new branch and a worktree directory for it.`}
                      />
                      <button
                        type="submit"
                        class="wt-pick-create-go"
                        disabled={!((newWtBranch[repo.id] ?? "").trim())}
                        title="git worktree add ~/wt/<repo>/<branch> -b <branch>"
                      >+ create</button>
                    </form>
                  {/if}
                  <button
                    class="wt-pick-remove-repo"
                    on:click|stopPropagation={() => {
                      const ok = confirm(
                        `Remove repository \`${repoName(repo)}\` and all its worktree rows from supergit?\n\n` +
                        `This only untracks the repo from supergit's workspace — your repo at\n  ${repo.path}\nand any worktree directories on disk are NOT deleted.\n\n` +
                        `You can re-add it later via "+ Add" if you change your mind.`,
                      );
                      if (!ok) return;
                      wtPickerOpen = { ...wtPickerOpen, [wt ? wt.path : repo.id]: false };
                      void removeRepo(repo.id);
                    }}
                    title="Untrack the repo from supergit (the repo dir + worktrees on disk are kept)"
                  >Remove repository and all worktree rows from supergit</button>
                </Popover>
              {/if}
            </span>
            {/if}
            {#if rowFolded[row.key] && wt}
              <OpenInActions
                path={wt.path}
                repoId={repo.id}
                {editors}
                remotes={repo.remotes ?? []}
                customLinks={repo.customLinks ?? []}
                {runningCommandIds}
                onCommandClick={(l) => handleCommandClick(wt.path, l)}
                {commandUrls}
                {openIn}
                {openRemote}
                onAddCustomLink={(input) => addCustomLink(repo.id, input)}
                onRemoveCustomLink={(linkId) => removeCustomLink(repo.id, linkId)}
                onReorderCustomLinks={(orderedIds) => reorderCustomLinks(repo.id, orderedIds)}
                onEditCustomLink={(linkId, input) => updateCustomLink(repo.id, linkId, input)}
                iconOnly
              />
            {/if}
            <button
              class="row-zen-btn"
              class:open={zenRowKey === row.key}
              title={zenRowKey === row.key
                ? "Exit zen — restore the rest of the dashboard (Esc)"
                : `Zen — make \`${repo.name}${wt ? ` · ${wt.branch}` : ""}\` fill the viewport`}
              aria-label={zenRowKey === row.key ? "Exit zen" : "Enter zen"}
              on:click|stopPropagation={() => toggleZenRow(row.key)}
            >{zenRowKey === row.key ? "◱" : "▣"}</button>
            <button
              class="row-remove"
              title={wt && !wt.nonGit
                ? "Hide this worktree's row from the dashboard. Worktree directory on disk is NOT deleted; the repo stays in supergit. Re-show via the worktrees picker."
                : "Remove this folder from supergit's workspace. The folder on disk is NOT deleted."}
              on:click={() => {
                if (wt && !wt.nonGit && repo.worktrees.length > 1) {
                  hideWorktreeRow(
                    repo.id,
                    wt.path,
                    repo.worktrees.map((w) => w.path),
                  );
                } else {
                  void removeRepo(repo.id);
                }
              }}>×</button
            >
          </div>

          <div class="row-body">
          {#if newWtOpen[repo.id]}
            <div class="new-wt-form">
              <input
                type="text"
                class="new-wt-input"
                placeholder="new branch name (e.g. feat/audio)"
                bind:value={newWtBranch[repo.id]}
                disabled={newWtBusy[repo.id]}
                on:keydown={(e) => {
                  if (e.key === "Enter") createWorktree(repo.id);
                  if (e.key === "Escape") {
                    newWtOpen = { ...newWtOpen, [repo.id]: false };
                  }
                }}
              />
              <button
                class="tiny"
                disabled={!newWtBranch[repo.id]?.trim() || newWtBusy[repo.id]}
                on:click={() => createWorktree(repo.id)}
              >
                {newWtBusy[repo.id] ? "Creating…" : "Create"}
              </button>
              <span class="muted small">
                will live at ~/wt/{repo.name}/{(newWtBranch[repo.id] ?? "")
                  .trim()
                  .replace(/[\/\\]/g, "-") || "…"}
              </span>
            </div>
          {/if}

          {#if wt && summary}
            <div class="row-status">
              {#if isFirstOfRepo && !newlyAddedRepoPaths.has(wt?.path ?? "") && !newlyAddedRepoPaths.has(repo.path)}
                <RepoRecentSummary repoId={repo.id} repoName={repo.name} inline />
              {/if}

              <OpenInActions
                path={wt.path}
                repoId={repo.id}
                {editors}
                remotes={repo.remotes ?? []}
                customLinks={repo.customLinks ?? []}
                {runningCommandIds}
                onCommandClick={(l) => handleCommandClick(wt.path, l)}
                {commandUrls}
                {openIn}
                {openRemote}
                onAddCustomLink={(input) => addCustomLink(repo.id, input)}
                onRemoveCustomLink={(linkId) => removeCustomLink(repo.id, linkId)}
                onReorderCustomLinks={(orderedIds) => reorderCustomLinks(repo.id, orderedIds)}
                onEditCustomLink={(linkId, input) => updateCustomLink(repo.id, linkId, input)}
              />
            </div>
          {/if}

          {#if wt && (newlyAddedRepoPaths.has(wt.path) || newlyAddedRepoPaths.has(repo.path) || onboardingByWt[wt.path] || walkthroughByWt[wt.path] != null)}
            {@const ob = onboardingByWt[wt.path]}
            <div class="onboarding-section">
              {#if ob && (ob.status === "streaming" || ob.status === "done")}
                <div class="onboarding-response">
                  <span class="onboarding-provider-badge">
                    {#if ob.provider === "ollama"}
                      <img src="/agents/ollama.svg" alt="" class="onboarding-provider-icon" />
                    {:else if ob.provider === "claude"}
                      <img src="/agents/claude.svg" alt="" class="onboarding-provider-icon" />
                    {/if}
                    <span class="muted small">{ob.model ?? ob.provider}</span>
                    {#if ob.status === "streaming"}
                      <LoadingSpinner size="0.7rem" />
                    {/if}
                  </span>
                  <div class="onboarding-text">{@html marked.parse(ob.text || "", { async: false, breaks: true, gfm: true })}</div>
                </div>
                {#if ob.status === "done" && walkthroughByWt[wt.path] == null && !walkthroughSeen(wt.path)}
                  <div class="onboarding-tour-buttons">
                    <button class="onboarding-btn" on:click={() => {
                      walkthroughByWt = { [wt.path]: 0 };
                    }}>Tour the UI</button>
                    <button class="walkthrough-btn-skip" on:click={() => {
                      markWalkthroughSeen(wt.path);
                      delete onboardingByWt[wt.path];
                      onboardingByWt = onboardingByWt;
                    }}>Skip onboarding</button>
                  </div>
                {/if}
              {:else if ob && ob.status === "error"}
                <div class="onboarding-error muted small">{ob.error}</div>
                <button
                  class="onboarding-btn"
                  on:click={() => startOnboarding(wt.path)}
                >Retry</button>
              {:else if walkthroughByWt[wt.path] == null}
                <div class="onboarding-cta-row">
                  <button
                    class="onboarding-btn"
                    on:click={() => {
                      walkthroughByWt = { [wt.path]: 0 };
                    }}
                  >Tour the UI</button>
                  <button
                    class="walkthrough-btn-skip"
                    on:click={() => {
                      newlyAddedRepoPaths.delete(wt.path);
                      newlyAddedRepoPaths.delete(repo.path);
                      markWalkthroughSeen(wt.path);
                      delete onboardingByWt[wt.path];
                      onboardingByWt = onboardingByWt;
                    }}
                  >Skip</button>
                </div>
              {/if}
              {#if walkthroughByWt[wt.path] != null}
                <OnboardingWalkthrough
                  wtPath={wt.path}
                  currentStep={walkthroughByWt[wt.path] ?? 0}
                  on:next={() => {
                    const s = (walkthroughByWt[wt.path] ?? 0) + 1;
                    if (s >= WALKTHROUGH_STEPS.length) {
                      markWalkthroughSeen(wt.path);
                      walkthroughByWt = { ...walkthroughByWt, [wt.path]: null };
                      delete onboardingByWt[wt.path];
                      onboardingByWt = onboardingByWt;
                    } else {
                      walkthroughByWt = { ...walkthroughByWt, [wt.path]: s };
                    }
                  }}
                  on:skip={() => {
                    markWalkthroughSeen(wt.path);
                    walkthroughByWt = { ...walkthroughByWt, [wt.path]: null };
                    delete onboardingByWt[wt.path];
                    onboardingByWt = onboardingByWt;
                  }}
                />
              {/if}
            </div>
          {/if}

          {#if wt && summary}
            {#if wt}
              {@const stripFilter = stripFilterByWt[wt.path]}
              {#if (openSessionsByWt[wt.path]?.length ?? 0) > 0 || (stripFilter && stripFilter.notOpen.length > 0)}
                {@const existingSources = new Set(
                  (wt.agents ?? []).map((a) => a.source),
                )}
                {@const visibleSessions = filterToExistingSessions(
                  openSessionsByWt[wt.path] ?? [],
                  existingSources,
                )}
                {#if visibleSessions.length > 0 || (stripFilter && stripFilter.notOpen.length > 0)}
                  <div
                    class="sessions-strip"
                    data-wt-strip={wt.path}
                    on:dragleave={(e) => handleStripDragLeave(e, wt.path)}
                  >
                    <!-- Trailing spacer (the leading inset is handled by
                         `.sessions-strip { padding-left }`). Can't use
                         padding-right here — horizontally scrolling flex
                         containers drop it — so a real flex item gives
                         the last column the same breathing room. -->
                    {#each visibleSessions as s, i (s.source)}
                      <div
                        class="session-col"
                        class:session-col-filtered={stripFilter && !stripFilter.matched.has(s.source)}
                        class:session-col-pickable={!!stripFilter && stripFilter.matched.has(s.source)}
                        class:drop-before={dragOverTarget?.wtPath === wt.path
                          && dragOverTarget.index === i
                          && dragOverTarget.side === "left"
                          && dragSource?.index !== i}
                        class:drop-after={dragOverTarget?.wtPath === wt.path
                          && dragOverTarget.index === i
                          && dragOverTarget.side === "right"
                          && dragSource?.index !== i}
                        data-session-source={s.source}
                        animate:flip={{ duration: 220 }}
                        on:dragover={(e) => handleSessionDragOver(e, wt.path, i)}
                        on:drop={(e) =>
                          handleSessionDrop(e, wt.path, i)}
                        on:dragend={handleSessionDragEnd}
                        on:click={() => {
                          commitStripSearch(row.key, wt.path, s.source);
                          // Bubbles from any click inside the column — a
                          // child handler that closes the session will
                          // have run first, so guard with isOpenInWt so
                          // we don't park `focusedSource` on a source
                          // that's already been removed.
                          if (isOpenInWt(wt.path, s.source)) {
                            focusedSource = s.source;
                          }
                        }}
                        out:closeColumn
                      >
                        {#if s.source.startsWith("__files__:")}
                          <FileBrowser
                            wtPath={wt.path}
                            source={s.source}
                            onClose={() => closeSessionInWt(wt.path, s)}
                            onDragStart={(e) =>
                              handleSessionDragStart(e, wt.path, i)}
                          />
                        {:else if s.source.startsWith("__history__:")}
                          <GitHistory
                            wtPath={wt.path}
                            source={s.source}
                            onClose={() => closeSessionInWt(wt.path, s)}
                            onDragStart={(e) =>
                              handleSessionDragStart(e, wt.path, i)}
                            fsChangeKey={fsChangeKey[wt.path] ?? 0}
                          />
                        {:else if s.source.startsWith("__transcript__:ollama:")}
                          <!-- Read-mode column for a stopped (or live)
                               Ollama session. OllamaTranscriptView is a
                               thin wrapper around SessionView so the
                               read view looks identical to Claude /
                               Codex; the wrapper only adds Ollama-
                               specific Resume actions. Needs the
                               on-disk JSONL path so SessionView's
                               /api/session fetch can parse it. -->
                          {@const ollamaTermId = s.source.slice("__transcript__:ollama:".length)}
                          {@const ollamaMeta = (wt.agents ?? []).find(
                            (a) => a.agent === "ollama" && a.sessionId === ollamaTermId,
                          )}
                          {@const ollamaModelLabel = s.ollamaModel ?? ollamaMeta?.model ?? ollamaMeta?.title ?? "ollama"}
                          {@const ollamaSourcePath = ollamaMeta?.source ?? ollamaSourcePathOverride[s.source]}
                          {#if ollamaSourcePath}
                            <OllamaTranscriptView
                              termId={ollamaTermId}
                              wt={wt.path}
                              model={ollamaModelLabel}
                              sourcePath={ollamaSourcePath}
                              starred={starredSessions.has(ollamaSourcePath)}
                              onToggleStar={() => toggleStarSession(ollamaSourcePath)}
                              onContinueWith={(targetAgent, ollamaModel) =>
                                void continueSessionWith(wt.path, ollamaSourcePath, targetAgent, ollamaModel)}
                              on:close={() => closeSessionInWt(wt.path, s)}
                            />
                          {:else}
                            <!-- No matching AgentSession yet (still
                                 mid-spawn or /api/repos hasn't
                                 rescanned). Show a brief placeholder
                                 instead of an empty frame. -->
                            <div class="session muted small" style="padding: 0.75rem 1rem;">
                              starting…
                            </div>
                          {/if}
                        {:else if s.source.startsWith("__transcript__:")}
                          <!-- Read-mode column for a past shell session.
                               Renders the captured commands from the
                               JSONL and exposes a Resume button that
                               spawns a new PTY at the last cwd. -->
                          <div class="session shell-transcript-col">
                            <ShellView
                              termId={s.source.split(":").pop() ?? ""}
                              wt={wt.path}
                              onResume={(lastCwd) =>
                                resumePastShell(wt.path, s.source, lastCwd)}
                              onClose={() => closeSessionInWt(wt.path, s)}
                            />
                          </div>
                        {:else if s.source.startsWith("__new__:") || s.source.startsWith("__attached__:")}
                          <!-- Transient column: a brand-new agent we just
                               spawned, before its JSONL has been created on
                               disk. NewSessionCol.svelte handles the shell
                               + claude/codex variants; we just feed it
                               props and react to its events. -->
                          {@const newAgentMeta = s.resumeSessionId
                            ? (wt.agents ?? []).find(
                                (a) =>
                                  a.agent === s.agent &&
                                  a.sessionId === s.resumeSessionId,
                              )
                            : undefined}
                          {@const titleSource = resolveTitleSource(
                            s,
                            wt.agents ?? [],
                          )}
                          <NewSessionCol
                            agent={s.agent}
                            source={titleSource}
                            wtPath={wt.path}
                            cmd={cmdForOpenSession(s, defaultShell, defaultShellArgs)}
                            cwd={shellResumeCwd[s.source] ?? wt.path}
                            procName={`supergit-tui-new-${s.agent}`}
                            attachTermId={s.source.startsWith("__attached__:")
                              ? s.source.split(":").pop()
                              : undefined}
                            resumeFromTermId={shellResumeFromTermId[s.source]}
                            manualTitle={newAgentMeta?.manualTitle ??
                              newSessionTitles[titleSource] ??
                              newSessionTitles[s.source]}
                            awaiting={!!transientAwaiting[s.source]}
                            working={!!transientWorking[s.source]}
                            totalMessageCount={newAgentMeta?.messageCount}
                            contextTokens={newAgentMeta?.contextTokens}
                            contextTokensExact={newAgentMeta?.contextTokensExact}
                            contextWindow={newAgentMeta?.contextWindow}
                            model={newAgentMeta?.model}
                            lastActivityIso={newAgentMeta?.lastActive}
                            lastUserMessage={newAgentMeta?.lastUserMessage}
                            starred={starredSessions.has(titleSource) || starredSessions.has(s.source)}
                            onToggleStar={() => toggleStarSession(titleSource)}
                            on:close={() => closeSessionInWt(wt.path, s)}
                            on:dispose={() =>
                              disposeNewSessionColumn(wt.path, s, wt.agents ?? [])}
                            on:restart={() => restartNewAgentSession(wt.path, s)}
                            on:spawn={(e) => {
                              // Capture the daemon-assigned termId for
                              // every `__new__:` source (any agent) so
                              // disposeNewSessionColumn can DELETE
                              // /api/terminals/:id later.
                              if (s.source.startsWith("__new__:")) {
                                newTermIds = {
                                  ...newTermIds,
                                  [s.source]: e.detail.id,
                                };
                              }
                              // Claude with a preassignedSessionId: by
                              // this point claude has been exec'd with
                              // `--session-id <uuid>` and has created
                              // the JSONL. Promote the preassigned id to
                              // resumeSessionId so a reload spawns
                              // `claude --resume <uuid>` instead of
                              // re-passing `--session-id` (which now
                              // errors with "Session ID is already in
                              // use"). The activity-tail stamping does
                              // the same thing eventually, but it's
                              // racy — the user can reload faster than
                              // the SSE event arrives.
                              if (
                                s.source.startsWith("__new__:claude:") &&
                                s.preassignedSessionId &&
                                !s.resumeSessionId
                              ) {
                                const sid = s.preassignedSessionId;
                                openSessionsByWt = {
                                  ...openSessionsByWt,
                                  [wt.path]: (openSessionsByWt[wt.path] ?? []).map(
                                    (x) =>
                                      x.source === s.source
                                        ? { ...x, resumeSessionId: sid }
                                        : x,
                                  ),
                                };
                              }
                              // SHELLS only: also swap the persisted
                              // source from `__new__:shell:<random>` to
                              // `__attached__:shell:<termId>`. This is
                              // the canonical "reattach to existing PTY"
                              // form. Without the swap, a reload spawns a
                              // fresh PTY (via the lingering __new__:
                              // entry) *and* restoreLiveShells adds the
                              // still-alive old PTY as a separate
                              // __attached__:shell:<oldTermId> — the
                              // "regular terminal duplicates after
                              // reload" bug. The each-block remounts
                              // briefly (key change), but TerminalView's
                              // attach path reconnects via WS to the
                              // same termId without killing the PTY
                              // (daemon supports multiple subscribers).
                              // Claude/Codex don't get this swap: they
                              // use the activity-tail's resumeSessionId
                              // mechanism for reload continuity.
                              if (s.source.startsWith("__new__:shell:")) {
                                const attachedSource = `__attached__:shell:${e.detail.id}`;
                                promotedSources.add(s.source);
                                openSessionsByWt = {
                                  ...openSessionsByWt,
                                  [wt.path]: (openSessionsByWt[wt.path] ?? []).map(
                                    (x) =>
                                      x.source === s.source
                                        ? { ...x, source: attachedSource }
                                        : x,
                                  ),
                                };
                                // If the user already named this column during
                                // the brief "starting" phase before the PTY
                                // came up, migrate the title to the new source
                                // key so it survives the swap (otherwise the
                                // synthetic-source title gets orphaned and the
                                // header reverts to "Name this session…").
                                void migrateSessionTitleOnServer(
                                  s.source,
                                  attachedSource,
                                );
                              }
                            }}
                            on:awaitingChange={(e) => {
                              transientAwaiting = {
                                ...transientAwaiting,
                                [s.source]: e.detail.awaiting,
                              };
                            }}
                            on:workingChange={(e) => {
                              const wasWorking = !!transientWorking[s.source];
                              const nowWorking = e.detail.working;
                              transientWorking = {
                                ...transientWorking,
                                [s.source]: nowWorking,
                              };
                              if (wasWorking && !nowWorking) {
                                const start = workingStartedAt[s.source];
                                const worked = start ? Date.now() - start : 0;
                                if (worked >= MIN_WORKING_FOR_PULSE_MS) {
                                  scheduleFinished(s.source);
                                }
                                workingStartedAt[s.source] = undefined;
                              } else if (nowWorking && !wasWorking) {
                                workingStartedAt[s.source] = Date.now();
                                clearFinishedFor(s.source);
                              }
                            }}
                            on:exit={() => {
                              transientExited = {
                                ...transientExited,
                                [s.source]: true,
                              };
                              if (transientWorking[s.source]) {
                                transientWorking = {
                                  ...transientWorking,
                                  [s.source]: false,
                                };
                              }
                              workingStartedAt[s.source] = undefined;
                              clearFinishedFor(s.source);
                              if (transientAwaiting[s.source]) {
                                transientAwaiting = {
                                  ...transientAwaiting,
                                  [s.source]: false,
                                };
                              }
                            }}
                            on:titleSave={(e) =>
                              void saveNewSessionTitle(titleSource, e.detail.title)}
                            on:titleEditingChange={(e) => {
                              if (e.detail.editing) {
                                editingTitleSources.add(s.source);
                              } else {
                                editingTitleSources.delete(s.source);
                                flushDeferredPromotions(s.source);
                              }
                            }}
                            onDragStart={(e) =>
                              handleSessionDragStart(e, wt.path, i)}
                          />
                        {:else}
                          {@const agentMeta = (wt.agents ?? []).find(
                            (a) => a.source === s.source,
                          )}
                          <SessionView
                            agent={s.agent as "claude" | "codex" | "copilot"}
                            source={s.source}
                            wtPath={wt.path}
                            totalMessageCount={agentMeta?.messageCount}
                            contextTokens={agentMeta?.contextTokens}
                            contextTokensExact={agentMeta?.contextTokensExact}
                            contextWindow={agentMeta?.contextWindow}
                            model={agentMeta?.model}
                            attachTermId={(s as any).attachTermId}
                            initialMode={s.mode === "terminal" ? "terminal" : "read"}
                            onModeChange={(m) => {
                              // Persist so a reload restores the same view —
                              // otherwise a user who clicked "Resume in
                              // terminal" before refreshing lands back in
                              // history view.
                              const next = setSessionMode(
                                openSessionsByWt,
                                wt.path,
                                s.source,
                                m,
                              );
                              if (next !== openSessionsByWt) openSessionsByWt = next;
                            }}
                            onWorkingChange={(w) => {
                              const wasWorking = !!transientWorking[s.source];
                              transientWorking = {
                                ...transientWorking,
                                [s.source]: w,
                              };
                              if (wasWorking && !w) {
                                const start = workingStartedAt[s.source];
                                const worked = start ? Date.now() - start : 0;
                                if (worked >= MIN_WORKING_FOR_PULSE_MS) {
                                  scheduleFinished(s.source);
                                }
                                workingStartedAt[s.source] = undefined;
                              } else if (w && !wasWorking) {
                                workingStartedAt[s.source] = Date.now();
                                clearFinishedFor(s.source);
                              }
                            }}
                            onAwaitingChange={(a) => {
                              transientAwaiting = {
                                ...transientAwaiting,
                                [s.source]: a,
                              };
                            }}
                            starred={starredSessions.has(s.source)}
                            onToggleStar={() => toggleStarSession(s.source)}
                            onContinueWith={(targetAgent, ollamaModel) =>
                              void continueSessionWith(wt.path, s.source, targetAgent, ollamaModel)}
                            onClose={() => closeSessionInWt(wt.path, s)}
                            onDragStart={(e) =>
                              handleSessionDragStart(e, wt.path, i)}
                            onTitleChange={() => void load()}
                          />
                        {/if}
                      </div>
                    {/each}
                    {#if stripFilter && stripFilter.notOpen.length > 0}
                      <!-- Synthetic column: matches that exist for this
                           worktree but aren't currently mounted in the
                           strip. Click a row → reveal it as a real
                           column (the row vanishes from this list
                           because the matched-but-open partition flips).
                           Lives inside the same flex strip so it scrolls
                           with everything else. -->
                      <div class="session-col session-col-extra">
                        <div class="session-col-extra-head">
                          {stripFilter.notOpen.length} match{stripFilter.notOpen.length === 1 ? "" : "es"} not in strip
                        </div>
                        <ul class="session-col-extra-list">
                          {#each stripFilter.notOpen as extra (extra.source)}
                            <li>
                              <button
                                class="session-col-extra-row brand-{extra.agent}"
                                title={sessionTooltip(extra)}
                                on:click={() => {
                                  pinRowOpenAfterPick(row.key);
                                  // Picking from the synthetic list is a
                                  // definitive selection — exit filter
                                  // mode in the same gesture so the strip
                                  // returns to its full view with the
                                  // just-revealed column centered. Without
                                  // this the user has to click the search
                                  // ×/Esc to leave the filtered state.
                                  stripSearchOpen = {
                                    ...stripSearchOpen,
                                    [wt.path]: false,
                                  };
                                  stripSearchQuery = {
                                    ...stripSearchQuery,
                                    [wt.path]: "",
                                  };
                                  // Use `revealSession` (mode "reveal") so
                                  // the just-mounted column gets the
                                  // outline-flash cue — same affordance the
                                  // header-bar "most recent session" badge
                                  // uses. `revealOrToggleSession` would
                                  // skip the flash on an already-expanded
                                  // row, which is wrong here: the column
                                  // is new on screen and the user needs to
                                  // find it.
                                  revealSession(row.key, wt.path, {
                                    agent: extra.agent,
                                    source: extra.source,
                                  });
                                }}
                              >
                                {#if extra.agent === "claude"}
                                  <img class="agent-row-icon" src="/agents/claude.svg" alt="" />
                                {:else}
                                  <span class="agent-dot agent-{extra.agent}"></span>
                                {/if}
                                <span class="session-col-extra-title">
                                  {extra.manualTitle ?? extra.title ?? "(no title)"}
                                </span>
                                <span class="session-col-extra-meta">{relTime(extra.lastActive)}</span>
                              </button>
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                    <span class="sessions-strip-pad" aria-hidden="true"></span>
                  </div>
                {/if}
              {/if}

              <!-- Source-control foldout removed — git history now lives
                   in a session column (GitHistory.svelte). -->
            {/if}
          {/if}
          </div>
          </div>
        </li>
      {/each}
    </ul>
    <div class="add-folder-footer">
      <div class="add-folder-actions">
        <button
          class="add-folder-cta add-folder-cta-compact"
          on:click={pickAndAdd}
          disabled={addFolderBusy}
          title="Pick a folder to register as a repo"
        >
          {#if addFolderBusy}
            <LoadingSpinner size="0.8rem" />
            <span>Adding…</span>
          {:else}
            <svg
              class="add-folder-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <path d="M12 11v6" />
              <path d="M9 14h6" />
            </svg>
            <span>Add folder</span>
          {/if}
        </button>
        <div class="import-sessions-anchor" class:flip-up={importFlipUp}>
          <button
            class="add-folder-cta add-folder-cta-compact"
            on:click|stopPropagation={toggleImportSessions}
            aria-haspopup="menu"
            aria-expanded={importSessionsOpen}
            title="Suggest folders to add based on detected AI agent sessions"
          >
            <svg
              class="add-folder-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v12" />
              <path d="M7 10l5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            <span>Import from sessions</span>
          </button>
          {#if importSessionsOpen}
            <Popover variant="actions" extraClass="import-sessions-popover">
              <svelte:fragment slot="head">
                <div class="import-search-head">
                  <input
                    type="search"
                    class="import-search-input"
                    bind:value={importQuery}
                    placeholder="Folders from detected sessions"
                    aria-label="Filter folders from detected sessions"
                    use:focusOnMount
                    on:click|stopPropagation
                    on:keydown|stopPropagation
                  />
                  {#if importQuery.trim()}
                    <span class="import-search-count">{importFiltered.length}/{importSuggestions.length}</span>
                  {/if}
                </div>
              </svelte:fragment>
              {#if importLoading}
                <div class="import-empty">
                  <LoadingSpinner size="0.85rem" label="Scanning sessions" />
                  <span>scanning sessions…</span>
                </div>
              {:else if importError}
                <div class="import-empty import-error">{importError}</div>
              {:else if importFiltered.length === 0}
                <div class="import-empty muted">
                  {#if importQuery.trim()}
                    No folders match.
                  {:else}
                    No new folders to suggest — every detected session's cwd is
                    already in the dashboard.
                  {/if}
                </div>
              {:else}
                <ul class="import-list">
                  {#each importFiltered as sug (sug.path)}
                    {@const busy = importAdding.has(sug.path)}
                    <li>
                      <button
                        type="button"
                        class="import-row"
                        class:busy
                        disabled={busy}
                        on:click={() => addRepoFromSuggestion(sug.path)}
                        title={`Add ${sug.path} to the dashboard`}
                      >
                        <span class="import-row-main">
                          {#if busy}
                            <span class="import-row-name"><LoadingSpinner size="0.75rem" /> Importing…</span>
                          {:else}
                            <span class="import-row-name">{sug.name}</span>
                          {/if}
                          <span class="import-row-path muted small">{sug.path}</span>
                          {#if sug.repoUrl}
                            <span class="import-row-url muted small">{sug.repoUrl}</span>
                          {/if}
                        </span>
                        <span class="import-row-meta">
                          <span class="import-row-count">
                            <span class="import-row-agents-icons" aria-hidden="true">
                              {#each sug.agents as agent (agent)}
                                <AgentIcon {agent} size={14} />
                              {/each}
                            </span>
                            <span>
                              {sug.sessionCount} session{sug.sessionCount === 1 ? "" : "s"}
                            </span>
                          </span>
                          <span class="import-row-time muted small">
                            {formatRelativeTime(sug.lastActive)}
                          </span>
                          <span class="import-row-agents-names muted small">
                            {sug.agents.join(", ")}
                          </span>
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </Popover>
          {/if}
        </div>
      </div>
      <p class="add-folder-sub muted small">
        Track another folder — git repo or plain directory.
      </p>
    </div>
  {/if}
</main>

<SessionDock
  entries={dockEntries}
  {focusedSource}
  zen={zenRowKey !== null}
  on:pick={(e) => void onDockPick(e.detail)}
/>

<StickyNotesLayer changeKey={notesChangeKey} {repos} />

<ConfirmDialog />
<SummarizeDialog />
<ShareSessionDialog />
<ReceiveInviteDialog />
<CopySessionDialog />
<RepairSessionDialog />

{#if dirtyCheckout}
  <div
    class="modal-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dirty-title"
    tabindex="-1"
    on:click={(e) => {
      // Scrim click (NOT clicks on the modal itself) cancels — same as
      // hitting Esc in a real dialog. Modal contents stop the event.
      if (e.target === e.currentTarget) resolveDirty("cancel");
    }}
    on:keydown={(e) => {
      if (e.key === "Escape") resolveDirty("cancel");
    }}
  >
    <div class="modal" on:click|stopPropagation>
      <h3 id="dirty-title">Worktree has uncommitted changes</h3>
      <p class="modal-body">
        Switching to <code>{dirtyCheckout.branch}</code> in
        <code class="muted small">{dirtyCheckout.wtPath}</code>
        is blocked because the worktree is dirty. How would you like to handle
        your local changes?
      </p>
      <p class="modal-meta muted small">
        {dirtyCheckout.message}
      </p>
      <div class="modal-actions">
        <button
          class="modal-action modal-action-recommended"
          on:click={() => resolveDirty("stash")}
        >
          Stash &amp; switch
          <span class="modal-hint">git stash push (recoverable with stash pop)</span>
        </button>
        <button class="modal-action modal-action-danger" on:click={() => resolveDirty("force")}>
          Force &amp; switch
          <span class="modal-hint">discards uncommitted changes — cannot be undone</span>
        </button>
        <button class="modal-action modal-action-neutral" on:click={() => resolveDirty("cancel")}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

{#if dirtyPull}
  <div
    class="modal-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dirty-pull-title"
    tabindex="-1"
    on:click={(e) => {
      if (e.target === e.currentTarget) resolveDirtyPull("cancel");
    }}
    on:keydown={(e) => {
      if (e.key === "Escape") resolveDirtyPull("cancel");
    }}
  >
    <div class="modal" on:click|stopPropagation>
      <h3 id="dirty-pull-title">Pull would clobber uncommitted changes</h3>
      <p class="modal-body">
        Fast-forwarding
        <code class="muted small">{dirtyPull.wtPath}</code>
        is blocked because your local edits overlap the incoming commits.
        How would you like to handle your local changes?
      </p>
      <p class="modal-meta muted small">
        {dirtyPull.message}
      </p>
      <div class="modal-actions">
        <button
          class="modal-action modal-action-recommended"
          on:click={() => resolveDirtyPull("stash")}
        >
          Stash &amp; pull
          <span class="modal-hint">git stash push (recoverable with stash pop)</span>
        </button>
        <button class="modal-action modal-action-neutral" on:click={() => resolveDirtyPull("cancel")}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

{#if toasts.length > 0}
  <div class="toast-stack" role="region" aria-label="Notifications">
    {#each toasts as t (t.id)}
      <div
        class="toast toast-{t.kind}"
        class:toast-clickable={!!t.onClick}
        role={t.kind === "error" ? "alert" : "status"}
      >
        <span class="toast-icon" aria-hidden="true">
          {#if t.kind === "error"}!{:else if t.kind === "success"}✓{:else if t.kind === "invite"}⇆{:else}ℹ{/if}
        </span>
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div
          class="toast-body"
          class:toast-body-stacked={!!t.title}
          on:click={t.onClick ? () => { t.onClick?.(); dismissToast(t.id); } : undefined}
        >
          {#if t.title}<strong class="toast-title">{t.title}</strong>{/if}
          <span class="toast-message">{t.message}</span>
        </div>
        <button
          class="toast-close"
          on:click={() => dismissToast(t.id)}
          aria-label="Dismiss"
        >×</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  /*
   * App-wide CSS lives in packages/ui/src/styles/, imported from main.ts:
   *   tokens.css      — design tokens (colors, radii, scrollbars).
   *   base.css        — html/body resets, main layout, button/input
   *                     defaults, .muted/.small/.nopad utilities,
   *                     loading screen, error banner.
   *   popover.css     — Popover.svelte shell + variant overrides.
   *   agent-row.css   — .agent-row family used in every picker.
   *   new-session.css — transient new-session column shell + header.
   *   source-control.css — Unstaged/Staged tabs + diff + History.
   *   zen-row.css     — per-row "zen" focus layout.
   *   overlays.css    — dirty-checkout modal + toast stack.
   *   header.css      — top h1 strip + actions/events/tuis buttons.
   *   diagnostics.css — Recent actions + Errors list rows.
   *   worktree-row.css — .row layout, repo/branch chips, agent badge
   *                      cluster, status dot, ↑/↓ chips, new-wt, chevron.
   *   wt-picker.css   — worktree-picker rows + create-new + branch picker.
   *
   * App.svelte intentionally has no scoped <style> rules of its own.
   * Anything new shared across the dashboard should land in styles/
   * rather than in this block — see plans/PLAN.md → "App.svelte
   * refactor (componentization)".
   */
</style>
