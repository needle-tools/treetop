/**
 * Pure functions for session sharing across machines on the LAN.
 * See plans/PLAN-SESSION-SHARE.md.
 *
 * Nothing here touches the network, disk, or daemon state — these are the
 * building blocks the offer/accept routes will compose. Keeping them pure
 * keeps the gnarly string handling (path rewrites, secret stripping) fully
 * testable.
 */

import { redactLikelySecrets, type Redaction } from "./secret-redactor";

export type SharePlatform = "darwin" | "linux" | "win32";
export type ShareAgent = "claude" | "codex" | "ollama";
export type ToolOutputMode = "stripped" | "included";

export interface SessionShareManifest {
  offerId: string;
  sid: string;
  title: string;
  agent: ShareAgent;
  turnCount: number;
  summary?: string;
  originMachine: string;
  originMachineLabel: string;
  originPlatform: SharePlatform;
  originRepoRemote: string;
  originRepoName: string;
  originRepoPath: string;
  originWorktreePath?: string;
  createdAt: string;
  sentAt: string;
  bytes: number;
  toolOutputs: ToolOutputMode;
  strippedCount: number;
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: string };

/** Result of `prepareOutgoingJsonl` — what to ship + a side-report
 *  the UI can render so the sender knows exactly what got scrubbed. */
export interface PreparedJsonl {
  jsonl: string;
  strippedCount: number;
  redactions: Redaction[];
}

/** The full send-side scrub: strip tool_results, then redact common
 *  secret formats. Two independent layers; either may fire on the
 *  same byte range. Tests live with the underlying functions; this
 *  is just a thin compose so callers don't forget step two. */
export function prepareOutgoingJsonl(jsonl: string): PreparedJsonl {
  const stripped = stripToolOutputs(jsonl);
  const redacted = redactLikelySecrets(stripped.jsonl);
  return {
    jsonl: redacted.text,
    strippedCount: stripped.strippedCount,
    redactions: redacted.redactions,
  };
}

/** Hard cap on a single offer payload. Anything larger is almost
 *  certainly a bug (an entire repo serialised into a tool_result, etc.)
 *  and we'd rather fail loudly than DoS the receiver. */
export const MAX_OFFER_BYTES = 50 * 1024 * 1024;

/** Fold a git remote URL into a canonical key for cross-machine repo
 *  identity. We accept https, ssh (`git@host:owner/repo`), and ssh://
 *  forms, strip the `.git` suffix, and lowercase the host (paths stay
 *  case-sensitive because GitHub treats them that way on the API even
 *  if it redirects case-insensitively in the browser). */
export function normalizeRemote(url: string): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";

  // git@host:owner/repo(.git)
  const sshShort = trimmed.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshShort && sshShort[1] && sshShort[2]) {
    return `https://${sshShort[1].toLowerCase()}/${sshShort[2]}`;
  }

  // ssh://git@host[:port]/owner/repo(.git)
  const sshLong = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(\.git)?$/);
  if (sshLong && sshLong[1] && sshLong[2]) {
    return `https://${sshLong[1].toLowerCase()}/${sshLong[2]}`;
  }

  // https://host/owner/repo(.git) or http://...
  const https = trimmed.match(/^(https?):\/\/([^/]+)\/(.+?)(\.git)?$/);
  if (https && https[1] && https[2] && https[3]) {
    return `${https[1]}://${https[2].toLowerCase()}/${https[3]}`;
  }

  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Tool-output stripping                                              */
/* ------------------------------------------------------------------ */

/** Replace every `tool_result` block found in the JSONL with a placeholder
 *  that preserves shape but drops content. See PLAN-SESSION-SHARE.md →
 *  "Privacy: tool-output stripping" for the rationale.
 *
 *  Operates line-by-line: every line is parsed as JSON, walked, and
 *  re-serialised. Malformed lines pass through untouched (sessions can
 *  contain partial writes from a crashed agent). */
export function stripToolOutputs(text: string): {
  jsonl: string;
  strippedCount: number;
} {
  if (!text) return { jsonl: "", strippedCount: 0 };

  let strippedCount = 0;
  const lines = text.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (!line) {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    const replaced = walkAndStrip(parsed, (n) => {
      strippedCount += n;
    });
    out.push(JSON.stringify(replaced));
  }

  return { jsonl: out.join("\n"), strippedCount };
}

/** Marker prefix used inside the replacement `content` string of a
 *  stripped tool_result. Detect this on the receiver to render an
 *  "output stripped" badge in the UI / to count strips on import. */
export const STRIPPED_MARKER_PREFIX = "[supergit-stripped:";

/** Repair tool_result blocks left behind by an older `stripToolOutputs`
 *  that emitted `stripped: true` + `originalBytes` siblings (now invalid
 *  on Anthropic's API). Walks every line; for each tool_result whose
 *  shape carries the legacy markers, rewrites to the current API-valid
 *  shape. Returns the rewritten JSONL and a count of healed blocks.
 *  Idempotent — running on an already-healed file is a no-op. */
