/**
 * Classify unified-diff lines + the headers from `git show` and our own
 * "# untracked files" preamble. Pure function — testable without Svelte.
 *
 * Renderers map kinds to colors:
 *   add / remove / hunk / file headers stand out; meta + context stay quiet.
 */

export type DiffLineKind =
  | "file"
  | "meta"
  | "hunk"
  | "add"
  | "remove"
  | "context"
  | "untracked-header"
  | "untracked-file"
  | "commit-header"
  | "commit-meta"
  | "commit-message";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const META_RE =
  /^(index|new file|deleted file|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files) /;
const COMMIT_META_RE = /^(Author|AuthorDate|Commit|CommitDate|Date|Merge):/;
const APPLY_PATCH_FILE_RE = /^\*\*\* (Add|Update|Delete) File: /;

export function classifyLine(line: string): DiffLine {
  if (line.startsWith("# untracked files"))
    return { kind: "untracked-header", text: line };
  if (line.startsWith("?")) return { kind: "untracked-file", text: line };

  if (line.startsWith("commit ")) return { kind: "commit-header", text: line };
  if (COMMIT_META_RE.test(line)) return { kind: "commit-meta", text: line };

  if (line.startsWith("diff --git")) return { kind: "file", text: line };
  if (APPLY_PATCH_FILE_RE.test(line)) return { kind: "file", text: line };
  if (line.startsWith("@@")) return { kind: "hunk", text: line };
  if (line.startsWith("+++") || line.startsWith("---"))
    return { kind: "meta", text: line };
  if (META_RE.test(line)) return { kind: "meta", text: line };

  if (line.startsWith("+")) return { kind: "add", text: line };
  if (line.startsWith("-")) return { kind: "remove", text: line };

  return { kind: "context", text: line };
}

export function parseDiff(text: string): DiffLine[] {
  if (!text) return [];
  return text.split("\n").map(classifyLine);
}

/**
 * Group a parsed diff by file. Useful for rendering a sidebar of files with
 * per-file add/remove counts. `header` collects everything before the first
 * `diff --git` (commit header for `git show`, our "# untracked files"
 * preamble, etc.).
 */
export interface DiffFile {
  path: string;
  oldPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  header: DiffLine[];
  files: DiffFile[];
  untrackedFiles: string[];
}

function parseFileHeader(
  line: string,
): { oldPath: string; newPath: string } | null {
  // "diff --git a/foo b/foo bar" — git's format is unfortunately ambiguous
  // for paths with spaces. For now treat the simple case (no spaces).
  const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!m) return null;
  return { oldPath: m[1]!, newPath: m[2]! };
}

export function parseDiffStructured(text: string): ParsedDiff {
  const lines = parseDiff(text);
  const header: DiffLine[] = [];
  const files: DiffFile[] = [];
  const untrackedFiles: string[] = [];
  let current: DiffFile | null = null;

  for (const line of lines) {
    if (line.kind === "file") {
      if (current) files.push(current);
      const paths = parseFileHeader(line.text);
      current = {
        path: paths?.newPath ?? "(unknown)",
        oldPath: paths?.oldPath,
        isNew: false,
        isDeleted: false,
        isRename: paths !== null && paths.oldPath !== paths.newPath,
        isBinary: false,
        added: 0,
        removed: 0,
        lines: [line],
      };
      continue;
    }
    if (line.kind === "untracked-file") {
      const path = line.text.replace(/^\?\s+/, "").trim();
      if (path) untrackedFiles.push(path);
      if (current) current.lines.push(line);
      else header.push(line);
      continue;
    }
    if (current) {
      current.lines.push(line);
      if (line.kind === "add") current.added++;
      else if (line.kind === "remove") current.removed++;
      else if (line.kind === "meta") {
        const t = line.text;
        if (t.startsWith("new file")) current.isNew = true;
        else if (t.startsWith("deleted file")) current.isDeleted = true;
        else if (t.startsWith("Binary files")) current.isBinary = true;
        else if (t.startsWith("rename ")) current.isRename = true;
      }
    } else {
      header.push(line);
    }
  }
  if (current) files.push(current);

  return { header, files, untrackedFiles };
}

export interface CommitSummary {
  sha?: string;
  shortSha?: string;
  subject?: string;
  author?: string;
}

/**
 * Pull a compact "sha · subject · author" summary out of `git show` output
 * so the UI can render a tiny header instead of the multi-line commit block.
 */
export function extractCommitHeader(text: string): CommitSummary | null {
  if (!text) return null;
  let sha: string | undefined;
  let author: string | undefined;
  let subject: string | undefined;
  let inBlank = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("commit ")) {
      sha = line.slice("commit ".length).split(" ")[0];
    } else if (line.startsWith("Author: ")) {
      author = line.slice("Author: ".length);
    } else if (line === "" && sha && !subject) {
      inBlank = true;
    } else if (inBlank && line.startsWith("    ") && !subject) {
      subject = line.trim();
      break;
    }
  }
  if (!sha) return null;
  return { sha, shortSha: sha.slice(0, 7), subject, author };
}
