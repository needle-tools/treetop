/**
 * Filesystem storage for the session-share offer/accept flow. Pending
 * offers live in `<workspace>/session-invites/<offerId>.json`. On
 * accept, the import is split:
 *
 *   - **JSONL (claude)** → `~/.claude/projects/<encoded(cwd)>/<sid>.jsonl`
 *     so Claude Code's own `--resume <sid>` finds it without supergit
 *     having to copy / symlink at spawn time.
 *   - **JSONL (codex)** → `<workspace>/imported-sessions/<machine>/codex/<sid>.jsonl`
 *     (legacy layout; codex has no analogous projects-dir convention).
 *   - **Sidecar manifest** (both agents) →
 *     `<workspace>/imported-sessions/<machine>/<agent>/<sid>.manifest.json`,
 *     carrying the import metadata + an `importedJsonlPath` pointer.
 *
 * See plans/PLAN-SESSION-SHARE.md.
 *
 * No HTTP, no Workspace dependency. The server routes compose these
 * functions with `validateManifest` from `session-share.ts` and a
 * `repoLookup` callback that resolves the origin remote against the
 * workspace's `repos.json`.
 */

import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  access,
  rename,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  rewritePaths,
  type SessionShareManifest,
  type SharePlatform,
} from "./session-share";
import {
  findDivergence,
  mergeTranscripts,
  type Divergence,
} from "./session-share-divergence";
import { claudeProjectDirForCwd, CLAUDE_ROOT } from "./agents";

const INVITES_DIR = "session-invites";
const IMPORTED_DIR = "imported-sessions";

const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;

/**
 * Defense-in-depth: assert a path built from manifest fields stays
 * inside the workspace before we write to it. `validateManifest` already
 * rejects `..`/separators in the path-safe fields, but a write that
 * bypasses validation (a future caller, a refactor) must never escape
 * the workspace silently. Throws if `target` resolves outside `base`.
 */
function assertWithin(base: string, target: string): string {
  const root = resolve(base);
  const full = resolve(target);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`refusing to write outside workspace: ${target}`);
  }
  return full;
}

/** Strip HTML tags from text fields inside JSONL content blocks.
 *  Prevents stored XSS when shared sessions are rendered with {@html}. */
export function sanitizeJsonl(jsonl: string): string {
  return jsonl
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return line;
      }
      if (!obj?.message?.content || !Array.isArray(obj.message.content))
        return line;
      let changed = false;
      for (const block of obj.message.content) {
        if (
          (block.type === "text" || block.type === "thinking") &&
          typeof block.text === "string" &&
          HTML_TAG_RE.test(block.text)
        ) {
          block.text = block.text.replace(HTML_TAG_RE, "");
          changed = true;
        }
      }
      return changed ? JSON.stringify(obj) : line;
    })
    .join("\n");
}

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
 *   - `merge`: combine the two transcripts in place — shared prefix once,
 *     then both divergent tails (deduped). Written atomically via a temp
 *     file + rename so a failed write leaves the existing copy intact;
 *     on failure returns `{ ok: false, error: "merge_failed", ... }`.
 *
 *  The default is intentionally cautious — the v1 implementation
 *  silently overwrote, which lost data when two machines diverged. */
export type AcceptMode =
  | "abort_if_exists"
  | "replace"
  | "keep_both"
  | "merge";

export interface AcceptOfferArgs {
  workspaceDir: string;
  offerId: string;
  repoLookup: RepoLookup;
  mode?: AcceptMode;
  /** Override Claude's `~/.claude/projects` for tests. The accept flow
   *  for claude offers places the rewritten JSONL directly under
   *  `<claudeProjectsDir>/<encoded(cwd)>/<sid>.jsonl` so Claude Code's
   *  `--resume` finds it. */
  claudeProjectsDir?: string;
  /** Override the rewriter's target platform. Defaults to the daemon's
   *  `process.platform` because the imported JSONL lives on this host
   *  and should use its separator conventions. Tests pass an explicit
   *  value to keep the rewriter from converting separators when the
   *  test's expected output assumes the sender's platform. */
  toPlatform?: SharePlatform;
}

export type AcceptResult =
  | { ok: true; manifest: SessionShareManifest; importedPath: string }
  | { ok: false; error: "not_found" | "needs_clone" }
  | {
      ok: false;
      error: "exists";
      divergence: Divergence;
      existingPath: string;
    }
  | {
      ok: false;
      error: "merge_failed";
      reason: string;
      divergence: Divergence;
      existingPath: string;
    };

