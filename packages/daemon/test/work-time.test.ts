import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkTimeStore, handleWorkTimeRequest } from "../src/work-time";

test("workspace persistence unions overlapping windows, retries and concurrent writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "treetop-work-time-"));
  try {
    const store = await WorkTimeStore.open(dir);
    await Promise.all([
      store.add([{ repoId: "a", day: "2026-11-17", start: 1000, end: 61000 }]),
      store.add([{ repoId: "b", day: "2026-11-17", start: 31000, end: 91000 }]),
    ]);
    await store.add([
      { repoId: "a", day: "2026-11-17", start: 1000, end: 61000 },
    ]);
    expect(store.summary()).toEqual([
      { day: "2026-11-17", repoId: "a", ms: 60000 },
      { day: "2026-11-17", repoId: "b", ms: 30000 },
    ]);
    expect((await WorkTimeStore.open(dir)).summary()).toEqual(store.summary());
    await store.adjust({
      id: "edit-1",
      day: "2026-11-17",
      repoId: "a",
      deltaMs: -30000,
    });
    await store.adjust({
      id: "edit-1",
      day: "2026-11-17",
      repoId: "a",
      deltaMs: -30000,
    });
    expect(store.summary()[0].ms).toBe(30000);
    await expect(
      store.adjust({
        id: "edit-2",
        day: "2026-11-17",
        repoId: "a",
        deltaMs: -60000,
      }),
    ).rejects.toThrow("negative");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP validation rejects invalid projects and future spans; pause and reload persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "treetop-work-time-api-"));
  try {
    const store = await WorkTimeStore.open(dir),
      now = Date.now(),
      day = new Date(now).toISOString().slice(0, 10);
    const request = (body: unknown) =>
      handleWorkTimeRequest(
        new Request("http://test/api/work-time", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        store,
        now,
      );
    expect(
      (
        await request({
          action: "activity",
          spans: [{ repoId: null, day, start: now - 1000, end: now }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request({
          action: "activity",
          spans: [{ repoId: "a", day, start: now, end: now + 60000 }],
        })
      ).status,
    ).toBe(400);
    await request({
      action: "activity",
      spans: [{ repoId: "a", day, start: now - 60000, end: now }],
    });
    await request({ action: "pause", paused: true });
    await request({
      action: "activity",
      spans: [{ repoId: "a", day, start: now - 120000, end: now - 60000 }],
    });
    const reopened = await WorkTimeStore.open(dir);
    expect(reopened.paused()).toBe(true);
    expect(reopened.summary()[0].ms).toBe(60000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
