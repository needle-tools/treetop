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
import { rewritePaths, type SharePlatform } from "./session-share";

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
    // Iterate by manifest, not by jsonl: after a successful migration
    // the .jsonl sibling is gone but the manifest stays — and that's
    // exactly the case where we still need to act, e.g. when the
    // encoder changes and the existing `importedJsonlPath` becomes
    // stale (the user's prod failure mode).
    for (const name of entries) {
      if (!name.endsWith(".manifest.json")) continue;
      const sid = name.replace(/\.manifest\.json$/, "");
      const sidecarPath = join(claudeDir, name);
      const jsonlPath = join(claudeDir, `${sid}.jsonl`);
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
      const cwd = sidecar.localWorktreePath || sidecar.localRepoPath || "";
      if (!cwd) {
        skipped += 1;
        continue;
      }
      const targetDir = await claudeProjectDirForCwd(cwd, claudeProjectsDir);
      await mkdir(targetDir, { recursive: true });
      const targetPath = join(targetDir, `${sid}.jsonl`);

      // Already migrated, and to the place the *current* encoder
      // would land it? (Previously this just checked existence at
      // `importedJsonlPath`. That was wrong: an earlier encoder
      // version produced a different directory name for paths with
      // `~` / `.` in them, so a stale pointer would survive the
      // re-migration and Claude --resume would still fail. Compare
      // against the path the current encoder produces.)
      if (sidecar.importedJsonlPath === targetPath) {
        try {
          await access(targetPath);
          await dropLegacyJsonl(jsonlPath, targetPath);
          continue;
        } catch {
          // pointer dangling — fall through and re-migrate
        }
      }
      // Stale pointer: the sidecar references a different location
      // than what the current encoder produces. Move the file
      // there if it's at the stale location, then rewrite the
      // sidecar's pointer.
      if (
        sidecar.importedJsonlPath &&
        sidecar.importedJsonlPath !== targetPath
      ) {
        try {
          await access(sidecar.importedJsonlPath);
          try {
            await rename(sidecar.importedJsonlPath, targetPath);
            const updated = { ...sidecar, importedJsonlPath: targetPath };
            await writeFile(sidecarPath, JSON.stringify(updated, null, 2));
            moved += 1;
            continue;
          } catch {
            // EXDEV / perm — copy + remove fallback
            try {
              const data = await readFile(sidecar.importedJsonlPath);
              await writeFile(targetPath, data);
              await unlink(sidecar.importedJsonlPath);
              const updated = { ...sidecar, importedJsonlPath: targetPath };
              await writeFile(sidecarPath, JSON.stringify(updated, null, 2));
              moved += 1;
              continue;
            } catch {
              skipped += 1;
              continue;
            }
          }
        } catch {
          // Stale pointer's file is gone too — fall through to the
          // standard rehoming-from-imported-sessions path below.
        }
      }
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

/** Third-stage migrator: rehouse legacy ollama imports out of
 *  `<ws>/imported-sessions/<machine>/ollama/<sid>.jsonl` into
 *  `<ws>/ollama/<sid>.jsonl` so the receiver's `scanOllama` discovers
 *  them as native sessions (no separate "imported-ollama" code path).
 *  Sidecar stays under imported-sessions/, gains `importedJsonlPath`
 *  pointing at the new location. Idempotent on `importedJsonlPath`. */
export async function migrateOllamaImportsToWorkspace(
  workspaceDir: string,
): Promise<MigrateResult> {
  const root = join(workspaceDir, "imported-sessions");
  let machines: string[];
  try {
    machines = await readdir(root);
  } catch {
    return { moved: 0, skipped: 0 };
  }
  const ollamaDir = join(workspaceDir, "ollama");
  let moved = 0;
  let skipped = 0;
  for (const machine of machines) {
    const importDir = join(root, machine, "ollama");
    let entries: string[];
    try {
      entries = await readdir(importDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.replace(/\.jsonl$/, "").replace(/\.from-\d+$/, "");
      const jsonlPath = join(importDir, name);
      const sidecarPath = join(importDir, `${sid}.manifest.json`);
      let sidecar: { importedJsonlPath?: string };
      try {
        sidecar = JSON.parse(await readFile(sidecarPath, "utf-8"));
      } catch {
        skipped += 1;
        continue;
      }
      if (sidecar.importedJsonlPath) {
        try {
          await access(sidecar.importedJsonlPath);
          await dropLegacyJsonl(jsonlPath, sidecar.importedJsonlPath);
          continue;
        } catch {
          // pointer dangling — fall through and re-migrate
        }
      }
      await mkdir(ollamaDir, { recursive: true });
      const targetPath = join(ollamaDir, `${sid}.jsonl`);
      let alreadyThere = false;
      try {
        await access(targetPath);
        alreadyThere = true;
      } catch {}
      try {
        if (!alreadyThere) await rename(jsonlPath, targetPath);
      } catch {
        try {
          const data = await readFile(jsonlPath);
          await writeFile(targetPath, data);
          await rename(jsonlPath, jsonlPath + ".migrated-bak");
        } catch {
          skipped += 1;
          continue;
        }
      }
      const updated = { ...sidecar, importedJsonlPath: targetPath };
      await writeFile(sidecarPath, JSON.stringify(updated, null, 2));
      if (alreadyThere) await dropLegacyJsonl(jsonlPath, targetPath);
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
async function dropLegacyJsonl(
  legacyPath: string,
  keepPath: string,
): Promise<void> {
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

export interface RepairResult {
  /** Claude sidecars examined. */
  scanned: number;
  /** Imported JSONLs whose stale foreign cwd was rewritten in place. */
  repaired: number;
}

/** Fourth-stage migrator: repair imported claude sessions whose paths
 *  were never rewritten at import time.
 *
 *  A session shared from another machine carries the origin's absolute
 *  cwd in every transcript line. Accept-time `rewritePaths` is supposed
 *  to swap that for the receiver's local path. A slash-encoding mismatch
 *  bug (the sender stored `originRepoPath` with forward slashes — git's
 *  `--show-toplevel` form — while Claude Code records the cwd with
 *  backslashes) made that swap silently match nothing, leaving a dead
 *  foreign cwd like `C:\git\repo` that doesn't exist on the receiver.
 *  The terminal spawn then failed with a misleading
 *  `fork/exec /bin/bash: no such file or directory`.
 *
 *  Detection is just re-running the (now-fixed) rewrite from the sidecar's
 *  recorded origin→local paths: if it changes the file, the original
 *  import under-rewrote and we persist the correction. Idempotent — an
 *  already-correct transcript no longer contains the origin path, so the
 *  rewrite is a no-op and nothing is written. The first time a file is
 *  actually changed we park the pre-repair bytes as `<jsonl>.repair-bak`. */
export async function repairImportedSessionCwds(
  workspaceDir: string,
  claudeProjectsDir: string = CLAUDE_ROOT(),
): Promise<RepairResult> {
  const root = join(workspaceDir, "imported-sessions");
  let machines: string[];
  try {
    machines = await readdir(root);
  } catch {
    return { scanned: 0, repaired: 0 };
  }

  const toPlatform: SharePlatform =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";

  let scanned = 0;
  let repaired = 0;
  for (const machine of machines) {
    const claudeDir = join(root, machine, "claude");
    let entries: string[];
    try {
      entries = await readdir(claudeDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".manifest.json")) continue;
      const sid = name.replace(/\.manifest\.json$/, "");
      const sidecarPath = join(claudeDir, name);
      let sidecar: {
        originRepoPath?: string;
        originWorktreePath?: string;
        originPlatform?: SharePlatform;
        localRepoPath?: string;
        localWorktreePath?: string;
        importedJsonlPath?: string;
      };
      try {
        sidecar = JSON.parse(await readFile(sidecarPath, "utf-8"));
      } catch {
        continue;
      }
      scanned += 1;

      // Where the live JSONL lives: prefer the sidecar pointer, fall back
      // to the encoder-derived projects slot (matches scanImported).
      const cwdForDir =
        sidecar.localWorktreePath || sidecar.localRepoPath || "";
      let jsonlPath = sidecar.importedJsonlPath;
      if (!jsonlPath && cwdForDir) {
        jsonlPath = join(
          await claudeProjectDirForCwd(cwdForDir, claudeProjectsDir),
          `${sid}.jsonl`,
        );
      }
      if (!jsonlPath) continue;

      let content: string;
      try {
        content = await readFile(jsonlPath, "utf-8");
      } catch {
        continue;
      }

      // Re-apply exactly what accept-time does: repo root first, then the
      // worktree if both ends carry it. `originPlatform` may be absent on
      // very old sidecars — default to the local platform, which makes the
      // rewrite a no-op for same-platform imports rather than guessing.
      const fromPlatform = sidecar.originPlatform ?? toPlatform;
      let rewritten = content;
      if (sidecar.originRepoPath && sidecar.localRepoPath) {
        rewritten = rewritePaths(rewritten, {
          from: sidecar.originRepoPath,
          to: sidecar.localRepoPath,
          fromPlatform,
          toPlatform,
        });
      }
      if (sidecar.originWorktreePath) {
        // Fall back to localRepoPath when the receiver had no matching
        // worktree — same fix as acceptOffer. Otherwise worktree-shaped
        // cwds (parent-of-repo or sibling layouts) stay as sender-side
        // paths and scanClaude can't map the session to any local repo.
        const target = sidecar.localWorktreePath ?? sidecar.localRepoPath;
        if (target) {
          rewritten = rewritePaths(rewritten, {
            from: sidecar.originWorktreePath,
            to: target,
            fromPlatform,
            toPlatform,
          });
        }
      }

      if (rewritten === content) continue;

      // One-time backup before the first destructive write.
      const bak = jsonlPath + ".repair-bak";
      try {
        await access(bak);
      } catch {
        await writeFile(bak, content);
      }
      await writeFile(jsonlPath, rewritten);
      repaired += 1;
    }
  }
  return { scanned, repaired };
}
