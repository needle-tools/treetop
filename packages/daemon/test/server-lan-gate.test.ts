/**
 * Security characterization tests for the daemon's network-authorization
 * gate and anti DNS-rebinding Host check.
 *
 * Gate: loopback requests get the full API; remote (LAN) requests are
 * limited to the discovery / session-share *receiver* routes in
 * LAN_ALLOWED_ROUTES even when peer mode is on. The local control plane
 * (terminal spawn, command/run, open, file read/write, diff, ...) must
 * stay loopback-only ALWAYS so enabling session sharing can never expose
 * RCE or arbitrary file access to other machines on the network.
 *
 * Host check: every request is validated against the `Host` header so a
 * DNS-rebinding page (which arrives with its own domain as Host even on a
 * loopback connection) is rejected before any route runs.
 *
 * These assert on the server source string (like
 * server-characterization.test.ts) rather than importing server.ts,
 * which has top-level Bun.serve side effects.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_SRC = readFileSync(
  join(import.meta.dir, "../src/server.ts"),
  "utf-8",
);

// Pull out the `LAN_ALLOWED_ROUTES = new Set<string>([ ... ])` literal so
// we can assert exactly which "METHOD /path" routes are reachable over the
// network.
function lanAllowlistBlock(): string {
  const m = SERVER_SRC.match(
    /LAN_ALLOWED_ROUTES\s*=\s*new Set<string>\(\[([^\]]*)\]/,
  );
  expect(m, "LAN_ALLOWED_ROUTES Set literal not found").not.toBeNull();
  return m![1]!;
}

describe("daemon LAN authorization gate", () => {
  test("allowlist exposes only the discovery/share receiver routes over the LAN", () => {
    const block = lanAllowlistBlock();
    expect(block).toContain("POST /api/sessions/offer");
    expect(block).toContain("POST /api/messages/receive");
    expect(block).toContain("GET /api/identity");
    expect(block).toContain("GET /api/health");
  });

  test("dangerous control-plane routes are NOT in the LAN allowlist", () => {
    const block = lanAllowlistBlock();
    // RCE + arbitrary-file primitives flagged in the security review.
    expect(block).not.toContain("/api/terminals");
    expect(block).not.toContain("/api/command/run");
    expect(block).not.toContain("/api/open");
    expect(block).not.toContain("/api/files");
    expect(block).not.toContain("/api/config-fix");
    expect(block).not.toContain("/api/npm-scripts");
    expect(block).not.toContain("/api/image");
    expect(block).not.toContain("/api/diff");
  });

  test("the allowlist is method-aware (PATCH /api/identity is NOT allowed)", () => {
    const block = lanAllowlistBlock();
    // GET /api/identity is fine (liveness); PATCH would let a remote peer
    // rename this daemon, so it must not appear.
    expect(block).not.toContain("PATCH /api/identity");
  });

  test("remote requests are rejected when peer mode is off", () => {
    expect(SERVER_SRC).toContain('error: "peer mode is off"');
  });

  test("remote requests to non-allowlisted routes are rejected when peer mode is on", () => {
    // The gate keys on "METHOD /path", not the bare pathname.
    expect(SERVER_SRC).toContain(
      "LAN_ALLOWED_ROUTES.has(`${req.method} ${url.pathname}`)",
    );
    expect(SERVER_SRC).toContain("route not available over the network");
  });

  test("the gate keys off a non-loopback (remote) check", () => {
    // The remote determination must use isLoopback so loopback keeps the
    // full API surface.
    expect(SERVER_SRC).toMatch(
      /const remote\s*=\s*addr\s*\?\s*!isLoopback\(addr\)/,
    );
  });
});

describe("daemon anti DNS-rebinding Host check", () => {
  function isAllowedHostBody(): string {
    const m = SERVER_SRC.match(/function isAllowedHost[\s\S]*?\n\}/);
    expect(m, "isAllowedHost function not found").not.toBeNull();
    return m![0]!;
  }

  test("every request is validated against the Host header before routing", () => {
    expect(SERVER_SRC).toContain('isAllowedHost(req.headers.get("Host"))');
    expect(SERVER_SRC).toContain('error: "host not allowed"');
  });

  test("loopback names and *.localhost are accepted", () => {
    const body = isAllowedHostBody();
    expect(body).toContain('host === "localhost"');
    expect(body).toContain('host.endsWith(".localhost")');
    expect(body).toContain('host === "127.0.0.1"');
  });

  test("IP literals are accepted so LAN-IP peer access keeps working", () => {
    const body = isAllowedHostBody();
    // IPv4 literal regex + IPv6 colon check.
    expect(body).toMatch(/\\d\{1,3\}.*\\\.\\d\{1,3\}/);
    expect(body).toContain('host.includes(":")');
  });

  test("a missing Host header is allowed (non-browser client, not a rebinding vector)", () => {
    const body = isAllowedHostBody();
    expect(body).toContain("if (!hostHeader) return true;");
  });

  test("the accept-list is seeded from ALLOWED_ORIGINS (so SUPERGIT_EXTRA_ORIGINS extends it)", () => {
    expect(SERVER_SRC).toMatch(/ALLOWED_HOSTS\s*=\s*new Set<string>\(/);
    expect(SERVER_SRC).toContain("[...ALLOWED_ORIGINS]");
    expect(SERVER_SRC).toContain("ALLOWED_HOSTS.has(host)");
  });
});
