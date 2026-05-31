import { test, expect, describe } from "bun:test";
import {
  computeAgentUsage,
  scanClaudeDailyBuckets,
  clearClaudeDailyCache,
  scanClaudeSessionTokenTotals,
  clearClaudeTokenScanCache,
  floorToHourMs,
} from "../src/agent-usage";
import type { AgentSession } from "../src/agents";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Default to skipping the OAuth /api/oauth/usage network call in every
 *  test that isn't specifically testing the live-usage wiring. Saves
 *  CI from hitting Anthropic and from depending on whether the host
 *  has ~/.claude credentials. */
function computeAgentUsageSilent(
  sessions: AgentSession[],
  now: number,
  opts: Parameters<typeof computeAgentUsage>[2] = {},
): ReturnType<typeof computeAgentUsage> {
  return computeAgentUsage(sessions, now, {
    skipClaudeLiveUsage: true,
    skipCodexLiveUsage: true,
    skipClaudeTopSessions: true,
    ...opts,
  });
}

function session(
  agent: AgentSession["agent"],
  ago: number,
  messageCount?: number,
): AgentSession {
  return {
    agent,
    cwd: "/repo",
    lastActive: new Date(Date.now() - ago).toISOString(),
    source: `/sessions/${agent}-${ago}-${messageCount ?? 0}`,
    messageCount,
  };
}

describe("computeAgentUsage — mtime fallback agents (codex/ollama/copilot)", () => {
  test("bucketing — sessions inside 24h count in today, inside 7d count in week", async () => {
    const now = Date.now();
    const r = await computeAgentUsageSilent(
      [
        session("codex", 2 * HOUR, 10),
        session("codex", 3 * DAY, 5),
        session("codex", 10 * DAY, 99),
      ],
      now,
    );
    expect(r.agents.codex?.today).toEqual({ sessions: 1, messages: 10 });
    expect(r.agents.codex?.week).toEqual({ sessions: 2, messages: 15 });
  });

  test("agents with zero week activity are omitted from the report", async () => {
    const r = await computeAgentUsageSilent(
      [session("codex", 30 * DAY, 999)],
      Date.now(),
    );
    expect(r.agents.codex).toBeUndefined();
  });

  test("missing messageCount counts as 0, not NaN", async () => {
    const r = await computeAgentUsageSilent(
      [session("ollama", HOUR), session("ollama", HOUR, 3)],
      Date.now(),
    );
    expect(r.agents.ollama?.today).toEqual({ sessions: 2, messages: 3 });
  });

  test("peakDay / peakWeek populated for fallback agents too", async () => {
    const now = Date.now();
    const r = await computeAgentUsageSilent(
      [
        session("ollama", HOUR, 5),
        session("ollama", 2 * DAY, 50),
        session("ollama", 9 * DAY, 200),
      ],
      now,
    );
    // peakDay is the busiest single-day window in the last 30d — the
    // 2-day-ago session with 50 messages is the day's biggest spike.
    expect(r.agents.ollama?.peakDay).toBeGreaterThanOrEqual(50);
    // peakWeek captures any 7-day rolling window in the last 90d — the
    // 9-day-ago 200-msg session falls inside that range.
    expect(r.agents.ollama?.peakWeek).toBeGreaterThanOrEqual(200);
  });

  test("asOf and window widths are surfaced for the UI to label", async () => {
    const now = Date.UTC(2026, 4, 22, 15, 0, 0);
    const r = await computeAgentUsageSilent([session("ollama", HOUR, 1)], now);
    expect(r.asOf).toBe(new Date(now).toISOString());
    expect(r.windows.todayMs).toBe(DAY);
    expect(r.windows.weekMs).toBe(7 * DAY);
  });
});

describe("computeAgentUsage — Claude (per-date buckets)", () => {
  test("uses pre-computed daily totals when supplied", async () => {
    const now = Date.UTC(2026, 4, 22, 15, 0, 0);
    const totals = new Map<string, number>([
      ["2026-05-22", 30], // today (within last 24h via UTC date match)
      ["2026-05-21", 50], // yesterday
      ["2026-05-15", 80], // 7 days ago — at the edge of week
      ["2026-04-30", 200], // outside week, inside peakDay lookback
    ]);
    const sessionsByDate = new Map<string, Set<string>>([
      ["2026-05-22", new Set(["/s/a"])],
      ["2026-05-21", new Set(["/s/a", "/s/b"])],
      ["2026-05-15", new Set(["/s/c"])],
    ]);
    const r = await computeAgentUsageSilent(
      [session("claude", 1 * HOUR)], // present so the agent appears in byAgent
      now,
      {
        preComputedClaudeDailyTotals: totals,
        preComputedClaudeSessionsByDate: sessionsByDate,
      },
    );
    expect(r.agents.claude).toBeDefined();
    // today = sum of dates within the last DAY window. May 22 + May 21
    // are both within now - 24h on the UTC-date scan.
    expect(r.agents.claude!.today.messages).toBeGreaterThan(0);
    expect(r.agents.claude!.week.messages).toBeGreaterThanOrEqual(30 + 50);
    // peakDay should hit the 200-message day from April 30.
    expect(r.agents.claude!.peakDay).toBe(200);
  });

  test("omits claude from report when there are no in-window dates", async () => {
    const now = Date.UTC(2026, 4, 22, 15, 0, 0);
    const r = await computeAgentUsageSilent(
      [session("claude", 100 * DAY)],
      now,
      {
        preComputedClaudeDailyTotals: new Map(),
        preComputedClaudeSessionsByDate: new Map(),
      },
    );
    expect(r.agents.claude).toBeUndefined();
  });
});

