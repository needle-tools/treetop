import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

const daemonUp = await fetch("http://localhost:7777/api/health")
  .then((r) => r.ok)
  .catch(() => false);

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "supergit-files-test-"));
  await mkdir(join(tmpDir, "src"));
  await mkdir(join(tmpDir, "docs"));
  await mkdir(join(tmpDir, ".hidden-dir"));
  await writeFile(join(tmpDir, "README.md"), "# Hello\n");
  await writeFile(join(tmpDir, "package.json"), '{"name":"test"}');
  await writeFile(join(tmpDir, ".gitignore"), "node_modules\n");
  await writeFile(join(tmpDir, "src", "index.ts"), "console.log('hi');\n");
  await writeFile(join(tmpDir, "src", "util.ts"), "export const x = 1;\n");
  await writeFile(join(tmpDir, "docs", "guide.md"), "# Guide\n");
  try {
    await symlink(join(tmpDir, "README.md"), join(tmpDir, "LINK.md"));
  } catch {}
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function fetchFiles(path: string): Promise<{
  path: string;
  entries: {
    name: string;
    type: "file" | "directory" | "symlink";
    size?: number;
  }[];
}> {
  const res = await fetch(
    `http://localhost:7777/api/files?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

describe.skipIf(!daemonUp)("/api/files", () => {
  test("lists directory contents, sorted directories first", async () => {
    const result = await fetchFiles(tmpDir);
    expect(result.path).toBe(tmpDir);
    const names = result.entries.map((e) => e.name);
    expect(names.includes("src")).toBe(true);
    expect(names.includes("docs")).toBe(true);
    expect(names.includes("README.md")).toBe(true);
    expect(names.includes("package.json")).toBe(true);
    const dirIndices = result.entries
      .map((e, i) => (e.type === "directory" ? i : -1))
      .filter((i) => i >= 0);
    const fileIndices = result.entries
      .map((e, i) => (e.type === "file" || e.type === "symlink" ? i : -1))
      .filter((i) => i >= 0);
    if (dirIndices.length > 0 && fileIndices.length > 0) {
      expect(Math.max(...dirIndices)).toBeLessThan(Math.min(...fileIndices));
    }
  });

  test("includes dotfiles and dot-directories", async () => {
    const result = await fetchFiles(tmpDir);
    const names = result.entries.map((e) => e.name);
    expect(names.includes(".hidden-dir")).toBe(true);
    expect(names.includes(".gitignore")).toBe(true);
  });

  test("returns file sizes for files", async () => {
    const result = await fetchFiles(tmpDir);
    const readme = result.entries.find((e) => e.name === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.type).toBe("file");
    expect(typeof readme!.size).toBe("number");
    expect(readme!.size).toBeGreaterThan(0);
  });

  test("directories have no size field", async () => {
    const result = await fetchFiles(tmpDir);
    const src = result.entries.find((e) => e.name === "src");
    expect(src).toBeDefined();
    expect(src!.type).toBe("directory");
    expect(src!.size).toBeUndefined();
  });

  test("lists subdirectory contents", async () => {
    const result = await fetchFiles(join(tmpDir, "src"));
    const names = result.entries.map((e) => e.name);
    expect(names).toContain("index.ts");
    expect(names).toContain("util.ts");
  });

  test("returns 400 without path param", async () => {
    const res = await fetch("http://localhost:7777/api/files");
    expect(res.status).toBe(400);
  });

  test("returns 500 for non-existent directory", async () => {
    const res = await fetch(
      `http://localhost:7777/api/files?path=${encodeURIComponent("/nonexistent/path/xyz")}`,
    );
    expect(res.status).toBe(500);
  });

  test("entries within a directory are alphabetically sorted", async () => {
    const result = await fetchFiles(join(tmpDir, "src"));
    const names = result.entries.map((e) => e.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test("symlinks are identified as symlink type", async () => {
    const result = await fetchFiles(tmpDir);
    const link = result.entries.find((e) => e.name === "LINK.md");
    if (link) {
      expect(link.type).toBe("symlink");
    }
  });
});

describe.skipIf(!daemonUp)("/api/exists", () => {
  type StatEntry = { exists: boolean; type?: "file" | "directory" | "symlink" };
  async function postExists(
    paths: string[],
  ): Promise<Record<string, StatEntry>> {
    const res = await fetch("http://localhost:7777/api/exists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { results: Record<string, StatEntry> };
    return body.results;
  }

  test("returns exists:true with type:'file' for existing files", async () => {
    const real = join(tmpDir, "README.md");
    const result = await postExists([real]);
    expect(result[real]).toEqual({ exists: true, type: "file" });
  });

  test("returns exists:false for missing paths", async () => {
    const missing = join(tmpDir, "this-file-does-not-exist.txt");
    const result = await postExists([missing]);
    expect(result[missing]).toEqual({ exists: false });
  });

  test("returns type:'directory' for directories", async () => {
    const result = await postExists([join(tmpDir, "src")]);
    expect(result[join(tmpDir, "src")]).toEqual({
      exists: true,
      type: "directory",
    });
  });

  test("returns type:'symlink' for symlinks (lstat, not stat)", async () => {
    const link = join(tmpDir, "LINK.md");
    const result = await postExists([link]);
    // LINK.md is created in beforeAll; on Windows w/o developer mode this
    // may fall back to a real file copy, in which case "file" is fine.
    expect(result[link]!.exists).toBe(true);
    expect(["symlink", "file"]).toContain(result[link]!.type);
  });

  test("mixed existing + missing paths in one request", async () => {
    const a = join(tmpDir, "README.md");
    const b = join(tmpDir, "ghost.md");
    const c = join(tmpDir, "src");
    const result = await postExists([a, b, c]);
    expect(result[a]!.exists).toBe(true);
    expect(result[a]!.type).toBe("file");
    expect(result[b]!.exists).toBe(false);
    expect(result[c]!.type).toBe("directory");
  });

  test("handles empty input", async () => {
    const result = await postExists([]);
    expect(result).toEqual({});
  });

  test("returns 400 when body.paths is not an array", async () => {
    const res = await fetch("http://localhost:7777/api/exists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  test("ignores non-string entries (filtered out)", async () => {
    const res = await fetch("http://localhost:7777/api/exists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [join(tmpDir, "README.md"), 42, null] }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { results: Record<string, StatEntry> };
    expect(body.results[join(tmpDir, "README.md")]!.exists).toBe(true);
    // non-strings dropped — no extra keys
    expect(Object.keys(body.results).length).toBe(1);
  });
});
