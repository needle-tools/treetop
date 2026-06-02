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

/** A throwaway git repo (init + a tracked file + one commit) so it registers
 *  cleanly, the enrich fan-out has a HEAD to describe, and the file browser
 *  has something real to list. */
async function gitRepo(dir: string): Promise<void> {
  await $`git -C ${dir} init -q`.quiet();
  await $`git -C ${dir} config user.email e2e@example.com`.quiet();
  await $`git -C ${dir} config user.name e2e`.quiet();
  await Bun.write(join(dir, "README.md"), "# e2e remote repo\n");
  await $`git -C ${dir} add README.md`.quiet();
  await $`git -C ${dir} commit -q -m init`.quiet();
}

/** Pull the streamed NDJSON repo list from a FULL repos URL (local
 *  `…/api/repos` or proxied `…/api/daemons/<id>/repos`) and return the raw
 *  text + the repos parsed out of the manifest/repo lines (id + path). */
async function fetchRepos(
  reposUrl: string,
): Promise<{ text: string; paths: string[]; repos: Array<{ id: string; path: string }> }> {
  const res = await fetch(reposUrl);
  const text = await res.text();
  const repos: Array<{ id: string; path: string }> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as {
        type?: string;
        repos?: Array<{ id?: string; path?: string }>;
        repo?: { id?: string; path?: string };
      };
      if (obj.type === "manifest" && Array.isArray(obj.repos)) {
        for (const r of obj.repos)
          if (r.id && r.path) repos.push({ id: r.id, path: r.path });
      } else if (obj.repo?.id && obj.repo?.path) {
        repos.push({ id: obj.repo.id, path: obj.repo.path });
      }
    } catch {
      // partial / non-JSON line — ignore
    }
  }
  // De-dupe by id (the manifest lists every repo, then each streams again).
  const byId = new Map(repos.map((r) => [r.id, r]));
  const deduped = [...byId.values()];
  return { text, paths: deduped.map((r) => r.path), repos: deduped };
}

/** Subscribe to a proxied SSE stream, run `trigger` once the subscription is
 *  live, then resolve true if a chunk matching `matcher` arrives before the
 *  deadline. Proves the remote's broadcasts reach the UI through the proxy
 *  (the #15a live-refresh path). */
