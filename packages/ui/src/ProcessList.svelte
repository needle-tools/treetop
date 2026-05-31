<script lang="ts">
  import { apiUrl } from "./api";
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import Popover from "./Popover.svelte";
  import { repoChipFg } from "./repo-color";
  import { ICONS } from "./icons";
  import {
    processStore,
    recordSamples,
    procHistory,
    averagedCpuFromHistory,
    sortProcsByUsage,
    CPU_AVG_WINDOW_MS,
  } from "./process-store";

  interface Repo {
    id: string;
    path: string;
    name?: string;
    color?: string;
    worktrees?: Worktree[];
    /** Owning remote daemon (undefined ⇒ local). Carried so row-scoped
     *  actions can target the right daemon; grouping by [daemon, name]
     *  is a later Phase-B increment. */
    daemonId?: string;
  }
  interface Worktree {
    path: string;
    branch?: string;
    agents?: Agent[];
  }
  interface Agent {
    sessionId?: string;
    source?: string;
    manualTitle?: string;
    title?: string;
    firstUserMessage?: string;
    lastUserMessage?: string;
  }
  interface ActivityEvent {
    summary: string;
  }

  export interface TuiProc {
    id: string;
    pid: number;
    agent?: string;
    cmd: string[];
    cwd: string;
    ownerId?: string;
    createdAt?: string;
    lastOutputAt?: string;
    cpuPercent: number;
    memBytes: number;
    kind?: "tui" | "external";
    comm?: string;
  }

  interface RepoGroup {
    repoName: string;
    repoColor: string | null;
    totalCpu: number;
    totalMem: number;
    procs: (TuiProc & { ctx: ReturnType<typeof procContext> })[];
  }

  export let repos: Repo[] = [];
  export let activityByCwd: Record<string, ActivityEvent[]> = {};
  export let systemMemBytes: number | null = null;

  const dispatch = createEventDispatcher<{
    focusSession: { source: string };
  }>();

  const TUI_IDLE_MS = 2_000;
  function isIdle(p: TuiProc): boolean {
    if (!p.lastOutputAt) return false;
    return Date.now() - Date.parse(p.lastOutputAt) > TUI_IDLE_MS;
  }

  let open = false;
  export let procs: TuiProc[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let everLoaded = false;
  let loading = false;
  let collapsed: Record<string, boolean> = {};
  let closing: Record<string, boolean> = {};
  let pendingKill: Record<string, boolean> = {};
  let showExternal = true;

  // Processes within a repo are auto-sorted by usage (CPU avg, then mem).
  // While the cursor is over a repo's list we freeze that group's order
  // so rows don't reorder out from under the pointer mid-click. The
  // snapshot is the id order captured the moment the cursor entered;
  // values still update live, only positions hold. `null` = nothing
  // hovered, so every group sorts live.
  let hoveredRepo: string | null = null;
  let frozenOrder: Record<string, string[]> = {};

  const TUI_HOT_MEM_FRACTION = 0.5;
  const TUI_WARM_MEM_FRACTION = 0.3;
  const TUI_HOT_CPU_PERCENT = 50;
  const TUI_WARM_CPU_PERCENT = 30;
  const TUI_HOT_MEM_FALLBACK = 500 * 1024 * 1024;
  const TUI_WARM_MEM_FALLBACK = 300 * 1024 * 1024;

  $: hotMemBytes = systemMemBytes
    ? systemMemBytes * TUI_HOT_MEM_FRACTION
    : TUI_HOT_MEM_FALLBACK;
  $: warmMemBytes = systemMemBytes
    ? systemMemBytes * TUI_WARM_MEM_FRACTION
    : TUI_WARM_MEM_FALLBACK;

  // Displayed CPU% is a trailing average over CPU_AVG_WINDOW_MS, not the
  // raw per-poll sample. A single Windows perf-counter read is 0 for most
  // bursty processes, so the raw value flickers 0↔spike and usually shows
  // 0; averaging the samples we already collect (procHistory) yields a
  // stable, representative figure. Recomputed whenever procHistory changes
  // (each refresh). cpuOf() falls back to the raw value until a process
  // has accumulated at least one in-window sample.
  $: avgCpuById = averagedCpuFromHistory(
    $procHistory,
    CPU_AVG_WINDOW_MS,
    Date.now(),
  );
  function cpuOf(p: TuiProc, avg: Map<string, number>): number {
    return avg.get(p.id) ?? p.cpuPercent;
  }

  const hotDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("tuihot") === "1";
  const warmDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("tuiwarm") === "1";

  $: isHot =
    hotDebug ||
    procs.some(
      (p) =>
        p.memBytes > hotMemBytes ||
        cpuOf(p, avgCpuById) > TUI_HOT_CPU_PERCENT,
    );
  $: isWarm =
    !isHot &&
    (warmDebug ||
      procs.some(
        (p) =>
          p.memBytes > warmMemBytes ||
          cpuOf(p, avgCpuById) > TUI_WARM_CPU_PERCENT,
      ));

  $: visibleProcs = showExternal
    ? procs
    : procs.filter((p) => p.kind !== "external");
  $: grouped = groupByRepo(visibleProcs, avgCpuById);

  // Apply the per-group sort: hovered group keeps its frozen order;
  // every other group sorts live by usage. Depends on grouped,
  // avgCpuById, hoveredRepo, and frozenOrder so it re-runs whenever any
  // of them change.
  $: displayGroups = grouped.map((g) => {
    const frozen = frozenOrder[g.repoName];
    if (g.repoName === hoveredRepo && frozen) {
      const rank = new Map(frozen.map((id, i) => [id, i]));
      const procs = [...g.procs].sort(
        (a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
      return { ...g, procs };
    }
    return { ...g, procs: sortProcsByUsage(g.procs, avgCpuById) };
  });

  // Fired on each process row's mouseenter. Snapshot the group's current
  // (live-sorted) order the first time the cursor lands in it so freezing
  // causes no jump. The guard is essential: moving between rows in the
  // same group must NOT re-snapshot (a re-snapshot against changed CPU
  // values is exactly the reorder-under-the-cursor we're preventing).
  // Entering a different group switches the snapshot — the previously
  // hovered group is no longer `hoveredRepo`, so it resumes live sorting.
  function freezeGroup(repoName: string) {
    if (hoveredRepo === repoName) return;
    const g = grouped.find((x) => x.repoName === repoName);
    if (g) {
      frozenOrder = {
        ...frozenOrder,
        [repoName]: sortProcsByUsage(g.procs, avgCpuById).map((p) => p.id),
      };
    }
    hoveredRepo = repoName;
  }
  // Fired when the cursor leaves the whole process list (not on row→row
  // moves within it — those keep the freeze, since the gap between rows
  // isn't an element). Resumes live sorting everywhere.
  function clearFreeze() {
    hoveredRepo = null;
    frozenOrder = {};
  }

  function groupByRepo(
    list: TuiProc[],
    avg: Map<string, number>,
  ): RepoGroup[] {
    const map = new Map<string, RepoGroup>();
    for (const p of list) {
      const ctx = procContext(p);
      const key = ctx.repoName ?? "Other";
      let group = map.get(key);
      if (!group) {
        group = {
          repoName: key,
          repoColor: ctx.repoColor,
          totalCpu: 0,
          totalMem: 0,
          procs: [],
        };
        map.set(key, group);
      }
      group.totalCpu += cpuOf(p, avg);
      group.totalMem += p.memBytes;
      group.procs.push({ ...p, ctx });
    }
    for (const repo of repos) {
      const name =
        repo.name ?? repo.path.split("/").filter(Boolean).pop() ?? repo.path;
      if (!map.has(name)) {
        map.set(name, {
          repoName: name,
          repoColor: repo.color ?? null,
          totalCpu: 0,
          totalMem: 0,
          procs: [],
        });
      }
    }
    // Emit groups in the same vertical order the repos appear on the
    // board. The dashboard renders rows as `repos.flatMap(...)` (see
    // App.svelte), so `repos` order *is* the on-screen order; follow it
    // here instead of process-first-seen order. Any group not tied to a
    // known repo (the "Other" bucket for processes whose cwd matches no
    // repo) sorts last, in first-seen order.
    const ordered: RepoGroup[] = [];
    const placed = new Set<string>();
    for (const repo of repos) {
      const name =
        repo.name ?? repo.path.split("/").filter(Boolean).pop() ?? repo.path;
      const group = map.get(name);
      if (group && !placed.has(name)) {
        ordered.push(group);
        placed.add(name);
      }
    }
    for (const [name, group] of map) {
      if (!placed.has(name)) ordered.push(group);
    }
    return ordered;
  }

  function toggleGroup(name: string) {
    collapsed = { ...collapsed, [name]: !collapsed[name] };
  }

  async function refresh() {
    loading = true;
    try {
      const res = await fetch(apiUrl("/api/processes"));
      if (!res.ok) return;
      procs = (await res.json()) as TuiProc[];
      processStore.set(procs);
      recordSamples(procs);
      everLoaded = true;
      const liveIds = new Set(procs.map((p) => p.id));
      for (const id of Object.keys(pendingKill)) {
        if (!liveIds.has(id)) delete pendingKill[id];
      }
      for (const id of Object.keys(closing)) {
        if (!liveIds.has(id)) delete closing[id];
      }
      pendingKill = pendingKill;
      closing = closing;
    } catch {
    } finally {
      loading = false;
    }
  }

  const SLOW_MS = 10_000;
  const FAST_MS = 2_000;
  function startPolling(intervalMs: number) {
    if (pollTimer) clearInterval(pollTimer);
    void refresh();
    pollTimer = setInterval(refresh, intervalMs);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function toggle() {
    open = !open;
    startPolling(open ? FAST_MS : SLOW_MS);
  }
  async function sendTerm(p: TuiProc) {
    if (p.kind !== "external") {
      await fetch(apiUrl(`/api/terminals/${encodeURIComponent(p.id)}`), {
        method: "DELETE",
      }).catch(() => {});
    } else {
      await fetch(apiUrl(`/api/processes/${p.pid}/kill`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "SIGTERM" }),
      }).catch(() => {});
    }
  }
  async function sendKill(p: TuiProc) {
    await fetch(apiUrl(`/api/processes/${p.pid}/kill`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal: "SIGKILL" }),
    }).catch(() => {});
  }
  async function closeProc(p: TuiProc) {
    if (pendingKill[p.id]) {
      await sendKill(p);
      delete pendingKill[p.id];
      delete closing[p.id];
      pendingKill = pendingKill;
      closing = closing;
      void refresh();
      return;
    }
    closing = { ...closing, [p.id]: true };
    await sendTerm(p);
    setTimeout(() => {
      if (!closing[p.id]) return;
      delete closing[p.id];
      closing = closing;
      pendingKill = { ...pendingKill, [p.id]: true };
      void refresh();
    }, 2000);
  }
  async function forceKillProc(p: TuiProc) {
    await sendKill(p);
    delete pendingKill[p.id];
    delete closing[p.id];
    pendingKill = pendingKill;
    closing = closing;
    void refresh();
  }

  // Locale-aware number rendering so large values get the user's
  // thousands separator (e.g. "12.345,6 MB" in de-DE, "12,345.6 MB" in
  // en-US) instead of a bare "12345.6". Matches the rest of the app,
  // which formats counts via `toLocaleString()`.
  function formatBytes(n: number): string {
    if (!n) return "—";
    if (n < 1024 * 1024)
      return `${(n / 1024).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })} KB`;
    return `${(n / 1024 / 1024).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} MB`;
  }
  function formatPercent(n: number): string {
    return `${n.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`;
  }
  function formatUptime(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  function prettyName(p: TuiProc): string {
    if (p.agent === "claude") return "Claude";
    if (p.agent === "codex") return "Codex";
    if (p.agent === "copilot") return "Copilot";
    if (p.agent === "ollama") return "Ollama";
    const head = p.cmd[0]?.split(/[\\/]/).pop();
    return head || "tui";
  }

  function procContext(p: TuiProc): {
    repoName: string | null;
    repoColor: string | null;
    wtBranch: string | null;
    relCwd: string | null;
    title: string | null;
    lastActivity: string | null;
  } {
    let repoName: string | null = null;
    let repoColor: string | null = null;
    let wtBranch: string | null = null;
    let relCwd: string | null = null;
    let title: string | null = null;
    outer: for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        const match = p.cwd === wt.path || p.cwd.startsWith(wt.path + "/");
        if (!match) continue;
        repoName =
          repo.name ?? repo.path.split("/").filter(Boolean).pop() ?? null;
        repoColor = repo.color ?? null;
        wtBranch = wt.branch ?? null;
        relCwd = p.cwd === wt.path ? null : p.cwd.slice(wt.path.length + 1);
        if (p.ownerId) {
          for (const a of wt.agents ?? []) {
            if (a.sessionId === p.ownerId) {
              title =
                a.manualTitle ??
                a.title ??
                a.firstUserMessage ??
                a.lastUserMessage ??
                null;
              break;
            }
          }
        }
        break outer;
      }
      if (
        !repoName &&
        (p.cwd === repo.path || p.cwd.startsWith(repo.path + "/"))
      ) {
        repoName =
          repo.name ?? repo.path.split("/").filter(Boolean).pop() ?? null;
        repoColor = repo.color ?? null;
        relCwd = p.cwd === repo.path ? null : p.cwd.slice(repo.path.length + 1);
      }
    }
    const acts = activityByCwd[p.cwd] ?? [];
    const lastActivity = acts.length > 0 ? (acts[0]?.summary ?? null) : null;
    return { repoName, repoColor, wtBranch, relCwd, title, lastActivity };
  }

  function procSource(p: TuiProc): string | null {
    if (!p.ownerId) return null;
    for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        if (wt.path !== p.cwd) continue;
        for (const a of wt.agents ?? []) {
          if (a.sessionId === p.ownerId) return a.source ?? null;
        }
      }
    }
    return null;
  }

  async function focusProc(p: TuiProc): Promise<void> {
    const source = procSource(p);
    if (!source) return;
    open = false;
    startPolling(SLOW_MS);
    dispatch("focusSession", { source });
  }

  export function closeIfOpen() {
    if (open) {
      open = false;
      startPolling(SLOW_MS);
    }
  }

  onMount(() => startPolling(SLOW_MS));
  onDestroy(() => stopPolling());
