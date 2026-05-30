import { test, expect, describe } from "bun:test";
import { apiUrl, apiWsUrl } from "../src/api";

/**
 * apiUrl()/apiWsUrl() route a daemon request to either the LOCAL daemon
 * (same-origin, unchanged) or a REMOTE daemon via the reverse proxy
 * (/api/daemons/<id>/…). The whole UI funnels its fetch/WS/SSE URLs
 * through these so a remote folder row reaches the right daemon.
 *
 * Critical invariant: with NO daemonId the output is byte-identical to the
 * input — so wrapping the existing ~153 call sites is a pure no-op for the
 * local case (the UI behaves exactly as before until a remote row is used).
 */
describe("apiUrl", () => {
  test("returns the path unchanged when there is no daemonId (local)", () => {
    expect(apiUrl("/api/repos")).toBe("/api/repos");
    expect(apiUrl("/api/diff?path=/x&all=1")).toBe("/api/diff?path=/x&all=1");
    expect(apiUrl("/api/open-default")).toBe("/api/open-default");
  });

  test("treats null/undefined daemonId as local", () => {
    expect(apiUrl("/api/repos", null)).toBe("/api/repos");
    expect(apiUrl("/api/repos", undefined)).toBe("/api/repos");
  });

  test("inserts /daemons/<id> after /api for a remote daemon", () => {
    expect(apiUrl("/api/repos", "hz")).toBe("/api/daemons/hz/repos");
    expect(apiUrl("/api/diff?path=/x", "hz")).toBe(
      "/api/daemons/hz/diff?path=/x",
    );
  });

  test("handles the bare /api root for a remote daemon", () => {
    expect(apiUrl("/api", "hz")).toBe("/api/daemons/hz");
  });

  test("only rewrites the leading /api, not later occurrences", () => {
    // A query value that happens to contain '/api' must be left alone.
    expect(apiUrl("/api/open?path=/api/foo", "hz")).toBe(
      "/api/daemons/hz/open?path=/api/foo",
    );
  });
});

describe("apiWsUrl", () => {
  const host = "localhost:7777";

  test("builds a same-origin ws URL when local", () => {
    expect(apiWsUrl("/api/terminals/t1/io", host, "ws:")).toBe(
      "ws://localhost:7777/api/terminals/t1/io",
    );
  });

  test("uses wss when the page is https", () => {
    expect(apiWsUrl("/api/terminals/t1/io", host, "wss:")).toBe(
      "wss://localhost:7777/api/terminals/t1/io",
    );
  });

  test("routes through the proxy for a remote daemon", () => {
    expect(apiWsUrl("/api/terminals/t1/io", host, "ws:", "hz")).toBe(
      "ws://localhost:7777/api/daemons/hz/terminals/t1/io",
    );
  });
});
