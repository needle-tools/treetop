#!/usr/bin/env bun
/**
 * Build a self-contained supergit native binary + support files.
 *
 * Output layout:
 *   build/supergit-native/
 *   ├── supergit               compiled Bun binary
 *   ├── ui/                    SPA dist
 *   ├── helper.mjs             node-pty sidecar
 *   └── node_modules/node-pty/ runtime JS + current-platform prebuilds
 */

import { $ } from "bun";
import { resolve, join } from "node:path";
import { rm, mkdir, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(ROOT, "build", "supergit-native");
const platform = `${process.platform}-${process.arch}`;

console.log(`\n=== supergit native build (${platform}) ===\n`);

// 1. Build UI
console.log("1/4  Building UI…");
await $`cd ${resolve(ROOT, "packages/ui")} && bun run build`.quiet();
const distDir = resolve(ROOT, "packages/ui/dist");
if (!existsSync(distDir)) {
  console.error("   ✗ UI dist not found after build");
  process.exit(1);
}
console.log("     ✓ UI built");

// 2. Compile binary
console.log("2/4  Compiling daemon…");
const binaryPath = join(OUT, "supergit");
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await $`bun build --compile ${resolve(ROOT, "packages/daemon/src/server.ts")} --outfile ${binaryPath}`.quiet();
console.log("     ✓ Binary compiled");

// 3. Copy support files
console.log("3/4  Copying support files…");

// UI dist
await cp(distDir, join(OUT, "ui"), { recursive: true });

// helper.mjs
await cp(
  resolve(ROOT, "packages/daemon/src/terminals/helper.mjs"),
  join(OUT, "helper.mjs"),
);

// node-pty: lib + current-platform prebuilds only
const ptySrc = resolve(ROOT, "node_modules/node-pty");
const ptyDst = join(OUT, "node_modules", "node-pty");
await mkdir(join(ptyDst, "lib"), { recursive: true });
await cp(join(ptySrc, "package.json"), join(ptyDst, "package.json"));
await cp(join(ptySrc, "lib"), join(ptyDst, "lib"), { recursive: true });

// Only copy prebuilds for the current platform
const prebuildSrc = join(ptySrc, "prebuilds", platform);
if (existsSync(prebuildSrc)) {
  const prebuildDst = join(ptyDst, "prebuilds", platform);
  await mkdir(prebuildDst, { recursive: true });
  await cp(prebuildSrc, prebuildDst, { recursive: true });

  // Also copy into the exe-adjacent location the backend checks first
  const exeAdjDst = join(OUT, "node-pty-prebuilds", platform);
  await mkdir(exeAdjDst, { recursive: true });
  await cp(prebuildSrc, exeAdjDst, { recursive: true });
}

// Strip test files from the copied lib
for (const f of await readdir(join(ptyDst, "lib"))) {
  if (f.endsWith(".test.js") || f.endsWith(".test.js.map") || f.endsWith(".js.map")) {
    await rm(join(ptyDst, "lib", f));
  }
}

console.log("     ✓ Support files copied");

// 4. Smoke test
const smokePort = "17779";
console.log(`4/5  Smoke test on :${smokePort}…`);

// Clear inherited env that would override path resolution
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("SUPERGIT_")) continue;
  if (v != null) cleanEnv[k] = v;
}
cleanEnv.SUPERGIT_PORT = smokePort;

const daemon = Bun.spawn([binaryPath], {
  env: cleanEnv,
  stdout: "pipe",
  stderr: "pipe",
});

let ok = true;
try {
  await Bun.sleep(3000);

  const mem = await fetch(`http://localhost:${smokePort}/api/debug/mem`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!mem.ok) throw new Error(`API returned ${mem.status}`);

  const html = await fetch(`http://localhost:${smokePort}/`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!html.ok) throw new Error(`UI returned ${html.status}`);
  const body = await html.text();
  if (!body.includes("<!doctype html>") && !body.includes("<!DOCTYPE html>"))
    throw new Error("UI response doesn't look like HTML");

  console.log("     ✓ API + UI respond correctly");
} catch (err) {
  console.error(`     ✗ Smoke test failed: ${err}`);
  ok = false;
} finally {
  daemon.kill();
  await daemon.exited;
}

// 5. Summary
const { stdout: sizeOut } = await $`du -sh ${OUT}`.quiet();
console.log(`5/5  Done!\n`);
console.log(`  Output:  ${OUT}`);
console.log(`  Size:    ${sizeOut.toString().trim().split("\t")[0]}`);
console.log(`  Binary:  ${binaryPath}`);
console.log(`\n  To run:  ${binaryPath}`);
console.log(`  Or:      SUPERGIT_PORT=17777 ${binaryPath}\n`);

if (!ok) process.exit(1);
