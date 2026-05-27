import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { TerminalPersist, type PersistedTerminal } from "../src/terminal-persist";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "supergit-term-persist-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("TerminalPersist", () => {
  test("list returns empty when no file exists", async () => {
    const tp = new TerminalPersist(join(tmpDir, "empty"));
    expect(await tp.list()).toEqual([]);
  });

  test("save and list round-trip", async () => {
    const dir = join(tmpDir, "roundtrip");
    const tp = new TerminalPersist(dir);

    await tp.save({
      termId: "t_abc",
      cmd: ["sh", "-c", "ssh needle@host"],
      cwd: "/Users/me/repo",
      wtPath: "/Users/me/repo",
      title: "ssh NUC win",
    });

    const list = await tp.list();
    expect(list.length).toBe(1);
    expect(list[0]!.termId).toBe("t_abc");
    expect(list[0]!.cmd).toEqual(["sh", "-c", "ssh needle@host"]);
    expect(list[0]!.title).toBe("ssh NUC win");
  });

  test("save multiple terminals", async () => {
    const dir = join(tmpDir, "multi");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["ssh", "a@b"], cwd: "/a", wtPath: "/a" });
    await tp.save({ termId: "t2", cmd: ["ssh", "c@d"], cwd: "/b", wtPath: "/b", title: "server" });

    const list = await tp.list();
    expect(list.length).toBe(2);
  });

  test("remove deletes by termId", async () => {
    const dir = join(tmpDir, "remove");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["ssh", "a@b"], cwd: "/a", wtPath: "/a" });
    await tp.save({ termId: "t2", cmd: ["ssh", "c@d"], cwd: "/b", wtPath: "/b" });

    await tp.remove("t1");
    const list = await tp.list();
    expect(list.length).toBe(1);
    expect(list[0]!.termId).toBe("t2");
  });

  test("remove non-existent is a no-op", async () => {
    const dir = join(tmpDir, "noop");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["ssh", "a@b"], cwd: "/a", wtPath: "/a" });
    await tp.remove("t_nonexistent");

    const list = await tp.list();
    expect(list.length).toBe(1);
  });

  test("clear removes all", async () => {
    const dir = join(tmpDir, "clear");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["a"], cwd: "/", wtPath: "/" });
    await tp.save({ termId: "t2", cmd: ["b"], cwd: "/", wtPath: "/" });
    await tp.clear();

    expect(await tp.list()).toEqual([]);
  });

  test("duplicate termId overwrites", async () => {
    const dir = join(tmpDir, "dup");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["old"], cwd: "/", wtPath: "/" });
    await tp.save({ termId: "t1", cmd: ["new"], cwd: "/", wtPath: "/", title: "updated" });

    const list = await tp.list();
    expect(list.length).toBe(1);
    expect(list[0]!.cmd).toEqual(["new"]);
    expect(list[0]!.title).toBe("updated");
  });

  test("survives read-after-clear (restore card with empty backing)", async () => {
    const dir = join(tmpDir, "survive-clear");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["ssh", "a@b"], cwd: "/a", wtPath: "/a", title: "server" });

    // Simulate: UI reads entries
    const entries = await tp.list();
    expect(entries.length).toBe(1);
    expect(entries[0]!.cmd).toEqual(["ssh", "a@b"]);
    expect(entries[0]!.title).toBe("server");

    // Simulate: individual remove (not clear-all)
    await tp.remove("t1");
    expect(await tp.list()).toEqual([]);
  });

  test("individual remove preserves other entries", async () => {
    const dir = join(tmpDir, "partial-remove");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["ssh", "a@b"], cwd: "/a", wtPath: "/a" });
    await tp.save({ termId: "t2", cmd: ["ssh", "c@d"], cwd: "/b", wtPath: "/b" });

    await tp.remove("t1");
    const remaining = await tp.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.termId).toBe("t2");
  });

  test("atomic write survives concurrent access", async () => {
    const dir = join(tmpDir, "concurrent");
    const tp = new TerminalPersist(dir);

    await Promise.all([
      tp.save({ termId: "t1", cmd: ["a"], cwd: "/", wtPath: "/" }),
      tp.save({ termId: "t2", cmd: ["b"], cwd: "/", wtPath: "/" }),
      tp.save({ termId: "t3", cmd: ["c"], cwd: "/", wtPath: "/" }),
    ]);

    const list = await tp.list();
    expect(list.length).toBe(3);
  });
});
