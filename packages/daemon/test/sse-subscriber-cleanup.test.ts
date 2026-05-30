import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The /api/stream SSE handler must remove *its own* controller from
 * sseSubscribers when the connection is cancelled, so the multi-client
 * broadcast set doesn't accumulate dead entries. Two ways this regressed
 * before:
 *   - an empty try{} body in a loop that therefore never deleted anything;
 *   - "fixing" it as sseSubscribers.delete(controllerOrReason) — wrong,
 *     because ReadableStream.cancel(reason) gets the *reason*, not the
 *     controller, so it would delete undefined (a no-op).
 *
 * Like server-characterization.test.ts / sse-heartbeat.test.ts, we assert
 * on the source string — the daemon boots a real HTTP listener at import
 * time, so importing it here is undesirable.
 */
const SRC = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf-8");

/** Body of the start(...) → cancel(...) ReadableStream passed to the
 *  /api/stream route. Anchor on the route GUARD (not the API-docs index,
 *  which also mentions the path) and slice to the Response. */
function streamBlock(): string {
  const guard = SRC.indexOf('"/api/stream" && req.method === "GET"');
  expect(guard, "/api/stream route guard not found").toBeGreaterThan(-1);
  // Window must reach past the (large) explanatory comment to the cancel
  // body — 2400 chars comfortably covers start()…cancel()…Response.
  const block = SRC.slice(guard, guard + 2400);
  return block;
}

describe("SSE subscriber cleanup on cancel", () => {
  test("start() captures this connection's controller for later removal", () => {
    const block = streamBlock();
    // The controller from start() is stored so cancel() can target it.
    expect(block).toMatch(/start\(controller\)\s*\{/);
    expect(block).toMatch(/myController\s*=\s*controller/);
    expect(block).toContain("sseSubscribers.add(controller)");
  });

  test("cancel() deletes exactly this controller, not the reason arg", () => {
    const block = streamBlock();
    // Must remove the captured controller…
    expect(block).toContain("sseSubscribers.delete(myController)");
    // …and must NOT have regressed to deleting the cancel() argument,
    // which is the cancellation reason (undefined here), not a controller.
    expect(block).not.toContain("sseSubscribers.delete(controllerOrReason)");
    // …and must NOT have the old empty-try no-op loop.
    expect(block).not.toMatch(/try\s*\{\s*\}\s*catch/);
  });
});
