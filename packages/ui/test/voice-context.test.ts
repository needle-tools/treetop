import { describe, expect, test } from "bun:test";
import {
  deriveVoiceContext,
  resolveVoiceSessionMessageTarget,
} from "../src/voice-context";

describe("deriveVoiceContext", () => {
  test("uses the zen row and last-focused session without inventing another state source", () => {
    const context = deriveVoiceContext({
      projects: [
        {
          id: "repo-a",
          name: "Alpha",
          path: "/alpha",
          worktrees: [{ path: "/alpha", branch: "main" }],
        },
        {
          id: "repo-b",
          name: "Beta",
          path: "/beta",
          worktrees: [{ path: "/beta/wt", branch: "voice" }],
        },
      ],
      rows: [
        {
          key: "repo-a|/alpha",
          repoId: "repo-a",
          worktreePath: "/alpha",
        },
        {
          key: "repo-b|/beta/wt",
          repoId: "repo-b",
          worktreePath: "/beta/wt",
        },
      ],
      zenRowKey: "repo-b|/beta/wt",
      activeWorktreePath: "/alpha",
      lastActiveSessionSource: "/sessions/beta.jsonl",
      sessions: [
        {
          source: "/sessions/alpha.jsonl",
          agent: "claude",
          worktreePath: "/alpha",
          repoId: "repo-a",
          lastActive: "2026-07-29T10:00:00.000Z",
        },
        {
          source: "/sessions/beta.jsonl",
          agent: "codex",
          worktreePath: "/beta/wt",
          repoId: "repo-b",
          title: "Voice experiment",
          lastActive: "2026-07-29T09:00:00.000Z",
          working: true,
        },
      ],
      notes: [
        {
          id: "global",
          body: "A less relevant workspace note",
          anchors: ["worktree:/alpha"],
          updatedAt: "2026-07-29T12:00:00.000Z",
        },
        {
          id: "active",
          body: "Remember this active voice note with extra detail",
          anchors: ["worktree:/beta/wt"],
          tags: ["voice"],
          updatedAt: "2026-07-29T11:00:00.000Z",
        },
      ],
    });

    expect(context.zenMode).toEqual({
      active: true,
      rowKey: "repo-b|/beta/wt",
    });
    expect(context.activeProject).toMatchObject({
      id: "repo-b",
      name: "Beta",
      worktreePath: "/beta/wt",
      branch: "voice",
    });
    expect(context.activeSession).toMatchObject({
      source: "/sessions/beta.jsonl",
      agent: "codex",
      title: "Voice experiment",
      working: true,
    });
    expect(context.latestSession).toMatchObject({
      source: "/sessions/alpha.jsonl",
      agent: "claude",
    });
    expect(context.notes[0]).toMatchObject({
      id: "active",
      excerpt: "Remember this active voice note with extra detail",
      anchors: ["worktree:/beta/wt"],
      tags: ["voice"],
      kind: "note",
    });
    expect(context.cwd).toBe("/beta/wt");
  });

  test("falls back to the active worktree and newest session outside zen", () => {
    const context = deriveVoiceContext({
      projects: [
        {
          id: "repo-a",
          name: "Alpha",
          path: "/alpha",
          worktrees: [
            { path: "/alpha", branch: "main" },
            { path: "/alpha/wt", branch: "feature" },
          ],
        },
      ],
      rows: [],
      zenRowKey: null,
      activeWorktreePath: "/alpha/wt",
      lastActiveSessionSource: null,
      sessions: [
        {
          source: "/sessions/old.jsonl",
          agent: "codex",
          worktreePath: "/alpha",
          repoId: "repo-a",
          lastActive: "2026-07-28T09:00:00.000Z",
        },
        {
          source: "/sessions/new.jsonl",
          agent: "claude",
          worktreePath: "/alpha/wt",
          repoId: "repo-a",
          lastActive: "2026-07-29T09:00:00.000Z",
        },
      ],
    });

    expect(context.zenMode).toEqual({ active: false });
    expect(context.activeProject).toMatchObject({
      id: "repo-a",
      worktreePath: "/alpha/wt",
      branch: "feature",
    });
    expect(context.activeSession?.source).toBe("/sessions/new.jsonl");
    expect(context.latestSession?.source).toBe("/sessions/new.jsonl");
  });

  test("resolves voice session message targets from active or explicit source", () => {
    const context = deriveVoiceContext({
      projects: [
        {
          id: "repo-a",
          name: "Alpha",
          path: "/alpha",
          worktrees: [
            { path: "/alpha", branch: "main" },
            { path: "/alpha/wt", branch: "feature" },
          ],
        },
      ],
      rows: [],
      zenRowKey: null,
      activeWorktreePath: "/alpha/wt",
      lastActiveSessionSource: "/sessions/new.jsonl",
      sessions: [
        {
          source: "/sessions/old.jsonl",
          agent: "codex",
          worktreePath: "/alpha",
          repoId: "repo-a",
          sessionId: "sid-old",
          lastActive: "2026-07-28T09:00:00.000Z",
        },
        {
          source: "/sessions/new.jsonl",
          agent: "codex",
          worktreePath: "/alpha/wt",
          repoId: "repo-a",
          sessionId: "sid-new",
          lastActive: "2026-07-29T09:00:00.000Z",
        },
      ],
    });

    expect(resolveVoiceSessionMessageTarget(context)).toMatchObject({
      source: "/sessions/new.jsonl",
      sessionId: "sid-new",
    });
    expect(
      resolveVoiceSessionMessageTarget(context, "/sessions/old.jsonl"),
    ).toMatchObject({
      source: "/sessions/old.jsonl",
      sessionId: "sid-old",
    });
    expect(() =>
      resolveVoiceSessionMessageTarget(context, "/sessions/missing.jsonl"),
    ).toThrow("Treetop session not found");
  });
});
