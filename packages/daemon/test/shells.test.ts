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

  test("cmdSummary reports count plus the latest cmd line and timestamp", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    await log.writeHeader({
      kind: "header",
      termId: "t",
      wt: "/wt",
      spawnCwd: "/wt",
      createdAt: "t0",
    });
    expect(await log.cmdSummary("t")).toEqual({ count: 0 });
    await log.append("t", { kind: "cmd", ts: "t1", line: "ls", cwd: "/wt" });
    await log.append("t", { kind: "cmd", ts: "t2", line: "pwd", cwd: "/wt" });
    await log.append("t", { kind: "exit", ts: "t3", code: 0 });
    expect(await log.cmdSummary("t")).toEqual({
      count: 2,
      lastLine: "pwd",
      lastTs: "t2",
    });
  });

  test("cmdSummary returns count 0 for an unknown termId", async () => {
    const ws = await tempWorkspace();
    const log = await ShellsLog.open(ws);
    expect(await log.cmdSummary("nope")).toEqual({ count: 0 });
  });

  describe("Resume carry-over (writeHeader with previousTermId)", () => {
    test("new file contains prior cmd lines + a resume marker + new header", async () => {
      const ws = await tempWorkspace();
      const log = await ShellsLog.open(ws);
      // Seed prior session: header + two cmds + exit
      await log.writeHeader({
        kind: "header",
        termId: "t-prev",
        wt: "/w",
        spawnCwd: "/w",
        createdAt: "2026-05-13T00:00:00Z",
      });
      await log.append("t-prev", { kind: "cmd", ts: "t1", line: "ls", cwd: "/w" });
      await log.append("t-prev", { kind: "cmd", ts: "t2", line: "pwd", cwd: "/w" });
      await log.append("t-prev", { kind: "exit", ts: "t3", code: 0 });

      // Resume into a new shell, passing the prior termId.
      await log.writeHeader(
        {
          kind: "header",
          termId: "t-new",
          wt: "/w",
          spawnCwd: "/w",
          createdAt: "2026-05-13T01:00:00Z",
        },
        "t-prev",
      );

      const content = await readFile(join(log.dir, "t-new.jsonl"), "utf-8");
      const lines = content.trim().split("\n").map((l) => JSON.parse(l));
      // Expected order: carried cmds → resume marker → new header.
      // Prior header and exit are NOT carried (would confuse readTranscript).
      expect(lines.map((l) => l.kind)).toEqual([
        "cmd",
        "cmd",
        "resume",
        "header",
      ]);
      expect(lines[0].line).toBe("ls");
      expect(lines[1].line).toBe("pwd");
      expect(lines[2].fromTermId).toBe("t-prev");
      expect(lines[3].termId).toBe("t-new");
    });

    test("readTranscript on the resumed file shows carried cmds under the new header", async () => {
      const ws = await tempWorkspace();
      const log = await ShellsLog.open(ws);
      await log.writeHeader({
        kind: "header",
        termId: "t-prev",
        wt: "/w",
        spawnCwd: "/w",
        createdAt: "2026-05-13T00:00:00Z",
      });
      await log.append("t-prev", { kind: "cmd", ts: "t1", line: "ls", cwd: "/w" });
      await log.writeHeader(
        {
          kind: "header",
          termId: "t-new",
          wt: "/w",
          spawnCwd: "/w",
          createdAt: "2026-05-13T01:00:00Z",
        },
        "t-prev",
      );
      await log.append("t-new", { kind: "cmd", ts: "t2", line: "pwd", cwd: "/w" });

      const t = await log.readTranscript("t-new");
      expect(t).not.toBeNull();
      expect(t!.header.termId).toBe("t-new"); // new header wins, not carried
      expect(t!.cmds.map((c) => c.line)).toEqual(["ls", "pwd"]);
      expect(t!.exit).toBeNull(); // no exit yet — resume is still alive
      expect(t!.lastCwd).toBe("/w");
    });

    test("chains across multiple resumes — order preserved", async () => {
      const ws = await tempWorkspace();
      const log = await ShellsLog.open(ws);
      // Session A
      await log.writeHeader({
        kind: "header", termId: "A", wt: "/w", spawnCwd: "/w",
        createdAt: "2026-05-13T00:00:00Z",
      });
      await log.append("A", { kind: "cmd", ts: "a1", line: "echo A", cwd: "/w" });
      // Resume → Session B
      await log.writeHeader(
        {
          kind: "header", termId: "B", wt: "/w", spawnCwd: "/w",
          createdAt: "2026-05-13T01:00:00Z",
        },
        "A",
      );
      await log.append("B", { kind: "cmd", ts: "b1", line: "echo B", cwd: "/w" });
      // Resume → Session C
      await log.writeHeader(
        {
          kind: "header", termId: "C", wt: "/w", spawnCwd: "/w",
          createdAt: "2026-05-13T02:00:00Z",
        },
        "B",
      );
      await log.append("C", { kind: "cmd", ts: "c1", line: "echo C", cwd: "/w" });

      const t = await log.readTranscript("C");
      expect(t).not.toBeNull();
      expect(t!.cmds.map((c) => c.line)).toEqual(["echo A", "echo B", "echo C"]);
      expect(t!.header.termId).toBe("C");
    });

    test("missing prior file is a no-op (just writes the new header)", async () => {
      const ws = await tempWorkspace();
      const log = await ShellsLog.open(ws);
      await log.writeHeader(
        {
          kind: "header", termId: "t-new", wt: "/w", spawnCwd: "/w",
          createdAt: "2026-05-13T00:00:00Z",
        },
        "t-does-not-exist",
      );
      const t = await log.readTranscript("t-new");
      expect(t).not.toBeNull();
      expect(t!.header.termId).toBe("t-new");
      expect(t!.cmds).toEqual([]);
    });

    test("undefined previousTermId behaves like the no-resume path", async () => {
      const ws = await tempWorkspace();
      const log = await ShellsLog.open(ws);
      await log.writeHeader({
        kind: "header", termId: "t-fresh", wt: "/w", spawnCwd: "/w",
        createdAt: "2026-05-13T00:00:00Z",
      });
      const t = await log.readTranscript("t-fresh");
      expect(t!.cmds).toEqual([]);
    });
  });
});
