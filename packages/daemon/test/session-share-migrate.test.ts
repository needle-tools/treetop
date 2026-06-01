/**
 * One-time migrator for imported sessions written under the pre-discovery
 * layout. The original v1 of session-share wrote imported files at
 *   <ws>/imported-sessions/<machine>/<sid>.jsonl
 * but the discovery commit moved them to
 *   <ws>/imported-sessions/<machine>/<agent>/<sid>.jsonl
 * so resolveSessionAgent can stay sync and scanImported can iterate by
 * agent kind. Users who imported a session before the path change
 * have orphaned files in the old layout — invisible to the dashboard.
 * The migrator detects them and moves them to the new layout, reading
 * the sidecar manifest for the agent kind.
 */

import { test, expect, describe } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateLegacyImportedSessions,
  migrateClaudeImportsToProjects,
  migrateOllamaImportsToWorkspace,
  repairImportedSessionCwds,
} from "../src/session-share-migrate";

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-migrate-"));
}

async function cpd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-migrate-cpd-"));
}

describe("migrateLegacyImportedSessions", () => {
  test("noop when imported-sessions dir doesn't exist", async () => {
    const w = await ws();
    expect(await migrateLegacyImportedSessions(w)).toEqual({
      moved: 0,
      skipped: 0,
    });
  });

  test("moves an old-layout claude pair into <machine>/claude/", async () => {
    const w = await ws();
    const machineDir = join(w, "imported-sessions", "host-1");
    await mkdir(machineDir, { recursive: true });
    await writeFile(join(machineDir, "abc.jsonl"), "transcript");
    await writeFile(
      join(machineDir, "abc.manifest.json"),
      JSON.stringify({ sid: "abc", agent: "claude", localRepoPath: "/r" }),
    );

    const res = await migrateLegacyImportedSessions(w);
    expect(res).toEqual({ moved: 1, skipped: 0 });

    // New layout exists with both files
    expect(
      await readFile(
        join(w, "imported-sessions", "host-1", "claude", "abc.jsonl"),
        "utf-8",
      ),
    ).toBe("transcript");
    const sidecar = JSON.parse(
      await readFile(
        join(w, "imported-sessions", "host-1", "claude", "abc.manifest.json"),
        "utf-8",
      ),
    );
    expect(sidecar.sid).toBe("abc");

    // Old layout files gone
    let oldStillThere = true;
    try {
      await access(join(machineDir, "abc.jsonl"));
    } catch {
      oldStillThere = false;
    }
    expect(oldStillThere).toBe(false);
  });

  test("respects codex sidecar agent", async () => {
    const w = await ws();
    const machineDir = join(w, "imported-sessions", "host-c");
    await mkdir(machineDir, { recursive: true });
    await writeFile(join(machineDir, "xyz.jsonl"), "c");
    await writeFile(
      join(machineDir, "xyz.manifest.json"),
      JSON.stringify({ sid: "xyz", agent: "codex" }),
    );
    const res = await migrateLegacyImportedSessions(w);
    expect(res.moved).toBe(1);
    await access(join(w, "imported-sessions", "host-c", "codex", "xyz.jsonl"));
  });

  test("leaves new-layout files alone", async () => {
    const w = await ws();
    const newDir = join(w, "imported-sessions", "host-2", "claude");
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, "n.jsonl"), "already-migrated");
    await writeFile(
      join(newDir, "n.manifest.json"),
      JSON.stringify({ sid: "n", agent: "claude" }),
    );
    const res = await migrateLegacyImportedSessions(w);
    expect(res).toEqual({ moved: 0, skipped: 0 });
    // File still where it was
    expect(await readFile(join(newDir, "n.jsonl"), "utf-8")).toBe(
      "already-migrated",
    );
  });

  test("skips orphan jsonl without a matching sidecar", async () => {
    const w = await ws();
    const machineDir = join(w, "imported-sessions", "host-o");
    await mkdir(machineDir, { recursive: true });
    await writeFile(join(machineDir, "lonely.jsonl"), "orphan");
    const res = await migrateLegacyImportedSessions(w);
    expect(res).toEqual({ moved: 0, skipped: 1 });
    // File untouched, no agent dir created
    await access(join(machineDir, "lonely.jsonl"));
    const entries = await readdir(machineDir);
    expect(entries).toEqual(["lonely.jsonl"]);
  });

  test("skips files whose sidecar has an unknown agent", async () => {
    const w = await ws();
    const machineDir = join(w, "imported-sessions", "host-u");
    await mkdir(machineDir, { recursive: true });
    await writeFile(join(machineDir, "u.jsonl"), "u");
    await writeFile(
      join(machineDir, "u.manifest.json"),
      JSON.stringify({ sid: "u", agent: "skynet" }),
    );
    const res = await migrateLegacyImportedSessions(w);
    expect(res).toEqual({ moved: 0, skipped: 1 });
  });
});

