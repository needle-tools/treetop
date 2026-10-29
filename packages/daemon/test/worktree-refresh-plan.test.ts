import { test, expect, describe } from "bun:test";
import {
  planWorktreeRecompute,
  refreshWorktreeAfterMutation,
  type WorktreeRecomputeState,
} from "../src/worktree-refresh-plan";

const MIN = 2_500;

test("a completed mutation does not wait for slow badge refresh and still publishes its result", async () => {
  let finish!: (value: {ahead: number}) => void;
  const slow = new Promise<{ahead: number}>(resolve => {finish = resolve;});
  const published: unknown[] = [], errors: unknown[] = [];
  expect(refreshWorktreeAfterMutation(() => slow, value => published.push(value), error => errors.push(error))).toBeUndefined();
  expect(published).toEqual([]);
  finish({ahead: 0});
  await Bun.sleep(0);
  expect(published).toEqual([{ahead: 0}]);
  expect(errors).toEqual([]);
});

test("a failed post-mutation refresh is reported without changing mutation success", async () => {
  const errors: unknown[] = [];
  const error = new Error("status failed");
  refreshWorktreeAfterMutation(async () => {throw error;}, () => {throw new Error("unexpected publication");}, value => errors.push(value));
  await Bun.sleep(0);
  expect(errors).toEqual([error]);
});

test("session worktrees publish before a blocked status refresh finishes", async () => {
  const { publishWorktreesBeforeDetails } = await import("../src/worktree-refresh-plan");
  const sessions = [{ path: "/repo", agents: [{ sessionId: "preserved" }], branchStatus: null }];
  let finish!: (value: typeof sessions) => void;
  const blocked = new Promise<typeof sessions>(resolve => { finish = resolve; });
  const published: typeof sessions[] = [];
  const loading = publishWorktreesBeforeDetails(sessions, value => published.push(value), () => blocked);
  expect(published).toEqual([sessions]);
  expect(published[0][0].agents[0].sessionId).toBe("preserved");
  finish([{ ...sessions[0], branchStatus: { branch: "main" } as any }]);
  expect((await loading)[0].branchStatus).toEqual({ branch: "main" });
  expect(published[0][0].branchStatus).toBeNull();
});
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
