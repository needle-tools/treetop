import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  subscribeErrors,
  pushError,
  setErrors,
  clearErrorsLocal,
  recordBrowserError,
  recordBrowserDiagnostic,
  installFetchTracking,
  installBrowserResponsivenessTracking,
  eventLoopStallDiagnostic,
  getErrors,
  __resetFetchTrackingForTests,
  __resetBrowserResponsivenessTrackingForTests,
  describeWsClose,
  terminalWsCloseRepresentsExit,
  __flushErrorPostsForTests,
  __resetErrorPostsForTests,
  type FrontendErrorEntry,
} from "../src/errors";
import { record as recordTiming, reset as resetTimings } from "../src/timings";

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

describe("describeWsClose", () => {
  test("maps 'terminal not found' to an actionable resume hint", () => {
    const msg = describeWsClose(1011, "terminal not found");
    expect(msg).toContain("exited before the connection attached");
    expect(msg).toContain("Retry");
  });

  test("folds a known exit code into the resume hint", () => {
    const msg = describeWsClose(1011, "terminal exited code 1");
    expect(msg).toContain("(code 1)");
    expect(msg).toContain("exited before the connection attached");
    expect(msg).toContain("Retry");
  });

  test("folds a known exit signal into the resume hint", () => {
    const msg = describeWsClose(1011, "terminal exited signal SIGKILL");
    expect(msg).toContain("(signal SIGKILL)");
  });

  test("surfaces a remote tunnel failure reason verbatim", () => {
    const msg = describeWsClose(1011, "tunnel failed: connection refused");
    expect(msg).toContain("Remote daemon unreachable");
    expect(msg).toContain("connection refused");
  });

  test("explains a remote ws error", () => {
    expect(describeWsClose(1011, "remote ws error")).toContain(
      "remote daemon dropped",
    );
  });

  test("passes through any other daemon-supplied reason with its code", () => {
    const msg = describeWsClose(4001, "some custom reason");
    expect(msg).toContain("some custom reason");
    expect(msg).toContain("4001");
  });

  test("explains an abnormal 1006 close with no reason", () => {
    const msg = describeWsClose(1006, "");
    expect(msg).toContain("1006");
    expect(msg).toContain("daemon may have restarted");
  });

  test("falls back to the bare code when nothing else is known", () => {
    expect(describeWsClose(1005)).toBe("WebSocket closed (code 1005).");
    expect(describeWsClose(0)).toContain("unknown");
  });
});

describe("terminal websocket close lifecycle", () => {
  test("clean transport close is not a terminal exit without an exit frame", () => {
    expect(terminalWsCloseRepresentsExit({ sawExitFrame: false })).toBe(false);
  });

  test("daemon exit frame is the terminal-exit authority", () => {
    expect(terminalWsCloseRepresentsExit({ sawExitFrame: true })).toBe(true);
  });
});

