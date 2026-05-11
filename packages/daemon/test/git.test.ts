import { test, expect, describe } from "bun:test";
import { parseWorktreeList } from "../src/git";

describe("parseWorktreeList", () => {
  test("returns empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  test("parses a single worktree on a branch", () => {
    const input = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main
`;
    expect(parseWorktreeList(input)).toEqual([
      {
        path: "/home/user/repo",
        branch: "main",
        head: "abc123",
        bare: false,
        detached: false,
      },
    ]);
  });

  test("parses multiple worktrees separated by blank lines", () => {
    const input = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/wt/feat
HEAD def456
branch refs/heads/feat/audio
`;
    const result = parseWorktreeList(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.branch).toBe("main");
    expect(result[1]?.branch).toBe("feat/audio");
    expect(result[1]?.path).toBe("/home/user/wt/feat");
  });

  test("parses a detached worktree (no branch, detached flag)", () => {
    const input = `worktree /home/user/repo
HEAD abc123
detached
`;
    const result = parseWorktreeList(input);
    expect(result[0]?.detached).toBe(true);
    expect(result[0]?.branch).toBe("");
  });

  test("parses a bare worktree", () => {
    const input = `worktree /home/user/bare.git
bare
`;
    const result = parseWorktreeList(input);
    expect(result[0]?.bare).toBe(true);
  });

  test("strips the refs/heads/ prefix from branch names", () => {
    const input = `worktree /a
HEAD x
branch refs/heads/feat/nested/name
`;
    expect(parseWorktreeList(input)[0]?.branch).toBe("feat/nested/name");
  });
});
