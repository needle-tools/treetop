import { test, expect, describe } from "bun:test";
import { fetchOllamaModels } from "../src/ollama-models";

/** Build a fake `fetch` returning a Response-like object. */
function fakeFetch(opts: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  throwErr?: unknown;
}): typeof fetch {
  return (async () => {
    if (opts.throwErr !== undefined) throw opts.throwErr;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: opts.json ?? (async () => ({})),
    };
  }) as unknown as typeof fetch;
}

describe("fetchOllamaModels", () => {
  test("ok response → models passed through", async () => {
    const models = [
      { name: "llama3", size: 4_000_000, parameterSize: "8B" },
      { name: "qwen2.5", parameterSize: "7B" },
    ];
    const r = await fetchOllamaModels(
      fakeFetch({ ok: true, json: async () => ({ models }) }),
      "/api/ollama/models",
    );
    expect(r).toEqual({ ok: true, models });
  });

  test("ok response with no models field → empty list (not undefined)", async () => {
    const r = await fetchOllamaModels(
      fakeFetch({ ok: true, json: async () => ({}) }),
      "/x",
    );
    expect(r).toEqual({ ok: true, models: [] });
  });

  test("non-ok response → error with reached:true (daemon answered, don't retry)", async () => {
    const r = await fetchOllamaModels(
      fakeFetch({ ok: false, status: 503 }),
      "/x",
    );
    expect(r).toEqual({
      ok: false,
      error: "daemon returned 503",
      reached: true,
    });
  });

  test("network throw → error with reached:false (let caller retry next open)", async () => {
    const r = await fetchOllamaModels(
      fakeFetch({ throwErr: new Error("connection refused") }),
      "/x",
    );
    expect(r).toEqual({
      ok: false,
      error: "connection refused",
      reached: false,
    });
  });

  test("non-Error throw → stringified, reached:false", async () => {
    const r = await fetchOllamaModels(fakeFetch({ throwErr: "boom" }), "/x");
    expect(r).toEqual({ ok: false, error: "boom", reached: false });
  });

  test("JSON parse throw on an ok response → reached:false (treated as unreached, retryable)", async () => {
    const r = await fetchOllamaModels(
      fakeFetch({
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      }),
      "/x",
    );
    expect(r).toEqual({ ok: false, error: "invalid json", reached: false });
  });
});
