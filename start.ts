// Cross-platform prod launcher. Sets env defaults and execs the daemon.
// Replaces the bash-only "start" script so `bun run start` works on Windows.

import { resolve } from "path";

const port = process.env.SUPERGIT_PORT ?? "27787";
const uiDir = process.env.SUPERGIT_UI_DIR ?? resolve("packages/ui/dist");

const url = `http://localhost:${port}`;
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
