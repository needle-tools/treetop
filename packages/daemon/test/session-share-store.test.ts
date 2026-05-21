/**
 * Storage layer for session-share offers. Tests the pending-offer file
 * shape, the accept flow's path rewrite + write to imported-sessions/,
 * decline, and stale-offer GC.
 *
 * No HTTP and no Workspace dependency — repoLookup is injected so we
 * can simulate "repo present" / "repo missing" deterministically.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storePendingOffer,
  loadPendingOffer,
  listPendingOffers,
  acceptOffer,
  declineOffer,
  gcStaleOffers,
  type RepoLookup,
} from "../src/session-share-store";
import type { SessionShareManifest } from "../src/session-share";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-share-store-"));
}

function manifest(
  overrides: Partial<SessionShareManifest> = {},
): SessionShareManifest {
  return {
    offerId: "offer-aaa",
    sid: "sid-aaa",
    title: "Refactor PTY env scrub",
    agent: "claude",
    turnCount: 4,
    originMachine: "marcels-laptop",
    originMachineLabel: "Marcel's MBP",
    originPlatform: "darwin",
    originRepoRemote: "https://github.com/foo/bar",
    originRepoName: "bar",
    originRepoPath: "/Users/marcel/git/bar",
    createdAt: "2026-05-21T10:14:00Z",
    sentAt: "2026-05-21T14:02:00Z",
    bytes: 100,
    toolOutputs: "stripped",
    strippedCount: 0,
    ...overrides,
  };
}

function jsonlMentioning(repoPath: string): string {
  return [
    JSON.stringify({ cwd: `${repoPath}/src` }),
    JSON.stringify({
      message: {
        content: [{ type: "text", text: `read ${repoPath}/src/file.ts ok` }],
      },
    }),
  ].join("\n");
}

const repoFound = (localPath: string): RepoLookup => async () => ({
  localRepoPath: localPath,
});
const repoMissing: RepoLookup = async () => null;

describe("storePendingOffer", () => {
  test("writes session-invites/<offerId>.json with manifest + jsonl + receivedAt", async () => {
    const ws = await tempWorkspace();
    const m = manifest();
    const j = jsonlMentioning(m.originRepoPath);
    const path = await storePendingOffer(ws, m, j);

    expect(path).toBe(join(ws, "session-invites", "offer-aaa.json"));
    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw.manifest.offerId).toBe("offer-aaa");
    expect(raw.jsonl).toBe(j);
    expect(typeof raw.receivedAt).toBe("string");
    expect(new Date(raw.receivedAt).getTime()).toBeGreaterThan(0);
  });

  test("creates the session-invites directory on demand", async () => {
    const ws = await tempWorkspace();
    await storePendingOffer(ws, manifest(), "");
    const s = await stat(join(ws, "session-invites"));
    expect(s.isDirectory()).toBe(true);
  });
});

describe("loadPendingOffer / listPendingOffers", () => {
  test("round-trips a stored offer", async () => {
    const ws = await tempWorkspace();
    const m = manifest();
    await storePendingOffer(ws, m, "abc");
    const got = await loadPendingOffer(ws, "offer-aaa");
    expect(got?.manifest.offerId).toBe("offer-aaa");
    expect(got?.jsonl).toBe("abc");
  });

  test("returns null for unknown offerId", async () => {
    const ws = await tempWorkspace();
    expect(await loadPendingOffer(ws, "nope")).toBeNull();
  });

  test("listPendingOffers returns every stored manifest, sorted by receivedAt desc", async () => {
    const ws = await tempWorkspace();
    await storePendingOffer(ws, manifest({ offerId: "a" }), "");
    await new Promise((r) => setTimeout(r, 5));
    await storePendingOffer(ws, manifest({ offerId: "b" }), "");
    const list = await listPendingOffers(ws);
    expect(list.map((o) => o.manifest.offerId)).toEqual(["b", "a"]);
  });

  test("listPendingOffers returns [] when the directory does not exist", async () => {
    const ws = await tempWorkspace();
    expect(await listPendingOffers(ws)).toEqual([]);
  });
});

describe("acceptOffer", () => {
  test("rewrites paths, writes imported-sessions/<machine>/<sid>.jsonl, deletes pending", async () => {
    const ws = await tempWorkspace();
    const m = manifest();
    const j = jsonlMentioning(m.originRepoPath);
    await storePendingOffer(ws, m, j);

    const localPath = "/home/desktop/code/bar";
    const result = await acceptOffer({
      workspaceDir: ws,
      offerId: m.offerId,
      repoLookup: repoFound(localPath),
    });

    if (!result.ok) throw new Error("expected ok: " + result.error);
    expect(result.importedPath).toBe(
      join(ws, "imported-sessions", "marcels-laptop", "sid-aaa.jsonl"),
    );

    const imported = await readFile(result.importedPath, "utf-8");
    expect(imported.includes(m.originRepoPath)).toBe(false);
    expect(imported.includes(`${localPath}/src/file.ts`)).toBe(true);

    const sidecar = JSON.parse(
      await readFile(
        join(ws, "imported-sessions", "marcels-laptop", "sid-aaa.manifest.json"),
        "utf-8",
      ),
    );
    expect(sidecar.sid).toBe("sid-aaa");
    expect(sidecar.localRepoPath).toBe(localPath);

    expect(await loadPendingOffer(ws, m.offerId)).toBeNull();
  });

  test("returns needsClone when repoLookup yields null", async () => {
    const ws = await tempWorkspace();
    await storePendingOffer(ws, manifest(), "");
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "offer-aaa",
      repoLookup: repoMissing,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("needs_clone");
    // pending file is NOT deleted on needs_clone — receiver may add the
    // repo and retry.
    expect(await loadPendingOffer(ws, "offer-aaa")).not.toBeNull();
  });

  test("returns not_found for unknown offerId", async () => {
    const ws = await tempWorkspace();
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "ghost",
      repoLookup: repoFound("/tmp/anywhere"),
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toBe("not_found");
  });

  test("replaces existing import on re-accept of the same sid", async () => {
    const ws = await tempWorkspace();
    const m1 = manifest({ offerId: "o1" });
    await storePendingOffer(ws, m1, jsonlMentioning(m1.originRepoPath));
    await acceptOffer({
      workspaceDir: ws,
      offerId: "o1",
      repoLookup: repoFound("/local/bar"),
    });

    // Second send of the same sid with updated content
    const m2 = manifest({ offerId: "o2" });
    const j2 = JSON.stringify({
      cwd: `${m2.originRepoPath}/src`,
      extra: "second send",
    });
    await storePendingOffer(ws, m2, j2);
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "o2",
      repoLookup: repoFound("/local/bar"),
    });
    if (!r.ok) throw new Error("expected ok");

    const imported = await readFile(r.importedPath, "utf-8");
    expect(imported.includes("second send")).toBe(true);
  });

  test("rewrites worktree path when receiver has a matching worktree", async () => {
    const ws = await tempWorkspace();
    const m = manifest({
      originWorktreePath: "/Users/marcel/git/bar/.worktrees/feat-x",
    });
    const j = JSON.stringify({
      cwd: m.originWorktreePath,
      msg: `${m.originWorktreePath}/src/file.ts`,
    });
    await storePendingOffer(ws, m, j);

    const repoLookup: RepoLookup = async () => ({
      localRepoPath: "/local/bar",
      localWorktreePath: "/local/bar/.worktrees/feat-x",
    });

    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: m.offerId,
      repoLookup,
    });
    if (!r.ok) throw new Error("expected ok");
    const imported = await readFile(r.importedPath, "utf-8");
    expect(imported.includes(m.originWorktreePath!)).toBe(false);
    expect(imported.includes("/local/bar/.worktrees/feat-x/src/file.ts")).toBe(
      true,
    );
  });
});

describe("declineOffer", () => {
  test("deletes the pending file and returns true", async () => {
    const ws = await tempWorkspace();
    await storePendingOffer(ws, manifest(), "");
    expect(await declineOffer(ws, "offer-aaa")).toBe(true);
    expect(await loadPendingOffer(ws, "offer-aaa")).toBeNull();
  });

  test("returns false for unknown offerId", async () => {
    const ws = await tempWorkspace();
    expect(await declineOffer(ws, "ghost")).toBe(false);
  });
});

describe("gcStaleOffers", () => {
  test("deletes offers older than the cutoff and returns the count", async () => {
    const ws = await tempWorkspace();
    const invitesDir = join(ws, "session-invites");
    await mkdir(invitesDir, { recursive: true });

    const stale = {
      manifest: manifest({ offerId: "stale" }),
      jsonl: "",
      receivedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const fresh = {
      manifest: manifest({ offerId: "fresh" }),
      jsonl: "",
      receivedAt: new Date().toISOString(),
    };
    await writeFile(join(invitesDir, "stale.json"), JSON.stringify(stale));
    await writeFile(join(invitesDir, "fresh.json"), JSON.stringify(fresh));

    const removed = await gcStaleOffers(ws, 30 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    const remaining = await readdir(invitesDir);
    expect(remaining).toEqual(["fresh.json"]);
  });

  test("returns 0 when there are no stale offers", async () => {
    const ws = await tempWorkspace();
    await storePendingOffer(ws, manifest(), "");
    expect(await gcStaleOffers(ws, 30 * 24 * 60 * 60 * 1000)).toBe(0);
  });

  test("returns 0 when the directory does not exist", async () => {
    const ws = await tempWorkspace();
    expect(await gcStaleOffers(ws, 1)).toBe(0);
  });
});
