/**
 * Pure, dependency-free request/string helpers extracted from server.ts.
 *
 * Every function here is a pure transformation: it reads only its arguments
 * (plus Node/Bun builtins like `process.env`, `process.platform`, and `URL`)
 * and has no side-effects on module-level mutable state.
 *
 * Behaviour is pinned by `packages/daemon/test/server-helpers.test.ts` (real
 * input→output assertions added as part of the extraction PR).
 */

import { existsSync } from "node:fs";
import type { AttachmentKind, LinkTarget } from "./notes";

/** Strip model-specific thinking artifacts from Ollama output.
 *  Some models leak internal reasoning even with `think: false`:
 *  - gemma4 uses `<channel|>` as a separator (everything before is thinking)
 *  - deepseek/qwen use `<think>…</think>` XML blocks
 *  Keeps only the actual answer. */
export function stripThinkingArtifacts(raw: string): string {
  let s = raw;
  // gemma4's channel separator — take everything after the last occurrence
  const chIdx = s.lastIndexOf("<channel|>");
  if (chIdx !== -1) s = s.slice(chIdx + "<channel|>".length);
  // XML-style <think> blocks (deepseek, qwen, etc.)
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  return s.trim();
}

/** The user's default interactive shell with appropriate flags.
 *  Used by /api/shell-default and cmdForOpenSession-equivalent logic. */
/** Pick a POSIX login shell that actually EXISTS on this box. The old
 *  hard-coded `/bin/zsh` fallback failed on minimal servers (e.g. a fresh
 *  Debian remote daemon) where zsh isn't installed — the spawned terminal
 *  died with "/bin/zsh: No such file or directory". Prefer bash (near-
 *  universal), then sh (POSIX-guaranteed), then zsh. `exists` is injected
 *  so the choice is unit-testable without touching the filesystem. */
export function firstExistingPosixShell(
  exists: (p: string) => boolean,
): string {
  for (const cand of ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/bin/zsh"]) {
    if (exists(cand)) return cand;
  }
  return "/bin/sh"; // POSIX guarantees /bin/sh — last-resort even if stat lied
}

export function defaultLoginShell(deps?: {
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
}): { shell: string; args: string[] } {
  const exists = deps?.exists ?? ((p: string) => existsSync(p));
  const platform = deps?.platform ?? process.platform;
  const shell =
    process.env.SHELL ||
    process.env.COMSPEC ||
    (platform === "win32"
      ? "powershell.exe"
      : firstExistingPosixShell(exists));
  const base = shell.toLowerCase().replace(/\\/g, "/");
  if (base.includes("powershell") || base.includes("pwsh"))
    return { shell, args: ["-NoLogo"] };
  if (base.includes("cmd")) return { shell, args: [] };
  // /bin/sh is typically dash, which doesn't accept -l the same way; but
  // -l is harmless on sh/bash/zsh as a login flag, so keep it uniform.
  return { shell, args: ["-l"] };
}

export interface ShellOption {
  shell: string;
  args: string[];
  label: string;
}

/** The interactive shells a user can pick for a plain terminal column on THIS
 *  box. On Windows we surface BOTH PowerShell and CMD (both ship with every
 *  install), so the new-session picker offers each as its own entry —
 *  PowerShell first, because its PSReadLine line editor gives working
 *  arrow-key history over SSH, whereas cmd.exe behind a ConPTY pipe has no
 *  console line editor and just echoes the raw `^[[A`. On POSIX there's a
 *  single login shell, so we return one entry and the picker shows today's
 *  single "Terminal". Env is injected so the choice is unit-testable. */
