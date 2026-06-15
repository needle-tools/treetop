import { test, expect, describe } from "bun:test";
import {
  shouldAutoSummarizeTui,
  MIN_TURNS_TO_SEED,
  type TuiAutoSummaryInput,
} from "../src/tui-auto-summary";

const base: TuiAutoSummaryInput = {
  refreshing: false,
  hasSummary: false,
  sampledCount: 5,
  lastAttemptCount: -1,
  summaryDrifted: false,
};

describe("shouldAutoSummarizeTui", () => {
  test("seeds the first summary for a never-summarised TUI with enough turns", () => {
    // The regression we are fixing: previously this returned false because
    // the gate required an existing summary.
    expect(shouldAutoSummarizeTui(base)).toBe(true);
  });

  test("does not seed below the minimum turn count", () => {
    expect(
      shouldAutoSummarizeTui({ ...base, sampledCount: MIN_TURNS_TO_SEED - 1 }),
    ).toBe(false);
  });

  test("does not re-seed when the turn count has not grown since last attempt", () => {
    // No model installed → first attempt failed; count unchanged → stay quiet.
    expect(
      shouldAutoSummarizeTui({ ...base, lastAttemptCount: 5 }),
    ).toBe(false);
  });

  test("seeds again once new turns arrive after a failed attempt", () => {
    expect(
      shouldAutoSummarizeTui({ ...base, sampledCount: 7, lastAttemptCount: 5 }),
    ).toBe(true);
  });

  test("refreshes a drifted existing summary regardless of the seed guard", () => {
    expect(
      shouldAutoSummarizeTui({
        ...base,
        hasSummary: true,
        summaryDrifted: true,
        lastAttemptCount: 99,
      }),
    ).toBe(true);
  });

  test("does not fire for an existing summary that has not drifted", () => {
    expect(
      shouldAutoSummarizeTui({ ...base, hasSummary: true, summaryDrifted: false }),
    ).toBe(false);
  });

  test("never fires while a summary stream is already running", () => {
    expect(shouldAutoSummarizeTui({ ...base, refreshing: true })).toBe(false);
    expect(
      shouldAutoSummarizeTui({
        ...base,
        refreshing: true,
        summaryDrifted: true,
      }),
    ).toBe(false);
  });
});
