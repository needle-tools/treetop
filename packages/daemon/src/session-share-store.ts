/**
 * Filesystem storage for the session-share offer/accept flow. Pending
 * offers live in `<workspace>/session-invites/<offerId>.json`; accepted
 * imports land in `<workspace>/imported-sessions/<originMachine>/<sid>.jsonl`
 * with a sidecar `.manifest.json`. See plans/PLAN-SESSION-SHARE.md.
 *
 * No HTTP, no Workspace dependency, no agent-CLI knowledge. The server
 * routes compose these functions with `validateManifest` from
 * `session-share.ts` and a `repoLookup` callback that resolves the
 * origin remote against the workspace's `repos.json`.
 */

import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { rewritePaths, type SessionShareManifest } from "./session-share";
import { findDivergence, type Divergence } from "./session-share-divergence";

const INVITES_DIR = "session-invites";
const IMPORTED_DIR = "imported-sessions";

export interface PendingOffer {
  manifest: SessionShareManifest;
  jsonl: string;
  receivedAt: string;
}

/** Caller-supplied resolver: given a normalised origin remote URL,
 *  return the receiver's local repo + (optionally) the matching worktree.
 *  Returning null means "the receiver doesn't have this repo cloned." */
export type RepoLookup = (
  originRepoRemote: string,
  originWorktreePath: string | undefined,
) => Promise<{ localRepoPath: string; localWorktreePath?: string } | null>;

/** How acceptOffer should behave when an imported file already exists
 *  for `(originMachine, sid)`:
 *   - `abort_if_exists` (default): refuse and return `{ ok: false,
 *     error: "exists", divergence }` so the UI can prompt the user.
 *   - `replace`: overwrite the existing file.
 *   - `keep_both`: write to a sibling path `<sid>.from-<machine>-<n>.jsonl`
 *     so both copies live side by side.
 *
 *  The default is intentionally cautious — the v1 implementation
 *  silently overwrote, which lost data when two machines diverged. */
export type AcceptMode = "abort_if_exists" | "replace" | "keep_both";

export interface AcceptOfferArgs {
  workspaceDir: string;
  offerId: string;
  repoLookup: RepoLookup;
  mode?: AcceptMode;
}

export type AcceptResult =
  | { ok: true; manifest: SessionShareManifest; importedPath: string }
  | { ok: false; error: "not_found" | "needs_clone" }
  | { ok: false; error: "exists"; divergence: Divergence; existingPath: string };

/** Persist an incoming offer in the pending inbox. Idempotent on `offerId`. */
export async function storePendingOffer(
  workspaceDir: string,
  manifest: SessionShareManifest,
  jsonl: string,
): Promise<string> {
  const dir = join(workspaceDir, INVITES_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${manifest.offerId}.json`);
  const body: PendingOffer = {
    manifest,
    jsonl,
    receivedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(body, null, 2));
  return path;
}

/** Read one pending offer. Returns null if it doesn't exist or the file
 *  is unreadable / malformed (offers can be deleted concurrently). */
export async function loadPendingOffer(
  workspaceDir: string,
  offerId: string,
): Promise<PendingOffer | null> {
  const path = join(workspaceDir, INVITES_DIR, `${offerId}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as PendingOffer;
  } catch {
    return null;
  }
}

