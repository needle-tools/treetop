import { test, expect, describe } from "bun:test";
import {
  planWorktreeRecompute,
  type WorktreeRecomputeState,
} from "../src/worktree-refresh-plan";

const MIN = 2_500;
const idle: WorktreeRecomputeState = {
  lastRunAtMs: null,
  inFlight: false,
  hasPendingTrailing: false,
};

describe("planWorktreeRecompute", () => {
  test("runs immediately when never run before and idle", () => {
    expect(planWorktreeRecompute(idle, 1_000, MIN)).toEqual({ action: "run" });
  });

  test("runs immediately when the last run is older than the cooldown", () => {
    expect(
      planWorktreeRecompute(
        { lastRunAtMs: 0, inFlight: false, hasPendingTrailing: false },
        MIN + 1,
        MIN,
      ),
    ).toEqual({ action: "run" });
  });

  test("schedules a trailing run when the last run is within the cooldown", () => {
    // ran at 1000, now 2000, cooldown 2500 → 1500 left.
    expect(
      planWorktreeRecompute(
        { lastRunAtMs: 1_000, inFlight: false, hasPendingTrailing: false },
        2_000,
        MIN,
      ),
    ).toEqual({ action: "schedule-trailing", delayMs: 1_500 });
  });

  test("schedules a full-interval trailing run while one is in flight", () => {
    expect(
      planWorktreeRecompute(
        { lastRunAtMs: 1_000, inFlight: true, hasPendingTrailing: false },
        1_100,
        MIN,
      ),
    ).toEqual({ action: "schedule-trailing", delayMs: MIN });
  });

  test("coalesces: skips when a trailing run is already pending (chatty repo)", () => {
    // A dev server firing fs_change every 300ms must NOT enqueue a recompute
    // each time — once a trailing run is armed, further requests fold into it.
    const busy: WorktreeRecomputeState = {
      lastRunAtMs: 1_000,
      inFlight: false,
      hasPendingTrailing: true,
    };
    for (const now of [1_100, 1_400, 1_700, 2_000]) {
      expect(planWorktreeRecompute(busy, now, MIN)).toEqual({ action: "skip" });
    }
  });

  test("skips while in flight if a trailing run is already pending", () => {
    expect(
      planWorktreeRecompute(
        { lastRunAtMs: 1_000, inFlight: true, hasPendingTrailing: true },
        1_100,
        MIN,
      ),
    ).toEqual({ action: "skip" });
  });

  test("trailing delay never goes negative at the cooldown boundary", () => {
    const plan = planWorktreeRecompute(
      { lastRunAtMs: 1_000, inFlight: false, hasPendingTrailing: false },
      1_000 + MIN, // exactly at the boundary → eligible to run
      MIN,
    );
    expect(plan).toEqual({ action: "run" });
  });
});
