// Shared "kill whatever's holding the dev ports" helper. Used by
// `dev.ts` (pre-flight before starting) and `stop-dev.ts` (standalone
// shutdown without restart). Crucially, this NEVER touches prod's port
// (27787) — only the daemon's dev port (7777) and Vite (7779).
//
// If you ever bind something *intentionally* on 7777 / 7779 outside of
// supergit dev, expect this to kill it.

import { $ } from "bun";

/** Dev daemon port. The daemon's runtime default is 7777, and dev.ts
 *  passes SUPERGIT_PORT=<this value> explicitly to the spawned daemon
 *  so it can't accidentally bind prod's 27787 if the parent shell
 *  exports SUPERGIT_PORT (which is what kicked off the "dev never
 *  starts" flake).
 *
 *  Override with `SUPERGIT_DEV_PORT=8777 bun dev` (and the matching
 *  `SUPERGIT_DEV_UI_PORT` below for Vite) when you want to run two
 *  dev sessions side-by-side from different worktrees. `stop-dev.ts`
 *  picks up the same env, so killing the right ports only requires
 *  exporting the same vars in whatever shell you run `bun stop-dev`
 *  from. */
export const DEV_DAEMON_PORT = Number(process.env.SUPERGIT_DEV_PORT ?? 7777);
/** Vite dev-server port. Override with `SUPERGIT_DEV_UI_PORT=8779`. */
export const DEV_UI_PORT = Number(process.env.SUPERGIT_DEV_UI_PORT ?? 7779);

export async function killOnPort(port: number): Promise<void> {
  // Try graceful shutdown first — the daemon may be healthy and just
  // needs to be told to stop. This works on all platforms.
  try {
    const res = await fetch(`http://localhost:${port}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { pid?: number };
      console.log(`dev: asked daemon on :${port} (pid ${body.pid ?? "?"}) to shut down`);
      await Bun.sleep(1500);
      // Check if it actually stopped.
      try {
        await fetch(`http://localhost:${port}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        // Still alive — fall through to force-kill below.
      } catch {
        return; // Gone — port is free.
      }
    }
  } catch {
    // Nothing listening, or it didn't respond — fall through.
  }

  // Force-kill: platform-specific.
  if (process.platform === "win32") {
    // netstat + taskkill on Windows.
    const result = await $`netstat -ano -p TCP`.quiet().nothrow();
    const lines = result.stdout.toString().split("\n");
    const self = String(process.pid);
    const pids = new Set<string>();
    for (const line of lines) {
      if (!line.includes("LISTENING")) continue;
      const m = line.match(/:(\d+)\s.*LISTENING\s+(\d+)/);
      if (m && m[1] === String(port) && m[2] !== "0" && m[2] !== self) {
        pids.add(m[2]);
      }
    }
    if (pids.size === 0) return;
    console.log(`dev: port ${port} held by ${[...pids].join(", ")} — killing`);
    for (const pid of pids) {
      await $`taskkill /F /PID ${pid}`.quiet().nothrow();
    }
    await Bun.sleep(300);
  } else {
    // -sTCP:LISTEN is critical: plain `lsof -ti :PORT` also matches
    // *connections* to the port — e.g. the prod daemon's keep-alive
    // connection from a peer health check to localhost:7777. Without
    // this filter we'd SIGKILL prod when restarting dev.
    const self = String(process.pid);
    const parent = String(process.ppid);
    const result = await $`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`.quiet().nothrow();
    const pids = result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((p) => p && p !== self && p !== parent);
    if (pids.length === 0) return;
    console.log(`dev: port ${port} held by ${pids.join(", ")} — killing`);
    for (const pid of pids) {
      await $`kill -9 ${pid}`.quiet().nothrow();
    }
    await Bun.sleep(200);
  }
}

/** Kill anything holding the dev ports. Idempotent. Prod (27787) is
 *  deliberately not included — if it were, switching from `bun start`
 *  to `bun dev` (or running `bun stop-dev` while inspecting prod)
 *  would silently interrupt the running prod dashboard. */
export async function killDevPorts(): Promise<void> {
  await killOnPort(DEV_DAEMON_PORT);
  await killOnPort(DEV_UI_PORT);
}
