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
 *    - POST /api/shutdown to the daemon
 *    - Kill our own msedgewebview2.exe children
 *    - Delete the lockfile
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

// Kill msedgewebview2.exe whose --user-data-dir matches our partition.
const KILL_WEBVIEW2 = `
    const _esc = _partition.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "''");
    _spawnSync({
      cmd: [
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \\"Name='msedgewebview2.exe'\\" | " +
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + _esc + "') } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
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
const POST_CLOSE = `
  // Post-close: startEventLoop just returned (user closed the window).
  // forceExit below hard-kills the process, so the Worker's
  // process.on("exit") never fires. Clean up here instead.
  try {${PARTITION_RESOLVE}${KILL_WEBVIEW2}
    // Shut down the daemon so it doesn't linger.
    try {
      const _http = __require("node:http");
      const _req = _http.request("http://localhost:27787/api/shutdown", { method: "POST", timeout: 2000 });
      _req.on("error", () => {});
      _req.end();
    } catch {}
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