describe("scanClaudeDailyBuckets", () => {
  test("buckets user + assistant turns by UTC date from each line's timestamp", async () => {
    clearClaudeDailyCache();
    const dir = await mkdtemp(join(tmpdir(), "supergit-agent-usage-"));
    const file = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-22T10:00:00.000Z",
        message: { content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-22T10:00:05.000Z",
        message: { content: "hello" },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-23T08:00:00.000Z",
        message: { content: "follow up" },
      }),
    ].join("\n");
    await writeFile(file, lines);
    const buckets = await scanClaudeDailyBuckets(file);
    expect(buckets.get("2026-05-22")?.messages).toBe(2);
    expect(buckets.get("2026-05-23")?.messages).toBe(1);
  });

  test("tool-result-only user turns don't count", async () => {
    clearClaudeDailyCache();
    const dir = await mkdtemp(join(tmpdir(), "supergit-agent-usage-"));
    const file = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-22T10:00:00.000Z",
        message: { content: [{ type: "tool_result", content: "..." }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-22T10:01:00.000Z",
        message: { content: [{ type: "text", text: "real prompt" }] },
      }),
    ].join("\n");
    await writeFile(file, lines);
    const buckets = await scanClaudeDailyBuckets(file);
    expect(buckets.get("2026-05-22")?.messages).toBe(1);
  });

  test("lines without a timestamp are skipped", async () => {
    clearClaudeDailyCache();
    const dir = await mkdtemp(join(tmpdir(), "supergit-agent-usage-"));
    const file = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: "no ts" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-22T10:00:00.000Z",
      }),
    ].join("\n");
    await writeFile(file, lines);
    const buckets = await scanClaudeDailyBuckets(file);
    expect(buckets.get("2026-05-22")?.messages).toBe(1);
    expect(buckets.size).toBe(1);
  });

  test("malformed JSON lines are skipped (no throw)", async () => {
    clearClaudeDailyCache();
    const dir = await mkdtemp(join(tmpdir(), "supergit-agent-usage-"));
    const file = join(dir, "sess.jsonl");
    const lines = [
      "garbage",
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-22T10:00:00.000Z",
      }),
      "{ truncated",
    ].join("\n");
    await writeFile(file, lines);
    const buckets = await scanClaudeDailyBuckets(file);
    expect(buckets.get("2026-05-22")?.messages).toBe(1);
  });

  test("missing file returns empty map (no throw)", async () => {
    clearClaudeDailyCache();
    const buckets = await scanClaudeDailyBuckets("/no/such/path.jsonl");
    expect(buckets.size).toBe(0);
  });
});