describe("migrateClaudeImportsToProjects", () => {
  test("noop when imported-sessions dir doesn't exist", async () => {
    const w = await ws();
    const root = await cpd();
    expect(await migrateClaudeImportsToProjects(w, root)).toEqual({
      moved: 0,
      skipped: 0,
    });
  });

  test("moves a claude JSONL into <claudeProjectsDir>/<encoded(cwd)>/ and stamps the sidecar", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host-1", "claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "abc.jsonl"), "transcript");
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        localRepoPath: "/local/foo",
      }),
    );

    const res = await migrateClaudeImportsToProjects(w, root);
    expect(res).toEqual({ moved: 1, skipped: 0 });

    const targetPath = join(root, "-local-foo", "abc.jsonl");
    expect(await readFile(targetPath, "utf-8")).toBe("transcript");

    const sidecar = JSON.parse(
      await readFile(join(dir, "abc.manifest.json"), "utf-8"),
    );
    expect(sidecar.importedJsonlPath).toBe(targetPath);

    // Original jsonl is gone (renamed away on rename success).
    let stillThere = true;
    try {
      await access(join(dir, "abc.jsonl"));
    } catch {
      stillThere = false;
    }
    expect(stillThere).toBe(false);
  });

  test("uses localWorktreePath over localRepoPath when both are set", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.jsonl"), "x");
    await writeFile(
      join(dir, "s.manifest.json"),
      JSON.stringify({
        sid: "s",
        agent: "claude",
        localRepoPath: "/local/bar",
        localWorktreePath: "/local/bar/.worktrees/feat-x",
      }),
    );
    await migrateClaudeImportsToProjects(w, root);
    // `.worktrees` encodes to `-worktrees` — `.` is replaced with `-`
    // to match Claude's actual encoder. A naive reading might expect
    // `.worktrees` preserved; that would mis-locate the file.
    await access(join(root, "-local-bar--worktrees-feat-x", "s.jsonl"));
  });

  test("idempotent: a sidecar whose importedJsonlPath already points at an existing file is left alone", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    const targetDir = join(root, "-local-foo");
    await mkdir(dir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const targetPath = join(targetDir, "abc.jsonl");
    await writeFile(targetPath, "already-migrated");
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        localRepoPath: "/local/foo",
        importedJsonlPath: targetPath,
      }),
    );
    const res = await migrateClaudeImportsToProjects(w, root);
    expect(res).toEqual({ moved: 0, skipped: 0 });
    expect(await readFile(targetPath, "utf-8")).toBe("already-migrated");
  });

  test("skips when the sidecar has no localRepoPath / localWorktreePath to derive the project dir", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.jsonl"), "x");
    await writeFile(
      join(dir, "s.manifest.json"),
      JSON.stringify({ sid: "s", agent: "claude" }),
    );
    const res = await migrateClaudeImportsToProjects(w, root);
    expect(res).toEqual({ moved: 0, skipped: 1 });
  });

  test("unlinks the legacy JSONL when its content matches the canonical copy (no .migrated-bak leftover)", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    const targetDir = join(root, "-local-foo");
    await mkdir(dir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const body = "same content here\n";
    const targetPath = join(targetDir, "abc.jsonl");
    await writeFile(targetPath, body);
    await writeFile(join(dir, "abc.jsonl"), body);
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        localRepoPath: "/local/foo",
      }),
    );
    await migrateClaudeImportsToProjects(w, root);
    // Legacy JSONL is gone — no .migrated-bak either.
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(["abc.manifest.json"]);
  });

  test("parks the legacy JSONL as .migrated-bak when content differs from the canonical copy", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    const targetDir = join(root, "-local-foo");
    await mkdir(dir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "abc.jsonl"), "canonical body\n");
    await writeFile(join(dir, "abc.jsonl"), "DIFFERENT body — needs review\n");
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        localRepoPath: "/local/foo",
      }),
    );
    await migrateClaudeImportsToProjects(w, root);
    const entries = await readdir(dir);
    expect(entries.sort()).toEqual([
      "abc.jsonl.migrated-bak",
      "abc.manifest.json",
    ]);
  });

  test("re-migrates when sidecar.importedJsonlPath is stale (encoder changed)", async () => {
    // Reproduces the bug we hit in prod: an earlier encoder produced
    // `-Users-...-js-package~` for a cwd ending in `~`; the current
    // encoder produces `-Users-...-js-package-` because `~` now
    // gets replaced with `-` to match Claude's own behaviour.
    // After the encoder change, the migrator must detect that the
    // sidecar's pointer is stale and move the file to where the
    // current encoder lands it. Otherwise claude --resume keeps
    // failing.
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    // Stale dir, where the old encoder placed the file:
    const staleDir = join(root, "-foo-bar-pkg~");
    // Where the current encoder would now place it:
    const currentDir = join(root, "-foo-bar-pkg-");
    await mkdir(dir, { recursive: true });
    await mkdir(staleDir, { recursive: true });
    const stalePath = join(staleDir, "sid.jsonl");
    await writeFile(stalePath, "imported");
    await writeFile(
      join(dir, "sid.manifest.json"),
      JSON.stringify({
        sid: "sid",
        agent: "claude",
        localRepoPath: "/foo/bar/pkg~",
        importedJsonlPath: stalePath,
      }),
    );

    const res = await migrateClaudeImportsToProjects(w, root);
    expect(res.moved).toBe(1);

    // File moved to the current-encoder location
    expect(await readFile(join(currentDir, "sid.jsonl"), "utf-8")).toBe(
      "imported",
    );
    // Stale location now empty
    let stillThere = true;
    try {
      await access(stalePath);
    } catch {
      stillThere = false;
    }
    expect(stillThere).toBe(false);
    // Sidecar pointer updated
    const updated = JSON.parse(
      await readFile(join(dir, "sid.manifest.json"), "utf-8"),
    );
    expect(updated.importedJsonlPath).toBe(join(currentDir, "sid.jsonl"));
  });
});

