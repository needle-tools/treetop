import { test, expect, describe } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-events-"));
}

describe("EventLog", () => {
  test("starts empty when first opened", async () => {
    const log = await EventLog.open(await tempDir());
    expect(await log.list()).toEqual([]);
  });

  test("append returns the event with id and timestamp", async () => {
    const log = await EventLog.open(await tempDir());
    const ev = await log.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
    });
    expect(ev.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(ev.timestamp)).not.toBeNaN();
    expect(ev.payload).toEqual({ path: "/tmp/foo" });
  });

  test("list returns events in append order with undone=false", async () => {
    const log = await EventLog.open(await tempDir());
    await log.append({ type: "a", actor: "user", payload: {} });
    await log.append({ type: "b", actor: "user", payload: {} });
    const all = await log.list();
    expect(all.map((e) => e.type)).toEqual(["a", "b"]);
    expect(all.every((e) => !e.undone)).toBe(true);
  });

  test("reversible is true only when inverse is set and type !== undo", async () => {
    const log = await EventLog.open(await tempDir());
    await log.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/x" },
      inverse: { repoId: "abc" },
    });
    await log.append({ type: "observe", actor: "supergit", payload: {} });
    const all = await log.list();
    expect(all[0]?.reversible).toBe(true);
    expect(all[1]?.reversible).toBe(false);
  });

  test("undo events mark their target as undone", async () => {
    const log = await EventLog.open(await tempDir());
    const original = await log.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/x" },
      inverse: { repoId: "abc" },
    });
    await log.append({
      type: "undo",
      actor: "user",
      payload: { eventId: original.id },
    });
    const found = await log.findById(original.id);
    expect(found?.undone).toBe(true);
  });

  test("findById returns null for unknown id", async () => {
    const log = await EventLog.open(await tempDir());
    await log.append({ type: "a", actor: "user", payload: {} });
    expect(await log.findById("nope")).toBeNull();
  });

  test("persists across re-open of the same workspace", async () => {
    const dir = await tempDir();
    const log1 = await EventLog.open(dir);
    await log1.append({ type: "a", actor: "user", payload: {} });
    const log2 = await EventLog.open(dir);
    expect((await log2.list()).map((e) => e.type)).toEqual(["a"]);
  });
});
