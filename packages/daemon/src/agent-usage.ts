/**
 * Per-agent usage aggregator. For Claude, we walk each session's JSONL
 * to bucket every turn by its own UTC date — accurate "messages today /
 * this week" data, plus peak-day / peak-week reference values for the
 * usage bars in the menubar chip.
 *
 * For Codex / Ollama / Copilot we fall back to mtime-based bucketing
 * (the session's lifetime `messageCount` counts toward whichever
 * window its `lastActive` falls into). Per-turn parsing for those is
 * a follow-up.
 *
 * See plans/PLAN-AGENT-USAGE.md for the broader design (cost estimate,
 * engaged-time, top-repo, etc.).
 */

import { readFile, stat } from "node:fs/promises";
import type { AgentKind, AgentSession } from "./agents";
import {
  fetchClaudeOAuthUsage,
  type ClaudeOAuthUsage,
  type OAuthUsageError,
} from "./claude-oauth-usage";

export interface AgentUsageWindow {
  /** Distinct sessions active inside the window. For Claude this is
   *  the number of sessions whose JSONL had any turn in-window;
   *  for other agents it's sessions whose `lastActive` is in-window. */
  sessions: number;
  /** Total user + assistant turns inside the window. */
  messages: number;
}

export interface AgentUsage {
  today: AgentUsageWindow;
  week: AgentUsageWindow;
  /** Reference value for the "today" bar — max single-day message
   *  count observed in the last 30 days. Bar fill = today / peakDay. */
  peakDay: number;
  /** Reference value for the "week" bar — max rolling 7-day window
   *  observed in the last 90 days. Bar fill = week / peakWeek. */
  peakWeek: number;
}

export interface AgentUsageReport {
  /** ISO timestamp the report was computed at. Shown in the tooltip
   *  footer so the user knows how fresh the numbers are. */
  asOf: string;
  /** Window widths exposed so the UI can label without hard-coding. */
  windows: { todayMs: number; weekMs: number };
  /** Plan tier read from `~/.claude/.credentials.json` if present, so
   *  the tooltip can show "Max (20x)" without a server round trip.
   *  Undefined if the file is missing/unreadable; UI just omits it. */
  claudePlan?: { subscriptionType?: string; rateLimitTier?: string };
  /** Live plan-utilization numbers from Anthropic's OAuth usage
   *  endpoint — same data backing claude.ai's "Plan-Nutzungslimits"
   *  page. Present only when the call succeeded; null + error otherwise
   *  so the UI can fall back to local JSONL counts and show a hint. */
  claudeLiveUsage?: ClaudeOAuthUsage | null;
  /** When `claudeLiveUsage` is null, this carries the reason the call
   *  failed (no-credentials / expired / unauthorized / server). */
  claudeLiveUsageError?: OAuthUsageError;
  /** Only agents with non-zero week activity appear here. */
  agents: Partial<Record<AgentKind, AgentUsage>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PEAK_DAY_LOOKBACK_MS = 30 * DAY_MS;
const PEAK_WEEK_LOOKBACK_MS = 90 * DAY_MS;

interface DailyBucket {
  /** user + assistant turns combined. Tool-result-only "user" turns
   *  are excluded so the count matches "real conversation." */
  messages: number;
}

/** (path, mtimeMs) → per-date bucket map. JSONLs are append-only-ish
 *  for live sessions and immutable once closed, so mtime captures
 *  staleness without re-reading content. */
const claudeDailyCache = new Map<
  string,
  { mtimeMs: number; result: Map<string, DailyBucket> }
>();
const MAX_CLAUDE_DAILY_CACHE = 5000;

export function clearClaudeDailyCache(): void {
  claudeDailyCache.clear();
}

export async function scanClaudeDailyBuckets(
  path: string,
  mtimeMs?: number,
): Promise<Map<string, DailyBucket>> {
  if (mtimeMs !== undefined) {
    const cached = claudeDailyCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      // LRU touch.
      claudeDailyCache.delete(path);
      claudeDailyCache.set(path, cached);
      return cached.result;
    }
  }
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return new Map();
  }
  const buckets = new Map<string, DailyBucket>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    // Cheap prefilter — most lines are tool-call deltas and content
    // chunks that we don't bucket. The JSON.parse path is hot.
    if (
      !line.includes('"type":"user"') &&
      !line.includes('"type":"assistant"')
    ) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj.type;
    if (type !== "user" && type !== "assistant") continue;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    if (!ts || ts.length < 10) continue;

    // Skip tool-result-only "user" turns — these are responses from
    // the tool harness, not the human user. Counting them would
    // double-count assistant turns that triggered tools.
    if (type === "user") {
      const msg = obj.message as { content?: unknown } | undefined;
      const content = msg?.content;
      if (Array.isArray(content) && content.length > 0) {
        const onlyTool = content.every(
          (b) =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "tool_result",
        );
        if (onlyTool) continue;
      }
    }

    // UTC date bucketing. Local-timezone bucketing would be marginally
    // more accurate near midnight but would invalidate the mtime cache
    // when the user changes TZ; the rolling 24h window absorbs the
    // edge cases anyway.
    const date = ts.slice(0, 10);
    const entry = buckets.get(date) ?? { messages: 0 };
    entry.messages++;
    buckets.set(date, entry);
  }
  if (mtimeMs !== undefined) {
    claudeDailyCache.set(path, { mtimeMs, result: buckets });
    if (claudeDailyCache.size > MAX_CLAUDE_DAILY_CACHE) {
      const oldest = claudeDailyCache.keys().next().value;
      if (oldest !== undefined) claudeDailyCache.delete(oldest);
    }
  }
  return buckets;
}

