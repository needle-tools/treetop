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
  const calls: {
    url: string;
    method: string;
    body?: unknown;
    init?: RequestInit;
  }[] = [];
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
  test("does not overlap poll cycles when ticks fire while a request is in flight", async () => {
    let resolveBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch")) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              await batchGate;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    results: [
                      { source: "A", status: 200, etag: "a1", body: '{"v":1}' },
                    ],
                  }),
                ),
              );
              controller.close();
            },
          }),
        );
      }
      if (url.includes("/api/active-sends")) {
        return jsonResponse([], { etag: "rev-0-all" });
      }
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const got: string[] = [];
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: (body) => got.push(body),
      onInflight: noop,
    });

    const first = poller.tick();
    const second = poller.tick();
    await Promise.resolve();

    expect(
      calls.filter((c) => c.url.includes("/api/sessions/batch")),
    ).toHaveLength(1);
    expect(
      calls.filter((c) => c.url.includes("/api/active-sends")),
    ).toHaveLength(0);

    resolveBatch();
    await Promise.all([first, second]);

    expect(
      calls.filter((c) => c.url.includes("/api/sessions/batch")),
    ).toHaveLength(2);
    expect(
      calls.filter((c) => c.url.includes("/api/active-sends")),
    ).toHaveLength(2);
    expect(got).toEqual(['{"v":1}']);
  });

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

  test("sends a per-column requested message window for visual scroll-back", async () => {
    let minMessages = 100;
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch"))
        return jsonResponse({
          results: [
            {
              source: "A",
              status: 200,
              etag: "a1",
              body: '{"messages":[]}',
              messageHashes: [],
            },
          ],
        });
      if (url.includes("/api/active-sends"))
        return jsonResponse([], { etag: "rev-0-all" });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      getMinMessages: () => minMessages,
      onSession: noop,
      onInflight: noop,
    });

    await poller.tick();
    minMessages = 300;
    await poller.tick();

    const batches = calls.filter((c) => c.url.includes("/api/sessions/batch"));
    expect(JSON.parse(batches[0]!.body as string).sources[0]).toMatchObject({
      source: "A",
      minMessages: 100,
    });
    expect(JSON.parse(batches[1]!.body as string).sources[0]).toMatchObject({
      source: "A",
      etag: "a1",
      minMessages: 300,
    });
  });

  test("dispatches a session body only when it changes, and forwards the etag next tick", async () => {
    let phase = 0;
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch")) {
        phase++;
        if (phase === 1)
          return jsonResponse({
            results: [
              { source: "A", status: 200, etag: "a1", body: '{"v":1}' },
            ],
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

  test("reuses cached session bodies and etags when a column remounts", async () => {
    let phase = 0;
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch")) {
        phase++;
        if (phase === 1) {
          return jsonResponse({
            results: [
              { source: "A", status: 200, etag: "a1", body: '{"v":1}' },
            ],
          });
        }
        return jsonResponse({
          results: [{ source: "A", status: 304, etag: "a1" }],
        });
      }
      if (url.includes("/api/active-sends"))
        return jsonResponse([], { etag: "rev-0-all" });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const first: string[] = [];
    const unmount = poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: (body) => first.push(body),
      onInflight: noop,
    });

    await poller.tick();
    unmount();

    const remount: string[] = [];
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: (body) => remount.push(body),
      onInflight: noop,
    });
    await Promise.resolve();
    await poller.tick();

    expect(first).toEqual(['{"v":1}']);
    expect(remount).toEqual(['{"v":1}']);
    const batches = calls.filter((c) => c.url.includes("/api/sessions/batch"));
    expect(JSON.parse(batches[1]!.body as string).sources).toEqual([
      { source: "A", etag: "a1" },
    ]);
  });

  test("sends message hashes and dispatches daemon tail patches without full-body callback", async () => {
    let phase = 0;
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch")) {
        phase++;
        if (phase === 1) {
          return jsonResponse({
            results: [
              {
                source: "A",
                status: 200,
                etag: "a1",
                body: '{"agent":"claude","messages":[{"role":"user","blocks":[{"type":"text","text":"first"}]}]}',
                messageHashes: ["h-first"],
              },
            ],
          });
        }
        return jsonResponse({
          results: [
            {
              source: "A",
              status: 206,
              etag: "a2",
              session: { agent: "claude" },
              patch: {
                oldStart: 0,
                oldEnd: 1,
                messages: [
                  {
                    role: "assistant",
                    blocks: [{ type: "text", text: "second" }],
                  },
                ],
              },
              messageHashes: ["h-first", "h-second"],
            },
          ],
        });
      }
      if (url.includes("/api/active-sends"))
        return jsonResponse([], { etag: "rev-0-all" });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const bodies: string[] = [];
    const patches: unknown[] = [];
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: (body) => bodies.push(body),
      onSessionPatch: (patch) => patches.push(patch),
      onInflight: noop,
    });

    await poller.tick();
    await poller.tick();

    expect(bodies).toHaveLength(1);
    expect(patches).toEqual([
      {
        session: { agent: "claude" },
        patch: {
          oldStart: 0,
          oldEnd: 1,
          messages: [
            { role: "assistant", blocks: [{ type: "text", text: "second" }] },
          ],
        },
      },
    ]);
    const batches = calls.filter((c) => c.url.includes("/api/sessions/batch"));
    expect(JSON.parse(batches[1]!.body as string).sources[0]).toMatchObject({
      source: "A",
      etag: "a1",
      messageCursor: [{ index: 0, hash: "h-first" }],
    });
  });

  test("falls back to synthesizing a patched body for non-patch-aware registrations", async () => {
    let phase = 0;
    const { fn } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch")) {
        phase++;
        if (phase === 1) {
          return jsonResponse({
            results: [
              {
                source: "A",
                status: 200,
                etag: "a1",
                body: '{"agent":"claude","messages":[{"role":"user","blocks":[{"type":"text","text":"first"}]}]}',
                messageHashes: ["h-first"],
              },
            ],
          });
        }
        return jsonResponse({
          results: [
            {
              source: "A",
              status: 206,
              etag: "a2",
              session: { agent: "claude", cwd: "/repo" },
              patch: {
                oldStart: 0,
                oldEnd: 1,
                messages: [
                  {
                    role: "assistant",
                    blocks: [{ type: "text", text: "second" }],
                  },
                ],
              },
              messageHashes: ["h-first", "h-second"],
            },
          ],
        });
      }
      if (url.includes("/api/active-sends"))
        return jsonResponse([], { etag: "rev-0-all" });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const bodies: string[] = [];
    poller.register({
      source: "A",
      getSessionId: () => undefined,
      onSession: (body) => bodies.push(body),
      onInflight: noop,
    });

    await poller.tick();
    await poller.tick();

    expect(bodies.map((body) => JSON.parse(body))).toEqual([
      {
        agent: "claude",
        messages: [{ role: "user", blocks: [{ type: "text", text: "first" }] }],
      },
      {
        agent: "claude",
        cwd: "/repo",
        messages: [
          { role: "user", blocks: [{ type: "text", text: "first" }] },
          { role: "assistant", blocks: [{ type: "text", text: "second" }] },
        ],
      },
    ]);
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
        const inm = (init?.headers as Record<string, string>)?.[
          "If-None-Match"
        ];
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
    expect(
      JSON.parse(batch.body as string).sources.map(
        (s: { source: string }) => s.source,
      ),
    ).toEqual(["B"]);
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

  test("hundreds of open session panes still produce one batch and one active-sends request", async () => {
    const openCount = 200;
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch"))
        return jsonResponse({
          results: Array.from({ length: openCount }, (_, index) => ({
            source: `session-${index}`,
            status: 304,
            etag: `etag-${index}`,
          })),
        });
      if (url.includes("/api/active-sends"))
        return jsonResponse(
          Array.from({ length: 50 }, (_, index) => ({
            id: `send-${index}`,
            sessionId: `sid-${index * 2}`,
          })),
          { etag: "rev-hundreds" },
        );
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    let sessionDispatches = 0;
    let inflightDispatches = 0;
    for (let index = 0; index < openCount; index += 1) {
      poller.register({
        source: `session-${index}`,
        getSessionId: () => `sid-${index}`,
        onSession: () => {
          sessionDispatches += 1;
        },
        onInflight: () => {
          inflightDispatches += 1;
        },
      });
    }

    await poller.tick();
    await poller.tick();

    const batchCalls = calls.filter((c) =>
      c.url.includes("/api/sessions/batch"),
    );
    const sendsCalls = calls.filter((c) => c.url.includes("/api/active-sends"));
    expect(batchCalls).toHaveLength(2);
    expect(sendsCalls).toHaveLength(2);
    expect(JSON.parse(batchCalls[0]!.body as string).sources).toHaveLength(
      openCount,
    );
    expect(sessionDispatches).toBe(0);
    expect(inflightDispatches).toBe(200);
  });

  test("can skip transcript body polling for live-streamed panes while active-sends stays live", async () => {
    const { fn, calls } = makeFetch((url) => {
      if (url.includes("/api/sessions/batch"))
        return jsonResponse({
          results: [{ source: "history", status: 304, etag: "h1" }],
        });
      if (url.includes("/api/active-sends"))
        return jsonResponse([{ id: "send-1", sessionId: "live-sid" }], {
          etag: "rev-live",
        });
      return jsonResponse({}, { status: 404 });
    });
    const poller = createSessionPoller({ fetchImpl: fn, isIdle: () => false });
    const liveInflight: string[][] = [];
    poller.register({
      source: "live",
      getSessionId: () => "live-sid",
      shouldPollSession: () => false,
      onSession: () => {
        throw new Error("live stream should not poll transcript bodies");
      },
      onInflight: (list) => liveInflight.push(list.map((item) => item.id)),
    });
    poller.register({
      source: "history",
      getSessionId: () => "history-sid",
      onSession: noop,
      onInflight: noop,
    });

    await poller.tick();

    const batch = calls.find((call) =>
      call.url.includes("/api/sessions/batch"),
    );
    expect(JSON.parse(batch!.body as string).sources).toEqual([
      { source: "history" },
    ]);
    expect(
      calls.filter((call) => call.url.includes("/api/active-sends")),
    ).toHaveLength(1);
    expect(liveInflight).toEqual([["send-1"]]);
  });
});
