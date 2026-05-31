/**
 * The launcher pipes the daemon's stdout/stderr into a single
 * ~/.config/supergit/daemon.log that was never rotated — it grew without
 * bound. planLogRotation is the pure policy that turns it into one dated
 * file per calendar day and prunes to the newest N, so disk use is
 * capped at ~N days regardless of how chatty the daemon is. The fs glue
 * (readdir / unlink / open-append) lives in the launcher; this is the
 * decision it follows, kept pure so it's testable without touching disk.
 */

import { test, expect, describe } from "bun:test";
import { planLogRotation } from "../src/log-rotation";

describe("planLogRotation", () => {
  test("today's dated file is the active sink", () => {
    const { activeName } = planLogRotation([], "2026-05-31", 5);
    expect(activeName).toBe("daemon-2026-05-31.log");
  });

  test("nothing to delete when under the keep limit", () => {
    const existing = ["daemon-2026-05-29.log", "daemon-2026-05-30.log"];
    const plan = planLogRotation(existing, "2026-05-31", 5);
    expect(plan.deleteNames).toEqual([]);
  });

  test("prunes oldest, keeping the newest N including today", () => {
    const existing = [
      "daemon-2026-05-26.log",
      "daemon-2026-05-27.log",
      "daemon-2026-05-28.log",
      "daemon-2026-05-29.log",
      "daemon-2026-05-30.log",
    ];
    // today (05-31) is new → keep 31,30,29,28,27 ; delete 26.
    const plan = planLogRotation(existing, "2026-05-31", 5);
    expect(plan.activeName).toBe("daemon-2026-05-31.log");
    expect(plan.deleteNames).toEqual(["daemon-2026-05-26.log"]);
  });

  test("today's file already present (same-day restart) is not deleted", () => {
    const existing = [
      "daemon-2026-05-28.log",
      "daemon-2026-05-29.log",
      "daemon-2026-05-30.log",
      "daemon-2026-05-31.log",
    ];
    const plan = planLogRotation(existing, "2026-05-31", 2);
    // keep newest 2 incl today → 31, 30 ; delete 29, 28.
    expect(plan.deleteNames.sort()).toEqual([
      "daemon-2026-05-28.log",
      "daemon-2026-05-29.log",
    ]);
  });

  test("ignores unrelated files (legacy daemon.log, junk)", () => {
    const existing = [
      "daemon.log",
      "notes.txt",
      "daemon-2026-05-01.log",
      "daemon-2026-05-02.log",
      "daemon-2026-05-03.log",
    ];
    const plan = planLogRotation(existing, "2026-05-31", 2);
    // keep today + newest existing (05-03); delete 05-02, 05-01.
    expect(plan.deleteNames.sort()).toEqual([
      "daemon-2026-05-01.log",
      "daemon-2026-05-02.log",
    ]);
    // never touches non-matching files
    expect(plan.deleteNames).not.toContain("daemon.log");
    expect(plan.deleteNames).not.toContain("notes.txt");
  });
});
