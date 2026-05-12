import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellsLog } from "../src/shells";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-shells-"));
}

describe("ShellsLog", () => {
  test("creates the shells/ directory on open and starts empty", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    const entries = await readdir(log.dir);
    expect(entries).toEqual([]);
    expect(log.dir).toBe(join(ws, "shells"));
  });

  test("open is idempotent — second call doesn't throw if the dir exists", async () => {
    const ws = await tempWorkspace();
    await ShellsLog.open(ws);
    // The second open MUST NOT error out — daemon restart hits this path.
    const again = await ShellsLog.open(ws);
    expect(again.dir).toBe(join(ws, "shells"));
  });

  test("writeHeader persists a header line in <termId>.jsonl", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await log.writeHeader({
      kind: "header",
      termId: "t-abc-123",
      wt: "/Users/me/git/foo",
      spawnCwd: "/Users/me/git/foo",
      createdAt: "2026-05-13T01:00:00Z",
    });
    const file = await readFile(join(log.dir, "t-abc-123.jsonl"), "utf-8");
    const parsed = JSON.parse(file.trim());
    expect(parsed.kind).toBe("header");
    expect(parsed.termId).toBe("t-abc-123");
    expect(parsed.wt).toBe("/Users/me/git/foo");
  });

  test("readHeader round-trips the written header", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    const h = {
      kind: "header" as const,
      termId: "t-abc-123",
      wt: "/x",
      spawnCwd: "/x",
      createdAt: "2026-05-13T01:00:00Z",
    };
    await log.writeHeader(h);
    expect(await log.readHeader("t-abc-123")).toEqual(h);
  });

  test("readHeader returns null for an unknown termId", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    expect(await log.readHeader("not-there")).toBeNull();
  });

  test("listHeaders enumerates every shell file in the dir", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await log.writeHeader({
      kind: "header",
      termId: "a",
      wt: "/x",
      spawnCwd: "/x",
      createdAt: "t1",
    });
    await log.writeHeader({
      kind: "header",
      termId: "b",
      wt: "/y",
      spawnCwd: "/y",
      createdAt: "t2",
    });
    const all = await log.listHeaders();
    expect(all.map((h) => h.termId).sort()).toEqual(["a", "b"]);
  });

  test("listHeaders ignores files whose first line isn't a valid header", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    // Direct write of garbage so we don't go through writeHeader.
    await (await import("node:fs/promises")).writeFile(
      join(log.dir, "garbage.jsonl"),
      "not json\n",
    );
    expect(await log.listHeaders()).toEqual([]);
  });

  test("rejects path-traversal termIds", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await expect(
      log.writeHeader({
        kind: "header",
        termId: "../escape",
        wt: "/x",
        spawnCwd: "/x",
        createdAt: "t",
      }),
    ).rejects.toThrow(/invalid termId/);
  });

  test("append writes exit entries that survive alongside the header", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await log.writeHeader({
      kind: "header",
      termId: "t",
      wt: "/x",
      spawnCwd: "/x",
      createdAt: "t-now",
    });
    await log.append("t", { kind: "exit", ts: "t-later", code: 0 });
    const text = await readFile(join(log.dir, "t.jsonl"), "utf-8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("header");
    expect(JSON.parse(lines[1]!).kind).toBe("exit");
  });

  test("readTranscript reconstructs header + commands + exit + lastCwd", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await log.writeHeader({
      kind: "header",
      termId: "t",
      wt: "/wt",
      spawnCwd: "/wt",
      createdAt: "t0",
    });
    await log.append("t", { kind: "cmd", ts: "t1", line: "ls", cwd: "/wt" });
    await log.append("t", {
      kind: "cmd",
      ts: "t2",
      line: "cd sub && echo hi",
      cwd: "/wt/sub",
    });
    await log.append("t", { kind: "exit", ts: "t3", code: 0 });

    const tr = await log.readTranscript("t");
    expect(tr).not.toBeNull();
    expect(tr!.header.termId).toBe("t");
    expect(tr!.cmds.map((c) => c.line)).toEqual(["ls", "cd sub && echo hi"]);
    expect(tr!.exit?.code).toBe(0);
    // Last cwd should reflect where the user `cd`-ed to, not the spawn dir.
    expect(tr!.lastCwd).toBe("/wt/sub");
  });

  test("readTranscript falls back to spawnCwd when no cmds were captured", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await log.writeHeader({
      kind: "header",
      termId: "t",
      wt: "/wt",
      spawnCwd: "/wt",
      createdAt: "t0",
    });
    const tr = await log.readTranscript("t");
    expect(tr).not.toBeNull();
    expect(tr!.cmds).toEqual([]);
    expect(tr!.lastCwd).toBe("/wt");
  });

  test("readTranscript returns null for an unknown termId", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    expect(await log.readTranscript("nope")).toBeNull();
  });
});
