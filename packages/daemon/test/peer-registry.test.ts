/**
 * Pure peer-registry: takes "up" / "down" events (from mDNS in prod;
 * fed by hand in tests) and maintains a Map<id, Peer> snapshot the
 * /api/peers route serves. Bonjour can report the same service through
 * multiple interfaces, so dedup-by-id is the load-bearing logic to test.
 */

import { test, expect, describe } from "bun:test";
import { PeerRegistry } from "../src/peer-registry";

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

  test("dedupes the same peer reported on multiple interfaces (same id)", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.addPeer({ id: "p1", label: "alice", host: "fe80::1", port: 27787 });
    expect(r.peers()).toHaveLength(1);
  });

  test("the last seen host wins on dedupe (most recent is the freshest route)", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.99", port: 27787 });
    expect(r.peers()[0]?.host).toBe("10.0.0.99");
  });

  test("removePeer drops a peer by id", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.addPeer({ id: "p2", label: "bob", host: "10.0.0.6", port: 27787 });
    r.removePeer("p1");
    expect(r.peers().map((p) => p.id)).toEqual(["p2"]);
  });

  test("removePeer is a noop for unknown ids", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("ghost");
    expect(r.peers()).toHaveLength(1);
  });

  test("removePeer with graceMs keeps the peer visible until the timer fires", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", { graceMs: 30 });
    // Peer still present immediately after a soft remove.
    expect(r.peers()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.peers()).toHaveLength(0);
  });

  test("an addPeer during the grace window cancels the pending removal", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", { graceMs: 50 });
    // Hiccup: bonjour fired 'down' then 'up' for the same peer.
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(r.peers()).toHaveLength(1);
  });

  test("repeated removePeer calls during the grace window don't reset the timer", async () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "p1", label: "alice", host: "10.0.0.5", port: 27787 });
    r.removePeer("p1", { graceMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Second 'down' before the timer fires — should NOT push the
    // removal deadline further out.
    r.removePeer("p1", { graceMs: 30 });
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

  test("rejects entries missing required fields without throwing", () => {
    const r = new PeerRegistry({ selfId: "me" });
    r.addPeer({ id: "", label: "x", host: "h", port: 1 });
    r.addPeer({ id: "p1", label: "x", host: "", port: 1 });
    r.addPeer({ id: "p2", label: "", host: "h", port: 1 });
    r.addPeer({ id: "p3", label: "x", host: "h", port: 0 });
    expect(r.peers()).toEqual([]);
  });
});
