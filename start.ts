// Cross-platform prod launcher. Sets env defaults and execs the daemon.
// Replaces the bash-only "start" script so `bun run start` works on Windows.

import { resolve } from "path";
import { $ } from "bun";

const port = process.env.SUPERGIT_PORT ?? "27787";
const uiDir = process.env.SUPERGIT_UI_DIR ?? resolve("packages/ui/dist");
const url = `http://localhost:${port}`;

async function stopExisting(): Promise<void> {
  // 1) Ask the running daemon to shut down via the same endpoint the
  //    UI's restart button uses. Best-effort — if nothing is listening
  //    or it doesn't answer in 2s, we fall through to the force-kill.
  try {
    const res = await fetch(`${url}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { pid?: number };
      console.log(`supergit: asked existing daemon (pid ${body.pid ?? "?"}) to shut down`);
    }
  } catch {
    // no daemon, or it didn't answer — that's fine
  }

  // 2) Give the daemon 2s to flush + release the port (same delay the
  //    UI restart flow uses before reconnecting).
  await Bun.sleep(2000);

  // 3) Belt-and-braces: if anything is still holding the port (stuck
  //    daemon, orphaned child, TIME_WAIT-but-actually-bound), force-kill
  //    it. Without this we get EADDRINUSE when /api/shutdown didn't
  //    actually clear the socket in time.
  if (process.platform !== "win32") {
    const result = await $`lsof -ti :${port}`.quiet().nothrow();
    const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
    if (pids.length > 0) {
      console.log(`supergit: port ${port} still held by ${pids.join(", ")} — killing`);
      for (const pid of pids) {
        await $`kill -9 ${pid}`.quiet().nothrow();
      }
      // Kernel needs a moment to release the socket after SIGKILL.
      await Bun.sleep(300);
    }
  }
}

await stopExisting();

console.log(`supergit prod: API     → ${url}/api/`);
console.log(`supergit prod: UI      → ${url}`);

const server = Bun.spawn([process.execPath, "run", "packages/daemon/src/server.ts"], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    SUPERGIT_PORT: port,
    SUPERGIT_UI_DIR: uiDir,
    SUPERGIT_PROCESS_TITLE: "supergit prod",
  },
});

process.on("SIGINT", () => { server.kill(); process.exit(0); });
process.on("SIGTERM", () => { server.kill(); process.exit(0); });

await server.exited;
process.exit(server.exitCode ?? 1);
