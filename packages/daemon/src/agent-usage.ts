/**
 * Per-agent usage aggregator. Given the flat AgentSession list that
 * `detectAgents()` already produces, this returns "sessions active in
 * the last 24h / 7d" and the cumulative message counts for those
 * sessions, broken down per agent.
 *
 * v1 scope: sessions + messages only (no token totals, no engaged-time
 * breakdown). The session's lifetime messageCount counts toward the
 * window it was last active in — a session touched today but started
 * yesterday contributes its full messageCount to both `today` and
 * `week`. This overcounts vs. per-turn timestamp bucketing but is
 * directionally honest for an at-a-glance menubar tooltip; per-turn
 * scanning is left for a follow-up if the numbers feel off.
 *
 * See plans/PLAN-AGENT-USAGE.md for the full design including the
 * deferred work (token totals, engaged-time, top-repo, cost estimate).
 */

import type { AgentKind, AgentSession } from "./agents";

export interface AgentUsageWindow {
  /** Distinct sessions whose `lastActive` falls inside the window. */
  sessions: number;
  /** Sum of `messageCount` across those sessions. Undefined per-session
   *  counts are treated as 0. */
  messages: number;
}

export interface AgentUsage {
  today: AgentUsageWindow;
  week: AgentUsageWindow;
}

export interface AgentUsageReport {
  /** ISO timestamp the report was computed at — matches the upper edge
   *  of the rolling window. Shown in the tooltip footer so the user
   *  knows how fresh the numbers are. */
  asOf: string;
  /** Width of each rolling window, exposed to the UI so it can label
   *  "Today" / "Week" without hard-coding the values. */
  windows: { todayMs: number; weekMs: number };
  /** Only agents that have at least one session within the *week*
   *  window appear here. Agents the user never touches don't waste
   *  tooltip rows. */
  agents: Partial<Record<AgentKind, AgentUsage>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function computeAgentUsage(
  sessions: AgentSession[],
  now: number,
): AgentUsageReport {
  const todayCutoff = now - DAY_MS;
  const weekCutoff = now - WEEK_MS;

  const byAgent = new Map<AgentKind, AgentSession[]>();
  for (const s of sessions) {
    const arr = byAgent.get(s.agent);
    if (arr) arr.push(s);
    else byAgent.set(s.agent, [s]);
  }

  const agents: Partial<Record<AgentKind, AgentUsage>> = {};
  for (const [agent, list] of byAgent) {
    const week = aggregate(list, weekCutoff);
    if (week.sessions === 0) continue;
    const today = aggregate(list, todayCutoff);
    agents[agent] = { today, week };
  }

  return {
    asOf: new Date(now).toISOString(),
    windows: { todayMs: DAY_MS, weekMs: WEEK_MS },
    agents,
  };
}

function aggregate(
  list: AgentSession[],
  cutoffMs: number,
): AgentUsageWindow {
  let sessions = 0;
  let messages = 0;
  for (const s of list) {
    const t = Date.parse(s.lastActive);
    if (Number.isNaN(t) || t < cutoffMs) continue;
    sessions++;
    messages += s.messageCount ?? 0;
  }
  return { sessions, messages };
}
