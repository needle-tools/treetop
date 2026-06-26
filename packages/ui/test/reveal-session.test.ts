import { describe, expect, test } from "bun:test";
import {
  dockEntryExistsInLoadedRepos,
  planReveal,
  type RevealMode,
} from "../src/reveal-session";

/** Concise helper for table-style assertions over the 2×2×2 matrix. */
function plan(mode: RevealMode, rowFolded: boolean, isOpen: boolean) {
  return planReveal({ mode, rowFolded, isOpen });
}

describe("planReveal — folded row (both modes agree)", () => {
  test("folded + closed → unfold + open + scroll-flash", () => {
    for (const mode of ["reveal", "reveal-or-toggle"] as const) {
      expect(plan(mode, true, false)).toEqual({
        unfold: true,
        open: true,
        close: false,
        scrollAndFlash: true,
      });
    }
  });

  test("folded + open → unfold + scroll-flash (don't toggle off; the user can't see what's open)", () => {
    for (const mode of ["reveal", "reveal-or-toggle"] as const) {
      expect(plan(mode, true, true)).toEqual({
        unfold: true,
        open: false,
        close: false,
        scrollAndFlash: true,
      });
    }
  });
});

describe("planReveal — expanded row, mode='reveal' (latest-session badge)", () => {
  test("expanded + closed → just open + scroll-flash (no unfold needed)", () => {
    expect(plan("reveal", false, false)).toEqual({
      unfold: false,
      open: true,
      close: false,
      scrollAndFlash: true,
    });
  });

  test("expanded + open → re-scroll only, never close", () => {
    expect(plan("reveal", false, true)).toEqual({
      unfold: false,
      open: false,
      close: false,
      scrollAndFlash: true,
    });
  });
});

describe("planReveal — expanded row, mode='reveal-or-toggle' (picker entries)", () => {
  test("expanded + closed → open, no scroll-flash (user can already see it)", () => {
    expect(plan("reveal-or-toggle", false, false)).toEqual({
      unfold: false,
      open: true,
      close: false,
      scrollAndFlash: false,
    });
  });

  test("expanded + open → close, no scroll-flash (classic toggle)", () => {
    expect(plan("reveal-or-toggle", false, true)).toEqual({
      unfold: false,
      open: false,
      close: true,
      scrollAndFlash: false,
    });
  });
});

describe("planReveal — invariants", () => {
  test("never asks for both open and close in the same plan", () => {
    for (const mode of ["reveal", "reveal-or-toggle"] as const) {
      for (const rowFolded of [true, false]) {
        for (const isOpen of [true, false]) {
          const p = plan(mode, rowFolded, isOpen);
          expect(p.open && p.close).toBe(false);
        }
      }
    }
  });

  test("never asks to open something that's already open", () => {
    for (const mode of ["reveal", "reveal-or-toggle"] as const) {
      for (const rowFolded of [true, false]) {
        const p = plan(mode, rowFolded, /* isOpen */ true);
        expect(p.open).toBe(false);
      }
    }
  });

  test("never asks to close something that's already closed", () => {
    for (const mode of ["reveal", "reveal-or-toggle"] as const) {
      for (const rowFolded of [true, false]) {
        const p = plan(mode, rowFolded, /* isOpen */ false);
        expect(p.close).toBe(false);
      }
    }
  });

  test("unfold is true only when the row was folded", () => {
    for (const mode of ["reveal", "reveal-or-toggle"] as const) {
      for (const isOpen of [true, false]) {
        expect(plan(mode, false, isOpen).unfold).toBe(false);
        expect(plan(mode, true, isOpen).unfold).toBe(true);
      }
    }
  });

  test("reveal mode never produces a close action — even on an expanded open session", () => {
    for (const rowFolded of [true, false]) {
      for (const isOpen of [true, false]) {
        expect(plan("reveal", rowFolded, isOpen).close).toBe(false);
      }
    }
  });
});

describe("dockEntryExistsInLoadedRepos", () => {
  const repos = [
    {
      id: "repo-a",
      worktrees: [
        {
          path: "/wt-a",
          agents: [
            { agent: "codex", source: "/sessions/a.jsonl" },
            {
              agent: "claude",
              source: "/sessions/b.jsonl",
              resumeSessionId: "sid-b",
            },
          ],
        },
      ],
    },
  ];

  test("matches a regular session source in the loaded repo state", () => {
    expect(
      dockEntryExistsInLoadedRepos(repos, {
        repoId: "repo-a",
        wtPath: "/wt-a",
        agent: "codex",
        source: "/sessions/a.jsonl",
      }),
    ).toBe(true);
  });

  test("matches by session id surface key", () => {
    expect(
      dockEntryExistsInLoadedRepos(repos, {
        repoId: "repo-a",
        wtPath: "/wt-a",
        agent: "claude",
        source: "/other/path.jsonl",
        resumeSessionId: "sid-b",
      }),
    ).toBe(true);
  });

  test("keeps synthetic dock entries when their worktree is loaded", () => {
    expect(
      dockEntryExistsInLoadedRepos(repos, {
        repoId: "repo-a",
        wtPath: "/wt-a",
        agent: "shell",
        source: "__attached__:shell:t_1",
      }),
    ).toBe(true);
  });

  test("returns false for missing repo, worktree, or real source", () => {
    expect(
      dockEntryExistsInLoadedRepos(repos, {
        repoId: "missing",
        wtPath: "/wt-a",
        agent: "codex",
        source: "/sessions/a.jsonl",
      }),
    ).toBe(false);
    expect(
      dockEntryExistsInLoadedRepos(repos, {
        repoId: "repo-a",
        wtPath: "/missing",
        agent: "codex",
        source: "/sessions/a.jsonl",
      }),
    ).toBe(false);
    expect(
      dockEntryExistsInLoadedRepos(repos, {
        repoId: "repo-a",
        wtPath: "/wt-a",
        agent: "codex",
        source: "/sessions/missing.jsonl",
      }),
    ).toBe(false);
  });
});
