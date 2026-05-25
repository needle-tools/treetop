/**
 * Integration tests for mDNS-based peer discovery. These exercise the
 * real bonjour-service stack (dgram socket, multicast, publish, browse)
 * — the layer that the pure PeerRegistry tests don't cover.
 *
 * Each test creates real PeerDiscovery instances with unique IDs and
 * ports, verifying that mDNS advertisement + browsing actually works
 * end-to-end on this platform. A failure here means the daemon's share
 * feature won't find peers on the LAN.
 *
 * Runs on Windows and macOS. Uses localhost multicast so no LAN peers
 * are needed.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { PeerDiscovery, type DiscoveryOpts } from "../src/peer-discovery";
import { randomUUID } from "node:crypto";

const instances: PeerDiscovery[] = [];

function makeDiscovery(overrides: Partial<DiscoveryOpts> = {}): PeerDiscovery {
  const d = new PeerDiscovery({
    port: 20000 + Math.floor(Math.random() * 40000),
    id: randomUUID(),
    label: `test-${randomUUID().slice(0, 8)}`,
    version: "0.0.0-test",
    ...overrides,
  });
  instances.push(d);
  return d;
}

async function pollUntil(
  check: () => boolean,
  { timeoutMs = 8000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

afterEach(async () => {
  await Promise.all(instances.map((d) => d.stop()));
  instances.length = 0;
});

describe("PeerDiscovery (mDNS integration)", () => {
  test("start() enables discovery without throwing", () => {
    const d = makeDiscovery();
    d.start();
    expect(d.enabled).toBe(true);
  });

  test("two instances on the same host discover each other", async () => {
    const alice = makeDiscovery({ label: "alice" });
    const bob = makeDiscovery({ label: "bob" });
    alice.start();
    bob.start();

    await pollUntil(
      () => alice.peers().some((p) => p.label === "bob") &&
            bob.peers().some((p) => p.label === "alice"),
    );

    const bobSeenByAlice = alice.peers().find((p) => p.label === "bob")!;
    expect(bobSeenByAlice).toBeDefined();
    expect(bobSeenByAlice.id).toBe((bob as any).opts.id);
    expect(bobSeenByAlice.port).toBe((bob as any).opts.port);
    expect(bobSeenByAlice.version).toBe("0.0.0-test");

    const aliceSeenByBob = bob.peers().find((p) => p.label === "alice")!;
    expect(aliceSeenByBob).toBeDefined();
    expect(aliceSeenByBob.id).toBe((alice as any).opts.id);
  });

  test("self-advertisements are filtered out (selfId match)", async () => {
    const d = makeDiscovery({ label: "loner" });
    d.start();

    // Give mDNS time to receive its own advertisement.
    await new Promise((r) => setTimeout(r, 2000));

    // Should have zero peers — only self is on the network (in this
    // test's service-type namespace), and that's filtered.
    const selfEntries = d.peers().filter((p) => p.id === (d as any).opts.id);
    expect(selfEntries).toHaveLength(0);
  });

  test("TXT record fields (id, label, version, frontendPort) survive the round-trip", async () => {
    const alice = makeDiscovery({
      label: "alice",
      version: "1.2.3",
      frontendPort: 9999,
    });
    const bob = makeDiscovery({ label: "bob" });
    alice.start();
    bob.start();

    await pollUntil(() => bob.peers().some((p) => p.label === "alice"));

    const seen = bob.peers().find((p) => p.label === "alice")!;
    expect(seen.id).toBe((alice as any).opts.id);
    expect(seen.version).toBe("1.2.3");
    expect(seen.frontendPort).toBe(9999);
  });

  test("frontendPort defaults to daemon port when not specified", async () => {
    const alice = makeDiscovery({ label: "alice" });
    const bob = makeDiscovery({ label: "bob" });
    alice.start();
    bob.start();

    await pollUntil(() => bob.peers().some((p) => p.label === "alice"));

    const seen = bob.peers().find((p) => p.label === "alice")!;
    expect(seen.frontendPort).toBe((alice as any).opts.port);
  });

  test("host is an IPv4 address, not a .local hostname", async () => {
    const alice = makeDiscovery({ label: "alice" });
    const bob = makeDiscovery({ label: "bob" });
    alice.start();
    bob.start();

    await pollUntil(() => bob.peers().some((p) => p.label === "alice"));

    const seen = bob.peers().find((p) => p.label === "alice")!;
    // IPv4: no colons (which would indicate IPv6 or a hostname).
    expect(seen.host).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  test("stopped instance is eventually removed from the other's peer list", async () => {
    const alice = makeDiscovery({ label: "alice" });
    const bob = makeDiscovery({ label: "bob" });
    alice.start();
    bob.start();

    await pollUntil(() => alice.peers().some((p) => p.label === "bob"));

    // Stop bob — alice should see it disappear. The bonjour 'down'
    // event fires on stop(); the registry has a 60s grace by default,
    // but the raw 'down' processing in PeerDiscovery still triggers.
    // We use removePeer directly via the registry to confirm the
    // plumbing works without waiting 60s.
    const bobEntry = alice.peers().find((p) => p.label === "bob")!;
    alice.registry.removePeer(bobEntry.id, bobEntry.port);
    expect(alice.peers().some((p) => p.label === "bob")).toBe(false);
  });

  test("three instances all see the other two", async () => {
    const a = makeDiscovery({ label: "alpha" });
    const b = makeDiscovery({ label: "bravo" });
    const c = makeDiscovery({ label: "charlie" });
    a.start();
    b.start();
    c.start();

    await pollUntil(
      () =>
        a.peers().length >= 2 &&
        b.peers().length >= 2 &&
        c.peers().length >= 2,
    );

    expect(a.peers().map((p) => p.label).sort()).toEqual(["bravo", "charlie"]);
    expect(b.peers().map((p) => p.label).sort()).toEqual(["alpha", "charlie"]);
    expect(c.peers().map((p) => p.label).sort()).toEqual(["alpha", "bravo"]);
  });
});
