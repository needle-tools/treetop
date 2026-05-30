/**
 * Characterization tests for the daemon's network bind address.
 *
 * The bind address (the `hostname` passed to Bun.serve) is a kernel-level
 * filter on which interface connections may arrive on, enforced before any
 * route code runs:
 *   - "0.0.0.0"   — all interfaces; reachable from the LAN (needed for
 *                   session sharing, see plans/PLAN-SESSION-SHARE.md).
 *   - "127.0.0.1" — loopback only; the OS refuses non-local connections.
 *                   Correct posture for a tunnel-fronted remote daemon
 *                   (see plans/PLAN-REMOTE-DAEMON.md).
 *
 * It must be configurable via SUPERGIT_BIND, default to "0.0.0.0" (so
 * existing LAN session-sharing is unaffected), and Bun.serve must consume
 * the resolved value rather than a hard-coded literal.
 *
 * Like server-lan-gate.test.ts / server-characterization.test.ts, these
 * assert on the server source string rather than importing server.ts,
 * which has top-level Bun.serve side effects.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_SRC = readFileSync(
  join(import.meta.dir, "../src/server.ts"),
  "utf-8",
);

describe("daemon bind address", () => {
  test("BIND is resolved from SUPERGIT_BIND with a 0.0.0.0 default", () => {
    const m = SERVER_SRC.match(
      /const BIND\s*=\s*process\.env\.SUPERGIT_BIND\s*\|\|\s*"([^"]+)"/,
    );
    expect(m, "BIND resolution from SUPERGIT_BIND not found").not.toBeNull();
    // Default must stay 0.0.0.0 so LAN session-sharing keeps working when
    // no override is set — flipping the default to loopback would silently
    // break peer discovery / session offers.
    expect(m![1]).toBe("0.0.0.0");
  });

  test("Bun.serve binds to the resolved BIND, not a hard-coded literal", () => {
    // The hostname must reference BIND so SUPERGIT_BIND=127.0.0.1 actually
    // takes effect for tunnel-fronted deployments.
    expect(SERVER_SRC).toMatch(/hostname:\s*BIND\b/);
    // And the old hard-coded all-interfaces literal must be gone from the
    // serve config (it now lives only in the default + comments).
    expect(SERVER_SRC).not.toMatch(/hostname:\s*"0\.0\.0\.0"/);
  });
});