/** Persist an incoming offer in the pending inbox. Idempotent on `offerId`. */
export async function storePendingOffer(
  workspaceDir: string,
  manifest: SessionShareManifest,
  jsonl: string,
): Promise<string> {
  const dir = join(workspaceDir, INVITES_DIR);
  await mkdir(dir, { recursive: true });
  const path = assertWithin(dir, join(dir, `${manifest.offerId}.json`));
  const body: PendingOffer = {
    manifest,
    jsonl: sanitizeJsonl(jsonl),
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
export async function acceptOffer(
  args: AcceptOfferArgs,
): Promise<AcceptResult> {
  const {
    workspaceDir,
    offerId,
    repoLookup,
    mode = "abort_if_exists",
    claudeProjectsDir = CLAUDE_ROOT(),
  } = args;
  const pending = await loadPendingOffer(workspaceDir, offerId);
  if (!pending) return { ok: false, error: "not_found" };

  const { manifest, jsonl } = pending;
  const looked = await repoLookup(
    manifest.originRepoRemote,
    manifest.originWorktreePath,
  );
  if (!looked) return { ok: false, error: "needs_clone" };

  // Rewrite repo root first, then the worktree if both ends have it.
  // Critically, when the manifest carries an originWorktreePath but
  // the receiver has no matching worktree, fall back to rewriting it
  // to localRepoPath anyway — otherwise worktree-path mentions in the
  // JSONL (e.g. `cwd` fields) stay as sender-side paths, which
  // scanClaude can't map to any local repo and the imported session
  // becomes invisible. Hit in practice when originWorktreePath is a
  // parent/sibling of originRepoPath (npm package nested in repo,
  // etc.) — the first pass below only touches originRepoPath, so
  // anything mentioning the bare worktree was previously orphaned.
  const toPlatform: SharePlatform =
    args.toPlatform ??
    (process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux");
  let rewritten = rewritePaths(jsonl, {
    from: manifest.originRepoPath,
    to: looked.localRepoPath,
    fromPlatform: manifest.originPlatform,
    toPlatform,
  });
  if (manifest.originWorktreePath) {
    rewritten = rewritePaths(rewritten, {
      from: manifest.originWorktreePath,
      to: looked.localWorktreePath ?? looked.localRepoPath,
      fromPlatform: manifest.originPlatform,
      toPlatform,
    });
  }

  // Where the import lives depends on agent:
  //   - claude: the rewritten JSONL goes straight into
  //     `<claudeProjectsDir>/<encoded(cwd)>/<sid>.jsonl` so Claude Code's
  //     own `--resume <sid>` lookup finds it.
  //   - ollama: JSONL lands in `<workspace>/ollama/<sid>.jsonl` — the
  //     same directory supergit's own `scanOllama` walks, so the
  //     receiver's dashboard surfaces the imported session natively
  //     (no separate "imported ollama" code path) and can resume it
  //     by spawning a new PTY that replays the transcript.
  //   - codex: JSONL + sidecar both stay under
  //     `<workspace>/imported-sessions/<machine>/codex/`. Codex's
  //     date-bucketed projects dir is a follow-up; sibling location
  //     is fine for now since `codex resume` accepts a sid + picker.
  //
  // Sidecars (import metadata only) ALWAYS live under
  // `<workspace>/imported-sessions/<machine>/<agent>/<sid>.manifest.json`.
  const sidecarDir = join(
    workspaceDir,
    IMPORTED_DIR,
    manifest.originMachine,
    manifest.agent,
  );
  // sidecarDir embeds manifest.originMachine; both it and the sidecar
  // filename embed validated fields, but assert containment anyway so a
  // validation bypass can never write outside the imported-sessions tree.
  assertWithin(join(workspaceDir, IMPORTED_DIR), sidecarDir);
  await mkdir(sidecarDir, { recursive: true });
  const sidecarPath = assertWithin(
    sidecarDir,
    join(sidecarDir, `${manifest.sid}.manifest.json`),
  );

  let jsonlDir: string;
  if (manifest.agent === "claude") {
    const cwd = looked.localWorktreePath || looked.localRepoPath;
    jsonlDir = await claudeProjectDirForCwd(cwd, claudeProjectsDir);
  } else if (manifest.agent === "ollama") {
    jsonlDir = join(workspaceDir, "ollama");
  } else {
    jsonlDir = sidecarDir;
  }
  await mkdir(jsonlDir, { recursive: true });
  const defaultPath = assertWithin(
    jsonlDir,
    join(jsonlDir, `${manifest.sid}.jsonl`),
  );

  // Check collision + compute divergence so the caller can decide.
  let existingPath: string | null = null;
  let existingJsonl = "";
  let divergence: Divergence | null = null;
  try {
    await access(defaultPath);
    existingPath = defaultPath;
    existingJsonl = await readFile(defaultPath, "utf-8").catch(() => "");
    divergence = findDivergence(existingJsonl, rewritten);
  } catch {
    // No collision — proceed normally below.
  }

  let importedPath = defaultPath;
  let mergeRequested = false;
  if (existingPath && divergence) {
    if (mode === "abort_if_exists") {
      return { ok: false, error: "exists", divergence, existingPath };
    }
    if (mode === "keep_both") {
      importedPath = await pickKeepBothPath(jsonlDir, manifest.sid);
    } else if (mode === "merge") {
      // Combine the two transcripts in memory first — a bad merge can't
      // touch disk. The write below goes through a temp + rename so the
      // existing copy survives a write failure too.
      mergeRequested = true;
      try {
        rewritten = mergeTranscripts(existingJsonl, rewritten);
      } catch (e) {
        return {
          ok: false,
          error: "merge_failed",
          reason: e instanceof Error ? e.message : String(e),
          divergence,
          existingPath,
        };
      }
    }
    // mode === "replace" → keep defaultPath, writeFile will overwrite.
  }

  if (mergeRequested) {
    // Atomic swap: write the merged transcript to a sibling temp file,
    // then rename over the original. rename is atomic on the same
    // filesystem, so a crash mid-write can never leave a truncated
    // session behind — the original stays until the rename lands.
    const tmp = `${importedPath}.merge-tmp`;
    try {
      await writeFile(tmp, rewritten);
      await rename(tmp, importedPath);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      return {
        ok: false,
        error: "merge_failed",
        reason: e instanceof Error ? e.message : String(e),
        divergence: divergence!,
        existingPath: existingPath!,
      };
    }
  } else {
    await writeFile(importedPath, rewritten);
  }
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
        // Records where the JSONL actually lives so scanImported can
        // find it without re-deriving from cwd, and so the UI can
        // surface the import as a native claude session (dedupe key).
        importedJsonlPath: importedPath,
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
