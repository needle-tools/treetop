#!/usr/bin/env bun
import { resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";

const ROOT = resolve(import.meta.dir, "..");
const platform = `${process.platform}-${process.arch}`;
const isWin = process.platform === "win32";

const paths: Record<string, string> = {
  flat: resolve(ROOT, "build/supergit-native"),
};
if (process.platform === "darwin") {
  paths.app = resolve(ROOT, `build/stable-${platform === "darwin-arm64" ? "macos-arm64" : platform}/Supergit.app`);
  paths.dmg = resolve(ROOT, "artifacts", `stable-macos-arm64-Supergit.dmg`);
}
if (isWin) {
  paths.setup = resolve(ROOT, "build/stable-win-x64/Supergit-Setup.exe");
  paths.archive = resolve(ROOT, "build/stable-win-x64/Supergit-Setup.tar.zst");
}

// Cross-platform recursive size (avoids `du`, which doesn't exist on Windows).
async function sizeOf(path: string): Promise<string> {
  async function walk(p: string): Promise<number> {
    const s = statSync(p);
    if (!s.isDirectory()) return s.size;
    let total = 0;
    for (const entry of await readdir(p)) total += await walk(join(p, entry));
    return total;
  }
  const bytes = await walk(path);
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

console.log(`\n=== supergit build complete ===\n`);

for (const [label, path] of Object.entries(paths)) {
  if (existsSync(path)) {
    console.log(`  ${label.padEnd(7)} ${path}  (${await sizeOf(path)})`);
  }
}

if (paths.app && existsSync(paths.app)) {
  console.log(`\n  open ${paths.app}\n`);
} else if (isWin && paths.setup && existsSync(paths.setup)) {
  console.log(`\n  Run the installer:  ${paths.setup}\n`);
}
