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

/** Set `SUPERGIT_USAGE_INSTRUMENT=1` to log every scan timing
 *  unconditionally. Otherwise we only log scans that take longer than
 *  the SLOW_SCAN_MS threshold — so a quiet host stays quiet and slow
 *  outliers still surface in stderr without grep gymnastics. */
const VERBOSE_INSTRUMENT = process.env.SUPERGIT_USAGE_INSTRUMENT === "1";
const SLOW_SCAN_MS = 50;

interface ScanStats {
  bytesRead: number;
  linesScanned: number;
  linesParsed: number;
  cacheHit: boolean;
}

function logScan(label: string, path: string, ms: number, s: ScanStats): void {
  if (s.cacheHit) {
    if (VERBOSE_INSTRUMENT) {
      console.log(`[usage] ${label} HIT  ${ms.toFixed(1)}ms  ${path}`);
    }
    return;
  }
  if (VERBOSE_INSTRUMENT || ms >= SLOW_SCAN_MS) {
    const kb = (s.bytesRead / 1024).toFixed(0);
    console.log(
      `[usage] ${label} MISS ${ms.toFixed(1)}ms  ${kb}KB ${s.linesScanned}lines ${s.linesParsed}parsed  ${path}`,
    );
  }
}

interface AggregateStats {
  sessionsConsidered: number;
  sessionsScanned: number;
  cacheHits: number;
  totalScanMs: number;
  walkMs: number;
}

function logAggregate(label: string, ms: number, s: AggregateStats): void {
  if (VERBOSE_INSTRUMENT || ms >= SLOW_SCAN_MS) {
    console.log(
      `[usage] ${label} total=${ms.toFixed(1)}ms  walk=${s.walkMs.toFixed(1)}ms  considered=${s.sessionsConsidered} scanned=${s.sessionsScanned} hits=${s.cacheHits} scan-sum=${s.totalScanMs.toFixed(1)}ms`,
    );
  }
}
import {
  fetchClaudeOAuthUsage,
  type ClaudeOAuthUsage,
  type OAuthUsageError,
} from "./claude-oauth-usage";
import {
  fetchCodexOAuthUsage,
  type CodexOAuthUsage,
  type CodexOAuthUsageError,
} from "./codex-oauth-usage";

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
  /** Same idea as `claudeLiveUsage`, but for Codex via ChatGPT's
   *  `backend-api/wham/usage` endpoint. Carries plan type, primary +
   *  secondary rate-limit windows, and any API credit balance. */
  codexLiveUsage?: CodexOAuthUsage | null;
  codexLiveUsageError?: CodexOAuthUsageError;
  /** Sessions sorted by total tokens spent inside the past 7-day window,
   *  most-expensive first. Capped at 5 entries. Only populated when the
   *  local JSONL scan finds at least one session with > 0 tokens — saves
   *  a no-op section in the tooltip. Pure-local data — sessions on
   *  other machines / the web client don't appear here. */
  claudeTopSessions?: ClaudeTopSession[];
  /** Only agents with non-zero week activity appear here. */
  agents: Partial<Record<AgentKind, AgentUsage>>;
}

