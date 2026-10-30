// Starts the daemon (watch mode) and UI (Vite dev server) together
// with hot reload. Ctrl-C kills both.
//
// Pre-flight: any stale processes still holding ports 7777 (daemon) or
// 7779 (Vite) from a previous run get killed first. Otherwise --watch
// occasionally leaves an orphan and the next `bun dev` fails with
// EADDRINUSE / "Port 7779 is in use". Prod's :27787 is NEVER touched —
// see `dev-ports.ts` and `stop-dev.ts`.

import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  rewriteTempWorkspaceAttachmentRefs,
  shouldCopyTempWorkspaceRelativePath,
} from "./packages/daemon/src/server-helpers";

export interface DevWorkspaceOptions {
  name: string;
  workspacePath: string;
  copyFrom?: string;
  readonly: boolean;
  daemonPort: number;
  uiPort: number;
}

/** Localhost cookies are shared across ports and can exceed Node's 16 KiB default. */
export function devUiNodeOptions(existing = ""): string {
  return `${existing} --max-http-header-size=131072`.trim();
}

function defaultWorkspaceRoot(): string {
  return join(homedir(), "supergit", "workspaces");
}

function defaultWorkspacePath(name: string): string {
  return join(defaultWorkspaceRoot(), name);
}

function defaultMainWorkspacePath(): string {
  return join(defaultWorkspaceRoot(), "default");
}

function assertSafeWorkspaceName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(
      `workspace name must contain only letters, digits, dot, dash, or underscore: ${name}`,
    );
  }
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function numberFlag(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`${flag} must be a TCP port number`);
  }
  return n;
}

export function parseDevWorkspaceArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): DevWorkspaceOptions {
  let workspace: string | undefined;
  let workspacePath: string | undefined;
  let copyFrom: string | undefined;
  let readonly = false;
  let daemonPort = Number(env.SUPERGIT_DEV_PORT ?? 17777);
  let uiPort = Number(env.SUPERGIT_DEV_UI_PORT ?? 17779);
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--workspace" || arg === "-w") {
      workspace = readValue(argv, i, arg);
      i++;
    } else if (arg === "--path") {
      workspacePath = resolve(readValue(argv, i, arg));
      i++;
    } else if (arg === "--copy-from-main") {
      copyFrom = defaultMainWorkspacePath();
    } else if (arg === "--copy-from") {
      copyFrom = resolve(readValue(argv, i, arg));
      i++;
    } else if (arg === "--readonly" || arg === "--read-only") {
      readonly = true;
    } else if (arg === "--port") {
      daemonPort = numberFlag(readValue(argv, i, arg), arg);
      i++;
    } else if (arg === "--ui-port") {
      uiPort = numberFlag(readValue(argv, i, arg), arg);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!workspace && positional.length > 0) workspace = positional[0];
  if (!workspace && !workspacePath) throw new Error(usage());
  if (workspace && workspacePath) {
    throw new Error("use either --workspace or --path, not both");
  }

  if (workspacePath) {
    const name = workspacePath.split(/[\\/]/).filter(Boolean).at(-1);
    return {
      name: name || "workspace",
      workspacePath,
      copyFrom,
      readonly,
      daemonPort,
      uiPort,
    };
  }

  const name = workspace!;
  assertSafeWorkspaceName(name);
  return {
    name,
    workspacePath: defaultWorkspacePath(name),
    copyFrom,
    readonly,
    daemonPort,
    uiPort,
  };
}

export function usage(): string {
  return [
    "usage: bun run dev -- [--workspace <name>] [options]",
    "",
    "Options:",
    "  --workspace, -w <name>   Use ~/supergit/workspaces/<name> (created if missing)",
    "  --path <dir>             Use an explicit workspace directory",
    "  --copy-from-main         Seed a missing workspace from ~/supergit/workspaces/default",
    "  --copy-from <dir>        Seed a missing workspace from a specific workspace",
    "  --readonly               Block workspace/repo mutations but keep terminal runtime usable",
    "  --port <port>            Daemon port for workspace mode (default 17777)",
    "  --ui-port <port>         Vite port for workspace mode (default 17779)",
  ].join("\n");
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function rewriteCopiedWorkspaceRefs(
  source: string,
  target: string,
): Promise<void> {
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "attachments") await visit(path);
          return;
        }
        if (!entry.isFile() || !/\.(json|jsonl|md)$/.test(entry.name)) return;
        const raw = await readFile(path, "utf-8");
        const next = rewriteTempWorkspaceAttachmentRefs(raw, source, target);
        if (next !== raw) await writeFile(path, next);
      }),
    );
  };
  await visit(target);
}

export async function seedWorkspaceIfMissing(opts: {
  workspacePath: string;
  copyFrom?: string;
}): Promise<"created-empty" | "copied" | "existing"> {
  if (await pathIsDirectory(opts.workspacePath)) return "existing";
  if (!opts.copyFrom) {
    await mkdir(opts.workspacePath, { recursive: true });
    return "created-empty";
  }
  const source = opts.copyFrom;
  if (!(await pathIsDirectory(source))) {
    throw new Error(`copy source must be an existing directory: ${source}`);
  }
  await mkdir(dirname(opts.workspacePath), { recursive: true });
  await cp(source, opts.workspacePath, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => shouldCopyTempWorkspaceRelativePath(relative(source, src)),
  });
  await rewriteCopiedWorkspaceRefs(source, opts.workspacePath);
  return "copied";
}