export function availableShells(deps?: {
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}): ShellOption[] {
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  if (platform === "win32") {
    const cmd = env.COMSPEC || "cmd.exe";
    return [
      { shell: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" },
      { shell: cmd, args: [], label: "CMD" },
    ];
  }
  const def = defaultLoginShell({ exists: deps?.exists, platform });
  return [{ shell: def.shell, args: def.args, label: "Terminal" }];
}

export const URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{2,5}[^\s'")}\]>]*/g;

export function urlPriority(url: string): number {
  try {
    const host = new URL(url).hostname;
    if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 2;
    if (host === "localhost" || host === "127.0.0.1") return 1;
  } catch {}
  return 0;
}

/** Strip a hostname down to a path-safe identifier — used as a
 *  directory name on the receiver's filesystem when an imported
 *  session lands. Keeps letters, digits, dot, dash, underscore. Any
 *  other character becomes a single dash, and the result is lowercased
 *  + truncated so collisions across casing or pathological hostnames
 *  don't blow up the file system. */
export function sanitiseMachineId(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "unknown";
}

/** Coerce an untyped /api/notes payload field into the AttachmentKind
 *  the store expects. Anything other than the two known values
 *  returns undefined — the store then treats it as "leave the existing
 *  kind alone" on PUT, and "default to note" on POST. */
export function parseKind(v: unknown): AttachmentKind | undefined {
  return v === "note" || v === "link" || v === "emoji" ? v : undefined;
}

/** Same posture for `target`. The whole object is dropped if any field
 *  is malformed; we don't half-accept (a note with a recognised type
 *  but an empty value would render as a broken chip in the UI). */
export function parseTarget(v: unknown): LinkTarget | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as {
    type?: unknown;
    value?: unknown;
    label?: unknown;
    subtitle?: unknown;
    meta?: unknown;
  };
  if (typeof obj.value !== "string" || obj.value.length === 0) return undefined;
  if (
    obj.type === "url" ||
    obj.type === "commit" ||
    obj.type === "session" ||
    obj.type === "file" ||
    obj.type === "command"
  ) {
    const target: LinkTarget = { type: obj.type, value: obj.value };
    // Display-snapshot fields are pass-through with a string + length
    // guard — empty strings would write empty frontmatter keys we'd
    // then re-parse as empty values, which is fine but pointless.
    if (typeof obj.label === "string" && obj.label.length > 0) {
      target.label = obj.label;
    }
    if (typeof obj.subtitle === "string" && obj.subtitle.length > 0) {
      target.subtitle = obj.subtitle;
    }
    if (typeof obj.meta === "string" && obj.meta.length > 0) {
      target.meta = obj.meta;
    }
    if (
      typeof (obj as { agent?: unknown }).agent === "string" &&
      (obj as { agent: string }).agent.length > 0
    ) {
      target.agent = (obj as { agent: string }).agent;
    }
    if (
      typeof (obj as { provider?: unknown }).provider === "string" &&
      (obj as { provider: string }).provider.length > 0
    ) {
      target.provider = (obj as { provider: string }).provider;
    }
    if (
      typeof (obj as { repoId?: unknown }).repoId === "string" &&
      (obj as { repoId: string }).repoId.length > 0
    ) {
      target.repoId = (obj as { repoId: string }).repoId;
    }
    if (
      typeof (obj as { cwd?: unknown }).cwd === "string" &&
      (obj as { cwd: string }).cwd.length > 0
    ) {
      target.cwd = (obj as { cwd: string }).cwd;
    }
    if (
      typeof (obj as { command?: unknown }).command === "string" &&
      (obj as { command: string }).command.length > 0
    ) {
      target.command = (obj as { command: string }).command;
    }
    const runMode = (obj as { runMode?: unknown }).runMode;
    if (
      runMode === "internal" ||
      runMode === "external" ||
      runMode === "shell"
    ) {
      target.runMode = runMode;
    }
    return target;
  }
  return undefined;
}

/** Minimal HTML-entity decoder for &amp; / &lt; / &gt; / &quot; /
 *  &#NN; / &#xNN; — enough to make `<title>` text human-readable
 *  without pulling in a full HTML parser. Unknown named entities are
 *  left untouched. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Patch one worktree's freshly-recomputed git details into a cached
 * `/api/repos` payload array, IN PLACE. Returns true if a matching
 * worktree was found and updated.
 *
 * The fs watcher recomputes a single worktree's `getWorktreeDetails`
 * (fileStatus / branchStatus / lastCommit) after a change. The route's
 * full-payload `reposCache` short-circuits before any rebuild, so just
 * deleting the per-worktree details cache is invisible until that payload
 * TTL expires AND a later cache-missing fetch happens — leaving push/pull/
 * dirty badges stale for an unbounded time. Splicing the new details into
 * the cached row keeps the badges live without forcing a full rebuild (and
 * its expensive `detectAgents` JSONL scan). Non-detail fields the enrich
 * adds — `agents`, `branch`, `path`, … — are preserved by spreading the
 * existing row first.
 */
export function patchWorktreeDetailsInRepos(
  repos: Array<{ worktrees?: unknown }>,
  wtPath: string,
  details: Record<string, unknown>,
): boolean {
  for (const repo of repos) {
    const wts = repo.worktrees;
    if (!Array.isArray(wts)) continue;
    const idx = wts.findIndex(
      (w) => w && (w as { path?: unknown }).path === wtPath,
    );
    if (idx >= 0) {
      wts[idx] = { ...wts[idx], ...details };
      return true;
    }
  }
  return false;
}

export function extractIconHrefs(html: string): string[] {
  const out: string[] = [];
  // <link rel="icon" ...>, <link rel="shortcut icon" ...>, apple-touch-icon
  const linkRe = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (!/rel\s*=\s*["']?[^"'>]*icon/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (hrefMatch?.[1]) out.push(hrefMatch[1]);
  }
  return out;
}