/** Sum per-date buckets across every Claude session whose mtime is
 *  inside the wider 90-day lookback window. Sessions older than that
 *  are skipped — we won't render anything against them. */
async function buildClaudeDailyTotals(
  sessions: AgentSession[],
  now: number,
): Promise<{ totals: Map<string, number>; sessionsByDate: Map<string, Set<string>> }> {
  const totals = new Map<string, number>();
  const sessionsByDate = new Map<string, Set<string>>();
  const cutoff = now - PEAK_WEEK_LOOKBACK_MS - WEEK_MS;
  await Promise.all(
    sessions.map(async (s) => {
      if (s.agent !== "claude") return;
      const lastActive = Date.parse(s.lastActive);
      if (Number.isNaN(lastActive) || lastActive < cutoff) return;
      let mtimeMs: number | undefined;
      try {
        const st = await stat(s.source);
        mtimeMs = st.mtimeMs;
      } catch {
        return;
      }
      const buckets = await scanClaudeDailyBuckets(s.source, mtimeMs);
      for (const [date, b] of buckets) {
        totals.set(date, (totals.get(date) ?? 0) + b.messages);
        const setForDate = sessionsByDate.get(date) ?? new Set();
        setForDate.add(s.source);
        sessionsByDate.set(date, setForDate);
      }
    }),
  );
  return { totals, sessionsByDate };
}

/** Sum messages in dailyTotals for dates ∈ [cutoff, now]. UTC date
 *  match — same convention used at scan time. */
function sumWindow(
  totals: Map<string, number>,
  fromMs: number,
  toMs: number,
): { messages: number; dateCount: number } {
  let messages = 0;
  let dateCount = 0;
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const toDate = new Date(toMs).toISOString().slice(0, 10);
  for (const [date, m] of totals) {
    if (date < fromDate || date > toDate) continue;
    messages += m;
    dateCount++;
  }
  return { messages, dateCount };
}

function sessionsInWindow(
  sessionsByDate: Map<string, Set<string>>,
  fromMs: number,
  toMs: number,
): number {
  const seen = new Set<string>();
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const toDate = new Date(toMs).toISOString().slice(0, 10);
  for (const [date, set] of sessionsByDate) {
    if (date < fromDate || date > toDate) continue;
    for (const src of set) seen.add(src);
  }
  return seen.size;
}

function peakSingleDay(totals: Map<string, number>, fromMs: number): number {
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  let peak = 0;
  for (const [date, m] of totals) {
    if (date < fromDate) continue;
    if (m > peak) peak = m;
  }
  return peak;
}

function peakRollingWeek(
  totals: Map<string, number>,
  now: number,
  lookbackMs: number,
): number {
  // Walk each day in the lookback window, sum the 7 days ending on it.
  let peak = 0;
  const start = now - lookbackMs;
  for (let t = start; t <= now; t += DAY_MS) {
    const w = sumWindow(totals, t - WEEK_MS, t);
    if (w.messages > peak) peak = w.messages;
  }
  return peak;
}

/** Aggregate Claude sessions using per-turn date buckets. */
function aggregateClaude(
  totals: Map<string, number>,
  sessionsByDate: Map<string, Set<string>>,
  now: number,
): AgentUsage {
  const today = {
    sessions: sessionsInWindow(sessionsByDate, now - DAY_MS, now),
    messages: sumWindow(totals, now - DAY_MS, now).messages,
  };
  const week = {
    sessions: sessionsInWindow(sessionsByDate, now - WEEK_MS, now),
    messages: sumWindow(totals, now - WEEK_MS, now).messages,
  };
  return {
    today,
    week,
    peakDay: peakSingleDay(totals, now - PEAK_DAY_LOOKBACK_MS),
    peakWeek: peakRollingWeek(totals, now, PEAK_WEEK_LOOKBACK_MS),
  };
}

/** Fallback for agents we don't yet per-turn-parse. Uses mtime as the
 *  session's "happened then" stamp and counts its full lifetime
 *  messageCount toward whatever window the mtime lands in. */