async function waitForSseEvent(
  streamUrl: string,
  trigger: () => Promise<void>,
  matcher: (buf: string) => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const ac = new AbortController();
  const res = await fetch(streamUrl, {
    signal: ac.signal,
    headers: { Accept: "text/event-stream" },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let found = false;
  try {
    // Let the proxied subscription register on the remote before triggering,
    // so the broadcast can't fire before we're listening.
    await Bun.sleep(400);
    await trigger();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const timeout = new Promise<"timeout">((r) =>
        setTimeout(() => r("timeout"), Math.max(0, deadline - Date.now())),
      );
      const r = await Promise.race([reader.read(), timeout]);
      if (r === "timeout") break;
      const { value, done } = r;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (matcher(buf)) {
        found = true;
        break;
      }
    }
  } finally {
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // already torn down
    }
  }
  return found;
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
  let plantedSessionId = "";
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
    // Give the REMOTE daemon an isolated HOME so its agent-session scan is
    // deterministic (not the dev machine's real ~/.claude). Plant one minimal
    // Claude session there so session discovery has a known entry to find.
    const remoteHome = await mkdtemp(join(tmpdir(), "sg-e2e-remote-home-"));
    tmps.push(remoteWs, localWs, remoteRepo, remoteHome);
    remoteRepoPath = remoteRepo;
    repoBasename = remoteRepo.split(/[\\/]/).pop()!;
    await gitRepo(remoteRepo);

    plantedSessionId = "e2e-session-0001";
    await Bun.write(
      join(remoteHome, ".claude", "projects", "-e2e-proj", `${plantedSessionId}.jsonl`),
      `{"type":"summary","summary":"e2e"}\n` +
        `{"type":"user","cwd":${JSON.stringify(remoteRepo)},"message":{"role":"user","content":"hello from e2e"}}\n`,
    );

    const base = {
      SUPERGIT_BIND: "127.0.0.1",
      SUPERGIT_NO_UI_DIR: "1",
    };
    remote = spawnDaemon({
      ...base,
      SUPERGIT_PORT: String(remotePort),
      SUPERGIT_WORKSPACE: remoteWs,
      // Isolate agent discovery to the planted session (homedir() reads these).
      HOME: remoteHome,
      USERPROFILE: remoteHome,
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

  /* --- adding / removing repos on the remote, through the proxy --- */

  test("POST /api/daemons/<id>/repos adds a folder on the REMOTE daemon", async () => {
    const repo2 = await mkdtemp(join(tmpdir(), "sg-e2e-repo2-"));
    tmps.push(repo2);
    await gitRepo(repo2);
    const base2 = repo2.split(/[\\/]/).pop()!;

    const res = await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/repos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repo2 }),
      },
    );
    expect(res.ok).toBe(true);

    // It now appears on the remote via the proxy…
    const proxied = await fetchRepos(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/repos`,
    );
    expect(proxied.paths.some((p) => p.includes(base2))).toBe(true);
    // …but NOT on the local daemon's own list — it lives on the remote box.
    const localRepos = await fetchRepos(
      `http://127.0.0.1:${localPort}/api/repos`,
    );
    expect(localRepos.text).not.toContain(base2);
  }, 25_000);

  test("DELETE /api/daemons/<id>/repos/<repoId> removes a folder on the REMOTE daemon", async () => {
    const repo3 = await mkdtemp(join(tmpdir(), "sg-e2e-repo3-"));
    tmps.push(repo3);
    await gitRepo(repo3);
    const base3 = repo3.split(/[\\/]/).pop()!;
    const reposUrl = `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/repos`;

    await fetch(reposUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: repo3 }),
    });
    const entry = (await fetchRepos(reposUrl)).repos.find((r) =>
      r.path.includes(base3),
    );
    expect(entry).toBeTruthy();

    const del = await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/repos/${encodeURIComponent(entry!.id)}`,
      { method: "DELETE" },
    );
    expect(del.ok).toBe(true);

    const after = await fetchRepos(reposUrl);
    expect(after.repos.some((r) => r.path.includes(base3))).toBe(false);
  }, 25_000);

  /* --- browsing the remote daemon's filesystem through the proxy --- */

  test("GET /api/daemons/<id>/files browses the REMOTE daemon's filesystem", async () => {
    const res = await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/files?path=${encodeURIComponent(remoteRepoPath)}`,
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      entries?: Array<{ name: string; type: string }>;
    };
    const names = (body.entries ?? []).map((e) => e.name);
    // README.md was committed into the repo on the remote box (gitRepo()).
    expect(names).toContain("README.md");
  }, 20_000);

  // INTENTIONALLY-FAILING SPEC — keep it red until the feature exists.
  //
  // "Open a remote file, edit locally, save, get save/discard feedback on an
  // external change" (the ssh-filesystem behaviour) is NOT yet implemented for
  // the remote-daemon axis: the proxy exposes browse (/api/files) + diff
  // (/api/file-diff) but no file-content read + conflict-aware write-back. That
  // flow lives only in the local→ssh-host subsystem (/api/ssh/open +
  // confirm/dismiss-upload). This test pins the intended contract so building
  // it turns the harness green; until then it FAILS (the opt-in harness is
  // skipped by default, so this never reddens CI). See
  // plans/PLAN-REMOTE-DAEMON.md "Remote file editing (TODO)".
  test("a remote file opens for editing and saves back with external-change detection", async () => {
    const file = join(remoteRepoPath, "README.md");
    const base = `http://127.0.0.1:${localPort}/api/daemons/${daemonId}`;

    // Open: read the remote file's content + a version token (mtime).
    const open = await fetch(`${base}/file?path=${encodeURIComponent(file)}`);
    expect(open.ok).toBe(true);
    const opened = (await open.json()) as { content: string; mtimeMs: number };
    expect(opened.content).toContain("e2e remote repo");

    // Save edited content back, guarded by the version we read so a concurrent
    // external change is detected (→ the UI offers save / discard).
    const save = await fetch(`${base}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: file,
        content: "# edited by e2e\n",
        expectedMtimeMs: opened.mtimeMs,
      }),
    });
    expect(save.ok).toBe(true);

    // The write landed on the remote box.
    const reread = await fetch(`${base}/file?path=${encodeURIComponent(file)}`);
    const after = (await reread.json()) as { content: string };
    expect(after.content).toContain("edited by e2e");
  }, 20_000);

  /* --- notes on the remote daemon, through the proxy --- */

  test("notes can be created and deleted on the REMOTE daemon via the proxy", async () => {
    const notesUrl = `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/notes`;
    const create = await fetch(notesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "e2e remote note", anchors: ["e2e-anchor"] }),
    });
    expect(create.ok).toBe(true);
    const note = (await create.json()) as { id: string };
    expect(note.id).toBeTruthy();

    // Present on the remote (via proxy)…
    const list = (await (await fetch(notesUrl)).json()) as Array<{ id: string }>;
    expect(list.some((n) => n.id === note.id)).toBe(true);
    // …and absent from the local daemon's own notes board.
    const localList = (await (
      await fetch(`http://127.0.0.1:${localPort}/api/notes`)
    ).json()) as Array<{ id: string }>;
    expect(localList.some((n) => n.id === note.id)).toBe(false);

    const del = await fetch(`${notesUrl}/${encodeURIComponent(note.id)}`, {
      method: "DELETE",
    });
    expect(del.ok).toBe(true);

    const after = (await (await fetch(notesUrl)).json()) as Array<{ id: string }>;
    expect(after.some((n) => n.id === note.id)).toBe(false);
  }, 20_000);

  /* --- live update events from the remote, over the proxied SSE stream --- */

  test("a remote-side change is delivered over the proxied SSE stream (#15a)", async () => {
    const got = await waitForSseEvent(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/stream`,
      async () => {
        // Cause a change ON THE REMOTE (a note create broadcasts on its
        // stream). The local UI subscribes to /api/daemons/<id>/stream and
        // must receive it — that's how a remote row live-refreshes.
        await fetch(
          `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/notes`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: "sse trigger", anchors: ["e2e-sse"] }),
          },
        );
      },
      (buf) => buf.includes("note_create"),
      12_000,
    );
    expect(got).toBe(true);
  }, 30_000);

  /* --- discovering agent sessions on the remote, through the proxy --- */

  test("GET /api/daemons/<id>/agents discovers a session on the REMOTE daemon", async () => {
    const res = await fetch(
      `http://127.0.0.1:${localPort}/api/daemons/${daemonId}/agents`,
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Array<{
      sessionId?: string;
      agent?: string;
    }>;
    expect(Array.isArray(body)).toBe(true);
    // The session planted in the remote's isolated HOME is discovered and
    // streamed back through the proxy.
    expect(
      body.some((s) => s.sessionId === plantedSessionId && s.agent === "claude"),
    ).toBe(true);
  }, 20_000);
});
