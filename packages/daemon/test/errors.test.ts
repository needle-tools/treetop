import { test, expect, describe } from "bun:test";
import { appendFile, mkdtemp, stat } from "node:fs/promises";
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

  test("list clamps oversized limits to the configured cap", async () => {
    const log = await ErrorLog.open(await tempDir(), { defaultLimit: 3 });
    for (let i = 0; i < 10; i++) {
      await log.append({
        kind: "server",
        source: "daemon",
        message: `m${i}`,
      });
    }

    const all = await log.list({ limit: 10_000 });

    expect(all.map((e) => e.message)).toEqual(["m9", "m8", "m7"]);
  });

  test("append truncates oversized entries before persisting them", async () => {
    const log = await ErrorLog.open(await tempDir(), {
      maxEntryBytes: 1024,
      maxExtraBytes: 256,
      maxMessageChars: 128,
      maxStackChars: 128,
    });

    const entry = await log.append({
      kind: "diagnostic",
      source: "browser",
      message: "m".repeat(10_000),
      stack: "s".repeat(10_000),
      extra: { blob: "x".repeat(10_000) },
    });
    const size = (await stat(log.path)).size;

    expect(size).toBeLessThanOrEqual(1024 + 1);
    expect(entry.message.length).toBeLessThan(10_000);
    expect(entry.message).toContain("truncated");
    expect(entry.stack?.length).toBeLessThan(10_000);
    expect(entry.extra).toEqual(
      expect.objectContaining({ truncated: true }),
    );
    expect((await log.list()).length).toBe(1);
  });

  test("open prunes an oversized persisted log to a recent tail", async () => {
    const dir = await tempDir();
    const bootstrap = await ErrorLog.open(dir, {
      maxBytes: 10_000,
      pruneTargetBytes: 4096,
    });
    for (let i = 0; i < 100; i++) {
      await appendFile(
        bootstrap.path,
        JSON.stringify({
          id: `old-${i}`,
          timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
          kind: "server",
          source: "daemon",
          message: `old-${i}`,
          extra: { padding: "x".repeat(512) },
        }) + "\n",
      );
    }
    await appendFile(
      bootstrap.path,
      JSON.stringify({
        id: "recent",
        timestamp: new Date().toISOString(),
        kind: "server",
        source: "daemon",
        message: "recent",
      }) + "\n",
    );
    expect((await stat(bootstrap.path)).size).toBeGreaterThan(10_000);

    const log = await ErrorLog.open(dir, {
      maxBytes: 10_000,
      pruneTargetBytes: 4096,
    });

    expect((await stat(log.path)).size).toBeLessThanOrEqual(4096);
    expect((await log.list()).map((e) => e.message)).toContain("recent");
  });

  test("list reads the newest bounded page from a large historical log", async () => {
    const log = await ErrorLog.open(await tempDir());
    const oldTimestamp = new Date(Date.now() - 2 * 3600_000).toISOString();
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          id: `old-${i}`,
          timestamp: oldTimestamp,
          kind: "server",
          source: "daemon",
          message: `old-${i}`,
          extra: { padding: "x".repeat(512) },
        }),
      );
    }
    await appendFile(log.path, lines.join("\n") + "\n");
    await log.append({ kind: "server", source: "daemon", message: "new-0" });
    await log.append({ kind: "server", source: "daemon", message: "new-1" });

    const recent = await log.list({ limit: 2 });

    expect(recent.map((entry) => entry.message)).toEqual(["new-1", "new-0"]);
  });

  test("list omits entries older than 24h", async () => {
    const log = await ErrorLog.open(await tempDir());
    await log.append({ kind: "server", source: "daemon", message: "fresh" });
    // Inject a stale line directly (append() always stamps `now`).
    const { appendFile } = await import("node:fs/promises");
    const stale = {
      id: "stale",
      timestamp: new Date(Date.now() - 25 * 3600_000).toISOString(),
      kind: "server",
      source: "daemon",
      message: "ancient",
    };
    await appendFile(log.path, JSON.stringify(stale) + "\n");
    const all = await log.list();
    expect(all.map((e) => e.message)).toEqual(["fresh"]);
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
