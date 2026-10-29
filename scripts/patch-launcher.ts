#!/usr/bin/env bun
/** Patch the SDK launcher for DPI/thread initialization and migrate old
 * templates away from global WebView2 termination. Native hosts own their
 * WebViews; daemon and broker lifetimes are managed separately. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** SDK callbacks explicitly decode CString pointers. Bun 1.4 now converts
 * cstring callback arguments to JS strings; keep the SDK's pointer contract. */
export function preserveNativeCallbackPointers(source: string): string {
  return source.replace(/new JSCallback\([\s\S]*?\n\);/g, callback =>
    callback.replace(/args:\s*\[[^\]]*\]/g, args => args.replace(/FFIType\.cstring\b/g, "FFIType.ptr")));
}

if (import.meta.main) {
  for (const directory of ["dist", "dist-win-x64", "dist-macos-arm64", "dist-macos-x64"]) {
    const path = resolve(ROOT, "node_modules/electrobun", directory, "api/bun/proc/native.ts");
    if (!existsSync(path)) continue;
    const original = readFileSync(path, "utf8");
    const patched = preserveNativeCallbackPointers(original);
    if (patched !== original) writeFileSync(path, patched);
  }
}

const targets = [
  resolve(ROOT, "node_modules/electrobun/dist/main.js"),
  resolve(ROOT, "node_modules/electrobun/dist-win-x64/main.js"),
];

const MARKER = "/* SUPERGIT_LAUNCHER_PATCHED */";

const LEGACY_DPI_MARKER = "/* TREETOP_PER_MONITOR_DPI */";
const DPI_MARKER = "/* TREETOP_PER_MONITOR_DPI_V2 */";
const LEGACY_DPI_INIT = `
  ${LEGACY_DPI_MARKER}
  // Set the process default on the launcher thread before the Worker
  // can create any HWND. Windows otherwise bitmap-stretches our UI.
  if (process.platform === "win32") {
    try {
      const { dlopen: _dpiDlopen } = __require("bun:ffi");
      const _dpiUser32 = _dpiDlopen("user32.dll", {
        SetProcessDpiAwarenessContext: { args: ["i64"], returns: "i32" },
      });
      try {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = (HANDLE)-4.
        if (!_dpiUser32.symbols.SetProcessDpiAwarenessContext(-4n)) {
          console.warn("[LAUNCHER] Could not enable per-monitor DPI awareness (process default may already be set)");
        }
      } finally { _dpiUser32.close(); }
    } catch (error) {
      console.warn("[LAUNCHER] Could not initialize DPI awareness:", error);
    }
  }
`;

const DPI_INIT = LEGACY_DPI_INIT
  .replace(LEGACY_DPI_MARKER, DPI_MARKER)
  .replace(
    'SetProcessDpiAwarenessContext: { args: ["i64"], returns: "i32" },',
    'SetProcessDpiAwarenessContext: { args: ["i64"], returns: "i32" },\n        SetThreadDpiAwarenessContext: { args: ["i64"], returns: "i64" },',
  )
  .replace(
    '      } finally { _dpiUser32.close(); }',
    '        // A preexisting thread override survives a process-default change.\n        if (!_dpiUser32.symbols.SetThreadDpiAwarenessContext(-4n)) {\n          console.warn("[LAUNCHER] Could not enable per-monitor DPI awareness on the launcher thread");\n        }\n      } finally { _dpiUser32.close(); }',
  );

export function addDpiAwarenessBeforeWorker(source: string): string {
  if (source.includes(DPI_MARKER)) return source;
  // Upgrade launcher templates patched before thread overrides were handled.
  source = source.replace(LEGACY_DPI_INIT, "");
  const worker = source.indexOf("new Worker(");
  if (worker < 0) throw new Error("Unrecognized launcher: missing app Worker");
  // Insert before the complete statement, including a possible assignment.
  const lineStart = source.lastIndexOf("\n", worker) + 1;
  return source.slice(0, lineStart) + DPI_INIT + source.slice(lineStart);
}

