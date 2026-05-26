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

  // 3) Belt-and-braces: if anything is still LISTENING on the port
  //    (stuck daemon, orphaned child), force-kill it. Without this we
  //    get EADDRINUSE when /api/shutdown didn't actually clear the
  //    socket in time.
  //
  //    -sTCP:LISTEN is load-bearing: plain `lsof -ti :PORT` also matches
  //    *connections* to the port (e.g. the fetch this script just made
  //    to /api/shutdown), which can include our own PID. We once
  //    SIGKILL'd ourselves that way. We also explicitly exclude our own
  //    PID and our parent's PID as a second line of defence.
  const self = String(process.pid);
  const parent = String(process.ppid);
  let pids: string[] = [];

  if (process.platform === "win32") {
    const result = await $`netstat -ano`.quiet().nothrow();
    const seen = new Set<string>();
    for (const line of result.stdout.toString().split("\n")) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (!m || m[1] !== port) continue;
      const pid = m[2]!;
      if (pid !== self && pid !== parent && pid !== "0") seen.add(pid);
    }
    pids = [...seen];
    if (pids.length > 0) {
      console.log(`supergit: port ${port} still held by ${pids.join(", ")} — killing`);
      for (const pid of pids) {
        await $`taskkill /F /PID ${pid}`.quiet().nothrow();
      }
      await Bun.sleep(300);
    }
  } else {
    const result = await $`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`.quiet().nothrow();
    pids = result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((p) => p && p !== self && p !== parent);
    if (pids.length > 0) {
      console.log(`supergit: port ${port} still held by ${pids.join(", ")} — killing`);
      for (const pid of pids) {
        await $`kill -9 ${pid}`.quiet().nothrow();
      }
      await Bun.sleep(300);
    }
  }
}

if (process.env.SUPERGIT_SKIP_STOP_EXISTING !== "1") {
  await stopExisting();
}

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
