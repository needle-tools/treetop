/**
 * Integration tests for the add/remove/rename + undo/redo state machine.
 *
 * These exercise Workspace + EventLog together using the exact payload
 * contracts the server routes write — they would have caught the
 * "redo says not found" bug we hit when --hot didn't reload the new redo
 * route. Treat each route's logic as a pure function from (workspace,
 * events, eventId, toggle) -> next state, and assert that round-trips
 * don't lose information.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, type Repo } from "../src/workspace";
import { EventLog } from "../src/events";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-integration-"));
}

// Mirror of the server's undo handler for add_repo / remove_repo / rename_repo.
async function undoAction(
  ws: Workspace,
  events: EventLog,
  eventId: string,
): Promise<void> {
  const ev = await events.findById(eventId);
  if (!ev) throw new Error("event not found");
  if (!ev.reversible || ev.inverse === undefined) throw new Error("not reversible");
  if (ev.undone) throw new Error("already undone");

  if (ev.type === "add_repo") {
    const inv = ev.inverse as { repo: { id: string } };
    const removed = await ws.removeRepo(inv.repo.id);
    if (!removed) throw new Error("inverse failed: repo no longer exists");
  } else if (ev.type === "remove_repo") {
    const inv = ev.inverse as { repo: Repo };
    await ws.restoreRepo(inv.repo);
  } else if (ev.type === "rename_repo") {
    const inv = ev.inverse as { id: string; oldName: string };
    await ws.renameRepo(inv.id, inv.oldName);
  } else {
    throw new Error(`no inverse handler for ${ev.type}`);
  }
  await events.append({
    type: "undo",
    actor: "user",
    payload: { eventId },
  });
}

async function redoAction(
  ws: Workspace,
  events: EventLog,
  eventId: string,
): Promise<void> {
  const ev = await events.findById(eventId);
  if (!ev) throw new Error("event not found");
  if (!ev.reversible || ev.inverse === undefined) throw new Error("not reversible");
  if (!ev.undone) throw new Error("nothing to redo");

  if (ev.type === "add_repo") {
    const inv = ev.inverse as { repo: Repo };
    await ws.restoreRepo(inv.repo);
  } else if (ev.type === "remove_repo") {
    const inv = ev.inverse as { repo: { id: string } };
    const removed = await ws.removeRepo(inv.repo.id);
    if (!removed) throw new Error("redo failed: repo no longer exists");
  } else if (ev.type === "rename_repo") {
    const p = ev.payload as { id: string; newName: string };
    await ws.renameRepo(p.id, p.newName);
  } else {
    throw new Error(`no redo handler for ${ev.type}`);
  }
  await events.append({
    type: "redo",
    actor: "user",
    payload: { eventId },
  });
}

describe("add → undo → redo round-trip", () => {
  test("restores the same repo with the same id and metadata", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const addEv = await events.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
      inverse: { repo },
    });

    expect(await ws.listRepos()).toHaveLength(1);

    await undoAction(ws, events, addEv.id);
    expect(await ws.listRepos()).toHaveLength(0);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
    expect((await events.findById(addEv.id))?.redoable).toBe(true);

    await redoAction(ws, events, addEv.id);
    const after = await ws.listRepos();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(repo.id);
    expect(after[0]?.addedAt).toBe(repo.addedAt);
    expect((await events.findById(addEv.id))?.undone).toBe(false);
  });

  test("undo → redo → undo flips correctly through the chain", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const addEv = await events.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
      inverse: { repo },
    });

    await undoAction(ws, events, addEv.id);
    await redoAction(ws, events, addEv.id);
    await undoAction(ws, events, addEv.id);

    expect(await ws.listRepos()).toEqual([]);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
  });
});

describe("remove → undo → redo round-trip", () => {
  test("restores the removed repo on undo, removes it again on redo", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    await ws.removeRepo(repo.id);
    const removeEv = await events.append({
      type: "remove_repo",
      actor: "user",
      payload: { id: repo.id },
      inverse: { repo },
    });

    expect(await ws.listRepos()).toEqual([]);

    await undoAction(ws, events, removeEv.id);
    expect((await ws.listRepos())[0]?.id).toBe(repo.id);

    await redoAction(ws, events, removeEv.id);
    expect(await ws.listRepos()).toEqual([]);
  });
});

describe("rename → undo → redo round-trip", () => {
  test("restores the old name on undo and reapplies the new one on redo", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const { oldName, newName } = await ws.renameRepo(repo.id, "FancyName");
    const ev = await events.append({
      type: "rename_repo",
      actor: "user",
      payload: { id: repo.id, newName },
      inverse: { id: repo.id, oldName },
    });

    expect((await ws.listRepos())[0]?.name).toBe("FancyName");

    await undoAction(ws, events, ev.id);
    expect((await ws.listRepos())[0]?.name).toBe("foo");

    await redoAction(ws, events, ev.id);
    expect((await ws.listRepos())[0]?.name).toBe("FancyName");
  });
});
