import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseClaudeSession, repairClaudeSession } from "../src/session-repair";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function makeChain(): string[] {
  return [
    line({
      type: "user",
      uuid: "aaa",
      parentUuid: undefined,
      sessionId: "S-1",
      cwd: "/repo",
      message: { role: "user", content: "hello" },
      timestamp: "2026-05-25T10:00:00Z",
      userType: "external",
      entrypoint: "cli",
      version: "2.1.150",
      gitBranch: "main",
      slug: "test-slug",
    }),
    line({
      type: "assistant",
      uuid: "bbb",
      parentUuid: "aaa",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
      timestamp: "2026-05-25T10:00:01Z",
      sessionId: "S-1",
      cwd: "/repo",
      slug: "test-slug",
    }),
    // This is the tool result — will be removed to simulate the bug
    line({
      type: "user",
      uuid: "ccc",
      parentUuid: "bbb",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "file1.txt\nfile2.txt",
            tool_use_id: "tool-1",
          },
        ],
      },
      timestamp: "2026-05-25T10:00:02Z",
      sessionId: "S-1",
      cwd: "/repo",
      slug: "test-slug",
    }),
    line({
      type: "assistant",
      uuid: "ddd",
      parentUuid: "ccc",
      message: { role: "assistant", content: "Here are your files." },
      timestamp: "2026-05-25T10:00:03Z",
      sessionId: "S-1",
      cwd: "/repo",
      slug: "test-slug",
    }),
  ];
}

describe("diagnoseClaudeSession", () => {
  test("healthy session has no broken links", () => {
    const text = makeChain().join("\n");
    const diag = diagnoseClaudeSession(text);
    expect(diag.brokenLinks).toHaveLength(0);
    expect(diag.totalEntries).toBe(4);
  });

  test("detects a missing parent", () => {
    const lines = makeChain();
    // Remove line index 2 (uuid=ccc) — ddd now references a missing parent
    lines.splice(2, 1);
    const text = lines.join("\n");
    const diag = diagnoseClaudeSession(text);
    expect(diag.brokenLinks).toHaveLength(1);
    expect(diag.brokenLinks[0]!.missingUuid).toBe("ccc");
    expect(diag.brokenLinks[0]!.referencedBy).toBe("ddd");
  });

  test("handles entries with no parentUuid (roots)", () => {
    const text = line({
      type: "user",
      uuid: "root",
      message: { role: "user", content: "hi" },
    });
    const diag = diagnoseClaudeSession(text);
    expect(diag.brokenLinks).toHaveLength(0);
  });

  test("skips non-chain entries (metadata, queue-operation, etc.)", () => {
    const text = [
      line({ type: "queue-operation", operation: "enqueue" }),
      line({ type: "last-prompt", lastPrompt: "hi" }),
      line({
        type: "user",
        uuid: "a",
        message: { role: "user", content: "hi" },
      }),
    ].join("\n");
    const diag = diagnoseClaudeSession(text);
    expect(diag.brokenLinks).toHaveLength(0);
  });

  test("detects orphaned tail after messageCount drop", () => {
    const text = [
      line({ type: "system", subtype: "turn_duration", uuid: "td1", messageCount: 500, timestamp: "2026-05-25T10:00:00Z" }),
      line({ type: "user", uuid: "u1", parentUuid: "td1", message: { role: "user", content: "good msg" } }),
      line({ type: "system", subtype: "turn_duration", uuid: "td2", messageCount: 510, timestamp: "2026-05-25T10:01:00Z" }),
      line({ type: "last-prompt", lastPrompt: "something" }),
      line({ type: "ai-title", aiTitle: "test" }),
      line({ type: "user", uuid: "u2", parentUuid: "td2", message: { role: "user", content: "amnesiac" } }),
      line({ type: "system", subtype: "turn_duration", uuid: "td3", messageCount: 5, timestamp: "2026-05-25T10:02:00Z" }),
    ].join("\n");
    const diag = diagnoseClaudeSession(text);
    expect(diag.orphanedTail).not.toBeNull();
    expect(diag.orphanedTail!.messageCountBefore).toBe(510);
    expect(diag.orphanedTail!.messageCountAfter).toBe(5);
    expect(diag.orphanedTail!.lineCount).toBeGreaterThan(0);
  });

  test("no orphaned tail when messageCount is stable", () => {
    const text = [
      line({ type: "system", subtype: "turn_duration", uuid: "td1", messageCount: 100, timestamp: "2026-05-25T10:00:00Z" }),
      line({ type: "system", subtype: "turn_duration", uuid: "td2", messageCount: 110, timestamp: "2026-05-25T10:01:00Z" }),
    ].join("\n");
    const diag = diagnoseClaudeSession(text);
    expect(diag.orphanedTail).toBeNull();
  });
});

