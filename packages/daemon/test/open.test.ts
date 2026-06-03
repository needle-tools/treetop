import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildRestoreWindowScript,
  detectEditors,
  findWorkspaceFile,
  isUrlLike,
  pathFromFileUrl,
  repoCandidateFromNativeOpenUrl,
  resetDetectEditorsCache,
  windowsOpenCommand,
  windowsOpensWithNotepad,
} from "../src/open";
import electrobunConfig, { macSigningConfig } from "../../../electrobun.config";
import {
  SUPERGIT_DIRECTORY_DOCUMENT_TYPE,
  SUPERGIT_FOLDER_DOCUMENT_TYPE,
  candidateInfoPlists,
  withSupergitMacOpenWith,
} from "../../../scripts/patch-macos-open-with";
import { macBuildAppCandidates } from "../../../scripts/install-macos";

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

describe("isUrlLike", () => {
  test("matches scheme:// URLs", () => {
    expect(isUrlLike("http://localhost:27787/x.png")).toBe(true);
    expect(isUrlLike("https://github.com/a/b")).toBe(true);
    expect(isUrlLike("file:///C:/Users/me/x.png")).toBe(true);
    expect(isUrlLike("file:///home/me/x.png")).toBe(true);
  });

  test("does NOT match Windows drive paths, back- or forward-slash", () => {
    // A clicked link / link target may arrive with either separator —
    // both must read as a local file (colon but no `://`).
    expect(isUrlLike("C:\\Users\\me\\.claude.json")).toBe(false);
    expect(isUrlLike("C:\\Users\\me\\photo.png")).toBe(false);
    expect(isUrlLike("C:/Users/me/.claude.json")).toBe(false);
    expect(isUrlLike("C:/Users/me/photo.png")).toBe(false);
  });

  test("does NOT match Linux / macOS absolute paths", () => {
    expect(isUrlLike("/home/me/.claude.json")).toBe(false);
    expect(isUrlLike("/Users/me/Library/photo.png")).toBe(false);
    expect(isUrlLike("/usr/local/bin/thing")).toBe(false);
  });

  test("does NOT match relative or UNC paths", () => {
    expect(isUrlLike("./attachments/paste.png")).toBe(false);
    expect(isUrlLike("../config.json")).toBe(false);
    expect(isUrlLike("attachments/paste.png")).toBe(false);
    expect(isUrlLike("\\\\server\\share\\file.json")).toBe(false);
  });
});

describe("native open URLs", () => {
  test("decodes file URLs for macOS open-url events", () => {
    expect(pathFromFileUrl("file:///Users/me/has%20space")).toBe(
      "/Users/me/has space",
    );
    expect(pathFromFileUrl("supergit://repo/abc")).toBeNull();
  });

  test("uses a file's parent as the repo candidate", async () => {
    const d = await tempDir();
    const workspace = join(d, "project.code-workspace");
    await writeFile(workspace, "{}");
    expect(await repoCandidateFromNativeOpenUrl(`file://${workspace}`)).toBe(d);
  });
});

