import { closeSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PREVIEW_PORT = 17879;
const DEFAULT_DEV_PORT = 17880;

export function replayLabPagePath(uiRoot = resolve("packages/ui")): string {
  return resolve(uiRoot, "dist-replay-lab/replay-lab.html");
}

function viteBinary(platform: NodeJS.Platform): string {
  return resolve(
    "node_modules/.bin",
    platform === "win32" ? "vite.cmd" : "vite",
  );
}

function serverArgs(port: number): string[] {
  return ["--host", "127.0.0.1", "--port", String(port), "--strictPort"];
}

export function replayLabPreviewCommand(
  platform: NodeJS.Platform,
  _uiRoot: string,
  port: number,
): string[] {
  return [
    viteBinary(platform),
    "preview",
    "--mode",
    "replay-lab-static",
    "--outDir",
    "dist-replay-lab",
    ...serverArgs(port),
  ];
}

export function replayLabDevCommand(
  platform: NodeJS.Platform,
  _uiRoot: string,
  port: number,
): string[] {
  return [
    viteBinary(platform),
    "--mode",
    "replay-lab-static",
    ...serverArgs(port),
  ];
}

export function replayLabUrl(port = DEFAULT_PREVIEW_PORT): string {
  return `http://127.0.0.1:${port}/replay-lab.html`;
}

async function waitUntilReady(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The detached Vite process is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Replay Lab did not start at ${url}`);
}

function openBrowserCommand(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd.exe", "/c", "start", "", url];
  return ["xdg-open", url];
}

if (import.meta.main) {
  const dev = process.env.TREETOP_REPLAY_LAB_DEV === "1";
  const uiRoot = resolve("packages/ui");
  const port = Number(
    process.env.TREETOP_REPLAY_LAB_PORT ??
      (dev ? DEFAULT_DEV_PORT : DEFAULT_PREVIEW_PORT),
  );
  const url = replayLabUrl(port);

  if (!dev && !existsSync(replayLabPagePath(uiRoot))) {
    throw new Error(
      "Replay Lab static build is missing. Run npm run build:replay-lab first.",
    );
  }

  let alreadyRunning = false;
  try {
    alreadyRunning = (await fetch(url)).ok;
  } catch {
    // Expected when launching the server for the first time.
  }

  if (!alreadyRunning) {
    const logPath = dev
      ? "/tmp/treetop-replay-lab-dev.log"
      : "/tmp/treetop-replay-lab.log";
    const logFd = openSync(logPath, "a");
    const command = dev
      ? replayLabDevCommand(process.platform, uiRoot, port)
      : replayLabPreviewCommand(process.platform, uiRoot, port);
    const child = Bun.spawn(command, {
      cwd: uiRoot,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
    child.unref();
    closeSync(logFd);
    await waitUntilReady(url);
  }

  const browser = Bun.spawn(openBrowserCommand(process.platform, url), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await browser.exited;
  console.log(`treetop: opened ${dev ? "dev" : "static"} Replay Lab at ${url}`);
}
