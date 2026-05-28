import { test, expect, describe } from "bun:test";
import { pendingDiffLoad, type DiffCacheState } from "../src/source-control";

function state(over: Partial<DiffCacheState> = {}): DiffCacheState {
  return {
    expanded: false,
    diffTab: "workdir",
    workdirDiff: undefined,
    stagedDiff: undefined,
    ...over,
  };
}

describe("pendingDiffLoad", () => {
  test("collapsed pane never loads, regardless of cache state", () => {
    expect(pendingDiffLoad(state({ expanded: false }))).toBeNull();
    expect(
      pendingDiffLoad(
        state({
          expanded: false,
          workdirDiff: undefined,
          stagedDiff: undefined,
        }),
      ),
    ).toBeNull();
  });

  test("expanded + workdir tab + uncached workdir → 'workdir'", () => {
    expect(
      pendingDiffLoad(
        state({ expanded: true, diffTab: "workdir", workdirDiff: undefined }),
      ),
    ).toBe("workdir");
  });

  test("expanded + workdir tab + already-cached workdir → null", () => {
    expect(
      pendingDiffLoad(
        state({
          expanded: true,
          diffTab: "workdir",
          workdirDiff: "diff --git a/x b/x\n…",
        }),
      ),
    ).toBeNull();
  });

  test("an empty string is a valid cached answer — no refetch", () => {
    // The daemon returns "" for "no changes here", and that's
    // distinct from undefined (which means "we haven't asked yet" or
    // "fs_change cleared the cache"). Don't refetch on empty: it
    // would loop forever for a clean worktree.
    expect(
      pendingDiffLoad(
        state({ expanded: true, diffTab: "workdir", workdirDiff: "" }),
      ),
    ).toBeNull();
    expect(
      pendingDiffLoad(
        state({ expanded: true, diffTab: "staged", stagedDiff: "" }),
      ),
    ).toBeNull();
  });

  test("expanded + staged tab + uncached staged → 'staged'", () => {
    expect(
      pendingDiffLoad(
        state({ expanded: true, diffTab: "staged", stagedDiff: undefined }),
      ),
    ).toBe("staged");
  });

  test("only the active tab matters — uncached inactive side doesn't trigger a load", () => {
    // The pane only renders one diff at a time. We refetch only the
    // tab the user is looking at; the other becomes load-on-switch
    // (setDiffTab handles that).
    expect(
      pendingDiffLoad(
        state({
          expanded: true,
          diffTab: "workdir",
          workdirDiff: "<populated>",
          stagedDiff: undefined,
        }),
      ),
    ).toBeNull();
    expect(
      pendingDiffLoad(
        state({
          expanded: true,
          diffTab: "staged",
          stagedDiff: "<populated>",
          workdirDiff: undefined,
        }),
      ),
    ).toBeNull();
  });
});

describe("regression: collapse → fs_change → re-open must trigger a load", () => {
  // This is the user-reported bug. Three component lifecycles
  // (onExpandedChange, onFsChange, setDiffTab) used to each decide
  // independently whether to load — and the "re-open with cleared
  // cache" path fell between the cracks because hasTabBeenSet was
  // already true and onFsChange had early-returned while the pane
  // was collapsed.
  //
  // After the refactor, every lifecycle hook calls pendingDiffLoad +
  // dispatches; the rule is centralized. The sequence below walks
  // the exact transition the user hit and asserts the pane decides
  // to load on re-open.
  test("the full collapse → clear → re-open dance ends in 'load workdir'", () => {
    let s = state({ expanded: true, diffTab: "workdir" });
    // 1. First open: nothing cached → fetch workdir.
    expect(pendingDiffLoad(s)).toBe("workdir");
    // 2. The fetch resolves with content.
    s = { ...s, workdirDiff: "diff --git a/file b/file\n…" };
    expect(pendingDiffLoad(s)).toBeNull();
    // 3. User collapses the pane.
    s = { ...s, expanded: false };
    expect(pendingDiffLoad(s)).toBeNull();
    // 4. fs_change clears the cache while collapsed.
    s = { ...s, workdirDiff: undefined, stagedDiff: undefined };
    expect(pendingDiffLoad(s)).toBeNull(); // still collapsed
    // 5. User re-opens — historically this is where the bug bit:
    //    the pane rendered "Nothing unstaged." with workdirDiff =
    //    undefined forever until the user clicked a tab manually.
    s = { ...s, expanded: true };
    expect(pendingDiffLoad(s)).toBe("workdir");
  });

  test("same dance on the staged tab", () => {
    let s = state({ expanded: true, diffTab: "staged" });
    expect(pendingDiffLoad(s)).toBe("staged");
    s = { ...s, stagedDiff: "<diff>" };
    expect(pendingDiffLoad(s)).toBeNull();
    s = { ...s, expanded: false };
    expect(pendingDiffLoad(s)).toBeNull();
    s = { ...s, workdirDiff: undefined, stagedDiff: undefined };
    expect(pendingDiffLoad(s)).toBeNull();
    s = { ...s, expanded: true };
    expect(pendingDiffLoad(s)).toBe("staged");
  });

  test("switching tabs while expanded triggers a load for the newly-active one", () => {
    // Drive-by: covers the setDiffTab path. Same rule, applied when
    // the active tab itself changes.
    let s = state({
      expanded: true,
      diffTab: "workdir",
      workdirDiff: "<diff>",
      stagedDiff: undefined,
    });
    expect(pendingDiffLoad(s)).toBeNull();
    // User clicks "Staged" — the tab flips, no cache for that side.
    s = { ...s, diffTab: "staged" };
    expect(pendingDiffLoad(s)).toBe("staged");
  });
});
