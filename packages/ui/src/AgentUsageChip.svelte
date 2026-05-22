<script lang="ts">
  /**
   * Menubar chip: per-agent usage at a glance. Renders a logo per
   * detected coding agent (Claude / Codex / Ollama / Copilot), and on
   * hover surfaces a tooltip with rolling 24h + 7d stats — sessions
   * and messages, today vs. week.
   *
   * Data comes from the daemon's `/api/agent-usage` endpoint, which
   * caches its detectAgents() walk for 60s. We poll on the same
   * cadence so the numbers track day-to-day shifts without battering
   * the filesystem. See `plans/PLAN-AGENT-USAGE.md` for the full
   * design (incl. deferred tokens / engaged-time / per-repo split).
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
  }
  interface Report {
    asOf: string;
    windows: { todayMs: number; weekMs: number };
    agents: Partial<Record<string, AgentUsage>>;
  }

  let report: Report | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/agent-usage");
      if (res.ok) report = (await res.json()) as Report;
    } catch {
      // network blip — keep the previously-loaded report visible
      // rather than blanking the chip; next poll will retry.
    }
  }

  onMount(() => {
    void load();
    pollTimer = setInterval(load, 60_000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  // Stable order across agents — matches the brand-row order used in
  // other popovers so the same agent always sits in the same slot.
  const AGENT_ORDER = ["claude", "codex", "ollama", "copilot"] as const;

  $: agentsList = report
    ? AGENT_ORDER.filter((a) => report!.agents[a]).map(
        (a) => [a, report!.agents[a]!] as const,
      )
    : [];

  function agentLabel(a: string): string {
    if (a === "claude") return "Claude";
    if (a === "codex") return "Codex";
    if (a === "ollama") return "Ollama";
    if (a === "copilot") return "Copilot";
    return a;
  }

  function fmtTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
</script>

{#if agentsList.length > 0}
  <Tooltip placement="bottom" variant="wide" escapeClip>
    <button slot="trigger" type="button" class="actions-btn usage-btn" aria-label="Agent usage this week">
      {#each agentsList as [agent] (agent)}
        <AgentIcon {agent} size={14} />
      {/each}
    </button>
    <div slot="content" class="usage-tt">
      <div class="usage-tt-head">Agent usage</div>
      <table class="usage-tt-table">
        <thead>
          <tr>
            <th></th>
            <th>Today</th>
            <th>Week</th>
          </tr>
        </thead>
        <tbody>
          {#each agentsList as [agent, usage] (agent)}
            <tr>
              <td class="usage-tt-agent brand-{agent}">
                <AgentIcon {agent} size={12} />
                <span>{agentLabel(agent)}</span>
              </td>
              <td>
                <span class="usage-tt-num">{usage.today.sessions}</span>
                <span class="usage-tt-unit">sess</span>
                <span class="usage-tt-sep">·</span>
                <span class="usage-tt-num">{usage.today.messages}</span>
                <span class="usage-tt-unit">msg</span>
              </td>
              <td>
                <span class="usage-tt-num">{usage.week.sessions}</span>
                <span class="usage-tt-unit">sess</span>
                <span class="usage-tt-sep">·</span>
                <span class="usage-tt-num">{usage.week.messages}</span>
                <span class="usage-tt-unit">msg</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if report}
        <div class="usage-tt-foot">rolling 24h / 7d · as of {fmtTime(report.asOf)}</div>
      {/if}
    </div>
  </Tooltip>
{/if}

<style>
  .usage-btn {
    /* Keep the icons close together — they read as a single agent-
       row, not four separate buttons. The shared .actions-btn rule
       in the menubar already drops padding + border. */
    gap: 0.3rem;
  }
  .usage-tt {
    font-family: system-ui, -apple-system, sans-serif;
  }
  .usage-tt-head {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.4rem;
  }
  .usage-tt-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .usage-tt-table th {
    text-align: right;
    font-weight: 500;
    color: var(--text-muted);
    padding: 0 0.55rem 0.2rem;
    font-size: 0.7rem;
  }
  .usage-tt-table th:first-child {
    text-align: left;
  }
  .usage-tt-table td {
    padding: 0.2rem 0.55rem;
    white-space: nowrap;
    text-align: right;
  }
  .usage-tt-agent {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
    text-align: left;
    /* `brand-*` selectors below paint currentColor; the AgentIcon's
       SVG/path inherits via `fill="currentColor"`. */
  }
  .usage-tt-agent.brand-claude {
    color: var(--chip-orange-text);
  }
  .usage-tt-agent.brand-codex {
    color: var(--chip-codex-text);
  }
  .usage-tt-agent.brand-ollama {
    color: var(--chip-ollama-text);
  }
  .usage-tt-agent.brand-copilot {
    color: var(--chip-default-text);
  }
  .usage-tt-num {
    font-weight: 600;
    color: var(--text-1);
  }
  .usage-tt-unit {
    color: var(--text-muted);
    margin-left: 0.15rem;
  }
  .usage-tt-sep {
    color: var(--text-faint);
    margin: 0 0.25rem;
  }
  .usage-tt-foot {
    margin-top: 0.45rem;
    font-size: 0.68rem;
    color: var(--text-muted);
    text-align: right;
  }
</style>
