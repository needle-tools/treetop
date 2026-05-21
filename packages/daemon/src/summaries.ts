/**
 * Persistent cache of Ollama-generated session summaries.
 *
 * One markdown file per session at `<workspace>/summaries/<key>.md`,
 * where `key` is the first 16 hex of `sha256(normalize(sourcePath))`.
 * The path is normalised (lowercase on Windows) so case drift in a
 * source path doesn't desync the key.
 *
 * File shape — plain markdown so a user can `cat`/grep one with no
 * tooling, with a YAML frontmatter block carrying the metadata the
 * UI needs to label / stale-check / re-render the cached summary:
 *
 *     ---
 *     source: /abs/path/to/session.jsonl
 *     agent: claude
 *     sessionId: 8f12-…       # optional
 *     model: llama3.2:3b
 *     sourceMtimeMs: 1747841234567
 *     generatedAt: 2026-05-21T13:42:11.000Z
 *     includedMessages: 28
 *     totalMessages: 412
 *     truncatedMessages: 3
 *     estimatedTokens: 1840
 *     elapsedMs: 4231
 *     ---
 *
 *     <the summary body, markdown, as the model produced it>
 *
 * Writes are atomic: write to `<key>.md.tmp` then rename. A kill
 * mid-stream leaves no half-summary on disk.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

const SUMMARIES_DIR = "summaries";

export interface SummaryFrontmatter {
  source: string;
  agent: "claude" | "codex" | "ollama";
  sessionId?: string;
  model: string;
  sourceMtimeMs: number;
  generatedAt: string;
  includedMessages: number;
  totalMessages: number;
  truncatedMessages: number;
  estimatedTokens: number;
  elapsedMs: number;
}

export interface SummaryRecord {
  frontmatter: SummaryFrontmatter;
  body: string;
}

export interface SummaryWriteInput extends Omit<SummaryFrontmatter, "source"> {
  /** The summary markdown produced by the model. Stored verbatim. */
  body: string;
}

export interface StalenessResult {
  summary: SummaryRecord | null;
  /** True if the on-disk summary is older than the source file
   *  (or the source is missing / stat fails). False when there's
   *  no summary, or when the recorded sourceMtimeMs matches the
   *  current mtime exactly. */
  stale: boolean;
}

/** Derive the on-disk filename key for a given session source path.
 *  The path is normalised — case-folded so Windows drive-letter
 *  casing drift doesn't change the key — and then hashed. */
export function keyForSource(sourcePath: string): string {
  const normalised = sourcePath.toLowerCase();
  return createHash("sha256")
    .update(normalised)
    .digest("hex")
    .slice(0, 16);
}

export class SummariesStore {
  private constructor(public readonly dir: string) {}

  static async open(workspacePath: string): Promise<SummariesStore> {
    const dir = join(workspacePath, SUMMARIES_DIR);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
    return new SummariesStore(dir);
  }

  private pathFor(sourcePath: string): string {
    return join(this.dir, `${keyForSource(sourcePath)}.md`);
  }

  /** Atomic write: temp file → rename. */
  async write(sourcePath: string, input: SummaryWriteInput): Promise<void> {
    const frontmatter: SummaryFrontmatter = {
      source: sourcePath,
      agent: input.agent,
      sessionId: input.sessionId,
      model: input.model,
      sourceMtimeMs: input.sourceMtimeMs,
      generatedAt: input.generatedAt,
      includedMessages: input.includedMessages,
      totalMessages: input.totalMessages,
      truncatedMessages: input.truncatedMessages,
      estimatedTokens: input.estimatedTokens,
      elapsedMs: input.elapsedMs,
    };
    const file = this.pathFor(sourcePath);
    const tmp = file + ".tmp";
    const content = renderFile(frontmatter, input.body);
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, file);
  }

  async read(sourcePath: string): Promise<SummaryRecord | null> {
    let text: string;
    try {
      text = await readFile(this.pathFor(sourcePath), "utf-8");
    } catch {
      return null;
    }
    return parseFile(text);
  }

  async delete(sourcePath: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(sourcePath));
      return true;
    } catch {
      return false;
    }
  }

  /** Read the cached summary (if any) and compare its recorded
   *  source mtime against the source file's current mtime. */
  async staleness(sourcePath: string): Promise<StalenessResult> {
    const summary = await this.read(sourcePath);
    if (!summary) return { summary: null, stale: false };
    let currentMtimeMs: number | null;
    try {
      currentMtimeMs = (await stat(sourcePath)).mtimeMs;
    } catch {
      currentMtimeMs = null;
    }
    const stale =
      currentMtimeMs === null || currentMtimeMs !== summary.frontmatter.sourceMtimeMs;
    return { summary, stale };
  }

  async listAll(): Promise<SummaryRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: SummaryRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      try {
        const text = await readFile(join(this.dir, name), "utf-8");
        const parsed = parseFile(text);
        if (parsed) out.push(parsed);
      } catch {
        // skip
      }
    }
    return out;
  }
}

