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
import { mkdtemp, mkdir, writeFile, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyImportedSessions } from "../src/session-share-migrate";

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-migrate-"));
}

describe("migrateLegacyImportedSessions", () => {
  test("noop when imported-sessions dir doesn't exist", async () => {
    const w = await ws();
    expect(await migrateLegacyImportedSessions(w)).toEqual({ moved: 0, skipped: 0 });
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
    expect(await readFile(join(newDir, "n.jsonl"), "utf-8")).toBe("already-migrated");
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
