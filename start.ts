// Cross-platform prod launcher. Sets env defaults and execs the daemon.
// Replaces the bash-only "start" script so `bun run start` works on Windows.

import { resolve } from "path";

const port = process.env.SUPERGIT_PORT ?? "27787";
const uiDir = process.env.SUPERGIT_UI_DIR ?? resolve("packages/ui/dist");
const url = `http://localhost:${port}`;

async function stopExisting(): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { pid?: number };
    const pid = body.pid;
    console.log(`supergit: asked existing daemon (pid ${pid}) to shut down`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(300) });
        await Bun.sleep(200);
      } catch {
        console.log("supergit: old daemon stopped");
        return true;
      }
    }
    console.log("supergit: old daemon did not stop within 5s, proceeding anyway");
    return true;
  } catch {
    return false;
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
