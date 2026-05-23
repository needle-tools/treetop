#!/usr/bin/env bun
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { $ } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const platform = `${process.platform}-${process.arch}`;

const paths = {
  app: resolve(ROOT, `build/stable-${platform === "darwin-arm64" ? "macos-arm64" : platform}/Supergit.app`),
  dmg: resolve(ROOT, "artifacts", `stable-macos-arm64-Supergit.dmg`),
  flat: resolve(ROOT, "build/supergit-native"),
};

console.log(`\n=== supergit build complete ===\n`);

for (const [label, path] of Object.entries(paths)) {
  if (existsSync(path)) {
    const { stdout } = await $`du -sh ${path}`.quiet();
    console.log(`  ${label.padEnd(5)} ${path}  (${stdout.toString().trim().split("\t")[0]})`);
  }
}

if (existsSync(paths.app)) {
  console.log(`\n  open ${paths.app}\n`);
}
