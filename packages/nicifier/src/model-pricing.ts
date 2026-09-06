import type { VisualTokenUsage } from "./core/index.js";

export interface ModelTokenRates {
  /** USD per million tokens. */
  input: number;
  cachedInput: number;
  cacheWriteInput?: number;
  cacheWriteInput1h?: number;
  output: number;
  thresholdTokens?: number;
  highInput?: number;
  highCachedInput?: number;
  highCacheWriteInput?: number;
  highCacheWriteInput1h?: number;
  highOutput?: number;
}

export interface ModelPricePeriod {
  from?: string;
  before?: string;
  rates: ModelTokenRates;
  source: string;
  note?: string;
}

export interface ModelPriceDefinition {
  id: string;
  provider: "OpenAI" | "Anthropic";
  aliases: readonly string[];
  periods: readonly ModelPricePeriod[];
}

export interface ResolvedModelPricing {
  model: string;
  provider: ModelPriceDefinition["provider"];
  rates: ModelTokenRates;
  period: ModelPricePeriod;
}

export interface ModelTokenCost {
  model: string;
  provider: ModelPriceDefinition["provider"];
  at?: string;
  estimated: true;
  longContext: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  parts: {
    inputUsd: number;
    cachedInputUsd: number;
    cacheWriteInputUsd: number;
    outputUsd: number;
  };
  totalUsd: number;
  source: string;
  note?: string;
}

const GPT_56_TERRA_LUNA_CUTOVER = "2026-07-30T00:00:00.000Z";
const GPT_56_SOL_PROMO_CUTOVER = "2026-08-21T00:00:00.000Z";

function longContextRates(
  input: number,
  cachedInput: number,
  output: number,
  cacheWriteInput = input * 1.25,
): ModelTokenRates {
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    thresholdTokens: 272_000,
    highInput: input * 2,
    highCachedInput: cachedInput * 2,
    highCacheWriteInput: cacheWriteInput * 2,
    highOutput: output * 1.5,
  };
}

const OPENAI_CURRENT_SOURCE =
  "https://developers.openai.com/api/docs/models/compare";
const GPT_56_LAUNCH_SOURCE = "https://openai.com/index/gpt-5-6/";
const GPT_56_TERRA_LUNA_SOURCE =
  "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/";

/**
 * Versioned API-equivalent token pricing. Periods stay immutable when prices
 * change so old session checkpoints continue to resolve against their date.
 */
export const MODEL_PRICE_CATALOG: readonly ModelPriceDefinition[] = [
  {
    id: "gpt-6-astra",
    provider: "OpenAI",
    aliases: ["gpt-6-astra"],
    periods: [
      {
        rates: longContextRates(10, 1, 50),
        source: OPENAI_CURRENT_SOURCE,
      },
    ],
  },
  {
    id: "gpt-5.6-sol",
    provider: "OpenAI",
    aliases: ["gpt-5.6-sol", "gpt-5.6"],
    periods: [
      {
        before: GPT_56_SOL_PROMO_CUTOVER,
        rates: longContextRates(5, 0.5, 30),
        source: GPT_56_LAUNCH_SOURCE,
      },
      {
        from: GPT_56_SOL_PROMO_CUTOVER,
        rates: longContextRates(4, 0.4, 20),
        source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
        note: "Promotional pricing announced through at least 2026-11-21",
      },
    ],
  },
  {
    id: "gpt-5.6-terra",
    provider: "OpenAI",
    aliases: ["gpt-5.6-terra"],
    periods: [
      {
        before: GPT_56_TERRA_LUNA_CUTOVER,
        rates: longContextRates(2.5, 0.25, 15),
        source: GPT_56_LAUNCH_SOURCE,
      },
      {
        from: GPT_56_TERRA_LUNA_CUTOVER,
        rates: longContextRates(2, 0.2, 12),
        source: GPT_56_TERRA_LUNA_SOURCE,
      },
    ],
  },
  {
    id: "gpt-5.6-luna",
    provider: "OpenAI",
    aliases: ["gpt-5.6-luna"],
    periods: [
      {
        before: GPT_56_TERRA_LUNA_CUTOVER,
        rates: longContextRates(1, 0.1, 6),
        source: GPT_56_LAUNCH_SOURCE,
      },
      {
        from: GPT_56_TERRA_LUNA_CUTOVER,
        rates: longContextRates(0.2, 0.02, 1.2),
        source: GPT_56_TERRA_LUNA_SOURCE,
      },
    ],
  },
  ...[
    ["gpt-5.5", 5, 0.5, 30, true],
    ["gpt-5.4", 2.5, 0.25, 15, true],
    ["gpt-5.4-mini", 0.75, 0.075, 4.5, false],
    ["gpt-5.4-nano", 0.2, 0.02, 1.25, false],
    ["gpt-5.3-codex", 1.75, 0.175, 14, false],
    ["gpt-5.2-codex", 1.75, 0.175, 14, false],
    ["gpt-5.1-codex", 1.25, 0.125, 10, false],
    ["gpt-5.1-codex-max", 1.25, 0.125, 10, false],
    ["gpt-5.1-codex-mini", 0.25, 0.025, 2, false],
    ["gpt-5-codex", 1.25, 0.125, 10, false],
    ["codex-mini-latest", 1.5, 0.375, 6, false],
  ].map(([id, input, cachedInput, output, longContext]) => ({
    id: id as string,
    provider: "OpenAI" as const,
    aliases: [id as string],
    periods: [
      {
        rates: longContext
          ? longContextRates(
              input as number,
              cachedInput as number,
              output as number,
              input as number,
            )
          : {
              input: input as number,
              cachedInput: cachedInput as number,
              output: output as number,
            },
        source: "Bundled historical OpenAI API pricing",
      },
    ],
  })),
  {
    id: "gpt-5.3-codex-spark",
    provider: "OpenAI",
    aliases: ["gpt-5.3-codex-spark"],
    periods: [
      {
        rates: { input: 0, cachedInput: 0, output: 0 },
        source: "OpenAI research preview",
      },
    ],
  },
  ...[
    ["claude-fable-5", 10, 1, 12.5, 20, 50],
    ["claude-mythos-5", 10, 1, 12.5, 20, 50],
    ["claude-opus-5", 5, 0.5, 6.25, 10, 25],
    ["claude-opus-4-8", 5, 0.5, 6.25, 10, 25],
    ["claude-opus-4-7", 5, 0.5, 6.25, 10, 25],
    ["claude-opus-4-6", 5, 0.5, 6.25, 10, 25],
    ["claude-opus-4-5", 5, 0.5, 6.25, 10, 25],
    ["claude-sonnet-5", 2, 0.2, 2.5, 4, 10],
    ["claude-sonnet-4-6", 3, 0.3, 3.75, 6, 15],
    ["claude-sonnet-4-5", 3, 0.3, 3.75, 6, 15],
    ["claude-haiku-4-5", 1, 0.1, 1.25, 2, 5],
  ].map(([id, input, cachedInput, cacheWriteInput, cacheWriteInput1h, output]) => ({
    id: id as string,
    provider: "Anthropic" as const,
    aliases: [id as string],
    periods: [
      {
        rates: {
          input: input as number,
          cachedInput: cachedInput as number,
          cacheWriteInput: cacheWriteInput as number,
          cacheWriteInput1h: cacheWriteInput1h as number,
          output: output as number,
        },
        source: "https://platform.claude.com/docs/en/about-claude/pricing",
      },
    ],
  })),
];

