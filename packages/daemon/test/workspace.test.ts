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

  test("setRepoColor persists hex color and returns old + new", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const result = await ws.setRepoColor(repo.id, "#FF8800");
    expect(result).toEqual({ oldColor: undefined, newColor: "#ff8800" });
    expect((await ws.listRepos())[0]?.color).toBe("#ff8800");
  });

  test("setRepoColor with null clears an existing color", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await ws.setRepoColor(repo.id, "#abcdef");
    const cleared = await ws.setRepoColor(repo.id, null);
    expect(cleared).toEqual({ oldColor: "#abcdef", newColor: undefined });
    expect((await ws.listRepos())[0]?.color).toBeUndefined();
  });

  test("setRepoColor rejects bad hex formats", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(ws.setRepoColor(repo.id, "red")).rejects.toThrow(/hex/);
    await expect(ws.setRepoColor(repo.id, "#abc")).rejects.toThrow(/hex/);
    await expect(ws.setRepoColor(repo.id, "rgb(1,2,3)")).rejects.toThrow(/hex/);
  });

  test("setRepoColor is a no-op when value unchanged", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await ws.setRepoColor(repo.id, "#112233");
    const again = await ws.setRepoColor(repo.id, "#112233");
    expect(again).toEqual({ oldColor: "#112233", newColor: "#112233" });
  });

  test("setRepoColor throws when id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.setRepoColor("nope", "#112233")).rejects.toThrow(/not found/);
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

  test("migrateSessionTitle moves the title from oldSource to newSource", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("__new__:claude:abc", "Cool refactor");
    await ws.migrateSessionTitle("__new__:claude:abc", "/abs/real.jsonl");
    expect(await ws.listSessionTitles()).toEqual({
      "/abs/real.jsonl": "Cool refactor",
    });
  });

  test("migrateSessionTitle is a no-op when oldSource has no title", async () => {
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("/abs/real.jsonl", "Already named");
    await ws.migrateSessionTitle("__new__:claude:abc", "/abs/real.jsonl");
    // No mutation: the existing newSource title is preserved.
    expect(await ws.listSessionTitles()).toEqual({
      "/abs/real.jsonl": "Already named",
    });
  });

  test("migrateSessionTitle preserves oldSource title if newSource already has one", async () => {
    // If the user manually named both sides we don't silently overwrite the
    // destination — the explicit later edit wins. Source is left intact too
    // so nothing is lost.
    const ws = await Workspace.open(await tempDir());
    await ws.setSessionTitle("__new__:claude:abc", "From synthetic");
    await ws.setSessionTitle("/abs/real.jsonl", "From real");
    await ws.migrateSessionTitle("__new__:claude:abc", "/abs/real.jsonl");
    expect(await ws.listSessionTitles()).toEqual({
      "__new__:claude:abc": "From synthetic",
      "/abs/real.jsonl": "From real",
    });
  });

  test("migrateSessionTitle rejects empty source strings", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.migrateSessionTitle("", "/x")).rejects.toThrow();
    await expect(ws.migrateSessionTitle("/x", "")).rejects.toThrow();
  });

  test("addCustomLink persists a link on the repo and returns it", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "https://coolify.example.com/app/123",
      name: "Coolify",
    });
    expect(link.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(link.url).toBe("https://coolify.example.com/app/123");
    expect(link.name).toBe("Coolify");
    const persisted = (await ws.listRepos())[0]!;
    expect(persisted.customLinks).toEqual([link]);
  });

  test("addCustomLink trims fields and treats blank name as absent", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, {
      url: "  https://example.com/  ",
      name: "   ",
    });
    expect(link.url).toBe("https://example.com/");
    expect(link.name).toBeUndefined();
  });

  test("addCustomLink rejects bad URLs", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    await expect(
      ws.addCustomLink(repo.id, { url: "not a url" }),
    ).rejects.toThrow(/url/i);
    await expect(
      ws.addCustomLink(repo.id, { url: "" }),
    ).rejects.toThrow(/url/i);
    await expect(
      ws.addCustomLink(repo.id, { url: "ftp://example.com/x" }),
    ).rejects.toThrow(/http/i);
  });

  test("addCustomLink throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(
      ws.addCustomLink("nope", { url: "https://x" }),
    ).rejects.toThrow(/not found/);
  });

  test("addCustomLink appends in order", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    expect((await ws.listRepos())[0]!.customLinks).toEqual([a, b]);
  });

  test("removeCustomLink deletes the link and returns the removed entry", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const link = await ws.addCustomLink(repo.id, { url: "https://x.test/" });
    const removed = await ws.removeCustomLink(repo.id, link.id);
    expect(removed).toEqual(link);
    expect((await ws.listRepos())[0]!.customLinks ?? []).toEqual([]);
  });

  test("removeCustomLink returns null when the link id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    expect(await ws.removeCustomLink(repo.id, "missing-id")).toBeNull();
  });

  test("removeCustomLink throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.removeCustomLink("nope", "x")).rejects.toThrow(/not found/);
  });

  test("reorderCustomLinks rewrites the order to match the id list", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    const c = await ws.addCustomLink(repo.id, { url: "https://c.test/" });
    const result = await ws.reorderCustomLinks(repo.id, [c.id, a.id, b.id]);
    expect(result.oldOrder).toEqual([a.id, b.id, c.id]);
    expect(result.newOrder).toEqual([c.id, a.id, b.id]);
    expect((await ws.listRepos())[0]!.customLinks?.map((l) => l.id)).toEqual([
      c.id,
      a.id,
      b.id,
    ]);
  });

  test("reorderCustomLinks is a no-op when the order is unchanged", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    const result = await ws.reorderCustomLinks(repo.id, [a.id, b.id]);
    expect(result.oldOrder).toEqual([a.id, b.id]);
    expect(result.newOrder).toEqual([a.id, b.id]);
  });

  test("reorderCustomLinks rejects mismatched id sets", async () => {
    const ws = await Workspace.open(await tempDir());
    const repo = await ws.addRepo("/tmp/foo");
    const a = await ws.addCustomLink(repo.id, { url: "https://a.test/" });
    const b = await ws.addCustomLink(repo.id, { url: "https://b.test/" });
    // wrong length
    await expect(ws.reorderCustomLinks(repo.id, [a.id])).rejects.toThrow(/length/);
    // unknown id
    await expect(
      ws.reorderCustomLinks(repo.id, [a.id, "ghost"]),
    ).rejects.toThrow(/Unknown link id/);
    // duplicates
    await expect(
      ws.reorderCustomLinks(repo.id, [a.id, a.id]),
    ).rejects.toThrow(/unique/);
    void b;
  });

  test("reorderCustomLinks throws when the repo id is unknown", async () => {
    const ws = await Workspace.open(await tempDir());
    await expect(ws.reorderCustomLinks("nope", [])).rejects.toThrow(/not found/);
  });
});
