import { test, expect, describe } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorLog } from "../src/errors";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-errors-"));
}

describe("ErrorLog", () => {
  test("starts empty when first opened", async () => {
    const log = await ErrorLog.open(await tempDir());
    expect(await log.list()).toEqual([]);
  });

  test("append returns the entry with id and timestamp", async () => {
    const log = await ErrorLog.open(await tempDir());
    const e = await log.append({
      kind: "server",
      source: "daemon",
      route: "/api/repos",
      method: "GET",
      status: 500,
      message: "boom",
      stack: "Error: boom\n  at x",
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(e.timestamp)).not.toBeNaN();
    expect(e.message).toBe("boom");
  });

  test("list returns most-recent first", async () => {
    const log = await ErrorLog.open(await tempDir());
    await log.append({ kind: "server", source: "daemon", message: "a" });
    await log.append({ kind: "server", source: "daemon", message: "b" });
    const all = await log.list();
    expect(all.map((e) => e.message)).toEqual(["b", "a"]);
  });

  test("list respects limit (default cap)", async () => {
    const log = await ErrorLog.open(await tempDir());
    for (let i = 0; i < 10; i++) {
      await log.append({
        kind: "server",
        source: "daemon",
        message: `m${i}`,
      });
    }
    const five = await log.list({ limit: 5 });
    expect(five.length).toBe(5);
    expect(five[0]?.message).toBe("m9");
    expect(five[4]?.message).toBe("m5");
  });

  test("clear empties the log", async () => {
    const log = await ErrorLog.open(await tempDir());
    await log.append({ kind: "server", source: "daemon", message: "a" });
    await log.clear();
    expect(await log.list()).toEqual([]);
  });

  test("persists across re-open of the same workspace", async () => {
    const dir = await tempDir();
    const log1 = await ErrorLog.open(dir);
    await log1.append({ kind: "server", source: "daemon", message: "a" });
    const log2 = await ErrorLog.open(dir);
    expect((await log2.list()).map((e) => e.message)).toEqual(["a"]);
  });

  test("ignores malformed lines on read (does not throw)", async () => {
    const log = await ErrorLog.open(await tempDir());
    await log.append({ kind: "server", source: "daemon", message: "ok" });
    // Manually corrupt the log with a junk line; list() should skip it.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(log.path, "not-json\n");
    const all = await log.list();
    expect(all.map((e) => e.message)).toEqual(["ok"]);
  });
});
