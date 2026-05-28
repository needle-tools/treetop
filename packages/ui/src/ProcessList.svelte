<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import Popover from "./Popover.svelte";
  import { processStore, recordSamples } from "./process-store";

  interface Repo {
    id: string;
    path: string;
    name?: string;
    color?: string;
    worktrees?: Worktree[];
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

  const hotDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("tuihot") === "1";
  const warmDebug =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("tuiwarm") === "1";

  $: isHot =
    hotDebug ||
    procs.some(
      (p) => p.memBytes > hotMemBytes || p.cpuPercent > TUI_HOT_CPU_PERCENT,
    );
  $: isWarm =
    !isHot &&
    (warmDebug ||
      procs.some(
        (p) => p.memBytes > warmMemBytes || p.cpuPercent > TUI_WARM_CPU_PERCENT,
      ));

  $: visibleProcs = showExternal
    ? procs
    : procs.filter((p) => p.kind !== "external");
  $: grouped = groupByRepo(visibleProcs);

  function groupByRepo(list: TuiProc[]): RepoGroup[] {
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
      group.totalCpu += p.cpuPercent;
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
    return [...map.values()];
  }

  function toggleGroup(name: string) {
    collapsed = { ...collapsed, [name]: !collapsed[name] };
  }

  async function refresh() {
    loading = true;
    try {
      const res = await fetch("/api/processes");
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
      await fetch(`/api/terminals/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
      }).catch(() => {});
    } else {
      await fetch(`/api/processes/${p.pid}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "SIGTERM" }),
      }).catch(() => {});
    }
  }
  async function sendKill(p: TuiProc) {
    await fetch(`/api/processes/${p.pid}/kill`, {
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

  function formatBytes(n: number): string {
    if (!n) return "—";
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
        <div class="proc-groups">
          {#each grouped as group (group.repoName)}
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
                <span
                  class="proc-group-name"
                  style={group.repoColor ? `color: ${group.repoColor}` : ""}
                  >{group.repoName}</span
                >
                <span class="proc-group-count">{group.procs.length}</span>
                <span class="proc-group-spacer"></span>
                <span class="proc-group-stat">{group.totalCpu.toFixed(1)}%</span
                >
                <span class="proc-group-stat"
                  >{formatBytes(group.totalMem)}</span
                >
              </button>
              {#if !collapsed[group.repoName]}
                {#if group.procs.length === 0}
                  <p class="muted small proc-empty">No processes running</p>
                {:else}
                  <ul class="agents-list">
                    <li class="proc-col-header">
                      <span></span>
                      <span>Name</span>
                      <span>Info</span>
                      <span>CPU</span>
                      <span>Mem</span>
                      <span>Up</span>
                      <span></span>
                      <span></span>
                    </li>
                    {#each group.procs as p (p.id)}
                      {@const ctx = p.ctx}
                      {@const source =
                        p.kind !== "external" ? procSource(p) : null}
                      {@const isExternal = p.kind === "external"}
                      {@const procWarm =
                        p.memBytes > warmMemBytes ||
                        p.cpuPercent > TUI_WARM_CPU_PERCENT}
                      {@const procHot =
                        p.memBytes > hotMemBytes ||
                        p.cpuPercent > TUI_HOT_CPU_PERCENT}
                      <li>
                        <div
                          class="agent-row tui-row-static"
                          class:proc-warm={procWarm && !procHot}
                          class:proc-hot={procHot}
                          class:tui-row-focusable={source !== null}
                          role={source !== null ? "button" : undefined}
                          tabindex={source !== null ? 0 : -1}
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
                            {#if ctx.title}{ctx.title}{:else}{p.cmd.join(
                                " ",
                              )}{/if}
                            {#if ctx.relCwd}<span class="tui-inline-cwd"
                                >{ctx.relCwd}</span
                              >{/if}
                          </span>
                          <span
                            class="tui-stat tui-cpu"
                            title={`pid ${p.pid} — ${p.cmd.join(" ")}`}
                            >{p.cpuPercent.toFixed(1)}%</span
                          >
                          <span class="tui-stat tui-mem"
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