// =========================================================================
// Repo summaries — sibling store sharing the same `<workspace>/summaries/`
// directory, keyed by `repo-<id>.md` so the two filename schemes never
// collide. Different frontmatter shape (sha-based staleness, no `source`
// path) lives in its own type to keep `SummaryFrontmatter` clean.
// =========================================================================

export interface RepoSummaryFrontmatter {
  repoId: string;
  repoName: string;
  repoPath: string;
  model: string;
  /** HEAD sha of the canonical repo path at generation time. The
   *  freshness check compares this to the current HEAD; mismatch
   *  → re-summarise. */
  lastSha: string;
  generatedAt: string;
  /** How many hours of activity the digest covered (24 by default). */
  sinceHours: number;
  /** Count of commits the digest included. Zero means "we summarised
   *  an empty window" — keep the marker so we don't re-fire just
   *  because a sha is the same. */
  commitCount: number;
  dirtyWorktreeCount: number;
  totalInsertions: number;
  totalDeletions: number;
  estimatedTokens: number;
  elapsedMs: number;
}

export interface RepoSummaryRecord {
  frontmatter: RepoSummaryFrontmatter;
  body: string;
}

export interface RepoSummaryWriteInput
  extends Omit<RepoSummaryFrontmatter, "repoId"> {
  body: string;
}

/** Filename key for a per-repo summary. `repoId` comes from
 *  `repos.json` and is already URL-safe / filename-safe — no
 *  hashing needed. The `repo-` prefix keeps it from colliding with
 *  session-keyed files (16 hex chars). */
export function keyForRepo(repoId: string): string {
  return `repo-${repoId}`;
}

export class RepoSummariesStore {
  private constructor(public readonly dir: string) {}

  static async open(workspacePath: string): Promise<RepoSummariesStore> {
    const dir = join(workspacePath, SUMMARIES_DIR);
    try {
      await access(dir);
    } catch {
      await mkdir(dir, { recursive: true });
    }
    return new RepoSummariesStore(dir);
  }

  private pathFor(repoId: string): string {
    if (repoId.includes("/") || repoId.includes("\\") || repoId.includes("..")) {
      throw new Error(`invalid repoId: ${repoId}`);
    }
    return join(this.dir, `${keyForRepo(repoId)}.md`);
  }

  async write(repoId: string, input: RepoSummaryWriteInput): Promise<void> {
    const frontmatter: RepoSummaryFrontmatter = {
      repoId,
      repoName: input.repoName,
      repoPath: input.repoPath,
      model: input.model,
      lastSha: input.lastSha,
      generatedAt: input.generatedAt,
      sinceHours: input.sinceHours,
      commitCount: input.commitCount,
      dirtyWorktreeCount: input.dirtyWorktreeCount,
      totalInsertions: input.totalInsertions,
      totalDeletions: input.totalDeletions,
      estimatedTokens: input.estimatedTokens,
      elapsedMs: input.elapsedMs,
    };
    const file = this.pathFor(repoId);
    const tmp = file + ".tmp";
    const content = renderRepoFile(frontmatter, input.body);
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, file);
  }

  async read(repoId: string): Promise<RepoSummaryRecord | null> {
    let text: string;
    try {
      text = await readFile(this.pathFor(repoId), "utf-8");
    } catch {
      return null;
    }
    return parseRepoFile(text);
  }

  async delete(repoId: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(repoId));
      return true;
    } catch {
      return false;
    }
  }
}

export function renderRepoFile(
  fm: RepoSummaryFrontmatter,
  body: string,
): string {
  const lines: string[] = ["---"];
  lines.push(`kind: repo`);
  lines.push(`repoId: ${quoteYaml(fm.repoId)}`);
  lines.push(`repoName: ${quoteYaml(fm.repoName)}`);
  lines.push(`repoPath: ${quoteYaml(fm.repoPath)}`);
  lines.push(`model: ${quoteYaml(fm.model)}`);
  lines.push(`lastSha: ${quoteYaml(fm.lastSha)}`);
  lines.push(`generatedAt: ${quoteYaml(fm.generatedAt)}`);
  lines.push(`sinceHours: ${fm.sinceHours}`);
  lines.push(`commitCount: ${fm.commitCount}`);
  lines.push(`dirtyWorktreeCount: ${fm.dirtyWorktreeCount}`);
  lines.push(`totalInsertions: ${fm.totalInsertions}`);
  lines.push(`totalDeletions: ${fm.totalDeletions}`);
  lines.push(`estimatedTokens: ${fm.estimatedTokens}`);
  lines.push(`elapsedMs: ${fm.elapsedMs}`);
  lines.push("---");
  lines.push("");
  return lines.join("\n") + body;
}

