#!/usr/bin/env bun
/**
 * Patch electrobun's launcher main.js with two hooks:
 *
 * 1. PRE-INIT cleanup (before startEventLoop):
 *    Kill orphan msedgewebview2.exe from a previous crash that are
 *    holding the WebView2 profile lockfile (HRESULT 0x800700AA).
 *
 * 2. POST-CLOSE cleanup (between startEventLoop and forceExit):
 *    When the user closes the window, startEventLoop returns but
 *    forceExit immediately hard-kills the process — so the Worker's
 *    process.on("exit") never fires. We inject cleanup here to:
 *    - Kill our own msedgewebview2.exe children
 *    - Delete the lockfile
 *    The daemon (Worker inside bun) dies with the bun process via
 *    forceExit, so no separate HTTP shutdown call is needed.
 *
 * Electrobun copies main.js from node_modules/electrobun/dist/ into
 * the built bundle. We patch that source template before `electrobun
 * build` runs. Idempotent: a marker comment prevents re-patching.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const targets = [
  resolve(ROOT, "node_modules/electrobun/dist/main.js"),
  resolve(ROOT, "node_modules/electrobun/dist-win-x64/main.js"),
];

const MARKER = "/* SUPERGIT_LAUNCHER_PATCHED */";

// Helper: resolve the WebView2 partition path. Used by both snippets.
//
// Uses __require (= import.meta.require, defined at top of bundled
// main.js by Bun's bundler) — bare require() is not a global in Bun's
// ESM runtime, so any earlier use of `require()` here silently threw
// and the cleanup never ran.
const PARTITION_RESOLVE = `
    const _path = __require("node:path");
    const _fs = __require("node:fs");
    const { spawnSync: _spawnSync } = __require("bun");
    const _partition = _path.resolve(
      _path.dirname(process.execPath),
      "..", "..", "WebView2", "Partitions", "default", "EBWebView",
    );`;

// Kill ALL msedgewebview2.exe processes via Get-Process | Stop-Process.
//
// We used to filter to only our partition via Get-CimInstance + Where-Object
// on CommandLine, but on a busy Windows 11 box Get-CimInstance Win32_Process
// regularly takes 30–60s because it enumerates every process plus WMI joins.
// This runs on the LAUNCHER MAIN THREAD between Worker spawn and
// electrobun_core_run_main_thread, so during that time the WebView2 message
// loop can't pump → the window appears but is frozen. Switching to
// Get-Process (PSAPI, not WMI) is sub-second.
//
// Side-effect of dropping the filter: we kill every msedgewebview2.exe on
// the system, not just our partition's. msedgewebview2.exe is ONLY the
// WebView2 runtime — it is NOT Edge browser, Outlook, Teams, etc. (those
// have other process names). The only collateral damage is any other
// WebView2-hosted app a user happens to be running at launch; that's a
// rare and acceptable trade.
const KILL_WEBVIEW2 = `
    _spawnSync({
      cmd: [
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
      ],
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    const _lock = _path.join(_partition, "lockfile");
    if (_fs.existsSync(_lock)) { try { _fs.unlinkSync(_lock); } catch {} }`;

// ── Snippet 1: pre-init (before startEventLoop) ─────────────────────
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

for (const path of targets) {
  if (!existsSync(path)) {
    console.log(`  skip (not present): ${path}`);
    continue;
  }
  const src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) {
    console.log(`  already patched: ${path}`);
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
    writeFileSync(path, out);
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
  writeFileSync(path, out);
  console.log(`  patched (old API): ${path}`);
}
