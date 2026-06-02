/**
 * ============================================================================
 *  TWO-DAEMON END-TO-END HARNESS — OPT-IN, NEVER RUNS IN THE DEFAULT SUITE
 * ============================================================================
 *
 * This is the runtime proof the rest of the remote-daemon work could only
 * fake: it boots TWO REAL daemon processes on localhost and drives the local
 * one's reverse proxy (`/api/daemons/<id>/*`) against the remote one — the
 * exact chain (register → tunnel → HTTP/WS forward → real remote) where the
 * live-deployment bugs lived (the WS sync-upgrade hang #12, the proxy error
 * masking, the readiness race). Unit tests stub the OS boundary; this doesn't.
 *
 * WHY IT'S GUARDED: it spawns processes and binds ports, which is slow,
 * port-flaky, and exactly what an agent must not trigger by accident on every
 * `bun test`. So the whole suite is `describe.skip` unless the env guard is
 * set. Run it deliberately:
 *
 *     bun run test:two-daemon
 *
 * The ssh hop is the one thing we still fake — both daemons are on localhost,
 * so there's no real network to tunnel. The local daemon runs with
 * SUPERGIT_TUNNEL_DIRECT=1, which makes its TunnelManager proxy straight at
 * the remote's 127.0.0.1:<port> instead of spawning `ssh -L` (see
 * tunnel-manager.ts `direct`). Tier 3 (a real `ssh -L` into a container) is
 * the documented next step in plans/PLAN-REMOTE-DAEMON.md.
 *
 * SAFETY: both daemons bind loopback only and use throwaway temp workspaces;
 * the chosen ports are asserted to differ from the prod listener (27787)
 * before anything spawns; every process is killed and every temp dir removed
 * in afterAll, even if setup throws.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { Subprocess } from "bun";

const ENABLED = process.env.SUPERGIT_TWO_DAEMON_TESTS === "1";
/** Production daemon listener — must never be touched by the harness. */
const PROD_PORT = 27787;
const SERVER = join(import.meta.dir, "../src/server.ts");
const MARKER = "READY_42_E2E";

const suite = ENABLED ? describe : describe.skip;

/* ----------------------------- helpers ---------------------------------- */

/** Ask the OS for a free loopback TCP port (bind :0, read, release). */
async function freePort(): Promise<number> {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  const p = srv.port;
  srv.stop(true);
  return p;
}

/** Spawn a daemon child running the real server.ts with the given overrides
 *  layered on the current env. stdout is dropped (chatty boot logs); stderr
 *  is inherited so a crash surfaces in the test output. */
function spawnDaemon(env: Record<string, string>): Subprocess {
  return Bun.spawn([process.execPath, SERVER], {
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function killDaemon(proc: Subprocess | null): Promise<void> {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    // already gone
  }
  await proc.exited.catch(() => {});
}

/** Poll GET /api/health until it answers 200 (the daemon finished booting)
 *  or the deadline passes. */
async function waitForHealth(port: number, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        await r.text();
        return;
      }
      await r.text().catch(() => {});
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`daemon on :${port} never became healthy`);
    }
    await Bun.sleep(200);
  }
}

/** A throwaway git repo (init + one commit) so it registers cleanly and the
 *  enrich fan-out has a HEAD to describe. */
async function gitRepo(dir: string): Promise<void> {
  await $`git -C ${dir} init -q`.quiet();
  await $`git -C ${dir} config user.email e2e@example.com`.quiet();
  await $`git -C ${dir} config user.name e2e`.quiet();
  await $`git -C ${dir} commit -q --allow-empty -m init`.quiet();
}

/** Pull the streamed NDJSON repo list from a FULL repos URL (local
 *  `…/api/repos` or proxied `…/api/daemons/<id>/repos`) and return the raw
 *  text + the repo paths parsed out of the manifest/repo lines. */
async function fetchRepos(
  reposUrl: string,
): Promise<{ text: string; paths: string[] }> {
  const res = await fetch(reposUrl);
  const text = await res.text();
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as {
        type?: string;
        repos?: Array<{ path?: string }>;
        repo?: { path?: string };
      };
      if (obj.type === "manifest" && Array.isArray(obj.repos)) {
        for (const r of obj.repos) if (r.path) paths.push(r.path);
      } else if (obj.repo?.path) {
        paths.push(obj.repo.path);
      }
    } catch {
      // partial / non-JSON line — ignore
    }
  }
  return { text, paths };
}

/* ------------------------------ harness --------------------------------- */