export interface ClaudeTopSession {
  /** Anthropic's per-session UUID. Pulled from the AgentSession;
   *  may be undefined for malformed sessions. */
  sessionId?: string;
  /** JSONL file path — the dashboard's session identifier. The UI
   *  uses this to address its open-session columns. */
  source: string;
  /** Working directory the session ran in. UI uses this to derive
   *  the repo + worktree breadcrumb for display. */
  cwd: string;
  /** Best-effort display title (manualTitle > title > firstUserMessage). */
  title?: string;
  /** Sum of (input + cache_read + cache_creation + output) tokens
   *  across every in-window assistant turn. The single "total" the
   *  list sorts on. */
  totalTokens: number;
  /** Breakdown so the tooltip can show "X in / Y out" or hover to
   *  see cache-hit savings. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
  const startMs = performance.now();
  const stats: ScanStats = { bytesRead: 0, linesScanned: 0, linesParsed: 0, cacheHit: false };
  if (mtimeMs !== undefined) {
    const cached = claudeDailyCache.get(path);
    if (cached && cached.mtimeMs === mtimeMs) {
      // LRU touch.
      claudeDailyCache.delete(path);
      claudeDailyCache.set(path, cached);
      stats.cacheHit = true;
      logScan("scanDaily", path, performance.now() - startMs, stats);
      return cached.result;
    }
  }
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    logScan("scanDaily", path, performance.now() - startMs, stats);
    return new Map();
  }
  stats.bytesRead = content.length;
  const buckets = new Map<string, DailyBucket>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    stats.linesScanned++;
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
      stats.linesParsed++;
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
  logScan("scanDaily", path, performance.now() - startMs, stats);
  return buckets;
}

interface ClaudeSessionTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Billing-faithful weighted sum used to rank sessions in the
   *  "top sessions this week" list. Anthropic prices cache reads at
   *  ~10% of input, so a raw sum of all four fields is dominated by
   *  cache_read (every assistant turn re-reads the cached context)
   *  and turns a thoughtful one-hour session into a 100M-token
   *  monster. Formula: in + out + cache_write + CACHE_READ_WEIGHT *
   *  cache_read. Keep the unweighted fields above for any consumer
   *  that wants a different breakdown. */
  totalTokens: number;
}

/** Cache-read price multiplier on the Anthropic API (roughly 0.1 of
 *  the per-input-token rate at time of writing). Used to fold
 *  cache-read tokens into `totalTokens` without letting them swamp
 *  the ranking. If Anthropic re-prices, bump this; the unweighted
 *  cache_read count stays on `cacheReadTokens` either way. */
const CACHE_READ_WEIGHT = 0.1;

/** (path, mtime+since) → in-window token sums. The `sinceMs` parameter
 *  is baked into the cache key so a Tuesday read and a Saturday read
 *  of the same file produce independent (correct) results. */
const claudeTokenScanCache = new Map<
  string,
  { mtimeMs: number; sinceMs: number; result: ClaudeSessionTokenTotals }
>();
const MAX_CLAUDE_TOKEN_SCAN_CACHE = 5000;

export function clearClaudeTokenScanCache(): void {
  claudeTokenScanCache.clear();
}

/** Walk a single Claude JSONL and sum every assistant turn's
 *  message.usage block when the turn's `timestamp` is on/after
 *  `sinceMs`. Each turn contributes its full usage row — Anthropic's
 *  per-turn accounting is already final; we don't try to disambiguate
 *  thinking/tool/output. */
export async function scanClaudeSessionTokenTotals(
  path: string,
  mtimeMs: number | undefined,
  sinceMs: number,
): Promise<ClaudeSessionTokenTotals> {
  const startMs = performance.now();
  const stats: ScanStats = { bytesRead: 0, linesScanned: 0, linesParsed: 0, cacheHit: false };
  const cacheKey = `${path}|${sinceMs}`;
  if (mtimeMs !== undefined) {
    const cached = claudeTokenScanCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs && cached.sinceMs === sinceMs) {
      claudeTokenScanCache.delete(cacheKey);
      claudeTokenScanCache.set(cacheKey, cached);
      stats.cacheHit = true;
      logScan("scanToken", path, performance.now() - startMs, stats);
      return cached.result;
    }
  }
  const zero: ClaudeSessionTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    logScan("scanToken", path, performance.now() - startMs, stats);
    return zero;
  }
  stats.bytesRead = content.length;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const line of content.split("\n")) {
    if (!line) continue;
    stats.linesScanned++;
    // Cheap prefilter — only assistant turns carry usage blocks.
    if (!line.includes('"type":"assistant"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
      stats.linesParsed++;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const ts =
      typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (Number.isNaN(ts) || ts < sinceMs) continue;
    const msg = obj.message as { usage?: unknown } | undefined;
    const usage = msg?.usage as
      | {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        }
      | undefined;
    if (!usage || typeof usage !== "object") continue;
    if (typeof usage.input_tokens === "number")
      inputTokens += usage.input_tokens;
    if (typeof usage.output_tokens === "number")
      outputTokens += usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number")
      cacheReadTokens += usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === "number")
      cacheCreationTokens += usage.cache_creation_input_tokens;
  }
  const result: ClaudeSessionTokenTotals = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: Math.round(
      inputTokens +
        outputTokens +
        cacheCreationTokens +
        CACHE_READ_WEIGHT * cacheReadTokens,
    ),
  };
  if (mtimeMs !== undefined) {
    claudeTokenScanCache.set(cacheKey, { mtimeMs, sinceMs, result });
    if (claudeTokenScanCache.size > MAX_CLAUDE_TOKEN_SCAN_CACHE) {
      const oldest = claudeTokenScanCache.keys().next().value;
      if (oldest !== undefined) claudeTokenScanCache.delete(oldest);
    }
  }
  logScan("scanToken", path, performance.now() - startMs, stats);
  return result;
}

