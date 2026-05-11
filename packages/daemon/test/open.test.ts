import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceFile } from "../src/open";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-open-"));
}

describe("findWorkspaceFile", () => {
  test("returns null for a missing directory", async () => {
    expect(await findWorkspaceFile("/nope/does/not/exist")).toBeNull();
  });

  test("returns null when no .code-workspace file is present", async () => {
    const d = await tempDir();
    await writeFile(join(d, "README.md"), "");
    expect(await findWorkspaceFile(d)).toBeNull();
  });

  test("returns the workspace file when there is exactly one", async () => {
    const d = await tempDir();
    await writeFile(join(d, "anything.code-workspace"), "{}");
    expect(await findWorkspaceFile(d)).toBe(join(d, "anything.code-workspace"));
  });

  test("prefers the file matching the directory basename", async () => {
    const d = await tempDir();
    await writeFile(join(d, "zzz.code-workspace"), "{}");
    const base = d.split("/").filter(Boolean).pop()!;
    await writeFile(join(d, `${base}.code-workspace`), "{}");
    expect(await findWorkspaceFile(d)).toBe(
      join(d, `${base}.code-workspace`),
    );
  });
});
