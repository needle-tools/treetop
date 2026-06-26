/**
 * Tests for the repo-summary FIFO queue. The queue exists because Ollama
 * serialises chat requests per model on one GPU — firing N generations
 * at once just stalls N rows. So the contract is:
 *
 *  - jobs run one at a time, in enqueue order;
 *  - cancelling a not-yet-started job skips it entirely;
 *  - cancelling a running job aborts its signal;
 *  - a throwing job doesn't poison the rest of the queue;
 *  - each job receives an AbortSignal.
 *
 * The pump is microtask-scheduled, so tests await a macrotask turn
 * (`tick`) to let it advance, and gate long-running jobs on deferreds so
 * we control exactly when each one finishes.
 */

import { test, expect, describe } from "bun:test";
import {
  __resetSessionSummaryLookupForTests,
  enqueueSummary,
  invalidateCachedSessionSummary,
  loadCachedSessionSummary,
  nextCachedSessionSummaryRequest,
} from "../src/summary-queue";

/** Resolve after the current macrotask queue drains — enough for the
 *  microtask-scheduled pump plus any awaited deferreds to settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("enqueueSummary", () => {
  test("runs a queued job", async () => {
    let ran = false;
    enqueueSummary(async () => {
      ran = true;
    });
    await tick();
    expect(ran).toBe(true);
  });

  test("runs jobs strictly in FIFO order, one at a time", async () => {
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    enqueueSummary(async () => {
      order.push("a:start");
      await a.promise;
      order.push("a:end");
    });
    enqueueSummary(async () => {
      order.push("b:start");
      await b.promise;
      order.push("b:end");
    });

    await tick();
    // b must NOT have started while a is still running.
    expect(order).toEqual(["a:start"]);

    a.resolve();
    await tick();
    expect(order).toEqual(["a:start", "a:end", "b:start"]);

    b.resolve();
    await tick();
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("a job cancelled before it starts is skipped", async () => {
    const calls: string[] = [];
    const block = deferred();
    enqueueSummary(async () => {
      calls.push("a");
      await block.promise;
    });
    const cancelB = enqueueSummary(async () => {
      calls.push("b");
    });

    await tick(); // a is now running and awaiting `block`; b still queued
    cancelB();
    block.resolve();
    await tick();

    expect(calls).toEqual(["a"]); // b never ran
  });

  test("cancelling a running job aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const started = deferred();
    const release = deferred();
    const cancel = enqueueSummary(async (s) => {
      signal = s;
      started.resolve();
      await release.promise;
    });

    await started.promise;
    expect(signal!.aborted).toBe(false);
    cancel();
    expect(signal!.aborted).toBe(true);

    release.resolve(); // let the job unwind so the queue drains
    await tick();
  });

  test("a throwing job does not poison the queue", async () => {
    const calls: string[] = [];
    enqueueSummary(async () => {
      throw new Error("boom");
    });
    enqueueSummary(async () => {
      calls.push("survivor");
    });
    await tick();
    expect(calls).toEqual(["survivor"]);
  });

  test("each job receives an AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    enqueueSummary(async (s) => {
      signal = s;
    });
    await tick();
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("jobs enqueued after the queue drained still run", async () => {
    let first = false;
    enqueueSummary(async () => {
      first = true;
    });
    await tick();
    expect(first).toBe(true);

    // Queue is idle now; a fresh enqueue must restart the pump.
    let second = false;
    enqueueSummary(async () => {
      second = true;
    });
    await tick();
    expect(second).toBe(true);
  });
});

describe("loadCachedSessionSummary", () => {
  test("coalesces concurrent reads for the same source", async () => {
    __resetSessionSummaryLookupForTests();
    let resolveRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      await gate;
      return new Response(JSON.stringify({ summary: { body: "cached" } }));
    }) as typeof fetch;

    const a = loadCachedSessionSummary("source-a", "/summary/a", fetchImpl);
    const b = loadCachedSessionSummary("source-a", "/summary/a", fetchImpl);
    await Promise.resolve();

    expect(calls).toEqual(["/summary/a"]);
    resolveRead();
    expect(await a).toEqual({ summary: { body: "cached" } });
    expect(await b).toEqual({ summary: { body: "cached" } });
  });

  test("caps different-source cached summary reads", async () => {
    __resetSessionSummaryLookupForTests();
    const resolvers: (() => void)[] = [];
    const started: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      started.push(String(url));
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return new Response(JSON.stringify({ summary: null }));
    }) as typeof fetch;

    const a = loadCachedSessionSummary("a", "/summary/a", fetchImpl);
    const b = loadCachedSessionSummary("b", "/summary/b", fetchImpl);
    const c = loadCachedSessionSummary("c", "/summary/c", fetchImpl);
    await Promise.resolve();

    expect(started).toEqual(["/summary/a", "/summary/b"]);
    resolvers.shift()?.();
    await a;
    await Promise.resolve();
    expect(started).toEqual(["/summary/a", "/summary/b", "/summary/c"]);

    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all([b, c]);
  });

  test("caches successful reads until invalidated", async () => {
    __resetSessionSummaryLookupForTests();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ summary: { body: `v${calls}` } }));
    }) as typeof fetch;

    expect(
      await loadCachedSessionSummary("source-a", "/summary/a", fetchImpl),
    ).toEqual({ summary: { body: "v1" } });
    expect(
      await loadCachedSessionSummary("source-a", "/summary/a", fetchImpl),
    ).toEqual({ summary: { body: "v1" } });
    expect(calls).toBe(1);

    invalidateCachedSessionSummary("source-a");
    expect(
      await loadCachedSessionSummary("source-a", "/summary/a", fetchImpl),
    ).toEqual({ summary: { body: "v2" } });
    expect(calls).toBe(2);
  });
});

describe("nextCachedSessionSummaryRequest", () => {
  test("clears when the column no longer has a source", () => {
    expect(
      nextCachedSessionSummaryRequest({
        target: undefined,
        sessionLoaded: false,
        nearViewport: false,
        lastRequested: "source-a",
      }),
    ).toBe("");
  });

  test("waits until the session is loaded and near the viewport", () => {
    expect(
      nextCachedSessionSummaryRequest({
        target: "source-a",
        sessionLoaded: false,
        nearViewport: true,
        lastRequested: undefined,
      }),
    ).toBeNull();
    expect(
      nextCachedSessionSummaryRequest({
        target: "source-a",
        sessionLoaded: true,
        nearViewport: false,
        lastRequested: undefined,
      }),
    ).toBeNull();
  });

  test("requests a visible loaded source once", () => {
    expect(
      nextCachedSessionSummaryRequest({
        target: "source-a",
        sessionLoaded: true,
        nearViewport: true,
        lastRequested: undefined,
      }),
    ).toBe("source-a");
    expect(
      nextCachedSessionSummaryRequest({
        target: "source-a",
        sessionLoaded: true,
        nearViewport: true,
        lastRequested: "source-a",
      }),
    ).toBeNull();
  });
});