/** Walk every Claude AgentSession active in the past week, fetch its
 *  token totals, and return the top-N sorted by totalTokens desc.
 *  Exported so the route can serve this independently of the main
 *  /api/agent-usage payload — the scan is the slowest part of the
 *  report, so we lazy-load it. */
export async function topClaudeSessionsByTokens(
  sessions: AgentSession[],
  now: number,
  limit: number,
): Promise<ClaudeTopSession[]> {
  const startMs = performance.now();
  const sinceMs = now - WEEK_MS;
  const cutoffMtime = now - WEEK_MS;
  const agg: AggregateStats = {
    sessionsConsidered: sessions.length,
    sessionsScanned: 0,
    cacheHits: 0,
    totalScanMs: 0,
    walkMs: 0,
  };
  const results = await Promise.all(
    sessions.map(async (s): Promise<ClaudeTopSession | null> => {
      if (s.agent !== "claude") return null;
      const lastActive = Date.parse(s.lastActive);
      if (Number.isNaN(lastActive) || lastActive < cutoffMtime) return null;
      let mtimeMs: number | undefined;
      try {
        const st = await stat(s.source);
        mtimeMs = st.mtimeMs;
      } catch {
        return null;
      }
      agg.sessionsScanned++;
      const cacheKey = `${s.source}|${sinceMs}`;
      const wasCacheHit =
        mtimeMs !== undefined &&
        (() => {
          const c = claudeTokenScanCache.get(cacheKey);
          return c?.mtimeMs === mtimeMs && c?.sinceMs === sinceMs;
        })();
      if (wasCacheHit) agg.cacheHits++;
      const scanStart = performance.now();
      const totals = await scanClaudeSessionTokenTotals(
        s.source,
        mtimeMs,
        sinceMs,
      );
      agg.totalScanMs += performance.now() - scanStart;
      if (totals.totalTokens === 0) return null;
      return {
        sessionId: s.sessionId,
        source: s.source,
        cwd: s.cwd,
        title: s.manualTitle ?? s.title ?? s.firstUserMessage,
        totalTokens: totals.totalTokens,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
      };
    }),
  );
  agg.walkMs = performance.now() - startMs - agg.totalScanMs;
  const populated = results.filter((r): r is ClaudeTopSession => r !== null);
  populated.sort((a, b) => b.totalTokens - a.totalTokens);
  logAggregate("topSessions", performance.now() - startMs, agg);
  return populated.slice(0, limit);
}

/** Sum per-date buckets across every Claude session whose mtime is
 *  inside the wider 90-day lookback window. Sessions older than that
 *  are skipped — we won't render anything against them. */