export function healLegacyStrippedToolResults(text: string): {
  jsonl: string;
  healedCount: number;
} {
  if (!text) return { jsonl: "", healedCount: 0 };
  let healedCount = 0;
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (!line) {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    const replaced = walkAndHealLegacy(parsed, () => {
      healedCount += 1;
    });
    out.push(JSON.stringify(replaced));
  }
  return { jsonl: out.join("\n"), healedCount };
}

function walkAndHealLegacy(node: unknown, onHeal: () => void): unknown {
  if (Array.isArray(node)) return node.map((i) => walkAndHealLegacy(i, onHeal));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (obj.type === "tool_result" && obj.stripped === true) {
    onHeal();
    const bytes = typeof obj.originalBytes === "number" ? obj.originalBytes : 0;
    const replacement: Record<string, unknown> = {
      type: "tool_result",
      content: `${STRIPPED_MARKER_PREFIX}${bytes}]`,
    };
    if (typeof obj.tool_use_id === "string") {
      replacement.tool_use_id = obj.tool_use_id;
    }
    if (obj.is_error === true) replacement.is_error = true;
    return replacement;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = walkAndHealLegacy(v, onHeal);
  }
  return out;
}

function walkAndStrip(node: unknown, onStrip: (n: number) => void): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => walkAndStrip(item, onStrip));
  }
  if (node === null || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  if (obj.type === "tool_result") {
    const originalBytes = approximateBytes(obj.content);
    onStrip(1);
    // Anthropic's API only accepts these keys on a tool_result content
    // block: `type`, `tool_use_id`, `content`, `is_error`, `cache_control`.
    // Any extra key (we previously emitted `stripped: true` +
    // `originalBytes`) gets rejected as "Extra inputs are not permitted"
    // when Claude Code replays the conversation on `--resume`. Encode the
    // stripped marker into the `content` string so the shape stays valid
    // while still being self-describing on read.
    const replacement: Record<string, unknown> = {
      type: "tool_result",
      content: `${STRIPPED_MARKER_PREFIX}${originalBytes}]`,
    };
    if (typeof obj.tool_use_id === "string") {
      replacement.tool_use_id = obj.tool_use_id;
    }
    if (obj.is_error === true) replacement.is_error = true;
    return replacement;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = walkAndStrip(v, onStrip);
  }
  return out;
}

function approximateBytes(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const item of content) {
      if (item && typeof item === "object") {
        const t = (item as { text?: unknown }).text;
        if (typeof t === "string") n += t.length;
      }
    }
    return n;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Path rewriting                                                     */
/* ------------------------------------------------------------------ */

export interface RewritePathsOptions {
  from: string;
  to: string;
  fromPlatform: SharePlatform;
  toPlatform: SharePlatform;
}

/** Rewrite every occurrence of an absolute `from` repo/worktree path to the
 *  receiver's equivalent `to` path, handling JSON-escaped backslashes for
 *  Windows ↔ POSIX transfers.
 *
 *  Implementation is a string replace, not a JSON walk, because path
 *  references appear inside opaque string values (command outputs, IDE
 *  refs, error messages) that we don't want to schema-track. To avoid
 *  matching prefix-only collisions (e.g. `/foo/bar` vs `/foo/barbershop`),
 *  the regex requires `from` to be followed by a path separator, quote,
 *  end-of-string, or newline. */
export function rewritePaths(text: string, opts: RewritePathsOptions): string {
  if (!text) return "";
  const { from, to, fromPlatform, toPlatform } = opts;
  if (!from || !to) return text;

  // Strip trailing separator from both ends before building the regex.
  // The terminator lookahead below already enforces a boundary after the
  // prefix; if `from` itself ends in `/` or `\`, the regex requires a
  // *second* separator in the data, which breaks both root paths (no
  // trailing sep in the data) and nested paths (sep present but followed
  // by a non-terminator letter).
  const fromTrim = stripTrailingSep(from, fromPlatform);
  const toTrim = stripTrailingSep(to, toPlatform);

  // JSON-encoded form of the prefix. On Windows, single backslashes in a
  // path string get encoded as `\\` in JSON, so the literal bytes in the
  // JSONL contain doubled backslashes.
  const fromEncoded = jsonEncodePath(fromTrim, fromPlatform);
  const toEncoded = jsonEncodePath(toTrim, toPlatform);

  // Match the prefix, then *require* a path-terminator: separator (either
  // platform's), JSON-string close, end-of-input, or whitespace. This is
  // what prevents `/foo/bar` from matching `/foo/barbershop`.
  const escaped = fromEncoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const terminator = String.raw`(?=$|["\s]|\\\\|/)`;
  const re = new RegExp(escaped + terminator, "g");

  let stage1 = text.replace(re, toEncoded);

  // Cross-platform separator normalisation, applied *after* the prefix
  // swap so we only touch paths under `to`. We walk forward from each
  // occurrence of `to` and normalise separators until we hit a boundary
  // (quote, whitespace, end-of-string).
  if (fromPlatform !== toPlatform) {
    stage1 = normalizeSeparatorsInPaths(stage1, toEncoded, toPlatform);
  }

  return stage1;
}