describe("scanClaudeSessionTokenTotals", () => {
  test("sums every in-window assistant turn's usage block", async () => {
    clearClaudeTokenScanCache();
    const dir = await mkdtemp(join(tmpdir(), "supergit-agent-usage-"));
    const file = join(dir, "sess.jsonl");
    const sinceMs = Date.UTC(2026, 4, 20);
    const lines = [
      // In-window assistant turn with full usage block.
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-22T10:00:00.000Z",
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 100,
          },
        },
      }),
      // In-window assistant turn, output-only usage block.
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-22T11:00:00.000Z",
        message: { usage: { output_tokens: 50 } },
      }),
      // Out-of-window — predates `sinceMs`. Must NOT contribute.
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-19T08:00:00.000Z",
        message: { usage: { input_tokens: 99_999, output_tokens: 99_999 } },
      }),
      // User turns are skipped regardless of usage payload.
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-22T10:00:30.000Z",
      }),
    ].join("\n");
    await writeFile(file, lines);
    const totals = await scanClaudeSessionTokenTotals(file, undefined, sinceMs);
    expect(totals.inputTokens).toBe(1000);
    expect(totals.outputTokens).toBe(250);
    expect(totals.cacheReadTokens).toBe(5000);
    expect(totals.cacheCreationTokens).toBe(100);
    // Billing-faithful weighting: cache_read counts at 0.1× because
    // Anthropic prices it that way, and a raw sum is dominated by
    // cache replay rather than work done.
    //   1000 (in) + 250 (out) + 100 (cache_write) + 0.1 * 5000 (cache_read)
    //   = 1000 + 250 + 100 + 500 = 1850
    expect(totals.totalTokens).toBe(1850);
  });

  test("turns without a usage block contribute 0", async () => {
    clearClaudeTokenScanCache();
    const dir = await mkdtemp(join(tmpdir(), "supergit-agent-usage-"));
    const file = join(dir, "sess.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-22T10:00:00.000Z",
        message: {}, // no usage
      }),
    ].join("\n");
    await writeFile(file, lines);
    const totals = await scanClaudeSessionTokenTotals(file, undefined, 0);
    expect(totals.totalTokens).toBe(0);
  });

  test("missing file returns zeroed totals (no throw)", async () => {
    clearClaudeTokenScanCache();
    const totals = await scanClaudeSessionTokenTotals(
      "/no/such/path.jsonl",
      undefined,
      0,
    );
    expect(totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("computeAgentUsage — Claude live usage from OAuth endpoint", () => {
  test("forwards the fetched ClaudeOAuthUsage into the report", async () => {
    const now = Date.now();
    const fakeUsage = {
      fiveHour: { utilization: 0.41, resetsAt: "2026-05-22T13:50:00Z" },
      sevenDay: { utilization: 0.16, resetsAt: "2026-05-23T22:00:00Z" },
      fetchedAt: new Date(now).toISOString(),
    };
    const r = await computeAgentUsage(
      [
        {
          agent: "claude",
          cwd: "/repo",
          lastActive: new Date(now - HOUR).toISOString(),
          source: "/sessions/a",
          messageCount: 5,
        },
      ],
      now,
      {
        preComputedClaudeDailyTotals: new Map([
          [new Date(now).toISOString().slice(0, 10), 5],
        ]),
        preComputedClaudeSessionsByDate: new Map([
          [new Date(now).toISOString().slice(0, 10), new Set(["/sessions/a"])],
        ]),
        claudeLiveUsageFetcher: async () => ({ usage: fakeUsage, error: null }),
      },
    );
    expect(r.claudeLiveUsage?.fiveHour?.utilization).toBe(0.41);
    expect(r.claudeLiveUsage?.sevenDay?.utilization).toBe(0.16);
    expect(r.claudeLiveUsageError).toBeUndefined();
  });

  test("fetcher errors surface in claudeLiveUsageError, usage stays null", async () => {
    const now = Date.now();
    const r = await computeAgentUsage(
      [
        {
          agent: "claude",
          cwd: "/repo",
          lastActive: new Date(now - HOUR).toISOString(),
          source: "/sessions/a",
          messageCount: 5,
        },
      ],
      now,
      {
        preComputedClaudeDailyTotals: new Map([
          [new Date(now).toISOString().slice(0, 10), 5],
        ]),
        preComputedClaudeSessionsByDate: new Map([
          [new Date(now).toISOString().slice(0, 10), new Set(["/sessions/a"])],
        ]),
        claudeLiveUsageFetcher: async () => ({
          usage: null,
          error: { kind: "expired" },
        }),
      },
    );
    expect(r.claudeLiveUsage).toBeNull();
    expect(r.claudeLiveUsageError).toEqual({ kind: "expired" });
  });

  test("fetcher is called even when no claude agent sessions are present", async () => {
    const now = Date.now();
    let called = 0;
    const r = await computeAgentUsage(
      [
        {
          agent: "ollama",
          cwd: "/repo",
          lastActive: new Date(now - HOUR).toISOString(),
          source: "/sessions/o",
          messageCount: 1,
        },
      ],
      now,
      {
        claudeLiveUsageFetcher: async () => {
          called++;
          return { usage: null, error: null };
        },
      },
    );
    expect(called).toBe(1);
    expect(r.claudeLiveUsage).toBeNull();
  });
});

describe("floorToHourMs (token-scan cache-key stability)", () => {
  // The per-session token scan caches on `${path}|${sinceMs}`, and
  // sinceMs = now - WEEK_MS. Derived from raw Date.now() the key changed
  // every call, so the cache never hit and every (up to 300MB) JSONL was
  // re-read on every poll. Flooring `now` to the hour keeps the key
  // stable within the hour while the week window still advances hourly.
  const base = floorToHourMs(1_700_000_000_000); // some hour boundary

  test("floors to an exact hour boundary", () => {
    expect(floorToHourMs(base + 37 * 60 * 1000 + 4123) % HOUR).toBe(0);
  });

  test("is stable for any instant within the same hour", () => {
    expect(floorToHourMs(base)).toBe(base);
    expect(floorToHourMs(base + 1)).toBe(base);
    expect(floorToHourMs(base + 59 * 60 * 1000 + 59_999)).toBe(base);
  });

  test("advances by exactly one hour at the next boundary", () => {
    expect(floorToHourMs(base + HOUR)).toBe(base + HOUR);
    expect(floorToHourMs(base + HOUR + 1)).toBe(base + HOUR);
  });

  test("is idempotent", () => {
    const t = 1_700_003_999_123;
    expect(floorToHourMs(floorToHourMs(t))).toBe(floorToHourMs(t));
  });
});
