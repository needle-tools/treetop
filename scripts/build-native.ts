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
import { resolve, join, relative } from "node:path";
import { rm, mkdir, cp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { installPayloadPathspec } from "../packages/daemon/src/provision";

const ROOT = resolve(import.meta.dir, "..");
const BUILD = resolve(ROOT, "build");
const FLAT = join(BUILD, "supergit-native");
const APP = join(BUILD, "Supergit.app");
const CONTENTS = join(APP, "Contents");
const MACOS = join(CONTENTS, "MacOS");
const RESOURCES = join(CONTENTS, "Resources");
const platform = `${process.platform}-${process.arch}`;
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

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
// On Windows `bun build --compile` auto-appends `.exe`; on mac/linux it doesn't.
const binaryPath = join(FLAT, `supergit${exe}`);
const buildTime = new Date().toISOString();
await $`bun build --compile ${resolve(ROOT, "packages/daemon/src/server.ts")} --outfile ${join(FLAT, "supergit")} --define process.env.SUPERGIT_BUILD_TIME='"${buildTime}"'`.quiet();
// Write build-info.json so the Electrobun entry script knows our version.
await writeFile(join(FLAT, "build-info.json"), JSON.stringify({ buildTime }));
console.log("     ✓ Daemon binary compiled");

// ── 3. Build Go PTY helper + copy support files ─────────────────────
console.log("3/6  Building Go helper + copying files…");

await cp(distDir, join(FLAT, "ui"), { recursive: true });

// Build the Go PTY helper — replaces Node + helper.mjs + node-pty.
// Explicit `.exe` on Windows; `go build` doesn't add it when -o has no extension.
const goHelperDir = resolve(ROOT, "packages/daemon/src/terminals/helper-go");
const ptyHelperPath = join(FLAT, `pty-helper${exe}`);
await $`cd ${goHelperDir} && go build -o ${ptyHelperPath} .`.quiet();

console.log("     ✓ Go helper + support files copied");

// ── 3b. Bundle install payload (source the app ships to provision a box) ──
// The packaged app holds only THIS platform's compiled binaries, so it has
// nothing to run on a remote Linux box. Auto-provision therefore ships the
// SOURCE over ssh → `install.sh --no-pull` builds native artifacts ON the
// box. `git archive HEAD` is exactly the tracked tree (no node_modules /
// build / dist). The daemon finds it next to the binary via
// resolveInstallPayload(). Best-effort: if it can't be bundled (e.g. built
// from a non-git tarball), the app still works — auto-provision just reports
// itself unavailable and the manual paste flow remains.
console.log("3b/6 Bundling install payload…");
const payloadDir = join(FLAT, "install-payload");
const payloadTar = join(FLAT, "_install-payload.tar");
// Always leave the dir present so the electrobun copy step (which lists it
// statically) never hard-fails — even if the bundling below can't run.
await mkdir(payloadDir, { recursive: true });
try {
  // Archive to a FILE then extract — no shell pipe (Bun's `$` pipe + a bare
  // `tar -x` reading stdin is flaky on Windows). installPayloadPathspec()
  // drops the lone symlink (Windows `tar` can't create it) + internal docs /
  // AI-agent rules the box doesn't need. git archive HEAD = tracked tree only.
  //
  // CRITICAL (Windows): pass tar RELATIVE, forward-slash paths — never an
  // absolute "C:\…". GNU tar (Git Bash) reads a leading "C:" as a remote host
  // ("tar: Cannot connect to C: resolve failed") and the whole step silently
  // failed, shipping an EMPTY install-payload → the app reports mode "none".
  // git runs from the repo root (default cwd) so the `.` pathspec is correct.
  const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
  const tarRel = rel(payloadTar);
  const dirRel = rel(payloadDir);
  await $`git archive --format=tar -o ${tarRel} HEAD -- ${installPayloadPathspec()}`.quiet();
  await $`tar -x -f ${tarRel} -C ${dirRel}`.quiet();
  if (
    !existsSync(join(payloadDir, "deploy", "install.sh")) ||
    !existsSync(join(payloadDir, "packages", "daemon", "src", "server.ts"))
  ) {
    throw new Error("essential source files missing from the archive");
  }
  console.log("     ✓ install payload bundled (git archive HEAD)");
} catch (e) {
  console.warn(
    `     ⚠ install payload NOT bundled (${e instanceof Error ? e.message : e}); ` +
      `auto-provision will be unavailable in this build (manual paste still works)`,
  );
} finally {
  await rm(payloadTar, { force: true });
}

// ── 4. Compile Swift launcher (macOS only) ──────────────────────────
// On Windows/Linux, electrobun ships its own native launcher per platform,
// so the Swift step is mac-specific and skipped elsewhere.
if (isMac) {
  console.log("4/6  Compiling Swift launcher…");
  const swiftSrc = resolve(ROOT, "scripts/Supergit.swift");
  const launcherBin = join(MACOS, "Supergit");
  await mkdir(MACOS, { recursive: true });
  await $`swiftc -O -o ${launcherBin} ${swiftSrc} -framework Cocoa -framework WebKit`.quiet();
  console.log("     ✓ Swift launcher compiled");
} else {
  console.log("4/6  Compiling Swift launcher… (skipped, not macOS)");
}

// ── 5. Assemble .app bundle (macOS only) ────────────────────────────
if (isMac) {
  console.log("5/6  Assembling .app bundle…");

  await mkdir(RESOURCES, { recursive: true });

  // Copy flat layout into Resources
  await cp(join(FLAT, "supergit"), join(RESOURCES, "supergit"));
  await cp(join(FLAT, "ui"), join(RESOURCES, "ui"), { recursive: true });
  await cp(join(FLAT, "pty-helper"), join(RESOURCES, "pty-helper"));
  // The install payload (source for remote auto-provision), when bundled.
  if (existsSync(payloadDir)) {
    await cp(payloadDir, join(RESOURCES, "install-payload"), {
      recursive: true,
    });
  }

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
} else {
  console.log("5/6  Assembling .app bundle… (skipped, not macOS)");
}

// ── 5b. Stamp Windows icon + metadata onto electrobun binaries ───────
// Electrobun's built-in rcedit call fails (hardcoded CI paths), so we
// stamp the source bun.exe and launcher.exe BEFORE `electrobun build`
// compresses them into the archive. This way the installed app shows
// the Needle icon in the taskbar, Task Manager, and Alt+Tab.
if (isWin) {
  const rcedit = resolve(ROOT, "node_modules/rcedit/bin/rcedit-x64.exe");
  const ico = resolve(ROOT, "icon.ico");
  const ebDist = resolve(ROOT, "node_modules/electrobun/dist-win-x64");
  const targets = ["bun.exe", "launcher.exe"]
    .map((f) => join(ebDist, f))
    .filter((p) => existsSync(p));

  if (existsSync(rcedit) && existsSync(ico) && targets.length > 0) {
    console.log("5b/6 Stamping icon + metadata onto electrobun binaries…");
    for (const exe of targets) {
      await $`${rcedit} ${exe} --set-icon ${ico} --set-version-string ProductName Supergit --set-version-string FileDescription Supergit --set-file-version 0.1.0 --set-product-version 0.1.0`.quiet();
    }
    console.log("     ✓ Icon + version info stamped");
  }
}

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
async function dirSize(dir: string): Promise<string> {
  // Cross-platform recursive size in MB. Avoids `du` (unix-only).
  const { readdir, stat } = await import("node:fs/promises");
  async function walk(p: string): Promise<number> {
    const s = await stat(p);
    if (!s.isDirectory()) return s.size;
    let total = 0;
    for (const entry of await readdir(p)) total += await walk(join(p, entry));
    return total;
  }
  const bytes = await walk(dir);
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

console.log(`\n  Done!\n`);
console.log(`  Flat:    ${FLAT}  (${await dirSize(FLAT)})`);
if (isMac && existsSync(APP)) {
  console.log(`  App:     ${APP}  (${await dirSize(APP)})`);
  console.log(`\n  Double-click ${APP} or run:`);
  console.log(`    open ${APP}\n`);
} else {
  console.log(`\n  Next: run \`electrobun build --env=stable\` to wrap the flat layout into a native app bundle.\n`);
}

if (!ok) process.exit(1);
