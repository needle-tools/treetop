#!/usr/bin/env bun
/**
 * Build supergit as a macOS .app bundle with a native window.
 *
 * Output:
 *   build/Supergit.app/Contents/
 *   ├── MacOS/Supergit           Swift launcher (WKWebView + daemon lifecycle)
 *   ├── Resources/
 *   │   ├── supergit             compiled Bun daemon binary
 *   │   ├── ui/                  SPA dist
 *   │   ├── helper.mjs           node-pty sidecar
 *   │   ├── node-pty-prebuilds/  native prebuilds (current platform)
 *   │   └── node_modules/node-pty/  for Node module resolution
 *   └── Info.plist
 *
 * Also produces build/supergit-native/ (the flat layout) for headless use.
 */

import { $ } from "bun";
import { resolve, join } from "node:path";
import { rm, mkdir, cp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const BUILD = resolve(ROOT, "build");
const FLAT = join(BUILD, "supergit-native");
const APP = join(BUILD, "Supergit.app");
const CONTENTS = join(APP, "Contents");
const MACOS = join(CONTENTS, "MacOS");
const RESOURCES = join(CONTENTS, "Resources");
const platform = `${process.platform}-${process.arch}`;

console.log(`\n=== supergit native build (${platform}) ===\n`);

// ── 1. Build UI ──────────────────────────────────────────────────────
console.log("1/6  Building UI…");
await $`cd ${resolve(ROOT, "packages/ui")} && bun run build`.quiet();
const distDir = resolve(ROOT, "packages/ui/dist");
if (!existsSync(distDir)) {
  console.error("     ✗ UI dist not found after build");
  process.exit(1);
}
console.log("     ✓ UI built");

// ── 2. Compile daemon binary ─────────────────────────────────────────
console.log("2/6  Compiling daemon…");
await rm(FLAT, { recursive: true, force: true });
await rm(APP, { recursive: true, force: true });
await mkdir(FLAT, { recursive: true });
const binaryPath = join(FLAT, "supergit");
await $`bun build --compile ${resolve(ROOT, "packages/daemon/src/server.ts")} --outfile ${binaryPath}`.quiet();
console.log("     ✓ Daemon binary compiled");

// ── 3. Build Go PTY helper + copy support files ─────────────────────
console.log("3/6  Building Go helper + copying files…");

await cp(distDir, join(FLAT, "ui"), { recursive: true });

// Build the Go PTY helper — replaces Node + helper.mjs + node-pty.
const goHelperDir = resolve(ROOT, "packages/daemon/src/terminals/helper-go");
await $`cd ${goHelperDir} && go build -o ${join(FLAT, "pty-helper")} .`.quiet();

console.log("     ✓ Go helper + support files copied");

// ── 4. Compile Swift launcher ────────────────────────────────────────
console.log("4/6  Compiling Swift launcher…");
const swiftSrc = resolve(ROOT, "scripts/Supergit.swift");
const launcherBin = join(MACOS, "Supergit");
await mkdir(MACOS, { recursive: true });
await $`swiftc -O -o ${launcherBin} ${swiftSrc} -framework Cocoa -framework WebKit`.quiet();
console.log("     ✓ Swift launcher compiled");

// ── 5. Assemble .app bundle ──────────────────────────────────────────
console.log("5/6  Assembling .app bundle…");

await mkdir(RESOURCES, { recursive: true });

// Copy flat layout into Resources
await cp(join(FLAT, "supergit"), join(RESOURCES, "supergit"));
await cp(join(FLAT, "ui"), join(RESOURCES, "ui"), { recursive: true });
await cp(join(FLAT, "pty-helper"), join(RESOURCES, "pty-helper"));

await $`chmod +x ${join(RESOURCES, "supergit")} ${join(RESOURCES, "pty-helper")}`.quiet();

// Info.plist
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Supergit</string>
  <key>CFBundleIdentifier</key>
  <string>tools.needle.supergit</string>
  <key>CFBundleName</key>
  <string>Supergit</string>
  <key>CFBundleDisplayName</key>
  <string>Supergit</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticTermination</key>
  <false/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>`;
await writeFile(join(CONTENTS, "Info.plist"), plist);

console.log("     ✓ .app bundle assembled");

// ── 6. Smoke test (headless, flat binary) ────────────────────────────
const smokePort = "17779";
console.log(`6/6  Smoke test on :${smokePort}…`);

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
  // Wait for daemon to be ready (retries for up to 10s)
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    await Bun.sleep(500);
    try {
      const r = await fetch(`http://localhost:${smokePort}/api/debug/mem`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) ready = true;
    } catch {}
  }
  if (!ready) throw new Error("Daemon didn't respond after 10s");

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

// ── Summary ──────────────────────────────────────────────────────────
const { stdout: flatSize } = await $`du -sh ${FLAT}`.quiet();
const { stdout: appSize } = await $`du -sh ${APP}`.quiet();
console.log(`\n  Done!\n`);
console.log(`  Flat:    ${FLAT}  (${flatSize.toString().trim().split("\t")[0]})`);
console.log(`  App:     ${APP}  (${appSize.toString().trim().split("\t")[0]})`);
console.log(`\n  Double-click ${APP} or run:`);
console.log(`    open ${APP}\n`);

if (!ok) process.exit(1);