export interface DevChildProcess {
  exited: Promise<number>;
  kill(): void;
}

/** Only a refused TCP connection permits recovery. A slow API or timeout is
 * never a reason to stop a daemon that may still host live dev terminals. */
export function probeDevDaemon(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Dev daemon probe timed out"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

export function createDevDaemonRecovery({
  probe,
  restart,
  report,
  clock = Date.now,
  startupGraceMs = 15_000,
}: {
  probe: () => Promise<boolean>;
  restart: () => Promise<void>;
  report: (state: "recovering" | "failed" | "healthy") => void;
  clock?: () => number;
  startupGraceMs?: number;
}) {
  let failures = 0,
    attempts = 0,
    checking = false;
  let graceUntil = clock() + startupGraceMs;
  let state = "starting",
    healthySince: number | undefined;
  const publish = (next: "recovering" | "failed" | "healthy") => {
    if (state !== next) {
      state = next;
      report(next);
    }
  };
  return {
    async check() {
      if (checking) return;
      checking = true;
      try {
        let reachable: boolean;
        try {
          reachable = await probe();
        } catch {
          failures = 0;
          return;
        }
        if (reachable) {
          failures = 0;
          healthySince ??= clock();
          if (clock() - healthySince >= 60_000) attempts = 0;
          publish("healthy");
          return;
        }
        healthySince = undefined;
        if (clock() < graceUntil || ++failures < 3) return;
        if (attempts >= 2) {
          publish("failed");
          return;
        }
        attempts++;
        failures = 0;
        publish("recovering");
        try {
          await restart();
        } catch (error) {
          console.error("dev: backend recovery failed", error);
        } finally {
          graceUntil = clock() + startupGraceMs;
        }
      } finally {
        checking = false;
      }
    },
  };
}

/** Watch recovery must leave detached brokers/helpers outside its kill set. */
export async function stopDevChild(
  child: Bun.Subprocess,
  watcher = true,
): Promise<void> {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    const command = watcher
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
      $ErrorActionPreference='Stop'
      $watchRuntimes=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}' | Where-Object { $_.CommandLine -match '\\s--watch(?:\\s|$)' })
      Stop-Process -Id ${child.pid} -Force -ErrorAction SilentlyContinue
      foreach($runtime in $watchRuntimes) {
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$runtime.ProcessId)
        if($current -and $current.ParentProcessId -eq ${child.pid} -and $current.CreationDate -eq $runtime.CreationDate) {
          Stop-Process -Id $runtime.ProcessId -Force -ErrorAction SilentlyContinue
        }
      }
    `,
        ]
      : ["taskkill", "/PID", String(child.pid), "/T", "/F"];
    const stop = Bun.spawn(command, {
      windowsHide: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await stop.exited;
    if (code !== 0 && child.exitCode === null)
      throw new Error(`Could not stop owned dev process ${child.pid}`);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await child.exited;
}

export async function waitForDevChildren(
  daemon: DevChildProcess,
  ui: DevChildProcess,
): Promise<never> {
  const first = await Promise.race([
    daemon.exited.then((code) => ({ name: "daemon" as const, code })),
    ui.exited.then((code) => ({ name: "UI" as const, code })),
  ]);
  const sibling = first.name === "daemon" ? ui : daemon;
  sibling.kill();
  await sibling.exited.catch(() => undefined);
  throw new Error(`${first.name} exited with code ${first.code}`);
}

function argsRequestWorkspace(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--workspace" ||
      arg === "-w" ||
      arg === "--path" ||
      arg === "--copy-from-main" ||
      arg === "--copy-from" ||
      arg === "--readonly" ||
      arg === "--read-only" ||
      arg === "--help" ||
      arg === "-h" ||
      (!arg.startsWith("-") && !/^\d+$/.test(arg)),
  );
}

async function prepareDevEnvironment(argv: string[]): Promise<void> {
  if (!argsRequestWorkspace(argv)) return;

  const opts = parseDevWorkspaceArgs(argv);
  const seed = await seedWorkspaceIfMissing({
    workspacePath: opts.workspacePath,
    copyFrom: opts.copyFrom,
  });

  process.env.SUPERGIT_WORKSPACE = opts.workspacePath;
  process.env.TREETOP_WORKSPACE_LABEL = opts.name;
  process.env.TREETOP_SIDE_INSTANCE = "1";
  process.env.SUPERGIT_DEV_PORT = String(opts.daemonPort);
  process.env.SUPERGIT_DEV_UI_PORT = String(opts.uiPort);
  process.env.SUPERGIT_BIND = process.env.SUPERGIT_BIND ?? "127.0.0.1";
  if (opts.readonly) process.env.TREETOP_READONLY = "1";

  console.log(`dev: workspace ${opts.name} (${seed}) -> ${opts.workspacePath}`);
  console.log(`dev: UI http://localhost:${opts.uiPort}`);
}