function aggregateByMtime(list: AgentSession[], now: number): AgentUsage {
  const today = mtimeWindow(list, now - DAY_MS, now);
  const week = mtimeWindow(list, now - WEEK_MS, now);
  const peakDayMs = peakMtimeWindow(list, now - PEAK_DAY_LOOKBACK_MS, now, DAY_MS);
  const peakWeekMs = peakMtimeWindow(list, now - PEAK_WEEK_LOOKBACK_MS, now, WEEK_MS);
  return { today, week, peakDay: peakDayMs, peakWeek: peakWeekMs };
}

function mtimeWindow(
  list: AgentSession[],
  fromMs: number,
  toMs: number,
): AgentUsageWindow {
  let sessions = 0;
  let messages = 0;
  for (const s of list) {
    const t = Date.parse(s.lastActive);
    if (Number.isNaN(t) || t < fromMs || t > toMs) continue;
    sessions++;
    messages += s.messageCount ?? 0;
  }
  return { sessions, messages };
}

function peakMtimeWindow(
  list: AgentSession[],
  fromMs: number,
  toMs: number,
  windowMs: number,
): number {
  let peak = 0;
  for (let t = fromMs; t <= toMs; t += DAY_MS) {
    const w = mtimeWindow(list, t - windowMs, t);
    if (w.messages > peak) peak = w.messages;
  }
  return peak;
}

export interface ComputeOptions {
  /** Set to skip filesystem reads — used by tests that hand-roll the
   *  daily totals directly. */
  preComputedClaudeDailyTotals?: Map<string, number>;
  preComputedClaudeSessionsByDate?: Map<string, Set<string>>;
  /** Skip the OAuth /api/oauth/usage call. Tests don't want a network
   *  round trip; production sets this when the user has opted out. */
  skipClaudeLiveUsage?: boolean;
  /** Inject a custom fetcher for tests that DO exercise the OAuth path
   *  without hitting Anthropic. */
  claudeLiveUsageFetcher?: typeof fetchClaudeOAuthUsage;
}

export async function computeAgentUsage(
  sessions: AgentSession[],
  now: number,
  opts: ComputeOptions = {},
): Promise<AgentUsageReport> {
  const byAgent = new Map<AgentKind, AgentSession[]>();
  for (const s of sessions) {
    const arr = byAgent.get(s.agent);
    if (arr) arr.push(s);
    else byAgent.set(s.agent, [s]);
  }

  let claudeTotals = opts.preComputedClaudeDailyTotals;
  let claudeSessions = opts.preComputedClaudeSessionsByDate;
  if (!claudeTotals || !claudeSessions) {
    const built = await buildClaudeDailyTotals(byAgent.get("claude") ?? [], now);
    claudeTotals = built.totals;
    claudeSessions = built.sessionsByDate;
  }

  const agents: Partial<Record<AgentKind, AgentUsage>> = {};
  for (const [agent, list] of byAgent) {
    if (agent === "claude") {
      const usage = aggregateClaude(claudeTotals, claudeSessions, now);
      if (usage.week.messages > 0 || usage.week.sessions > 0) {
        agents[agent] = usage;
      }
      continue;
    }
    const usage = aggregateByMtime(list, now);
    if (usage.week.sessions > 0) {
      agents[agent] = usage;
    }
  }

  const claudePlan = await readClaudePlanTier();

  // Live plan utilization (% used + reset times) from Anthropic's
  // undocumented OAuth endpoint. Done in parallel-ish with the rest of
  // the report — failure is non-fatal; the chip falls back to local
  // JSONL counts and surfaces the error reason.
  let claudeLiveUsage: ClaudeOAuthUsage | null | undefined;
  let claudeLiveUsageError: OAuthUsageError | undefined;
  if (!opts.skipClaudeLiveUsage && agents.claude) {
    const fetcher = opts.claudeLiveUsageFetcher ?? fetchClaudeOAuthUsage;
    const result = await fetcher();
    claudeLiveUsage = result.usage;
    if (result.error) claudeLiveUsageError = result.error;
  }

  return {
    asOf: new Date(now).toISOString(),
    windows: { todayMs: DAY_MS, weekMs: WEEK_MS },
    claudePlan,
    claudeLiveUsage,
    claudeLiveUsageError,
    agents,
  };
}

/** Best-effort read of the user's plan tier from Claude Code's local
 *  credentials. Treats the file as opaque metadata — we only pluck
 *  `subscriptionType` and `rateLimitTier`. Tokens are never read into
 *  memory by this code path (the JSON is parsed and we discard
 *  everything else). */
async function readClaudePlanTier(): Promise<
  { subscriptionType?: string; rateLimitTier?: string } | undefined
> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(homedir(), ".claude", ".credentials.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const o = oauth as { subscriptionType?: unknown; rateLimitTier?: unknown };
  const out: { subscriptionType?: string; rateLimitTier?: string } = {};
  if (typeof o.subscriptionType === "string") out.subscriptionType = o.subscriptionType;
  if (typeof o.rateLimitTier === "string") out.rateLimitTier = o.rateLimitTier;
  return Object.keys(out).length > 0 ? out : undefined;
}
