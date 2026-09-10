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

export interface ModelsDevPricingSnapshot {
  observedAt: string;
  source: "https://models.dev/api.json";
  models: readonly ModelPriceDefinition[];
}

export interface ModelPricingOptions {
  modelsDev?: ModelsDevPricingSnapshot;
  standardOnly?: boolean;
}

export interface ContextCompactionDetails {
  beforeTokens?: number;
  afterTokens?: number;
  durationMs?: number;
}

export interface ContextTokenSnapshot {
  totalTokens: number;
  attributedTokens: number;
}

/** Shared provider-boundary normalization for Claude's compactMetadata. */
export function contextCompactionDetailsFromMetadata(
  value: unknown,
): ContextCompactionDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const metadata = value as Record<string, unknown>;
  const beforeTokens = finiteRate(metadata.preTokens);
  const afterTokens = finiteRate(metadata.postTokens);
  const durationMs = finiteRate(metadata.durationMs);
  if (beforeTokens === undefined && afterTokens === undefined && durationMs === undefined) {
    return undefined;
  }
  return {
    ...(beforeTokens !== undefined ? { beforeTokens } : {}),
    ...(afterTokens !== undefined ? { afterTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Shared interpretation of Codex's pre/post-compaction token snapshots. */
export function contextTokenSnapshotFromUsageRecord(
  value: unknown,
): ContextTokenSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const totalTokens = finiteRate(usage.total_tokens ?? usage.totalTokens);
  if (totalTokens === undefined || totalTokens <= 0) return undefined;
  const attributedTokens = [
    usage.input_tokens ?? usage.inputTokens,
    usage.cached_input_tokens ?? usage.cachedInputTokens,
    usage.output_tokens ?? usage.outputTokens,
    usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
  ].reduce<number>((sum, tokenCount) => sum + (finiteRate(tokenCount) ?? 0), 0);
  return { totalTokens, attributedTokens };
}

export interface LoadModelsDevPricingOptions {
  fetcher?: typeof fetch;
  cacheKey?: string;
  observedAt?: string;
  timeoutMs?: number;
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
    cacheWrite5mUsd: number;
    cacheWrite1hUsd: number;
    outputUsd: number;
  };
  totalUsd: number;
  source: string;
  note?: string;
}

export interface TokenCostAtRates {
  longContext: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  parts: ModelTokenCost["parts"];
  totalUsd: number;
}

export interface SessionTokenUsageSegment {
  usage: VisualTokenUsage;
  model?: string;
  at?: string;
  /** Aggregated requests known to use standard-context rates. */
  standardOnly?: boolean;
}

export interface SessionTokenCost {
  totalUsd: number;
  pricedSegments: number;
  unpricedSegments: number;
  newInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  models: string[];
  sources: string[];
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
  ].map(
    ([id, input, cachedInput, cacheWriteInput, cacheWriteInput1h, output]) => ({
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
    }),
  ),
];

