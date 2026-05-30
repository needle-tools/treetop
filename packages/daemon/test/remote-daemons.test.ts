import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace";

async function tempWs(): Promise<Workspace> {
  return Workspace.open(await mkdtemp(join(tmpdir(), "supergit-rd-")));
}

// The remote-daemon registry is the persistence backing for Phase 4b
// (a remote daemon shown as a folder row). It's a storage class, so per
// CLAUDE.md it ships with tests first: CRUD + a reversible-op round trip,
// ids and metadata preserved.
describe("Workspace remote-daemon registry", () => {
  test("lists no remote daemons initially (tolerates missing file)", async () => {
    const ws = await tempWs();
    expect(await ws.listRemoteDaemons()).toEqual([]);
  });

  test("adds a remote daemon with id/addedAt and supplied fields", async () => {
    const ws = await tempWs();
    const d = await ws.addRemoteDaemon({
      label: "hetzner",
      host: "203.0.113.4",
      user: "supergit",
      port: 7777,
    });
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.label).toBe("hetzner");
    expect(d.host).toBe("203.0.113.4");
    expect(d.user).toBe("supergit");
    expect(d.port).toBe(7777);
    expect(Date.parse(d.addedAt)).not.toBeNaN();
  });

  test("defaults the daemon port to 7777 when omitted", async () => {
    const ws = await tempWs();
    const d = await ws.addRemoteDaemon({ label: "box", host: "h" });
    expect(d.port).toBe(7777);
  });

  test("requires a non-empty host", async () => {
    const ws = await tempWs();
    await expect(
      ws.addRemoteDaemon({ label: "x", host: "  " }),
    ).rejects.toThrow(/host/);
  });

  test("persists across reopen of the same workspace path", async () => {
    const ws = await tempWs();
    await ws.addRemoteDaemon({ label: "a", host: "h1" });
    await ws.addRemoteDaemon({ label: "b", host: "h2" });
    const reopened = await Workspace.open(ws.path);
    expect((await reopened.listRemoteDaemons()).map((d) => d.label)).toEqual([
      "a",
      "b",
    ]);
  });

  test("removeRemoteDaemon deletes by id and reports whether it existed", async () => {
    const ws = await tempWs();
    const d = await ws.addRemoteDaemon({ label: "a", host: "h" });
    expect(await ws.removeRemoteDaemon(d.id)).toBe(true);
    expect(await ws.listRemoteDaemons()).toEqual([]);
    expect(await ws.removeRemoteDaemon(d.id)).toBe(false);
  });

  test("stores the registry in remote-daemons.json (not repos.json/prefs)", async () => {
    const ws = await tempWs();
    await ws.addRemoteDaemon({ label: "a", host: "h" });
    const raw = await readFile(join(ws.path, "remote-daemons.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.remoteDaemons)).toBe(true);
    expect(parsed.remoteDaemons[0].host).toBe("h");
    // repos.json must be untouched by remote-daemon writes.
    expect(JSON.parse(await readFile(join(ws.path, "repos.json"), "utf-8")))
      .toEqual({ repos: [] });
  });

  test("round-trip: add → remove → restore preserves id and metadata", async () => {
    const ws = await tempWs();
    const original = await ws.addRemoteDaemon({
      label: "hetzner",
      host: "203.0.113.4",
      user: "supergit",
      port: 7777,
      color: "#ff8800",
    });
    expect(await ws.removeRemoteDaemon(original.id)).toBe(true);
    await ws.restoreRemoteDaemon(original);
    const list = await ws.listRemoteDaemons();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(original);
  });

  test("restoreRemoteDaemon refuses to duplicate an existing id", async () => {
    const ws = await tempWs();
    const d = await ws.addRemoteDaemon({ label: "a", host: "h" });
    await expect(ws.restoreRemoteDaemon(d)).rejects.toThrow(/exists/);
  });

  test("tolerates a corrupt remote-daemons.json by listing empty", async () => {
    const ws = await tempWs();
    await writeFile(join(ws.path, "remote-daemons.json"), "{ not json");
    expect(await ws.listRemoteDaemons()).toEqual([]);
  });
});