export async function runDev(
  argv: string[] = Bun.argv.slice(2),
): Promise<void> {
  await prepareDevEnvironment(argv);
  const { DEV_DAEMON_PORT, DEV_UI_PORT, killDevPorts } =
    await import("./dev-ports");

  await killDevPorts();

  // Build the daemon child's environment explicitly so dev mode can't be
  // poisoned by parent-shell env or repo artifacts:
  //   - SUPERGIT_PORT pinned to the resolved dev-daemon port (default
  //     7777, override via SUPERGIT_DEV_PORT). Without this, an exported
  //     SUPERGIT_PORT=27787 (the prod port the user runs detached) would
  //     leak into the spawned daemon and dev would silently collide with
  //     prod, EADDRINUSE on prod's port, dev never reaches Vite.
  //   - SUPERGIT_NO_UI_DIR=1 disables the daemon's auto-detection of a
  //     sibling `packages/ui/dist`. With dist around (left over from a
  //     previous `bun run start`), the daemon would otherwise flip into
  //     "serving UI from dist" mode and clash with Vite's HMR copy on
  //     :7779. Always force pure dev posture here.
  //   - SUPERGIT_PROCESS_TITLE so `ps` shows "supergit dev" regardless
  //     of the dist-detection flag.
  const daemonEnv = {
    ...process.env,
    SUPERGIT_PORT: String(DEV_DAEMON_PORT),
    SUPERGIT_NO_UI_DIR: "1",
    SUPERGIT_PROCESS_TITLE: "supergit dev",
  };

  // Vite child env: PORT controls the dev server (default 7779, override
  // via SUPERGIT_DEV_UI_PORT). SUPERGIT_PORT is forwarded so vite.config's
  // proxy can target the same daemon port we picked above — without it,
  // Vite would default the proxy to localhost:7777 even when the daemon
  // is actually on a different port.
  const uiEnv = {
    ...process.env,
    NODE_OPTIONS: devUiNodeOptions(process.env.NODE_OPTIONS),
    PORT: String(DEV_UI_PORT),
    SUPERGIT_PORT: String(DEV_DAEMON_PORT),
  };

  // --watch (full process restart on file change), not --hot (in-place
  // module reload). --hot leaks timers, FS watchers, and the HTTP server
  // across reloads — we measured 50GB RSS after ~1h of editing. --watch
  // is a clean restart, so memory stays flat; cost is a manual browser
  // reload to reconnect SSE/WebSocket.
  // argv[0] rewrite so `ps` shows "supergit dev" instead of
  // "bun --watch run src/server.ts" (Bun's process.title doesn't
  // propagate to the kernel on macOS, so we use `exec -a` instead).
  // On Windows bash isn't available, so skip the exec -a wrapper.
  const daemonCmd =
    process.platform === "win32"
      ? [
          process.execPath,
          "--max-http-header-size=131072",
          "--watch",
          "run",
          "src/server.ts",
        ]
      : [
          "bash",
          "-c",
          "exec -a 'supergit dev' bun --max-http-header-size=131072 --watch run src/server.ts",
        ];
  const spawnDaemon = () =>
    Bun.spawn(daemonCmd, {
      cwd: "packages/daemon",
      stdout: "inherit",
      stderr: "inherit",
      env: daemonEnv,
      detached: process.platform !== "win32",
    });
  let daemon = spawnDaemon();

  const ui = Bun.spawn([process.execPath, "run", "dev"], {
    cwd: "packages/ui",
    stdout: "inherit",
    stderr: "inherit",
    env: uiEnv,
    detached: process.platform !== "win32",
  });

  let stopping = false;
  const devBind = process.env.SUPERGIT_BIND ?? "0.0.0.0";
  const probeHost =
    devBind === "0.0.0.0" ? "127.0.0.1" : devBind === "::" ? "::1" : devBind;
  const recovery = createDevDaemonRecovery({
    probe: () => probeDevDaemon(DEV_DAEMON_PORT, probeHost),
    restart: async () => {
      await stopDevChild(daemon);
      if (!stopping) daemon = spawnDaemon();
    },
    report: (state) =>
      console.log(
        state === "recovering"
          ? "dev: backend refused connections repeatedly; restarting the owned dev backend"
          : state === "failed"
            ? "dev: backend recovery failed twice. Check the startup error above and run bun dev again."
            : "dev: backend is reachable",
      ),
  });
  const monitor = setInterval(() => {
    if (!stopping) void recovery.check().catch(console.error);
  }, 2000);
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    await Promise.all([stopDevChild(daemon), stopDevChild(ui, false)]);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    const code = await ui.exited;
    throw new Error(`UI exited with code ${code}`);
  } finally {
    stopping = true;
    clearInterval(monitor);
    await stopDevChild(daemon);
  }
}

if (import.meta.main) {
  runDev().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
