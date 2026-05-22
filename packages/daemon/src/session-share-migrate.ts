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
  mkdir,
  rename,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

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