describe("macOS Open With metadata", () => {
  test("declares .code-workspace files in the Electrobun bundle config", () => {
    expect(electrobunConfig.app.urlSchemes).toContain("supergit");
    expect(electrobunConfig.app.fileAssociations).toContainEqual({
      ext: ["code-workspace"],
      name: "Supergit Workspace",
      role: "Editor",
    });
  });

  test("keeps macOS signing opt-in for local builds", () => {
    expect(macSigningConfig({})).toEqual({
      codesign: false,
      notarize: false,
    });
    expect(macSigningConfig({ SUPERGIT_CODESIGN: "1" })).toEqual({
      codesign: true,
      notarize: false,
    });
    expect(
      macSigningConfig({
        SUPERGIT_CODESIGN: "1",
        SUPERGIT_NOTARIZE: "1",
      }),
    ).toEqual({
      codesign: true,
      notarize: true,
    });
  });

  test("post-wrap patch adds a public.folder document type", () => {
    expect(withSupergitMacOpenWith({}).CFBundleDocumentTypes).toContainEqual(
      SUPERGIT_FOLDER_DOCUMENT_TYPE,
    );
    expect(withSupergitMacOpenWith({}).CFBundleDocumentTypes).toContainEqual(
      SUPERGIT_DIRECTORY_DOCUMENT_TYPE,
    );
    expect(withSupergitMacOpenWith({}).CFBundleURLTypes).toContainEqual({
      CFBundleTypeRole: "Editor",
      CFBundleURLName: "Supergit",
      CFBundleURLSchemes: ["supergit"],
    });
  });

  test("post-wrap patch is idempotent", () => {
    const plist = withSupergitMacOpenWith({});
    const twice = withSupergitMacOpenWith(plist);
    expect(twice.CFBundleDocumentTypes).toEqual(plist.CFBundleDocumentTypes);
  });

  test("post-wrap patch targets the wrapped macOS bundle", () => {
    expect(
      candidateInfoPlists({
        ELECTROBUN_OS: "macos",
        ELECTROBUN_WRAPPER_BUNDLE_PATH: "/tmp/Supergit.app",
        ELECTROBUN_BUILD_DIR: "/tmp/build",
        ELECTROBUN_APP_NAME: "Supergit",
      }),
    ).toEqual([
      "/tmp/Supergit.app/Contents/Info.plist",
      "/tmp/build/Supergit.app/Contents/Info.plist",
    ]);
  });

  test("post-build patch is a no-op on non-mac hosts", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(candidateInfoPlists({})).toEqual([]);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });

  test("build:install looks for the stable app before the legacy flat app", () => {
    expect(macBuildAppCandidates("/repo", "arm64")).toEqual([
      "/repo/build/stable-macos-arm64/Supergit.app",
      "/repo/build/Supergit.app",
    ]);
  });
});

describe("windowsOpensWithNotepad", () => {
  const base = {
    isUrl: false,
    hasExtension: true,
    hasAssociation: false,
    isRegularFile: true,
  };

  test("true only for an unassociated local file with an extension", () => {
    expect(windowsOpensWithNotepad(base)).toBe(true);
  });

  test("URLs never go to notepad (terminal link handler posts here too)", () => {
    // Regression: a clicked http(s) link must reach the browser via
    // `start`, not open notepad with the URL as a filename.
    expect(windowsOpensWithNotepad({ ...base, isUrl: true })).toBe(false);
  });

  test("directories (folder links) stay on `start` → Explorer", () => {
    expect(
      windowsOpensWithNotepad({ ...base, hasExtension: false, isRegularFile: false }),
    ).toBe(false);
  });

  test("associated files use the default app, not notepad", () => {
    expect(windowsOpensWithNotepad({ ...base, hasAssociation: true })).toBe(
      false,
    );
  });

  test("a missing / non-regular path stays on `start`", () => {
    expect(windowsOpensWithNotepad({ ...base, isRegularFile: false })).toBe(
      false,
    );
  });
});

describe("windowsOpenCommand", () => {
  const COMSPEC = process.env.COMSPEC ?? "cmd.exe";

  test("default route is `start` (with the empty title arg)", () => {
    const cmd = windowsOpenCommand("C:\\Users\\me\\photo.png", false);
    expect(cmd).toEqual([COMSPEC, "/c", "start", "", "C:\\Users\\me\\photo.png"]);
  });

  test("notepad route when useNotepad is set", () => {
    // .json is unassociated on stock Windows — `start` would no-op, so
    // the file must still open via notepad (the bug this fixes).
    const cmd = windowsOpenCommand("C:\\Users\\me\\.claude.json", true);
    expect(cmd).toEqual(["notepad", "C:\\Users\\me\\.claude.json"]);
  });

  test("the empty title arg is preserved so spaced paths still open", () => {
    const cmd = windowsOpenCommand("C:\\Program Files\\app\\config.json", false);
    // The "" sits between `start` and the path; without it `start` would
    // treat a quoted spaced path as a window title and open a blank shell.
    expect(cmd[3]).toBe("");
    expect(cmd[4]).toBe("C:\\Program Files\\app\\config.json");
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
