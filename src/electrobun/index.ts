/**
 * Electrobun main process — replaces the Swift launcher.
 *
 * 1. Resolves the user's real PATH (same reason as the Swift version:
 *    .app bundles get a minimal system PATH).
 * 2. Checks if git is available.
 * 3. Checks for an existing daemon, or starts the bundled one.
 * 4. Opens a native BrowserWindow pointed at localhost:<port>.
 */

import { BrowserWindow, ApplicationMenu } from "electrobun/bun";
import { resolve, dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";

const PORT = 27787;
const DAEMON_URL = `http://localhost:${PORT}`;
const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

// ── Resolve user's login PATH ────────────────────────────────────────
// On mac/linux, a .app bundle launched from Finder gets a minimal system
// PATH (no Homebrew, no asdf, no /usr/local/bin extras). Shell out to a
// login shell to pick up the user's real PATH so spawned tools (git,
// claude, codex, node, etc.) resolve. On Windows the launcher inherits
// the user's environment normally, so this is a no-op.

function resolveLoginPath(): string | null {
  if (isWin) return null;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const result = spawnSync(shell, ["-l", "-c", "echo $PATH"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const p = result.stdout?.trim();
    return p || null;
  } catch {
    return null;
  }
}

const loginPath = resolveLoginPath();
if (loginPath) {
  process.env.PATH = loginPath;
}

// ── Check for git ────────────────────────────────────────────────────

function gitAvailable(): boolean {
  try {
    const r = spawnSync("git", ["--version"], {
      timeout: 3000,
      stdio: "ignore",
      env: process.env,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ── Daemon lifecycle ─────────────────────────────────────────────────

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/debug/mem`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(attempts = 0): Promise<void> {
  if (attempts > 50) throw new Error("Daemon didn't start after 10s");
  if (await isDaemonRunning()) return;
  await new Promise((r) => setTimeout(r, 200));
  return waitForDaemon(attempts + 1);
}

let ownsDaemon = false;
let daemonProc: ReturnType<typeof spawn> | null = null;

async function getDaemonBuildTime(): Promise<string | null> {
  try {
    const res = await fetch(`${DAEMON_URL}/api/identity`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { buildTime?: string };
    return body.buildTime ?? null;
  } catch {
    return null;
  }
}

async function shutdownDaemon(): Promise<void> {
  try {
    await fetch(`${DAEMON_URL}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
  // Wait for port to be released
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await isDaemonRunning())) return;
  }
}

function loadMyBuildTime(): string | null {
  // build-info.json is copied into the bundle by electrobun.config.ts
  const execDir = dirname(process.execPath);
  const candidates = [
    resolve(execDir, "..", "Resources", "app", "build-info.json"),
    resolve(process.cwd(), "build", "supergit-native", "build-info.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.buildTime === "string") return parsed.buildTime;
    } catch {}
  }
  return null;
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    const myBuildTime = loadMyBuildTime();
    if (myBuildTime) {
      const remoteBuildTime = await getDaemonBuildTime();
      // No remote buildTime = dev daemon, assume newer. Only replace
      // when we can confirm the running daemon is strictly older.
      if (remoteBuildTime && remoteBuildTime < myBuildTime) {
        console.log(
          `supergit: replacing older daemon (${remoteBuildTime}) with ${myBuildTime}`,
        );
        await shutdownDaemon();
        // Fall through to start our own
      } else {
        return; // Running daemon is same age or newer
      }
    } else {
      return; // Dev mode, no build-info.json — reuse whatever's running
    }
  }

  // Find the bundled daemon binary. Layout differs per platform:
  //   macOS:   process.execPath = …/Contents/MacOS/bun
  //            copied files at  …/Contents/Resources/app/
  //   Windows: process.execPath = …/Supergit/bin/launcher.exe
  //            copied files at  …/Supergit/Resources/app.asar.unpacked/
  //            (because electrobun.config.ts adds them to asarUnpack)
  // We list every plausible path and use the first that exists.
  const execDir = dirname(process.execPath);
  const binName = `supergit${exe}`;
  const candidates = [
    // macOS bundle
    resolve(execDir, "..", "Resources", "app", binName),
    // Windows bundle — asar-unpacked (entry kept its `app/` prefix)
    resolve(execDir, "..", "Resources", "app.asar.unpacked", "app", binName),
    // Windows bundle — asar-unpacked (entry stored at root)
    resolve(execDir, "..", "Resources", "app.asar.unpacked", binName),
    // Flat native build (fallback for development)
    resolve(process.cwd(), "build", "supergit-native", binName),
  ];

  let binary: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) { binary = c; break; }
  }

  if (!binary) {
    console.error("supergit daemon binary not found in:", candidates);
    process.exit(1);
  }

  // Clean env for daemon
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SUPERGIT_")) continue;
    if (v != null) env[k] = v;
  }
  env.SUPERGIT_PORT = String(PORT);
  if (loginPath) env.PATH = loginPath;

  daemonProc = spawn(binary, [], {
    env,
    stdio: "ignore",
    detached: false,
  });

  daemonProc.on("error", (err) => {
    console.error("Failed to start daemon:", err.message);
  });

  ownsDaemon = true;
  await waitForDaemon();
}

