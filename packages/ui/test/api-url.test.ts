import { test, expect, describe } from "bun:test";
import { apiUrl, apiWsUrl } from "../src/api";
import { shouldOpenHrefOutsideApp } from "../src/open-url";

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

describe("shouldOpenHrefOutsideApp", () => {
  const currentHref = "http://localhost:27787/workspace?repo=supergit";

  test("routes same-origin http links outside the app shell", () => {
    expect(
      shouldOpenHrefOutsideApp(
        "http://localhost:27787/api/attachments/img.png",
        currentHref,
      ),
    ).toBe(true);
    expect(
      shouldOpenHrefOutsideApp("/api/attachments/img.png", currentHref),
    ).toBe(true);
  });

  test("routes external web and default-app links", () => {
    expect(shouldOpenHrefOutsideApp("https://example.com", currentHref)).toBe(
      true,
    );
    expect(
      shouldOpenHrefOutsideApp("mailto:test@example.com", currentHref),
    ).toBe(true);
    expect(
      shouldOpenHrefOutsideApp("file:///tmp/report.txt", currentHref),
    ).toBe(true);
  });

  test("does not route hash-only or unsafe/browser-owned protocols", () => {
    expect(shouldOpenHrefOutsideApp("#events", currentHref)).toBe(false);
    expect(shouldOpenHrefOutsideApp("javascript:alert(1)", currentHref)).toBe(
      false,
    );
    expect(shouldOpenHrefOutsideApp("data:text/plain,hello", currentHref)).toBe(
      false,
    );
    expect(
      shouldOpenHrefOutsideApp("blob:http://localhost:27787/id", currentHref),
    ).toBe(false);
  });
});
