/**
 * Electrobun main process — replaces the Swift launcher.
 *
 * 1. Resolves the user's real PATH (same reason as the Swift version:
 *    .app bundles get a minimal system PATH).
 * 2. Checks if git is available.
 * 3. Checks for an existing daemon, or starts the bundled one.
 * 4. Opens a native BrowserWindow pointed at localhost:<port>.
 */

import { BrowserWindow } from "electrobun/bun";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

const PORT = 27787;
const DAEMON_URL = `http://localhost:${PORT}`;

// ── Resolve user's login PATH ────────────────────────────────────────

function resolveLoginPath(): string | null {
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

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  // Find the bundled daemon binary relative to this script.
  // In dev: look in build/supergit-native/
  // In production: look adjacent to process.execPath.
  const candidates = [
    resolve(dirname(process.execPath), "supergit"),
    resolve(dirname(process.execPath), "..", "Resources", "supergit"),
    resolve(process.cwd(), "build", "supergit-native", "supergit"),
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

// ── Main ─────────────────────────────────────────────────────────────

if (!gitAvailable()) {
  // TODO: once Electrobun has dialog support, show a native dialog here.
  // For now, log and exit.
  console.error(
    "git is not installed. Install Xcode Command Line Tools:\n  xcode-select --install",
  );
  process.exit(1);
}

await ensureDaemon();

const win = new BrowserWindow({
  title: "Supergit",
  url: DAEMON_URL,
  width: 1400,
  height: 900,
});
