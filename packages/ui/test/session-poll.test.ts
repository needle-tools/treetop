/**
 * The shared session poller (Lever 1, plans/performance.md "per-column
 * session-poll storm"): one timer + one batched request per daemon, replacing
 * each SessionView's own setInterval + fetch. These tests drive `tick()`
 * manually with an injected fetch so they assert the coalescing + dispatch
 * behaviour without real timers or network.
 */

import { test, expect, describe } from "bun:test";
import { createSessionPoller } from "../src/session-poll";

function jsonResponse(
  obj: unknown,
  { status = 200, etag }: { status?: number; etag?: string } = {},
): Response {
  const headers: Record<string, string> = {};
  if (etag) headers["ETag"] = etag;
  return new Response(status === 304 ? null : JSON.stringify(obj), {
    status,
    headers,
  });
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; method: string; body?: unknown; init?: RequestInit }[] =
    [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body,
      init,
    });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fn, calls };
}

const noop = () => {};

describe("createSessionPoller", () => {
  test("coalesces N same-daemon sources into ONE batch POST + ONE active-sends GET", async () => {
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch"))
        return jsonResponse({
          results: [
            { source: "A", status: 200, etag: "a1", body: '{"v":"a"}' },
            { source: "B", status: 200, etag: "b1", body: '{"v":"b"}' },
          ],
        });
      if (url.includes("/api/active-sends"))
        return jsonResponse([], { etag: "rev-0-all" });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const gotA: string[] = [];
    const gotB: string[] = [];
    poller.register({
      source: "A",
      getSessionId: () => "S1",
      onSession: (b) => gotA.push(b),
      onInflight: noop,
    });
    poller.register({
      source: "B",
      getSessionId: () => "S2",
      onSession: (b) => gotB.push(b),
      onInflight: noop,
    });

    await poller.tick();

    const batch = calls.filter((c) => c.url.includes("/api/sessions/batch"));
    const sends = calls.filter((c) => c.url.includes("/api/active-sends"));
    expect(batch).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(batch[0]!.method).toBe("POST");
    const sources = JSON.parse(batch[0]!.body as string).sources.map(
      (s: { source: string }) => s.source,
    );
    expect(sources.sort()).toEqual(["A", "B"]);
    expect(gotA).toEqual(['{"v":"a"}']);
    expect(gotB).toEqual(['{"v":"b"}']);
  });

  test("dispatches a session body only when it changes, and forwards the etag next tick", async () => {
    let phase = 0;
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch")) {
        phase++;
        if (phase === 1)
          return jsonResponse({
            results: [{ source: "A", status: 200, etag: "a1", body: '{"v":1}' }],
          });
        return jsonResponse({
          results: [{ source: "A", status: 304, etag: "a1" }],
        });
      }
      if (url.includes("/api/active-sends"))
        return jsonResponse([], { etag: "rev-0-all" });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const got: string[] = [];
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: (b) => got.push(b),
      onInflight: noop,
    });

    await poller.tick();
    await poller.tick();

    expect(got).toEqual(['{"v":1}']); // only the changed tick
    const batches = calls.filter((c) => c.url.includes("/api/sessions/batch"));
    expect(JSON.parse(batches[1]!.body as string).sources[0].etag).toBe("a1");
  });

  test("polls active-sends once and slices it per column by sessionId; dispatch on change only", async () => {
    const { fn } = makeFetch((url, init) => {
      if (url.includes("/api/sessions/batch"))
        return jsonResponse({
          results: [
            { source: "A", status: 304, etag: "a1" },
            { source: "B", status: 304, etag: "b1" },
          ],
        });
      if (url.includes("/api/active-sends")) {
        const etag = "rev-7-all";
        const inm = (init?.headers as Record<string, string>)?.["If-None-Match"];
        if (inm === etag) return jsonResponse(null, { status: 304, etag });
        return jsonResponse(
          [
            { id: "1", sessionId: "S1" },
            { id: "2", sessionId: "S2" },
          ],
          { etag },
        );
      }
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const aInf: { id: string }[][] = [];
    const bInf: { id: string }[][] = [];
    poller.register({
      source: "A",
      getSessionId: () => "S1",
      onSession: noop,
      onInflight: (l) => aInf.push(l as { id: string }[]),
    });
    poller.register({
      source: "B",
      getSessionId: () => "S2",
      onSession: noop,
      onInflight: (l) => bInf.push(l as { id: string }[]),
    });

    await poller.tick(); // 200 → list, dispatch
    await poller.tick(); // 304 → cached list, same slice, no dispatch

    expect(aInf).toHaveLength(1);
    expect(aInf[0]!.map((r) => r.id)).toEqual(["1"]);
    expect(bInf[0]!.map((r) => r.id)).toEqual(["2"]);
  });

  test("does no network when the UI is idle", async () => {
    const { fn, calls } = makeFetch(() => jsonResponse({ results: [] }));
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => true });
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: noop,
      onInflight: noop,
    });
    await poller.tick();
    expect(calls).toHaveLength(0);
  });

  test("unregister removes a source from later batches and stops the timer when empty", async () => {
    const { fn, calls } = makeFetch((url) =>
      url.includes("/api/sessions/batch")
        ? jsonResponse({ results: [] })
        : jsonResponse([], { etag: "r" }),
    );
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const un = poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: noop,
      onInflight: noop,
    });
    poller.register({
      source: "B",
      getSessionId: () => undefined,
      onSession: noop,
      onInflight: noop,
    });
    un();
    await poller.tick();
    const batch = calls.find((c) => c.url.includes("/api/sessions/batch"))!;
    expect(JSON.parse(batch.body as string).sources.map((s: { source: string }) => s.source)).toEqual(["B"]);
  });

  test("groups by daemonId — one batch per distinct daemon", async () => {
    const { fn, calls } = makeFetch((url) =>
      url.includes("/api/sessions/batch") || url.includes("batch")
        ? jsonResponse({ results: [] })
        : jsonResponse([], { etag: "r" }),
    );
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    poller.register({
      source: "A",
      daemonId: undefined,
      getSessionId: () => undefined,
      onSession: noop,
      onInflight: noop,
    });
    poller.register({
      source: "B",
      daemonId: "remote1",
      getSessionId: () => undefined,
      onSession: noop,
      onInflight: noop,
    });
    await poller.tick();
    const batchCalls = calls.filter((c) => c.url.includes("batch"));
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls.some((c) => c.url.includes("/api/daemons/remote1"))).toBe(
      true,
    );
  });
});
