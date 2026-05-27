import { test, expect, describe } from "bun:test";
import { OrphanCleaner } from "../src/orphan-cleanup";

describe("OrphanCleaner", () => {
  test("does not fire when frontends are connected", async () => {
    let killed = false;
    const cleaner = new OrphanCleaner({
      orphanTimeoutMs: 100,
      killGraceMs: 50,
      getTerminals: () => [{ id: "t1", pid: 1, isAlive: true }],
      killTerminal: async () => { killed = true; },
      log: () => {},
    });

    cleaner.onFrontendConnected();
    await new Promise((r) => setTimeout(r, 200));
    expect(killed).toBe(false);
    cleaner.dispose();
  });

  test("fires after timeout when no frontends connected", async () => {
    const killed: string[] = [];
    const cleaner = new OrphanCleaner({
      orphanTimeoutMs: 100,
      killGraceMs: 50,
      getTerminals: () => [
        { id: "t1", pid: 111, isAlive: true },
        { id: "t2", pid: 222, isAlive: true },
      ],
      killTerminal: async (id) => { killed.push(id); },
      log: (msg) => console.log(`  [test] ${msg}`),
    });

    cleaner.onFrontendDisconnected();
    await new Promise((r) => setTimeout(r, 300));
    expect(killed).toContain("t1");
    expect(killed).toContain("t2");
    cleaner.dispose();
  });

  test("cancels cleanup when frontend reconnects before timeout", async () => {
    let killed = false;
    const cleaner = new OrphanCleaner({
      orphanTimeoutMs: 200,
      killGraceMs: 50,
      getTerminals: () => [{ id: "t1", pid: 1, isAlive: true }],
      killTerminal: async () => { killed = true; },
      log: () => {},
    });

    cleaner.onFrontendDisconnected();
    await new Promise((r) => setTimeout(r, 50));
    cleaner.onFrontendConnected();
    await new Promise((r) => setTimeout(r, 300));
    expect(killed).toBe(false);
    cleaner.dispose();
  });

  test("skips already-dead terminals", async () => {
    const killed: string[] = [];
    const cleaner = new OrphanCleaner({
      orphanTimeoutMs: 100,
      killGraceMs: 50,
      getTerminals: () => [
        { id: "t1", pid: 111, isAlive: false },
        { id: "t2", pid: 222, isAlive: true },
      ],
      killTerminal: async (id) => { killed.push(id); },
      log: () => {},
    });

    cleaner.onFrontendDisconnected();
    await new Promise((r) => setTimeout(r, 300));
    expect(killed).toEqual(["t2"]);
    cleaner.dispose();
  });

  test("logs every action", async () => {
    const logs: string[] = [];
    const cleaner = new OrphanCleaner({
      orphanTimeoutMs: 100,
      killGraceMs: 50,
      getTerminals: () => [{ id: "t1", pid: 999, isAlive: true }],
      killTerminal: async () => {},
      log: (msg) => logs.push(msg),
    });

    cleaner.onFrontendDisconnected();
    await new Promise((r) => setTimeout(r, 300));
    expect(logs.some((l) => l.includes("no frontend"))).toBe(true);
    expect(logs.some((l) => l.includes("t1"))).toBe(true);
    expect(logs.some((l) => l.includes("999"))).toBe(true);
    cleaner.dispose();
  });

  test("refcount: multiple connects need multiple disconnects", async () => {
    let killed = false;
    const cleaner = new OrphanCleaner({
      orphanTimeoutMs: 100,
      killGraceMs: 50,
      getTerminals: () => [{ id: "t1", pid: 1, isAlive: true }],
      killTerminal: async () => { killed = true; },
      log: () => {},
    });

    cleaner.onFrontendConnected();
    cleaner.onFrontendConnected();
    cleaner.onFrontendDisconnected();
    // Still one frontend connected
    await new Promise((r) => setTimeout(r, 200));
    expect(killed).toBe(false);

    cleaner.onFrontendDisconnected();
    // Now zero
    await new Promise((r) => setTimeout(r, 200));
    expect(killed).toBe(true);
    cleaner.dispose();
  });
});
