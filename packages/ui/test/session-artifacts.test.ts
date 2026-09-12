import { describe, expect, test } from "bun:test";
import {
  artifactMapOwnerSource,
  artifactMapPanelSource,
  analyzeSessionArtifactOverbooking,
  createSessionArtifactEvolutionTracker,
  filterSessionArtifactEvolution,
  insertArtifactMapPanel,
  sessionArtifactJuiceTransition,
  sessionArtifactTurnCounts,
  sessionArtifactTurnWindow,
  scopeSessionArtifactEvolution,
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
      references: 0,
      partialReads: 2,
      writes: 1,
      partialWrites: 1,
      additions: 1,
      deletions: 1,
    });
    expect(sessionArtifactTurnCounts(evolution.turns[0]!)).toEqual({
      reads: 1,
      references: 0,
      writes: 1,
    });
    expect(sessionArtifactTurnCounts(evolution.turns[1]!)).toEqual({
      reads: 1,
      references: 0,
      writes: 0,
    });

    const reads = filterSessionArtifactEvolution(evolution, "reads");
    expect(reads.turns.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    expect(reads.totals).toEqual({
      reads: 2,
      references: 0,
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
      references: 0,
      partialReads: 0,
      writes: 1,
      partialWrites: 1,
      additions: 1,
      deletions: 1,
    });

    const partialWrites = filterSessionArtifactEvolution(evolution, "partial-writes");
    expect(partialWrites.totals).toEqual(writes.totals);
  });

  test("counts every nested patch and an appended heredoc as writes", () => {
    const firstPatch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
    const secondPatch = "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-before\n+after\n+more\n*** End Patch";
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "Change it" }] },
      {
        role: "assistant",
        blocks: [{
          type: "tool_use",
          toolName: "exec_command",
          toolUseId: "nested",
          toolInput: { cmd: "cat >> tests/new.spec.js <<'EOF'\nfirst\nsecond\nEOF" },
          toolInvocations: [
            { toolName: "apply_patch", toolInput: firstPatch },
            { toolName: "exec_command", toolInput: { cmd: "cat >> tests/new.spec.js <<'EOF'\nfirst\nsecond\nEOF" } },
            { toolName: "apply_patch", toolInput: secondPatch },
          ],
        }],
      },
    ];
    const evolution = createSessionArtifactEvolutionTracker().update(buildVisualTranscriptItems(messages));
    expect(evolution.totals).toEqual({
      reads: 0,
      references: 0,
      partialReads: 0,
      writes: 3,
      partialWrites: 3,
      additions: 5,
      deletions: 2,
    });
  });

  test("can project the current turn without rebuilding consolidated history", () => {
    const first = { id: "first", kind: "file" as const, action: "used" as const, label: "a.ts", path: "a.ts" };
    const second = { id: "second", kind: "file" as const, action: "changed" as const, label: "b.ts", path: "b.ts", additions: 2 };
    const evolution = {
      artifacts: [first, second],
      turns: [
        { turnNumber: 1, artifacts: [first] },
        { turnNumber: 2, artifacts: [second] },
      ],
      totals: { reads: 1, references: 0, partialReads: 0, writes: 1, partialWrites: 0, additions: 2, deletions: 0 },
    };

    expect(scopeSessionArtifactEvolution(evolution, "consolidated")).toBe(evolution);
    expect(scopeSessionArtifactEvolution(evolution, "current")).toEqual({
      artifacts: [second],
      turns: [evolution.turns[1]],
      totals: { reads: 0, references: 0, partialReads: 0, writes: 1, partialWrites: 0, additions: 2, deletions: 0 },
    });
  });

  test("filters references separately without inflating read totals", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "Clone it" }] },
      {
        role: "assistant",
        blocks: [{
          type: "tool_use",
          toolName: "exec_command",
          toolInput: {
            cmd: "git clone https://example.test/project.git /tmp/project",
          },
        }],
      },
    ];
    const evolution = createSessionArtifactEvolutionTracker().update(
      buildVisualTranscriptItems(messages),
    );

    expect(evolution.totals).toMatchObject({ reads: 0, references: 1 });
    expect(filterSessionArtifactEvolution(evolution, "reads").artifacts).toEqual([]);
    expect(filterSessionArtifactEvolution(evolution, "references").artifacts).toMatchObject([
      { action: "referenced", path: "/tmp/project" },
    ]);
  });

  test("does not leak read previews into the references-only projection", () => {
    const artifact = {
      id: "file\0src/app.ts",
      kind: "file" as const,
      action: "used" as const,
      label: "app.ts",
      path: "src/app.ts",
      preview: "captured source",
      previewTitle: "Read app.ts",
      contentLineCount: 1,
      contentTokenCount: 3,
      changes: [
        { action: "referenced" as const, label: "app.ts", path: "src/app.ts" },
        { action: "used" as const, label: "app.ts", path: "src/app.ts", preview: "captured source", previewTitle: "Read app.ts", contentLineCount: 1, contentTokenCount: 3 },
      ],
    };
    const evolution = {
      artifacts: [artifact],
      turns: [{ turnNumber: 1, artifacts: [artifact] }],
      totals: { reads: 1, references: 1, partialReads: 0, writes: 0, partialWrites: 0, additions: 0, deletions: 0 },
    };

    expect(filterSessionArtifactEvolution(evolution, "references").artifacts[0]).toMatchObject({
      action: "referenced",
      preview: undefined,
      previewTitle: undefined,
      contentLineCount: undefined,
      contentTokenCount: undefined,
    });
  });

  test("includes command log outputs without calling full redirections partial writes", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "Run checks" }] },
      {
        role: "assistant",
        blocks: [{
          type: "tool_use",
          toolName: "exec_command",
          toolInput: {
            cmd: "npx vitest run > /tmp/unit.log 2>&1; npm test >> /tmp/history.log 2>&1",
          },
        }],
      },
    ];

    const evolution = createSessionArtifactEvolutionTracker().update(
      buildVisualTranscriptItems(messages),
    );
    expect(evolution.artifacts.map((artifact) => artifact.path)).toEqual([
      "/tmp/unit.log",
      "/tmp/history.log",
    ]);
    expect(evolution.totals).toMatchObject({ writes: 2, partialWrites: 1 });
  });

  test("keeps agent-authored writes in memory when flagging repeated reads", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "First pass" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolUseId: "r1", toolName: "exec_command", toolInput: { cmd: "sed -n '1,40p' src/app.ts" } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: "r1", text: "first" }] },
      { role: "user", blocks: [{ type: "text", text: "Second pass" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolUseId: "r2", toolName: "exec_command", toolInput: { cmd: "sed -n '1,40p' src/app.ts; sed -n '80,120p' src/app.ts" } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: "r2", text: "second" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolUseId: "w1", toolName: "file change", toolInput: { "src/app.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new" } } }] },
      { role: "user", blocks: [{ type: "text", text: "Verify after change" }] },
      { role: "assistant", blocks: [{ type: "tool_use", toolUseId: "r3", toolName: "exec_command", toolInput: { cmd: "sed -n '1,40p' src/app.ts" } }] },
      { role: "tool", blocks: [{ type: "tool_result", toolUseId: "r3", text: "third" }] },
    ];
    const evolution = createSessionArtifactEvolutionTracker().update(buildVisualTranscriptItems(messages));
    const overbooking = analyzeSessionArtifactOverbooking(evolution.turns);
    expect(analyzeSessionArtifactOverbooking(evolution.turns)).toBe(overbooking);

    expect(overbooking.repeatedReads).toBe(2);
    expect(overbooking.files).toEqual([
      {
        path: "src/app.ts",
        reads: 4,
        repeatedReads: 2,
        ranges: [
          { range: "1-40", reads: 3, repeatedReads: 2, turns: [1, 2, 3] },
          { range: "80-120", reads: 1, repeatedReads: 0, turns: [2] },
        ],
      },
    ]);
    expect(filterSessionArtifactEvolution(evolution, "repeated").totals.reads).toBe(2);
  });

  test("keeps reads from a shell call that also mutates another file", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "Inspect and copy" }] },
      {
        role: "assistant",
        blocks: [{
          type: "tool_use",
          toolName: "exec_command",
          toolInput: { cmd: "sed -n '1,20p' src/input.ts; cp /tmp/result.ts src/output.ts" },
        }],
      },
    ];
    const totals = createSessionArtifactEvolutionTracker()
      .update(buildVisualTranscriptItems(messages)).totals;
    expect(totals).toMatchObject({ reads: 2, partialReads: 1, writes: 1, partialWrites: 1 });
  });

  test("only fires artifact juice for forward read or write activity", () => {
    const before = { reads: 4, references: 0, partialReads: 2, writes: 1, partialWrites: 1, additions: 2, deletions: 1 };
    expect(sessionArtifactJuiceTransition(before, { ...before, reads: 5 }, true)).toEqual({ readImpact: true, writeImpact: false });
    expect(sessionArtifactJuiceTransition(before, { ...before, writes: 2 }, true)).toEqual({ readImpact: false, writeImpact: true });
    expect(sessionArtifactJuiceTransition(before, { ...before, writes: 2 }, false)).toEqual({ readImpact: false, writeImpact: false });
  });

  test("does not count produced images as file writes", () => {
    const produced = {
      id: "image\0out.png",
      kind: "image" as const,
      action: "produced" as const,
      label: "out.png",
      path: "out.png",
      changes: [{ action: "produced" as const, label: "out.png", path: "out.png" }],
    };
    const evolution = {
      artifacts: [produced],
      turns: [{ turnNumber: 1, artifacts: [produced] }],
      totals: { reads: 0, references: 0, partialReads: 0, writes: 0, partialWrites: 0, additions: 0, deletions: 0 },
    };
    expect(filterSessionArtifactEvolution(evolution, "writes").artifacts).toEqual([]);
    expect(sessionArtifactTurnCounts(evolution.turns[0]!)).toEqual({ reads: 0, references: 0, writes: 0 });
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
