import { describe, expect, test } from "bun:test";
import {
  artifactMapOwnerSource,
  artifactMapPanelSource,
  createSessionArtifactEvolutionTracker,
  filterSessionArtifactEvolution,
  insertArtifactMapPanel,
  sessionArtifactTurnCounts,
  sessionArtifactTurnWindow,
} from "../src/session-artifacts";
import { buildVisualTranscriptItems } from "../src/last-user-message";

describe("session artifact evolution", () => {
  test("uses the shared visual work extraction to accumulate ranged reads and writes by turn", () => {
    const messages = [
      { role: "user", timestamp: "2026-09-11T10:00:00.000Z", blocks: [{ type: "text", text: "Inspect it" }] },
      {
        role: "assistant",
        timestamp: "2026-09-11T10:00:01.000Z",
        blocks: [{ type: "tool_use", toolName: "exec_command", toolUseId: "read-1", toolInput: { cmd: "sed -n '1,40p' src/app.ts" } }],
      },
      {
        role: "tool",
        timestamp: "2026-09-11T10:00:02.000Z",
        blocks: [{ type: "tool_result", toolUseId: "read-1", text: "const before = true;" }],
      },
      {
        role: "assistant",
        timestamp: "2026-09-11T10:00:03.000Z",
        blocks: [{
          type: "tool_use",
          toolName: "file change",
          toolUseId: "write-1",
          toolInput: {
            "src/app.ts": {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-const before = true;\n+const after = true;",
            },
          },
        }],
      },
      { role: "user", timestamp: "2026-09-11T10:01:00.000Z", blocks: [{ type: "text", text: "Check the rest" }] },
      {
        role: "assistant",
        timestamp: "2026-09-11T10:01:01.000Z",
        blocks: [{ type: "tool_use", toolName: "exec_command", toolUseId: "read-2", toolInput: { cmd: "sed -n '80,120p' src/app.ts" } }],
      },
      {
        role: "tool",
        timestamp: "2026-09-11T10:01:02.000Z",
        blocks: [{ type: "tool_result", toolUseId: "read-2", text: "const tail = true;" }],
      },
    ];
    const tracker = createSessionArtifactEvolutionTracker();
    const evolution = tracker.update(buildVisualTranscriptItems(messages));

    expect(evolution.turns.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    expect(evolution.artifacts.map((artifact) => artifact.path)).toEqual([
      "src/app.ts",
      "src/app.ts",
    ]);
    expect(evolution.totals).toEqual({
      reads: 2,
      partialReads: 2,
      writes: 1,
      partialWrites: 1,
      additions: 1,
      deletions: 1,
    });
    expect(sessionArtifactTurnCounts(evolution.turns[0]!)).toEqual({
      reads: 1,
      writes: 1,
    });
    expect(sessionArtifactTurnCounts(evolution.turns[1]!)).toEqual({
      reads: 1,
      writes: 0,
    });

    const reads = filterSessionArtifactEvolution(evolution, "reads");
    expect(reads.turns.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    expect(reads.totals).toEqual({
      reads: 2,
      partialReads: 2,
      writes: 0,
      partialWrites: 0,
      additions: 0,
      deletions: 0,
    });
    expect(filterSessionArtifactEvolution(evolution, "reads").artifacts[0]).toBe(reads.artifacts[0]);

    const writes = filterSessionArtifactEvolution(evolution, "writes");
    expect(writes.turns.map((turn) => turn.turnNumber)).toEqual([1]);
    expect(writes.totals).toEqual({
      reads: 0,
      partialReads: 0,
      writes: 1,
      partialWrites: 1,
      additions: 1,
      deletions: 1,
    });
  });

  test("reuses cached completed work while only the live tail changes", () => {
    const first = buildVisualTranscriptItems([
      { role: "user", blocks: [{ type: "text", text: "Read" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolName: "exec_command", toolUseId: "r", toolInput: { cmd: "cat src/a.ts" } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: "r", text: "a" }] },
    ]);
    const tracker = createSessionArtifactEvolutionTracker();
    const before = tracker.update(first);
    const after = tracker.update([...first, { kind: "message", message: { role: "assistant", blocks: [{ type: "text", text: "Done" }] }, blocks: [{ type: "text", text: "Done" }], messageIndex: 3 }]);

    expect(after).toBe(before);
  });

  test("updates only a replaced tail and restores truncated replay state", () => {
    const first = buildVisualTranscriptItems([
      { role: "user", blocks: [{ type: "text", text: "Read" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolName: "exec_command", toolUseId: "r1", toolInput: { cmd: "cat src/a.ts" } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: "r1", text: "a" }] },
    ]);
    const replacement = buildVisualTranscriptItems([
      { role: "user", blocks: [{ type: "text", text: "Read" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolName: "exec_command", toolUseId: "r2", toolInput: { cmd: "cat src/b.ts" } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: "r2", text: "b" }] },
    ]);
    const tracker = createSessionArtifactEvolutionTracker();
    expect(tracker.update(first).artifacts.map((artifact) => artifact.path)).toEqual(["src/a.ts"]);

    const replaced = tracker.update([first[0]!, replacement[1]!]);
    expect(replaced.artifacts.map((artifact) => artifact.path)).toEqual(["src/b.ts"]);
    expect(tracker.update([first[0]!]).artifacts).toEqual([]);
    expect(tracker.update(first).artifacts.map((artifact) => artifact.path)).toEqual(["src/a.ts"]);
  });

  test("detects a changed middle even when the visible tail keeps its identity", () => {
    const work = (path: string, id: string) => buildVisualTranscriptItems([
      { role: "user", blocks: [{ type: "text", text: "Read" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolName: "exec_command", toolUseId: id, toolInput: { cmd: `cat ${path}` } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: id, text: path }] },
    ]).find((item) => item.kind === "work")!;
    const firstUser = buildVisualTranscriptItems([{ role: "user", blocks: [{ type: "text", text: "First" }] }])[0]!;
    const firstWork = work("src/a.ts", "a");
    const replacementWork = work("src/b.ts", "b");
    const stableTail = work("src/c.ts", "c");
    const tracker = createSessionArtifactEvolutionTracker();
    tracker.update([firstUser, firstWork, stableTail]);

    const replaced = tracker.update([firstUser, replacementWork, stableTail]);
    expect(replaced.artifacts.map((artifact) => artifact.path)).toEqual(["src/b.ts", "src/c.ts"]);
    expect(replaced.turns[0]?.artifacts.map((artifact) => artifact.path)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("round-trips arbitrary session sources through artifact panel ids", () => {
    const owner = "/Users/me/.codex/sessions/a b.jsonl";
    expect(artifactMapOwnerSource(artifactMapPanelSource(owner))).toBe(owner);
    expect(artifactMapOwnerSource("__files__:x")).toBeUndefined();
  });

  test("windows a large evolution timeline from the recent end", () => {
    const turns = Array.from({ length: 500 }, (_, index) => ({
      turnNumber: index + 1,
      artifacts: [],
    }));
    const window = sessionArtifactTurnWindow(turns, 200);
    expect(window.turns).toHaveLength(200);
    expect(window.turns[0]?.turnNumber).toBe(301);
    expect(window.hiddenTurnCount).toBe(300);
  });

  test("opens one artifact panel immediately left of its owning session", () => {
    const sessions = [
      { agent: "claude", source: "/sessions/one.jsonl" },
      { agent: "codex", source: "/sessions/two.jsonl" },
    ];
    const first = insertArtifactMapPanel(sessions, "/sessions/two.jsonl");
    expect(first.inserted).toBe(true);
    expect(first.sessions.map((session) => session.source)).toEqual([
      "/sessions/one.jsonl",
      artifactMapPanelSource("/sessions/two.jsonl"),
      "/sessions/two.jsonl",
    ]);
    expect(
      insertArtifactMapPanel(first.sessions, "/sessions/two.jsonl"),
    ).toEqual({ sessions: first.sessions, inserted: false });
  });
});
