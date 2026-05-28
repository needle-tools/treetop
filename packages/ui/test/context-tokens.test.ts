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
  test("current Opus / Sonnet (4.6+) → 1M per Anthropic's published caps", () => {
    expect(modelContextCap("claude-opus-4-7", "claude")).toBe(1_000_000);
    expect(modelContextCap("claude-opus-4-7-20251201", "claude")).toBe(
      1_000_000,
    );
    expect(modelContextCap("claude-sonnet-4-6", "claude")).toBe(1_000_000);
    expect(modelContextCap("claude-opus-4-6", "claude")).toBe(1_000_000);
  });

  test("Haiku 4.5 stays at 200k even on the current generation", () => {
    expect(modelContextCap("claude-haiku-4-5", "claude")).toBe(200_000);
    expect(modelContextCap("claude-haiku-4-5-20251001", "claude")).toBe(
      200_000,
    );
  });

  test("legacy Opus / Sonnet (≤4.5) → 200k", () => {
    expect(modelContextCap("claude-opus-4-5-20251101", "claude")).toBe(200_000);
    expect(modelContextCap("claude-opus-4-1-20250805", "claude")).toBe(200_000);
    expect(modelContextCap("claude-sonnet-4-5-20250929", "claude")).toBe(
      200_000,
    );
    expect(modelContextCap("claude-sonnet-4-20250514", "claude")).toBe(200_000);
  });

  test("`1m` / `[1m]` substring forces 1M regardless of family", () => {
    expect(modelContextCap("claude-sonnet-4-6-1m", "claude")).toBe(1_000_000);
    expect(modelContextCap("claude-sonnet-4-6[1m]", "claude")).toBe(1_000_000);
  });

  test("unknown model id → undefined (no fake denominator)", () => {
    expect(modelContextCap("gpt-5-codex", "codex")).toBeUndefined();
    expect(modelContextCap("gpt-4.1", "codex")).toBeUndefined();
    expect(modelContextCap("frobnitz-v9", undefined)).toBeUndefined();
  });

  test("unknown model + only an agent hint → still undefined", () => {
    // We used to default Claude / Codex to 200k here. That's a guess
    // and produces wrong-low percentages for 1M-window models, so the
    // chip now shows `??? / ???` instead.
    expect(modelContextCap(undefined, "claude")).toBeUndefined();
    expect(modelContextCap(undefined, "codex")).toBeUndefined();
    expect(modelContextCap(undefined, undefined)).toBeUndefined();
  });
});

describe("contextChip", () => {
  test("zero-state chip when tokens absent but cap is inferable (new TUI column)", () => {
    const a = contextChip({
      tokens: undefined,
      exact: true,
      model: "claude-sonnet-4-6",
    });
    expect(a).not.toBeNull();
    expect(a!.text).toBe("0 / 1M ctx (0%)");
    expect(a!.ratio).toBe(0);

    const b = contextChip({
      tokens: 0,
      exact: true,
      model: "claude-sonnet-4-6",
    });
    expect(b!.text).toBe("0 / 1M ctx (0%)");
  });

  test("returns null only when neither tokens nor cap are known", () => {
    expect(
      contextChip({
        tokens: undefined,
        exact: true,
        model: undefined,
        agent: undefined,
      }),
    ).toBeNull();
  });

  test("Opus 4.7 exact render: absolute + 1M cap + percent (regression: 220k must stay under 100%)", () => {
    // Real data from a supergit Opus 4.7 session that previously
    // rendered "218k / 200k ctx (109%)". The fix is the 1M cap for
    // current-generation Opus.
    const chip = contextChip({
      tokens: 220_561,
      exact: true,
      model: "claude-opus-4-7",
    });
    expect(chip).not.toBeNull();
    expect(chip!.text).toBe("221k / 1M ctx (22%)");
    expect(chip!.exact).toBe(true);
    expect(chip!.ratio).toBeCloseTo(220_561 / 1_000_000, 5);
    // Color escalation must be off for 22%.
    expect(chip!.ratio).toBeLessThan(0.6);
  });

  test("Haiku 4.5 still renders against the 200k cap", () => {
    const chip = contextChip({
      tokens: 42_100,
      exact: true,
      model: "claude-haiku-4-5",
    });
    expect(chip!.text).toBe("42.1k / 200k ctx (21%)");
  });

  test("Codex unknown cap → renders `???` instead of a fake denominator", () => {
    // We deliberately don't fabricate a Codex cap anymore: the user
    // sees `~42.1k / ??? ctx` so they know we couldn't infer the cap.
    const chip = contextChip({
      tokens: 42_100,
      exact: false,
      model: "gpt-5-codex",
      agent: "codex",
    });
    expect(chip!.text).toBe("~42.1k / ??? ctx");
    expect(chip!.exact).toBe(false);
    expect(chip!.ratio).toBeUndefined();
  });

  test("unknown model AND unknown agent → `??? ctx` placeholder, no percent", () => {
    const chip = contextChip({
      tokens: 1234,
      exact: true,
      model: "frobnitz-v9",
      agent: undefined,
    });
    expect(chip!.text).toBe("1.2k / ??? ctx");
    expect(chip!.ratio).toBeUndefined();
  });

  test("explicit `1m` suffix still forces the 1M cap", () => {
    const chip = contextChip({
      tokens: 250_000,
      exact: true,
      model: "claude-sonnet-4-6-1m",
    });
    expect(chip!.text).toBe("250k / 1M ctx (25%)");
  });

  test("explicit `cap` from the JSONL wins over the model-id heuristic", () => {
    // Real Codex 0.130 case: the file ships `info.model_context_window`
    // (258,400 in the wild). We must use that — not whatever guess the
    // gpt-5.5 model id would otherwise resolve to (which is "unknown",
    // since OpenAI ids fall through to undefined now).
    const codex = contextChip({
      tokens: 49_868,
      exact: true,
      model: "gpt-5.5",
      agent: "codex",
      cap: 258_400,
    });
    expect(codex).not.toBeNull();
    expect(codex!.capText).toBe("258k");
    expect(codex!.ratio).toBeCloseTo(49_868 / 258_400, 5);
    expect(codex!.text).toBe("49.9k / 258k ctx (19%)");
    expect(codex!.exact).toBe(true);
  });

  test("an explicit cap of 0 / NaN falls back to the model heuristic instead of silently disabling the cap", () => {
    const fallback = contextChip({
      tokens: 50_000,
      exact: true,
      model: "claude-opus-4-7",
      cap: 0,
    });
    expect(fallback!.capText).toBe("1M");
  });

  test("explicit cap also fills in a meaningful chip when the model id is unknown", () => {
    const chip = contextChip({
      tokens: 1_000,
      exact: true,
      model: undefined,
      agent: "codex",
      cap: 200_000,
    });
    expect(chip!.text).toBe("1k / 200k ctx (1%)");
  });

  test("exposes `absolute` and `capText` so the header can render them separately", () => {
    const known = contextChip({
      tokens: 220_561,
      exact: true,
      model: "claude-opus-4-7",
    });
    expect(known!.absolute).toBe("221k");
    expect(known!.capText).toBe("1M");

    const codex = contextChip({
      tokens: 12_345,
      exact: false,
      model: "gpt-5-codex",
      agent: "codex",
    });
    // Estimate prefix carries through into the absolute part.
    expect(codex!.absolute).toBe("~12.3k");
    expect(codex!.capText).toBeUndefined();
  });
});
