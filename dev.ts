// Starts the daemon (watch mode) and UI (Vite dev server) together
// with hot reload. Ctrl-C kills both.
//
// Pre-flight: any stale processes still holding ports 7777 (daemon) or
// 7779 (Vite) from a previous run get killed first. Otherwise --watch
// occasionally leaves an orphan and the next `bun dev` fails with
// EADDRINUSE / "Port 7779 is in use".

import { $ } from "bun";

async function killOnPort(port: number): Promise<void> {
  // lsof exists on macOS and most Linux distros; on Windows this just
  // no-ops which is fine — there's nothing to clean up there anyway.
  const result = await $`lsof -ti :${port}`.quiet().nothrow();
  const pids = result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  if (pids.length === 0) return;
  console.log(`dev: port ${port} held by ${pids.join(", ")} — killing`);
  for (const pid of pids) {
    await $`kill -9 ${pid}`.quiet().nothrow();
  }
  // Give the kernel a moment to release the socket before we bind it again.
  await new Promise((r) => setTimeout(r, 200));
}

await killOnPort(7777);
await killOnPort(7779);

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
  },
);

const ui = Bun.spawn(["bun", "run", "dev"], {
  cwd: "packages/ui",
  stdout: "inherit",
  stderr: "inherit",
});

const cleanup = () => {
  daemon.kill();
  ui.kill();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Promise.all([daemon.exited, ui.exited]);
