/**
 * Electrobun main process — replaces the Swift launcher.
 *
 * 1. Resolves the user's real PATH (same reason as the Swift version:
 *    .app bundles get a minimal system PATH).
 * 2. Checks if git is available.
 * 3. Checks for an existing daemon, or starts the bundled one.
 * 4. Opens a native BrowserWindow pointed at localhost:<port>.
 *
 * Note: Windows WebView2 orphan cleanup runs in the launcher's main.js
 * before this Worker is started — see scripts/patch-launcher.ts. By
 * the time we reach here, the WebView2 profile is unlocked and ready.
 */

import { BrowserWindow, ApplicationMenu, Tray, Utils, BuildConfig } from "electrobun/bun";
import { updateInstallParent, watchForUpdate } from "./update-handoff";
import { PRODUCT_NAME } from "../../product";
import { resolve, dirname, join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  openSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { spawn as bunSpawn } from "bun";
import { planLogRotation } from "../../packages/daemon/src/log-rotation";
import { nativeTitleBarStyle, restoreWindowState, captureWindowState, restoreWindowModeOnReady, type WindowState } from "./window-state";
import { createWindowsWebviewFocus, createWindowFocusReadiness } from "./window-focus";
import { createWindowsWindowIcons, createWindowsCaptionStyle, trayImageSize } from "./window-icons";
import { nativeWindowFocusScript } from "../../packages/ui/src/window-focus-events";

// ── Startup logger + stall watchdog ──────────────────────────────────
// Background: we've had two recurrences where the window opens but the
// SPA never mounts ("white window, no title"). When that happens there's
// no Console, no DevTools, no stderr (Bun Worker output goes nowhere on
// Windows), so we never know WHICH startup step actually stalled. This
// writes a tagged line per phase to ~/.config/supergit/launcher-<date>.log
// and a watchdog flags any phase that takes >5s. After a hang, read this
// log and the stalled step is the last "BEGIN" without a matching "END".
const LAUNCHER_LOG_DIR = join(homedir(), ".config", "supergit");
const LAUNCHER_LOG_PATH = join(
  LAUNCHER_LOG_DIR,
  `launcher-${new Date().toISOString().slice(0, 10)}.log`,
);
try {
  mkdirSync(LAUNCHER_LOG_DIR, { recursive: true });
} catch {}
const LAUNCHER_START = Date.now();
function llog(msg: string): void {
  const elapsed = ((Date.now() - LAUNCHER_START) / 1000).toFixed(3);
  const line = `[${new Date().toISOString()}] +${elapsed}s ${msg}\n`;
  try {
    appendFileSync(LAUNCHER_LOG_PATH, line);
  } catch {}
}
llog(`=== launcher boot pid=${process.pid} ===`);
llog(`execPath=${process.execPath}`);

let currentPhase: string | null = null;
let phaseStartedAt = 0;
function beginPhase(name: string): void {
  currentPhase = name;
  phaseStartedAt = Date.now();
  llog(`BEGIN ${name}`);
}
function endPhase(name: string): void {
  const ms = Date.now() - phaseStartedAt;
  llog(`END   ${name} (${ms}ms)`);
  if (currentPhase === name) currentPhase = null;
}
async function phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  beginPhase(name);
  try {
    const r = await fn();
    endPhase(name);
    return r;
  } catch (e) {
    llog(`ERROR ${name}: ${e instanceof Error ? e.message : String(e)}`);
    endPhase(name);
    throw e;
  }
}

// Watchdog: every 1s, if a phase has been running for >5s, log a STALL
// line. Doesn't kill anything — just leaves a trail so we can see what
// hung. Cleared once boot finishes (see "boot complete" marker).
const STALL_THRESHOLD_MS = 5_000;
const stallSeen = new Set<string>();
const stallTimer = setInterval(() => {
  if (!currentPhase) return;
  const elapsed = Date.now() - phaseStartedAt;
  if (elapsed < STALL_THRESHOLD_MS) return;
  // Log once per "stall epoch" so we don't spam — every full 5s past the
  // threshold gets one line.
  const bucket = `${currentPhase}@${Math.floor(elapsed / STALL_THRESHOLD_MS)}`;
  if (stallSeen.has(bucket)) return;
  stallSeen.add(bucket);
  llog(`STALL phase=${currentPhase} elapsed=${elapsed}ms`);
}, 1_000);
// Don't keep the event loop alive solely for this watchdog. The native
// shell + BrowserWindow already hold the loop open during normal
// operation; once boot completes the watchdog has nothing useful to say.
if (typeof stallTimer.unref === "function") stallTimer.unref();

