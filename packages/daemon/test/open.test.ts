import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildRestoreWindowScript,
  detectEditors,
  findWorkspaceFile,
  resetDetectEditorsCache,
} from "../src/open";

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
    const base = basename(d);
    await writeFile(join(d, `${base}.code-workspace`), "{}");
    expect(await findWorkspaceFile(d)).toBe(join(d, `${base}.code-workspace`));
  });
});

describe("buildRestoreWindowScript", () => {
  test("embeds the process name in a Get-Process call", () => {
    const script = buildRestoreWindowScript("Cursor");
    expect(script).toContain("Get-Process -Name 'Cursor'");
  });

  test("uses SW_RESTORE (9) on minimized windows", () => {
    const script = buildRestoreWindowScript("Code");
    expect(script).toContain("IsIconic");
    expect(script).toContain("ShowWindow($h, 9)");
  });

  test("doubles single quotes in process names to neutralise injection", () => {
    const script = buildRestoreWindowScript("foo'; rm -rf /; '");
    // PowerShell single-quoted strings escape ' as ''. Verify the raw
    // single quote never appears unescaped inside the Get-Process arg.
    expect(script).toContain("Get-Process -Name 'foo''; rm -rf /; '''");
  });
});

describe("detectEditors caching", () => {
  test("returns the same array reference on rapid repeat calls (cache hit)", async () => {
    resetDetectEditorsCache();
    const a = await detectEditors();
    const b = await detectEditors();
    // Same reference means the second call short-circuited and didn't
    // re-spawn `which` / re-probe /Applications. If this ever fails, the
    // cache has been bypassed and /api/editors is paying full cost again.
    expect(b).toBe(a);
  });

  test("resetDetectEditorsCache forces a fresh probe", async () => {
    resetDetectEditorsCache();
    const a = await detectEditors();
    resetDetectEditorsCache();
    const b = await detectEditors();
    expect(b).not.toBe(a);
    // …but the detected editors themselves should be identical
    // (the host's filesystem didn't change between calls).
    expect(b).toEqual(a);
  });
});