export function normalizePricedModelId(value: string | undefined): string {
  let normalized = (value ?? "").trim().toLowerCase();
  normalized = normalized.replace(/^(?:openai|anthropic)\//, "");
  return normalized
    .replace(/@\d{8}$/, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

function timestampMs(value: string | number | Date | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Date.now();
}

export function modelPricingAt(
  model: string | undefined,
  at?: string | number | Date,
): ResolvedModelPricing | undefined {
  const normalized = normalizePricedModelId(model);
  if (!normalized) return undefined;
  const definition = MODEL_PRICE_CATALOG.find((candidate) =>
    candidate.aliases.some((alias) => alias === normalized),
  );
  if (!definition) return undefined;
  const atMs = timestampMs(at);
  if (!Number.isFinite(atMs)) return undefined;
  const period = definition.periods.find((candidate) => {
    const fromMs = candidate.from ? Date.parse(candidate.from) : -Infinity;
    const beforeMs = candidate.before ? Date.parse(candidate.before) : Infinity;
    return atMs >= fromMs && atMs < beforeMs;
  });
  if (!period) return undefined;
  return {
    model: definition.id,
    provider: definition.provider,
    rates: period.rates,
    period,
  };
}

function finiteTokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function estimateModelTokenCost(
  usage: VisualTokenUsage,
  model: string | undefined,
  at?: string | number | Date,
): ModelTokenCost | undefined {
  const pricing = modelPricingAt(model, at);
  if (!pricing) return undefined;
  const reportedInput = finiteTokens(usage.input);
  const cachedInputTokens = Math.min(
    reportedInput,
    finiteTokens(usage.cachedInput),
  );
  const cacheWriteInputTokens = Math.min(
    reportedInput - cachedInputTokens,
    finiteTokens(usage.cacheWriteInput),
  );
  const cacheWriteInput1hTokens = Math.min(
    cacheWriteInputTokens,
    finiteTokens(usage.cacheWriteInput1h ?? 0),
  );
  const cacheWriteInput5mTokens =
    cacheWriteInputTokens - cacheWriteInput1hTokens;
  const inputTokens = Math.max(
    0,
    reportedInput - cachedInputTokens - cacheWriteInputTokens,
  );
  const outputTokens = finiteTokens(usage.output);
  const longContext =
    pricing.rates.thresholdTokens !== undefined &&
    reportedInput > pricing.rates.thresholdTokens;
  const rates = pricing.rates;
  const inputRate = longContext ? (rates.highInput ?? rates.input) : rates.input;
  const cachedRate = longContext
    ? (rates.highCachedInput ?? rates.cachedInput)
    : rates.cachedInput;
  const cacheWriteRate = longContext
    ? (rates.highCacheWriteInput ?? rates.highInput ?? rates.cacheWriteInput ?? rates.input)
    : (rates.cacheWriteInput ?? rates.input);
  const cacheWrite1hRate = longContext
    ? (rates.highCacheWriteInput1h ?? rates.cacheWriteInput1h ?? cacheWriteRate)
    : (rates.cacheWriteInput1h ?? cacheWriteRate);
  const outputRate = longContext
    ? (rates.highOutput ?? rates.output)
    : rates.output;
  const parts = {
    inputUsd: (inputTokens / 1_000_000) * inputRate,
    cachedInputUsd: (cachedInputTokens / 1_000_000) * cachedRate,
    cacheWriteInputUsd:
      (cacheWriteInput5mTokens / 1_000_000) * cacheWriteRate +
      (cacheWriteInput1hTokens / 1_000_000) * cacheWrite1hRate,
    outputUsd: (outputTokens / 1_000_000) * outputRate,
  };
  return {
    model: pricing.model,
    provider: pricing.provider,
    at: typeof at === "string" ? at : undefined,
    estimated: true,
    longContext,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    parts,
    totalUsd:
      parts.inputUsd +
      parts.cachedInputUsd +
      parts.cacheWriteInputUsd +
      parts.outputUsd,
    source: pricing.period.source,
    note: pricing.period.note,
  };
}