/** List every pending offer, newest first. */
export async function listPendingOffers(
  workspaceDir: string,
): Promise<PendingOffer[]> {
  const dir = join(workspaceDir, INVITES_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: PendingOffer[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf-8");
      out.push(JSON.parse(raw) as PendingOffer);
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  return out;
}

/** Accept a pending offer: rewrite paths, write the import + sidecar
 *  manifest, delete the pending file. Caller is responsible for
 *  appending the corresponding event-log entry.
 *
 *  When a previous import for `(originMachine, sid)` already exists,
 *  behaviour depends on `args.mode`:
 *   - default / `abort_if_exists`: returns `{ ok: false, error:
 *     "exists", divergence }` and leaves both the existing file and
 *     the pending offer untouched. The UI is expected to render a
 *     three-button choice (replace / keep both / cancel) and re-call
 *     with an explicit mode.
 *   - `replace`: overwrites the existing file.
 *   - `keep_both`: writes to a sibling path so both copies survive.
 */
export async function acceptOffer(args: AcceptOfferArgs): Promise<AcceptResult> {
  const { workspaceDir, offerId, repoLookup, mode = "abort_if_exists" } = args;
  const pending = await loadPendingOffer(workspaceDir, offerId);
  if (!pending) return { ok: false, error: "not_found" };

  const { manifest, jsonl } = pending;
  const looked = await repoLookup(
    manifest.originRepoRemote,
    manifest.originWorktreePath,
  );
  if (!looked) return { ok: false, error: "needs_clone" };

  // Rewrite repo root first, then the worktree if both ends have it.
  const toPlatform =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  let rewritten = rewritePaths(jsonl, {
    from: manifest.originRepoPath,
    to: looked.localRepoPath,
    fromPlatform: manifest.originPlatform,
    toPlatform,
  });
  if (manifest.originWorktreePath && looked.localWorktreePath) {
    rewritten = rewritePaths(rewritten, {
      from: manifest.originWorktreePath,
      to: looked.localWorktreePath,
      fromPlatform: manifest.originPlatform,
      toPlatform,
    });
  }

  // Path: imported-sessions/<machine>/<agent>/<sid>.jsonl
  // The <agent> segment lets the server's resolveSessionAgent figure
  // out which JSONL parser to use without reading the sidecar — keeps
  // that helper sync and matches the existing `~/.claude` /
  // `~/.codex` segmentation.
  const importDir = join(
    workspaceDir,
    IMPORTED_DIR,
    manifest.originMachine,
    manifest.agent,
  );
  await mkdir(importDir, { recursive: true });
  const defaultPath = join(importDir, `${manifest.sid}.jsonl`);
  const sidecarPath = join(importDir, `${manifest.sid}.manifest.json`);

  // Check collision + compute divergence so the caller can decide.
  let existingPath: string | null = null;
  let divergence: Divergence | null = null;
  try {
    await access(defaultPath);
    existingPath = defaultPath;
    const existingJsonl = await readFile(defaultPath, "utf-8").catch(() => "");
    divergence = findDivergence(existingJsonl, rewritten);
  } catch {
    // No collision — proceed normally below.
  }

  let importedPath = defaultPath;
  if (existingPath && divergence) {
    if (mode === "abort_if_exists") {
      return { ok: false, error: "exists", divergence, existingPath };
    }
    if (mode === "keep_both") {
      importedPath = await pickKeepBothPath(importDir, manifest.sid);
    }
    // mode === "replace" → keep defaultPath, writeFile will overwrite.
  }

  await writeFile(importedPath, rewritten);
  await writeFile(
    sidecarPath,
    JSON.stringify(
      {
        ...manifest,
        localRepoPath: looked.localRepoPath,
        localWorktreePath: looked.localWorktreePath,
        importedAt: new Date().toISOString(),
        worktreeMissing:
          manifest.originWorktreePath !== undefined &&
          looked.localWorktreePath === undefined,
      },
      null,
      2,
    ),
  );

  await unlink(join(workspaceDir, INVITES_DIR, `${offerId}.json`));

  return { ok: true, manifest, importedPath };
}

/** Find a free `<sid>.from-<n>.jsonl` slot in `importDir`. Used by the
 *  `keep_both` accept mode so a divergent import can sit next to the
 *  existing copy without overwriting. Probes up to 99 suffixes which
 *  is well past any realistic re-import count. */
async function pickKeepBothPath(
  importDir: string,
  sid: string,
): Promise<string> {
  for (let n = 2; n < 100; n++) {
    const candidate = join(importDir, `${sid}.from-${n}.jsonl`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  // Fallback: timestamp suffix. Implausible to reach in practice.
  return join(importDir, `${sid}.from-${Date.now()}.jsonl`);
}

/** Decline a pending offer. Returns whether anything was actually
 *  deleted (false if the offerId was already gone). */
export async function declineOffer(
  workspaceDir: string,
  offerId: string,
): Promise<boolean> {
  const path = join(workspaceDir, INVITES_DIR, `${offerId}.json`);
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** Garbage-collect offers older than the cutoff. `olderThanMs` is the
 *  age threshold in milliseconds (30 days = 30*24*60*60*1000). Returns
 *  the number of offers deleted. */
export async function gcStaleOffers(
  workspaceDir: string,
  olderThanMs: number,
): Promise<number> {
  const dir = join(workspaceDir, INVITES_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as PendingOffer;
      const ts = Date.parse(parsed.receivedAt);
      if (Number.isFinite(ts) && ts < cutoff) {
        await unlink(path);
        removed += 1;
      }
    } catch {
      // skip malformed
    }
  }
  return removed;
}
