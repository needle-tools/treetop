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
import { enqueueSummary } from "../src/summary-queue";

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