async function buildClaudeDailyTotals(
  sessions: AgentSession[],
  now: number,
): Promise<{
  totals: Map<string, number>;
  sessionsByDate: Map<string, Set<string>>;
}> {
  const startMs = performance.now();
  const totals = new Map<string, number>();
  const sessionsByDate = new Map<string, Set<string>>();
  const cutoff = now - PEAK_WEEK_LOOKBACK_MS - WEEK_MS;
  const agg: AggregateStats = {
    sessionsConsidered: sessions.length,
    sessionsScanned: 0,
    cacheHits: 0,
    totalScanMs: 0,
    walkMs: 0,
  };
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
      agg.sessionsScanned++;
      const wasCacheHit = (() => {
        const c = claudeDailyCache.get(s.source);
        return c?.mtimeMs === mtimeMs;
      })();
      if (wasCacheHit) agg.cacheHits++;
      const scanStart = performance.now();
      const buckets = await scanClaudeDailyBuckets(s.source, mtimeMs);
      agg.totalScanMs += performance.now() - scanStart;
      for (const [date, b] of buckets) {
        totals.set(date, (totals.get(date) ?? 0) + b.messages);
        const setForDate = sessionsByDate.get(date) ?? new Set();
        setForDate.add(s.source);
        sessionsByDate.set(date, setForDate);
      }
    }),
  );
  agg.walkMs = performance.now() - startMs - agg.totalScanMs;
  logAggregate("dailyTotals", performance.now() - startMs, agg);
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
  const peakDayMs = peakMtimeWindow(
    list,
    now - PEAK_DAY_LOOKBACK_MS,
    now,
    DAY_MS,
  );
  const peakWeekMs = peakMtimeWindow(
    list,
    now - PEAK_WEEK_LOOKBACK_MS,
    now,
    WEEK_MS,
  );
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
  /** Same pair for the Codex (ChatGPT) usage endpoint. */
  skipCodexLiveUsage?: boolean;
  codexLiveUsageFetcher?: typeof fetchCodexOAuthUsage;
  /** Skip the per-session token scan (Top-N list). Tests inject totals
   *  directly via `preComputedClaudeDailyTotals` and don't need a
   *  parallel filesystem walk for the unrelated token list. */
  skipClaudeTopSessions?: boolean;
  /** Override the top-N cap. Default 5 — keeps the tooltip compact. */
  claudeTopSessionsLimit?: number;
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
    const built = await buildClaudeDailyTotals(
      byAgent.get("claude") ?? [],
      now,
    );
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

  // Live plan utilization from each provider's undocumented OAuth
  // endpoint. Both fetched in parallel — neither call gates the
  // report; failure on either is non-fatal, the chip falls back to
  // local JSONL counts and surfaces the error reason.
  const fetches: Array<Promise<unknown>> = [];
  let claudeLiveUsage: ClaudeOAuthUsage | null | undefined;
  let claudeLiveUsageError: OAuthUsageError | undefined;
  let codexLiveUsage: CodexOAuthUsage | null | undefined;
  let codexLiveUsageError: CodexOAuthUsageError | undefined;

  // Fetch live plan-utilization from each provider's OAuth endpoint
  // regardless of whether local sessions exist — the user may be using
  // the agent on other machines / via web and still wants to see their
  // rate-limit status in the chip.
  if (!opts.skipClaudeLiveUsage) {
    const fetcher = opts.claudeLiveUsageFetcher ?? fetchClaudeOAuthUsage;
    fetches.push(
      fetcher().then((result) => {
        claudeLiveUsage = result.usage;
        if (result.error) claudeLiveUsageError = result.error;
      }),
    );
  }
  if (!opts.skipCodexLiveUsage) {
    const fetcher = opts.codexLiveUsageFetcher ?? fetchCodexOAuthUsage;
    fetches.push(
      fetcher().then((result) => {
        codexLiveUsage = result.usage;
        if (result.error) codexLiveUsageError = result.error;
      }),
    );
  }
  if (fetches.length > 0) await Promise.all(fetches);

  // Top-5 most-expensive Claude sessions in the past week (local).
  // Walks JSONLs of every Claude session active in window, sums each
  // turn's token usage, sorts desc. Empty when no in-window session
  // had a usage block.
  let claudeTopSessions: ClaudeTopSession[] | undefined;
  if (!opts.skipClaudeTopSessions && agents.claude) {
    claudeTopSessions = await topClaudeSessionsByTokens(
      byAgent.get("claude") ?? [],
      now,
      opts.claudeTopSessionsLimit ?? 5,
    );
    if (claudeTopSessions.length === 0) claudeTopSessions = undefined;
  }

  return {
    asOf: new Date(now).toISOString(),
    windows: { todayMs: DAY_MS, weekMs: WEEK_MS },
    claudePlan,
    claudeLiveUsage,
    claudeLiveUsageError,
    codexLiveUsage,
    codexLiveUsageError,
    claudeTopSessions,
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
  if (typeof o.subscriptionType === "string")
    out.subscriptionType = o.subscriptionType;
  if (typeof o.rateLimitTier === "string") out.rateLimitTier = o.rateLimitTier;
  return Object.keys(out).length > 0 ? out : undefined;
}