describe("repairClaudeSession", () => {
  test("inserts a synthetic node to bridge a broken link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-"));
    const file = join(dir, "session.jsonl");
    const lines = makeChain();
    lines.splice(2, 1); // remove uuid=ccc
    await writeFile(file, lines.join("\n") + "\n");

    const result = await repairClaudeSession(file);
    expect(result.repaired).toBe(1);
    expect(result.backupPath).toMatch(/\.bak$/);

    const repaired = await readFile(file, "utf-8");
    const repairedLines = repaired.split("\n").filter(Boolean);
    expect(repairedLines).toHaveLength(4); // 3 original + 1 inserted

    // The inserted line should have uuid=ccc and parentUuid=bbb
    const inserted = repairedLines.map((l) => JSON.parse(l)).find(
      (o: Record<string, unknown>) => o.uuid === "ccc",
    );
    expect(inserted).toBeDefined();
    expect(inserted.parentUuid).toBe("bbb");
    expect(inserted.type).toBe("user");
    // The repair marker should be present in the tool_result content
    const content = inserted.message?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]?.type).toBe("tool_result");
  });

  test("creates a .bak backup before modifying", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-"));
    const file = join(dir, "session.jsonl");
    const lines = makeChain();
    lines.splice(2, 1);
    const original = lines.join("\n") + "\n";
    await writeFile(file, original);

    const result = await repairClaudeSession(file);
    const backup = await readFile(result.backupPath, "utf-8");
    expect(backup).toBe(original);
  });

  test("returns repaired=0 for a healthy session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, makeChain().join("\n") + "\n");

    const result = await repairClaudeSession(file);
    expect(result.repaired).toBe(0);
    expect(result.backupPath).toBe("");
    expect(result.trimmedLines).toBe(0);
  });

  test("trims orphaned tail after chain repair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-"));
    const file = join(dir, "session.jsonl");
    // Simulate: healthy session → break → amnesiac messages
    const lines = [
      line({ type: "user", uuid: "u1", message: { role: "user", content: "start" }, timestamp: "2026-05-25T10:00:00Z", sessionId: "S", cwd: "/r", slug: "s" }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, timestamp: "2026-05-25T10:00:01Z", sessionId: "S", cwd: "/r", slug: "s" }),
      line({ type: "system", subtype: "turn_duration", uuid: "td1", parentUuid: "a1", messageCount: 200, timestamp: "2026-05-25T10:00:02Z" }),
      // Missing tool result (uuid=tr1, parentUuid=a1) — referenced by a2
      line({ type: "assistant", uuid: "a2", parentUuid: "tr1", message: { role: "assistant", content: "disk space" }, timestamp: "2026-05-25T10:00:03Z", sessionId: "S", cwd: "/r", slug: "s" }),
      line({ type: "system", subtype: "turn_duration", uuid: "td2", parentUuid: "a2", messageCount: 210, timestamp: "2026-05-25T10:00:04Z" }),
      // Amnesiac messages after the break
      line({ type: "last-prompt", lastPrompt: "test" }),
      line({ type: "user", uuid: "u2", parentUuid: "td2", message: { role: "user", content: "what" }, timestamp: "2026-05-25T10:01:00Z", sessionId: "S", cwd: "/r", slug: "s" }),
      line({ type: "assistant", uuid: "a3", parentUuid: "u2", message: { role: "assistant", content: "I have no history" }, timestamp: "2026-05-25T10:01:01Z", sessionId: "S", cwd: "/r", slug: "s" }),
      line({ type: "system", subtype: "turn_duration", uuid: "td3", parentUuid: "a3", messageCount: 5, timestamp: "2026-05-25T10:01:02Z" }),
    ];
    await writeFile(file, lines.join("\n") + "\n");

    const result = await repairClaudeSession(file);
    expect(result.repaired).toBe(1); // fixed broken chain
    expect(result.trimmedLines).toBeGreaterThan(0); // trimmed amnesiac tail

    const repaired = await readFile(file, "utf-8");
    const repairedLines = repaired.split("\n").filter(Boolean);
    // Should NOT contain the amnesiac messages
    const hasAmnesiac = repairedLines.some((l) => {
      try { return JSON.parse(l).uuid === "u2" || JSON.parse(l).uuid === "a3"; }
      catch { return false; }
    });
    expect(hasAmnesiac).toBe(false);
  });

  test("repairs multiple broken links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "repair-"));
    const file = join(dir, "session.jsonl");
    // Build a longer chain with two missing nodes
    const lines = [
      line({
        type: "user", uuid: "1", message: { role: "user", content: "a" },
        timestamp: "2026-05-25T10:00:00Z", sessionId: "S-1", cwd: "/r", slug: "s",
      }),
      line({
        type: "assistant", uuid: "2", parentUuid: "1",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        timestamp: "2026-05-25T10:00:01Z", sessionId: "S-1", cwd: "/r", slug: "s",
      }),
      // missing uuid=3 (parentUuid=2, referenced by uuid=4)
      line({
        type: "assistant", uuid: "4", parentUuid: "3",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
        timestamp: "2026-05-25T10:00:03Z", sessionId: "S-1", cwd: "/r", slug: "s",
      }),
      // missing uuid=5 (parentUuid=4, referenced by uuid=6)
      line({
        type: "assistant", uuid: "6", parentUuid: "5",
        message: { role: "assistant", content: "done" },
        timestamp: "2026-05-25T10:00:05Z", sessionId: "S-1", cwd: "/r", slug: "s",
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n");

    const result = await repairClaudeSession(file);
    expect(result.repaired).toBe(2);

    const repaired = await readFile(file, "utf-8");
    const repairedLines = repaired.split("\n").filter(Boolean);
    expect(repairedLines).toHaveLength(6); // 4 original + 2 inserted
  });
});
