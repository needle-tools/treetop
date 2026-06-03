#!/usr/bin/env bun
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";

type Plist = Record<string, unknown>;

export const SUPERGIT_FOLDER_DOCUMENT_TYPE = {
  CFBundleTypeName: "Folder",
  CFBundleTypeRole: "Editor",
  CFBundleTypeOSTypes: ["TEXT", "utxt", "TUTX", "****"],
  CFBundleTypeExtensions: [],
  CFBundleTypeIconFile: "AppIcon",
  LSItemContentTypes: ["public.folder"],
};

export const SUPERGIT_DIRECTORY_DOCUMENT_TYPE = {
  CFBundleTypeName: "Directory",
  CFBundleTypeRole: "Editor",
  CFBundleTypeExtensions: [],
  CFBundleTypeIconFile: "AppIcon",
  LSHandlerRank: "Alternate",
  LSItemContentTypes: ["public.directory"],
};

export function withSupergitMacOpenWith(plist: Plist): Plist {
  const docs = Array.isArray(plist.CFBundleDocumentTypes)
    ? [...plist.CFBundleDocumentTypes]
    : [];
  const hasType = (type: string) =>
    docs.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Plist).LSItemContentTypes) &&
        ((entry as Plist).LSItemContentTypes as unknown[]).includes(type),
    );
  const hasSupergitScheme =
    Array.isArray(plist.CFBundleURLTypes) &&
    plist.CFBundleURLTypes.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as Plist).CFBundleURLSchemes) &&
        ((entry as Plist).CFBundleURLSchemes as unknown[]).includes("supergit"),
    );
  const urlTypes = Array.isArray(plist.CFBundleURLTypes)
    ? [...plist.CFBundleURLTypes]
    : [];
  if (!hasSupergitScheme) {
    urlTypes.push({
      CFBundleTypeRole: "Editor",
      CFBundleURLName: "Supergit",
      CFBundleURLSchemes: ["supergit"],
    });
  }
  if (!hasType("public.folder")) docs.push(SUPERGIT_FOLDER_DOCUMENT_TYPE);
  if (!hasType("public.directory")) {
    docs.push(SUPERGIT_DIRECTORY_DOCUMENT_TYPE);
  }
  return {
    ...plist,
    CFBundleDocumentTypes: docs,
    CFBundleURLTypes: urlTypes,
  };
}

export function patchInfoPlist(infoPath: string): void {
  const raw = spawnSync(["plutil", "-convert", "json", "-o", "-", infoPath], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (raw.exitCode !== 0) throw new Error(`plutil failed for ${infoPath}`);
  const plist = JSON.parse(new TextDecoder().decode(raw.stdout));
  writeFileSync(
    infoPath,
    JSON.stringify(withSupergitMacOpenWith(plist), null, 2),
  );
  const xml = spawnSync(["plutil", "-convert", "xml1", infoPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (xml.exitCode !== 0) {
    throw new Error(`plutil xml conversion failed for ${infoPath}`);
  }
  console.log(`patched macOS Open With folder type: ${infoPath}`);
}

export function candidateInfoPlists(env: NodeJS.ProcessEnv): string[] {
  const paths = new Set<string>();
  for (const arg of process.argv.slice(2)) {
    if (arg.endsWith(".app")) paths.add(join(arg, "Contents", "Info.plist"));
    else paths.add(arg);
  }
  if (paths.size > 0) return [...paths];

  if (env.ELECTROBUN_OS === "macos") {
    const wrapper = env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
    if (wrapper) paths.add(join(wrapper, "Contents", "Info.plist"));
    const buildDir = env.ELECTROBUN_BUILD_DIR;
    const appName = env.ELECTROBUN_APP_NAME;
    if (buildDir && appName) {
      paths.add(join(buildDir, `${appName}.app`, "Contents", "Info.plist"));
    }
    return [...paths];
  }

  if (process.platform !== "darwin") return [];
  const root = resolve(import.meta.dir, "..", "build");
  collectBuiltSupergitPlists(root, paths);
  return [...paths];
}

function collectBuiltSupergitPlists(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let s;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    if (entry === "Supergit.app") {
      out.add(join(path, "Contents", "Info.plist"));
      continue;
    }
    collectBuiltSupergitPlists(path, out);
  }
}

if (import.meta.main) {
  for (const infoPath of candidateInfoPlists(process.env)) {
    if (existsSync(infoPath)) patchInfoPlist(infoPath);
  }
}
