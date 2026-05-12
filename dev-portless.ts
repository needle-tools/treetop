// Dev variant that exposes the UI at https://supergit-dev.localhost/ via
// the portless reverse proxy (requires the system proxy to be running:
// `sudo bunx portless proxy start --https`).
//
// Architecture:
//   - daemon spawned directly (with --hot) on 7777 — same as `bun dev`.
//   - Vite spawned wrapped in `bunx portless supergit-dev …`. Portless
//     injects PORT into Vite's env; our vite.config.ts already prefers
//     PORT over the 7779 default, so the proxy can route to whatever
//     ephemeral port portless picks.
//
// Ctrl-C kills both.

import { $ } from "bun";

async function killOnPort(port: number): Promise<void> {
  const result = await $`lsof -ti :${port}`.quiet().nothrow();
  const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
  if (pids.length === 0) return;
  console.log(`dev-portless: port ${port} held by ${pids.join(", ")} — killing`);
  for (const pid of pids) {
    await $`kill -9 ${pid}`.quiet().nothrow();
  }
  await new Promise((r) => setTimeout(r, 200));
}

await killOnPort(7777);

// Strip PORT from the daemon's env. A prior `bunx portless` (in this
// or a parent shell) may have leaked PORT=<ephemeral> upward; our
// daemon's port resolver respects PORT as a fallback, which would
// otherwise make the dev daemon try to bind to (e.g.) prod's 7787
// and EADDRINUSE-crash. Dev always wants 7777.
const daemonEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (k === "PORT" || k === "SUPERGIT_PORT") continue;
  daemonEnv[k] = v;
}
// --watch (full process restart on file change), not --hot (in-place
// module reload). --hot leaks timers, FS watchers, and the HTTP server
// across reloads — we measured 50GB RSS after ~1h of editing. --watch
// is a clean restart, so memory stays flat; cost is a manual browser
// reload to reconnect SSE/WebSocket.
// `exec -a "supergit dev"` rewrites argv[0] so `ps` / Activity Monitor's
// command column show "supergit dev …" instead of "bun --watch run
// src/server.ts". Bun's process.title setter doesn't rewrite the
// kernel-visible name on macOS, so we go through bash. Unix-only;
// Windows callers would just see the raw bun command (acceptable).
const daemon = Bun.spawn(
  [
    "bash",
    "-c",
    "exec -a 'supergit dev' bun --watch run src/server.ts",
  ],
  {
    cwd: "packages/daemon",
    env: daemonEnv,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const ui = Bun.spawn(
  ["bunx", "portless", "supergit-dev", "bun", "run", "dev"],
  {
    cwd: "packages/ui",
    stdout: "inherit",
    stderr: "inherit",
  },
);

const cleanup = () => {
  daemon.kill();
  ui.kill();
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Promise.all([daemon.exited, ui.exited]);
