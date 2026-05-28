import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OllamaSessionsLog } from "../src/ollama-sessions";

describe("OllamaSessionsLog", () => {
  let workspace: string;
  let log: OllamaSessionsLog;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "supergit-ollama-"));
    log = await OllamaSessionsLog.open(workspace);
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("appendTurn writes one line per call", async () => {
    await log.writeHeader({
      kind: "header",
      termId: "t1",
      wt: "/p",
      spawnCwd: "/p",
      model: "qwen3-coder:30b",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await log.appendTurn("t1", {
      kind: "turn",
      ts: "2026-01-01T00:00:01Z",
      role: "user",
      content: "hello",
      model: "qwen3-coder:30b",
    });
    await log.appendTurn("t1", {
      kind: "turn",
      ts: "2026-01-01T00:00:02Z",
      role: "assistant",
      content: "hi back",
      model: "qwen3-coder:30b",
    });
    const raw = await readFile(join(workspace, "ollama", "t1.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3); // header + 2 turns
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]!.kind).toBe("header");
    expect(parsed[1]!.kind).toBe("turn");
    expect(parsed[1]!.role).toBe("user");
    expect(parsed[2]!.role).toBe("assistant");
  });

  test("concurrent appends never interleave bytes mid-line", async () => {
    // The serialize mutex guarantees whole-line writes even when many
    // appendTurn calls fire without awaiting between them. Without
    // serialization, two fs.appendFile racers can interleave their
    // payloads and produce a corrupt JSONL.
    await log.writeHeader({
      kind: "header",
      termId: "race",
      wt: "/p",
      spawnCwd: "/p",
      model: "m",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(
        log.appendTurn("race", {
          kind: "turn",
          ts: "2026-01-01T00:00:00Z",
          role: i % 2 === 0 ? "user" : "assistant",
          content: `payload-${i.toString().padStart(4, "0")}`.repeat(64),
          model: "m",
        }),
      );
    }
    await Promise.all(writes);
    const raw = await readFile(
      join(workspace, "ollama", "race.jsonl"),
      "utf-8",
    );
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(51); // header + 50 turns
    // Every line must parse cleanly — interleaved bytes would surface
    // as a JSON.parse throw on at least one line.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("readMessagesForChat returns turns + model for API sessions", async () => {
    await log.writeHeader({
      kind: "header",
      termId: "api1",
      wt: "/p",
      spawnCwd: "/p",
      model: "qwen3-coder:30b",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await log.appendTurn("api1", {
      kind: "turn",
      ts: "2026-01-01T00:00:01Z",
      role: "user",
      content: "q1",
      model: "qwen3-coder:30b",
    });
    await log.appendTurn("api1", {
      kind: "turn",
      ts: "2026-01-01T00:00:02Z",
      role: "assistant",
      content: "a1",
      model: "qwen3-coder:30b",
    });
    const out = await log.readMessagesForChat("api1");
    expect(out).not.toBeNull();
    expect(out!.model).toBe("qwen3-coder:30b");
    expect(out!.messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  test("readMessagesForChat returns null for missing files", async () => {
    expect(await log.readMessagesForChat("missing")).toBeNull();
  });

  test("readMessagesForChat tracks per-turn model overrides", async () => {
    await log.writeHeader({
      kind: "header",
      termId: "multi",
      wt: "/p",
      spawnCwd: "/p",
      model: "gemma4:latest",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await log.appendTurn("multi", {
      kind: "turn",
      ts: "2026-01-01T00:00:01Z",
      role: "user",
      content: "q1",
    });
    await log.appendTurn("multi", {
      kind: "turn",
      ts: "2026-01-01T00:00:02Z",
      role: "assistant",
      content: "g",
      model: "gemma4:latest",
    });
    await log.appendTurn("multi", {
      kind: "turn",
      ts: "2026-01-01T00:00:03Z",
      role: "user",
      content: "switched to qwen",
      model: "qwen3-coder:30b",
    });
    const out = await log.readMessagesForChat("multi");
    expect(out).not.toBeNull();
    // Active model = most recent turn's model (qwen took over).
    expect(out!.model).toBe("qwen3-coder:30b");
    expect(out!.messages.map((m) => m.content)).toEqual([
      "q1",
      "g",
      "switched to qwen",
    ]);
  });

  test("rejects path traversal in termId", async () => {
    expect(
      log.writeHeader({
        kind: "header",
        termId: "../escape",
        wt: "/p",
        spawnCwd: "/p",
        model: "m",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ).rejects.toThrow(/invalid termId/);
  });
});