/** Encode a filesystem path the way it appears inside a JSON string in the
 *  JSONL. POSIX paths are unchanged; Windows paths get backslashes doubled
 *  because that's what `JSON.stringify` produces. */
function jsonEncodePath(p: string, platform: SharePlatform): string {
  if (platform === "win32") return p.replace(/\\/g, "\\\\");
  return p;
}

/** Strip a single trailing path separator. Platform-aware but permissive —
 *  Windows tooling occasionally produces `/`-suffixed paths and vice versa,
 *  and either form would defeat the rewrite regex's terminator lookahead. */
function stripTrailingSep(p: string, platform: SharePlatform): string {
  if (!p) return p;
  const last = p[p.length - 1];
  if (platform === "win32") {
    if (last === "\\" || last === "/") return p.slice(0, -1);
  } else {
    if (last === "/") return p.slice(0, -1);
  }
  return p;
}

/** After we've swapped `fromEncoded → toEncoded`, the *suffix* portions of
 *  any path still use the *source* platform's separators. Walk past each
 *  hit of `toEncoded` and translate the remaining separators in-place. */
function normalizeSeparatorsInPaths(
  text: string,
  toEncoded: string,
  toPlatform: SharePlatform,
): string {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const idx = text.indexOf(toEncoded, cursor);
    if (idx === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, idx + toEncoded.length);
    let i = idx + toEncoded.length;
    while (i < text.length) {
      const c = text[i];
      // Stop at JSON string boundary or whitespace
      if (c === '"' || c === "\n" || c === "\r" || c === "\t" || c === " ") {
        break;
      }
      // Escaped backslash in JSON = literal `\` in path
      if (c === "\\" && text[i + 1] === "\\") {
        if (toPlatform === "win32") {
          out += "\\\\";
        } else {
          out += "/";
        }
        i += 2;
        continue;
      }
      if (c === "/") {
        if (toPlatform === "win32") {
          out += "\\\\";
        } else {
          out += "/";
        }
        i += 1;
        continue;
      }
      out += c;
      i += 1;
    }
    cursor = i;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Manifest validation                                                */
/* ------------------------------------------------------------------ */

const REQUIRED_STRINGS: Array<keyof SessionShareManifest> = [
  "offerId",
  "sid",
  "title",
  "agent",
  "originMachine",
  "originMachineLabel",
  "originPlatform",
  "originRepoRemote",
  "originRepoName",
  "originRepoPath",
  "createdAt",
  "sentAt",
  "toolOutputs",
];

const VALID_AGENTS: ShareAgent[] = ["claude", "codex", "ollama"];
const VALID_PLATFORMS: SharePlatform[] = ["darwin", "linux", "win32"];
const VALID_TOOL_OUTPUTS: ToolOutputMode[] = ["stripped", "included"];

export function validateManifest(m: unknown): ValidateResult {
  if (!m || typeof m !== "object") {
    return { ok: false, error: "manifest must be an object" };
  }
  const obj = m as Partial<SessionShareManifest>;

  for (const key of REQUIRED_STRINGS) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: `missing or non-string field: ${key}` };
    }
  }

  if (!VALID_AGENTS.includes(obj.agent as ShareAgent)) {
    return { ok: false, error: `unknown agent: ${obj.agent}` };
  }
  if (!VALID_PLATFORMS.includes(obj.originPlatform as SharePlatform)) {
    return { ok: false, error: `unknown platform: ${obj.originPlatform}` };
  }
  if (!VALID_TOOL_OUTPUTS.includes(obj.toolOutputs as ToolOutputMode)) {
    return { ok: false, error: `unknown toolOutputs: ${obj.toolOutputs}` };
  }

  if (typeof obj.turnCount !== "number" || obj.turnCount < 0) {
    return { ok: false, error: "turnCount must be a non-negative number" };
  }
  if (typeof obj.bytes !== "number" || obj.bytes < 0) {
    return { ok: false, error: "bytes must be a non-negative number" };
  }
  if (obj.bytes > MAX_OFFER_BYTES) {
    return { ok: false, error: `bytes exceeds MAX_OFFER_BYTES (${MAX_OFFER_BYTES})` };
  }
  if (typeof obj.strippedCount !== "number" || obj.strippedCount < 0) {
    return { ok: false, error: "strippedCount must be a non-negative number" };
  }

  if (!isAbsolutePath(obj.originRepoPath as string, obj.originPlatform as SharePlatform)) {
    return {
      ok: false,
      error: `originRepoPath must be absolute for platform ${obj.originPlatform}`,
    };
  }
  if (obj.originWorktreePath !== undefined) {
    if (typeof obj.originWorktreePath !== "string") {
      return { ok: false, error: "originWorktreePath must be a string" };
    }
    if (
      !isAbsolutePath(obj.originWorktreePath, obj.originPlatform as SharePlatform)
    ) {
      return { ok: false, error: "originWorktreePath must be absolute" };
    }
  }

  if (obj.summary !== undefined && typeof obj.summary !== "string") {
    return { ok: false, error: "summary must be a string when present" };
  }

  return { ok: true };
}

function isAbsolutePath(p: string, platform: SharePlatform): boolean {
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
  }
  return p.startsWith("/");
}
