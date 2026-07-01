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
    "usage: npm run dev -- [--workspace <name>] [options]",
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
    filter: (src) => shouldCopyTempWorkspaceRelativePath(relative(source, src)),
  });
  await rewriteCopiedWorkspaceRefs(source, opts.workspacePath);
  return "copied";
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
      ? [process.execPath, "--watch", "run", "src/server.ts"]
      : ["bash", "-c", "exec -a 'supergit dev' bun --watch run src/server.ts"];
  const daemon = Bun.spawn(daemonCmd, {
    cwd: "packages/daemon",
    stdout: "inherit",
    stderr: "inherit",
    env: daemonEnv,
  });

  const ui = Bun.spawn([process.execPath, "run", "dev"], {
    cwd: "packages/ui",
    stdout: "inherit",
    stderr: "inherit",
    env: uiEnv,
  });

  const cleanup = () => {
    daemon.kill();
    ui.kill();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await Promise.all([daemon.exited, ui.exited]);
}

if (import.meta.main) {
  runDev().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
