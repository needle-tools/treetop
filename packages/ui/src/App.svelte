<script lang="ts">
  import { onMount } from "svelte";
  import { ExpandedStore } from "./storage";
  import DiffViewer from "./DiffViewer.svelte";
  import SessionView from "./SessionView.svelte";
  import TerminalView from "./TerminalView.svelte";
  import {
    OpenSessionsStore,
    VisibleWorktreesStore,
    effectiveVisibleWorktrees,
    filterToExistingSessions,
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
  }
  interface LastCommit {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    time: string;
  }
  interface AgentSession {
    agent: "claude" | "codex" | "copilot";
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
  /** Toggle browser fullscreen on the given element. If we're already
   *  fullscreen *and* it's the same element, exit. If we're fullscreen
   *  on a different element, swap (exit → request on new). xterm's
   *  FitAddon already listens to ResizeObserver so it re-fits on the
   *  size change without extra wiring. */
  async function toggleFullscreen(el: HTMLElement | null) {
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        if (document.fullscreenElement) await document.exitFullscreen();
        await el.requestFullscreen();
      }
    } catch {
      // Browser refused (permissions, already exiting, etc.) — silent.
    }
  }
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

  function startTuiPolling() {
    if (tuiPollTimer) return;
    void refreshTuis();
    tuiPollTimer = setInterval(refreshTuis, 2_000);
  }
  function stopTuiPolling() {
    if (tuiPollTimer) {
      clearInterval(tuiPollTimer);
      tuiPollTimer = null;
    }
  }
  function toggleTuisOpen() {
    tuisOpen = !tuisOpen;
    if (tuisOpen) startTuiPolling();
    else stopTuiPolling();
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

  /** Svelte action: keep a popover inside the viewport horizontally by
   *  translating it sideways when its left/right edge would clip. The
   *  CSS `max-width` can't see where the trigger sits, so a wide-ish
   *  popover anchored near the right edge of the page overflows
   *  off-screen no matter what `max-width` you set in absolute terms.
   *  This action measures on mount, on resize, and on scroll. */
  function clampToViewport(node: HTMLElement) {
    const MARGIN = 8;
    function clamp() {
      // Reset any prior offset before measuring, otherwise our own
      // correction gets compounded on resize.
      node.style.transform = "";
      const rect = node.getBoundingClientRect();
      const overRight = rect.right - window.innerWidth + MARGIN;
      const overLeft = MARGIN - rect.left;
      if (overRight > 0) {
        node.style.transform = `translateX(-${overRight}px)`;
      } else if (overLeft > 0) {
        node.style.transform = `translateX(${overLeft}px)`;
      }
    }
    clamp();
    window.addEventListener("resize", clamp);
    window.addEventListener("scroll", clamp, { passive: true });
    return {
      destroy() {
        window.removeEventListener("resize", clamp);
        window.removeEventListener("scroll", clamp);
      },
    };
  }

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

  /** Reattach Terminal columns that were live before this page reload.
   *  The daemon's GET /api/shells returns the surviving shell PTYs, each
   *  with its worktree path. We add a `__attached__:shell:<termId>`
   *  pseudo-source per shell to the matching worktree's column list;
   *  TerminalView skips the spawn step when given `attachTermId`. */
  async function restoreLiveShells() {
    try {
      const res = await fetch("/api/shells");
      if (!res.ok) return;
      const list = (await res.json()) as Array<{
        termId: string;
        wt: string;
        spawnCwd: string;
        currentCwd?: string;
      }>;
      const next = { ...openSessionsByWt };
      for (const sh of list) {
        const source = `__attached__:shell:${sh.termId}`;
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

  /** Per-synthetic-source manual title state. Lives here (not in the
   *  SessionView) because the `__new__:` flow uses a bare TerminalView,
   *  not SessionView. Title is keyed by the synthetic source so it
   *  persists across daemon restarts during the brief window before the
   *  real JSONL appears. */
  let newSessionTitles: Record<string, string> = {};
  let newSessionTitleEditing: Record<string, boolean> = {};
  let newSessionTitleDraft: Record<string, string> = {};

  function startNewSessionTitleEdit(source: string) {
    newSessionTitleDraft = {
      ...newSessionTitleDraft,
      [source]: newSessionTitles[source] ?? "",
    };
    newSessionTitleEditing = { ...newSessionTitleEditing, [source]: true };
  }

  async function saveNewSessionTitle(source: string) {
    const next = (newSessionTitleDraft[source] ?? "").trim();
    const prev = newSessionTitles[source] ?? "";
    newSessionTitleEditing = { ...newSessionTitleEditing, [source]: false };
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

  function onNewSessionTitleKey(e: KeyboardEvent, source: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveNewSessionTitle(source);
    } else if (e.key === "Escape") {
      e.preventDefault();
      newSessionTitleEditing = { ...newSessionTitleEditing, [source]: false };
    }
  }

  /** Svelte action: focus + select an input on mount. Used by the inline
   *  manual-title input in the new-session header. */
  function autoFocusSelect(node: HTMLInputElement) {
    requestAnimationFrame(() => {
      node.focus();
      node.select();
    });
    return {};
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
      // Already open — close it.
      openSessionsByWt = {
        ...openSessionsByWt,
        [wtPath]: [...list.slice(0, i), ...list.slice(i + 1)],
      };
      return;
    }

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
  function closeSessionInWt(wtPath: string, s: OpenSession): void {
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

  // diff viewer per worktree
  type DiffTab = "workdir" | "staged";
  let diffTab: Record<string, DiffTab> = {};
  let workdirDiff: Record<string, string> = {};
  let stagedDiff: Record<string, string> = {};
  let openCommitSha: Record<string, string | null> = {};
  let commitDiff: Record<string, string> = {};
  let diffLoading: Record<string, boolean> = {};
  // Per-worktree: false = ±2 lines of context (default); true = whole file.
  let fullFile: Record<string, boolean> = {};
  const FULL_FILE_CONTEXT = 99999;
  const DEFAULT_CONTEXT = 2;

  // commit history per worktree-path
  let commitsByPath: Record<string, LastCommit[]> = {};
  let commitsExpanded: Record<string, boolean> = {};
  let commitsLoading: Record<string, boolean> = {};
  let commitsExhausted: Record<string, boolean> = {};
  const COMMITS_BATCH = 50;

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
      const [r, e] = await Promise.all([
        fetch("/api/repos"),
        fetch("/api/events"),
      ]);
      if (!r.ok) throw new Error(`/api/repos: ${r.status}`);
      if (!e.ok) throw new Error(`/api/events: ${e.status}`);
      repos = await r.json();
      events = await e.json();
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

  async function fetchCommits(
    wtPath: string,
    before?: string,
  ): Promise<LastCommit[]> {
    const qs = new URLSearchParams({ path: wtPath, limit: String(COMMITS_BATCH) });
    if (before) qs.set("before", before);
    const res = await fetch(`/api/commits?${qs.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  function contextFor(wtPath: string): number {
    return fullFile[wtPath] ? FULL_FILE_CONTEXT : DEFAULT_CONTEXT;
  }
  async function fetchDiff(wtPath: string, kind: DiffTab): Promise<string> {
    const qs = new URLSearchParams({
      path: wtPath,
      kind,
      context: String(contextFor(wtPath)),
    });
    const res = await fetch(`/api/diff?${qs.toString()}`);
    if (!res.ok) throw new Error(`/api/diff: ${res.status}`);
    return res.text();
  }

  /** Flip ±2 lines ↔ Full file, drop the worktree's cached diffs, refetch. */
  async function toggleFullFile(wtPath: string) {
    fullFile = { ...fullFile, [wtPath]: !fullFile[wtPath] };

    const wd = { ...workdirDiff };
    delete wd[wtPath];
    workdirDiff = wd;

    const sd = { ...stagedDiff };
    delete sd[wtPath];
    stagedDiff = sd;

    const cd: Record<string, string> = {};
    for (const k in commitDiff) {
      if (!k.startsWith(`${wtPath}:`)) cd[k] = commitDiff[k]!;
    }
    commitDiff = cd;

    const tab = diffTab[wtPath] ?? "workdir";
    if (tab === "workdir") await loadWorkdirDiff(wtPath);
    else await loadStagedDiff(wtPath);

    // If a commit was open, refetch its diff with the new context.
    const sha = openCommitSha[wtPath];
    if (sha) {
      try {
        const qs = new URLSearchParams({
          path: wtPath,
          sha,
          context: String(contextFor(wtPath)),
        });
        const res = await fetch(`/api/commit?${qs.toString()}`);
        if (res.ok) {
          commitDiff = {
            ...commitDiff,
            [`${wtPath}:${sha}`]: await res.text(),
          };
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  async function loadWorkdirDiff(wtPath: string) {
    diffLoading = { ...diffLoading, [wtPath]: true };
    try {
      workdirDiff = {
        ...workdirDiff,
        [wtPath]: await fetchDiff(wtPath, "workdir"),
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading = { ...diffLoading, [wtPath]: false };
    }
  }
  async function loadStagedDiff(wtPath: string) {
    diffLoading = { ...diffLoading, [wtPath]: true };
    try {
      stagedDiff = {
        ...stagedDiff,
        [wtPath]: await fetchDiff(wtPath, "staged"),
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading = { ...diffLoading, [wtPath]: false };
    }
  }
  function setDiffTab(wtPath: string, tab: DiffTab) {
    diffTab = { ...diffTab, [wtPath]: tab };
    if (tab === "workdir" && workdirDiff[wtPath] === undefined)
      loadWorkdirDiff(wtPath);
    if (tab === "staged" && stagedDiff[wtPath] === undefined)
      loadStagedDiff(wtPath);
  }
  async function openCommit(wtPath: string, sha: string) {
    if (openCommitSha[wtPath] === sha) {
      openCommitSha = { ...openCommitSha, [wtPath]: null };
      return;
    }
    openCommitSha = { ...openCommitSha, [wtPath]: sha };
    if (commitDiff[`${wtPath}:${sha}`] !== undefined) return;
    diffLoading = { ...diffLoading, [wtPath]: true };
    try {
      const qs = new URLSearchParams({
        path: wtPath,
        sha,
        context: String(contextFor(wtPath)),
      });
      const res = await fetch(`/api/commit?${qs.toString()}`);
      if (!res.ok) throw new Error(`/api/commit: ${res.status}`);
      const text = await res.text();
      commitDiff = { ...commitDiff, [`${wtPath}:${sha}`]: text };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading = { ...diffLoading, [wtPath]: false };
    }
  }

  async function loadCommitsInitial(wtPath: string) {
    if (commitsByPath[wtPath]) return;
    commitsLoading = { ...commitsLoading, [wtPath]: true };
    try {
      const list = await fetchCommits(wtPath);
      commitsByPath = { ...commitsByPath, [wtPath]: list };
      commitsExhausted = {
        ...commitsExhausted,
        [wtPath]: list.length < COMMITS_BATCH,
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      commitsLoading = { ...commitsLoading, [wtPath]: false };
    }
  }

  async function loadMoreCommits(wtPath: string) {
    error = "";
    const existing = commitsByPath[wtPath] ?? [];
    const before = existing[existing.length - 1]?.sha;
    if (!before) return;
    commitsLoading = { ...commitsLoading, [wtPath]: true };
    try {
      const more = await fetchCommits(wtPath, before);
      commitsByPath = {
        ...commitsByPath,
        [wtPath]: [...existing, ...more],
      };
      commitsExhausted = {
        ...commitsExhausted,
        [wtPath]: more.length < COMMITS_BATCH,
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      commitsLoading = { ...commitsLoading, [wtPath]: false };
    }
  }

  async function toggleCommits(wtPath: string) {
    error = "";
    const willExpand = !commitsExpanded[wtPath];
    commitsExpanded = { ...commitsExpanded, [wtPath]: willExpand };
    persistExpanded();
    if (willExpand) {
      await loadCommitsInitial(wtPath);
      if (!diffTab[wtPath]) setDiffTab(wtPath, "workdir");
    }
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
      // If the change happened inside a worktree whose diff panel is
      // open, invalidate the cached diff so the visible content
      // re-fetches instead of staying stale ("Nothing unstaged" while
      // the row already shows "Unstaged 1").
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
      // Drop cached entries for this worktree; the active-tab refetch
      // below repopulates whichever one the user is looking at.
      if (workdirDiff[wtPath] !== undefined) {
        const wd = { ...workdirDiff };
        delete wd[wtPath];
        workdirDiff = wd;
      }
      if (stagedDiff[wtPath] !== undefined) {
        const sd = { ...stagedDiff };
        delete sd[wtPath];
        stagedDiff = sd;
      }
      const tab = diffTab[wtPath];
      if (tab === "workdir") void loadWorkdirDiff(wtPath);
      else if (tab === "staged") void loadStagedDiff(wtPath);
    });
    es.addEventListener("activity", (rawEvt: MessageEvent) => {
      try {
        const ev = JSON.parse(rawEvt.data) as ActivityEvent;
        const existing = activityByCwd[ev.cwd] ?? [];
        const next = [ev, ...existing].slice(0, MAX_ACTIVITY);
        activityByCwd = { ...activityByCwd, [ev.cwd]: next };
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
    void load().then(() => {
      for (const [path, expanded] of Object.entries(commitsExpanded)) {
        if (expanded) void loadCommitsInitial(path);
      }
    });
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
          <div class="actions-popover tuis-popover" role="menu" use:clampToViewport>
            <div class="popover-head">
              Active TUIs
              {#if tuisLoading}
                <span class="popover-spinner" aria-label="loading" title="refreshing"></span>
              {/if}
            </div>
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
          </div>
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
          <div class="actions-popover" role="menu">
            <div class="popover-head">Recent actions</div>
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
          </div>
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
          <div class="actions-popover events-popover" role="menu">
            <div class="popover-head">
              Events
              {#if errorEntries.length > 0}
                <button
                  class="undo events-clear"
                  on:click={clearAllErrors}
                  title="Clear the recorded error log"
                >Clear</button>
              {/if}
            </div>
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
                      <span class="err-msg" title={e.message}>{e.message}</span>
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
          </div>
        {/if}
      </div>
    </h1>
    <p class="muted">v0 — multi-repo, multi-agent, worktree-first dashboard</p>
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
                    <div class="agents-popover branch-popover" role="menu" use:clampToViewport>
                      <div class="popover-head branch-popover-head">
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
                      </div>
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
                    </div>
                  {/if}
                </span>
              {/if}
              {#if wt}
                {@const a = (wt.agents && wt.agents.length > 0) ? wt.agents[0] : null}
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
                    <div class="agents-popover new-agent-popover" role="menu" use:clampToViewport>
                      <div class="popover-head">Start a new session</div>
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
                    </div>
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
                  {#if a && wt.agents.length > 1}
                    <button
                      class="agent-more agent-{a.agent}"
                      title={`Pick from ${wt.agents.length} sessions in this worktree`}
                      on:click|stopPropagation={() => {
                        agentsPopoverOpen = {
                          ...agentsPopoverOpen,
                          [wt.path]: !agentsPopoverOpen[wt.path],
                        };
                      }}
                    >+{wt.agents.length - 1}</button>
                    {#if agentsPopoverOpen[wt.path]}
                      <div class="agents-popover" role="menu" use:clampToViewport>
                        <div class="popover-head">
                          {wt.agents.length} sessions in this worktree
                        </div>
                        <ul class="agents-list">
                          {#each wt.agents as sess (sess.source)}
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
                      </div>
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
                <div class="agents-popover wt-picker-popover" role="menu" use:clampToViewport>
                  <div class="popover-head">Worktrees of {repo.name ?? repoName(repo)}</div>
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
                </div>
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
              <span class="muted small">{summary.text}</span>
              {#if wt.branchStatus && wt.branchStatus.upstream}
                {#if wt.branchStatus.ahead > 0 || wt.branchStatus.behind > 0}
                  {#if wt.branchStatus.ahead > 0}
                    <span
                      class="ab ab-ahead"
                      title={`${wt.branchStatus.ahead} commit${wt.branchStatus.ahead === 1 ? "" : "s"} to push → ${wt.branchStatus.upstream}`}
                    >↑{wt.branchStatus.ahead}</span>
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
                        {#if s.source.startsWith("__new__:") || s.source.startsWith("__attached__:")}
                          <!-- Transient column: a brand-new agent we just
                               spawned, before its JSONL has been created on
                               disk. Renders the TUI directly. Once the user
                               closes it, we drop the entry from the open list. -->
                          <div
                            class="session new-session-col"
                            class:awaiting-input={transientAwaiting[s.source]}
                          >
                            <header class="new-session-head">
                              <span class="agent-pill agent-{s.agent}">{s.agent}</span>
                              {#if newSessionTitleEditing[s.source]}
                                <input
                                  class="manual-title-input"
                                  bind:value={newSessionTitleDraft[s.source]}
                                  on:keydown={(e) =>
                                    onNewSessionTitleKey(e, s.source)}
                                  on:blur={() => saveNewSessionTitle(s.source)}
                                  use:autoFocusSelect
                                  placeholder="Name this session…"
                                  maxlength="120"
                                />
                              {:else}
                                <button
                                  type="button"
                                  class="manual-title"
                                  class:placeholder={!newSessionTitles[s.source]}
                                  title={newSessionTitles[s.source]
                                    ? "Click to rename this session"
                                    : "Click to name this session"}
                                  on:click={() =>
                                    startNewSessionTitleEdit(s.source)}
                                >
                                  {newSessionTitles[s.source] ||
                                    "Name this session…"}
                                </button>
                              {/if}
                              <span class="muted small">
                                {s.agent === "shell" ? "new session — Terminal" : "new session — TUI"}
                              </span>
                              {#if transientAwaiting[s.source]}
                                <span class="awaiting-pill" title="The agent is paused waiting for input — click the terminal and respond.">
                                  needs input
                                </span>
                              {/if}
                              <button
                                class="restart-btn"
                                on:click={() => restartNewAgentSession(wt.path, s)}
                                title={`Re-run \`${s.agent}\` in this column (use after a self-update)`}
                                aria-label="Restart"
                              >↻</button>
                              <button
                                class="fullscreen-btn"
                                on:click={(e) =>
                                  toggleFullscreen(
                                    (e.currentTarget as HTMLElement).closest(
                                      ".new-session-col",
                                    ) as HTMLElement | null,
                                  )}
                                title="Fullscreen this terminal (Esc to exit)"
                                aria-label="Fullscreen"
                              >⛶</button>
                              <button
                                class="close"
                                on:click={() => closeSessionInWt(wt.path, s)}
                                title="Close + dispose this terminal"
                              >×</button>
                            </header>
                            <TerminalView
                              cmd={s.agent === "shell" ? [defaultShell] : [s.agent]}
                              cwd={wt.path}
                              procName={`supergit-tui-new-${s.agent}`}
                              attachTermId={s.source.startsWith("__attached__:")
                                ? s.source.split(":").pop()
                                : undefined}
                              onAwaitingChange={(awaiting) => {
                                transientAwaiting = {
                                  ...transientAwaiting,
                                  [s.source]: awaiting,
                                };
                              }}
                              onExit={() => {
                                // Deliberately NOT closing the column on
                                // PTY exit. Some agents (notably `codex`)
                                // restart themselves after an in-place
                                // update — they exit, then a fresh
                                // process spawns. If we auto-disposed
                                // here, the user would lose the new
                                // process and the update notice. Instead
                                // we leave the column open showing the
                                // final output; the user dismisses via
                                // the × in the header.
                              }}
                            />
                          </div>
                        {:else}
                          {@const agentMeta = (wt.agents ?? []).find(
                            (a) => a.source === s.source,
                          )}
                          <SessionView
                            agent={s.agent}
                            source={s.source}
                            totalMessageCount={agentMeta?.messageCount}
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
              <div class="row-commit muted small">
                <button
                  class="chevron"
                  class:open={commitsExpanded[wt.path]}
                  title={commitsExpanded[wt.path] ? "Hide source control" : "Show source control"}
                  aria-label={commitsExpanded[wt.path] ? "Hide source control" : "Show source control"}
                  on:click={() => toggleCommits(wt.path)}
                >
                  <span class="arrow">▸</span>
                </button>
                <span class="sha">{wt.lastCommit.shortSha}</span>
                <span class="commit-subject">{wt.lastCommit.subject}</span>
                <span class="commit-author">{wt.lastCommit.author}</span>
                <span class="commit-time">{relTime(wt.lastCommit.time)}</span>
              </div>

              {#if commitsExpanded[wt.path]}
                <div class="expanded">
                  {#if zenRowKey === row.key}
                    <button
                      class="hide-history-btn"
                      title="Hide source control"
                      on:click={() => toggleCommits(wt.path)}
                    >Hide ✕</button>
                  {/if}
                  {#if summary.text !== "clean" || wt.fileStatus.staged > 0}
                    <div class="inline-diff">
                      <div class="tabs-row">
                        <div class="tabs">
                          <button
                            class="tab"
                            class:active={(diffTab[wt.path] ?? "workdir") === "workdir"}
                            on:click={() => setDiffTab(wt.path, "workdir")}
                          >
                            Unstaged
                            {#if summary.text !== "clean"}
                              <span class="tab-count">{wt.fileStatus.unstaged + wt.fileStatus.untracked}</span>
                            {/if}
                          </button>
                          <button
                            class="tab"
                            class:active={diffTab[wt.path] === "staged"}
                            on:click={() => setDiffTab(wt.path, "staged")}
                          >
                            Staged
                            {#if wt.fileStatus.staged > 0}
                              <span class="tab-count">{wt.fileStatus.staged}</span>
                            {/if}
                          </button>
                        </div>
                        <button
                          class="ctx-toggle"
                          class:active={fullFile[wt.path]}
                          title={fullFile[wt.path]
                            ? "Showing whole file — click for ±2 lines"
                            : "Showing ±2 lines context — click for whole file"}
                          on:click={() => toggleFullFile(wt.path)}
                        >{fullFile[wt.path] ? "Full file" : "±2 lines"}</button>
                      </div>

                      {#if (diffTab[wt.path] ?? "workdir") === "workdir"}
                        {#if diffLoading[wt.path] && workdirDiff[wt.path] === undefined}
                          <p class="muted small nopad">Loading diff…</p>
                        {:else if workdirDiff[wt.path]}
                          <DiffViewer text={workdirDiff[wt.path]} />
                        {:else}
                          <p class="muted small nopad">Nothing unstaged.</p>
                        {/if}
                      {:else}
                        {#if diffLoading[wt.path] && stagedDiff[wt.path] === undefined}
                          <p class="muted small nopad">Loading diff…</p>
                        {:else if stagedDiff[wt.path]}
                          <DiffViewer text={stagedDiff[wt.path]} />
                        {:else}
                          <p class="muted small nopad">Nothing staged.</p>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                  <h3 class="commits-heading">History</h3>
                  <div class="commits">
                    {#if commitsLoading[wt.path] && !commitsByPath[wt.path]}
                      <p class="muted small nopad">Loading…</p>
                    {:else if commitsByPath[wt.path]}
                      {#each commitsByPath[wt.path] as c (c.sha)}
                        <button
                          class="commit-row"
                          class:open={openCommitSha[wt.path] === c.sha}
                          on:click={() => openCommit(wt.path, c.sha)}
                        >
                          <code class="sha">{c.shortSha}</code>
                          <span class="commit-subject">{c.subject}</span>
                          <span class="commit-author">{c.author}</span>
                          <span class="commit-time">{relTime(c.time)}</span>
                        </button>
                        {#if openCommitSha[wt.path] === c.sha}
                          {#if commitDiff[`${wt.path}:${c.sha}`] !== undefined}
                            <div class="inline-commit">
                              <DiffViewer text={commitDiff[`${wt.path}:${c.sha}`]} />
                            </div>
                          {:else}
                            <p class="muted small nopad">Loading commit…</p>
                          {/if}
                        {/if}
                      {/each}
                      {#if !commitsExhausted[wt.path]}
                        <button
                          class="tiny load-more"
                          on:click={() => loadMoreCommits(wt.path)}
                          disabled={commitsLoading[wt.path]}
                          >{commitsLoading[wt.path] ? "Loading…" : "Load more"}</button
                        >
                      {:else}
                        <span class="muted small">— end of history</span>
                      {/if}
                    {/if}
                  </div>
                </div>
              {/if}
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
  /* Disable trackpad two-finger swipe-back/forward at the CSS level.
     The popstate guard in main.ts isn't enough on Safari/Chrome: the
     swipe gesture is intercepted by the browser before any popstate
     handler runs. `overscroll-behavior-x: none` is the supported way
     to opt out of the horizontal overscroll → history navigation. */
  :global(html),
  :global(body) {
    overscroll-behavior-x: none;
  }
  :global(body) {
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      system-ui,
      sans-serif;
    margin: 0;
    background: var(--surface-0);
    color: var(--text-1);
  }
  main {
    /* Use almost the full window — supergit is a dashboard, not a
     * reading column. Cap at 1200px only on phones where 100% - 100px
     * collapses too far; otherwise let it breathe. */
    max-width: calc(100% - 100px);
    margin: 0 auto;
    padding: 1.5rem 1.5rem 1.5rem;
    min-width: 0;
  }
  /* Initial app-wide "loading repos…" state: centered pill, mirroring the
     TUI / SessionView load indicators so all three reads as one design. */
  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
  }
  .loading-overlay {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface-2);
    color: var(--text-1);
    padding: 0.4rem 0.85rem;
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .loading-overlay .spinner {
    width: 0.85rem;
    height: 0.85rem;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: app-spin 0.6s linear infinite;
  }
  @keyframes app-spin {
    to { transform: rotate(360deg); }
  }
  @media (max-width: 900px) {
    main {
      max-width: 100%;
      padding: 1rem 0.75rem;
    }
  }
  /* Open sessions live anchored to their worktree row in a horizontal
     strip. Each column has a generous min-width so two sessions fit
     comfortably side-by-side; max-width caps width on huge displays;
     overflow-x means a horizontal scrollbar appears once columns stop
     fitting. */
  .sessions-strip {
    /* Was 0.5rem; bumped to 1rem because the column's .session lost its
       own 0.5rem margin-top (which combined with height:100% was clipping
       the bottom border under the strip's overflow-y:hidden). */
    margin-top: 1rem;
    display: flex;
    gap: 0.6rem;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 0.25rem;
  }
  .session-col {
    /* Chat columns sized for comfortable reading — wide enough that code
       blocks don't wrap aggressively, narrow enough that you can fit two
       side-by-side on a 1440px screen. Hard cap in ch (not %) so widening
       the window doesn't stretch each column to billboard widths. */
    flex: 1 1 70ch;
    min-width: 60ch;
    max-width: 90ch;
    box-sizing: border-box;
  }
  header {
    margin-bottom: 1.5rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .brand-mark {
    height: 1.6rem;
    width: auto;
    display: inline-block;
  }
  .live {
    font-size: 0.75rem;
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }
  .live.on {
    color: var(--status-clean);
  }

  /* Actions popover */
  .actions-anchor {
    position: relative;
    margin-left: auto;
  }
  /* When TUIs sits left of Actions in the same header strip, the TUIs
     anchor claims the auto-margin (pushed to the right edge) and the
     Actions anchor sits flush next to it with just a small gap.
     Without this, both `margin-left: auto` siblings produce a big
     equal gap between them. */
  .tuis-anchor + .actions-anchor {
    margin-left: 0.4rem;
  }
  .actions-btn {
    padding: 0.4rem 0.75rem;
    background: var(--surface-2);
    color: var(--text-2);
    border: 0;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .actions-btn:hover,
  .actions-btn.open {
    background: var(--surface-3);
    color: var(--text-1);
  }
  .actions-btn .count {
    background: transparent;
    color: white;
    padding: .4em 0.4em;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 50%, transparent);
    font-size: 0.7rem;
    min-width: 1.2rem;
    text-align: center;
  }
  .actions-popover {
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    width: 380px;
    max-width: 90vw;
    max-height: 520px;
    overflow: auto;
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.6rem 0.7rem;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .popover-head {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
  }
  .popover-spinner {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    margin-left: 0.4rem;
    vertical-align: -1px;
    border: 1.5px solid var(--text-muted);
    border-top-color: transparent;
    border-radius: 50%;
    animation: popover-spin 0.8s linear infinite;
  }
  @keyframes popover-spin {
    to { transform: rotate(360deg); }
  }
  /* Events popover ("diagnostics"): same width/look as the TUIs popover.
     The button gets a subtle error-tint when there are entries, so the
     header strip visually nudges the user toward it without being noisy. */
  .events-anchor {
    margin-left: 0.4rem;
  }
  .actions-btn.has-errors {
    color: var(--error-text, #ffb4ad);
  }
  .events-popover {
    width: 540px;
    max-width: 90vw;
  }
  .events-popover .popover-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .events-clear {
    font-size: 0.7rem;
    padding: 0.15rem 0.45rem;
  }
  .err-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .err-list > li {
    border-top: 1px solid var(--surface-2);
  }
  .err-list > li:first-child {
    border-top: 0;
  }
  .err-row {
    width: 100%;
    display: grid;
    grid-template-columns: 5.5rem 1fr auto;
    gap: 0.5rem;
    align-items: center;
    padding: 0.4rem 0.2rem;
    background: transparent;
    border: 0;
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .err-row:hover {
    background: var(--surface-2);
  }
  .err-kind {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.65rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: var(--surface-3);
    color: var(--text-3);
    text-align: center;
  }
  .err-kind-server { background: color-mix(in srgb, var(--error-bg, #5a1d1d) 70%, transparent); color: var(--error-text, #ffb4ad); }
  .err-kind-fetch { background: color-mix(in srgb, #5a4500 70%, transparent); color: #ffd58a; }
  .err-kind-rejection,
  .err-kind-uncaught { background: color-mix(in srgb, #1d3a5a 70%, transparent); color: #a8d0ff; }
  .err-msg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .err-detail {
    padding: 0.2rem 0.4rem 0.6rem 0.4rem;
    font-size: 0.75rem;
  }
  .err-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-3);
    margin-bottom: 0.3rem;
  }
  .err-route {
    background: var(--surface-2);
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 4px);
  }
  .err-status {
    background: color-mix(in srgb, var(--error-bg, #5a1d1d) 60%, transparent);
    color: var(--error-text, #ffb4ad);
    padding: 0.05rem 0.35rem;
    border-radius: var(--radius-sm, 4px);
  }
  .err-stack {
    background: var(--surface-2);
    color: var(--text-2);
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius-sm, 4px);
    max-height: 220px;
    overflow: auto;
    white-space: pre;
    font-size: 0.7rem;
    line-height: 1.35;
    margin: 0.2rem 0 0 0;
  }

  /* TUIs popover reuses the agents-popover row look — same grid, same
     0.78rem font, same hover-reveal × — so both popovers feel like
     siblings. Only difference: a TUI row isn't a button (no click
     target on the row body); only its × button kills. */
  .tuis-popover {
    width: 540px;
    max-width: 90vw;
  }
  .tui-row-static {
    cursor: default;
    /* 4 grid columns: icon (fixed 16px) · name (auto) · stats (auto)
       · × (fixed 18px). Fixed widths on the icon and × cells keep them
       from collapsing into adjacent text when content is short. */
    grid-template-columns: 16px auto auto 18px;
    justify-content: end;
  }
  .tui-row-static:hover {
    background: var(--surface-2);
  }
  /* Stats are mono + tabular so columns of digits line up across rows. */
  .tui-stats {
    font-variant-numeric: tabular-nums;
    color: var(--text-4);
    white-space: nowrap;
  }
  /* X always reserves the 18px column (no layout shift between hover
     states), revealed on row hover like the agents popover's × is on
     hover of a dimmed row. */
  .tui-row-static:hover .tui-kill-x {
    opacity: 1;
    pointer-events: auto;
  }
  .tui-kill-x:hover {
    color: var(--error-text);
    background: var(--error-bg);
  }

  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.8rem;
  }
  .nopad {
    margin: 0.5rem 0 0 0;
  }

  /* Add folder button in the header strip — claims the auto-margin so
     it pins to the right edge; the TUIs anchor that follows sits flush
     beside it. */
  .add-folder-btn {
    margin-left: auto;
  }
  .add-folder-btn + .actions-anchor {
    margin-left: 0.4rem;
  }
  input {
    flex: 1;
    padding: 0.55rem 0.75rem;
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    color: inherit;
    border-radius: var(--radius-md);
    font-family: inherit;
    font-size: 0.95rem;
  }
  input:focus {
    outline: none;
    border-color: var(--brand);
  }
  button {
    padding: 0.55rem 1rem;
    background: var(--surface-2);
    border: 0;
    color: inherit;
    border-radius: var(--radius-md);
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:hover:not(:disabled) {
    background: var(--surface-3);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--brand);
    color: white;
  }
  button.primary:hover:not(:disabled) {
    background: var(--brand-hover);
  }
  button.tiny {
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
  }
  /* Unified worktree picker popover anchored to the repo-header
     `worktrees (N)` button. Same agents-popover shell; same .agent-row
     visual for each line; same 0.78rem font as "X sessions in this
     worktree". A create-new input lives at the bottom. */
  .wt-picker-anchor {
    position: relative;
    display: inline-flex;
  }
  .wt-picker-popover {
    width: 520px;
    max-width: 90vw;
  }
  .wt-pick-row {
    /* Each row is a div (not a button) since the X needs to be its own
       clickable target. Primary click on the row toggles visibility.
       4 children: tick · branch · path · × — override .agent-row's
       6-column session-popover grid so the cells line up. */
    cursor: pointer;
    grid-template-columns: 12px auto 1fr 18px;
  }
  .wt-pick-tick {
    display: inline-block;
    width: 12px;
    text-align: center;
    color: var(--brand);
    font-size: 0.8rem;
    line-height: 1;
  }
  /* Visible worktrees: brand-colored branch name so the eye picks them
     out from the hidden ones. */
  .wt-pick-row.wt-pick-visible .agent-row-name {
    color: var(--text-1);
  }
  .wt-pick-row:not(.wt-pick-visible) .agent-row-name,
  .wt-pick-row:not(.wt-pick-visible) .agent-title {
    opacity: 0.55;
  }
  .wt-pick-row:hover {
    background: var(--surface-2);
  }
  /* Hover-reveal the X exactly like the sessions popover's row-close. */
  .wt-pick-row .wt-pick-kill {
    opacity: 0;
    pointer-events: none;
  }
  .wt-pick-row:hover .wt-pick-kill {
    opacity: 1;
    pointer-events: auto;
  }
  .wt-pick-kill:hover {
    background: var(--error-bg);
    color: var(--error-text);
  }
  /* Highlight the worktree whose row this popover was opened from. */
  .wt-picker-popover .agent-row.rm-wt-current {
    background: var(--surface-2);
    outline: 1px solid color-mix(in srgb, var(--text-faint) 50%, transparent);
  }
  /* Create-new input at the bottom of the picker. */
  .wt-pick-create-row {
    margin-top: 0.4rem;
    display: flex;
    gap: 0.4rem;
    align-items: center;
    padding-top: 0.4rem;
    border-top: 1px solid var(--surface-2);
  }
  .wt-pick-create-input {
    flex: 1;
    background: transparent;
    color: var(--text-1);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.5rem;
    font: inherit;
    font-size: 0.78rem;
  }
  .wt-pick-create-input:focus {
    outline: none;
    border-color: var(--text-faint);
  }
  .wt-pick-create-go {
    background: var(--surface-2);
    color: var(--text-1);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.65rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .wt-pick-create-go:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .wt-pick-create-go:hover:not(:disabled) {
    background: var(--surface-3);
  }
  /* Tiny destructive link at the bottom of the worktree picker: untracks
     the repo from supergit entirely (workspace state). Distinct from
     hiding individual worktree rows. */
  .wt-pick-remove-repo {
    display: block;
    margin-top: 0.4rem;
    width: 100%;
    background: transparent;
    color: #efaaaa;
    border: 0;
    padding: 0.35rem 0;
    font-size: 0.72rem;
    cursor: pointer;
    text-align: center;
    border-top: 1px dashed color-mix(in srgb, var(--surface-3) 70%, transparent);
  }
  .wt-pick-remove-repo:hover {
    color: #ffcaca;
  }
  /* Brief highlight pulse when the picker scrolls to a worktree row. */
  @keyframes wt-row-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--brand) 50%, transparent); }
    40%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--brand) 30%, transparent); }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  .wt-row-pulse {
    animation: wt-row-pulse 1.2s ease-out;
    border-radius: var(--radius-md);
  }

  .error {
    background: var(--error-bg);
    color: var(--error-text);
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }

  /* Worktree rows */
  .rows {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .row {
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-lg);
    padding: 0.65rem 0.75rem;
    margin: 0 0 0.6rem;
    min-width: 0;
    /* The chevron lives next to the row-commit line (below the sessions
       strip) now, so no separate left-rail column — row-content takes
       the full width. */
  }
  /* When folded, only the row-head is rendered. Tighten the row's
     vertical padding and stack-gap so a folded repo reads as a compact
     one-liner instead of leaving a blank area where the body was. */
  .row.row-folded {
    padding: 0.35rem 0.75rem;
    margin-bottom: 0.3rem;
  }
  .fold-toggle {
    margin-right: -0.2rem;
    /* Tint the row-fold chevron with the same blue as the repo name so
       it visually pairs with the repo chip and reads as "fold this row"
       at a glance — versus the neutral history chevron next to the
       topmost-commit line which keeps the default muted colour. */
    color: var(--chip-blue-text);
  }
  .fold-toggle:hover {
    color: var(--chip-blue-text);
    background: color-mix(in srgb, var(--chip-blue-bg) 55%, transparent);
  }
  .row-content {
    min-width: 0;
  }
  .session-panel {
    margin-top: 0.5rem;
  }
  .row-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: nowrap;
    min-width: 0;
  }
  .repo-chip {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
    padding: 0.18rem 0.55rem;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    white-space: nowrap;
  }
  .repo-chip:hover {
    filter: brightness(1.15);
  }
  .repo-chip .pencil {
    opacity: 0;
    font-size: 0.7rem;
  }
  .repo-chip:hover .pencil {
    opacity: 0.8;
  }
  .name-edit {
    padding: 0.15rem 0.4rem;
    font-size: 0.85rem;
    background: var(--surface-1);
    border: 1px solid var(--brand);
    border-radius: var(--radius-sm);
    color: inherit;
    width: auto;
    max-width: 240px;
    flex: 0 0 auto;
  }
  .wt-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
    /* Matches the branch chip's font-size + uses muted text so the
       path reads as supporting metadata, not primary content. */
    font-size: 0.78rem;
    color: var(--text-muted);
  }
  .branch {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.78rem;
    white-space: nowrap;
  }
  /* Make the branch chip look clickable when it's actually a button. */
  button.branch-button {
    border: 0;
    cursor: pointer;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  button.branch-button:hover {
    filter: brightness(1.15);
  }
  .branch-caret {
    font-size: 0.65rem;
    opacity: 0.7;
    line-height: 1;
  }
  .branch-anchor {
    position: relative;
    display: inline-flex;
  }
  .branch-popover {
    width: 360px;
    max-width: 90vw;
  }
  /* Popover head with the title on the left and the sort toggle on
     the right. Sort toggle is a tiny pill so it doesn't compete with
     the actual branch list. */
  .branch-popover-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .branch-sort-toggle {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-sm);
    padding: 0.1rem 0.45rem;
    font-size: 0.68rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    text-transform: none;
    letter-spacing: 0;
  }
  .branch-sort-toggle:hover {
    color: var(--text-1);
    border-color: var(--text-faint);
  }
  /* Branch picker row: 3 cells (dot · name · local|remote). Override
     .agent-row's session-popover grid. */
  .branch-row {
    grid-template-columns: 12px auto 1fr;
  }
  .branch-row[disabled] {
    cursor: default;
  }
  .branch-tick {
    width: 12px;
    text-align: center;
    color: var(--brand);
    font-size: 0.8rem;
    line-height: 1;
  }
  .branch-row-current .agent-row-name {
    color: var(--text-1);
    font-weight: 600;
  }

  /* Modal for dirty-state checkout confirmation. */
  .modal-scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .modal {
    background: var(--surface-1);
    border: 1px solid var(--surface-3);
    border-radius: var(--radius-md);
    padding: 1rem 1.1rem;
    max-width: 520px;
    width: 100%;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    color: var(--text-1);
  }
  .modal h3 {
    margin: 0 0 0.6rem;
    font-size: 1rem;
  }
  .modal-body {
    margin: 0 0 0.4rem;
    font-size: 0.88rem;
    color: var(--text-2);
  }
  .modal-body code {
    background: var(--surface-2);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .modal-meta {
    margin: 0 0 0.8rem;
    font-family: ui-monospace, monospace;
    word-break: break-word;
  }
  .modal-actions {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .modal-action {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--surface-3);
    background: var(--surface-2);
    color: var(--text-1);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .modal-action:hover {
    background: var(--surface-3);
  }
  /* Recommended action: a subtle brand-tinted border all around,
     background stays a dark surface so the title and hint are
     legible. No accent stripe — just a quiet hint of brand. */
  .modal-action-recommended {
    border-color: color-mix(in srgb, var(--brand) 45%, var(--surface-3));
  }
  .modal-action-recommended:hover {
    background: color-mix(in srgb, var(--brand) 12%, var(--surface-2));
  }
  .modal-action-danger {
    border-color: color-mix(in srgb, #efaaaa 35%, transparent);
    color: #efcccc;
  }
  .modal-action-danger:hover {
    background: color-mix(in srgb, var(--error-bg) 60%, var(--surface-2));
  }
  .modal-action-neutral {
    background: transparent;
    color: var(--text-muted);
  }
  .modal-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-weight: 400;
  }

  /* Bottom-right toast stack. Errors + notices share the layout; the
     left-edge accent line + icon colour pick up `--kind`. */
  .toast-stack {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 250;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    max-width: 420px;
    padding: 0.7rem 0.9rem;
    background: var(--surface-2);
    border: 1px solid var(--surface-3);
    border-left: 3px solid var(--brand);
    border-radius: var(--radius-md);
    color: var(--text-1);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    font-size: 0.82rem;
    line-height: 1.4;
  }
  .toast-error {
    border-left-color: var(--error-text);
    background: color-mix(in srgb, var(--error-bg) 50%, var(--surface-2));
  }
  .toast-success {
    border-left-color: var(--status-clean);
  }
  .toast-icon {
    width: 1.1rem;
    height: 1.1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: 0.72rem;
    line-height: 1;
    flex: 0 0 auto;
    color: var(--text-1);
  }
  .toast-error .toast-icon {
    background: color-mix(in srgb, var(--error-text) 35%, transparent);
    color: var(--error-text);
  }
  .toast-success .toast-icon {
    background: color-mix(in srgb, var(--status-clean) 35%, transparent);
    color: white;
  }
  .toast-info .toast-icon {
    background: color-mix(in srgb, var(--brand) 35%, transparent);
    color: var(--brand);
  }
  .toast-body {
    flex: 1;
    word-break: break-word;
  }
  .toast-close {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }
  .toast-close:hover {
    color: var(--text-1);
  }
  .branch.detached {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .branch.bare {
    background: var(--chip-indigo-bg);
    color: var(--chip-grey-text);
  }
  .branch.warn {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .agent-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
    text-transform: lowercase;
    border: 0;
    cursor: pointer;
  }
  .agent-badge:hover {
    filter: brightness(1.15);
  }
  .agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .agent-badge.agent-claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .agent-badge.agent-codex {
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
  }
  .agent-badge.agent-copilot {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .agent-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0;
  }
  .agent-badge {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: 1px solid rgba(0, 0, 0, 0.25);
  }
  .agent-wrap > .agent-badge:only-child {
    border-radius: var(--radius-sm);
    border-right: 0;
  }
  .agent-more {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
    border: 0;
    padding: 0.1rem 0.4rem;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-top-right-radius: var(--radius-sm);
    border-bottom-right-radius: var(--radius-sm);
  }
  /* "+" chip glued to the LEFT of the agent badge — mirror of
     .agent-more but anchored to the start. Color picked up from the
     agent name modifier (.agent-claude / .agent-codex / …) so the
     pill looks like one continuous coloured group. */
  .agent-add {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
    border: 0;
    padding: 0.1rem 0.4rem;
    font-size: 0.7rem;
    font-family: ui-monospace, monospace;
    line-height: 1;
    cursor: pointer;
    border-top-left-radius: var(--radius-sm);
    border-bottom-left-radius: var(--radius-sm);
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: 1px solid rgba(0, 0, 0, 0.25);
  }
  .agent-add.agent-claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .agent-add.agent-codex {
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
  }
  .agent-add.agent-copilot {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  /* When there's no agent badge next to it (no sessions in this
     worktree yet), the "+" lives on its own — neutral muted color so
     it's discoverable but doesn't shout, and rounded on BOTH sides
     since there's no sibling pill to join with. */
  .agent-add.agent-empty {
    background: var(--surface-2);
    color: var(--text-muted);
    border-right: 0;
    border-top-right-radius: var(--radius-sm);
    border-bottom-right-radius: var(--radius-sm);
  }
  .agent-add.agent-empty:hover:not(:disabled) {
    color: var(--text-1);
    background: var(--surface-3);
    filter: none;
  }
  .agent-add:hover:not(:disabled) {
    filter: brightness(1.2);
  }
  .agent-add:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* Adding a "+" to the left means the badge's left edge is no longer
     a corner — make sure the badge plays along by un-rounding its
     left side when there's an .agent-add sibling before it. */
  .agent-wrap > .agent-add + .agent-badge {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  /* New-agent popover layout: 480px feels right for the agent rows. */
  .new-agent-popover {
    width: 360px;
    max-width: 90vw;
  }
  /* Transient new-session column: simple bordered shell with a small
     header strip. The TerminalView inside fills the column body. */
  .new-session-col {
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
  }
  .new-session-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--surface-3);
  }
  /* Match SessionView's .close so the transient-TUI column header
     reads exactly like a Claude chat's header — same padding,
     transparent bg, same red-on-hover destructive treatment for ×.
     Restart (↻) sits beside it with a neutral hover. */
  .new-session-head .close,
  .new-session-head .restart-btn,
  .new-session-head .fullscreen-btn {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
  .new-session-head .restart-btn {
    margin-left: auto;
  }
  .new-session-head .close {
    margin-left: auto;
  }
  /* The trailing-actions cluster sits flush on the right: restart
     claims the auto-margin (or close does if restart isn't there),
     and the rest just butt up against it. */
  .new-session-head .restart-btn + .fullscreen-btn,
  .new-session-head .fullscreen-btn + .close {
    margin-left: 0;
  }
  .new-session-head .restart-btn:hover,
  .new-session-head .fullscreen-btn:hover {
    color: var(--text-1);
    background: var(--surface-3);
  }
  .new-session-head .close:hover {
    background: var(--error-bg);
    color: var(--error-text);
  }
  /* "Awaiting input" affordance — column gains a soft amber outline
     that pulses gently, plus a small chip in the header. Both clear
     the moment the user types or the agent prints non-prompt output. */
  .awaiting-pill {
    background: color-mix(in srgb, var(--status-dirty) 25%, transparent);
    color: var(--status-dirty);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .new-session-col.awaiting-input {
    border-color: var(--status-dirty);
    animation: awaiting-pulse 1.8s ease-in-out infinite;
  }
  @keyframes awaiting-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-dirty) 0%, transparent); }
    50%      { box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-dirty) 25%, transparent); }
  }
  /* Click-to-edit manual title inside the new-session TUI header.
     Mirrors SessionView's affordance so naming behaves the same in both
     the stored-chat view and the live TUI view. */
  .new-session-head .manual-title {
    background: transparent;
    border: 0;
    color: var(--text-1);
    font: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    padding: 0.05rem 0.25rem;
    border-radius: var(--radius-sm);
    cursor: text;
    text-align: left;
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new-session-head .manual-title:hover {
    background: var(--surface-3);
  }
  .new-session-head .manual-title.placeholder {
    color: var(--text-faint);
    font-weight: 400;
    font-style: italic;
  }
  .new-session-head .manual-title-input {
    background: var(--surface-1);
    color: var(--text-1);
    border: 1px solid var(--text-faint);
    border-radius: var(--radius-sm);
    padding: 0.05rem 0.3rem;
    font: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    min-width: 8ch;
    width: 20ch;
    max-width: 100%;
  }
  .new-session-head .manual-title-input:focus {
    outline: none;
    border-color: var(--brand);
  }
  .agent-more.agent-claude {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .agent-more.agent-codex {
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
  }
  .agent-more.agent-copilot {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .agent-more:hover {
    filter: brightness(1.2);
  }
  .agents-popover {
    position: absolute;
    top: calc(100% + 0.3rem);
    left: 0;
    z-index: 50;
    /* Wide enough to show real titles; capped at 250ch on huge displays
       and 90vw on small ones so it never overflows the viewport. */
    width: max-content;
    min-width: 380px;
    max-width: min(250ch, 90vw);
    max-height: 60vh;
    overflow: auto;
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.4rem 0.5rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .agents-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .agent-row {
    display: grid;
    /* icon · agent-name · title · msgs · time · short-sha · close-x
       The close column is reserved on every row (open or not) so opening
       and closing sessions doesn't shift other rows' columns. */
    grid-template-columns: 16px auto 1fr auto auto auto 18px;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
    padding: 0.3rem 0.45rem;
    background: transparent;
    border: 0;
    color: inherit;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-size: 0.78rem;
  }
  .agent-row:hover {
    background: var(--surface-2);
  }
  /* "Already open" rows: faded so they read as background context, not
     primary candidates. Click still toggles them closed. */
  .agent-row.dimmed {
    opacity: 0.45;
  }
  .agent-row.dimmed:hover {
    opacity: 0.7;
  }
  .agent-row-icon {
    width: 14px;
    height: 14px;
    /* Inline SVGs pick up the row's currentColor (brand-* below). */
    color: inherit;
  }
  .agent-row.brand-claude {
    color: var(--chip-orange-text);
  }
  .agent-row.brand-codex {
    color: var(--chip-codex-text);
  }
  .agent-row.brand-copilot {
    color: var(--chip-blue-text);
  }
  .agent-row-name {
    font-weight: 600;
    /* Use the row's coloured currentColor for the agent name */
    color: inherit;
  }
  .agent-row .agent-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--text-2);
  }
  .agent-row .agent-title.manual {
    color: var(--text-1);
    font-weight: 600;
  }
  /* Manual title shown inline in the worktree row's single-agent badge.
     Stays on one line; the row already manages overflow. */
  .agent-manual-title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 18ch;
  }
  .agent-row .agent-msgs {
    /* Tabular nums so the digit columns align across rows. Right-aligned
       since it's a number, not a label. */
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .agent-row .agent-time {
    text-align: right;
    white-space: nowrap;
  }
  .agent-row .agent-sid {
    font-family: ui-monospace, monospace;
  }
  .agent-row .row-close {
    /* Always rendered to reserve column space; hidden by default,
       revealed on hover but only meaningful for open (dimmed) rows. */
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    color: var(--text-muted);
    opacity: 0;
    border-radius: var(--radius-sm);
    pointer-events: none;
  }
  /* Reveal + enable the X only on hover of a row that's already open
     (we use the .dimmed class as the marker for "open elsewhere"). */
  .agent-row.dimmed:hover .row-close {
    opacity: 1;
    pointer-events: auto;
  }
  .agent-row .row-close:hover {
    background: var(--error-bg);
    color: var(--error-text);
  }
  .row-activity {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
    padding: 0.25rem 0.5rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: 0.74rem;
    color: var(--text-3);
    min-width: 0;
  }
  .row-activity .agent-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .row-activity .agent-dot.agent-claude {
    background: var(--chip-orange-text);
  }
  .row-activity .agent-dot.agent-codex {
    background: var(--chip-codex-text);
  }
  .row-activity .agent-dot.agent-copilot {
    background: var(--chip-blue-text);
  }
  .activity-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity-time {
    flex: 0 0 auto;
    font-size: 0.7rem;
  }
  .remove {
    background: transparent;
    color: var(--text-muted);
    padding: 0.15rem 0.5rem;
    font-size: 1.05rem;
    line-height: 1;
    flex: 0 0 auto;
  }
  .remove:hover {
    background: var(--error-bg);
    color: var(--error-text);
  }
  .new-wt {
    background: transparent;
    color: var(--text-muted);
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
    line-height: 1;
    flex: 0 0 auto;
    border: 1px dashed var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .new-wt:hover {
    background: var(--surface-2);
    color: var(--text-2);
    border-style: solid;
  }
  .new-wt-form {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 0.5rem 0.6rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
  }
  .new-wt-input {
    flex: 1;
    padding: 0.35rem 0.5rem;
    font-size: 0.85rem;
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    color: inherit;
    border-radius: var(--radius-sm);
    min-width: 0;
  }

  .row-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    /* Left padding mirrors `.row-activity`'s 0.5rem so the status dot
       lines up vertically with the agent dot in the activity row above. */
    padding: 0 0.5rem;
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--status-dirty);
    display: inline-block;
  }
  .status-dot.clean {
    background: var(--status-clean);
  }
  .ab {
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.02em;
  }
  /* Ahead = local commits not pushed yet. Green = actionable: you have
     work ready to send. Bolder than the old indigo pill so it reads at
     a glance in a row that may also show dirty status + activity. */
  .ab-ahead {
    background: var(--chip-green-bg);
    color: var(--chip-green-text);
  }
  /* Behind = upstream has commits you don't. Orange = stale / needs
     attention, parallel to the dirty-status dot. */
  .ab-behind {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .row-actions {
    margin-left: auto;
    display: flex;
    gap: 0.3rem;
  }

  .row-commit {
    margin-top: 0.45rem;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    overflow: hidden;
  }
  /* Chevron lives inside .row-commit now. Make sure it sits aligned to
     the commit-line text and is interactive without disturbing
     baseline alignment of the sha/subject/author/time. */
  .row-commit > .chevron {
    flex: 0 0 auto;
  }
  .sha {
    /* Inherit font + color from .row-commit so the sha reads as part
       of the same one-line commit summary, not a code chip. */
  }
  .commit-subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .commit-author,
  .commit-time {
    white-space: nowrap;
  }

  /* Expanded section */
  .expanded {
    margin-top: 0.6rem;
    padding-left: 0.8rem;
    border-left: 2px solid var(--surface-2);
    min-width: 0;
  }
  /* Inline diff block (tabs + workdir/staged diff) that renders above
     the row-commit when the worktree is dirty. Same indent + left rule
     as `.expanded` so the column structure stays aligned. */
  .inline-diff {
    margin-top: 0.6rem;
    padding-left: 0.8rem;
    border-left: 2px solid var(--surface-2);
    min-width: 0;
  }
  .tabs-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
  }
  .ctx-toggle {
    padding: 0.25rem 0.6rem;
    background: var(--surface-2);
    color: var(--text-muted);
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
  }
  .ctx-toggle:hover {
    color: var(--text-2);
  }
  .ctx-toggle.active {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }
  .tab {
    padding: 0.25rem 0.6rem;
    background: var(--surface-2);
    border: 0;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .tab:hover {
    color: var(--text-2);
  }
  .tab.active {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .tab-count {
    background: rgba(0, 0, 0, 0.25);
    border-radius: 999px;
    padding: 0 0.4rem;
    font-size: 0.7rem;
  }

  .commits-heading {
    margin: 0.85rem 0 0.3rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .commits {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    max-height: 40vh;
    overflow-y: auto;
  }
  .commit-row {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
    color: var(--text-4);
    overflow: hidden;
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    width: 100%;
    flex-shrink: 0;
  }
  .commit-row:hover {
    background: var(--surface-2);
  }
  .commit-row.open {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .inline-commit {
    margin: 0.15rem 0.5rem 0.4rem 1.6rem;
  }
  .load-more {
    margin-top: 0.4rem;
    align-self: flex-start;
  }

  .chevron {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    margin: 0;
    background: transparent;
    border: 0;
    color: var(--text-faint);
    cursor: pointer;
    border-radius: var(--radius-sm);
    flex: 0 0 auto;
    font-size: 0.85rem;
    line-height: 1;
  }
  .chevron:hover {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .chevron .arrow {
    display: inline-block;
    line-height: 1;
    transition: transform 0.15s ease-out;
  }
  .chevron.open .arrow {
    transform: rotate(90deg);
  }

  /* Events list inside the popover */
  .events {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .events > li {
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.65rem;
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
  }
  .events > li.undone {
    opacity: 0.55;
  }
  .ev-row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
  }
  .ev-type {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .ev-time {
    font-size: 0.72rem;
    white-space: nowrap;
  }
  .ev-meta {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.3rem;
  }
  .actor {
    font-size: 0.68rem;
    padding: 0.08rem 0.45rem;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .actor-user {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .actor-agent {
    background: var(--chip-purple-bg);
    color: var(--chip-purple-text);
  }
  .actor-supergit {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .undo {
    margin-left: auto;
    padding: 0.18rem 0.55rem;
    font-size: 0.72rem;
    background: var(--surface-2);
  }
  .undo:hover {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
  }

  /* Per-row zen — one row takes over the viewport, every other row +
     the top bar are hidden. Esc exits (handled in onMount). */
  main.zen-row > header {
    display: none;
  }
  main.zen-row .row:not(.row-zen) {
    display: none;
  }
  /* The focused row pops out of flow and fills the viewport. The
     row's normal content tree (.row-content → .row-head + body) keeps
     working unchanged; we just give it a viewport-sized canvas. */
  .row.row-zen {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--bg-0, var(--surface-1));
    margin: 0;
    border-radius: 0;
    overflow: hidden;
    padding: 0.6rem 1rem;
    box-sizing: border-box;
  }
  /* In zen, .row-content is a viewport-pinned column flex. We anchor
     each section explicitly so any extra siblings (new-wt-form, etc.)
     can't shift the "elastic" slot onto the wrong child:
       - .row-head / .row-commit / everything else → natural height
         (flex: 0 0 auto) so the chevron bar can never get squeezed.
       - .sessions-strip → flex: 1 1 0; the only grower when history
         is closed.
       - .expanded → flex: 1 1 0; only present when history is open,
         in which case it shares with the strip 50/50.
     min-height:0 unlocks shrinking below intrinsic content; each
     elastic child has its own internal scroll. */
  .row.row-zen > .row-content {
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
  }
  .row.row-zen > .row-content > * {
    flex: 0 0 auto;
  }
  .row.row-zen .sessions-strip {
    flex: 1 1 0;
    min-height: 0;
  }
  .row.row-zen .expanded {
    flex: 1 1 0;
    min-height: 0;
    overflow: auto;
    position: relative;
  }
  /* Zen-only close affordance for the history pane. The existing
     chevron in .row-commit also toggles it, but in zen the chevron is
     a small icon between the strip and the panel — easy to miss when
     scanning the diff. This sticky button stays visible at the panel's
     top-right even as the diff scrolls. */
  .hide-history-btn {
    position: sticky;
    top: 0;
    margin-left: auto;
    margin-bottom: -1.5rem;
    z-index: 2;
    display: block;
    width: max-content;
    background: var(--surface-2);
    color: var(--text-2);
    border: 1px solid var(--surface-3);
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    cursor: pointer;
  }
  .hide-history-btn:hover {
    background: var(--surface-3);
    color: var(--text-1);
  }
  /* TerminalView caps its height at 60vh in the normal dashboard so
     a single TUI doesn't dominate the page. In zen that cap defeats
     the point — let it grow. xterm's FitAddon re-fits via the
     ResizeObserver TerminalView already wires up. Same override for
     SessionView's .session wrapper so its message list / inline TUI
     fills the column. */
  .row.row-zen :global(.terminal-wrap) {
    max-height: none;
    min-height: 0;
    flex: 1 1 0;
  }
  /* Row-head Zen toggle. Sits next to the row's × remove; the icon
     swap (▣ → ◱) gives a quick visual read of state. */
  .row-zen-btn {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    padding: 0.1rem 0.45rem;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .row-zen-btn:hover {
    color: var(--text-1);
    background: var(--surface-3);
  }
  .row-zen-btn.open {
    color: var(--chip-purple-text);
    background: var(--chip-purple-bg);
  }

  /* Fullscreen styling for an individual transient-TUI column. The
     browser paints a black backdrop by default; we just make sure the
     column fills it without its rounded corners + border looking
     awkward on a black surround. xterm's FitAddon reacts to the size
     change via TerminalView's ResizeObserver — no extra wiring. */
  .new-session-col:fullscreen {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
    border: 0;
    background: var(--surface-1);
  }
</style>
