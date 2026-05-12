import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  subscribeErrors,
  pushError,
  setErrors,
  clearErrorsLocal,
  recordBrowserError,
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
    setErrors([makeEntry({ id: "1" }), makeEntry({ id: "2" })]);
    // pushing the same id again should be a no-op
    pushError(makeEntry({ id: "1", message: "duplicate" }));
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last!.length).toBe(2);
    unsub();
  });

  test("clearErrorsLocal empties the list and notifies", () => {
    pushError(makeEntry());
    pushError(makeEntry());
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
    for (let i = 0; i < 250; i++) {
      pushError(makeEntry({ id: `i${i}`, message: `m${i}` }));
    }
    let last: FrontendErrorEntry[] | null = null;
    const unsub = subscribeErrors((es) => {
      last = es;
    });
    expect(last!.length).toBe(200);
    expect(last![0]?.message).toBe("m249");
    unsub();
  });
});
