import { test, expect, describe } from "bun:test";
import { parseDaemonProxyPath, buildProxyTargetUrl } from "../src/daemon-proxy";

// Pure routing helpers for the reverse proxy (Phase 4b). The catch-all
// `/api/daemons/<id>/*` must split into the daemon id and the remainder
// path that gets forwarded to the remote daemon's own `/api/...` surface.
describe("parseDaemonProxyPath", () => {
  test("splits id and the forwarded remainder", () => {
    expect(parseDaemonProxyPath("/api/daemons/abc123/repos")).toEqual({
      id: "abc123",
      rest: "/repos",
    });
  });

  test("keeps nested remainder paths intact", () => {
    expect(
      parseDaemonProxyPath("/api/daemons/abc123/terminals/t9/io"),
    ).toEqual({ id: "abc123", rest: "/terminals/t9/io" });
  });

  test("bare /api/daemons/<id> forwards to root", () => {
    expect(parseDaemonProxyPath("/api/daemons/abc123")).toEqual({
      id: "abc123",
      rest: "/",
    });
  });

  test("trailing slash after id forwards to root", () => {
    expect(parseDaemonProxyPath("/api/daemons/abc123/")).toEqual({
      id: "abc123",
      rest: "/",
    });
  });

  test("returns null for the registry collection route itself", () => {
    // `/api/daemons` (list/add) is NOT a proxy path — it's handled by the
    // CRUD routes, so the catch-all must not swallow it.
    expect(parseDaemonProxyPath("/api/daemons")).toBeNull();
    expect(parseDaemonProxyPath("/api/daemons/")).toBeNull();
  });

  test("returns null for non-proxy paths", () => {
    expect(parseDaemonProxyPath("/api/repos")).toBeNull();
    expect(parseDaemonProxyPath("/api/daemonsX/abc")).toBeNull();
  });
});

describe("buildProxyTargetUrl", () => {
  test("targets the tunnel's local loopback port with the /api prefix", () => {
    expect(buildProxyTargetUrl(7801, "/repos", "")).toBe(
      "http://127.0.0.1:7801/api/repos",
    );
  });

  test("preserves the query string", () => {
    expect(buildProxyTargetUrl(7801, "/diff", "?path=/x&all=1")).toBe(
      "http://127.0.0.1:7801/api/diff?path=/x&all=1",
    );
  });

  test("root remainder maps to the remote /api root", () => {
    expect(buildProxyTargetUrl(7801, "/", "")).toBe(
      "http://127.0.0.1:7801/api/",
    );
  });
});
