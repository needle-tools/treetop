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

export function classifyLine(line: string): DiffLine {
  if (line.startsWith("# untracked files"))
    return { kind: "untracked-header", text: line };
  if (line.startsWith("?")) return { kind: "untracked-file", text: line };

  if (line.startsWith("commit ")) return { kind: "commit-header", text: line };
  if (COMMIT_META_RE.test(line)) return { kind: "commit-meta", text: line };

  if (line.startsWith("diff --git")) return { kind: "file", text: line };
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
