<script lang="ts">
  import { createEventDispatcher, onDestroy } from "svelte";
  import Popover from "./Popover.svelte";
  import { apiUrl } from "./api";
  import { errorKindLabel, eventToText } from "./event-format";
  import { relTime } from "./display-helpers";
  import type { FrontendErrorEntry } from "./errors";
  export let errorEntries: FrontendErrorEntry[];
  const dispatch = createEventDispatcher();
  type EventsTab = "log" | "perf";
  type AnalyzePayload = {
    generatedAt?: string;
    durationMs?: number;
    requestRate?: {
      total?: number;
      perSec?: number;
      top?: Array<{ path?: string; count?: number }>;
    };
    probes?: {
      timings?: { value?: Record<string, TimingSummary> };
      memory?: {
        value?: {
          memoryUsage?: Record<string, number>;
          uptimeSec?: number;
          pid?: number;
        };
      };
      terminals?: {
        value?: {
          total?: number;
          alive?: number;
          visible?: number;
          pendingWs?: number;
          byAgent?: Record<string, number>;
        };
      };
    };
  };
  type TimingSummary = {
    count?: number;
    p50?: number;
    p95?: number;
    max?: number;
    last?: number;
  };
  type PerfRow = {
    key: string;
    label: string;
    value: string;
    detail?: string;
  };
  let activeTab: EventsTab = "log";
  /** id -> true when the user has expanded its stack trace inline. */
  let errorExpanded: Record<string, boolean> = {};
  function toggleErrorExpanded(id: string) {
    errorExpanded = { ...errorExpanded, [id]: !errorExpanded[id] };
  }
  /** id of the event whose Copy button is flashing "Copied". */
  let copiedErrorId: string | null = null;
  let copiedErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let analyzeBusy = false;
  let analyzeJson = "";
  let analyzeError = "";
  let analyzeCopied = false;
  let analyzeCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  function flashCopied(id: string) {
    copiedErrorId = id;
    if (copiedErrorTimer) clearTimeout(copiedErrorTimer);
    copiedErrorTimer = setTimeout(() => {
      copiedErrorId = null;
      copiedErrorTimer = null;
    }, 1200);
  }
  function flashAnalyzeCopied() {
    analyzeCopied = true;
    if (analyzeCopiedTimer) clearTimeout(analyzeCopiedTimer);
    analyzeCopiedTimer = setTimeout(() => {
      analyzeCopied = false;
      analyzeCopiedTimer = null;
    }, 1200);
  }
  /** Robust clipboard write — the async Clipboard API is silently
   *  rejected in WebView2 / strict-Permissions contexts even under a
   *  trusted gesture, so we fall back to a transient offscreen textarea
   *  + execCommand("copy"). Same pattern as TerminalView.svelte. Only
   *  flash "Copied" once a write actually lands. */
  function copyText(text: string, onCopied: () => void, label: string) {
    const tryLegacy = (): boolean => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText =
          "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(ta);
        const prev = document.activeElement as HTMLElement | null;
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        try {
          prev?.focus();
        } catch {
          /* best-effort restore */
        }
        return ok;
      } catch {
        return false;
      }
    };
    const writeText = navigator.clipboard?.writeText;
    if (writeText) {
      writeText.call(navigator.clipboard, text).then(onCopied, () => {
        if (tryLegacy()) onCopied();
        else console.warn(`supergit: clipboard write failed (${label})`);
      });
      return;
    }
    if (tryLegacy()) onCopied();
    else console.warn(`supergit: clipboard write failed (${label})`);
  }
  function copyError(e: FrontendErrorEntry) {
    copyText(eventToText(e), () => flashCopied(e.id), "event copy");
  }
  function copyAnalyzeJson() {
    if (!analyzeJson) return;
    copyText(analyzeJson, flashAnalyzeCopied, "diagnostic analyze copy");
  }
  async function analyzeServer() {
    if (analyzeBusy) return;
    analyzeBusy = true;
    analyzeError = "";
    try {
      const res = await fetch(apiUrl("/api/debug/analyze?instance=1"), {
        cache: "no-cache",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body && typeof body.error === "string"
            ? body.error
            : `/api/debug/analyze?instance=1: ${res.status}`,
        );
      }
      analyzeJson = JSON.stringify(body, null, 2);
    } catch (err) {
      analyzeError = err instanceof Error ? err.message : String(err);
    } finally {
      analyzeBusy = false;
    }
  }
  function parseAnalyzeJson(raw: string): AnalyzePayload | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as AnalyzePayload)
        : null;
    } catch {
      return null;
    }
  }
  function numberValue(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  function formatMs(v: unknown): string {
    const n = numberValue(v);
    if (n === null) return "n/a";
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
    return `${Math.round(n)}ms`;
  }
  function formatBytes(v: unknown): string {
    const n = numberValue(v);
    if (n === null) return "n/a";
    const mib = n / 1024 / 1024;
    if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
    return `${Math.round(mib)} MiB`;
  }
  function routeBase(route: string | undefined): string {
    if (!route) return "(unknown)";
    return route.split("?", 1)[0] || route;
  }
  function extraNumber(e: FrontendErrorEntry, key: string): number | null {
    return numberValue(e.extra?.[key]);
  }
  function recentStalls(entries: FrontendErrorEntry[]): PerfRow[] {
    return entries
      .filter((e) => e.message.startsWith("browser-event-loop-stall"))
      .slice(0, 8)
      .map((e) => ({
        key: e.id,
        label: relTime(e.timestamp),
        value: formatMs(extraNumber(e, "driftMs")),
        detail:
          e.extra?.inFlightFetches !== undefined
            ? `${e.extra.inFlightFetches} fetches`
            : undefined,
      }));
  }
  function slowRoutes(entries: FrontendErrorEntry[]): PerfRow[] {
    const byRoute = new Map<string, { count: number; max: number; method: string }>();
    for (const e of entries) {
      const fetchMs = extraNumber(e, "fetchMs");
      if (fetchMs === null || !e.route) continue;
      const route = routeBase(e.route);
      const existing = byRoute.get(route);
      if (!existing) {
        byRoute.set(route, {
          count: e.count ?? 1,
          max: fetchMs,
          method: e.method ?? "",
        });
      } else {
        existing.count += e.count ?? 1;
        existing.max = Math.max(existing.max, fetchMs);
      }
    }
    return [...byRoute.entries()]
      .sort((a, b) => b[1].max - a[1].max)
      .slice(0, 10)
      .map(([route, stats]) => ({
        key: route,
        label: `${stats.method} ${route}`.trim(),
        value: formatMs(stats.max),
        detail: `${stats.count} samples`,
      }));
  }
  function timingRows(payload: AnalyzePayload | null): PerfRow[] {
    return Object.entries(payload?.probes?.timings?.value ?? {})
      .sort((a, b) => (b[1].max ?? 0) - (a[1].max ?? 0))
      .slice(0, 10)
      .map(([name, t]) => ({
        key: name,
        label: name,
        value: formatMs(t.max),
        detail: `p95 ${formatMs(t.p95)} · last ${formatMs(t.last)} · n ${t.count ?? 0}`,
      }));
  }
  function requestRows(payload: AnalyzePayload | null): PerfRow[] {
    return (payload?.requestRate?.top ?? []).slice(0, 10).map((r) => ({
      key: r.path ?? "(unknown)",
      label: r.path ?? "(unknown)",
      value: `${r.count ?? 0}`,
      detail: "requests",
    }));
  }
  $: analyzeData = parseAnalyzeJson(analyzeJson);
  $: stallRows = recentStalls(errorEntries);
  $: slowRouteRows = slowRoutes(errorEntries);
  $: daemonTimingRows = timingRows(analyzeData);
  $: requestRateRows = requestRows(analyzeData);
  $: memoryUsage = analyzeData?.probes?.memory?.value?.memoryUsage ?? {};
  $: terminalSummary = analyzeData?.probes?.terminals?.value ?? null;
  // Preserve the SSE error_clear behavior locally: when the list empties
  // (cleared via Clear button or the daemon's error_clear broadcast),
  // drop the stale expand-state — mirrors App's old `errorExpanded = {}`.
  $: if (errorEntries.length === 0) errorExpanded = {};
  onDestroy(() => {
    if (copiedErrorTimer) clearTimeout(copiedErrorTimer);
    if (analyzeCopiedTimer) clearTimeout(analyzeCopiedTimer);
  });
</script>

<Popover variant="actions" extraClass="events-popover" unclamped>
  <svelte:fragment slot="head">
    Events
    {#if errorEntries.length > 0}
      <button
        class="undo events-clear"
        on:click={() => dispatch("clear")}
        title="Clear the recorded error log">Clear</button
      >
    {/if}
  </svelte:fragment>
  <div class="events-tabs" role="tablist" aria-label="Events view">
    <button
      class:active={activeTab === "log"}
      role="tab"
      aria-selected={activeTab === "log"}
      on:click={() => (activeTab = "log")}>Log</button
    >
    <button
      class:active={activeTab === "perf"}
      role="tab"
      aria-selected={activeTab === "perf"}
      on:click={() => (activeTab = "perf")}>Perf</button
    >
  </div>
  {#if activeTab === "log"}
    {#if errorEntries.length === 0}
      <p class="muted small nopad">No errors.</p>
    {:else}
      <ul class="events err-list">
        {#each errorEntries.slice(0, 50) as e (e.id)}
          <li>
            <div
              class="err-row"
              class:expanded={errorExpanded[e.id]}
              role="button"
              tabindex="0"
              on:click={() => toggleErrorExpanded(e.id)}
              on:keydown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  toggleErrorExpanded(e.id);
                }
              }}
            >
              <span class="err-kind err-kind-{e.kind}">{errorKindLabel(e)}</span>
              <span class="err-msg" title={e.message}>
                {e.message}
                {#if e.count && e.count > 1}
                  <span class="err-count" title={`${e.count} occurrences`}
                    >× {e.count}</span
                  >
                {/if}
              </span>
              <button
                class="err-copy"
                title="Copy this event to the clipboard"
                on:click|stopPropagation={() => copyError(e)}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path
                    d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                  />
                </svg>
                {copiedErrorId === e.id ? "Copied" : "Copy"}
              </button>
              <span class="muted ev-time">{relTime(e.timestamp)}</span>
            </div>
            {#if errorExpanded[e.id]}
              <div class="err-detail">
                <div class="err-meta">
                  <span
                    class="actor actor-{e.source === 'daemon'
                      ? 'supergit'
                      : 'user'}">{e.source}</span
                  >
                  {#if e.method || e.route}
                    <code class="err-route">{e.method ?? ""} {e.route ?? ""}</code
                    >
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
  {:else}
    <div class="perf-panel">
      <div class="perf-actions">
        <button
          class="undo events-analyze-btn"
          disabled={analyzeBusy}
          on:click={analyzeServer}
          title="Collect and log a bounded daemon diagnostic JSON report"
        >
          {analyzeBusy ? "Analyzing..." : "Analyze"}
        </button>
        {#if analyzeJson}
          <button
            class="err-copy events-analyze-copy"
            on:click={copyAnalyzeJson}
            title="Copy the diagnostic JSON"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {analyzeCopied ? "Copied" : "Copy JSON"}
          </button>
        {/if}
        {#if analyzeData?.generatedAt}
          <span class="muted perf-stamp">{relTime(analyzeData.generatedAt)}</span>
        {/if}
      </div>
      {#if analyzeError}
        <p class="muted small events-analyze-error">{analyzeError}</p>
      {/if}
      <div class="perf-grid">
        <section class="perf-card">
          <h3>Requests</h3>
          <div class="perf-metric">
            <strong>{analyzeData?.requestRate?.total ?? "n/a"}</strong>
            <span>{analyzeData?.requestRate?.perSec?.toFixed(1) ?? "n/a"}/s</span>
          </div>
          <ul class="perf-table">
            {#each requestRateRows as row (row.key)}
              <li>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </li>
            {:else}
              <li class="empty"><span>No sample</span></li>
            {/each}
          </ul>
        </section>
        <section class="perf-card">
          <h3>Renderer Stalls</h3>
          <ul class="perf-table">
            {#each stallRows as row (row.key)}
              <li>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
                {#if row.detail}<em>{row.detail}</em>{/if}
              </li>
            {:else}
              <li class="empty"><span>No recent stalls</span></li>
            {/each}
          </ul>
        </section>
        <section class="perf-card">
          <h3>Slow Routes</h3>
          <ul class="perf-table">
            {#each slowRouteRows as row (row.key)}
              <li>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
                {#if row.detail}<em>{row.detail}</em>{/if}
              </li>
            {:else}
              <li class="empty"><span>No slow routes</span></li>
            {/each}
          </ul>
        </section>
        <section class="perf-card">
          <h3>Daemon Timings</h3>
          <ul class="perf-table">
            {#each daemonTimingRows as row (row.key)}
              <li>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
                {#if row.detail}<em>{row.detail}</em>{/if}
              </li>
            {:else}
              <li class="empty"><span>No sample</span></li>
            {/each}
          </ul>
        </section>
        <section class="perf-card compact">
          <h3>Memory</h3>
          <dl class="perf-kv">
            <div><dt>RSS</dt><dd>{formatBytes(memoryUsage.rss)}</dd></div>
            <div><dt>Heap</dt><dd>{formatBytes(memoryUsage.heapUsed)}</dd></div>
            <div><dt>External</dt><dd>{formatBytes(memoryUsage.external)}</dd></div>
            <div><dt>Buffers</dt><dd>{formatBytes(memoryUsage.arrayBuffers)}</dd></div>
          </dl>
        </section>
        <section class="perf-card compact">
          <h3>Terminals</h3>
          <dl class="perf-kv">
            <div><dt>Total</dt><dd>{terminalSummary?.total ?? "n/a"}</dd></div>
            <div><dt>Alive</dt><dd>{terminalSummary?.alive ?? "n/a"}</dd></div>
            <div><dt>Visible</dt><dd>{terminalSummary?.visible ?? "n/a"}</dd></div>
            <div><dt>Pending WS</dt><dd>{terminalSummary?.pendingWs ?? "n/a"}</dd></div>
          </dl>
        </section>
      </div>
      {#if analyzeJson}
        <details class="events-analyze">
          <summary>JSON</summary>
          <pre class="events-analyze-json">{analyzeJson}</pre>
        </details>
      {/if}
    </div>
  {/if}
</Popover>