export function parseRepoFile(text: string): RepoSummaryRecord | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const afterOpen = text.indexOf("\n") + 1;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) return null;
  const fmText = text.slice(afterOpen, closeIdx);
  let bodyStart = closeIdx + "\n---".length;
  if (text[bodyStart] === "\r") bodyStart++;
  if (text[bodyStart] === "\n") bodyStart++;
  if (text.startsWith("\n", bodyStart)) bodyStart++;
  const body = text.slice(bodyStart);

  const out: Record<string, unknown> = {};
  for (const rawLine of fmText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    out[line.slice(0, colon).trim()] = parseYamlScalar(
      line.slice(colon + 1).trim(),
    );
  }
  const required = [
    "repoId",
    "repoName",
    "repoPath",
    "model",
    "lastSha",
    "generatedAt",
    "sinceHours",
    "commitCount",
    "dirtyWorktreeCount",
    "totalInsertions",
    "totalDeletions",
    "estimatedTokens",
    "elapsedMs",
  ];
  for (const k of required) {
    if (!(k in out)) return null;
  }
  return {
    frontmatter: {
      repoId: String(out.repoId),
      repoName: String(out.repoName),
      repoPath: String(out.repoPath),
      model: String(out.model),
      lastSha: String(out.lastSha),
      generatedAt: String(out.generatedAt),
      sinceHours: Number(out.sinceHours),
      commitCount: Number(out.commitCount),
      dirtyWorktreeCount: Number(out.dirtyWorktreeCount),
      totalInsertions: Number(out.totalInsertions),
      totalDeletions: Number(out.totalDeletions),
      estimatedTokens: Number(out.estimatedTokens),
      elapsedMs: Number(out.elapsedMs),
    },
    body,
  };
}

// =========================================================================

/** Render a SummaryRecord to its on-disk form. Exported for tests. */
export function renderFile(fm: SummaryFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  // Order matches the file-doc block at the top so a hand-read of
  // any summary looks consistent.
  lines.push(`source: ${quoteYaml(fm.source)}`);
  lines.push(`agent: ${fm.agent}`);
  if (fm.sessionId) lines.push(`sessionId: ${quoteYaml(fm.sessionId)}`);
  lines.push(`model: ${quoteYaml(fm.model)}`);
  lines.push(`sourceMtimeMs: ${fm.sourceMtimeMs}`);
  lines.push(`generatedAt: ${quoteYaml(fm.generatedAt)}`);
  lines.push(`includedMessages: ${fm.includedMessages}`);
  lines.push(`totalMessages: ${fm.totalMessages}`);
  lines.push(`truncatedMessages: ${fm.truncatedMessages}`);
  lines.push(`estimatedTokens: ${fm.estimatedTokens}`);
  lines.push(`elapsedMs: ${fm.elapsedMs}`);
  lines.push("---");
  lines.push("");
  return lines.join("\n") + body;
}

/** Parse the on-disk form back into a SummaryRecord. Exported for
 *  tests. Returns null on malformed input. */
export function parseFile(text: string): SummaryRecord | null {
  // Frontmatter is bounded by a leading `---` line and the next
  // `---` line. Anything after the closing fence (less one leading
  // newline) is the body, preserved verbatim.
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const afterOpen = text.indexOf("\n") + 1;
  const closeIdx = text.indexOf("\n---", afterOpen);
  if (closeIdx === -1) return null;
  const fmText = text.slice(afterOpen, closeIdx);
  // Skip the closing fence line.
  let bodyStart = closeIdx + "\n---".length;
  if (text[bodyStart] === "\r") bodyStart++;
  if (text[bodyStart] === "\n") bodyStart++;
  // One blank line between fence and body is conventional — strip
  // exactly that leading blank so round-tripping preserves the
  // author's body bytes.
  if (text.startsWith("\n", bodyStart)) bodyStart++;
  const body = text.slice(bodyStart);

  const fm = parseFrontmatter(fmText);
  if (!fm) return null;
  return { frontmatter: fm, body };
}

function parseFrontmatter(text: string): SummaryFrontmatter | null {
  const out: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    out[key] = parseYamlScalar(valueRaw);
  }
  // Spot-check required fields. Anything missing → treat as
  // malformed and force a regenerate.
  const required = [
    "source",
    "agent",
    "model",
    "sourceMtimeMs",
    "generatedAt",
    "includedMessages",
    "totalMessages",
    "truncatedMessages",
    "estimatedTokens",
    "elapsedMs",
  ];
  for (const k of required) {
    if (!(k in out)) return null;
  }
  const agent = out.agent;
  if (agent !== "claude" && agent !== "codex" && agent !== "ollama") return null;
  return {
    source: String(out.source),
    agent,
    sessionId: typeof out.sessionId === "string" ? out.sessionId : undefined,
    model: String(out.model),
    sourceMtimeMs: Number(out.sourceMtimeMs),
    generatedAt: String(out.generatedAt),
    includedMessages: Number(out.includedMessages),
    totalMessages: Number(out.totalMessages),
    truncatedMessages: Number(out.truncatedMessages),
    estimatedTokens: Number(out.estimatedTokens),
    elapsedMs: Number(out.elapsedMs),
  };
}

/** Bare scalar parser. Strings either come bare or double-quoted —
 *  enough for the values we ever write. */
function parseYamlScalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  // Numbers — integer or float, but not anything with leading zeros
  // (might be a model name like "0001"). Bare numerics only.
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/** Quote a YAML scalar if it contains any character that would
 *  break the bare-string parse. Safe by default — we wrap anything
 *  that isn't purely word-ish. */
function quoteYaml(s: string): string {
  if (/^[A-Za-z0-9_\-./:+]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
