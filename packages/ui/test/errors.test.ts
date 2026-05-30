import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  subscribeErrors,
  pushError,
  setErrors,
  clearErrorsLocal,
  recordBrowserError,
  installFetchTracking,
  getErrors,
  __resetFetchTrackingForTests,
  type FrontendErrorEntry,
} from "../src/errors";

function makeEntry(over: Partial<FrontendErrorEntry> = {}): FrontendErrorEntry {
  return {
    id: over.id ?? crypto.randomUUID(),
    timestamp: over.timestamp ?? new Date().toISOString(),
    kind: over.kind ?? "fetch",
    source: over.source ?? "browser",
    message: over.message ?? "boom",
    stack: over.stack,
    route: over.route,
    method: over.method,
    status: over.status,
    extra: over.extra,
  };
}

describe("frontend errors store", () => {
  beforeEach(() => {
    clearErrorsLocal();
  });

  test("subscribers receive the current list on subscribe", () => {
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last).toEqual([]);
    unsub();
  });

  test("pushError prepends most-recent-first and notifies subscribers", () => {
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    pushError(makeEntry({ message: "first" }));
    pushError(makeEntry({ message: "second" }));
    expect(last!.map((e) => e.message)).toEqual(["second", "first"]);
    unsub();
  });

  test("pushError dedups by id", () => {
    const a = makeEntry({ id: "x", message: "a" });
    const b = makeEntry({ id: "x", message: "b" });
    pushError(a);
    pushError(b);
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last!.map((e) => e.message)).toEqual(["a"]);
    unsub();
  });

  test("setErrors replaces the list and rebuilds dedup index", () => {
    // Distinct messages so they don't fold into one row — this test is
    // about the id-based no-op on re-push, not content dedup.
    setErrors([
      makeEntry({ id: "1", message: "one" }),
      makeEntry({ id: "2", message: "two" }),
    ]);
    // pushing the same id again should be a no-op
    pushError(makeEntry({ id: "1", message: "duplicate" }));
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last!.length).toBe(2);
    unsub();
  });

  test("setErrors folds duplicate occurrences and prunes >24h entries", () => {
    const now = Date.now();
    setErrors([
      // Two identical occurrences of the same error → one row, count 2.
      makeEntry({ id: "d1", message: "same", route: "/api/x", method: "GET" }),
      makeEntry({ id: "d2", message: "same", route: "/api/x", method: "GET" }),
      // A stale occurrence (>24h) → dropped entirely.
      makeEntry({
        id: "old",
        message: "ancient",
        timestamp: new Date(now - 25 * 3600_000).toISOString(),
      }),
    ]);
    const list = getErrors();
    expect(list.length).toBe(1);
    expect(list[0]?.message).toBe("same");
    expect(list[0]?.count).toBe(2);
  });

  test("clearErrorsLocal empties the list and notifies", () => {
    pushError(makeEntry({ message: "one" }));
    pushError(makeEntry({ message: "two" }));
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last!.length).toBe(2);
    clearErrorsLocal();
    expect(last).toEqual([]);
    unsub();
  });

  test("recordBrowserError fills id/timestamp and adds to store", () => {
    // Stub fetch so postEntry doesn't try to hit a real network.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const e = recordBrowserError({
        kind: "fetch",
        source: "browser",
        message: "GET /api/foo → 502 Bad Gateway",
        route: "/api/foo",
        method: "GET",
        status: 502,
      });
      expect(e.id).toMatch(/.+/);
      expect(Date.parse(e.timestamp)).not.toBeNaN();
      expect(e.status).toBe(502);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("list caps at MAX_ENTRIES (no unbounded growth)", () => {
    // Distinct messages so none fold — exercises the hard 1000-row cap.
    for (let i = 0; i < 1100; i++) {
      pushError(makeEntry({ id: `i${i}`, message: `m${i}` }));
    }
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last!.length).toBe(1000);
    expect(last![0]?.message).toBe("m1099");
    unsub();
  });
});

