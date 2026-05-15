import { describe, expect, test } from "bun:test";
import {
  contextChip,
  formatTokens,
  modelContextCap,
} from "../src/context-tokens";

describe("formatTokens", () => {
  test("renders sub-1k as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(952)).toBe("952");
  });

  test("renders 1k-100k with one decimal, 100k+ as integer-k", () => {
    expect(formatTokens(4321)).toBe("4.3k");
    expect(formatTokens(42100)).toBe("42.1k");
    expect(formatTokens(152000)).toBe("152k");
  });

  test("drops trailing zero on small-k values", () => {
    expect(formatTokens(8000)).toBe("8k");
  });

  test("renders megatokens with a couple of decimals", () => {
    expect(formatTokens(1_050_000)).toBe("1.05M");
    expect(formatTokens(12_300_000)).toBe("12.3M");
  });
});

describe("modelContextCap", () => {
  test("Claude sonnet/opus default to 200k", () => {
    expect(modelContextCap("claude-sonnet-4-6", "claude")).toBe(200_000);
    expect(modelContextCap("claude-opus-4-7-20250101", "claude")).toBe(200_000);
  });

  test("the [1m] / 1m Claude variant gets 1M", () => {
    expect(modelContextCap("claude-sonnet-4-6-1m", "claude")).toBe(1_000_000);
    expect(modelContextCap("claude-sonnet-4-6[1m]", "claude")).toBe(1_000_000);
  });

  test("known OpenAI ids fall back to 200k", () => {
    expect(modelContextCap("gpt-5-codex", "codex")).toBe(200_000);
    expect(modelContextCap("gpt-4.1", "codex")).toBe(200_000);
  });

  test("unknown model + claude agent still gives 200k", () => {
    expect(modelContextCap(undefined, "claude")).toBe(200_000);
  });

  test("unknown model + unknown agent → undefined", () => {
    expect(modelContextCap(undefined, undefined)).toBeUndefined();
    expect(modelContextCap("frobnitz-v9", undefined)).toBeUndefined();
  });
});

describe("contextChip", () => {
  test("returns null when there's no token count", () => {
    expect(
      contextChip({ tokens: undefined, exact: true, model: "claude-sonnet-4-6" }),
    ).toBeNull();
    expect(
      contextChip({ tokens: 0, exact: true, model: "claude-sonnet-4-6" }),
    ).toBeNull();
  });

  test("Claude exact render: absolute + cap + percent", () => {
    const chip = contextChip({
      tokens: 42_100,
      exact: true,
      model: "claude-sonnet-4-6",
    });
    expect(chip).not.toBeNull();
    expect(chip!.text).toBe("42.1k / 200k ctx (21%)");
    expect(chip!.exact).toBe(true);
    expect(chip!.ratio).toBeCloseTo(42_100 / 200_000, 5);
  });

  test("Codex estimate render: ~ prefix on the absolute", () => {
    const chip = contextChip({
      tokens: 42_100,
      exact: false,
      model: "gpt-5-codex",
      agent: "codex",
    });
    expect(chip!.text).toBe("~42.1k / 200k ctx (21%)");
    expect(chip!.exact).toBe(false);
  });

  test("unknown cap → absolute only, no slash, no percent", () => {
    const chip = contextChip({
      tokens: 1234,
      exact: true,
      model: "frobnitz-v9",
      agent: undefined,
    });
    expect(chip!.text).toBe("1.2k ctx");
    expect(chip!.ratio).toBeUndefined();
  });

  test("Claude 1M variant scales the cap accordingly", () => {
    const chip = contextChip({
      tokens: 250_000,
      exact: true,
      model: "claude-sonnet-4-6-1m",
    });
    expect(chip!.text).toBe("250k / 1M ctx (25%)");
  });
});
