import { test, expect, describe } from "bun:test";
import { _internal, fetchClaudeOAuthUsage } from "../src/claude-oauth-usage";

describe("decodeUsage", () => {
  test("decodes five_hour + seven_day + per-model windows (0..100 → 0..1)", () => {
    // Anthropic returns utilization as a percentage point (0..100),
    // not a fraction. The decoder normalizes to 0..1 so consumers can
    // multiply by 100 to display a % without an awkward double-scale.
    const raw = {
      five_hour: { utilization: 41, resets_at: "2026-05-22T13:50:00Z" },
      seven_day: { utilization: 16, resets_at: "2026-05-23T22:00:00Z" },
      seven_day_sonnet: { utilization: 0, resets_at: "2026-05-23T22:00:00Z" },
      seven_day_opus: { utilization: 5, resets_at: "2026-05-23T22:00:00Z" },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour).toEqual({
      utilization: 0.41,
      resetsAt: "2026-05-22T13:50:00Z",
    });
    expect(out.sevenDay?.utilization).toBe(0.16);
    expect(out.sevenDaySonnet?.utilization).toBe(0);
    expect(out.sevenDayOpus?.utilization).toBe(0.05);
    expect(typeof out.fetchedAt).toBe("string");
  });

  test("accepts alternate key names for design / routines", () => {
    const raw = {
      claude_design: { utilization: 20 },
      seven_day_claude_routines: { utilization: 10 },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.sevenDayDesign?.utilization).toBe(0.2);
    expect(out.sevenDayRoutines?.utilization).toBe(0.1);
  });

  test("decodes extra_usage credit pool (utilization normalized 0..100 → 0..1)", () => {
    const raw = {
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 12.5,
        utilization: 12.5,
        currency: "USD",
      },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.extraUsage).toEqual({
      isEnabled: true,
      monthlyLimit: 100,
      usedCredits: 12.5,
      utilization: 0.125,
      currency: "USD",
    });
  });

  test("missing windows resolve to undefined, not throw", () => {
    const out = _internal.decodeUsage({})!;
    expect(out.fiveHour).toBeUndefined();
    expect(out.sevenDay).toBeUndefined();
    expect(out.extraUsage).toBeUndefined();
  });

  test("returns null for non-object payloads", () => {
    expect(_internal.decodeUsage(null)).toBeNull();
    expect(_internal.decodeUsage("oops")).toBeNull();
    expect(_internal.decodeUsage(42)).toBeNull();
  });

  test("ignores window entries with non-numeric utilization", () => {
    const raw = {
      five_hour: { utilization: "not a number", resets_at: "x" },
      seven_day: { utilization: 50 },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour).toBeUndefined();
    expect(out.sevenDay?.utilization).toBe(0.5);
  });

  test("resets_at as unix timestamp (number) is converted to ISO", () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: 1748311200 },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour?.resetsAt).toBe(
      new Date(1748311200 * 1000).toISOString(),
    );
  });

  test("resets_at as bare ISO string without Z gets UTC suffix", () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: "2026-05-27T02:00:00" },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour?.resetsAt).toBe("2026-05-27T02:00:00Z");
  });

  test("resets_at as ISO string with Z is left as-is", () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: "2026-05-27T02:00:00Z" },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour?.resetsAt).toBe("2026-05-27T02:00:00Z");
  });

  test("resets_at with +HH:MM offset is left as-is (not double-Z'd)", () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: "2026-05-27T04:00:00+02:00" },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour?.resetsAt).toBe("2026-05-27T04:00:00+02:00");
    // Must be parseable — the old regex appended Z making it invalid.
    expect(Number.isNaN(Date.parse(out.fiveHour!.resetsAt!))).toBe(false);
  });

  test("resets_at with +HHMM offset (no colon) is left as-is", () => {
    const raw = {
      five_hour: { utilization: 10, resets_at: "2026-05-27T04:00:00+0200" },
    };
    const out = _internal.decodeUsage(raw)!;
    expect(out.fiveHour?.resetsAt).toBe("2026-05-27T04:00:00+0200");
  });
});

describe("fetchClaudeOAuthUsage — injected fetcher", () => {
  test("decodes a 200 response into ClaudeOAuthUsage", async () => {
    const fakeBody = {
      five_hour: { utilization: 41, resets_at: "2026-05-22T13:50:00Z" },
      seven_day: { utilization: 16, resets_at: "2026-05-23T22:00:00Z" },
    };
    const fetcher = async (url: string, init: RequestInit) => {
      // Verify the request shape matches CodexBar's contract.
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      const headers = init.headers as Record<string, string>;
      expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(headers["User-Agent"]).toMatch(/^claude-code\//);
      expect(headers.Authorization).toMatch(/^Bearer .+/);
      return new Response(JSON.stringify(fakeBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    // Skip if no real credentials on this host — the readAccessToken
    // step bails before we ever call fetcher. This test is shape-only
    // and only runs when a credentials file exists.
    const result = await fetchClaudeOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") {
      // Not a failure — this CI host doesn't have ~/.claude.
      return;
    }
    expect(result.usage?.fiveHour?.utilization).toBe(0.41);
    expect(result.usage?.sevenDay?.utilization).toBe(0.16);
  });

  test("401 returns kind=unauthorized", async () => {
    const fetcher = async () => new Response("nope", { status: 401 });
    const result = await fetchClaudeOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") return;
    expect(result.usage).toBeNull();
    expect(result.error?.kind).toBe("unauthorized");
  });

  test("network error surfaces as kind=network", async () => {
    const fetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await fetchClaudeOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") return;
    expect(result.error?.kind).toBe("network");
  });

  test("non-200/401 status surfaces as kind=server with body excerpt", async () => {
    const fetcher = async () => new Response("boom", { status: 503 });
    const result = await fetchClaudeOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") return;
    expect(result.error?.kind).toBe("server");
    if (result.error?.kind === "server") {
      expect(result.error.status).toBe(503);
      expect(result.error.body).toBe("boom");
    }
  });
});