describe("pushError dedup", () => {
  beforeEach(() => {
    clearErrorsLocal();
  });

  test("folds identical entries into one row with a count bump", () => {
    // The same fetch failure firing 30 times collapses to a single row.
    const baseTs = Date.now();
    for (let i = 0; i < 30; i++) {
      pushError(
        makeEntry({
          id: `burst-${i}`,
          kind: "fetch",
          method: "GET",
          route: "/api/repos",
          message: "GET /api/repos → Failed to fetch",
          timestamp: new Date(baseTs + i * 100).toISOString(),
        }),
      );
    }
    const list = getErrors();
    expect(list.length).toBe(1);
    expect(list[0]?.count).toBe(30);
    // The original row's id stays stable so subscribers keyed by id don't churn.
    expect(list[0]?.id).toBe("burst-0");
    // Timestamp tracks the latest occurrence.
    expect(list[0]?.timestamp).toBe(new Date(baseTs + 29 * 100).toISOString());
  });

  test("does NOT fold entries with different routes", () => {
    pushError(
      makeEntry({ id: "a", kind: "fetch", method: "GET", route: "/api/repos" }),
    );
    pushError(
      makeEntry({ id: "b", kind: "fetch", method: "GET", route: "/api/diff" }),
    );
    expect(getErrors().length).toBe(2);
  });

  test("folds identical entries regardless of how much time has elapsed", () => {
    // No coalesce window any more: a recurrence a day apart still folds.
    const now = Date.now();
    pushError(
      makeEntry({
        id: "a",
        kind: "fetch",
        method: "GET",
        route: "/api/ssh/sessions",
        message: "GET /api/ssh/sessions → Failed to fetch",
        timestamp: new Date(now - 23 * 3600_000).toISOString(),
      }),
    );
    pushError(
      makeEntry({
        id: "b",
        kind: "fetch",
        method: "GET",
        route: "/api/ssh/sessions",
        message: "GET /api/ssh/sessions → Failed to fetch",
        timestamp: new Date(now).toISOString(),
      }),
    );
    const list = getErrors();
    expect(list.length).toBe(1);
    expect(list[0]?.count).toBe(2);
  });

  test("folds uncaught errors with the same message, keeps different ones apart", () => {
    pushError(makeEntry({ id: "u1", kind: "uncaught", message: "boom" }));
    pushError(makeEntry({ id: "u2", kind: "uncaught", message: "boom" }));
    pushError(makeEntry({ id: "u3", kind: "uncaught", message: "splat" }));
    const list = getErrors();
    expect(list.length).toBe(2);
    expect(list.find((e) => e.message === "boom")?.count).toBe(2);
  });

  test("prunes entries older than 24h on the next push", () => {
    const now = Date.now();
    pushError(
      makeEntry({
        id: "old",
        message: "stale",
        timestamp: new Date(now - 25 * 3600_000).toISOString(),
      }),
    );
    pushError(makeEntry({ id: "fresh", message: "fresh" }));
    const list = getErrors();
    expect(list.map((e) => e.message)).toEqual(["fresh"]);
  });
});

describe("installFetchTracking — expected-client-error filter", () => {
  // Each test stubs `globalThis.fetch` to a Response factory BEFORE
  // calling installFetchTracking, so the wrapper captures the stub as
  // its underlying fetch. The `__resetFetchTrackingForTests` call
  // forgets a prior install so the new stub takes effect.
  let savedFetch: typeof globalThis.fetch;
  beforeEach(() => {
    clearErrorsLocal();
    __resetFetchTrackingForTests();
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    __resetFetchTrackingForTests();
  });

  function stubResponse(status: number, statusText: string) {
    globalThis.fetch = (async () =>
      new Response("", { status, statusText })) as typeof fetch;
    installFetchTracking();
  }

  test("skips recording 409 Conflict responses on non-GET requests", async () => {
    stubResponse(409, "Conflict");
    const res = await fetch("/api/repos/r1/checkout", { method: "POST" });
    expect(res.status).toBe(409);
    // The caller still sees the 409 and can handle it. We just don't
    // shovel it into the error popover.
    expect(getErrors().length).toBe(0);
  });

  test("STILL records 409 Conflict on a GET (genuine bug, not a contract)", async () => {
    stubResponse(409, "Conflict");
    await fetch("/api/repos/r1");
    expect(getErrors().length).toBe(1);
    expect(getErrors()[0]?.status).toBe(409);
  });

  test("STILL records other 4xx (400/404/etc.) on non-GET requests", async () => {
    stubResponse(400, "Bad Request");
    await fetch("/api/repos/r1/checkout", { method: "POST" });
    expect(getErrors().length).toBe(1);
    expect(getErrors()[0]?.status).toBe(400);
  });

  test("skips recording 304 Not Modified responses", async () => {
    stubResponse(304, "Not Modified");
    const res = await fetch("/api/session?source=foo.jsonl");
    expect(res.status).toBe(304);
    expect(getErrors().length).toBe(0);
  });
});
