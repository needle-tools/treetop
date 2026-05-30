import { describe, expect, test } from "bun:test";
import { relativizeToWorktree } from "../src/worktree-path";

describe("relativizeToWorktree", () => {
  test("returns empty when path equals worktree root", () => {
    expect(relativizeToWorktree("C:\\git\\supergit", "C:\\git\\supergit")).toBe("");
    expect(relativizeToWorktree("/home/user/project", "/home/user/project")).toBe("");
  });

  test("returns relative when path is inside worktree", () => {
    expect(relativizeToWorktree("C:\\git\\supergit\\packages\\ui", "C:\\git\\supergit"))
      .toBe("packages/ui");
    expect(relativizeToWorktree("/home/user/project/src/lib", "/home/user/project"))
      .toBe("src/lib");
  });

  test("returns unchanged when outside worktree", () => {
    expect(relativizeToWorktree("C:\\other\\repo", "C:\\git\\supergit"))
      .toBe("C:\\other\\repo");
    expect(relativizeToWorktree("/tmp/other", "/home/user/project"))
      .toBe("/tmp/other");
  });

  test("handles mixed slashes (Windows)", () => {
    expect(relativizeToWorktree("C:/git/supergit/packages/ui", "C:\\git\\supergit"))
      .toBe("packages/ui");
    expect(relativizeToWorktree("C:\\git\\supergit\\packages/ui", "C:/git/supergit"))
      .toBe("packages/ui");
  });

  test("case insensitive on the base prefix", () => {
    expect(relativizeToWorktree("C:\\Git\\SUPERGIT\\packages", "c:\\git\\supergit"))
      .toBe("packages");
  });

  test("handles trailing slashes on base", () => {
    expect(relativizeToWorktree("/home/user/project/src", "/home/user/project/"))
      .toBe("src");
  });

  test("trailing slash on picked path is stripped", () => {
    expect(relativizeToWorktree("C:\\git\\supergit\\packages\\", "C:\\git\\supergit"))
      .toBe("packages");
  });

  test("does not match prefix when only partial directory name", () => {
    // C:\git\supergit2 should not be considered inside C:\git\supergit
    expect(relativizeToWorktree("C:\\git\\supergit2", "C:\\git\\supergit"))
      .toBe("C:\\git\\supergit2");
  });

  test("returns input unchanged when base is empty", () => {
    expect(relativizeToWorktree("C:\\some\\path", "")).toBe("C:\\some\\path");
  });

  test("returns input unchanged when picked is empty", () => {
    expect(relativizeToWorktree("", "C:\\git\\supergit")).toBe("");
  });
});