process.on("exit", (code) => {
  llog(`process exit code=${code}`);
});

// Why no bunSpawnSync: this whole file runs inside a Bun Worker that
// electrobun spawns from its native launcher. The native side keeps a
// message loop that dispatches threadsafe FFI callbacks back to this
// Worker thread; if we sit in a sync spawn (waiting on PowerShell, git,
// lsof, …) the callbacks queue up and the native side blocks waiting
// for one — most visibly, `core_.symbols.createWindow` never returns,
// and no window ever appears. Reproduced on Windows 11 26200 with
// electrobun 1.18.4-beta.3 and PowerShell Get-NetTCPConnection taking
// 10–60s. So every external command goes through `bunSpawn` + stream
// await, never sync.
async function runCapture(cmd: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const child = bunSpawn({ cmd, windowsHide: true, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const code = (await child.exited) ?? 1;
    return { code, stdout };
  } catch {
    return { code: 1, stdout: "" };
  }
}

const PREFERRED_PORT = 27787;
// Mutated by chooseDaemonPort() at startup. The UI uses relative URLs
// (`fetch("/api/...")`), so whatever port BrowserWindow opens at is
// what the frontend will hit — picking a fallback is safe.
let PORT = PREFERRED_PORT;
let DAEMON_URL = `http://localhost:${PORT}`;
const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

// ── Resolve user's login PATH ────────────────────────────────────────
// On mac/linux, a .app bundle launched from Finder gets a minimal system
// PATH (no Homebrew, no asdf, no /usr/local/bin extras). Shell out to a
// login shell to pick up the user's real PATH so spawned tools (git,
// claude, codex, node, etc.) resolve. On Windows the launcher inherits
// the user's environment normally, so this is a no-op.

async function resolveLoginPath(): Promise<string | null> {
  if (isWin) return null;
  const shell = process.env.SHELL || "/bin/zsh";
  const r = await runCapture([shell, "-l", "-c", "echo $PATH"]);
  const p = r.stdout.trim();
  return p || null;
}

const loginPath = await resolveLoginPath();
if (loginPath) {
  process.env.PATH = loginPath;
}

// ── Check for git ────────────────────────────────────────────────────

async function gitAvailable(): Promise<boolean> {
  const r = await runCapture(["git", "--version"]);
  return r.code === 0;
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
let daemonProc: ReturnType<typeof bunSpawn> | null = null;

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

/** True when something is listening on PORT but doesn't respond to
 *  HTTP. A previous daemon got wedged and is keeping the port
 *  EADDRINUSE-locked for any new daemon we'd spawn. We detect this so
 *  ensureDaemon() can force-kill the holder before spawning. */
async function isPortBound(port: number): Promise<boolean> {
  if (isWin) {
    const r = await runCapture([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`,
    ]);
    const count = parseInt(r.stdout.trim() || "0", 10);
    return count > 0;
  }
  const r = await runCapture(["lsof", "-i", `TCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return r.stdout.trim().length > 0;
}

/** Force-kill whatever process is holding PORT in LISTEN state. Only
 *  called after we've confirmed (via isDaemonRunning + isPortBound)
 *  that there's a zombie daemon — a process that bound the port but
 *  isn't responding to HTTP. Returns true if we killed something. */
async function killPortHolder(port: number): Promise<boolean> {
  if (isWin) {
    const r = await runCapture([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      `$pids = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique; ` +
      `foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; ` +
      `Write-Output ($pids.Count)`,
    ]);
    const killed = parseInt(r.stdout.trim() || "0", 10);
    return killed > 0;
  }
  const r = await runCapture(["bash", "-c", `lsof -i TCP:${port} -sTCP:LISTEN -t | xargs -r kill -9`]);
  return r.code === 0;
}

/** Try to bind a quick test server to PORT. If it works, port is free.
 *  We use Bun.listen on TCP so we don't need any kernel-level tricks. */
function canBindPort(port: number): boolean {
  try {
    const s = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {} },
    });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Pick a port for the daemon. Prefer the canonical PREFERRED_PORT so
 *  external tools / docs aren't broken. Only fall back if the port is
 *  truly wedged (bound but no live process) — that's the case where
 *  killPortHolder couldn't help because the holding PID is gone. */
async function chooseDaemonPort(): Promise<number> {
  // If something live answers on the canonical port, we'll reuse it
  // anyway (ensureDaemon handles that). Just check we can use the port.
  if (await isDaemonRunning()) return PREFERRED_PORT;
  if (canBindPort(PREFERRED_PORT)) return PREFERRED_PORT;
  // Wedged. Scan upward for a free port.
  for (let p = PREFERRED_PORT + 1; p < PREFERRED_PORT + 50; p++) {
    if (canBindPort(p)) {
      console.warn(`supergit: port ${PREFERRED_PORT} is wedged, falling back to ${p}`);
      return p;
    }
  }
  console.error(`supergit: no free port in ${PREFERRED_PORT}..${PREFERRED_PORT + 49}, using canonical anyway`);
  return PREFERRED_PORT;
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

  // Zombie check skipped at boot: we used to call isPortBound() here
  // (PowerShell Get-NetTCPConnection on Windows), but that command can
  // take 30–60s on a busy box even when run async, and during that
  // window the launcher hasn't reached `new BrowserWindow` yet — so
  // the user stares at no UI for half a minute. If a zombie is holding
  // the port, the daemon spawn below will fail with EADDRINUSE; the
  // top-level retry path (killPortHolder + 500ms + ensureDaemon again)
  // handles that case. Worst case is a slightly slower startup on a
  // truly wedged port, but the common case (no zombie) is now instant.

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
  env.TREETOP_TERMINAL_BROKER = "1";
  if (loginPath) env.PATH = loginPath;

  const logDir = join(homedir(), ".config", "supergit");
  try { mkdirSync(logDir, { recursive: true }); } catch {}
  // Daily-rotated daemon log, capped to the newest few days so it can't
  // grow without bound (the old single daemon.log never rotated). Append
  // within a day so same-day restarts don't lose earlier output; an
  // open-append fd is inheritable by the spawned daemon.
  const today = new Date().toISOString().slice(0, 10);
  let logName = `daemon-${today}.log`;
  try {
    const plan = planLogRotation(readdirSync(logDir), today, 5);
    logName = plan.activeName;
    for (const name of plan.deleteNames) {
      try { unlinkSync(join(logDir, name)); } catch {}
    }
  } catch {}
  const logPath = join(logDir, logName);
  const logFd = openSync(logPath, "a");

  try {
    daemonProc = bunSpawn({
      cmd: [binary],
      windowsHide: true,
      env,
      stdout: logFd,
      stderr: logFd,
      stdin: "ignore",
    });
  } catch (err) {
    console.error("Failed to start daemon:", (err as Error).message);
    throw err;
  }

  ownsDaemon = true;
  await waitForDaemon();
}

// ── Cleanup ──────────────────────────────────────────────────────────

process.on("exit", () => {
  if (ownsDaemon && daemonProc) {
    try { daemonProc.kill(); } catch {}
  }
});

// ── Window bounds persistence ────────────────────────────────────────

const BOUNDS_DIR = join(homedir(), ".config", "supergit");
const BOUNDS_FILE = join(BOUNDS_DIR, "window.json");

// Win32 parks minimized windows at (-32000, -32000) with thumbnail-sized
// frames (~160x39). If we ever persist those, the next launch hands them
// straight to electrobun's createWindow, which rejects them with
// "Parent window has invalid client area: 144x0" and no window ever
// appears. Treat anything that looks minimized/zero-ish as garbage.
function loadBounds(): WindowState {
  try {
    const raw = readFileSync(BOUNDS_FILE, "utf-8");
    return restoreWindowState(JSON.parse(raw));
  } catch {}
  return restoreWindowState(null);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function writeWindowState(state: WindowState): void {
  try {
    mkdirSync(BOUNDS_DIR, { recursive: true });
    writeFileSync(BOUNDS_FILE, JSON.stringify(state));
  } catch (error) { llog(`Failed to save window state: ${error}`); }
}
function saveBounds(state: WindowState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeWindowState(state);
  }, 500);
}

// ── Main ─────────────────────────────────────────────────────────────

if (!(await phase("gitAvailable", () => gitAvailable()))) {
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
      label: PRODUCT_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { label: "Stop all and quit Treetop", action: "stop-and-quit", accelerator: "Cmd+Q" },
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

// Pick a port — canonical 27787 normally; if it's wedged (Windows
// kernel sometimes leaves a LISTEN socket holding a dead PID's port
// for hours after the process dies, blocking any new bind), use the
// next free port. UI uses relative URLs so it follows whatever port
// BrowserWindow opens at.
PORT = await phase("chooseDaemonPort", () => chooseDaemonPort());
DAEMON_URL = `http://localhost:${PORT}`;
llog(`port=${PORT} url=${DAEMON_URL}`);

// Don't let an ensureDaemon failure bubble up as an unhandled
// rejection — in a Bun Worker that takes down the launcher's parent
// process with exit 1, and the user sees nothing at all. Log + retry
// once after force-killing whatever's holding the port, then bail
// loudly if it still fails.
try {
  await phase("ensureDaemon", () => ensureDaemon());
} catch (e) {
  console.error("supergit: ensureDaemon failed:", e instanceof Error ? e.message : e);
  // One last-ditch attempt: kill anything on the port and retry.
  await phase("killPortHolder", () => killPortHolder(PORT));
  await new Promise((r) => setTimeout(r, 500));
  try {
    await phase("ensureDaemon retry", () => ensureDaemon());
  } catch (e2) {
    console.error("supergit: ensureDaemon retry failed:", e2 instanceof Error ? e2.message : e2);
    // Continue anyway — BrowserWindow will load with a connection error
    // page instead of vanishing silently. The user can at least see
    // something and use the OS to terminate.
  }
}

let activeWindow: BrowserWindow | undefined;
let openingWindow = false;
let quitting = false;
const nativeWindowId = crypto.randomUUID();
let heartbeatSequence = 0;
let trayError = "";
let backgroundWasConnected = false;
let updatingTray = false;
const trayAsset = isWin ? "tray.ico" : "tray.png";
const trayAssetPath = [
  resolve(dirname(process.execPath), "..", "Resources", "app", trayAsset),
  resolve(dirname(process.execPath), "..", "Resources", "app.asar.unpacked", "app", trayAsset),
  resolve(dirname(process.execPath), "..", "Resources", "app.asar.unpacked", trayAsset),
  resolve(process.cwd(), isWin ? "icon.ico" : "tray.png"),
].find(path => existsSync(path));
const macTemplateTray = process.platform === "darwin" && !!trayAssetPath;
const tray = new Tray({ title: macTemplateTray ? "" : PRODUCT_NAME, image: trayAssetPath ?? "", template: macTemplateTray, ...trayImageSize(process.platform) });
llog(`background runtime exitOnLastWindowClosed=${BuildConfig.getSync().runtime?.exitOnLastWindowClosed ?? true}`);
llog(`background tray visible=${tray.visible} image=${trayAssetPath ?? "missing"}`);
if (!tray.visible) llog("WARNING: tray unavailable; closing the window will stop managed resources");
async function backgroundRequest(path: string, body?: unknown) {
  const response = await fetch(`${DAEMON_URL}/api/background/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path === "shutdown" ? 130_000 : 20_000),
  });
  const value = await response.json() as any;
  if (!response.ok) throw new Error(value.error ?? `Background request failed: ${response.status}`);
  return value;
}
async function stopAndQuit() {
  if (quitting) return;
  quitting = true; trayError = "";
  llog("explicit Stop all and quit requested");
  try {
    const status = await backgroundRequest("status");
    if (status.connected) await backgroundRequest("shutdown", {});
    else if (status.enabled) throw new Error("Broker is offline; process exits cannot be confirmed");
    llog("confirmed background resources stopped; quitting");
    tray.remove(); Utils.quit();
  } catch (error) {
    quitting = false; trayError = `Stop failed: ${error}`;
    llog(trayError);
    if (!activeWindow && !tray.visible) await openTreetopWindow();
    await updateTray();
  }
}
async function updateTray() {
  if (quitting || updatingTray) return;
  updatingTray = true;
  try {
    if (activeWindow) await backgroundRequest("lease", { windowId: nativeWindowId, sequence: ++heartbeatSequence });
    const status = await backgroundRequest("status");
    backgroundWasConnected ||= status.connected === true;
    const sessions = status.sessions ?? 0, commands = status.commands ?? 0, terminals = status.shells ?? 0;
    const title = status.connected ? `${sessions} sessions, ${terminals} terminals, ${commands} commands` : "Background connection unavailable";
    tray.setTitle(isWin ? `Treetop: ${title}` : macTemplateTray ? "" : PRODUCT_NAME);
    const remaining = Math.max(0, Math.ceil((status.remainingMs ?? 0) / 60_000));
    tray.setMenu([
      { type: "normal" as const, label: trayError || `Treetop: ${title}`, enabled: false },
      ...(!activeWindow && status.connected ? [{ type: "normal" as const, label: `Stops after ${remaining} min without an open Treetop window`, enabled: false }] : []),
      { type: "normal" as const, label: "Open Treetop", action: "open" },
      ...(isWin && activeWindow ? [
        { type: "normal" as const, label: "Minimize window", action: "minimize-window" },
        { type: "normal" as const, label: activeWindow.isMaximized() ? "Restore window" : "Maximize window", action: "maximize-window" },
        { type: "normal" as const, label: "Close window (keep sessions running)", action: "close-window" },
      ] : []),
      { type: "separator" },
      { type: "normal" as const, label: "Stop all and quit", action: "stop-and-quit" },
    ]);
    // A vanished broker must not leave an invisible desktop launcher forever.
    // Require a previous successful connection and its expired lease.
    if (!activeWindow && backgroundWasConnected && !status.connected && status.remainingMs === 0) {
      llog("background lease expired; closing idle tray"); tray.remove(); Utils.quit();
    }
  } catch (error) { llog(`tray/lease update failed: ${error}`); }
  finally { updatingTray = false; }
}
tray.on("tray-clicked", (event: any) => {
  if (event.data?.action === "stop-and-quit") void stopAndQuit();
  else if (event.data?.action === "minimize-window") activeWindow?.minimize();
  else if (event.data?.action === "maximize-window" && activeWindow) {
    if (activeWindow.isMaximized()) activeWindow.unmaximize();
    else activeWindow.maximize();
    void updateTray();
  }
  else if (event.data?.action === "close-window") activeWindow?.close();
  else if (event.data?.action === "open" || (isWin && !event.data?.action)) void openTreetopWindow();
});
ApplicationMenu.on("application-menu-clicked", (event: any) => {
  if (event.data?.action === "stop-and-quit") void stopAndQuit();
});
setInterval(() => { void updateTray(); }, 5000);

async function openTreetopWindow() {
  if (activeWindow) { activeWindow.unminimize(); activeWindow.show(); activeWindow.activate(); return; }
  if (openingWindow || quitting) return;
  openingWindow = true;
  try {
    await backgroundRequest("reconnect", {});
    // Renew before loading the SPA: boot/render time must not race idle cleanup.
    await backgroundRequest("lease", { windowId: nativeWindowId, sequence: ++heartbeatSequence });
  } catch (error) { llog(`window background reconnect failed: ${error}`); }
  const bounds = loadBounds();
  let windowState = bounds;
  llog(`window bounds x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height}`);

  beginPhase("new BrowserWindow");
  const win = new BrowserWindow({
    // Pre-load title; the page's <title>/document.title (same source) takes
    // over once the UI loads. Name from the shared product module.
    title: PRODUCT_NAME,
    titleBarStyle: nativeTitleBarStyle(process.platform),
    url: DAEMON_URL,
    frame: bounds,
  });
  endPhase("new BrowserWindow");
  activeWindow = win; openingWindow = false;
  void updateTray();
  let nativeFocus: ReturnType<typeof createWindowsWebviewFocus> | undefined;
  let nativeIcons: ReturnType<typeof createWindowsWindowIcons> | undefined;
  let nativeCaption: ReturnType<typeof createWindowsCaptionStyle> | undefined;
  function refreshWindowIcons() {
    if (!nativeIcons || !win.ptr) return;
    try { nativeIcons.refresh(BigInt(win.ptr)); }
    catch (error) { llog(`Failed to refresh window icons: ${error}`); }
  }
  if (isWin) {
    try { nativeFocus = createWindowsWebviewFocus(); }
    catch (error) { llog(`Failed to initialize WebView keyboard focus: ${error}`); }
  }
  let nativeFocusRetry: ReturnType<typeof setTimeout> | undefined;
  function restoreWindowInput(attempt = 0): void {
    nativeFocusRetry = undefined;
    let restored = true;
    if (nativeFocus && win.ptr) {
      const handle = BigInt(win.ptr);
      restored = nativeFocus.restore(handle);
      llog(`window focus attempt=${attempt} restored=${restored} ${JSON.stringify(nativeFocus.snapshot(handle))}`);
    }
    if (attempt === 0 || restored) win.webview.executeJavascript(nativeWindowFocusScript(true));
    if (!restored && attempt < 4) nativeFocusRetry = setTimeout(() => restoreWindowInput(attempt + 1), 75);
  }
  const focusReadiness = createWindowFocusReadiness({
    focus: () => {
      refreshWindowAppearance();
      if (nativeFocusRetry) clearTimeout(nativeFocusRetry);
      restoreWindowInput();
    },
    cancel: () => {
      if (nativeFocusRetry) clearTimeout(nativeFocusRetry);
      nativeFocusRetry = undefined;
    },
    blur: () => win.webview.executeJavascript(nativeWindowFocusScript(false)),
  });
  win.on("focus", () => { llog("window focus event"); focusReadiness.focus(); });
  win.on("blur", () => { llog("window blur"); focusReadiness.blur(); });
  const installerReadyPath = process.env.TREETOP_INSTALLER_READY;
  delete process.env.TREETOP_INSTALLER_READY;
  win.webview.on("dom-ready", () => {
    llog(`window WebView DOM ready hwnd=${win.ptr}`);
    focusReadiness.ready();
    if (installerReadyPath) {
      try { writeFileSync(installerReadyPath, JSON.stringify({ pid: process.pid })); llog("installer UI readiness acknowledged"); }
      catch (error) { llog(`installer UI readiness acknowledgement failed: ${error}`); }
    }
  });
  restoreWindowModeOnReady(bounds, {
    onReady: (callback) => win.webview.on("dom-ready", callback),
    maximize: () => win.maximize(),
    setFullScreen: (enabled) => win.setFullScreen(enabled),
  });

  // Icons use this exact SDK window, independent of its page title.
  function refreshWindowAppearance() {
    if (!isWin) return;
    try {
      const handle = win.ptr;
      if (!handle) throw new Error("Native window handle is not ready");

      refreshWindowIcons();
      nativeCaption?.refresh(BigInt(handle));
      llog(`window appearance applied hwnd=${handle}`);
    } catch (error) { llog(`Window appearance failed: ${error}`); }
  }
  if (isWin) {
    try { nativeCaption = createWindowsCaptionStyle(); }
    catch (error) { llog(`Window caption initialization failed: ${error}`); }
    const icoPath = resolve(dirname(process.execPath), "..", "Resources", "app.ico");
    try {
      if (existsSync(icoPath)) nativeIcons = createWindowsWindowIcons(icoPath);
      else llog(`Window icon missing: ${icoPath}`);
    } catch (error) { llog(`Window icon initialization failed: ${error}`); }
    refreshWindowAppearance();
    win.webview.on("dom-ready", () => {
      refreshWindowAppearance();
    });
  }

  llog(`boot complete (total ${Date.now() - LAUNCHER_START}ms)`);

  function captureState(): void {
    windowState = captureWindowState(windowState, win.getFrame(), {
      fullscreen: win.isFullScreen(), maximized: win.isMaximized(), minimized: win.isMinimized(),
    });
    saveBounds(windowState);
  }
  win.on("resize", captureState);
  win.on("move", captureState);
  win.on("resize", refreshWindowIcons);
  win.on("move", refreshWindowIcons);

  // Window lifecycle events. "close" fires when the user clicks X / Alt+F4 /
  // menu Quit — useful to confirm in the log whether a hang is "process
  // died before close" or "close fired but process never exited". The
  // "closed" event arrives after destruction completes.
  try {
    win.on("close", () => {
      focusReadiness.close();
      if (nativeFocusRetry) clearTimeout(nativeFocusRetry);
      nativeFocusRetry = undefined;
      nativeFocus?.close();
      nativeFocus = undefined;
      nativeIcons?.close();
      nativeIcons = undefined;
      nativeCaption?.close();
      nativeCaption = undefined;
      captureState();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      writeWindowState(windowState);
      activeWindow = undefined;
      llog("window closed; bounded background retention started");
      if (!tray.visible) void stopAndQuit();
      else void updateTray();
    });
  } catch {
    /* electrobun's BrowserWindow may not expose all events; ignore. */
  }

}
await openTreetopWindow();
const updateParent = isWin ? updateInstallParent(process.execPath, "ui") : undefined;
if (updateParent) watchForUpdate(updateParent, {
  log: llog,
  prepare: async () => {
    if (quitting) throw new Error("Treetop is already quitting");
    const status = await backgroundRequest("status");
    if (!status.connected) throw new Error("Cannot preserve sessions: broker is not connected");
    await backgroundRequest("lease", { windowId: nativeWindowId, sequence: ++heartbeatSequence });
    llog("update handoff prepared; broker retains sessions under its bounded lease");
  },
  exit: () => {
    llog("update handoff: exiting window/tray host without stopping broker");
    quitting = true;
    activeWindow?.close();
    tray.remove();
    Utils.quit();
  },
});
