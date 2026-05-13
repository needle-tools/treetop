// Starts the daemon (watch mode) and UI (Vite dev server) together
// with hot reload. Ctrl-C kills both.
//
// Pre-flight: any stale processes still holding ports 7777 (daemon) or
// 7779 (Vite) from a previous run get killed first. Otherwise --watch
// occasionally leaves an orphan and the next `bun dev` fails with
// EADDRINUSE / "Port 7779 is in use". Prod's :27787 is NEVER touched —
// see `dev-ports.ts` and `stop-dev.ts`.

import {
  DEV_DAEMON_PORT,
  DEV_UI_PORT,
  killDevPorts,
} from "./dev-ports";

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
const daemon = Bun.spawn(
  [
    "bash",
    "-c",
    "exec -a 'supergit dev' bun --watch run src/server.ts",
  ],
  {
    cwd: "packages/daemon",
    stdout: "inherit",
    stderr: "inherit",
    env: daemonEnv,
  },
);

const ui = Bun.spawn(["bun", "run", "dev"], {
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
