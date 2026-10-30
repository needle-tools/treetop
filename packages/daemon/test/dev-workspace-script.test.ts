import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDevWorkspaceArgs,
  usage,
  seedWorkspaceIfMissing,
  waitForDevChildren,
  devUiNodeOptions,
  createDevDaemonRecovery,
  probeDevDaemon,
  stopDevChild,
} from "../../../dev";

test("dev recovery replaces a real stopped-listening Bun watch subtree", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-dev-watch-recovery-"));
  const entry = join(root, "backend.ts");
  const preservedPids: number[] = [];
  await writeFile(
    entry,
    `const keep=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdin:'ignore',stdout:'ignore',stderr:'ignore'});keep.unref();const server=Bun.serve({hostname:'127.0.0.1',port:Number(Bun.argv[2]??0),fetch(req){if(new URL(req.url).pathname==='/fail')setTimeout(()=>server.stop(true),10);return new Response('ok');}});setInterval(()=>{},1000);console.log(JSON.stringify({pid:process.pid,port:server.port,preservedPid:keep.pid}));`,
  );
  const launch = async (port: number) => {
    const child = Bun.spawn(
      [process.execPath, "--watch", "run", entry, String(port)],
      {
        windowsHide: true,
        detached: process.platform !== "win32",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const reader = child.stdout.getReader();
    const line = await reader.read();
    reader.releaseLock();
    const result = {
      child,
      info: JSON.parse(new TextDecoder().decode(line.value).trim()) as {
        pid: number;
        port: number;
        preservedPid: number;
      },
    };
    preservedPids.push(result.info.preservedPid);
    return result;
  };
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    running = await launch(0);
    const port = running.info.port,
      stalePid = running.info.pid;
    expect(await probeDevDaemon(port)).toBe(true);
    await (await fetch(`http://127.0.0.1:${port}/fail`)).text();
    await Bun.sleep(100);
    expect(await probeDevDaemon(port)).toBe(false);
    let restarts = 0;
    const recovery = createDevDaemonRecovery({
      startupGraceMs: 0,
      probe: () => probeDevDaemon(port),
      report: () => {},
      restart: async () => {
        restarts++;
        await stopDevChild(running!.child);
        running = undefined;
        running = await launch(port);
      },
    });
    await recovery.check();
    await recovery.check();
    await recovery.check();
    expect(restarts).toBe(1);
    expect(await probeDevDaemon(port)).toBe(true);
    expect(() => process.kill(stalePid, 0)).toThrow();
    expect(() => process.kill(preservedPids[0]!, 0)).not.toThrow();
  } finally {
    if (running) await stopDevChild(running.child);
    for (const pid of preservedPids) {
      try {
        process.kill(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    expect(root.startsWith(join(tmpdir(), "treetop-dev-watch-recovery-"))).toBe(
      true,
    );
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("dev recovery tolerates reloads, retries twice, and stops retrying persistent failure", async () => {
  let now = 0,
    reachable = false,
    restarts = 0;
  const states: string[] = [];
  const recovery = createDevDaemonRecovery({
    clock: () => now,
    probe: async () => reachable,
    restart: async () => {
      restarts++;
    },
    report: (state) => states.push(state),
  });
  for (let i = 0; i < 5; i++) await recovery.check();
  expect(restarts).toBe(0);
  now = 20_000;
  await recovery.check();
  await recovery.check();
  expect(restarts).toBe(0);
  await recovery.check();
  expect(restarts).toBe(1);
  now += 20_000;
  await recovery.check();
  await recovery.check();
  await recovery.check();
  expect(restarts).toBe(2);
  now += 20_000;
  for (let i = 0; i < 6; i++) await recovery.check();
  expect(restarts).toBe(2);
  expect(states.at(-1)).toBe("failed");
  reachable = true;
  await recovery.check();
  expect(states.at(-1)).toBe("healthy");
});

test("dev recovery never restarts on a timeout and never overlaps recovery attempts", async () => {
  let now = 20_000,
    restarts = 0;
  let release!: () => void;
  let timeout = true;
  const recovery = createDevDaemonRecovery({
    clock: () => now,
    startupGraceMs: 0,
    probe: async () => {
      if (timeout) throw new Error("timeout");
      return false;
    },
    restart: () => {
      restarts++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    report: () => {},
  });
  for (let i = 0; i < 5; i++) await recovery.check();
  expect(restarts).toBe(0);
  timeout = false;
  await recovery.check();
  await recovery.check();
  const pending = recovery.check();
  await Bun.sleep(0);
  await recovery.check();
  expect(restarts).toBe(1);
  release();
  await pending;
});

test("Vite's Node process accepts larger localhost cookie headers", async () => {
  const child = Bun.spawn(
    ["node", "-p", "require('node:http').maxHeaderSize"],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: devUiNodeOptions("--enable-source-maps"),
      },
      windowsHide: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(Number(output.trim())).toBe(131072);
  expect(devUiNodeOptions("--enable-source-maps")).toContain(
    "--enable-source-maps",
  );
});

test("dev daemon runtime accepts a real 24 KiB cookie header", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--max-http-header-size=131072",
      "--eval",
      `
    const server = Bun.serve({port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok')});
    console.log(server.port);
  `,
    ],
    { windowsHide: true, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const port = Number(new TextDecoder().decode(first.value).trim());
    expect(port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { cookie: "probe=" + "a".repeat(24000) },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    reader.releaseLock();
  } finally {
    child.kill();
    await child.exited;
  }
}, 15000);

function pendingChild() {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  let killed = false;
  return {
    child: {
      exited,
      kill: () => {
        killed = true;
        resolveExit(0);
      },
    },
    exit: resolveExit,
    wasKilled: () => killed,
  };
}

describe("dev workspace arguments", () => {
  test("help points to the Bun workspace command", () => {
    expect(usage()).toContain("bun run dev --");
  });

  test("maps a workspace name to the user's supergit workspace root", () => {
    const opts = parseDevWorkspaceArgs(["--workspace", "perf-scroll"], {});
    expect(opts.name).toBe("perf-scroll");
    expect(opts.workspacePath).toMatch(
      /supergit[/\\]workspaces[/\\]perf-scroll$/,
    );
    expect(opts.readonly).toBe(false);
    expect(opts.daemonPort).toBe(17777);
    expect(opts.uiPort).toBe(17779);
  });

  test("accepts positional name, readonly, and explicit ports", () => {
    const opts = parseDevWorkspaceArgs([
      "w1",
      "--readonly",
      "--port",
      "18877",
      "--ui-port",
      "18879",
    ]);
    expect(opts.name).toBe("w1");
    expect(opts.readonly).toBe(true);
    expect(opts.daemonPort).toBe(18877);
    expect(opts.uiPort).toBe(18879);
  });

  test("rejects path traversal in named workspaces", () => {
    expect(() => parseDevWorkspaceArgs(["--workspace", "../prod"])).toThrow(
      /workspace name/,
    );
  });
});

describe("seedWorkspaceIfMissing", () => {
  test("creates an empty named workspace when no copy source is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "treetop-ws-test-"));
    try {
      const target = join(root, "empty");
      await expect(
        seedWorkspaceIfMissing({ workspacePath: target }),
      ).resolves.toBe("created-empty");
      await expect(
        seedWorkspaceIfMissing({ workspacePath: target }),
      ).resolves.toBe("existing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies persisted data from a source workspace and skips runtime files", async () => {
    const root = await mkdtemp(join(tmpdir(), "treetop-ws-copy-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      await mkdir(join(source, "attachments"), { recursive: true });
      await writeFile(join(source, "repos.json"), '{"repos":[]}');
      const recordedAt = new Date("2026-08-29T15:47:32.000Z");
      await utimes(join(source, "repos.json"), recordedAt, recordedAt);
      await writeFile(join(source, "daemon.log"), "runtime log");
      await writeFile(
        join(source, "notes.json"),
        JSON.stringify({
          path: join(source, "attachments", "paste.txt"),
        }),
      );

      await expect(
        seedWorkspaceIfMissing({ workspacePath: target, copyFrom: source }),
      ).resolves.toBe("copied");

      expect(await readFile(join(target, "repos.json"), "utf-8")).toBe(
        '{"repos":[]}',
      );
      expect((await stat(join(target, "repos.json"))).mtimeMs).toBe(
        recordedAt.getTime(),
      );
      await expect(
        readFile(join(target, "daemon.log"), "utf-8"),
      ).rejects.toThrow();
      const copiedNotes = JSON.parse(
        await readFile(join(target, "notes.json"), "utf-8"),
      ) as { path?: string };
      expect(copiedNotes.path).toBe(join(target, "attachments", "paste.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("dev child lifecycle", () => {
  test("stops Vite when the daemon exits instead of leaving a broken proxy alive", async () => {
    const daemon = pendingChild();
    const ui = pendingChild();
    const waiting = waitForDevChildren(daemon.child, ui.child);

    daemon.exit(1);

    await expect(waiting).rejects.toThrow("daemon exited with code 1");
    expect(ui.wasKilled()).toBe(true);
  });
});
