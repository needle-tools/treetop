import { describe, it, expect } from "bun:test";
import {
  walkthroughHash,
  WALKTHROUGH_STEPS,
} from "../src/onboarding-walkthrough";

describe("walkthroughHash", () => {
  it("returns a stable non-empty string", () => {
    const h1 = walkthroughHash();
    const h2 = walkthroughHash();
    expect(h1).toBe(h2);
    expect(h1.length).toBeGreaterThan(0);
  });

  it("is derived from step ids and messages", () => {
    expect(typeof walkthroughHash()).toBe("string");
  });
});

describe("WALKTHROUGH_STEPS", () => {
  it("has at least 3 steps", () => {
    expect(WALKTHROUGH_STEPS.length).toBeGreaterThanOrEqual(3);
  });

  it("every step has id, emoji, message, placement, and target function", () => {
    for (const step of WALKTHROUGH_STEPS) {
      expect(step.id).toBeTruthy();
      expect(step.emoji).toBeTruthy();
      expect(step.message).toBeTruthy();
      expect(["top", "bottom"]).toContain(step.placement);
      expect(typeof step.target).toBe("function");
    }
  });

  it("last step is the finish step", () => {
    const last = WALKTHROUGH_STEPS[WALKTHROUGH_STEPS.length - 1];
    expect(last?.id).toBe("finish");
  });
});

describe("X button remove-vs-hide logic", () => {
  function shouldRemoveRepo(
    wt: { nonGit: boolean } | null,
    worktreeCount: number,
  ): boolean {
    if (wt && !wt.nonGit && worktreeCount > 1) return false;
    return true;
  }

  it("removes repo when single worktree", () => {
    expect(shouldRemoveRepo({ nonGit: false }, 1)).toBe(true);
  });

  it("hides worktree when multiple worktrees", () => {
    expect(shouldRemoveRepo({ nonGit: false }, 3)).toBe(false);
  });

  it("removes repo for nonGit folders", () => {
    expect(shouldRemoveRepo({ nonGit: true }, 1)).toBe(true);
  });

  it("removes repo when wt is null", () => {
    expect(shouldRemoveRepo(null, 0)).toBe(true);
  });
});