// ── Cleanup ──────────────────────────────────────────────────────────

process.on("exit", () => {
  if (ownsDaemon && daemonProc && !daemonProc.killed) {
    daemonProc.kill("SIGTERM");
  }
});

// ── Window bounds persistence ────────────────────────────────────────

type WindowBounds = { x: number; y: number; width: number; height: number };

const BOUNDS_DIR = join(homedir(), ".config", "supergit");
const BOUNDS_FILE = join(BOUNDS_DIR, "window.json");

function loadBounds(): WindowBounds {
  const fallback = { x: 100, y: 100, width: 1400, height: 900 };
  try {
    const raw = readFileSync(BOUNDS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.x === "number" && typeof parsed.width === "number")
      return parsed;
  } catch {}
  return fallback;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveBounds(bounds: WindowBounds): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(BOUNDS_DIR, { recursive: true });
      writeFileSync(BOUNDS_FILE, JSON.stringify(bounds));
    } catch {}
  }, 500);
}

// ── Main ─────────────────────────────────────────────────────────────

if (!gitAvailable()) {
  if (isWin) {
    console.error("git is not installed. Install from https://git-scm.com/download/win");
  } else {
    console.error(
      "git is not installed. Install Xcode Command Line Tools:\n  xcode-select --install",
    );
  }
  process.exit(1);
}

// macOS: strip the default Edit menu so WKWebView doesn't intercept
// Ctrl+A (Select All), Ctrl+C, etc. before xterm.js sees them.
// Windows: no native menu bar — skip entirely.
if (!isWin) {
  ApplicationMenu.setApplicationMenu([
    {
      label: "Supergit",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "close" },
        { type: "separator" },
        { role: "toggleFullScreen" },
      ],
    },
  ]);
}

await ensureDaemon();

const bounds = loadBounds();

const win = new BrowserWindow({
  title: "Supergit",
  url: DAEMON_URL,
  frame: bounds,
});

// Set the window/taskbar icon on Windows via Win32 API. Electrobun
// copies icon.ico to Resources/app.ico but never calls setWindowIcon,
// so the taskbar shows the default bun icon. We load the ico directly
// via LoadImage + SendMessage(WM_SETICON) using bun:ffi.
if (isWin) {
  try {
    const icoPath = resolve(dirname(process.execPath), "..", "Resources", "app.ico");
    if (existsSync(icoPath)) {
      const user32 = dlopen("user32.dll", {
        FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        SendMessageW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        LoadImageW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      });
      const title16 = new Uint8Array(Buffer.from("Supergit\0", "utf-16le"));
      const hwnd = user32.symbols.FindWindowW(null, ptr(title16));
      if (hwnd) {
        const ico16 = new Uint8Array(Buffer.from(icoPath + "\0", "utf-16le"));
        const IMAGE_ICON = 1;
        const LR_LOADFROMFILE = 0x0010;
        const LR_DEFAULTSIZE = 0x0040;
        const WM_SETICON = 0x0080;
        const ICON_SMALL = 0;
        const ICON_BIG = 1;
        const hIcon = user32.symbols.LoadImageW(null, ptr(ico16), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
        if (hIcon) {
          user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_SMALL as any, hIcon);
          user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_BIG as any, hIcon);
        }
      }
    }
  } catch (e) {
    console.warn("Failed to set window icon:", e);
  }
}

win.on("resize", (event: any) => {
  const frame = win.getFrame();
  saveBounds(frame);
});

win.on("move", (event: any) => {
  const frame = win.getFrame();
  saveBounds(frame);
});
