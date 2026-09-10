import { describe, expect, test } from "bun:test";
import {
  contextCompactionDetailsFromMetadata,
  contextTokenSnapshotFromUsageRecord,
  estimateModelTokenCost,
  estimateSessionTokenCost,
  loadModelsDevPricing,
  modelPricingAt,
  modelsDevPricingSnapshotFrom,
  visualWorkDetailGroups,
  visualWorkOverview,
} from "../../nicifier/src/index";
import {
  codexAppHistoryMessagesFromThread,
  codexLiveMessagesFromEvent,
} from "../src/codex-event-stream";

describe("model pricing", () => {
  test("normalizes shared Claude and Codex compaction measurements", () => {
    expect(contextCompactionDetailsFromMetadata({
      preTokens: 999_820,
      postTokens: 15_028,
      durationMs: 127_824,
    })).toEqual({
      beforeTokens: 999_820,
      afterTokens: 15_028,
      durationMs: 127_824,
    });
    expect(contextTokenSnapshotFromUsageRecord({
      total_tokens: 14_484,
      input_tokens: 0,
      output_tokens: 0,
    })).toEqual({ totalTokens: 14_484, attributedTokens: 0 });
  });

  test("prices compact full-session usage segments and reports gaps", () => {
    const summary = estimateSessionTokenCost(
      [
        {
          model: "gpt-5.6-terra",
          at: "2026-09-06T10:00:00.000Z",
          usage: {
            input: 1_000_000,
            cachedInput: 500_000,
            cacheWriteInput: 0,
            output: 100_000,
            reasoningOutput: 0,
            total: 1_100_000,
          },
        },
        {
          model: "unknown-future-model",
          at: "2026-09-06T10:01:00.000Z",
          usage: {
            input: 10,
            cachedInput: 0,
            cacheWriteInput: 0,
            output: 5,
            reasoningOutput: 0,
            total: 15,
          },
        },
      ],
      undefined,
    );

    expect(summary).toMatchObject({
      pricedSegments: 1,
      unpricedSegments: 1,
      models: ["gpt-5.6-terra"],
      newInputTokens: 500_010,
      cachedInputTokens: 500_000,
      outputTokens: 100_005,
    });
    expect(summary.totalUsd).toBeCloseTo(4, 10);
  });

  test("does not turn aggregated standard-context requests into one long-context request", () => {
    const summary = estimateSessionTokenCost([
      {
        model: "gpt-5.6-terra",
        at: "2026-09-06T10:00:00.000Z",
        standardOnly: true,
        usage: {
          input: 1_000_000,
          cachedInput: 0,
          cacheWriteInput: 0,
          output: 0,
          reasoningOutput: 0,
          total: 1_000_000,
        },
      },
    ]);

    expect(summary.totalUsd).toBeCloseTo(2, 10);
  });

  test("normalizes models.dev prices and context tiers", () => {
    const snapshot = modelsDevPricingSnapshotFrom(
      {
        openai: {
          id: "openai",
          models: {
            "gpt-test": {
              id: "gpt-test",
              release_date: "2026-08-01",
              last_updated: "2026-09-01",
              cost: {
                input: 2,
                output: 12,
                cache_read: 0.2,
                cache_write: 2.5,
                tiers: [
                  {
                    input: 4,
                    output: 18,
                    cache_read: 0.4,
                    cache_write: 5,
                    tier: { type: "context", size: 200_000 },
                  },
                ],
              },
            },
          },
        },
      },
      "2026-09-06T10:00:00.000Z",
    );

    expect(snapshot.models).toHaveLength(1);
    expect(
      modelPricingAt("openai/gpt-test", "2026-09-06T10:00:01.000Z", {
        modelsDev: snapshot,
      }),
    ).toMatchObject({
      model: "gpt-test",
      rates: {
        input: 2,
        cachedInput: 0.2,
        cacheWriteInput: 2.5,
        output: 12,
        thresholdTokens: 200_000,
        highInput: 4,
        highCachedInput: 0.4,
        highCacheWriteInput: 5,
        highOutput: 18,
      },
    });
  });

  test("keeps bundled history before a models.dev snapshot was observed", () => {
    const snapshot = modelsDevPricingSnapshotFrom(
      {
        openai: {
          id: "openai",
          models: {
            "gpt-5.6-terra": {
              id: "gpt-5.6-terra",
              last_updated: "2026-09-05",
              cost: { input: 9, output: 90, cache_read: 0.9 },
            },
          },
        },
      },
      "2026-09-06T10:00:00.000Z",
    );

    expect(
      modelPricingAt("gpt-5.6-terra", "2026-07-29T12:00:00.000Z", {
        modelsDev: snapshot,
      })?.rates.input,
    ).toBe(2.5);
    expect(
      modelPricingAt("gpt-5.6-terra", "2026-09-06T10:00:01.000Z", {
        modelsDev: snapshot,
      })?.rates.input,
    ).toBe(9);
  });

  test("coalesces models.dev loading and times out to the bundled catalog", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          anthropic: {
            id: "anthropic",
            models: {
              "claude-test": {
                id: "claude-test",
                cost: { input: 1, output: 5, cache_read: 0.1 },
              },
            },
          },
        }),
      );
    };
    const options = {
      fetcher,
      cacheKey: "test-coalescing",
      observedAt: "2026-09-06T10:00:00.000Z",
    };
    const [first, second] = await Promise.all([
      loadModelsDevPricing(options),
      loadModelsDevPricing(options),
    ]);

    expect(calls).toBe(1);
    expect(first).toBe(second);
    expect(first?.models[0]?.id).toBe("claude-test");
  });

  test("keeps the active app-server model on live and history checkpoints", () => {
    const tokenPayload = {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 120,
        },
      },
    };
    const live = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "token_count",
        params: tokenPayload,
        receivedAt: "2026-09-06T10:00:00.000Z",
      },
      { model: "gpt-5.6-sol" },
    );
    const history = codexAppHistoryMessagesFromThread({
      model: "gpt-5.6-terra",
      turns: [
        {
          id: "turn-1",
          startedAt: 1788688800,
          items: [{ id: "usage-1", ...tokenPayload }],
        },
      ],
    });

    expect(live[0]).toMatchObject({
      model: "gpt-5.6-sol",
      tokensUsed: 20,
    });
    expect(history[0]).toMatchObject({
      model: "gpt-5.6-terra",
      tokensUsed: 20,
    });
  });

  test("tracks live model changes announced by nested thread settings", () => {
    const context = {};
    codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "thread/settings/updated",
        params: {
          thread_settings: { model: "gpt-6-astra" },
        },
        receivedAt: "2026-09-06T10:00:00.000Z",
      },
      context,
    );
    const [checkpoint] = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "token_count",
        params: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
            },
          },
        },
        receivedAt: "2026-09-06T10:00:01.000Z",
      },
      context,
    );

    expect(checkpoint?.model).toBe("gpt-6-astra");
  });

  test("prices cached input and cache writes as subsets of reported input", () => {
    const cost = estimateModelTokenCost(
      {
        input: 200_000,
        cachedInput: 100_000,
        cacheWriteInput: 20_000,
        output: 10_000,
        reasoningOutput: 4_000,
        total: 210_000,
      },
      "openai/gpt-5.6-sol-2026-08-01",
      "2026-09-06T10:00:00.000Z",
    );

    expect(cost).toMatchObject({
      model: "gpt-5.6-sol",
      inputTokens: 80_000,
      cachedInputTokens: 100_000,
      cacheWriteInputTokens: 20_000,
      outputTokens: 10_000,
      longContext: false,
    });
    expect(cost?.parts.inputUsd).toBeCloseTo(0.32, 10);
    expect(cost?.parts.cachedInputUsd).toBeCloseTo(0.04, 10);
    expect(cost?.parts.cacheWriteInputUsd).toBeCloseTo(0.1, 10);
    expect(cost?.parts.outputUsd).toBeCloseTo(0.2, 10);
    expect(cost?.totalUsd).toBeCloseTo(0.66, 10);
  });

  test("uses Claude's separate one-hour cache-write rate", () => {
    const cost = estimateModelTokenCost(
      {
        input: 34_086,
        cachedInput: 24_018,
        cacheWriteInput: 10_066,
        cacheWriteInput1h: 10_066,
        output: 306,
        reasoningOutput: 143,
        total: 34_392,
      },
      "claude-opus-5",
      "2026-08-20T06:05:45.485Z",
    );

    expect(cost?.parts.inputUsd).toBeCloseTo(0.00001, 10);
    expect(cost?.parts.cachedInputUsd).toBeCloseTo(0.012009, 10);
    expect(cost?.parts.cacheWriteInputUsd).toBeCloseTo(0.10066, 10);
    expect(cost?.parts.outputUsd).toBeCloseTo(0.00765, 10);
    expect(cost?.totalUsd).toBeCloseTo(0.120329, 10);
  });

  test("retains historical price periods and switches at their boundary", () => {
    expect(
      modelPricingAt("gpt-5.6-terra", "2026-07-29T23:59:59.999Z")?.rates,
    ).toMatchObject({ input: 2.5, cachedInput: 0.25, output: 15 });
    expect(
      modelPricingAt("gpt-5.6-terra", "2026-07-30T00:00:00.000Z")?.rates,
    ).toMatchObject({ input: 2, cachedInput: 0.2, output: 12 });
  });

  test("applies long-context rates to each request independently", () => {
    const cost = estimateModelTokenCost(
      {
        input: 300_000,
        cachedInput: 250_000,
        cacheWriteInput: 10_000,
        output: 10_000,
        reasoningOutput: 3_000,
        total: 310_000,
      },
      "gpt-5.6-terra",
      "2026-09-06T10:00:00.000Z",
    );

    expect(cost?.longContext).toBe(true);
    expect(cost?.totalUsd).toBeCloseTo(0.49, 10);
  });

  test("sums priced checkpoints while retaining unknown checkpoints", () => {
    const usage = (model: string, timestamp: string, input: number) => ({
      kind: "entry" as const,
      entry: {
        message: {
          role: "assistant",
          model,
          timestamp,
          tokenUsage: {
            input,
            cachedInput: 0,
            cacheWriteInput: 0,
            output: 10_000,
            reasoningOutput: 2_000,
            total: input + 10_000,
          },
        },
        blocks: [],
        messageIndex: 1,
      },
    });
    const entries = [
      usage("gpt-5.6-terra", "2026-09-06T10:00:01.000Z", 200_000),
      usage("gpt-5.6-terra", "2026-09-06T10:00:02.000Z", 200_000),
      usage("future-model", "2026-09-06T10:00:03.000Z", 10),
    ];

    const overview = visualWorkOverview(
      {
        startedAt: "2026-09-06T10:00:00.000Z",
        endedAt: "2026-09-06T10:00:04.000Z",
      },
      entries,
    );

    expect(overview.cost).toMatchObject({
      pricedCheckpoints: 2,
      unpricedCheckpoints: 1,
      models: ["gpt-5.6-terra"],
    });
    expect(overview.cost.totalUsd).toBeCloseTo(1.04, 10);
    expect(overview.tokens).toMatchObject({
      output: 30_000,
      reasoningOutput: 6_000,
      generatedOutput: 30_000,
      total: 430_010,
    });
  });

  test("uses a models.dev snapshot while pricing a rendered work round", () => {
    const modelsDev = modelsDevPricingSnapshotFrom(
      {
        openai: {
          id: "openai",
          models: {
            "gpt-future": {
              id: "gpt-future",
              release_date: "2026-09-01",
              cost: { input: 1, output: 5, cache_read: 0.1 },
            },
          },
        },
      },
      "2026-09-06T10:00:00.000Z",
    );
    const overview = visualWorkOverview(
      {},
      [
        {
          kind: "entry",
          entry: {
            message: {
              role: "assistant",
              model: "gpt-future",
              timestamp: "2026-09-06T10:00:01.000Z",
              tokenUsage: {
                input: 1_000_000,
                cachedInput: 0,
                cacheWriteInput: 0,
                output: 1_000_000,
                reasoningOutput: 0,
                total: 2_000_000,
              },
            },
            blocks: [],
            messageIndex: 1,
          },
        },
      ],
      { modelsDev },
    );

    expect(overview.cost).toMatchObject({
      totalUsd: 6,
      pricedCheckpoints: 1,
      models: ["gpt-future"],
      sources: ["https://models.dev/api.json"],
    });
  });

  test("attributes hidden token checkpoints to the preceding visible step", () => {
    const action = {
      kind: "entry" as const,
      entry: {
        message: {
          role: "assistant",
          timestamp: "2026-09-06T10:00:01.000Z",
        },
        blocks: [{ type: "tool_use", toolName: "exec_command" }],
        messageIndex: 1,
      },
    };
    const checkpoint = {
      kind: "entry" as const,
      entry: {
        message: {
          role: "assistant",
          model: "gpt-5.6-luna",
          timestamp: "2026-09-06T10:00:02.000Z",
          tokenUsage: {
            input: 100_000,
            cachedInput: 0,
            cacheWriteInput: 0,
            output: 10_000,
            reasoningOutput: 2_000,
            total: 110_000,
          },
        },
        blocks: [],
        messageIndex: 2,
      },
    };

    const [group] = visualWorkDetailGroups([action], [action, checkpoint]);
    expect(group?.entries).toEqual([action]);
    const overview = visualWorkOverview({}, group?.overviewEntries ?? []);
    expect(overview.cost.pricedCheckpoints).toBe(1);
    expect(overview.cost.totalUsd).toBeCloseTo(0.032, 10);
  });
});
