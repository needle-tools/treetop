#!/usr/bin/env bun
import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE_ID = "tools.needle.supergit";
const DEFAULT_DEST = "/Applications/Supergit.app";

export function macBuildAppCandidates(
  root: string,
  arch = process.arch,
): string[] {
  const macArch = arch === "arm64" ? "macos-arm64" : "macos-x64";
  return [
    resolve(root, `build/stable-${macArch}/Supergit.app`),
    resolve(root, "build/Supergit.app"),
  ];
}

function firstExistingApp(paths: string[]): string | null {
  for (const path of paths) {
    try {
      if (existsSync(path) && statSync(path).isDirectory()) return path;
    } catch {}
  }
  return null;
}

function appIsRunning(): boolean {
  const r = spawnSync(
    [
      "osascript",
      "-e",
      `application id "${BUNDLE_ID}" is running`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  return new TextDecoder().decode(r.stdout).trim() === "true";
}

function run(cmd: string[]): void {
  const r = spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

function plistValue(appPath: string, key: string): string {
  const r = spawnSync(
    [
      "/usr/libexec/PlistBuddy",
      "-c",
      `Print :${key}`,
      `${appPath}/Contents/Info.plist`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return new TextDecoder().decode(r.stdout).trim();
}

function assertInstalledMetadata(appPath: string): void {
  const docs = plistValue(appPath, "CFBundleDocumentTypes");
  const urls = plistValue(appPath, "CFBundleURLTypes");
  const missing = [
    ["public.folder", docs],
    ["public.directory", docs],
    ["supergit", urls],
  ].filter(([needle, haystack]) => !haystack.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `Installed app is missing macOS Open With metadata: ${missing
        .map(([needle]) => needle)
        .join(", ")}`,
    );
  }
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    throw new Error("build:install is macOS-only");
  }

  if (appIsRunning()) {
    throw new Error(
      "Supergit is running. Quit the app first, then rerun `bun run build:install`.",
    );
  }

  const source =
    process.env.SUPERGIT_INSTALL_SOURCE ??
    firstExistingApp(macBuildAppCandidates(ROOT));
  if (!source) {
    throw new Error(
      "No built Supergit.app found. Run `bun run build` before install.",
    );
  }

  const dest = process.env.SUPERGIT_INSTALL_DEST ?? DEFAULT_DEST;
  console.log(`installing ${source} -> ${dest}`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true, force: true });
  assertInstalledMetadata(dest);

  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  run([lsregister, "-f", dest]);

  console.log("\nInstalled Supergit:");
  console.log(`  bundle: ${plistValue(dest, "CFBundleIdentifier")}`);
  console.log(`  docs:\n${plistValue(dest, "CFBundleDocumentTypes")}`);
  console.log(`  urls:\n${plistValue(dest, "CFBundleURLTypes")}`);
  console.log("\nTry:");
  console.log(`  open -a Supergit ${ROOT}`);
}
