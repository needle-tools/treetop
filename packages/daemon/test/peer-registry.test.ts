/**
 * Pure peer-registry: takes "up" / "down" events (from mDNS in prod;
 * fed by hand in tests) and maintains a Map<key, Peer> snapshot the
 * /api/peers route serves. Bonjour can report the same service through
 * multiple interfaces, so dedup-by-(id,port) is the load-bearing logic
 * to test — same id + same port = same daemon on a different route;
 * same id + different port = two daemons on the same host (e.g. dev
 * on 7777 + prod on 27787 sharing one workspace identity file).
 */

import { test, expect, describe } from "bun:test";
import { PeerRegistry, disambiguatePeerLabels } from "../src/peer-registry";

describe("PeerRegistry", () => {
  test("starts empty", () => {
    const r = new PeerRegistry({ selfId: "me" });
    expect(r.peers()).toEqual([]);
  });

  test("addPeer adds a peer", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    expect(r.peers()).toHaveLength(1);
    expect(r.peers()[0]?.label).toBe("alice");
  });

  test("ignores our own advertisement (selfId match)", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "me", label: "myself", host: "10.0.0.5", port: 27787 });
    expect(r.peers()).toEqual([]);
  });

  test("dedupes the same peer reported on multiple interfaces (same id, same port)", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.addPeer({ id: "p1", label: "alice", host: "fe80::1", port: 27787 });
    expect(r.peers()).toHaveLength(1);
  });

  test("two daemons on the same host (same id, different ports) coexist", () => {
    // Real symptom: a single workspace identity is loaded by both the
    // dev daemon (7777) and the prod daemon (27787) on the same box.
    // They advertise the same id; before the composite-key fix, the
    // receiver collapsed the two adverts into one entry and the user
    // could only ever see one of the daemons.
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 7777 });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    expect(r.peers()).toHaveLength(2);
    expect(r.peers().map((p) => p.port).sort((a, b) => a - b)).toEqual([7777, 27787]);
  });

  test("the last seen host wins on dedupe (most recent is the freshest route)", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.99", port: 27787 });
    expect(r.peers()[0]?.host).toBe("10.0.0.99");
  });

  test("removePeer drops a peer by (id, port)", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.addPeer({ id: "p2", label: "bob", host: "10.0.0.6", port: 27787 });
    r.removePeer("p1", 27787);
    expect(r.peers().map((p) => p.id)).toEqual(["p2"]);
  });

  test("removePeer only removes the matching port when an id has multiple ports", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 7777 });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", 7777);
    expect(r.peers()).toHaveLength(1);
    expect(r.peers()[0]?.port).toBe(27787);
  });

  test("removePeer is a noop for unknown (id, port) pairs", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("ghost", 27787);
    r.removePeer("p1", 1234);
    expect(r.peers()).toHaveLength(1);
  });

  test("removePeer with graceMs keeps the peer visible until the timer fires", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", 27787, { graceMs: 30 });
    // Peer still present immediately after a soft remove.
    expect(r.peers()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.peers()).toHaveLength(0);
  });

  test("an addPeer during the grace window cancels the pending removal", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", 27787, { graceMs: 50 });
    // Hiccup: bonjour fired 'down' then 'up' for the same peer.
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(r.peers()).toHaveLength(1);
  });

  test("grace-window removal for one port doesn't affect the sibling port", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 7777 });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", 7777, { graceMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Dev (7777) gone, prod (27787) still listed.
    expect(r.peers()).toHaveLength(1);
    expect(r.peers()[0]?.port).toBe(27787);
  });

  test("repeated removePeer calls during the grace window don't reset the timer", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", 27787, { graceMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Second 'down' before the timer fires — should NOT push the
    // removal deadline further out.
    r.removePeer("p1", 27787, { graceMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Original 30ms timer should have fired by now.
    expect(r.peers()).toHaveLength(0);
  });

  test("setSelfId can be called after construction (identity loads async at startup)", () => {
    const r = new PeerRegistry({ selfId: "" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    expect(r.peers()).toHaveLength(1);
    r.setSelfId("p1");
    expect(r.peers()).toEqual([]);
  });

  test("setSelfId nukes every advert with the same id (covers all ports we previously stored)", () => {
    // If the registry happens to have already stored sibling daemons
    // (dev + prod from the same host that turns out to be us, e.g.
    // because the bonjour browser fired before identity finished
    // loading), setSelfId must drop every one of them, not just the
    // first.
    const r = new PeerRegistry({ selfId: "" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 7777 });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    expect(r.peers()).toHaveLength(2);
    r.setSelfId("p1");
    expect(r.peers()).toEqual([]);
  });

  test("rejects entries missing required fields without throwing", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "", label: "x", host: "h", port: 1 });
    r.addPeer({ id: "p1", label: "x", host: "", port: 1 });
    r.addPeer({ id: "p2", label: "", host: "h", port: 1 });
    r.addPeer({ id: "p3", label: "x", host: "h", port: 0 });
    expect(r.peers()).toEqual([]);
  });
});

describe("disambiguatePeerLabels", () => {
  // Build a Peer-shaped object inline — `lastSeen` and `version`
  // aren't load-bearing for label logic.
  const peer = (overrides: {
    id: string;
    label: string;
    port?: number;
    frontendPort?: number;
  }) => ({
    id: overrides.id,
    label: overrides.label,
    host: "10.0.0.5",
    port: overrides.port ?? 7777,
    frontendPort: overrides.frontendPort ?? overrides.port ?? 7777,
    lastSeen: "2026-05-22T00:00:00.000Z",
  });

  test("leaves a unique label untouched", () => {
    const out = disambiguatePeerLabels([peer({ id: "a", label: "alice" })]);
    expect(out[0]?.label).toBe("alice");
  });

  test("suffixes :frontendPort when two peers share a label", () => {
    // Real bug: dev and prod on the same Windows box both advertise
    // "marcel@windows-pc". Without disambiguation the user can't tell
    // them apart in the Share dialog.
    const out = disambiguatePeerLabels([
      peer({ id: "p1", label: "marcel@win", port: 7777, frontendPort: 7779 }),
      peer({ id: "p1", label: "marcel@win", port: 27787 }),
    ]);
    expect(out.map((p) => p.label).sort()).toEqual([
      "marcel@win:27787",
      "marcel@win:7779",
    ]);
  });

  test("suffix logic uses the label, not the id (two real users with identical labels also collide)", () => {
    const out = disambiguatePeerLabels([
      peer({ id: "p1", label: "alice@laptop", port: 27787 }),
      peer({ id: "p2", label: "alice@laptop", port: 27787 }),
    ]);
    // Same frontendPort + same label → suffix still gets appended;
    // user can fall back to the host column to distinguish. Not
    // beautiful, but not worse than the pre-fix state.
    expect(out.every((p) => p.label.endsWith(":27787"))).toBe(true);
  });

  test("only the collision group is suffixed; unique peers stay clean", () => {
    const out = disambiguatePeerLabels([
      peer({ id: "p1", label: "marcel@win", port: 7777, frontendPort: 7779 }),
      peer({ id: "p1", label: "marcel@win", port: 27787 }),
      peer({ id: "p2", label: "bob@mac", port: 27787 }),
    ]);
    const labels = out.map((p) => p.label);
    expect(labels).toContain("marcel@win:7779");
    expect(labels).toContain("marcel@win:27787");
    expect(labels).toContain("bob@mac");
  });
});