describe("migrateOllamaImportsToWorkspace", () => {
  test("noop when imported-sessions dir doesn't exist", async () => {
    const w = await ws();
    expect(await migrateOllamaImportsToWorkspace(w)).toEqual({
      moved: 0,
      skipped: 0,
    });
  });

  test("moves an ollama JSONL into <workspace>/ollama/ and stamps the sidecar", async () => {
    const w = await ws();
    const dir = join(w, "imported-sessions", "host-1", "ollama");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "abc.jsonl"), "ollama-transcript");
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({ sid: "abc", agent: "ollama" }),
    );

    const res = await migrateOllamaImportsToWorkspace(w);
    expect(res).toEqual({ moved: 1, skipped: 0 });

    const targetPath = join(w, "ollama", "abc.jsonl");
    expect(await readFile(targetPath, "utf-8")).toBe("ollama-transcript");

    const sidecar = JSON.parse(
      await readFile(join(dir, "abc.manifest.json"), "utf-8"),
    );
    expect(sidecar.importedJsonlPath).toBe(targetPath);

    // Original jsonl is gone.
    let stillThere = true;
    try {
      await access(join(dir, "abc.jsonl"));
    } catch {
      stillThere = false;
    }
    expect(stillThere).toBe(false);
  });

  test("idempotent: a sidecar whose importedJsonlPath points at an existing file is left alone", async () => {
    const w = await ws();
    const dir = join(w, "imported-sessions", "host", "ollama");
    const ollamaDir = join(w, "ollama");
    await mkdir(dir, { recursive: true });
    await mkdir(ollamaDir, { recursive: true });
    const targetPath = join(ollamaDir, "abc.jsonl");
    await writeFile(targetPath, "already-migrated");
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "ollama",
        importedJsonlPath: targetPath,
      }),
    );
    const res = await migrateOllamaImportsToWorkspace(w);
    expect(res).toEqual({ moved: 0, skipped: 0 });
    expect(await readFile(targetPath, "utf-8")).toBe("already-migrated");
  });

  test("skips when sidecar is missing", async () => {
    const w = await ws();
    const dir = join(w, "imported-sessions", "host", "ollama");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "orphan.jsonl"), "x");
    const res = await migrateOllamaImportsToWorkspace(w);
    expect(res).toEqual({ moved: 0, skipped: 1 });
  });
});

