import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  TerminalPersist,
  terminalCreatedAt,
  prunePersistedTerminals,
  type PersistedTerminal,
} from "../src/terminal-persist";
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

    await tp.save({
      termId: "t1",
      cmd: ["ssh", "a@b"],
      cwd: "/a",
      wtPath: "/a",
    });
    await tp.save({
      termId: "t2",
      cmd: ["ssh", "c@d"],
      cwd: "/b",
      wtPath: "/b",
      title: "server",
    });

    const list = await tp.list();
    expect(list.length).toBe(2);
  });

  test("remove deletes by termId", async () => {
    const dir = join(tmpDir, "remove");
    const tp = new TerminalPersist(dir);

    await tp.save({
      termId: "t1",
      cmd: ["ssh", "a@b"],
      cwd: "/a",
      wtPath: "/a",
    });
    await tp.save({
      termId: "t2",
      cmd: ["ssh", "c@d"],
      cwd: "/b",
      wtPath: "/b",
    });

    await tp.remove("t1");
    const list = await tp.list();
    expect(list.length).toBe(1);
    expect(list[0]!.termId).toBe("t2");
  });

  test("remove non-existent is a no-op", async () => {
    const dir = join(tmpDir, "noop");
    const tp = new TerminalPersist(dir);

    await tp.save({
      termId: "t1",
      cmd: ["ssh", "a@b"],
      cwd: "/a",
      wtPath: "/a",
    });
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
    await tp.save({
      termId: "t1",
      cmd: ["new"],
      cwd: "/",
      wtPath: "/",
      title: "updated",
    });

    const list = await tp.list();
    expect(list.length).toBe(1);
    expect(list[0]!.cmd).toEqual(["new"]);
    expect(list[0]!.title).toBe("updated");
  });

  test("survives read-after-clear (restore card with empty backing)", async () => {
    const dir = join(tmpDir, "survive-clear");
    const tp = new TerminalPersist(dir);

    await tp.save({
      termId: "t1",
      cmd: ["ssh", "a@b"],
      cwd: "/a",
      wtPath: "/a",
      title: "server",
    });

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

    await tp.save({
      termId: "t1",
      cmd: ["ssh", "a@b"],
      cwd: "/a",
      wtPath: "/a",
    });
    await tp.save({
      termId: "t2",
      cmd: ["ssh", "c@d"],
      cwd: "/b",
      wtPath: "/b",
    });

    await tp.remove("t1");
    const remaining = await tp.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.termId).toBe("t2");
  });

  test("updateLastCmd stores the last typed command", async () => {
    const dir = join(tmpDir, "lastcmd");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["cmd.exe"], cwd: "/a", wtPath: "/a" });
    await tp.updateLastCmd("t1", "ssh needle@100.71.105.118");

    const list = await tp.list();
    expect(list[0]!.lastCmd).toBe("ssh needle@100.71.105.118");
  });

  test("updateLastCmd is a no-op for unknown termId", async () => {
    const dir = join(tmpDir, "lastcmd-noop");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["bash"], cwd: "/", wtPath: "/" });
    await tp.updateLastCmd("t_unknown", "some command");

    const list = await tp.list();
    expect(list[0]!.lastCmd).toBeUndefined();
  });

  test("updateLastCmd overwrites lastCmd but firstCmd is set once", async () => {
    const dir = join(tmpDir, "lastcmd-overwrite");
    const tp = new TerminalPersist(dir);

    await tp.save({ termId: "t1", cmd: ["bash"], cwd: "/", wtPath: "/" });
    await tp.updateLastCmd("t1", "ssh user@host");
    await tp.updateLastCmd("t1", "cd /var/log");
    await tp.updateLastCmd("t1", "tail -f syslog");

    const list = await tp.list();
    expect(list[0]!.firstCmd).toBe("ssh user@host");
    expect(list[0]!.lastCmd).toBe("tail -f syslog");
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

// A termId as the daemon mints it: `t_<base36(spawnMs)>_<counter>`.
const idAt = (ms: number, n: number): string => `t_${ms.toString(36)}_${n}`;
const entryAt = (ms: number, n: number): PersistedTerminal => ({
  termId: idAt(ms, n),
  cmd: ["cmd.exe"],
  cwd: "C:/repo",
  wtPath: "C:/repo",
});

describe("terminalCreatedAt", () => {
  test("decodes the base36 spawn time from a real termId", () => {
    const ms = Date.parse("2026-07-11T12:34:26.852Z");
    expect(terminalCreatedAt(idAt(ms, 47))).toBe(ms);
    // Tolerates the extra hash segment resumed terminals carry.
    expect(terminalCreatedAt(`t_${ms.toString(36)}_47_2b78064b`)).toBe(ms);
  });

  test("returns null for ids that don't fit the shape or decode implausibly", () => {
    expect(terminalCreatedAt("weird")).toBeNull();
    expect(terminalCreatedAt("t_zzz_1")).toBeNull(); // decodes far in the past
  });
});

describe("prunePersistedTerminals", () => {
  const NOW = Date.parse("2026-07-11T12:00:00.000Z");
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  test("drops entries older than maxAgeMs", () => {
    const entries = [
      entryAt(NOW - 1 * HOUR, 1),
      entryAt(NOW - 5 * DAY, 2), // stale
      entryAt(NOW - 2 * HOUR, 3),
    ];
    const kept = prunePersistedTerminals(entries, {
      now: NOW,
      maxAgeMs: 48 * HOUR,
      maxEntries: 100,
    });
    expect(kept.map((e) => e.termId)).toEqual([
      idAt(NOW - 1 * HOUR, 1),
      idAt(NOW - 2 * HOUR, 3),
    ]);
  });

  test("keeps only the most-recent maxEntries and preserves file order", () => {
    const entries = [
      entryAt(NOW - 3 * HOUR, 1),
      entryAt(NOW - 1 * HOUR, 2),
      entryAt(NOW - 2 * HOUR, 3),
    ];
    const kept = prunePersistedTerminals(entries, {
      now: NOW,
      maxAgeMs: 48 * HOUR,
      maxEntries: 2,
    });
    // Newest two are #2 (1h) and #3 (2h); output keeps original order (2 then 3).
    expect(kept.map((e) => e.termId)).toEqual([
      idAt(NOW - 1 * HOUR, 2),
      idAt(NOW - 2 * HOUR, 3),
    ]);
  });

  test("a no-op when everything is fresh and under the cap", () => {
    const entries = [entryAt(NOW - 1 * HOUR, 1), entryAt(NOW - 2 * HOUR, 2)];
    const kept = prunePersistedTerminals(entries, {
      now: NOW,
      maxAgeMs: 48 * HOUR,
      maxEntries: 25,
    });
    expect(kept).toEqual(entries);
  });

  test("unknown-age entries are never age-dropped but still count against the cap", () => {
    const entries = [
      { termId: "legacy-a", cmd: ["x"], cwd: "/", wtPath: "/" },
      entryAt(NOW - 1 * HOUR, 1),
      { termId: "legacy-b", cmd: ["x"], cwd: "/", wtPath: "/" },
    ];
    // Cap of 2: the known-recent one wins a slot, then the later unknown.
    const kept = prunePersistedTerminals(entries, {
      now: NOW,
      maxAgeMs: 1 * HOUR,
      maxEntries: 2,
    });
    expect(kept.map((e) => e.termId).sort()).toEqual(
      [idAt(NOW - 1 * HOUR, 1), "legacy-b"].sort(),
    );
  });
});

describe("TerminalPersist.prune", () => {
  const NOW = Date.parse("2026-07-11T12:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  test("rewrites the file to the bounded set and reports the drop count", async () => {
    const dir = join(tmpDir, "prune");
    const tp = new TerminalPersist(dir);
    for (let i = 0; i < 5; i++) {
      await tp.save(entryAt(NOW - (i + 1) * HOUR, i));
    }
    await tp.save(entryAt(NOW - 500 * HOUR, 99)); // ancient

    const removed = await tp.prune({
      now: NOW,
      maxAgeMs: 48 * HOUR,
      maxEntries: 3,
    });
    // 6 saved → 1 ancient age-dropped, then capped to 3 → 3 removed total.
    expect(removed).toBe(3);
    const list = await tp.list();
    expect(list.length).toBe(3);
    expect(list.every((e) => e.termId !== idAt(NOW - 500 * HOUR, 99))).toBe(
      true,
    );
  });

  test("returns 0 and leaves the file untouched when nothing to prune", async () => {
    const dir = join(tmpDir, "prune-noop");
    const tp = new TerminalPersist(dir);
    await tp.save(entryAt(NOW - 1 * HOUR, 1));
    const removed = await tp.prune({
      now: NOW,
      maxAgeMs: 48 * HOUR,
      maxEntries: 25,
    });
    expect(removed).toBe(0);
    expect((await tp.list()).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// prunePersistedTerminals — `protect` (live PTYs)
// ---------------------------------------------------------------------------

describe("prunePersistedTerminals with protect (live PTYs)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;
  /** A termId whose embedded spawn time is `ms`. */
  const idAt = (ms: number, tag: string) => `t_${ms.toString(36)}_${tag}`;
  const entry = (termId: string) => ({
    termId,
    cmd: ["sh", "-c", "npm run dev"],
    cwd: "/repo",
    wtPath: "/repo",
  });

  test("a live PTY survives the age cap", () => {
    // 5 days old — well past a 48h maxAgeMs — but still running.
    const live = idAt(NOW - 5 * DAY, "devserver");
    const kept = prunePersistedTerminals([entry(live)], {
      now: NOW,
      maxAgeMs: 2 * DAY,
      maxEntries: 10,
      protect: new Set([live]),
    });
    expect(kept.map((e) => e.termId)).toEqual([live]);
  });

  test("the same entry IS dropped once its PTY is gone", () => {
    const dead = idAt(NOW - 5 * DAY, "devserver");
    expect(
      prunePersistedTerminals([entry(dead)], {
        now: NOW,
        maxAgeMs: 2 * DAY,
        maxEntries: 10,
      }),
    ).toEqual([]);
  });

  test("live entries do not consume maxEntries slots", () => {
    const live = [idAt(NOW - 9 * DAY, "l1"), idAt(NOW - 8 * DAY, "l2")];
    const fresh = [idAt(NOW - 1000, "f1"), idAt(NOW - 2000, "f2")];
    const kept = prunePersistedTerminals([...live, ...fresh].map(entry), {
      now: NOW,
      maxAgeMs: 2 * DAY,
      maxEntries: 2,
      protect: new Set(live),
    });
    // Both live entries survive AND both fresh ones still get their 2 slots.
    expect(new Set(kept.map((e) => e.termId))).toEqual(
      new Set([...live, ...fresh]),
    );
  });

  test("omitting protect preserves the original startup behaviour", () => {
    const old = idAt(NOW - 5 * DAY, "old");
    const fresh = idAt(NOW - 1000, "fresh");
    const kept = prunePersistedTerminals([entry(old), entry(fresh)], {
      now: NOW,
      maxAgeMs: 2 * DAY,
      maxEntries: 10,
    });
    expect(kept.map((e) => e.termId)).toEqual([fresh]);
  });

  test("file order is preserved across a protected prune", () => {
    const a = idAt(NOW - 9 * DAY, "a"); // live
    const b = idAt(NOW - 1000, "b"); // fresh
    const c = idAt(NOW - 9 * DAY, "c"); // stale, dropped
    const d = idAt(NOW - 2000, "d"); // fresh
    const kept = prunePersistedTerminals(
      [entry(a), entry(b), entry(c), entry(d)],
      { now: NOW, maxAgeMs: 2 * DAY, maxEntries: 10, protect: new Set([a]) },
    );
    expect(kept.map((e) => e.termId)).toEqual([a, b, d]);
  });
});
