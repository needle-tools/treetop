<script lang="ts">
  import { onMount } from "svelte";
  import { ExpandedStore } from "./storage";
  import DiffViewer from "./DiffViewer.svelte";
  import SessionView from "./SessionView.svelte";
  import ShellView from "./ShellView.svelte";
  import Popover from "./Popover.svelte";
  import SourceControlPane from "./SourceControlPane.svelte";
  import Tooltip from "./Tooltip.svelte";
  import NewSessionCol from "./NewSessionCol.svelte";
  import {
    OpenSessionsStore,
    VisibleWorktreesStore,
    cmdForOpenSession,
    effectiveVisibleWorktrees,
    filterToExistingSessions,
    setSessionMode,
    stampDiscoveredSessionId,
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

  interface FileStatus {
    staged: number;
    unstaged: number;
    untracked: number;
  }
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
     *  alongside Claude/Codex/Copilot. The daemon only ever returns
     *  "claude" / "codex" / "copilot" here. */
    agent: "claude" | "codex" | "copilot" | "shell";
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
  }
  interface ShellRecord {
    termId: string;
    wt: string;
    spawnCwd: string;
    currentCwd?: string;
    createdAt: string;
    alive: boolean;
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
  }
  interface Repo {
    id: string;
    path: string;
    name: string;
    addedAt: string;
    worktrees: Worktree[];
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
  /** Shells (Terminal columns the daemon is hosting / has hosted). Used
   *  by the worktree session picker so past + live shells appear next
   *  to Claude/Codex agent sessions instead of hiding under a separate
   *  affordance. Refreshed alongside /api/repos in `load()`. */
  let allShells: ShellRecord[] = [];
  let loading = false;
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
    kind: "error" | "info" | "success";
    message: string;
    title?: string;
  }
  let toasts: Toast[] = [];
  let toastSeq = 0;
  const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  function addToast(opts: { kind: Toast["kind"]; message: string; title?: string; ttlMs?: number }): number {
    if (!opts.message) return -1;
    const id = ++toastSeq;
    toasts = [...toasts, { id, kind: opts.kind, message: opts.message, title: opts.title }];
    const ttl = opts.ttlMs ?? (opts.kind === "error" ? 12_000 : 7_000);
    toastTimers.set(
      id,
      setTimeout(() => dismissToast(id), ttl),
    );
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

  // The unique row key (repoId + worktree path) currently being renamed.
  // Was just editingRepoId — but repos with multiple worktrees produce
  // multiple rows for the same repo, so a repo-id match would render two
  // inputs at once and the bind:value + focus() race breaks typing.
  let editingRowKey: string | null = null;
  let editingRepoId: string | null = null;
  let editRepoName = "";

  let actionsOpen = false;
  let eventsOpen = false;
  /** Per-row "zen" focus — one worktree row takes over the viewport,
   *  hiding the top bar and all other rows. `null` = no row focused.
   *  Toggled from the row-head; Esc exits. Purely cosmetic, no state
   *  persisted to workspace. */
  let zenRowKey: string | null = null;
  function toggleZenRow(key: string) {
    zenRowKey = zenRowKey === key ? null : key;
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

  /** "TUIs" header popover — global view of every PTY supergit is
   *  hosting right now (cpu/mem per row, click × to dispose). */
  interface TuiProc {
    id: string;
    pid: number;
    agent?: string;
    cmd: string[];
    cwd: string;
    ownerId?: string;
    createdAt: string;
    cpuPercent: number;
    memBytes: number;
  }
  let tuisOpen = false;
  let tuiProcs: TuiProc[] = [];
  let tuiPollTimer: ReturnType<typeof setInterval> | null = null;
  // `/api/processes` samples cpu/mem per pid and can take a beat on a
  // busy machine. Without this flag the popover flashes "Nothing running"
  // during the first fetch even when there are TUIs.
  let tuisEverLoaded = false;
  let tuisLoading = false;

  async function refreshTuis() {
    tuisLoading = true;
    try {
      const res = await fetch("/api/processes");
      if (!res.ok) return;
      tuiProcs = (await res.json()) as TuiProc[];
      tuisEverLoaded = true;
    } catch {
      // ignore network blips; we'll catch up on the next tick
    } finally {
      tuisLoading = false;
    }
  }

  /** TUI poll cadence: slow (10s) when only the count is on display in
   *  the header button, fast (2s) when the popover is open and live
   *  cpu/mem values are visible. `/api/processes` runs `ps` to sample
   *  per-pid usage so 2s-always isn't free; 10s for the background
   *  case is barely measurable and keeps the badge accurate enough. */
  const TUI_SLOW_MS = 10_000;
  const TUI_FAST_MS = 2_000;
  function startTuiPolling(intervalMs: number) {
    if (tuiPollTimer) clearInterval(tuiPollTimer);
    void refreshTuis();
    tuiPollTimer = setInterval(refreshTuis, intervalMs);
  }
  function stopTuiPolling() {
    if (tuiPollTimer) {
      clearInterval(tuiPollTimer);
      tuiPollTimer = null;
    }
  }
  function toggleTuisOpen() {
    tuisOpen = !tuisOpen;
    // Speed up while the popover is on screen so the cpu/mem rows feel
    // live; otherwise drop back to the slow background cadence that
    // keeps the header-button count fresh.
    startTuiPolling(tuisOpen ? TUI_FAST_MS : TUI_SLOW_MS);
  }
  async function killTui(id: string) {
    await fetch(`/api/terminals/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => {});
    void refreshTuis();
  }

  function formatBytes(n: number): string {
    if (!n) return "—";
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  function prettyTuiName(p: TuiProc): string {
    if (p.agent === "claude") return "Claude";
    if (p.agent === "codex") return "Codex";
    if (p.agent === "copilot") return "Copilot";
    // Fall through: show the actual executable basename (e.g. "bash",
    // "zsh") for shell sessions, or whatever cmd[0] resolves to.
    const head = p.cmd[0]?.split(/[\\/]/).pop();
    return head || "tui";
  }
  function formatUptime(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // Per worktree: is the "all sessions" popover next to the agent badge open?
  let agentsPopoverOpen: Record<string, boolean> = {};

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
  // Agent CLIs we detected on PATH at the daemon. Loaded once on mount.
  let installedAgents: { name: string; path: string }[] = [];
  // Per-worktree: is the "+ new agent" popover open?
  let newAgentPopoverOpen: Record<string, boolean> = {};

  // Per transient session source: is the agent paused on a prompt
  // waiting for user input? Surfaced as an outlined column + a small
  // "needs input" pill in the header. Cleared when the agent emits
  // any output that no longer matches the prompt pattern, or when
  // the user types something.
  let transientAwaiting: Record<string, boolean> = {};
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

  /** Unified Dispose handler for live new-session columns. Shell flips
   *  to a `__transcript__:shell:` source so ShellView takes over (the
   *  user can Resume later). Claude / Codex / Copilot just kill the
   *  PTY and leave the column open showing final output — same as the
   *  agent's own `exit` would do — so the user can read the last
   *  message before × ing. */
  async function disposeNewSessionColumn(
    wtPath: string,
    s: { agent: string; source: string },
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
        // Shell: replace the source in place so the column survives
        // and flips to ShellView (command history + Resume).
        const transcriptSource = `__transcript__:shell:${termId}`;
        openSessionsByWt = {
          ...openSessionsByWt,
          [wtPath]: (openSessionsByWt[wtPath] ?? []).map((x) =>
            x.source === s.source
              ? { agent: "shell", source: transcriptSource }
              : x,
          ),
        };
        // Mark the now-defunct `__attached__:shell:<id>` form as
        // dismissed so a UI reload while the daemon's 30s grace timer
        // is still alive doesn't have restoreLiveShells add the live
        // attachment alongside the transcript — the duplicate-column +
        // "always opens in TUI mode after reload" bug.
        dismissShellSource(`__attached__:shell:${termId}`);
      }
      // Claude / Codex / Copilot: no source-swap. The column keeps its
      // existing `__new__:claude:…` / `__attached__:codex:…` source;
      // TerminalView's onExit handler is a deliberate no-op so the
      // dead xterm stays visible until the user ×s.
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

  /** Open a brand-new agent session in this worktree. Adds a transient
   *  open-session entry whose source is sentinel-prefixed with
   *  `__new__:` — the column rendering branches on that to render
   *  TerminalView directly instead of the read-mode SessionView. */
  function openNewAgentSession(wtPath: string, agent: "claude" | "codex") {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:${agent}:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: [{ agent, source: synthetic }, ...existing],
    };
  }

  /** Open a brand-new "Terminal" column in this worktree — a plain PTY
   *  running the user's $SHELL. Mirrors `openNewAgentSession` but uses
   *  agent="shell"; the render branch picks `defaultShell` as the cmd. */
  function openNewTerminalInWt(wtPath: string) {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const synthetic = `__new__:shell:${id}`;
    const existing = openSessionsByWt[wtPath] ?? [];
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: [{ agent: "shell", source: synthetic }, ...existing],
    };
  }

  async function loadDefaultShell() {
    try {
      const res = await fetch("/api/shell-default");
      if (!res.ok) return;
      const body = (await res.json()) as { shell?: unknown };
      if (typeof body.shell === "string" && body.shell.length > 0) {
        defaultShell = body.shell;
      }
    } catch {
      // best-effort — keeps the /bin/zsh fallback
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
      const raw = localStorage.getItem(DISMISSED_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  })();
  function saveDismissedShells() {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedShells]));
    } catch {
      // localStorage full / disabled — best effort; runtime state stays consistent.
    }
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
    const replacement = {
      agent: current.agent as "claude" | "codex" | "copilot",
      source: `__new__:${current.agent}:${id}`,
    };
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

  /** Persist a manual title for a `__new__:` / `__attached__:` source.
   *  Called from NewSessionCol via `on:titleSave` with the trimmed
   *  string already in hand. */
  async function saveNewSessionTitle(source: string, next: string) {
    const prev = newSessionTitles[source] ?? "";
    if (next === prev) return;
    try {
      const res = await fetch("/api/session/title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, title: next }),
      });
      if (!res.ok) return;
      newSessionTitles = next
        ? { ...newSessionTitles, [source]: next }
        : (({ [source]: _, ...rest }) => rest)(newSessionTitles);
      // Refresh /api/repos so a worktree row reflects the new title the
      // moment its real JSONL takes over from the synthetic source.
      void load();
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
    agent: AgentSession["agent"] | "shell";
    source: string;
    /** Optional. Stamped on `__new__:claude:` / `__new__:codex:` columns
     *  by the activity-SSE handler once the daemon surfaces a real
     *  agent-side session id for this (cwd, agent). Survives reload via
     *  `OpenSessionsStore`. On remount, `cmdForOpenSession` uses it to
     *  spawn `claude --resume <sid>` instead of bare `claude`. */
    resumeSessionId?: string;
    /** Optional. `"terminal"` means SessionView should hydrate in
     *  terminal mode on remount (i.e. immediately spawn the resume PTY
     *  instead of showing the read-only chat view). Absent ⇒ read. */
    mode?: "terminal";
  }
  let openSessionsByWt: Record<string, OpenSession[]> = {};

  /** The user's default login shell (env $SHELL), fetched once on mount
   *  from /api/shell-default. Used when the user picks "Terminal" from
   *  the new-session menu so we spawn the right shell instead of
   *  hardcoding bash/zsh in the frontend. */
  let defaultShell: string = "/bin/zsh";

  function isOpenInWt(wtPath: string, source: string): boolean {
    return (openSessionsByWt[wtPath] ?? []).some((s) => s.source === source);
  }
  function toggleOpenSessionInWt(wtPath: string, s: OpenSession): void {
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
    const strip = document.querySelector(
      `[data-wt-strip="${CSS.escape(wtPath)}"]`,
    ) as HTMLElement | null;

    let underlyingInsertAt = 0;
    if (strip) {
      const scrollLeft = strip.scrollLeft;
      const cols = strip.querySelectorAll<HTMLElement>(".session-col");
      for (const col of cols) {
        const colRight = col.offsetLeft + col.offsetWidth;
        // The first column whose right edge is at least 50px past the
        // current scroll offset is the leftmost "visible" column.
        if (colRight - scrollLeft >= 50) {
          const targetSource = col.dataset.sessionSource;
          if (targetSource) {
            const u = list.findIndex((x) => x.source === targetSource);
            if (u >= 0) underlyingInsertAt = u;
          }
          break;
        }
      }
    }

    const next = [...list];
    next.splice(underlyingInsertAt, 0, s);
    openSessionsByWt = { ...openSessionsByWt, [wtPath]: next };

    requestAnimationFrame(() => {
      const strip2 = document.querySelector(
        `[data-wt-strip="${CSS.escape(wtPath)}"]`,
      ) as HTMLElement | null;
      if (!strip2) return;
      const newCol = strip2.querySelector<HTMLElement>(
        `.session-col[data-session-source="${CSS.escape(s.source)}"]`,
      );
      if (!newCol) return;
      strip2.scrollTo({ left: newCol.offsetLeft, behavior: "smooth" });
    });
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
    openSessionsByWt = {
      ...openSessionsByWt,
      [wtPath]: (openSessionsByWt[wtPath] ?? []).filter(
        (x) => x.source !== s.source,
      ),
    };
  }

  // Drag-to-reorder for sessions inside one worktree's strip. We don't
  // (yet) move sessions between worktrees — that's a bigger UX choice.
  let dragSource: { wtPath: string; index: number } | null = null;

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

  function handleSessionDragOver(e: DragEvent): void {
    if (!dragSource) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function handleSessionDrop(
    e: DragEvent,
    wtPath: string,
    targetIndex: number,
  ): void {
    e.preventDefault();
    const src = dragSource;
    dragSource = null;
    if (!src || src.wtPath !== wtPath) return;
    if (src.index === targetIndex) return;
    const list = openSessionsByWt[wtPath] ?? [];
    const item = list[src.index];
    if (!item) return;
    const next = [...list];
    next.splice(src.index, 1);
    next.splice(targetIndex, 0, item);
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

  const expandedStore = new ExpandedStore(
    typeof window !== "undefined"
      ? window.localStorage
      : ({ getItem: () => null, setItem: () => {} }),
    "supergit:commitsExpanded",
  );
  const openSessionsPersistence = new OpenSessionsStore(
    typeof window !== "undefined"
      ? window.localStorage
      : ({ getItem: () => null, setItem: () => {} }),
    "supergit:openSessions",
  );
  const visibleWorktreesPersistence = new VisibleWorktreesStore(
    typeof window !== "undefined"
      ? window.localStorage
      : ({ getItem: () => null, setItem: () => {} }),
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
    typeof window !== "undefined"
      ? window.localStorage
      : ({ getItem: () => null, setItem: () => {} }),
    "supergit:foldedRows",
  );
  let rowFolded: Record<string, boolean> = {};
  let foldedHydrated = false;
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
  function toggleRowFolded(rowKey: string) {
    rowFolded = { ...rowFolded, [rowKey]: !rowFolded[rowKey] };
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

  async function load() {
    loading = true;
    error = "";
    try {
      const [r, e, s] = await Promise.all([
        fetch("/api/repos"),
        fetch("/api/events"),
        fetch("/api/shells"),
      ]);
      if (!r.ok) throw new Error(`/api/repos: ${r.status}`);
      if (!e.ok) throw new Error(`/api/events: ${e.status}`);
      repos = await r.json();
      events = await e.json();
      // /api/shells failing is non-fatal — empty list just means no
      // shell entries surface in the worktree picker this cycle.
      if (s.ok) allShells = (await s.json()) as ShellRecord[];
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function pickAndAdd() {
    error = "";
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
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
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

  async function removeRepo(id: string) {
    error = "";
    try {
      const res = await fetch(`/api/repos/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
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
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function openIn(path: string, app: string) {
    error = "";
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

  function subscribeToStream(): () => void {
    const es = new EventSource("/api/stream");
    es.addEventListener("change", (rawEvt: MessageEvent) => {
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
      if (payload.kind !== "fs_change" || typeof payload.path !== "string") return;
      const wtPath = payload.path;
      fsChangeKey = { ...fsChangeKey, [wtPath]: (fsChangeKey[wtPath] ?? 0) + 1 };
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
        const stamped = stampDiscoveredSessionId(openSessionsByWt, ev);
        if (stamped !== openSessionsByWt) openSessionsByWt = stamped;
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
    return ev.type;
  }

  function relTime(iso: string): string {
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return `${Math.floor(d)}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  /** Once the oldest unpushed commit is older than this, the green
   *  "ahead" pill brightens + thickens to signal staleness. Matches
   *  the tentative threshold in PLAN.md's reminder-rules section. */
  const STALE_AHEAD_HOURS = 4;

  function aheadStale(b: BranchStatus): boolean {
    if (!b.aheadOldestTime) return false;
    const ageH = (Date.now() - Date.parse(b.aheadOldestTime)) / 3_600_000;
    return ageH >= STALE_AHEAD_HOURS;
  }

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
  interface WtSummary {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    unpushedCommits: { sha: string; subject: string }[];
  }
  let wtSummaryByPath: Record<string, WtSummary | "loading"> = {};

  async function loadWtSummary(path: string): Promise<void> {
    // Skip if already in flight or fetched; the tooltip always shows
    // the freshest cached value. The next fs_change SSE would normally
    // invalidate this, but tooltips are ephemeral enough that we can
    // wait for the user to re-hover.
    if (wtSummaryByPath[path]) return;
    wtSummaryByPath = { ...wtSummaryByPath, [path]: "loading" };
    try {
      const qs = new URLSearchParams({ path });
      const res = await fetch(`/api/wt-summary?${qs.toString()}`);
      if (!res.ok) {
        // Drop the loading sentinel so a next hover retries.
        const next = { ...wtSummaryByPath };
        delete next[path];
        wtSummaryByPath = next;
        return;
      }
      const data = (await res.json()) as WtSummary;
      wtSummaryByPath = { ...wtSummaryByPath, [path]: data };
    } catch {
      const next = { ...wtSummaryByPath };
      delete next[path];
      wtSummaryByPath = next;
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

  function statusSummary(s: FileStatus): { clean: boolean; text: string } {
    const total = s.staged + s.unstaged + s.untracked;
    if (total === 0) return { clean: true, text: "clean" };
    const parts: string[] = [];
    if (s.staged) parts.push(`${s.staged} staged`);
    if (s.unstaged) parts.push(`${s.unstaged} unstaged`);
    if (s.untracked) parts.push(`${s.untracked} untracked`);
    return { clean: false, text: parts.join(", ") };
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

  /** Map shell records into the same shape as AgentSession so the picker
   *  can iterate one merged list. The `source` is the synthetic
   *  attached/transcript token openSessionsByWt expects, so clicking a
   *  picker row routes through `toggleOpenSessionInWt` unchanged. */
  function shellToSession(sh: ShellRecord): AgentSession {
    return {
      agent: "shell",
      cwd: sh.wt,
      lastActive: sh.createdAt,
      source: sh.alive
        ? `__attached__:shell:${sh.termId}`
        : `__transcript__:shell:${sh.termId}`,
      title: sh.currentCwd ?? sh.spawnCwd,
      sessionId: sh.termId,
    };
  }

  /** wt.path → agents + shells merged, sorted by lastActive desc.
   *  Drives the "+N sessions in this worktree" picker. */
  $: pickerSessionsByWt = ((): Record<string, AgentSession[]> => {
    const m: Record<string, AgentSession[]> = {};
    for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        const merged: AgentSession[] = [...(wt.agents ?? [])];
        for (const sh of allShells) {
          if (sh.wt === wt.path) merged.push(shellToSession(sh));
        }
        merged.sort(
          (a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive),
        );
        m[wt.path] = merged;
      }
    }
    return m;
  })();

  function handleDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (actionsOpen && !target?.closest(".actions-anchor")) {
      actionsOpen = false;
    }
    if (eventsOpen && !target?.closest(".events-anchor")) {
      eventsOpen = false;
    }
    if (tuisOpen && !target?.closest(".tuis-anchor")) {
      tuisOpen = false;
      stopTuiPolling();
    }
    // Close any open "new agent" picker the click landed outside of.
    for (const key of Object.keys(newAgentPopoverOpen)) {
      if (!newAgentPopoverOpen[key]) continue;
      const anchor = target?.closest(`[data-new-agent-anchor="${key}"]`);
      if (!anchor) {
        newAgentPopoverOpen = { ...newAgentPopoverOpen, [key]: false };
      }
    }
    // Close any open branch picker the click landed outside of.
    for (const key of Object.keys(branchPickerOpen)) {
      if (!branchPickerOpen[key]) continue;
      const anchor = target?.closest(`[data-branch-anchor="${key}"]`);
      if (!anchor) {
        branchPickerOpen = { ...branchPickerOpen, [key]: false };
      }
    }
    // Close any open worktree-picker popover the click landed outside of.
    for (const key of Object.keys(wtPickerOpen)) {
      if (!wtPickerOpen[key]) continue;
      const anchor = target?.closest(`[data-wt-picker-anchor="${key}"]`);
      if (!anchor) {
        wtPickerOpen = { ...wtPickerOpen, [key]: false };
      }
    }
    // Any open agents popovers that the click landed outside of: close them.
    for (const key of Object.keys(agentsPopoverOpen)) {
      if (!agentsPopoverOpen[key]) continue;
      const anchor = target?.closest(`[data-agents-anchor="${key}"]`);
      if (!anchor) {
        agentsPopoverOpen = { ...agentsPopoverOpen, [key]: false };
      }
    }
  }

  // Svelte action: focus + select the node when it's mounted. Used on the
  // rename input so clicking the repo chip drops you straight into typing.
  function focusAndSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
    return {};
  }

  onMount(() => {
    restoreExpanded();
    restoreOpenSessions();
    restoreVisibleWorktrees();
    restoreFoldedRepos();
    void loadInstalledAgents();
    void loadEditors();
    void loadDefaultShell();
    void restoreLiveShells();
    // Background-poll the TUI count so the header button shows it
    // before the popover is opened. Switches to a faster cadence in
    // `toggleTuisOpen` when the popover is on screen.
    startTuiPolling(TUI_SLOW_MS);
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
        zenRowKey = null;
      }
    };
    document.addEventListener("keydown", handleKey);
    const unsubStream = subscribeToStream();
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKey);
      stopTuiPolling();
      unsubStream();
      unsubErrors();
    };
  });
</script>

<main class:zen-row={zenRowKey !== null}>
  <header>
    <h1>
      <img src="/needle-logo.svg" alt="" class="brand-mark" />
      supergit
      <span
        class="live"
        class:on={streamConnected}
        title={streamConnected ? "live (SSE connected)" : "offline (SSE disconnected)"}
      >
        {streamConnected ? "● live" : "○ offline"}
      </span>

      <button
        class="actions-btn add-folder-btn"
        on:click={pickAndAdd}
        title="Pick a folder to register as a repo"
      >Add folder</button>

      <div class="actions-anchor tuis-anchor">
        <button
          class="actions-btn"
          class:open={tuisOpen}
          on:click={toggleTuisOpen}
          title="Active TUIs (terminals supergit is hosting)"
        >
          TUIs
          <!-- Always-rendered so the button width stays stable whether
               there are 0 TUIs or 12. -->
          <span class="count">{tuiProcs.length}</span>
        </button>
        {#if tuisOpen}
          <Popover variant="actions" extraClass="tuis-popover">
            <svelte:fragment slot="head">
              Active TUIs
              {#if tuisLoading}
                <span class="popover-spinner" aria-label="loading" title="refreshing"></span>
              {/if}
            </svelte:fragment>
            {#if !tuisEverLoaded}
              <p class="muted small nopad">Loading…</p>
            {:else if tuiProcs.length === 0}
              <p class="muted small nopad">Nothing running.</p>
            {:else}
              <ul class="agents-list">
                {#each tuiProcs as p (p.id)}
                  <li>
                    <div class="agent-row brand-{p.agent ?? 'shell'} tui-row-static">
                      {#if p.agent === "claude"}
                        <img class="agent-row-icon" src="/agents/claude.svg" alt="" />
                      {:else if p.agent === "codex"}
                        <img class="agent-row-icon" src="/agents/codex.svg" alt="" />
                      {:else}
                        <span class="agent-dot agent-{p.agent ?? 'shell'}"></span>
                      {/if}
                      <span class="agent-row-name">{prettyTuiName(p)}</span>
                      <span
                        class="tui-stats"
                        title={`pid ${p.pid} — ${p.cmd.join(" ")}`}
                      >
                        {p.cpuPercent.toFixed(1)}% · {formatBytes(p.memBytes)} · {formatUptime(p.createdAt)}
                      </span>
                      <span>
                        <!-- empty -->
                      </span>
                      <button
                        class="row-close tui-kill-x"
                        on:click={() => killTui(p.id)}
                        title="Dispose (SIGTERM → SIGKILL)"
                        aria-label="Kill terminal"
                      >×</button>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </Popover>
        {/if}
      </div>

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
    </h1>
    <p class="muted">multi-repo, multi-agent, worktree-first dashboard</p>
  </header>

  {#if loading && repos.length === 0}
    <div class="loading-screen">
      <div class="loading-overlay">
        <span class="spinner" aria-hidden="true"></span> loading repos…
      </div>
    </div>
  {:else if rows.length === 0}
    <p class="muted">No repos registered yet. Pick a folder above to start.</p>
  {:else}
    <ul class="rows">
      {#each rows as row (row.key)}
        {@const { repo, wt } = row}
        {@const summary = wt ? statusSummary(wt.fileStatus) : null}
        <li
          class="row"
          class:row-folded={rowFolded[row.key]}
          class:row-zen={zenRowKey === row.key}
          data-wt-row={wt ? wt.path : `${repo.id}|none`}
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
              on:click|stopPropagation={() => toggleRowFolded(row.key)}
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
              <button
                class="repo-chip"
                title="Rename repo"
                on:click={() => startRenameRepo(repo, row.key)}
              >
                {repo.name}
                <span class="pencil">✎</span>
              </button>
            {/if}

            {#if wt}
              {#if wt.detached}
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
                  >{wt.branch} <span class="branch-caret" aria-hidden="true">▾</span></button>
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
              {#if wt}
                {@const a = (wt.agents && wt.agents.length > 0) ? wt.agents[0] : null}
                {@const pickerSessions = pickerSessionsByWt[wt.path] ?? wt.agents ?? []}
                <span class="agent-wrap" data-agents-anchor={wt.path} data-new-agent-anchor={wt.path}>
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
                            <button
                              class="agent-row new-agent-row"
                              on:click={() => {
                                newAgentPopoverOpen = { ...newAgentPopoverOpen, [wt.path]: false };
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
                              openNewTerminalInWt(wt.path);
                            }}
                            title={`Spawn ${defaultShell} as a plain terminal in ${wt.path}`}
                          >
                            <span class="agent-dot agent-shell"></span>
                            <span class="agent-row-name">Terminal</span>
                            <span class="agent-title muted">{defaultShell}</span>
                          </button>
                        </li>
                      </ul>
                    </Popover>
                  {/if}
                  {#if a}
                  <button
                    class="agent-badge agent-{a.agent}"
                    class:active={isOpenInWt(wt.path, a.source)}
                    title={`${a.manualTitle ?? `Open the latest ${a.agent} session`}\nLast active ${relTime(a.lastActive)}`}
                    on:click={() =>
                      toggleOpenSessionInWt(wt.path, {
                        agent: a.agent,
                        source: a.source,
                      })}
                  >
                    <span class="agent-dot"></span>
                    {#if a.manualTitle}
                      <span class="agent-manual-title">{a.manualTitle}</span>
                      <span class="muted small">· {relTime(a.lastActive)}</span>
                    {:else}
                      {a.agent} · {relTime(a.lastActive)}
                    {/if}
                  </button>
                  {/if}
                  {#if a && pickerSessions.length > 1}
                    <button
                      class="agent-more agent-{a.agent}"
                      title={`Pick from ${pickerSessions.length} sessions in this worktree`}
                      on:click|stopPropagation={() => {
                        agentsPopoverOpen = {
                          ...agentsPopoverOpen,
                          [wt.path]: !agentsPopoverOpen[wt.path],
                        };
                      }}
                    >+{pickerSessions.length - 1}</button>
                    {#if agentsPopoverOpen[wt.path]}
                      <Popover variant="agents">
                        <svelte:fragment slot="head">
                          {pickerSessions.length} sessions in this worktree
                        </svelte:fragment>
                        <ul class="agents-list">
                          {#each pickerSessions as sess (sess.source)}
                            <li>
                              <button
                                class="agent-row brand-{sess.agent}"
                                class:dimmed={isOpenInWt(wt.path, sess.source)}
                                title={isOpenInWt(wt.path, sess.source)
                                  ? "Already open — click to close"
                                  : sess.title}
                                on:click={() => {
                                  toggleOpenSessionInWt(wt.path, {
                                    agent: sess.agent,
                                    source: sess.source,
                                  });
                                  agentsPopoverOpen = {
                                    ...agentsPopoverOpen,
                                    [wt.path]: false,
                                  };
                                }}
                              >
                                {#if sess.agent === "claude"}
                                  <img
                                    class="agent-row-icon"
                                    src="/agents/claude.svg"
                                    alt=""
                                  />
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
                                  title={sessionTooltip(sess)}
                                >
                                  {sess.manualTitle ?? sess.title ?? "(no title)"}
                                </span>
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
                                <!-- Close affordance: space reserved for every
                                     row to avoid layout shift; only visible
                                     (and clickable) on hover of an already-
                                     open row. -->
                                <span
                                  class="row-close"
                                  aria-hidden={!isOpenInWt(wt.path, sess.source)}
                                  on:click|stopPropagation={() => {
                                    if (isOpenInWt(wt.path, sess.source)) {
                                      toggleOpenSessionInWt(wt.path, {
                                        agent: sess.agent,
                                        source: sess.source,
                                      });
                                    }
                                  }}
                                  title="Close this session"
                                >×</span>
                              </button>
                            </li>
                          {/each}
                        </ul>
                      </Popover>
                    {/if}
                  {/if}
                </span>
              {/if}
              <code class="wt-path">{wt.path}</code>
            {:else}
              <code class="wt-path">{repo.path}</code>
              <span class="branch warn">no worktrees</span>
            {/if}

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
                          <span class="agent-row-name">{wOption.branch}</span>
                          <span class="agent-title">{wOption.path}</span>
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
                        </div>
                      </li>
                    {/each}
                  </ul>
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
              class="remove"
              title={wt
                ? "Hide this worktree's row from the dashboard. Worktree directory on disk is NOT deleted; the repo stays in supergit. Re-show via the worktrees picker."
                : "Remove this repo from supergit's workspace."}
              on:click={() => {
                if (wt) {
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

          {#if !rowFolded[row.key]}
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

          {#if wt && activityByCwd[wt.path] && activityByCwd[wt.path].length > 0}
            {@const latest = activityByCwd[wt.path][0]}
            <div class="row-activity" title={`source: ${latest.source}`}>
              <span class="agent-dot agent-{latest.agent}"></span>
              <span class="activity-text">{latest.summary}</span>
              <span class="activity-time muted">{relTime(latest.timestamp)}</span>
            </div>
          {/if}

          {#if wt && summary}
            <div class="row-status">
              <span
                class="status-dot"
                class:clean={summary.clean}
                title={summary.text}
              ></span>
              {#if summary.clean}
                <span class="muted small">{summary.text}</span>
              {:else}
                <Tooltip onShow={() => loadWtSummary(wt.path)}>
                  <span slot="trigger" class="muted small status-summary-trigger">{summary.text}</span>
                  <span slot="content" class="wt-tt-content">
                    {#if wtSummaryByPath[wt.path] === undefined || wtSummaryByPath[wt.path] === "loading"}
                      <span class="muted small">Loading…</span>
                    {:else}
                      {@const s = wtSummaryByPath[wt.path]}
                      {#if s !== "loading" && s !== undefined}
                        {#if s.staged.length > 0}
                          <div class="wt-tt-section">
                            <div class="wt-tt-section-head">staged ({s.staged.length})</div>
                            {#each s.staged as p}<div class="wt-tt-path">{p}</div>{/each}
                          </div>
                        {/if}
                        {#if s.unstaged.length > 0}
                          <div class="wt-tt-section">
                            <div class="wt-tt-section-head">unstaged ({s.unstaged.length})</div>
                            {#each s.unstaged as p}<div class="wt-tt-path">{p}</div>{/each}
                          </div>
                        {/if}
                        {#if s.untracked.length > 0}
                          <div class="wt-tt-section">
                            <div class="wt-tt-section-head">untracked ({s.untracked.length})</div>
                            {#each s.untracked as p}<div class="wt-tt-path">{p}</div>{/each}
                          </div>
                        {/if}
                      {/if}
                    {/if}
                  </span>
                </Tooltip>
              {/if}
              {#if wt.branchStatus && wt.branchStatus.upstream}
                {#if wt.branchStatus.ahead > 0 || wt.branchStatus.behind > 0}
                  {#if wt.branchStatus.ahead > 0}
                    <Tooltip onShow={() => loadWtSummary(wt.path)}>
                      <span
                        slot="trigger"
                        class="ab ab-ahead"
                        class:ab-ahead-stale={aheadStale(wt.branchStatus)}
                      >↑{wt.branchStatus.ahead}</span>
                      <span slot="content" class="wt-tt-content">
                        <div class="wt-tt-section-head">{aheadTooltip(wt.branchStatus)}</div>
                        {#if wtSummaryByPath[wt.path] === undefined || wtSummaryByPath[wt.path] === "loading"}
                          <span class="muted small">Loading commits…</span>
                        {:else}
                          {@const s = wtSummaryByPath[wt.path]}
                          {#if s !== "loading" && s !== undefined && s.unpushedCommits.length > 0}
                            {#each s.unpushedCommits as c}
                              <div class="wt-tt-commit">
                                <span class="wt-tt-sha">{c.sha.slice(0, 7)}</span>
                                <span class="wt-tt-subject">{c.subject}</span>
                              </div>
                            {/each}
                          {/if}
                        {/if}
                      </span>
                    </Tooltip>
                  {/if}
                  {#if wt.branchStatus.behind > 0}
                    <span
                      class="ab ab-behind"
                      title={`${wt.branchStatus.behind} commit${wt.branchStatus.behind === 1 ? "" : "s"} to pull from ${wt.branchStatus.upstream}`}
                    >↓{wt.branchStatus.behind}</span>
                  {/if}
                {:else}
                  <span class="muted small">in sync</span>
                {/if}
              {:else if !wt.detached && !wt.bare && wt.branchStatus}
                <span class="muted small">no upstream</span>
              {/if}

              <div class="row-actions">
                {#each editors as ed}
                  <button
                    class="tiny"
                    on:click={() => openIn(wt.path, ed.cmd)}
                    title={`Open in ${ed.name}`}>{ed.name}</button
                  >
                {/each}
                <button
                  class="tiny"
                  on:click={() => openIn(wt.path, "fork")}
                  title="Open in Fork">Fork</button
                >
                <button
                  class="tiny"
                  on:click={() => openIn(wt.path, "terminal")}
                  title="Open in terminal">Terminal</button
                >
                <button
                  class="tiny"
                  on:click={() => openIn(wt.path, "files")}
                  title="Reveal in file manager">{fileManagerLabel()}</button
                >
              </div>
            </div>

            {#if wt.lastCommit}
              {#if wt && (openSessionsByWt[wt.path]?.length ?? 0) > 0}
                {@const existingSources = new Set(
                  (wt.agents ?? []).map((a) => a.source),
                )}
                {@const visibleSessions = filterToExistingSessions(
                  openSessionsByWt[wt.path] ?? [],
                  existingSources,
                )}
                {#if visibleSessions.length > 0}
                  <div class="sessions-strip" data-wt-strip={wt.path}>
                    {#each visibleSessions as s, i (s.source)}
                      <div
                        class="session-col"
                        data-session-source={s.source}
                        on:dragover={handleSessionDragOver}
                        on:drop={(e) =>
                          handleSessionDrop(e, wt.path, i)}
                      >
                        {#if s.source.startsWith("__transcript__:")}
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
                          <NewSessionCol
                            agent={s.agent}
                            source={s.source}
                            wtPath={wt.path}
                            cmd={cmdForOpenSession(s, defaultShell)}
                            cwd={shellResumeCwd[s.source] ?? wt.path}
                            procName={`supergit-tui-new-${s.agent}`}
                            attachTermId={s.source.startsWith("__attached__:")
                              ? s.source.split(":").pop()
                              : undefined}
                            manualTitle={newSessionTitles[s.source]}
                            awaiting={!!transientAwaiting[s.source]}
                            on:close={() => closeSessionInWt(wt.path, s)}
                            on:dispose={() => disposeNewSessionColumn(wt.path, s)}
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
                                openSessionsByWt = {
                                  ...openSessionsByWt,
                                  [wt.path]: (openSessionsByWt[wt.path] ?? []).map(
                                    (x) =>
                                      x.source === s.source
                                        ? { ...x, source: attachedSource }
                                        : x,
                                  ),
                                };
                              }
                            }}
                            on:awaitingChange={(e) => {
                              transientAwaiting = {
                                ...transientAwaiting,
                                [s.source]: e.detail.awaiting,
                              };
                            }}
                            on:titleSave={(e) =>
                              void saveNewSessionTitle(s.source, e.detail.title)}
                          />
                        {:else}
                          {@const agentMeta = (wt.agents ?? []).find(
                            (a) => a.source === s.source,
                          )}
                          <SessionView
                            agent={s.agent}
                            source={s.source}
                            totalMessageCount={agentMeta?.messageCount}
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
                            onClose={() => closeSessionInWt(wt.path, s)}
                            onDragStart={(e) =>
                              handleSessionDragStart(e, wt.path, i)}
                            onTitleChange={() => void load()}
                          />
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}

              <!-- "Topmost commit" row: chevron + last-commit summary,
                   placed BELOW the sessions strip so the chat columns
                   are the row's primary content. The chevron toggles
                   the source-control panel (staging + history) below. -->
              <SourceControlPane
                {wt}
                expanded={!!commitsExpanded[wt.path]}
                inZen={zenRowKey === row.key}
                fsChangeKey={fsChangeKey[wt.path] ?? 0}
                onError={(msg) => (error = msg)}
                on:toggle={() => toggleCommits(wt.path)}
              />
            {/if}
          {/if}
          {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>

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

{#if toasts.length > 0}
  <div class="toast-stack" role="region" aria-label="Notifications">
    {#each toasts as t (t.id)}
      <div class="toast toast-{t.kind}" role={t.kind === "error" ? "alert" : "status"}>
        <span class="toast-icon" aria-hidden="true">
          {#if t.kind === "error"}!{:else if t.kind === "success"}✓{:else}ℹ{/if}
        </span>
        <div class="toast-body">
          {#if t.title}<strong>{t.title}</strong> {/if}{t.message}
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