describe("frontend errors store", () => {
  beforeEach(() => {
    clearErrorsLocal();
    resetTimings();
    __resetErrorPostsForTests();
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

  test("recordBrowserDiagnostic records browser diagnostics with structured extra", () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    try {
      const e = recordBrowserDiagnostic("terminal-startup ws-open trace=t1", {
        traceId: "t1",
        elapsedMs: 12,
      });
      expect(e.kind).toBe("diagnostic");
      expect(e.source).toBe("browser");
      expect(e.message).toBe("terminal-startup ws-open trace=t1");
      expect(e.extra).toEqual({ traceId: "t1", elapsedMs: 12 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("persists browser errors in one batched POST", async () => {
    const origFetch = globalThis.fetch;
    const posted: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      __resetFetchTrackingForTests();
      installFetchTracking();
      recordBrowserError({
        kind: "fetch",
        source: "browser",
        message: "GET /api/a -> slow",
        route: "/api/a",
        method: "GET",
      });
      recordBrowserDiagnostic("browser-event-loop-stall driftMs=3000", {
        driftMs: 3000,
      });
      await __flushErrorPostsForTests();
      expect(posted.length).toBe(1);
      expect(Array.isArray(posted[0])).toBe(true);
      expect((posted[0] as FrontendErrorEntry[]).map((e) => e.message)).toEqual(
        ["GET /api/a -> slow", "browser-event-loop-stall driftMs=3000"],
      );
    } finally {
      globalThis.fetch = origFetch;
      __resetFetchTrackingForTests();
      __resetErrorPostsForTests();
    }
  });

  test("serializes persisted browser errors while a POST is in flight", async () => {
    const origFetch = globalThis.fetch;
    const posted: unknown[] = [];
    let releaseFirst!: () => void;
    const firstPostGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstPostStarted!: () => void;
    const firstPostStartedPromise = new Promise<void>((resolve) => {
      firstPostStarted = resolve;
    });
    let postCount = 0;
    globalThis.fetch = (async (_input, init) => {
      postCount++;
      posted.push(JSON.parse(String(init?.body)));
      if (postCount === 1) {
        firstPostStarted();
        await firstPostGate;
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      __resetFetchTrackingForTests();
      installFetchTracking();
      recordBrowserError({
        kind: "fetch",
        source: "browser",
        message: "GET /api/a -> slow",
        route: "/api/a",
        method: "GET",
      });
      const firstFlush = __flushErrorPostsForTests();
      await firstPostStartedPromise;

      recordBrowserDiagnostic("browser-event-loop-stall driftMs=3000", {
        driftMs: 3000,
      });
      const secondFlush = __flushErrorPostsForTests();
      await Promise.resolve();

      expect(postCount).toBe(1);
      releaseFirst();
      await Promise.all([firstFlush, secondFlush]);
      expect(postCount).toBe(2);
      expect(
        posted.flatMap((body) =>
          Array.isArray(body)
            ? body.map((entry: FrontendErrorEntry) => entry.message)
            : [(body as FrontendErrorEntry).message],
        ),
      ).toEqual([
        "GET /api/a -> slow",
        "browser-event-loop-stall driftMs=3000",
      ]);
    } finally {
      globalThis.fetch = origFetch;
      __resetFetchTrackingForTests();
      __resetErrorPostsForTests();
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
    __resetErrorPostsForTests();
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

  test("skips recording expected /api/processes timeout aborts", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    installFetchTracking();

    await expect(fetch("/api/processes")).rejects.toThrow(
      "The operation was aborted.",
    );
    expect(getErrors().length).toBe(0);
  });

  test("records slow successful API mutations with structured timing", async () => {
    let now = 1_000;
    const savedNow = globalThis.performance.now;
    Object.defineProperty(globalThis.performance, "now", {
      configurable: true,
      value: () => now,
    });
    globalThis.fetch = (async () => {
      now = 1_375;
      return new Response("", { status: 200, statusText: "OK" });
    }) as typeof fetch;
    try {
      installFetchTracking();
      const res = await fetch("/api/notes", { method: "POST" });
      expect(res.status).toBe(200);
      const entry = getErrors()[0];
      expect(entry?.kind).toBe("diagnostic");
      expect(entry?.message).toBe(
        "api-fetch POST /api/notes fetchMs=375 status=200",
      );
      expect(entry?.route).toBe("/api/notes");
      expect(entry?.method).toBe("POST");
      expect(entry?.status).toBe(200);
      expect(entry?.extra).toMatchObject({
        route: "/api/notes",
        apiPath: "/api/notes",
        method: "POST",
        status: 200,
        fetchMs: 375,
        inFlightAtStart: 1,
        inFlightAtEnd: 1,
      });
    } finally {
      Object.defineProperty(globalThis.performance, "now", {
        configurable: true,
        value: savedNow,
      });
    }
  });

  test("does not record fast successful API GETs", async () => {
    let now = 2_000;
    const savedNow = globalThis.performance.now;
    Object.defineProperty(globalThis.performance, "now", {
      configurable: true,
      value: () => now,
    });
    globalThis.fetch = (async () => {
      now = 2_050;
      return new Response("", { status: 200, statusText: "OK" });
    }) as typeof fetch;
    try {
      installFetchTracking();
      const res = await fetch("/api/events");
      expect(res.status).toBe(200);
      expect(getErrors().length).toBe(0);
    } finally {
      Object.defineProperty(globalThis.performance, "now", {
        configurable: true,
        value: savedNow,
      });
    }
  });

  test("event-loop stall diagnostics include active API fetch routes", async () => {
    let now = 1_000;
    const savedNow = globalThis.performance.now;
    Object.defineProperty(globalThis.performance, "now", {
      configurable: true,
      value: () => now,
    });
    let resolveFetch:
      | ((value: Response | PromiseLike<Response>) => void)
      | null = null;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch;
    try {
      installFetchTracking();
      const pending = fetch("/api/events");
      now = 3_500;

      const diagnostic = eventLoopStallDiagnostic({
        expectedAtMs: 1_000,
        observedAtMs: 3_500,
        lastRecordedAtMs: -Infinity,
      });

      expect(diagnostic?.extra).toMatchObject({
        driftMs: 2500,
        inFlightFetches: 1,
        activeFetches: [
          {
            method: "GET",
            route: "/api/events",
            apiPath: "/api/events",
            ageMs: 2500,
          },
        ],
      });

      resolveFetch?.(new Response("", { status: 200, statusText: "OK" }));
      await pending;
    } finally {
      Object.defineProperty(globalThis.performance, "now", {
        configurable: true,
        value: savedNow,
      });
    }
  });
});

describe("installBrowserResponsivenessTracking", () => {
  let savedPerformanceObserver: unknown;

  beforeEach(() => {
    clearErrorsLocal();
    resetTimings();
    __resetBrowserResponsivenessTrackingForTests();
    savedPerformanceObserver = globalThis.PerformanceObserver;
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & { PerformanceObserver?: unknown }
    ).PerformanceObserver = savedPerformanceObserver;
    __resetBrowserResponsivenessTrackingForTests();
  });

  test("records browser long tasks as diagnostics", () => {
    let callback:
      | ((list: {
          getEntries: () => Array<{
            duration: number;
            startTime: number;
            name?: string;
          }>;
        }) => void)
      | null = null;
    class FakePerformanceObserver {
      static supportedEntryTypes = ["longtask"];
      constructor(cb: NonNullable<typeof callback>) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    (
      globalThis as typeof globalThis & { PerformanceObserver?: unknown }
    ).PerformanceObserver = FakePerformanceObserver;

    installBrowserResponsivenessTracking();
    callback?.({
      getEntries: () => [{ duration: 1_234.4, startTime: 55.2, name: "self" }],
    });

    const entry = getErrors()[0];
    expect(entry?.kind).toBe("diagnostic");
    expect(entry?.message).toBe("browser-longtask durationMs=1234");
    expect(entry?.extra).toMatchObject({
      durationMs: 1234,
      startTimeMs: 55,
      name: "self",
      inFlightFetches: 0,
    });
  });

  test("long task diagnostics include nearby completed API fetches", async () => {
    let now = 100;
    const savedNow = globalThis.performance.now;
    Object.defineProperty(globalThis.performance, "now", {
      configurable: true,
      value: () => now,
    });
    let callback:
      | ((list: {
          getEntries: () => Array<{
            duration: number;
            startTime: number;
            name?: string;
          }>;
        }) => void)
      | null = null;
    class FakePerformanceObserver {
      static supportedEntryTypes = ["longtask"];
      constructor(cb: NonNullable<typeof callback>) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    const savedFetch = globalThis.fetch;
    (
      globalThis as typeof globalThis & { PerformanceObserver?: unknown }
    ).PerformanceObserver = FakePerformanceObserver;
    globalThis.fetch = (async () => {
      now = 150;
      return new Response("{}", { status: 200, statusText: "OK" });
    }) as typeof fetch;

    try {
      installFetchTracking();
      installBrowserResponsivenessTracking();
      await fetch("/api/sessions/batch", { method: "POST", body: "{}" });
      callback?.({
        getEntries: () => [{ duration: 300, startTime: 160, name: "self" }],
      });

      expect(getErrors()[0]?.extra?.recentApiFetches).toMatchObject([
        {
          method: "POST",
          apiPath: "/api/sessions/batch",
          status: 200,
          fetchMs: 50,
        },
      ]);
    } finally {
      globalThis.fetch = savedFetch;
      Object.defineProperty(globalThis.performance, "now", {
        configurable: true,
        value: savedNow,
      });
    }
  });

  test("builds event-loop stall diagnostics with cooldown gating", () => {
    expect(
      eventLoopStallDiagnostic({
        expectedAtMs: 1_000,
        observedAtMs: 2_500,
        lastRecordedAtMs: -Infinity,
      }),
    ).toBeNull();

    const first = eventLoopStallDiagnostic({
      expectedAtMs: 1_000,
      observedAtMs: 3_250,
      lastRecordedAtMs: -Infinity,
    });
    expect(first?.message).toBe("browser-event-loop-stall driftMs=2250");
    expect(first?.extra).toMatchObject({
      driftMs: 2250,
      expectedAtMs: 1000,
      observedAtMs: 3250,
    });

    expect(
      eventLoopStallDiagnostic({
        expectedAtMs: 4_000,
        observedAtMs: 7_500,
        lastRecordedAtMs: 3_250,
      }),
    ).toBeNull();
  });

  test("includes recent slow UI timing samples in stall diagnostics", () => {
    recordTiming("load.repo-upsert", 24);
    recordTiming("dockEntries", 41);

    const diagnostic = eventLoopStallDiagnostic({
      expectedAtMs: 1_000,
      observedAtMs: 3_500,
      lastRecordedAtMs: -Infinity,
    });

    expect(diagnostic?.extra.recentUiTimings).toMatchObject([
      { name: "dockEntries", ms: 41 },
      { name: "load.repo-upsert", ms: 24 },
    ]);
  });
});
