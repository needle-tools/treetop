import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-test-"));
}

describe("Workspace", () => {
  test("opens an empty workspace by creating repos.json", async () => {
    const path = await tempDir();
    await Workspace.open(path);
    const raw = await readFile(join(path, "repos.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ repos: [] });
  });

  test("lists no repos initially", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.listRepos()).toEqual([]);
  });

  test("adds a repo and returns it with id, name, addedAt", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo/bar");
    expect(repo.path).toBe("/tmp/foo/bar");
    expect(repo.name).toBe("bar");
    expect(repo.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(repo.addedAt)).not.toBeNaN();
  });

  test("lists previously added repos", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.addRepo("/tmp/foo");
    await ws.addRepo("/tmp/bar");
    const repos = await ws.listRepos();
    expect(repos.map((r) => r.path)).toEqual(["/tmp/foo", "/tmp/bar"]);
  });

  test("rejects duplicate repo paths", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.addRepo("/tmp/foo");
    await expect(ws.addRepo("/tmp/foo")).rejects.toThrow(/already registered/);
  });

  test("removes a repo by id and returns true", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const removed = await ws.removeRepo(repo.id);
    expect(removed).toBe(true);
    expect(await ws.listRepos()).toEqual([]);
  });

  test("returns false when removing a non-existent id", async () => {
    const ws = await Workspace.open(await tempDir());
    const removed = await ws.removeRepo("does-not-exist");
    expect(removed).toBe(false);
  });

  test("persists repos across re-opens of the same path", async () => {
    const path = await tempDir();
    const ws1 = await Workspace.open(path);
    await ws1.addRepo("/tmp/foo");
    const ws2 = await Workspace.open(path);
    expect((await ws2.listRepos()).map((r) => r.path)).toEqual(["/tmp/foo"]);
  });

  test("restoreRepo preserves id and metadata (for undo/redo round-trips)", async () => {
    const ws = await Workspace.open(await tempDir());
    const original = await ws.addRepo("/tmp/foo");
    await ws.removeRepo(original.id);
    await ws.restoreRepo(original);
    const repos = await ws.listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]?.id).toBe(original.id);
    expect(repos[0]?.addedAt).toBe(original.addedAt);
  });

  test("restoreRepo rejects when id already exists", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(ws.restoreRepo(repo)).rejects.toThrow(/already exists/);
  });

  test("renameRepo updates name and returns old + new", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const result = await ws.renameRepo(repo.id, "FancyName");
    expect(result).toEqual({ oldName: "foo", newName: "FancyName" });
    expect((await ws.listRepos())[0]?.name).toBe("FancyName");
  });

  test("renameRepo rejects empty name", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(ws.renameRepo(repo.id, "   ")).rejects.toThrow(/empty/);
  });

  test("renameRepo throws when id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.renameRepo("nope", "X")).rejects.toThrow(/not found/);
  });

  test("session titles start empty", async () => {
    const ws = await Workspace.open(await tempDir());
    expect(await ws.listSessionTitles()).toEqual({});
  });

  test("setSessionTitle persists and roundtrips", async () => {
    const path = await tempDir();
    const ws1 = await Workspace.open(path);
    await ws1.setSessionTitle("/abs/session.jsonl", "Refactor billing");
    expect(await ws1.listSessionTitles()).toEqual({
      "/abs/session.jsonl": "Refactor billing",
    });
    const ws2 = await Workspace.open(path);
    expect(await ws2.listSessionTitles()).toEqual({
      "/abs/session.jsonl": "Refactor billing",
    });
  });

  test("setSessionTitle with empty string deletes the entry", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("/a.jsonl", "name");
    await ws.setSessionTitle("/b.jsonl", "other");
    await ws.setSessionTitle("/a.jsonl", "");
    expect(await ws.listSessionTitles()).toEqual({ "/b.jsonl": "other" });
  });

  test("setSessionTitle trims whitespace; whitespace-only clears", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("/a.jsonl", "  spaced  ");
    expect((await ws.listSessionTitles())["/a.jsonl"]).toBe("spaced");
    await ws.setSessionTitle("/a.jsonl", "   ");
    expect(await ws.listSessionTitles()).toEqual({});
  });
});
