<script lang="ts">
  /**
   * Menubar agent-usage strip: one button per detected coding agent
   * (Claude / Codex / Ollama / Copilot), each with its own hover
   * tooltip showing only that agent's data. For Claude, the tooltip
   * renders the **real** plan-utilization bars from Anthropic's
   * `/api/oauth/usage` endpoint (same numbers as claude.ai's
   * "Plan-Nutzungslimits" page); for other agents it shows local
   * JSONL-derived counts.
   *
   * See `plans/PLAN-AGENT-USAGE.md` for the broader design and
   * `claude-oauth-usage.ts` for the endpoint contract.
   */
  import { onMount, onDestroy } from "svelte";
  import Tooltip from "./Tooltip.svelte";
  import AgentIcon from "./AgentIcon.svelte";

  interface UsageWindow {
    sessions: number;
    messages: number;
  }
  interface AgentUsage {
    today: UsageWindow;
    week: UsageWindow;
    peakDay: number;
    peakWeek: number;
  }
  interface OAuthWindow {
    utilization: number;
    resetsAt?: string;
  }
  interface OAuthExtraUsage {
    isEnabled?: boolean;
    monthlyLimit?: number;
    usedCredits?: number;
    utilization?: number;
    currency?: string;
  }
  interface ClaudeOAuthUsage {
    fiveHour?: OAuthWindow;
    sevenDay?: OAuthWindow;
    sevenDaySonnet?: OAuthWindow;
    sevenDayOpus?: OAuthWindow;
    sevenDayDesign?: OAuthWindow;
    sevenDayRoutines?: OAuthWindow;
    extraUsage?: OAuthExtraUsage;
    fetchedAt: string;
  }
  type OAuthUsageError =
    | { kind: "no-credentials"; checkedPath?: string }
    | { kind: "credentials-unreadable"; checkedPath?: string; message: string }
    | { kind: "credentials-malformed"; checkedPath?: string; message: string }
    | { kind: "credentials-schema"; checkedPath?: string; message: string }
    | { kind: "unauthorized" }
    | { kind: "expired" }
    | { kind: "network"; message: string }
    | { kind: "server"; status: number; body?: string }
    | { kind: "decode"; message: string };
  interface CodexWindow {
    utilization: number;
    resetsAt?: string;
    windowSeconds?: number;
  }
  interface CodexCredits {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: number;
  }
  interface CodexOAuthUsage {
    planType?: string;
    primaryWindow?: CodexWindow;
    secondaryWindow?: CodexWindow;
    credits?: CodexCredits;
    fetchedAt: string;
  }
  type CodexUsageError =
    | { kind: "no-credentials" }
    | { kind: "unauthorized" }
    | { kind: "network"; message: string }
    | { kind: "server"; status: number; body?: string }
    | { kind: "decode"; message: string };
  interface Report {
    asOf: string;
    windows: { todayMs: number; weekMs: number };
    claudePlan?: { subscriptionType?: string; rateLimitTier?: string };
    claudeLiveUsage?: ClaudeOAuthUsage | null;
    claudeLiveUsageError?: OAuthUsageError;
    codexLiveUsage?: CodexOAuthUsage | null;
    codexLiveUsageError?: CodexUsageError;
    agents: Partial<Record<string, AgentUsage>>;
  }

  let report: Report | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/agent-usage");
      if (res.ok) report = (await res.json()) as Report;
    } catch {
      // keep the previously-loaded report; next poll retries.
    }
  }

  onMount(() => {
    void load();
    pollTimer = setInterval(load, 60_000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  const AGENT_ORDER = ["claude", "codex", "ollama", "copilot"] as const;

  $: agentsList = report
    ? AGENT_ORDER.filter((a) => report!.agents[a]).map(
        (a) => [a, report!.agents[a]!] as const,
      )
    : [];

  $: claudeLive = report?.claudeLiveUsage ?? null;
  $: claudeLiveErr = report?.claudeLiveUsageError ?? null;
  $: codexLive = report?.codexLiveUsage ?? null;
  $: codexLiveErr = report?.codexLiveUsageError ?? null;

  /** Has-live-data check per agent. The trigger button's bottom bar
   *  and the tooltip body both branch on this. */
  function hasLiveData(agent: string): boolean {
    if (agent === "claude") return !!claudeLive;
    if (agent === "codex") return !!codexLive;
    return false;
  }

  /** Pick a human-readable label for a Codex rate-limit window based
   *  on its `windowSeconds`. Codex Free returns a single primary window
   *  that's actually a 7-day budget, while paid plans return both 5h
   *  and 7d — so a fixed "Session (5h) / Weekly" labeling would lie
   *  to Free users. */
  function codexWindowLabel(seconds: number | undefined, fallback: string): string {
    if (!seconds || seconds <= 0) return fallback;
    if (seconds <= 60) return `Session (${seconds}s)`;
    if (seconds < 3600) return `Session (${Math.round(seconds / 60)}m)`;
    if (seconds < 86400) return `Session (${Math.round(seconds / 3600)}h)`;
    const days = Math.round(seconds / 86400);
    return days === 7 ? "Weekly" : days === 1 ? "Daily" : `${days}-day`;
  }

  $: codexLiveRows = codexLive
    ? (
        [
          {
            label: codexWindowLabel(codexLive.primaryWindow?.windowSeconds, "Primary"),
            window: codexLive.primaryWindow,
          },
          {
            label: codexWindowLabel(codexLive.secondaryWindow?.windowSeconds, "Secondary"),
            window: codexLive.secondaryWindow,
          },
        ] as const
      ).filter((r) => r.window !== undefined)
    : [];

  function agentLabel(a: string): string {
    if (a === "claude") return "Claude";
    if (a === "codex") return "Codex";
    if (a === "ollama") return "Ollama";
    if (a === "copilot") return "Copilot";
    return a;
  }

  function localRatio(value: number, peak: number): number {
    if (!peak || peak <= 0) return 0;
    return Math.min(1, value / peak);
  }

  function fmtTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function fmtResets(iso: string | undefined): string {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const diffMs = t - Date.now();
    if (diffMs <= 0) return "now";
    const mins = Math.round(diffMs / 60_000);
    if (mins < 60) return `in ${mins} min`;
    const hours = Math.round(diffMs / 3_600_000);
    if (hours < 24) return `in ${hours}h`;
    const d = new Date(t);
    return d.toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /** Capitalize a Codex plan_type string ("free" / "plus" / "pro" /
   *  "business" / …) so it reads like a proper name in the tooltip
   *  head, matching how Claude's "Max (20x)" is presented. */
  function codexPlanLabel(planType: string): string {
    if (!planType) return planType;
    return planType[0].toUpperCase() + planType.slice(1);
  }

  function planLabel(p: Report["claudePlan"]): string | null {
    if (!p) return null;
    const sub = p.subscriptionType?.toLowerCase();
    const tier = p.rateLimitTier ?? "";
    const xMatch = tier.match(/_max_(\d+x)$/i);
    if (sub === "max" && xMatch) return `Max (${xMatch[1]})`;
    if (sub === "max") return "Max";
    if (sub === "pro") return "Pro";
    if (sub) return sub[0].toUpperCase() + sub.slice(1);
    return null;
  }

  function pct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  function liveBarWidth(util: number | undefined): string {
    if (typeof util !== "number") return "0%";
    if (util > 0 && util < 0.01) return "1%";
    return `${Math.min(100, util * 100).toFixed(1)}%`;
  }

  /** Fill ratio for the 3px progress bar painted along the bottom of
   *  the button — surfaces the agent's *weekly* usage at-a-glance so
   *  you don't have to hover. For Claude with live OAuth data we use
   *  the real plan % (sevenDay.utilization); for everyone else we use
   *  the local "this week's messages ÷ your peak week" ratio. Returns
   *  0..1 (clamped). */
  function buttonBarRatio(agent: string, usage: AgentUsage): number {
    if (agent === "claude") {
      const live = report?.claudeLiveUsage;
      if (live?.sevenDay?.utilization !== undefined) {
        return Math.max(0, Math.min(1, live.sevenDay.utilization));
      }
    }
    if (agent === "codex") {
      // Prefer the long (weekly) Codex window for the button bar so
      // the "how much of my plan have I burned this week" read matches
      // Claude's bottom bar semantics.
      const live = report?.codexLiveUsage;
      const w = live?.secondaryWindow ?? live?.primaryWindow;
      if (w?.utilization !== undefined) {
        return Math.max(0, Math.min(1, w.utilization));
      }
    }
    if (usage.peakWeek > 0) {
      return Math.max(0, Math.min(1, usage.week.messages / usage.peakWeek));
    }
    return 0;
  }

  /** Public usage page per agent — opened in a new tab when the user
   *  clicks the button. Null = no known page; the button stays hover-
   *  only (Ollama is local, no online dashboard). */
  function usageUrl(agent: string): string | null {
    if (agent === "claude") return "https://claude.ai/settings/usage";
    if (agent === "codex") return "https://platform.openai.com/usage";
    if (agent === "copilot") return "https://github.com/settings/copilot";
    return null;
  }

  function openUsagePage(agent: string): void {
    const url = usageUrl(agent);
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function errorHint(e: OAuthUsageError | CodexUsageError): string {
    switch (e.kind) {
      case "no-credentials":
        // `checkedPath` carries every location the daemon probed; if
        // the user is on a path we don't know about, this surfaces
        // "checked X, Y, Z" so they can tell us where the file
        // actually lives.
        return "checkedPath" in e && e.checkedPath
          ? `no Claude credentials at: ${e.checkedPath}`
          : "no Claude credentials found";
      case "credentials-unreadable":
        // Permissions / FS issue: file is there but we can't read it.
        return `credentials at ${"checkedPath" in e ? e.checkedPath : "?"} unreadable: ${e.message}`;
      case "credentials-malformed":
        // JSON.parse blew up — file format changed or file is corrupt.
        return `credentials file is not valid JSON: ${e.message}`;
      case "credentials-schema":
        // File parsed but missing expected fields — format may have
        // shifted since this code was written.
        return `credentials present but ${e.message}`;
      case "expired":
        return "OAuth token expired — run `claude login`";
      case "unauthorized":
        return "OAuth 401 — re-auth with `claude login`";
      case "network":
        return `network error: ${e.message}`;
      case "server":
        return `Anthropic ${e.status}`;
      case "decode":
        return "unexpected response shape";
    }
  }

  // Live rows are filtered per Claude's tooltip — only present
  // windows render. Matches claude.ai's ordering.
  $: liveRows = claudeLive
    ? ([
        { label: "Session (5h)", window: claudeLive.fiveHour },
        { label: "Week — all models", window: claudeLive.sevenDay },
        { label: "Week — Sonnet", window: claudeLive.sevenDaySonnet },
        { label: "Week — Opus", window: claudeLive.sevenDayOpus },
        { label: "Design", window: claudeLive.sevenDayDesign },
        { label: "Routines", window: claudeLive.sevenDayRoutines },
      ] as const).filter((r) => r.window !== undefined)
    : [];
</script>

{#each agentsList as [agent, usage] (agent)}
  {@const url = usageUrl(agent)}
  {@const barRatio = buttonBarRatio(agent, usage)}
  <div class="actions-anchor agent-usage-anchor">
    <Tooltip placement="bottom" variant="wide" escapeClip>
      <button
        slot="trigger"
        type="button"
        class="actions-btn agent-usage-btn brand-{agent}"
        class:has-url={url !== null}
        style:--usage-bar-pct={`${(barRatio * 100).toFixed(1)}%`}
        aria-label={url
          ? `${agentLabel(agent)} usage — opens ${url}`
          : `${agentLabel(agent)} usage`}
        on:click={() => openUsagePage(agent)}
      >
        <AgentIcon {agent} size={14} />
      </button>

      <div slot="content" class="usage-tt brand-{agent}">
        <div class="usage-tt-head brand-{agent}">
          <AgentIcon {agent} size={14} />
          <span>{agentLabel(agent)}</span>
          {#if agent === "claude" && planLabel(report?.claudePlan)}
            <span class="usage-plan">· {planLabel(report?.claudePlan)}</span>
          {:else if agent === "codex" && codexLive?.planType}
            <span class="usage-plan">· {codexPlanLabel(codexLive.planType)}</span>
          {/if}
          <span
            class="usage-source"
            class:source-live={hasLiveData(agent)}
            aria-label={hasLiveData(agent)
              ? "Real plan usage from the provider's API."
              : "Counted from local JSONL turns; no public usage API for this agent."}
          >
            {hasLiveData(agent) ? "live" : "local"}
          </span>
        </div>

        {#if agent === "claude" && claudeLive && liveRows.length > 0}
          <!-- Claude: real plan-utilization bars from OAuth API. -->
          <div class="usage-live-grid">
            {#each liveRows as row (row.label)}
              <span class="usage-live-label">{row.label}</span>
              <span
                class="usage-bar live"
                aria-label={row.window?.resetsAt
                  ? `Resets ${fmtResets(row.window.resetsAt)} (${row.window.resetsAt})`
                  : undefined}
              >
                <span
                  class="usage-bar-fill live"
                  style:width={liveBarWidth(row.window?.utilization)}
                ></span>
              </span>
              <span class="usage-live-pct">{pct(row.window?.utilization ?? 0)}</span>
              <span class="usage-live-reset">{fmtResets(row.window?.resetsAt)}</span>
            {/each}
          </div>
          {#if claudeLive.extraUsage?.isEnabled}
            <div class="usage-extra">
              Extra usage: {pct(claudeLive.extraUsage.utilization ?? 0)}
              {#if claudeLive.extraUsage.usedCredits !== undefined && claudeLive.extraUsage.monthlyLimit !== undefined}
                · {claudeLive.extraUsage.usedCredits.toFixed(2)} / {claudeLive.extraUsage.monthlyLimit.toFixed(0)} {claudeLive.extraUsage.currency ?? ""}
              {/if}
            </div>
          {/if}
        {:else if agent === "codex" && codexLive && codexLiveRows.length > 0}
          <!-- Codex: real plan-utilization bars from chatgpt.com's
               backend-api/wham/usage endpoint (CodexBar's discovery). -->
          <div class="usage-live-grid">
            {#each codexLiveRows as row (row.label)}
              <span class="usage-live-label">{row.label}</span>
              <span
                class="usage-bar live"
                aria-label={row.window?.resetsAt
                  ? `Resets ${fmtResets(row.window.resetsAt)} (${row.window.resetsAt})`
                  : undefined}
              >
                <span
                  class="usage-bar-fill live"
                  style:width={liveBarWidth(row.window?.utilization)}
                ></span>
              </span>
              <span class="usage-live-pct">{pct(row.window?.utilization ?? 0)}</span>
              <span class="usage-live-reset">{fmtResets(row.window?.resetsAt)}</span>
            {/each}
          </div>
          {#if codexLive.credits && (codexLive.credits.hasCredits || codexLive.credits.unlimited)}
            <div class="usage-extra">
              Credits:
              {#if codexLive.credits.unlimited}
                <strong>unlimited</strong>
              {:else if codexLive.credits.balance !== undefined}
                <strong>{codexLive.credits.balance.toFixed(2)}</strong>
              {:else}
                <strong>available</strong>
              {/if}
            </div>
          {/if}
        {:else}
          <!-- Local-count fallback (every non-Claude agent, plus
               Claude when the OAuth call failed). `{@const}` has to be
               the immediate child of the control-flow block, not nested
               inside a `<div>` — that's why these sit here instead of
               next to `.usage-local-rows`. -->
          {@const todayR = localRatio(usage.today.messages, usage.peakDay)}
          {@const weekR = localRatio(usage.week.messages, usage.peakWeek)}
          <!-- Surface every error kind including no-credentials. The
               daemon now probes multiple known credential paths and
               returns the full list in `checkedPath`, so a no-credentials
               hint here is the user's only diagnostic for "file is
               actually somewhere I don't know about" — useful enough
               to outweigh the "looks like an error on a clean install"
               concern. -->
          {#if agent === "claude" && claudeLiveErr}
            <div class="usage-live-error">{errorHint(claudeLiveErr)}</div>
          {:else if agent === "codex" && codexLiveErr}
            <div class="usage-live-error">{errorHint(codexLiveErr)}</div>
          {/if}
          <div class="usage-local-rows">
            <div class="usage-local-row">
              <span class="usage-local-label">Today</span>
              <!-- No tier() coloring on local "vs. your peak" bars: a
                   freshly-detected agent is by definition at 100% of
                   its own brief history, and painting that red as
                   "hot" misreads the signal. tier() stays meaningful
                   only for the live OAuth bars where 100% = real
                   plan cap. -->
              <span class="usage-bar" aria-label={`${usage.today.messages} of ${usage.peakDay || "—"} peak day`}>
                <span
                  class="usage-bar-fill"
                  style:width={usage.peakDay > 0
                    ? `${Math.round(todayR * 100)}%`
                    : "0%"}
                ></span>
              </span>
              <span class="usage-local-num">
                {usage.today.messages}
                <span class="usage-local-unit">msg</span>
              </span>
              <span class="usage-local-sub">{usage.today.sessions} sess</span>
            </div>

            <div class="usage-local-row">
              <span class="usage-local-label">Week</span>
              <span class="usage-bar" aria-label={`${usage.week.messages} of ${usage.peakWeek || "—"} peak week`}>
                <span
                  class="usage-bar-fill"
                  style:width={usage.peakWeek > 0
                    ? `${Math.round(weekR * 100)}%`
                    : "0%"}
                ></span>
              </span>
              <span class="usage-local-num">
                {usage.week.messages}
                <span class="usage-local-unit">msg</span>
              </span>
              <span class="usage-local-sub">{usage.week.sessions} sess</span>
            </div>
          </div>
        {/if}

        {#if report}
          <div class="usage-tt-foot">
            <span>
              {#if hasLiveData(agent)}
                fill = % of plan
              {:else}
                fill = vs. your peak
              {/if}
            </span>
            <span class="usage-tt-asof">as of {fmtTime(report.asOf)}</span>
          </div>
        {/if}
      </div>
    </Tooltip>
  </div>
{/each}

<style>
  /* The agent-usage buttons are icon-only; the global `.actions-btn`
     padding (0.3rem 0.6rem) gives them roughly square hit targets.
     `brand-*` lets the icon's `currentColor` flow through the SVG.

     Bottom-edge fill bar: a single `::after` pseudo at the bottom of
     each button shows the agent's *weekly* usage at-a-glance, so the
     user doesn't need to hover to know whether they're 5% or 90% of
     the way through the plan. Two-stop gradient over `--usage-bar-pct`
     paints a solid brand-coloured (or live-blue) fill segment and a
     muted track to the right, in one paint. */
  .agent-usage-btn {
    position: relative;
    padding: 0.3rem 0.45rem 0.42rem;
    /* Don't paint the per-agent buttons as actual menubar buttons —
       they're informational chips that just happen to be clickable.
       Drop the inherited `.menubar .actions-btn` surface so the icon
       sits flush on the menubar background; the bottom progress bar
       and the agent's brand color carry the visual identity. */
    background: transparent;
  }
  .agent-usage-btn:hover,
  .agent-usage-btn:focus-visible {
    /* A subtle hover-only surface so the click affordance still
       registers without making the resting state look like a button. */
    background: color-mix(in srgb, var(--text-1) 10%, transparent);
  }
  /* `color` controls the icon glyph (via AgentIcon's currentColor) and
     stays muted-on-dark so the icon reads cleanly. The bottom-bar
     fill picks up `--bar-color` instead, which is the agent's *brand*
     color — the saturated, brand-recognisable one — so the loading
     bar at the bottom of the button reads as "Claude orange,"
     "Codex green," etc. at a glance, distinct from the muted icon
     text color used elsewhere in the chrome. */
  .agent-usage-btn.brand-claude {
    color: var(--chip-orange-text);
    --bar-color: #cc785c; /* Anthropic burnt sienna — the real logo orange */
  }
  .agent-usage-btn.brand-codex {
    color: var(--chip-codex-text);
    --bar-color: #10a37f; /* OpenAI green */
  }
  .agent-usage-btn.brand-ollama {
    color: var(--chip-ollama-text);
    --bar-color: #4fb6d2; /* punchier teal than the pale-text token */
  }
  .agent-usage-btn.brand-copilot {
    color: var(--chip-default-text);
    --bar-color: #a371f7; /* GitHub Copilot purple */
  }
  /* The fill picks up the button's `currentColor`, which the
     brand-{agent} rules above set to the agent's brand color
     (Claude=orange, Codex=greenish, etc.). One consistent visual
     language: the loading bar always reads as "the agent's usage,"
     regardless of whether the number came from live OAuth or local
     JSONL counts. */
  .agent-usage-btn::after {
    content: "";
    position: absolute;
    left: 4px;
    right: 4px;
    bottom: 2px;
    height: 3px;
    border-radius: 999px;
    pointer-events: none;
    background: linear-gradient(
      to right,
      var(--bar-color, currentColor) 0%,
      var(--bar-color, currentColor) var(--usage-bar-pct, 0%),
      color-mix(in srgb, var(--text-1) 14%, transparent) var(--usage-bar-pct, 0%),
      color-mix(in srgb, var(--text-1) 14%, transparent) 100%
    );
    opacity: 0.9;
    transition: background 220ms ease;
  }

  .usage-tt {
    font-family: system-ui, -apple-system, sans-serif;
    min-width: 17rem;
  }
  .usage-tt-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
    font-size: 0.82rem;
    margin-bottom: 0.5rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--surface-2);
  }
  .usage-tt-head.brand-claude {
    color: var(--chip-orange-text);
  }
  .usage-tt-head.brand-codex {
    color: var(--chip-codex-text);
  }
  .usage-tt-head.brand-ollama {
    color: var(--chip-ollama-text);
  }
  .usage-tt-head.brand-copilot {
    color: var(--chip-default-text);
  }
  .usage-plan {
    color: var(--text-muted);
    font-weight: 400;
  }
  /* Source pill ("LIVE" / "LOCAL"). High contrast on both states —
     these read as small chips, so they need to be readable at a
     glance, not blend into the surface. */
  .usage-source {
    margin-left: auto;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-1) 14%, transparent);
    color: var(--text-1);
    font-weight: 600;
    cursor: help;
  }
  /* LIVE pill stays the same neutral chip as LOCAL — same contrast,
     no special blue tint. The data source is informational, not a
     status callout, so it shouldn't compete visually with the bars. */

  /* Live (OAuth) — 4-column grid: label · bar · % · resets-in.
     Bar is the same fixed 64px width as SessionHeader's ctx-bar so
     a single-agent tooltip doesn't stretch to fill the viewport. */
  .usage-live-grid {
    display: grid;
    grid-template-columns: minmax(7rem, auto) 64px auto auto;
    gap: 0.3rem 0.6rem;
    align-items: center;
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
  }
  .usage-live-label {
    color: var(--text-muted);
  }
  .usage-live-pct {
    font-weight: 600;
    color: var(--text-1);
    text-align: right;
    min-width: 2.7rem;
  }
  .usage-live-reset {
    /* Bumped from --text-faint to --text-muted — the countdown is one
       of the more useful bits of info on the row and needs to read,
       not whisper. */
    color: var(--text-muted);
    font-size: 0.7rem;
    text-align: right;
    white-space: nowrap;
  }
  .usage-live-error {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
  }
  .usage-extra {
    margin-top: 0.45rem;
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  /* Local-count rows — same shape as before, just isolated per agent. */
  .usage-local-rows {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .usage-local-row {
    display: grid;
    /* Fixed 64px bar (matches ctx-bar); the num + sub columns hug their
       content on the right. A `1fr` bar made single-agent tooltips
       look comically wide; this keeps them compact. */
    grid-template-columns: 2.4rem 64px minmax(4rem, auto) auto;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
  }
  .usage-local-label {
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .usage-local-num {
    font-weight: 600;
    color: var(--text-1);
    white-space: nowrap;
  }
  .usage-local-unit {
    color: var(--text-muted);
    margin-left: 0.15rem;
    font-weight: 400;
  }
  .usage-local-sub {
    color: var(--text-muted);
    font-size: 0.68rem;
    white-space: nowrap;
    text-align: right;
  }

  /* Shared bar shell — colours match SessionHeader's `.ctx-bar`:
     a `--surface-3` track with a `--text-faint` border, a `--text-faint`
     fill at rest, and `var(--ctx-warn)` / `var(--ctx-hot)` tints when
     the value crosses 60% / 85% of the bar's reference (plan-% for
     live, peak for local). No brand-coloured fills — the bar reads as
     a neutral measurement, only screaming when it should. */
  .usage-bar {
    display: inline-grid;
    grid-template-areas: "bar";
    /* Same 8px as SessionHeader's .ctx-bar — keeps the usage tooltip
       looking like a sibling of the context bar in the session header
       rather than its own visual system. */
    height: 8px;
    align-items: stretch;
    border-radius: 999px;
    /* Theme-agnostic track: a translucent layer over whatever surface
       the tooltip sits on, so it stays visible on both the dark menubar
       and a light theme. */
    background: color-mix(in srgb, var(--text-1) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-1) 28%, transparent);
    overflow: hidden;
    cursor: help;
    transition: border-color 200ms ease;
  }
  /* Every bar — live OR local — paints in the agent's brand color
     (`--bar-color` cascades from `.usage-tt.brand-{agent}` below).
     One consistent visual language: a Claude bar is Anthropic
     sienna at 5% AND at 95%, no special "warn" or "hot" tier
     coloring at high values. The user explicitly asked for this:
     brand color only, no traffic-light states. A soft halo keeps
     small fills readable. */
  .usage-tt.brand-claude {
    --bar-color: #cc785c;
  }
  .usage-tt.brand-codex {
    --bar-color: #10a37f;
  }
  .usage-tt.brand-ollama {
    --bar-color: #4fb6d2;
  }
  .usage-tt.brand-copilot {
    --bar-color: #a371f7;
  }
  .usage-bar-fill {
    grid-area: bar;
    background: var(--bar-color, var(--text-2));
    transition: width 220ms ease, background 200ms ease;
    border-radius: 999px;
  }
  .usage-bar.live {
    border-color: color-mix(in srgb, var(--bar-color, #60a5fa) 50%, transparent);
  }
  .usage-bar.live .usage-bar-fill {
    box-shadow: 0 0 6px color-mix(in srgb, var(--bar-color, #60a5fa) 55%, transparent);
  }

  .usage-tt-foot {
    margin-top: 0.55rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--surface-2);
    font-size: 0.7rem;
    /* Was --text-muted; bumped to --text-2 so the "as of HH:MM" and
       "fill = …" footer copy actually reads, instead of sitting one
       step above invisible. */
    color: var(--text-2);
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .usage-tt-asof {
    white-space: nowrap;
  }
</style>
