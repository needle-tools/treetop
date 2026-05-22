/**
 * One-shot migrator for imported sessions written under the old
 * layout. Pre-discovery imports lived directly under
 *   <ws>/imported-sessions/<machine>/<sid>.jsonl
 * The discovery commit moved them to
 *   <ws>/imported-sessions/<machine>/<agent>/<sid>.jsonl
 * so the path encodes the agent kind and `resolveSessionAgent` /
 * `scanImported` stay sync. This module rehouses the old files into
 * the new layout, reading the sidecar `.manifest.json` for the agent
 * kind. Runs once at daemon startup; idempotent (a second run after
 * everything is migrated reports `{ moved: 0, skipped: 0 }`).
 */

import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rename,
  stat,
  access,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_ROOT, claudeProjectDirForCwd } from "./agents";

export interface MigrateResult {
  moved: number;
  /** Old-layout `.jsonl` files we couldn't rehouse — missing sidecar,
   *  unknown agent, or read error. Logged so the user can clean them
   *  up by hand if they care. */
  skipped: number;
}

const VALID_AGENTS = new Set(["claude", "codex"]);

export async function migrateLegacyImportedSessions(
  workspaceDir: string,
): Promise<MigrateResult> {
  const root = join(workspaceDir, "imported-sessions");
  let machines: string[];
  try {
    machines = await readdir(root);
  } catch {
    return { moved: 0, skipped: 0 };
  }

  let moved = 0;
  let skipped = 0;
  for (const machine of machines) {
    const machineDir = join(root, machine);
    let entries: string[];
    try {
      entries = await readdir(machineDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      // Already a directory? Then this is the new layout (claude/ or
      // codex/), not a file to migrate.
      const jsonlPath = join(machineDir, name);
      try {
        const st = await stat(jsonlPath);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const sid = name.replace(/\.jsonl$/, "");
      const sidecarPath = join(machineDir, `${sid}.manifest.json`);
      let agent: string | null = null;
      try {
        const sidecarRaw = await readFile(sidecarPath, "utf-8");
        const sidecar = JSON.parse(sidecarRaw) as { agent?: unknown };
        if (typeof sidecar.agent === "string") agent = sidecar.agent;
      } catch {
        // No sidecar — can't know the agent. Skip.
      }
      if (!agent || !VALID_AGENTS.has(agent)) {
        skipped += 1;
        continue;
      }
      const targetDir = join(machineDir, agent);
      await mkdir(targetDir, { recursive: true });
      try {
        await rename(jsonlPath, join(targetDir, name));
      } catch {
        skipped += 1;
        continue;
      }
      try {
        await rename(sidecarPath, join(targetDir, `${sid}.manifest.json`));
      } catch {
        // sidecar move failed but jsonl already moved — best effort
      }
      moved += 1;
    }
  }
  return { moved, skipped };
}

/** Second-stage migrator: rehouse legacy claude imports out of
 *  `<ws>/imported-sessions/<machine>/claude/<sid>.jsonl` and into
 *  `<claudeProjectsDir>/<encoded(cwd)>/<sid>.jsonl` so Claude Code's
 *  own `--resume <sid>` lookup finds them. Sidecar stays where it is,
 *  but gains an `importedJsonlPath` field pointing at the new
 *  location. Idempotent: a JSONL whose sidecar already has
 *  `importedJsonlPath` and whose file exists at that path is left
 *  alone. */
export async function migrateClaudeImportsToProjects(
  workspaceDir: string,
  claudeProjectsDir: string = CLAUDE_ROOT(),
): Promise<MigrateResult> {
  const root = join(workspaceDir, "imported-sessions");
  let machines: string[];
  try {
    machines = await readdir(root);
  } catch {
    return { moved: 0, skipped: 0 };
  }
  let moved = 0;
  let skipped = 0;
  for (const machine of machines) {
    const claudeDir = join(root, machine, "claude");
    let entries: string[];
    try {
      entries = await readdir(claudeDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.replace(/\.jsonl$/, "").replace(/\.from-\d+$/, "");
      const jsonlPath = join(claudeDir, name);
      const sidecarPath = join(claudeDir, `${sid}.manifest.json`);
      let sidecar: {
        localRepoPath?: string;
        localWorktreePath?: string;
        importedJsonlPath?: string;
      };
      try {
        sidecar = JSON.parse(await readFile(sidecarPath, "utf-8"));
      } catch {
        skipped += 1;
        continue;
      }
      // Already migrated if sidecar points at an existing claude-projects file.
      if (sidecar.importedJsonlPath) {
        try {
          await access(sidecar.importedJsonlPath);
          // The legacy sibling JSONL is now redundant.
          await dropLegacyJsonl(jsonlPath, sidecar.importedJsonlPath);
          continue;
        } catch {
          // pointer dangling — fall through and re-migrate
        }
      }
      const cwd = sidecar.localWorktreePath || sidecar.localRepoPath || "";
      if (!cwd) {
        skipped += 1;
        continue;
      }
      const targetDir = await claudeProjectDirForCwd(cwd, claudeProjectsDir);
      await mkdir(targetDir, { recursive: true });
      const targetPath = join(targetDir, `${sid}.jsonl`);
      let alreadyThere = false;
      try {
        await access(targetPath);
        alreadyThere = true;
      } catch {
        // target free — proceed
      }
      try {
        if (!alreadyThere) {
          await rename(jsonlPath, targetPath);
        }
      } catch {
        // Cross-volume rename (EXDEV) or perm — copy + remove as a
        // best-effort fallback. We read+write since `cp` and
        // `copyFile` both need a real fs path; rename failure
        // usually means EXDEV which copyFile handles.
        try {
          const data = await readFile(jsonlPath);
          await writeFile(targetPath, data);
          await rename(jsonlPath, jsonlPath + ".migrated-bak");
        } catch {
          skipped += 1;
          continue;
        }
      }
      // Update sidecar with the canonical pointer.
      const updated = { ...sidecar, importedJsonlPath: targetPath };
      await writeFile(sidecarPath, JSON.stringify(updated, null, 2));
      if (alreadyThere) {
        // Source file lost the rename race (target already had a file
        // — likely a prior hardlink or a previous half-finished
        // migration). Drop it if it's safe to do so.
        await dropLegacyJsonl(jsonlPath, targetPath);
      }
      moved += 1;
    }
  }
  return { moved, skipped };
}

/** Remove a legacy `imported-sessions/.../<sid>.jsonl` file once a
 *  canonical copy exists at `keepPath`. The legacy file is unlinked
 *  outright when it's safe — same inode (hardlink) or byte-identical
 *  content. Otherwise it's renamed to `<...>.migrated-bak` so the
 *  user can compare by hand before deleting (this preserves data when
 *  someone hand-edited one of the two paths between migrations). */
async function dropLegacyJsonl(legacyPath: string, keepPath: string): Promise<void> {
  let legacySt;
  try {
    legacySt = await stat(legacyPath);
  } catch {
    return; // already gone
  }
  let keepSt;
  try {
    keepSt = await stat(keepPath);
  } catch {
    // Without a verified canonical copy we mustn't delete. Park as .bak.
    try {
      await rename(legacyPath, legacyPath + ".migrated-bak");
    } catch {}
    return;
  }
  // Same inode → hardlink alias; unlink is a no-op on the data.
  if (legacySt.ino && keepSt.ino && legacySt.ino === keepSt.ino) {
    try {
      await unlink(legacyPath);
    } catch {}
    return;
  }
  // Different inodes — compare bytes. Cheap because we've already
  // committed to reading at least one side during accept/migrate, and
  // the read happens once per legacy file.
  try {
    const [a, b] = await Promise.all([
      readFile(legacyPath),
      readFile(keepPath),
    ]);
    if (a.equals(b)) {
      await unlink(legacyPath);
      return;
    }
  } catch {
    // fall through to park-as-bak
  }
  try {
    await rename(legacyPath, legacyPath + ".migrated-bak");
  } catch {}
}