export function normalizePricedModelId(value: string | undefined): string {
  let normalized = (value ?? "").trim().toLowerCase();
  normalized = normalized.replace(/^(?:openai|anthropic)\//, "");
  const claudeIndex = normalized.indexOf("claude-");
  if (claudeIndex > 0) normalized = normalized.slice(claudeIndex);
  return normalized
    .replace(/@\d{8}$/, "")
    .replace(/-v\d+:\d+$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

interface ModelsDevCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
  context_over_200k?: ModelsDevCost;
  tiers?: Array<
    ModelsDevCost & {
      tier?: { type?: unknown; size?: unknown };
    }
  >;
}

interface ModelsDevModel {
  id?: unknown;
  release_date?: unknown;
  last_updated?: unknown;
  cost?: ModelsDevCost;
}

function finiteRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function modelsDevRates(
  cost: ModelsDevCost | undefined,
): ModelTokenRates | undefined {
  const input = finiteRate(cost?.input);
  const output = finiteRate(cost?.output);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = finiteRate(cost?.cache_read) ?? input;
  const cacheWriteInput = finiteRate(cost?.cache_write) ?? input;
  const contextTier = cost?.tiers
    ?.filter(
      (candidate) =>
        candidate.tier?.type === "context" &&
        finiteRate(candidate.tier.size) !== undefined,
    )
    .sort(
      (a, b) =>
        (finiteRate(a.tier?.size) ?? Infinity) -
        (finiteRate(b.tier?.size) ?? Infinity),
    )[0];
  const legacyTier = cost?.context_over_200k;
  const tier = contextTier ?? legacyTier;
  const thresholdTokens = contextTier
    ? finiteRate(contextTier.tier?.size)
    : legacyTier
      ? 200_000
      : undefined;
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    thresholdTokens,
    highInput: finiteRate(tier?.input),
    highCachedInput: finiteRate(tier?.cache_read),
    highCacheWriteInput: finiteRate(tier?.cache_write),
    highOutput: finiteRate(tier?.output),
  };
}

function utcBoundary(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  return Number.isFinite(Date.parse(normalized))
    ? new Date(normalized).toISOString()
    : undefined;
}

/** Converts the public models.dev provider map into the pricing contract. */
export function modelsDevPricingSnapshotFrom(
  value: unknown,
  observedAt: string | number | Date = new Date(),
): ModelsDevPricingSnapshot {
  const root =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const models: ModelPriceDefinition[] = [];
  for (const [providerKey, providerName] of [
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
  ] as const) {
    const provider = root[providerKey];
    if (!provider || typeof provider !== "object") continue;
    const providerModels = (provider as { models?: unknown }).models;
    if (!providerModels || typeof providerModels !== "object") continue;
    for (const [key, rawModel] of Object.entries(
      providerModels as Record<string, ModelsDevModel>,
    )) {
      const id = normalizePricedModelId(
        typeof rawModel?.id === "string" ? rawModel.id : key,
      );
      const rates = modelsDevRates(rawModel?.cost);
      if (!id || !rates) continue;
      models.push({
        id,
        provider: providerName,
        aliases: [id],
        periods: [
          {
            from:
              utcBoundary(rawModel.last_updated) ??
              utcBoundary(rawModel.release_date),
            rates,
            source: "https://models.dev/api.json",
            note: `models.dev snapshot observed ${timestampIso(observedAt)}`,
          },
        ],
      });
    }
  }
  return {
    observedAt: timestampIso(observedAt),
    source: "https://models.dev/api.json",
    models,
  };
}

function timestampIso(value: string | number | Date): string {
  const parsed = timestampMs(value);
  if (!Number.isFinite(parsed))
    throw new TypeError("Invalid pricing timestamp");
  return new Date(parsed).toISOString();
}

const modelsDevLoads = new Map<
  string,
  Promise<ModelsDevPricingSnapshot | undefined>
>();

/** Fetches models.dev once per cache key. Failure leaves bundled pricing active. */
export function loadModelsDevPricing(
  options: LoadModelsDevPricingOptions = {},
): Promise<ModelsDevPricingSnapshot | undefined> {
  const cacheKey = options.cacheKey ?? "default";
  const existing = modelsDevLoads.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, options.timeoutMs ?? 3_000),
    );
    try {
      const response = await (options.fetcher ?? fetch)(
        "https://models.dev/api.json",
        { signal: controller.signal },
      );
      if (!response.ok) return undefined;
      return modelsDevPricingSnapshotFrom(
        await response.json(),
        options.observedAt ?? new Date(),
      );
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  })();
  modelsDevLoads.set(cacheKey, promise);
  return promise;
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
  options: ModelPricingOptions = {},
): ResolvedModelPricing | undefined {
  const normalized = normalizePricedModelId(model);
  if (!normalized) return undefined;
  const atMs = timestampMs(at);
  if (!Number.isFinite(atMs)) return undefined;
  const findDefinition = (
    definitions: readonly ModelPriceDefinition[],
  ): ModelPriceDefinition | undefined =>
    definitions
      .filter((candidate) =>
        candidate.aliases.some(
          (alias) => normalized === alias || normalized.startsWith(`${alias}-`),
        ),
      )
      .sort(
        (a, b) =>
          Math.max(...b.aliases.map((alias) => alias.length)) -
          Math.max(...a.aliases.map((alias) => alias.length)),
      )[0];
  const bundledDefinition = findDefinition(MODEL_PRICE_CATALOG);
  const modelsDevDefinition = options.modelsDev
    ? findDefinition(options.modelsDev.models)
    : undefined;
  const observedAtMs = options.modelsDev
    ? Date.parse(options.modelsDev.observedAt)
    : Infinity;
  const definition =
    modelsDevDefinition &&
    (!bundledDefinition || atMs >= observedAtMs || at === undefined)
      ? modelsDevDefinition
      : (bundledDefinition ?? modelsDevDefinition);
  if (!definition) return undefined;
  const period = definition.periods.find((candidate) => {
    const fromMs = candidate.from ? Date.parse(candidate.from) : -Infinity;
    const beforeMs = candidate.before ? Date.parse(candidate.before) : Infinity;
    return atMs >= fromMs && atMs < beforeMs;
  });
  if (!period) return undefined;
  const bundledPeriod = bundledDefinition?.periods.find((candidate) => {
    const fromMs = candidate.from ? Date.parse(candidate.from) : -Infinity;
    const beforeMs = candidate.before ? Date.parse(candidate.before) : Infinity;
    return atMs >= fromMs && atMs < beforeMs;
  });
  const rates =
    definition === modelsDevDefinition && bundledPeriod
      ? {
          ...period.rates,
          cacheWriteInput1h:
            period.rates.cacheWriteInput1h ??
            bundledPeriod.rates.cacheWriteInput1h,
          highCacheWriteInput1h:
            period.rates.highCacheWriteInput1h ??
            bundledPeriod.rates.highCacheWriteInput1h,
        }
      : period.rates;
  return {
    model: definition.id,
    provider: definition.provider,
    rates,
    period,
  };
}

function finiteTokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Shared cache-aware token math for consumers that already resolved rates. */
export function estimateTokenCostAtRates(
  usage: VisualTokenUsage,
  rates: ModelTokenRates,
  options: { standardOnly?: boolean } = {},
): TokenCostAtRates {
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
    !options.standardOnly &&
    rates.thresholdTokens !== undefined &&
    reportedInput > rates.thresholdTokens;
  const inputRate = longContext
    ? (rates.highInput ?? rates.input)
    : rates.input;
  const cachedRate = longContext
    ? (rates.highCachedInput ?? rates.cachedInput)
    : rates.cachedInput;
  const cacheWriteRate = longContext
    ? (rates.highCacheWriteInput ??
      rates.highInput ??
      rates.cacheWriteInput ??
      rates.input)
    : (rates.cacheWriteInput ?? rates.input);
  const cacheWrite1hRate = longContext
    ? (rates.highCacheWriteInput1h ?? rates.cacheWriteInput1h ?? cacheWriteRate)
    : (rates.cacheWriteInput1h ?? cacheWriteRate);
  const outputRate = longContext
    ? (rates.highOutput ?? rates.output)
    : rates.output;
  const cacheWrite5mUsd =
    (cacheWriteInput5mTokens / 1_000_000) * cacheWriteRate;
  const cacheWrite1hUsd =
    (cacheWriteInput1hTokens / 1_000_000) * cacheWrite1hRate;
  const parts = {
    inputUsd: (inputTokens / 1_000_000) * inputRate,
    cachedInputUsd: (cachedInputTokens / 1_000_000) * cachedRate,
    cacheWriteInputUsd: cacheWrite5mUsd + cacheWrite1hUsd,
    cacheWrite5mUsd,
    cacheWrite1hUsd,
    outputUsd: (outputTokens / 1_000_000) * outputRate,
  };
  return {
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
  };
}

export function estimateModelTokenCost(
  usage: VisualTokenUsage,
  model: string | undefined,
  at?: string | number | Date,
  options: ModelPricingOptions = {},
): ModelTokenCost | undefined {
  const pricing = modelPricingAt(model, at, options);
  if (!pricing) return undefined;
  const estimated = estimateTokenCostAtRates(usage, pricing.rates, {
    standardOnly: options.standardOnly,
  });
  return {
    model: pricing.model,
    provider: pricing.provider,
    at: typeof at === "string" ? at : undefined,
    estimated: true,
    ...estimated,
    source: pricing.period.source,
    note: pricing.period.note,
  };
}

/** Prices a compact whole-session usage summary without needing transcript rows. */
export function estimateSessionTokenCost(
  segments: readonly SessionTokenUsageSegment[],
  defaultModel?: string,
  options: ModelPricingOptions = {},
): SessionTokenCost {
  let totalUsd = 0;
  let pricedSegments = 0;
  let unpricedSegments = 0;
  let newInputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  const models = new Set<string>();
  const sources = new Set<string>();
  for (const segment of segments) {
    const input = finiteTokens(segment.usage.input);
    const cachedInput = Math.min(
      input,
      finiteTokens(segment.usage.cachedInput),
    );
    newInputTokens += input - cachedInput;
    cachedInputTokens += cachedInput;
    outputTokens += finiteTokens(segment.usage.output);
    const cost = estimateModelTokenCost(
      segment.usage,
      segment.model ?? defaultModel,
      segment.at,
      { ...options, standardOnly: segment.standardOnly },
    );
    if (!cost) {
      unpricedSegments += 1;
      continue;
    }
    totalUsd += cost.totalUsd;
    pricedSegments += 1;
    models.add(cost.model);
    sources.add(cost.source);
  }
  return {
    totalUsd,
    pricedSegments,
    unpricedSegments,
    newInputTokens,
    cachedInputTokens,
    outputTokens,
    models: [...models],
    sources: [...sources],
  };
}
