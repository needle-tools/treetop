import { test, expect, describe } from "bun:test";
import { parseDiff, classifyLine } from "../src/diff";

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