describe("repairImportedSessionCwds", () => {
  test("noop when imported-sessions dir doesn't exist", async () => {
    const w = await ws();
    const root = await cpd();
    expect(await repairImportedSessionCwds(w, root)).toEqual({
      scanned: 0,
      repaired: 0,
    });
  });

  // The real-world bug: sender stored originRepoPath with forward slashes
  // (git --show-toplevel form) while the transcript cwd uses backslashes,
  // so accept-time rewrite matched nothing and the dead Windows cwd
  // survived. Repair re-applies the now-fixed rewrite.
  test("repairs a Windows import whose forward-slash origin never matched", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    const jsonlPath = join(dir, "abc.jsonl");
    const content = [
      JSON.stringify({ cwd: "C:\\git\\needle-haystack" }),
      JSON.stringify({ cwd: "C:\\git\\needle-haystack\\src\\app.ts" }),
    ].join("\n");
    await writeFile(jsonlPath, content);
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        originPlatform: "win32",
        originRepoPath: "C:/git/needle-haystack",
        localRepoPath: "/Users/marcel/git/needle-logs-view",
        importedJsonlPath: jsonlPath,
      }),
    );

    const res = await repairImportedSessionCwds(w, root);
    expect(res).toEqual({ scanned: 1, repaired: 1 });

    const out = await readFile(jsonlPath, "utf-8");
    expect(out.includes("needle-haystack")).toBe(false);
    expect(out.includes('"cwd":"/Users/marcel/git/needle-logs-view"')).toBe(
      true,
    );
    expect(
      out.includes('"cwd":"/Users/marcel/git/needle-logs-view/src/app.ts"'),
    ).toBe(true);

    // Pre-repair bytes parked alongside.
    expect(await readFile(jsonlPath + ".repair-bak", "utf-8")).toBe(content);
  });

  test("idempotent: a second run repairs nothing and leaves the file byte-identical", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    const jsonlPath = join(dir, "abc.jsonl");
    await writeFile(
      jsonlPath,
      JSON.stringify({ cwd: "C:\\git\\needle-haystack" }),
    );
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        originPlatform: "win32",
        originRepoPath: "C:/git/needle-haystack",
        localRepoPath: "/Users/marcel/git/needle-logs-view",
        importedJsonlPath: jsonlPath,
      }),
    );

    await repairImportedSessionCwds(w, root);
    const afterFirst = await readFile(jsonlPath, "utf-8");
    const second = await repairImportedSessionCwds(w, root);
    expect(second).toEqual({ scanned: 1, repaired: 0 });
    expect(await readFile(jsonlPath, "utf-8")).toBe(afterFirst);
  });

  test("already-correct import is scanned but not touched (no .repair-bak)", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    const jsonlPath = join(dir, "abc.jsonl");
    const content = JSON.stringify({ cwd: "/Users/marcel/git/needle-logs-view" });
    await writeFile(jsonlPath, content);
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        originPlatform: "win32",
        originRepoPath: "C:/git/needle-haystack",
        localRepoPath: "/Users/marcel/git/needle-logs-view",
        importedJsonlPath: jsonlPath,
      }),
    );

    const res = await repairImportedSessionCwds(w, root);
    expect(res).toEqual({ scanned: 1, repaired: 0 });
    expect(await readFile(jsonlPath, "utf-8")).toBe(content);
    let bakThere = true;
    try {
      await access(jsonlPath + ".repair-bak");
    } catch {
      bakThere = false;
    }
    expect(bakThere).toBe(false);
  });

  test("derives the JSONL location from the encoder when importedJsonlPath is absent", async () => {
    const w = await ws();
    const root = await cpd();
    const dir = join(w, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    // No importedJsonlPath in the sidecar → fall back to the encoded slot.
    const projectDir = join(root, "-local-foo");
    await mkdir(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, "abc.jsonl");
    await writeFile(jsonlPath, JSON.stringify({ cwd: "C:\\git\\repo" }));
    await writeFile(
      join(dir, "abc.manifest.json"),
      JSON.stringify({
        sid: "abc",
        agent: "claude",
        originPlatform: "win32",
        originRepoPath: "C:/git/repo",
        localRepoPath: "/local/foo",
      }),
    );

    const res = await repairImportedSessionCwds(w, root);
    expect(res).toEqual({ scanned: 1, repaired: 1 });
    expect(await readFile(jsonlPath, "utf-8")).toBe(
      JSON.stringify({ cwd: "/local/foo" }),
    );
  });
});
