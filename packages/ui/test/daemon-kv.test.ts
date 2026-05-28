/**
 * Tests for the daemon-backed KV store — the layer CLAUDE.md mandates for
 * all shared UI state (open sessions, note positions, folded rows, …).
 * The behaviours that matter:
 *
 *  - before init, getDaemonKV() degrades gracefully (no crash if the app
 *    reads a pref before initDaemonKV() resolved);
 *  - when the daemon has prefs, init seeds window.localStorage so the
 *    native app inherits browser layout, and reads come from the cache;
 *  - when the daemon is empty, init migrates the known localStorage keys
 *    up to the daemon via a PATCH;
 *  - writes are synchronous to the cache + localStorage and debounce a
 *    PATCH back to the daemon, deduping no-op writes.
 *
 * The module reaches for the globals `fetch` and `window.localStorage`,
 * so each test wires up an in-memory localStorage and a fetch stub, then
 * restores the globals afterwards.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { initDaemonKV, getDaemonKV } from "../src/daemon-kv";

const originalFetch = globalThis.fetch;

function memLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

/** Install a fetch stub: GET /api/prefs returns `prefs`; any PATCH is
 *  recorded and acked. Returns the call log. */
function stubFetch(prefs: Record<string, string>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    calls.push({
      url: String(url),
      method,
      body: opts?.body ? JSON.parse(opts.body as string) : undefined,
    });
    if (method === "GET") {
      return { ok: true, status: 200, json: async () => prefs };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { window?: unknown }).window;
});

describe("getDaemonKV before init", () => {
  test("returns a no-op store when window is undefined (never throws)", () => {
    // This test runs first, before any initDaemonKV() call, so the
    // module's singleton instance is still null.
    delete (globalThis as { window?: unknown }).window;
    const kv = getDaemonKV();
    expect(kv.getItem("supergit:foldedRows")).toBeNull();
    expect(() => kv.setItem("supergit:foldedRows", "[1]")).not.toThrow();
  });
});

describe("initDaemonKV — daemon has prefs (seed direction)", () => {
  let ls: ReturnType<typeof memLocalStorage>;

  beforeEach(() => {
    ls = memLocalStorage();
    (globalThis as { window?: unknown }).window = { localStorage: ls };
  });

  test("seeds window.localStorage from the daemon prefs", async () => {
    stubFetch({
      "supergit:foldedRows": "[1,2]",
      "supergit:notesHidden": "true",
    });
    await initDaemonKV();
    expect(ls.getItem("supergit:foldedRows")).toBe("[1,2]");
    expect(ls.getItem("supergit:notesHidden")).toBe("true");
  });

  test("reads served from the in-memory cache match the daemon prefs", async () => {
    stubFetch({ "supergit:foldedRows": "[1,2]" });
    await initDaemonKV();
    expect(getDaemonKV().getItem("supergit:foldedRows")).toBe("[1,2]");
  });

  test("does not fire a migration PATCH when the daemon already has data", async () => {
    const calls = stubFetch({ "supergit:foldedRows": "[1]" });
    await initDaemonKV();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("initDaemonKV — daemon empty (migrate direction)", () => {
  let ls: ReturnType<typeof memLocalStorage>;

  beforeEach(() => {
    ls = memLocalStorage();
    (globalThis as { window?: unknown }).window = { localStorage: ls };
  });

  test("PATCHes the known localStorage keys up to the daemon", async () => {
    ls.setItem("supergit:notesHidden", "true");
    ls.setItem("supergit:foldedRows", "[3]");
    ls.setItem("unrelated:key", "ignored"); // not in MIGRATED_KEYS
    const calls = stubFetch({}); // daemon empty
    await initDaemonKV();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.body).toEqual({
      "supergit:notesHidden": "true",
      "supergit:foldedRows": "[3]",
    });
    // The non-migrated key is left out of the patch.
    expect(
      (patch!.body as Record<string, string>)["unrelated:key"],
    ).toBeUndefined();
  });

  test("the migrated values are readable from the store immediately", async () => {
    ls.setItem("supergit:onboardingWalkthroughSeen", "1");
    stubFetch({});
    await initDaemonKV();
    expect(getDaemonKV().getItem("supergit:onboardingWalkthroughSeen")).toBe(
      "1",
    );
  });

  test("no PATCH when there is nothing local to migrate", async () => {
    const calls = stubFetch({});
    await initDaemonKV();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("DaemonKVStore writes", () => {
  let ls: ReturnType<typeof memLocalStorage>;

  beforeEach(() => {
    ls = memLocalStorage();
    (globalThis as { window?: unknown }).window = { localStorage: ls };
  });

  test("setItem updates the cache and window.localStorage synchronously", async () => {
    stubFetch({});
    await initDaemonKV();
    const kv = getDaemonKV();
    kv.setItem("supergit:foldedRows", "[9]");
    expect(kv.getItem("supergit:foldedRows")).toBe("[9]");
    expect(ls.getItem("supergit:foldedRows")).toBe("[9]");
    // Drain the debounced flush this write scheduled — the store is a
    // singleton, so a pending timer would otherwise fire into the next
    // test's fetch stub and look like a spurious PATCH.
    await new Promise((r) => setTimeout(r, 350));
  });

  test("a no-op write (same value) is ignored — no PATCH scheduled", async () => {
    const calls = stubFetch({ "supergit:foldedRows": "[1]" });
    await initDaemonKV();
    const before = calls.length;
    getDaemonKV().setItem("supergit:foldedRows", "[1]"); // identical
    await new Promise((r) => setTimeout(r, 350)); // past the 300ms debounce
    expect(calls.length).toBe(before); // no extra PATCH
  });

  test("a real write debounces a single PATCH carrying the change", async () => {
    const calls = stubFetch({});
    await initDaemonKV();
    const kv = getDaemonKV();
    kv.setItem("supergit:foldedRows", "[1]");
    kv.setItem("supergit:notesHidden", "true"); // coalesced into one flush
    await new Promise((r) => setTimeout(r, 350));

    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.length).toBe(1);
    expect(patches[0]!.body).toEqual({
      "supergit:foldedRows": "[1]",
      "supergit:notesHidden": "true",
    });
  });
});
