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
  sanitizeJsonl,
  type RepoLookup,
} from "../src/session-share-store";
import type { SessionShareManifest } from "../src/session-share";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-share-store-"));
}

async function tempClaudeProjects(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-claude-projects-"));
}

/** Mirrors claudeProjectDirForCwd's encoding so tests can predict the
 *  JSONL path without depending on the import order of agents.ts.
 *  Must stay in sync with the production encoder. */
function encodedProjectDir(cwd: string): string {
  const normalized = cwd.replace(/[/\\]+$/, "") || cwd;
  return normalized.replace(/[^A-Za-z0-9-]/g, "-");
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
  test("claude offer: JSONL lands in <claudeProjectsDir>/<encoded-cwd>/<sid>.jsonl, sidecar under imported-sessions", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    const m = manifest();
    const j = jsonlMentioning(m.originRepoPath);
    await storePendingOffer(ws, m, j);

    const localPath = "/home/desktop/code/bar";
    const result = await acceptOffer({
      workspaceDir: ws,
      offerId: m.offerId,
      repoLookup: repoFound(localPath),
      claudeProjectsDir: cpd,
      // Tests use POSIX-shaped paths regardless of host OS; force the
      // rewriter to treat the target as POSIX so separators in the
      // assertion strings below stay as `/` instead of being flipped
      // to `\\` on Windows test runs.
      toPlatform: "darwin",
    });

    if (!result.ok) throw new Error("expected ok: " + result.error);
    expect(result.importedPath).toBe(
      join(cpd, encodedProjectDir(localPath), "sid-aaa.jsonl"),
    );

    const imported = await readFile(result.importedPath, "utf-8");
    expect(imported.includes(m.originRepoPath)).toBe(false);
    expect(imported.includes(`${localPath}/src/file.ts`)).toBe(true);

    const sidecar = JSON.parse(
      await readFile(
        join(ws, "imported-sessions", "marcels-laptop", "claude", "sid-aaa.manifest.json"),
        "utf-8",
      ),
    );
    expect(sidecar.sid).toBe("sid-aaa");
    expect(sidecar.localRepoPath).toBe(localPath);
    expect(sidecar.importedJsonlPath).toBe(result.importedPath);

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

  test("re-accept of the same sid without mode → exists with divergence info", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    const m1 = manifest({ offerId: "o1" });
    const j1 = [
      JSON.stringify({ uuid: "u1", text: "hello" }),
      JSON.stringify({ uuid: "u2", text: "world" }),
    ].join("\n");
    await storePendingOffer(ws, m1, j1);
    await acceptOffer({
      workspaceDir: ws,
      offerId: "o1",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });

    // Re-send: same prefix, two new turns appended → strict superset.
    const m2 = manifest({ offerId: "o2" });
    const j2 = [
      JSON.stringify({ uuid: "u1", text: "hello" }),
      JSON.stringify({ uuid: "u2", text: "world" }),
      JSON.stringify({ uuid: "u3", text: "more" }),
      JSON.stringify({ uuid: "u4", text: "still more" }),
    ].join("\n");
    await storePendingOffer(ws, m2, j2);
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "o2",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("exists");
    expect(r.divergence?.supersetOfExisting).toBe(true);
    expect(r.divergence?.incomingAfter).toBe(2);
    expect(r.divergence?.existingAfter).toBe(0);
    // Pending file stays alive so the user can retry with mode.
    expect(await loadPendingOffer(ws, "o2")).not.toBeNull();
  });

  test("mode=replace overwrites the existing import", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    await storePendingOffer(ws, manifest({ offerId: "o1" }), "old content");
    await acceptOffer({
      workspaceDir: ws,
      offerId: "o1",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });

    await storePendingOffer(ws, manifest({ offerId: "o2" }), "new content");
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "o2",
      repoLookup: repoFound("/local/bar"),
      mode: "replace",
      claudeProjectsDir: cpd,
    });
    if (!r.ok) throw new Error("expected ok");
    const imported = await readFile(r.importedPath, "utf-8");
    expect(imported).toBe("new content");
    // Default-named file — same path as the first import.
    expect(r.importedPath).toBe(
      join(cpd, encodedProjectDir("/local/bar"), "sid-aaa.jsonl"),
    );
  });

  test("mode=keep_both writes a sibling file with a suffix", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    await storePendingOffer(ws, manifest({ offerId: "o1" }), "first");
    const r1 = await acceptOffer({
      workspaceDir: ws,
      offerId: "o1",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });
    if (!r1.ok) throw new Error("expected ok");

    await storePendingOffer(ws, manifest({ offerId: "o2" }), "second");
    const r2 = await acceptOffer({
      workspaceDir: ws,
      offerId: "o2",
      repoLookup: repoFound("/local/bar"),
      mode: "keep_both",
      claudeProjectsDir: cpd,
    });
    if (!r2.ok) throw new Error("expected ok");

    expect(r2.importedPath).not.toBe(r1.importedPath);
    expect(r2.importedPath.includes("sid-aaa.")).toBe(true);
    // Both files survive
    expect(await readFile(r1.importedPath, "utf-8")).toBe("first");
    expect(await readFile(r2.importedPath, "utf-8")).toBe("second");
  });

  test("first import succeeds even when mode defaults — exists check applies only on collision", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    await storePendingOffer(ws, manifest(), "fresh");
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "offer-aaa",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });
    expect(r.ok).toBe(true);
  });

  test("genuine fork → exists with diverged=true, supersetOfExisting=false", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    const j1 = [
      JSON.stringify({ uuid: "u1" }),
      JSON.stringify({ uuid: "u2" }),
      JSON.stringify({ uuid: "x1" }),
    ].join("\n");
    const j2 = [
      JSON.stringify({ uuid: "u1" }),
      JSON.stringify({ uuid: "u2" }),
      JSON.stringify({ uuid: "y1" }),
      JSON.stringify({ uuid: "y2" }),
    ].join("\n");
    await storePendingOffer(ws, manifest({ offerId: "o1" }), j1);
    await acceptOffer({
      workspaceDir: ws,
      offerId: "o1",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });

    await storePendingOffer(ws, manifest({ offerId: "o2" }), j2);
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: "o2",
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("exists");
    expect(r.divergence?.diverged).toBe(true);
    expect(r.divergence?.supersetOfExisting).toBe(false);
    expect(r.divergence?.commonPrefix).toBe(2);
    expect(r.divergence?.existingAfter).toBe(1);
    expect(r.divergence?.incomingAfter).toBe(2);
  });

  test("rewrites worktree path when receiver has a matching worktree; JSONL lives under encoded(worktree)", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
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
      claudeProjectsDir: cpd,
      toPlatform: "darwin",
    });
    if (!r.ok) throw new Error("expected ok");
    // Worktree wins over repo path when picking the project dir.
    expect(r.importedPath).toBe(
      join(
        cpd,
        encodedProjectDir("/local/bar/.worktrees/feat-x"),
        "sid-aaa.jsonl",
      ),
    );
    const imported = await readFile(r.importedPath, "utf-8");
    expect(imported.includes(m.originWorktreePath!)).toBe(false);
    expect(imported.includes("/local/bar/.worktrees/feat-x/src/file.ts")).toBe(
      true,
    );
  });

  test("codex offer keeps legacy layout: JSONL + sidecar under imported-sessions/<machine>/codex/", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    const m = manifest({ agent: "codex" });
    await storePendingOffer(ws, m, "irrelevant\n");
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: m.offerId,
      repoLookup: repoFound("/local/bar"),
      claudeProjectsDir: cpd,
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.importedPath).toBe(
      join(ws, "imported-sessions", "marcels-laptop", "codex", "sid-aaa.jsonl"),
    );
    // The shared claude projects dir stays empty for codex imports.
    expect(await readdir(cpd)).toEqual([]);
  });

  test("ollama offer: JSONL lands in <workspace>/ollama/<sid>.jsonl, sidecar under imported-sessions", async () => {
    const ws = await tempWorkspace();
    const cpd = await tempClaudeProjects();
    const m = manifest({ agent: "ollama" });
    const j = JSON.stringify({
      kind: "header",
      termId: m.sid,
      spawnCwd: m.originRepoPath,
      model: "llama3",
      createdAt: "2026-05-21T10:00:00Z",
    });
    await storePendingOffer(ws, m, j);

    const localPath = "/home/desktop/code/bar";
    const r = await acceptOffer({
      workspaceDir: ws,
      offerId: m.offerId,
      repoLookup: repoFound(localPath),
      claudeProjectsDir: cpd,
      toPlatform: "darwin",
    });
    if (!r.ok) throw new Error("expected ok");

    // JSONL lives in the workspace's own ollama dir, the same place
    // scanOllama walks — so an imported ollama session shows up as a
    // native one with no extra plumbing.
    expect(r.importedPath).toBe(join(ws, "ollama", "sid-aaa.jsonl"));

    // Sidecar stays under imported-sessions/, carries the pointer.
    const sidecar = JSON.parse(
      await readFile(
        join(ws, "imported-sessions", "marcels-laptop", "ollama", "sid-aaa.manifest.json"),
        "utf-8",
      ),
    );
    expect(sidecar.importedJsonlPath).toBe(r.importedPath);
    expect(sidecar.localRepoPath).toBe(localPath);

    // The rewritten JSONL's spawnCwd now points at the receiver's path.
    const header = JSON.parse((await readFile(r.importedPath, "utf-8")).split("\n")[0]!);
    expect(header.spawnCwd).toBe(localPath);
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

describe("sanitizeJsonl", () => {
  test("strips HTML tags from text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: 'Hello <img src=x onerror="alert(1)"> world' },
        ],
      },
    });
    const result = sanitizeJsonl(line);
    const parsed = JSON.parse(result);
    expect(parsed.message.content[0].text).toBe("Hello  world");
    expect(parsed.message.content[0].text).not.toContain("<");
  });

  test("strips HTML from thinking blocks", () => {
    const line = JSON.stringify({
      message: {
        content: [
          { type: "thinking", text: "<script>steal()</script>plan step" },
        ],
      },
    });
    const result = sanitizeJsonl(line);
    const parsed = JSON.parse(result);
    expect(parsed.message.content[0].text).toBe("steal()plan step");
  });

  test("preserves lines without HTML", () => {
    const line = JSON.stringify({
      message: { content: [{ type: "text", text: "clean markdown **bold**" }] },
    });
    expect(sanitizeJsonl(line)).toBe(line);
  });

  test("preserves non-message JSONL lines", () => {
    const line = JSON.stringify({ cwd: "/Users/marcel/git/bar" });
    expect(sanitizeJsonl(line)).toBe(line);
  });

  test("handles multi-line JSONL", () => {
    const lines = [
      JSON.stringify({ cwd: "/tmp" }),
      JSON.stringify({
        message: {
          content: [{ type: "text", text: "<b>bold</b> text" }],
        },
      }),
      JSON.stringify({
        message: {
          content: [{ type: "text", text: "no html here" }],
        },
      }),
    ].join("\n");
    const result = sanitizeJsonl(lines);
    const parsed = result.split("\n").map((l) => JSON.parse(l));
    expect(parsed[1].message.content[0].text).toBe("bold text");
    expect(parsed[2].message.content[0].text).toBe("no html here");
  });

  test("storePendingOffer sanitizes JSONL on ingest", async () => {
    const ws = await tempWorkspace();
    const malicious = JSON.stringify({
      message: {
        content: [{ type: "text", text: '<img src=x onerror="fetch(\\"/api/shutdown\\")"> hello' }],
      },
    });
    await storePendingOffer(ws, manifest(), malicious);
    const loaded = await loadPendingOffer(ws, "offer-aaa");
    const parsed = JSON.parse(loaded!.jsonl);
    expect(parsed.message.content[0].text).not.toContain("<img");
    expect(parsed.message.content[0].text).toContain("hello");
  });
});
