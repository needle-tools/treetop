import { test, expect, describe } from "bun:test";
import {
  parseDiff,
  classifyLine,
  parseDiffStructured,
  extractCommitHeader,
} from "../src/diff";

describe("classifyLine", () => {
  test("classifies file headers", () => {
    expect(classifyLine("diff --git a/foo b/foo").kind).toBe("file");
  });

  test("classifies meta lines including --- / +++", () => {
    expect(classifyLine("index abc..def 100644").kind).toBe("meta");
    expect(classifyLine("new file mode 100644").kind).toBe("meta");
    expect(classifyLine("deleted file mode 100644").kind).toBe("meta");
    expect(classifyLine("rename from a.txt").kind).toBe("meta");
    expect(classifyLine("Binary files a/foo and b/foo differ").kind).toBe("meta");
    expect(classifyLine("--- a/foo").kind).toBe("meta");
    expect(classifyLine("+++ b/foo").kind).toBe("meta");
  });

  test("classifies hunk headers", () => {
    expect(classifyLine("@@ -1,3 +1,4 @@ context").kind).toBe("hunk");
  });

  test("classifies + / - / context lines", () => {
    expect(classifyLine("+added").kind).toBe("add");
    expect(classifyLine("-removed").kind).toBe("remove");
    expect(classifyLine(" unchanged").kind).toBe("context");
    expect(classifyLine("").kind).toBe("context");
  });

  test("does not misclassify --- / +++ as remove / add", () => {
    expect(classifyLine("--- a/foo").kind).toBe("meta");
    expect(classifyLine("+++ b/foo").kind).toBe("meta");
  });

  test("classifies commit header + metadata from git show", () => {
    expect(classifyLine("commit abc123def").kind).toBe("commit-header");
    expect(classifyLine("Author: Marcel").kind).toBe("commit-meta");
    expect(classifyLine("AuthorDate: 2026-05-12").kind).toBe("commit-meta");
    expect(classifyLine("Commit: Marcel").kind).toBe("commit-meta");
    expect(classifyLine("CommitDate: 2026-05-12").kind).toBe("commit-meta");
    expect(classifyLine("Merge: abc def").kind).toBe("commit-meta");
  });

  test("classifies our # untracked-files preamble", () => {
    expect(classifyLine("# untracked files (3):").kind).toBe("untracked-header");
    expect(classifyLine("?  README.md").kind).toBe("untracked-file");
  });
});

describe("parseDiff", () => {
  test("returns [] for empty input", () => {
    expect(parseDiff("")).toEqual([]);
  });

  test("parses a small full diff", () => {
    const sample = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,1 +1,1 @@",
      "-v1",
      "+v2",
    ].join("\n");
    const out = parseDiff(sample);
    expect(out.map((l) => l.kind)).toEqual([
      "file",
      "meta",
      "meta",
      "meta",
      "hunk",
      "remove",
      "add",
    ]);
  });

  test("parses git show output (commit header + diff)", () => {
    const sample = [
      "commit abc123",
      "Author: Marcel",
      "Date: now",
      "",
      "    Subject line",
      "",
      "diff --git a/a b/a",
      "@@ -0,0 +1 @@",
      "+hi",
    ].join("\n");
    const out = parseDiff(sample);
    expect(out[0]?.kind).toBe("commit-header");
    expect(out[1]?.kind).toBe("commit-meta");
    expect(out[2]?.kind).toBe("commit-meta");
    expect(out[6]?.kind).toBe("file");
    expect(out[7]?.kind).toBe("hunk");
    expect(out[8]?.kind).toBe("add");
  });
});

describe("parseDiffStructured", () => {
  test("returns empty for empty input", () => {
    const r = parseDiffStructured("");
    expect(r.header).toEqual([]);
    expect(r.files).toEqual([]);
    expect(r.untrackedFiles).toEqual([]);
  });

  test("parses a single file with add and remove counts", () => {
    const sample = [
      "diff --git a/a.txt b/a.txt",
      "index 1..2 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.path).toBe("a.txt");
    expect(r.files[0]?.added).toBe(1);
    expect(r.files[0]?.removed).toBe(1);
  });

  test("flags a new file", () => {
    const sample = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0..1 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.files[0]?.isNew).toBe(true);
    expect(r.files[0]?.added).toBe(1);
  });

  test("flags a deleted file", () => {
    const sample = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.files[0]?.isDeleted).toBe(true);
    expect(r.files[0]?.removed).toBe(1);
  });

  test("flags a rename and captures both paths", () => {
    const sample = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to new.txt",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.files[0]?.isRename).toBe(true);
    expect(r.files[0]?.path).toBe("new.txt");
    expect(r.files[0]?.oldPath).toBe("old.txt");
  });

  test("flags binary files", () => {
    const sample = [
      "diff --git a/a.bin b/a.bin",
      "Binary files a/a.bin and b/a.bin differ",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.files[0]?.isBinary).toBe(true);
  });

  test("splits multiple files", () => {
    const sample = [
      "diff --git a/a.txt b/a.txt",
      "@@ -1 +1 @@",
      "-a1",
      "+a2",
      "diff --git a/b.txt b/b.txt",
      "@@ -1 +1 @@",
      "-b1",
      "+b2",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.files).toHaveLength(2);
    expect(r.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
  });

  test("collects commit header before the first file", () => {
    const sample = [
      "commit abc",
      "Author: Marcel",
      "Date: today",
      "",
      "    subject",
      "",
      "diff --git a/a b/a",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.header[0]?.kind).toBe("commit-header");
    expect(r.files).toHaveLength(1);
  });

  test("captures untracked files from the # preamble", () => {
    const sample = [
      "# untracked files (2):",
      "?  foo.txt",
      "?  bar.ts",
      "",
    ].join("\n");
    const r = parseDiffStructured(sample);
    expect(r.untrackedFiles).toEqual(["foo.txt", "bar.ts"]);
  });
});

describe("extractCommitHeader", () => {
  test("returns null for non-commit input", () => {
    expect(extractCommitHeader("")).toBeNull();
    expect(extractCommitHeader("diff --git a/a b/a")).toBeNull();
  });

  test("extracts sha, shortSha, author, and subject", () => {
    const sample = [
      "commit abc1234defabcd",
      "Author: Marcel <m@example.com>",
      "AuthorDate: 2026-05-12",
      "",
      "    Fix the thing",
      "    body continues here",
      "",
      "diff --git a/x b/x",
    ].join("\n");
    const r = extractCommitHeader(sample);
    expect(r?.sha).toBe("abc1234defabcd");
    expect(r?.shortSha).toBe("abc1234");
    expect(r?.author).toBe("Marcel <m@example.com>");
    expect(r?.subject).toBe("Fix the thing");
  });
});