/** Electrobun downloads its CLI after package installation. On newer macOS
 * versions that cached ad-hoc signature can be rejected: the CLI then exits
 * zero without producing a bundle, leaving build:launch to open an old app.
 * Re-signing the local build tool makes failure explicit and keeps the
 * distribution bundle on the same build timestamp as the native payload. */
export function electrobunCliPreparationFor(platform: NodeJS.Platform, root: string): {
  command: string;
  args: string[];
} | undefined {
  if (platform !== "darwin") return undefined;
  return {
    command: "codesign",
    args: [
      "--force",
      "--sign",
      "-",
      resolve(root, "node_modules/electrobun/bin/electrobun"),
    ],
  };
}

function prepareElectrobunCli(): void {
  const preparation = electrobunCliPreparationFor(process.platform, ROOT);
  if (!preparation) return;
  const cliPath = preparation.args.at(-1)!;
  if (!existsSync(cliPath)) {
    throw new Error(`Electrobun CLI not found: ${cliPath}`);
  }
  const result = spawnSync(preparation.command, preparation.args, {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Could not prepare Electrobun CLI (codesign exited ${result.status ?? "without a status"})`);
  }
  console.log(`  prepared Electrobun CLI: ${cliPath}`);
}

/** Cleanup must finish before the Worker can create its first WebView2.
 * Existing patched templates also need migration: the marker alone does
 * not mean they have the safe startup order. */
export function moveCleanupBeforeWorker(source: string): string {
  const marker = source.indexOf(MARKER);
  const worker = source.indexOf("new Worker(");
  if (marker < 0 || worker < 0) {
    throw new Error("Unrecognized launcher: missing cleanup or app Worker");
  }
  if (marker < worker) return source;
  const entry = /^[\t ]*(?:const\s+\w+\s*=\s*)?lib\.symbols\.(?:electrobun_core_run_main_thread|startEventLoop)\s*\(/m.exec(source.slice(marker));
  if (!entry) throw new Error("Unrecognized launcher: missing native event loop");
  const cleanupEnd = marker + entry.index;
  return source.slice(0, worker) + source.slice(marker, cleanupEnd) +
    source.slice(worker, marker) + source.slice(cleanupEnd);
}

// Helper: resolve the WebView2 partition path. Used by both snippets.
//
// Uses __require (= import.meta.require, defined at top of bundled
// main.js by Bun's bundler) — bare require() is not a global in Bun's
// ESM runtime, so any earlier use of `require()` here silently threw
// and the cleanup never ran.
//
// CRITICAL — the partition path is NOT under the install dir.
// Electrobun's WebView2 host plants its profile at
//   %LOCALAPPDATA%\Electrobun\default\WebView2\Partitions\default\EBWebView
// regardless of where launcher.exe lives. Earlier we resolved against
// process.execPath (..\..\WebView2\Partitions\default\EBWebView), which
// pointed at a directory that DOES NOT EXIST in the installed app. So
// the lockfile cleanup ran against an empty path and a stale lockfile
// in the real partition kept blocking WebView2 init — symptom: window
// opens but never paints, no msedgewebview2 children even spawn,
// app.log shows "Custom class failed, falling back to STATIC class"
// because the message pump can't bind the WebView2 surface.
const PARTITION_RESOLVE = `
    const _path = __require("node:path");
    const _fs = __require("node:fs");
    const { spawnSync: _spawnSync } = __require("bun");
    const _appdata = process.env.LOCALAPPDATA
      || _path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const _partition = _path.join(
      _appdata, "Electrobun", "default", "WebView2", "Partitions", "default", "EBWebView",
    );`;

// WebView2 belongs to its native host. Never kill other hosts during an
// installer handoff (or a second-window launch). The SDK tears down its views.
const LEGACY_GLOBAL_CLEANUP = "Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue";
const KILL_WEBVIEW2 = "";
export function removeGlobalWebviewCleanup(source: string): string {
  return source.split(LEGACY_GLOBAL_CLEANUP).join("Write-Verbose 'Native host owns WebView2 lifetime'");
}

const PRE_INIT = `
  ${MARKER}
  // Pre-init: kill orphan WebView2 from previous crashes so the
  // profile lockfile is free before startEventLoop opens WebView2.
  try {${PARTITION_RESOLVE}${KILL_WEBVIEW2}
  } catch {}
`;

// ── Snippet 2: post-close (between startEventLoop and forceExit) ────
//
// Why no HTTP shutdown call: the daemon runs as a Worker inside the
// same bun process. forceExit(0) below kills bun, which kills the
// Worker — no separate /api/shutdown needed. (The previous version
// hardcoded port 27787, which is the dev/`bun run start` port, not
// the port electrobun's installed bundle binds — it picks 50000+.)
const POST_CLOSE = `
  // Post-close: startEventLoop just returned (user closed the window).
  // Kill our msedgewebview2 children + drop the profile lockfile so
  // the next launch starts clean. forceExit below takes care of bun
  // and the Worker (= daemon).
  try {${PARTITION_RESOLVE}${KILL_WEBVIEW2}
  } catch {}
`;

// Electrobun 1.18.1+ replaced the original {startEventLoop, forceExit}
// pair with a single `electrobun_core_run_main_thread` call that returns
// an i32 status code. We support both shapes — older builds still use
// the old symbols. Find both API variants and patch whichever matches.
const ENTRY_OLD = /lib\.symbols\.startEventLoop\s*\(/;
const EXIT_OLD = /lib\.symbols\.forceExit\s*\(/;
const ENTRY_NEW = /lib\.symbols\.electrobun_core_run_main_thread\s*\(/;

if (import.meta.main) prepareElectrobunCli();

if (import.meta.main) for (const path of targets) {
  if (!existsSync(path)) {
    console.log(`  skip (not present): ${path}`);
    continue;
  }
  const src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) {
    const migrated = removeGlobalWebviewCleanup(addDpiAwarenessBeforeWorker(moveCleanupBeforeWorker(src)));
    if (migrated !== src) writeFileSync(path, migrated);
    console.log(`  ${migrated !== src ? "moved cleanup before Worker" : "already patched"}: ${path}`);
    continue;
  }

  // Try the new API shape first (electrobun_core_run_main_thread).
  // The call returns the status, so post-close runs naturally after it.
  const mNew = src.match(ENTRY_NEW);
  if (mNew) {
    // Locate the end of the const runStatus = ...; statement: scan from
    // the match index forward to the matching `;` after the closing `)`.
    const start = mNew.index!;
    let i = start, depth = 0, found = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    // Skip whitespace + ;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === ";") { i++; found = i; }
    if (found < 0) {
      console.warn(`  ⚠ couldn't locate end of run_main_thread call in ${path}`);
      continue;
    }
    // Find the start of the line containing run_main_thread (back to \n)
    let lineStart = start;
    while (lineStart > 0 && src[lineStart - 1] !== "\n") lineStart--;

    const out =
      src.slice(0, lineStart) +
      PRE_INIT +
      src.slice(lineStart, found) +
      "\n" +
      POST_CLOSE +
      src.slice(found);
    writeFileSync(path, addDpiAwarenessBeforeWorker(moveCleanupBeforeWorker(out)));
    console.log(`  patched (new API): ${path}`);
    continue;
  }

  // Fallback: old API (startEventLoop + forceExit).
  const mStart = src.match(ENTRY_OLD);
  const mExit = src.match(EXIT_OLD);
  if (!mStart) {
    console.warn(`  ⚠ no recognized entry point in ${path}, skipping`);
    continue;
  }
  if (!mExit) {
    console.warn(`  ⚠ no forceExit in ${path}, skipping`);
    continue;
  }
  let out = src.slice(0, mExit.index!) + POST_CLOSE + "  " + src.slice(mExit.index!);
  const mStart2 = out.match(ENTRY_OLD);
  out = out.slice(0, mStart2!.index!) + PRE_INIT + "  " + out.slice(mStart2!.index!);
  writeFileSync(path, addDpiAwarenessBeforeWorker(moveCleanupBeforeWorker(out)));
  console.log(`  patched (old API): ${path}`);
}
