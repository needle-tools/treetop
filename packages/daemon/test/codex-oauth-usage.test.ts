import { test, expect, describe } from "bun:test";
import { _internal, fetchCodexOAuthUsage } from "../src/codex-oauth-usage";

describe("decodeWindow", () => {
  test("normalizes used_percent (0..100 → 0..1) and converts reset_at to ISO", () => {
    const out = _internal.decodeWindow({
      used_percent: 41,
      reset_at: 1747920600, // 2025-05-22T13:30:00Z (unix seconds)
      limit_window_seconds: 18000,
    })!;
    expect(out.utilization).toBe(0.41);
    expect(out.resetsAt).toBe("2025-05-22T13:30:00.000Z");
    expect(out.windowSeconds).toBe(18000);
  });

  test("missing used_percent → undefined window", () => {
    expect(_internal.decodeWindow({})).toBeUndefined();
    expect(_internal.decodeWindow(null)).toBeUndefined();
    expect(_internal.decodeWindow({ used_percent: "n/a" })).toBeUndefined();
  });

  test("missing reset_at and window_seconds leave them undefined", () => {
    const out = _internal.decodeWindow({ used_percent: 5 })!;
    expect(out.utilization).toBe(0.05);
    expect(out.resetsAt).toBeUndefined();
    expect(out.windowSeconds).toBeUndefined();
  });
});

describe("decodeUsage", () => {
  test("full response shape: plan + windows + credits", () => {
    const out = _internal.decodeUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 22, reset_at: 1747920600 },
        secondary_window: {
          used_percent: 8,
          reset_at: 1748000000,
          limit_window_seconds: 604800,
        },
      },
      credits: { has_credits: true, unlimited: false, balance: 12.34 },
    })!;
    expect(out.planType).toBe("pro");
    expect(out.primaryWindow?.utilization).toBe(0.22);
    expect(out.secondaryWindow?.utilization).toBe(0.08);
    expect(out.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 12.34,
    });
    expect(typeof out.fetchedAt).toBe("string");
  });

  test("missing rate_limit branches return undefined windows, not throw", () => {
    const out = _internal.decodeUsage({ plan_type: "free" })!;
    expect(out.planType).toBe("free");
    expect(out.primaryWindow).toBeUndefined();
    expect(out.secondaryWindow).toBeUndefined();
    expect(out.credits).toBeUndefined();
  });

  test("balance as string parses to number", () => {
    const out = _internal.decodeUsage({
      credits: { has_credits: true, unlimited: false, balance: "5.5" },
    })!;
    expect(out.credits?.balance).toBe(5.5);
  });

  test("null payload returns null", () => {
    expect(_internal.decodeUsage(null)).toBeNull();
    expect(_internal.decodeUsage("nope")).toBeNull();
  });
});

describe("fetchCodexOAuthUsage — injected fetcher", () => {
  test("forwards Bearer + optional ChatGPT-Account-Id headers", async () => {
    const fakeBody = {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 33, reset_at: 1747920600 },
      },
    };
    const fetcher = async (url: string, init: RequestInit) => {
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer .+/);
      expect(headers.Accept).toBe("application/json");
      return new Response(JSON.stringify(fakeBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await fetchCodexOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") return; // host has no codex auth.json
    expect(result.usage?.planType).toBe("pro");
    expect(result.usage?.primaryWindow?.utilization).toBe(0.33);
  });

  test("401/403 surfaces as kind=unauthorized", async () => {
    const fetcher = async () => new Response("nope", { status: 401 });
    const result = await fetchCodexOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") return;
    expect(result.error?.kind).toBe("unauthorized");
  });

  test("network error surfaces as kind=network", async () => {
    const fetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await fetchCodexOAuthUsage({ fetcher });
    if (result.error?.kind === "no-credentials") return;
    expect(result.error?.kind).toBe("network");
  });
});