</script>

<div class="actions-anchor tuis-anchor">
  <button
    class="actions-btn tuis-btn"
    class:open
    class:warm={isWarm}
    class:hot={isHot}
    on:click={toggle}
    title={isHot
      ? "A process is using significant CPU or memory — open to inspect"
      : isWarm
        ? "A process is working hard — open to inspect"
        : "Processes running in your repos"}
  >
    Procs
    <span class="count">{procs.length}</span>
  </button>
  {#if open}
    <Popover variant="actions" extraClass="tuis-popover">
      <svelte:fragment slot="head">
        <span class="proc-head-row">
          <span>Processes</span>
          <span
            class="popover-spinner"
            class:popover-spinner-hidden={!loading}
            aria-label="loading"
            title="refreshing"
          ></span>
          <span class="proc-head-spacer"></span>
          <label
            class="proc-toggle"
            title="Show processes discovered in repo directories (not spawned by supergit)"
          >
            <input type="checkbox" bind:checked={showExternal} />
            Subprocesses
          </label>
        </span>
      </svelte:fragment>
      {#if !everLoaded}
        <p class="muted small nopad">Loading…</p>
      {:else if procs.length === 0}
        <p class="muted small nopad">Nothing running.</p>
      {:else}
        <!-- mouseleave here is a pointer-only affordance (resume live
             sorting when the cursor leaves the list); it carries no
             semantics for keyboard/AT users, so a static layout div is
             correct and an ARIA role would be misleading. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="proc-groups" on:mouseleave={clearFreeze}>
          {#each displayGroups as group (group.repoName)}
            <div class="proc-group">
              <button
                class="proc-group-header"
                on:click={() => toggleGroup(group.repoName)}
              >
                <svg
                  class="proc-group-chevron"
                  class:collapsed={collapsed[group.repoName]}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span class="proc-group-label">
                  <span
                    class="proc-group-badge"
                    class:proc-group-badge-colored={!!group.repoColor}
                    style={group.repoColor
                      ? `--repo-bg: ${group.repoColor}; --repo-fg: ${repoChipFg(
                          group.repoColor,
                        )}`
                      : ""}>{group.repoName}</span
                  >
                  <span class="proc-group-count">{group.procs.length}</span>
                </span>
                <span class="proc-group-stat proc-group-cpu"
                  >{formatPercent(group.totalCpu)}</span
                >
                <span class="proc-group-stat proc-group-mem"
                  >{formatBytes(group.totalMem)}</span
                >
              </button>
              {#if !collapsed[group.repoName]}
                {#if group.procs.length === 0}
                  <p class="muted small proc-empty">
                    <svg
                      class="proc-empty-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" /><path
                        d="M5.6 5.6l12.8 12.8"
                      />
                    </svg>
                    No processes running
                  </p>
                {:else}
                  <ul class="agents-list">
                    <li class="proc-col-header">
                      <span></span>
                      <span>Name</span>
                      <span>Info</span>
                      <span title="Average CPU over the last 30s">CPU</span>
                      <span>Mem</span>
                      <span>Up</span>
                      <span></span>
                      <span></span>
                    </li>
                    {#each group.procs as p (p.id)}
                      {@const ctx = p.ctx}
                      {@const cpu = cpuOf(p, avgCpuById)}
                      {@const source =
                        p.kind !== "external" ? procSource(p) : null}
                      {@const isExternal = p.kind === "external"}
                      {@const procWarm =
                        p.memBytes > warmMemBytes ||
                        cpu > TUI_WARM_CPU_PERCENT}
                      {@const procHot =
                        p.memBytes > hotMemBytes ||
                        cpu > TUI_HOT_CPU_PERCENT}
                      <li>
                        <div
                          class="agent-row tui-row-static"
                          class:proc-warm={procWarm && !procHot}
                          class:proc-hot={procHot}
                          class:tui-row-focusable={source !== null}
                          role={source !== null ? "button" : undefined}
                          tabindex={source !== null ? 0 : -1}
                          on:mouseenter={() => freezeGroup(group.repoName)}
                          on:click={() => {
                            if (!isExternal) void focusProc(p);
                          }}
                          on:keydown={(e) => {
                            if (
                              source !== null &&
                              (e.key === "Enter" || e.key === " ")
                            ) {
                              e.preventDefault();
                              void focusProc(p);
                            }
                          }}
                          title={isExternal
                            ? `pid ${p.pid} — ${p.cmd.join(" ")}\n${p.cwd}`
                            : source !== null
                              ? "Click to jump to this session in its worktree strip"
                              : undefined}
                        >
                          {#if p.agent === "claude"}
                            <img
                              class="agent-row-icon"
                              src="/agents/claude.svg"
                              alt=""
                            />
                          {:else if p.agent === "codex"}
                            <img
                              class="agent-row-icon"
                              src="/agents/codex.svg"
                              alt=""
                            />
                          {:else if p.agent === "ollama"}
                            <img
                              class="agent-row-icon"
                              src="/agents/ollama.svg"
                              alt=""
                            />
                          {:else if !isExternal}
                            <!-- Terminal/shell session: dark "screen" box
                                 glyph (the alt terminal icon in icons.ts),
                                 not the plain prompt chevron. -->
                            <svg
                              class="agent-row-icon proc-terminal-icon"
                              viewBox="0 0 24 24"
                              width="14"
                              height="14"
                              aria-hidden="true"
                              >{@html ICONS["terminal-screen"]?.svg ?? ""}</svg
                            >
                          {:else}
                            <svg
                              class="agent-row-icon proc-icon"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M4 17l5-5-5-5" /><path d="M11 19h8" />
                            </svg>
                          {/if}
                          <span class="agent-row-name"
                            >{isExternal
                              ? (p.comm ?? p.cmd[0] ?? "process")
                              : prettyName(p)}</span
                          >
                          <span
                            class="tui-inline-title"
                            title={`${ctx.title ?? p.cmd.join(" ")}\n${p.cwd}`}
                          >
                            <span class="tui-inline-cmd"
                              >{#if ctx.title}{ctx.title}{:else}{p.cmd.join(
                                  " ",
                                )}{/if}</span
                            >
                            {#if ctx.relCwd}<span class="tui-inline-cwd"
                                >{ctx.relCwd}</span
                              >{/if}
                          </span>
                          <span
                            class="tui-stat tui-cpu"
                            class:tui-stat-muted={cpu < 2}
                            title={`pid ${p.pid} — avg CPU over last ${Math.round(
                              CPU_AVG_WINDOW_MS / 1000,
                            )}s (now ${formatPercent(
                              p.cpuPercent,
                            )})\n${p.cmd.join(" ")}`}
                            >{formatPercent(cpu)}</span
                          >
                          <span
                            class="tui-stat tui-mem"
                            class:tui-stat-muted={systemMemBytes !== null && p.memBytes < systemMemBytes * 0.02}
                            >{formatBytes(p.memBytes)}</span
                          >
                          {#if p.createdAt}
                            <span class="tui-stat tui-uptime"
                              >{formatUptime(p.createdAt)}</span
                            >
                          {/if}
                          {#if !isExternal && p.lastOutputAt && isIdle(p)}
                            <span class="tui-stat tui-idle"
                              >idle {formatUptime(p.lastOutputAt)}</span
                            >
                          {/if}
                          <button
                            class="row-close tui-kill-x"
                            class:tui-kill-closing={closing[p.id]}
                            class:tui-kill-pending={pendingKill[p.id]}
                            on:click|stopPropagation={() => closeProc(p)}
                            on:dblclick|stopPropagation={() => forceKillProc(p)}
                            title={pendingKill[p.id]
                              ? "Process didn't exit — click to force kill (SIGKILL)"
                              : closing[p.id]
                                ? "Closing… waiting for process to exit"
                                : "Close process (SIGTERM). Double-click to force kill."}
                            aria-label={pendingKill[p.id]
                              ? "Force kill"
                              : closing[p.id]
                                ? "Closing"
                                : "Close process"}
                            >{#if closing[p.id]}<svg
                                class="kill-spinner"
                                viewBox="0 0 16 16"
                                aria-hidden="true"
                                ><circle
                                  cx="8"
                                  cy="8"
                                  r="6"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="1.5"
                                  stroke-dasharray="28"
                                  stroke-dashoffset="8"
                                /></svg
                              >{:else if pendingKill[p.id]}<svg
                                class="kill-skull"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                aria-hidden="true"
                                ><circle cx="12" cy="10" r="7" /><circle
                                  cx="9"
                                  cy="9"
                                  r="1.2"
                                  fill="currentColor"
                                  stroke="none"
                                /><circle
                                  cx="15"
                                  cy="9"
                                  r="1.2"
                                  fill="currentColor"
                                  stroke="none"
                                /><path d="M9.5 14.5 L12 13 L14.5 14.5" /><path
                                  d="M9 17v3"
                                /><path d="M12 17v3" /><path
                                  d="M15 17v3"
                                /></svg
                              >{:else}×{/if}</button
                          >
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Popover>
  {/if}
</div>
