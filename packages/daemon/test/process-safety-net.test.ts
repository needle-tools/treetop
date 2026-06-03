import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import { installCrashGuard } from "../src/process-safety-net";

/**
 * The daemon hosts every TUI (each PTY is a child of the daemon's helper).
 * If a stray unhandledRejection / uncaughtException reaches the default
 * handler, the daemon exits and EVERY hosted session dies with it (the
 * helper gets stdin-EOF and SIGTERMs all PTYs). So the daemon installs a
 * last-resort guard that LOGS and keeps running. These tests pin the
 * contract — logs the event, includes the cause, and never rethrows — using
 * a fake process emitter so we don't touch the real one.
 */
describe("installCrashGuard", () => {
  test("logs an unhandled rejection and does NOT rethrow", () => {
    const proc = new EventEmitter();
    const logs: string[] = [];
    installCrashGuard(proc, (l) => logs.push(l));

    // With a listener registered, emitting must not throw (the default
    // crash-the-process behaviour is suppressed).
    expect(() =>
      proc.emit("unhandledRejection", new Error("boom"), Promise.resolve()),
    ).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("unhandledRejection");
    expect(logs[0]).toContain("boom");
  });

  test("logs an uncaught exception with its stack", () => {
    const proc = new EventEmitter();
    const logs: string[] = [];
    installCrashGuard(proc, (l) => logs.push(l));

    proc.emit("uncaughtException", new Error("kaboom"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("uncaughtException");
    expect(logs[0]).toContain("kaboom");
  });

  test("formats non-Error reasons too (no throw on a string/undefined)", () => {
    const proc = new EventEmitter();
    const logs: string[] = [];
    installCrashGuard(proc, (l) => logs.push(l));

    proc.emit("unhandledRejection", "plain string reason");
    proc.emit("uncaughtException", undefined);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("plain string reason");
    expect(logs[1]).toContain("undefined");
  });

  test("a throwing logger can't take the process down (guard swallows it)", () => {
    const proc = new EventEmitter();
    installCrashGuard(proc, () => {
      throw new Error("logger blew up");
    });
    // The guard's whole point is resilience — even a broken log sink must
    // not turn into an unhandled throw on the emit path.
    expect(() => proc.emit("uncaughtException", new Error("x"))).not.toThrow();
  });
});