suite("two-daemon e2e — local daemon reverse-proxies a real remote daemon", () => {
  let remote: Subprocess | null = null;
  let local: Subprocess | null = null;
  let remotePort = 0;
  let localPort = 0;
  let daemonId = "";
  let repoBasename = "";
  let remoteRepoPath = "";
  const tmps: string[] = [];

  beforeAll(async () => {
    [remotePort, localPort] = [await freePort(), await freePort()];
    // Hard guard: never collide with the prod listener.
    expect(remotePort).not.toBe(PROD_PORT);
    expect(localPort).not.toBe(PROD_PORT);
    expect(remotePort).not.toBe(localPort);

    const remoteWs = await mkdtemp(join(tmpdir(), "sg-e2e-remote-ws-"));
    const localWs = await mkdtemp(join(tmpdir(), "sg-e2e-local-ws-"));
    const remoteRepo = await mkdtemp(join(tmpdir(), "sg-e2e-repo-"));
    tmps.push(remoteWs, localWs, remoteRepo);
    remoteRepoPath = remoteRepo;
    repoBasename = remoteRepo.split(/[\\/]/).pop()!;
    await gitRepo(remoteRepo);

    const base = {
      SUPERGIT_BIND: "127.0.0.1",
      SUPERGIT_NO_UI_DIR: "1",
    };
    remote = spawnDaemon({
      ...base,
      SUPERGIT_PORT: String(remotePort),
      SUPERGIT_WORKSPACE: remoteWs,
    });
    local = spawnDaemon({
      ...base,
      SUPERGIT_PORT: String(localPort),
      SUPERGIT_WORKSPACE: localWs,
      // The seam: proxy straight at the remote's loopback port, no ssh.
      SUPERGIT_TUNNEL_DIRECT: "1",
    });

    await Promise.all([waitForHealth(remotePort), waitForHealth(localPort)]);

    // Register the repo on the REMOTE daemon (its own filesystem).
    const addRepo = await fetch(`http://127.0.0.1:${remotePort}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: remoteRepo }),
    });
    expect(addRepo.ok).toBe(true);

    // Register the REMOTE daemon on the LOCAL daemon → it appears as a row.
    const addDaemon = await fetch(`http://127.0.0.1:${localPort}/api/daemons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "127.0.0.1",
        port: remotePort,
        label: "e2e-remote",
      }),
    });
    expect(addDaemon.ok).toBe(true);
    daemonId = ((await addDaemon.json()) as { id: string }).id;
    expect(daemonId).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    await killDaemon(local);
    await killDaemon(remote);
    for (const d of tmps) await rm(d, { recursive: true, force: true }).catch(() => {});
  });

  test("the remote repo is NOT in the local daemon's own repo list", async () => {
    // Proves the next test's hit really came over the proxy, not from the
    // local daemon happening to know the repo.
    const localRepos = await fetchRepos(
      `http://127.0.0.1:${localPort}/api/repos`,
    );
    expect(localRepos.text).not.toContain(repoBasename);
  });

  test("GET /api/daemons/<id>/health proxies through to the REMOTE daemon", async () => {
    const res = await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/health`,
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status?: string; port?: number };
    expect(body.status).toBe("ok");
    // The remote reports ITS port — proof the response came from the remote
    // daemon, not the local one (which would report localPort).
    expect(body.port).toBe(remotePort);
  }, 20_000);

  test("GET /api/daemons/<id>/repos streams the remote's repo through the proxy", async () => {
    const proxied = await fetchRepos(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/repos`,
    );
    // The repo registered on the remote shows up via the proxy (NDJSON
    // streaming passthrough), and carries the remote box's path.
    expect(proxied.text).toContain(repoBasename);
    expect(proxied.paths.some((p) => p.includes(repoBasename))).toBe(true);
  }, 20_000);

  test("a terminal WS round-trips I/O to a PTY on the REMOTE daemon", async () => {
    // Spawn a shell PTY on the remote (cwd = the remote repo), via the proxy.
    const isWin = process.platform === "win32";
    const shellCmd = isWin ? ["cmd.exe"] : ["/bin/sh"];

    const spawnRes = await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/terminals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: shellCmd,
          cwd: remoteRepoPath,
          cols: 80,
          rows: 24,
        }),
      },
    );
    expect(spawnRes.ok).toBe(true);
    const { id: termId } = (await spawnRes.json()) as { id: string };
    expect(termId).toBeTruthy();

    const wsUrl = `ws://127.0.0.1:${localPort}/api/daemons/${daemonId}/terminals/${encodeURIComponent(termId)}/io`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    const sawMarker = await new Promise<boolean>((resolve) => {
      let acc = "";
      const timer = setTimeout(() => resolve(false), 12_000);
      const decoder = new TextDecoder();
      ws.onopen = () => {
        // Type a command into the remote PTY. Its echo + output both carry
        // the marker, which must travel back over the proxied WS — exercising
        // both directions of the bridge AND the sync-upgrade path (#12).
        const typed = isWin ? `echo ${MARKER}\r\n` : `echo ${MARKER}\n`;
        ws.send(new TextEncoder().encode(typed));
      };
      ws.onmessage = (ev) => {
        // Control frames (state/exit) arrive as JSON strings; PTY output as
        // binary. We only care about the binary output stream.
        if (typeof ev.data === "string") return;
        acc += decoder.decode(new Uint8Array(ev.data as ArrayBuffer));
        if (acc.includes(MARKER)) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      ws.onerror = () => {};
    });

    try {
      ws.close();
    } catch {
      // ignore
    }
    // Tear down the remote PTY.
    await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/terminals/${encodeURIComponent(termId)}`,
      { method: "DELETE" },
    ).catch(() => {});

    expect(sawMarker).toBe(true);
  }, 30_000);
});
