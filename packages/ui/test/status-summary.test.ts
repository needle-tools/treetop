import { describe, expect, test } from "bun:test";
import { statusSummary } from "../src/status-summary";

const FS = (s: number, u: number, n: number, subs = 0) => ({
  staged: s,
  unstaged: u,
  untracked: n,
  submodules: subs,
});
const WT = (s: string[], u: string[], n: string[]) => ({
  staged: s,
  unstaged: u,
  untracked: n,
});

describe("statusSummary (FileStatus only)", () => {
  test("returns clean for an empty status", () => {
    expect(statusSummary(FS(0, 0, 0))).toEqual({
      clean: true,
      text: "clean",
      submoduleText: "",
    });
  });

  test("formats non-zero buckets in fixed order", () => {
    expect(statusSummary(FS(3, 5, 1)).text).toBe("3 staged, 5 unstaged, 1 untracked");
  });

  test("omits zero buckets from the joined text", () => {
    expect(statusSummary(FS(0, 5, 1)).text).toBe("5 unstaged, 1 untracked");
    expect(statusSummary(FS(2, 0, 0)).text).toBe("2 staged");
  });

  test("pluralises submoduleText", () => {
    expect(statusSummary(FS(0, 0, 0, 1)).submoduleText).toBe("1 submodule changed");
    expect(statusSummary(FS(0, 0, 0, 3)).submoduleText).toBe("3 submodules changed");
  });

  test("clean + dirty-submodule still reports clean=true (badge is just a trailer)", () => {
    const s = statusSummary(FS(0, 0, 0, 2));
    expect(s.clean).toBe(true);
    expect(s.submoduleText).toBe("2 submodules changed");
  });
});

describe("statusSummary (wt-summary override)", () => {
  test("derives counts from the path-array lengths when wt-summary is loaded", () => {
    // The exact scenario from the bug report: FileStatus snapshot is
    // stale (says 5 unstaged) but the freshly-loaded wt-summary only
    // has 2 paths. The badge should reflect the wt-summary so it
    // matches the tooltip's "UNSTAGED (2)" column header.
    const fs = FS(0, 5, 1);
    const wt = WT([], ["a.txt", "b.txt"], ["c.txt"]);
    expect(statusSummary(fs, wt).text).toBe("2 unstaged, 1 untracked");
  });

  test("falls back to FileStatus when wt-summary is undefined", () => {
    expect(statusSummary(FS(0, 5, 1), undefined).text).toBe("5 unstaged, 1 untracked");
  });

  test('falls back to FileStatus when wt-summary is "loading"', () => {
    expect(statusSummary(FS(0, 5, 1), "loading").text).toBe("5 unstaged, 1 untracked");
  });

  test("an empty wt-summary overrides a stale-dirty FileStatus to clean", () => {
    // The badge had said "5 unstaged" but the user has since committed
    // every file; the next wt-summary fetch returns empty arrays. The
    // badge should flip to "clean" right away rather than waiting for
    // the next /api/repos round-trip.
    const s = statusSummary(FS(0, 5, 1), WT([], [], []));
    expect(s.clean).toBe(true);
    expect(s.text).toBe("clean");
  });

  test("keeps submodules from FileStatus (wt-summary doesn't carry that bucket)", () => {
    const s = statusSummary(FS(0, 0, 0, 3), WT([], [], []));
    expect(s.clean).toBe(true);
    expect(s.submoduleText).toBe("3 submodules changed");
  });
});
