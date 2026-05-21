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
} from "node:fs/promises";
import { join } from "node:path";
import { rewritePaths, type SessionShareManifest } from "./session-share";

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

export interface AcceptOfferArgs {
  workspaceDir: string;
  offerId: string;
  repoLookup: RepoLookup;
}

export type AcceptResult =
  | { ok: true; manifest: SessionShareManifest; importedPath: string }
  | { ok: false; error: "not_found" | "needs_clone" };

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
 *  appending the corresponding event-log entry. */
export async function acceptOffer(args: AcceptOfferArgs): Promise<AcceptResult> {
  const { workspaceDir, offerId, repoLookup } = args;
  const pending = await loadPendingOffer(workspaceDir, offerId);
  if (!pending) return { ok: false, error: "not_found" };

  const { manifest, jsonl } = pending;
  const looked = await repoLookup(
    manifest.originRepoRemote,
    manifest.originWorktreePath,
  );
  if (!looked) return { ok: false, error: "needs_clone" };

  // Rewrite repo root first, then the worktree if both ends have it.
  let rewritten = rewritePaths(jsonl, {
    from: manifest.originRepoPath,
    to: looked.localRepoPath,
    fromPlatform: manifest.originPlatform,
    toPlatform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
  });
  if (manifest.originWorktreePath && looked.localWorktreePath) {
    rewritten = rewritePaths(rewritten, {
      from: manifest.originWorktreePath,
      to: looked.localWorktreePath,
      fromPlatform: manifest.originPlatform,
      toPlatform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    });
  }

  const importDir = join(workspaceDir, IMPORTED_DIR, manifest.originMachine);
  await mkdir(importDir, { recursive: true });
  const importedPath = join(importDir, `${manifest.sid}.jsonl`);
  const sidecarPath = join(importDir, `${manifest.sid}.manifest.json`);

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
