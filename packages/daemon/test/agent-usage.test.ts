import { test, expect, describe } from "bun:test";
import { computeAgentUsage } from "../src/agent-usage";
import type { AgentSession } from "../src/agents";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

describe("computeAgentUsage", () => {
  test("bucketing — sessions inside 24h count in today, inside 7d count in week", () => {
    const now = Date.now();
    const r = computeAgentUsage(
      [
        session("claude", 2 * HOUR, 10),
        session("claude", 3 * DAY, 5),
        session("claude", 10 * DAY, 99),
      ],
      now,
    );
    expect(r.agents.claude?.today).toEqual({ sessions: 1, messages: 10 });
    expect(r.agents.claude?.week).toEqual({ sessions: 2, messages: 15 });
  });

  test("multi-agent — each agent gets its own bucket", () => {
    const now = Date.now();
    const r = computeAgentUsage(
      [
        session("claude", HOUR, 4),
        session("claude", HOUR, 6),
        session("codex", 5 * HOUR, 12),
        session("ollama", 3 * DAY, 1),
      ],
      now,
    );
    expect(r.agents.claude).toEqual({
      today: { sessions: 2, messages: 10 },
      week: { sessions: 2, messages: 10 },
    });
    expect(r.agents.codex).toEqual({
      today: { sessions: 1, messages: 12 },
      week: { sessions: 1, messages: 12 },
    });
    expect(r.agents.ollama).toEqual({
      today: { sessions: 0, messages: 0 },
      week: { sessions: 1, messages: 1 },
    });
  });

  test("missing messageCount counts as 0, not NaN", () => {
    const r = computeAgentUsage(
      [session("claude", HOUR), session("claude", HOUR, 3)],
      Date.now(),
    );
    expect(r.agents.claude?.today).toEqual({ sessions: 2, messages: 3 });
  });

  test("agents with zero week activity are omitted from the report", () => {
    const r = computeAgentUsage(
      [session("claude", HOUR, 1), session("codex", 30 * DAY, 999)],
      Date.now(),
    );
    expect(r.agents.claude).toBeDefined();
    expect(r.agents.codex).toBeUndefined();
  });

  test("malformed lastActive — session is skipped, not thrown", () => {
    const r = computeAgentUsage(
      [
        {
          agent: "claude",
          cwd: "/repo",
          lastActive: "not-a-date",
          source: "/bad",
          messageCount: 10,
        },
        session("claude", HOUR, 5),
      ],
      Date.now(),
    );
    expect(r.agents.claude?.today).toEqual({ sessions: 1, messages: 5 });
  });

  test("asOf and window widths are surfaced for the UI to label", () => {
    const now = Date.UTC(2026, 4, 22, 15, 0, 0);
    const r = computeAgentUsage([session("claude", HOUR, 1)], now);
    expect(r.asOf).toBe(new Date(now).toISOString());
    expect(r.windows.todayMs).toBe(DAY);
    expect(r.windows.weekMs).toBe(7 * DAY);
  });
});
