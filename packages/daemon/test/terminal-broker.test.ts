import { CodexAppServerAdapter } from "../src/codex-app-server";
import { BrokerCodexAdapter } from "../src/broker-codex";
import { Workspace } from "../src/workspace";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTerminalBroker } from "../src/terminal-broker";
import { BrokerBackend } from "../src/terminals/broker-backend";
import { UpdateHandoff } from "../../../src/electrobun/update-handoff";

test("broker survives daemon disconnection and reattaches the same PTY without duplicating its process", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-"));
  const broker = await startTerminalBroker({
    workspace,
    token: "test-secret",
    log: () => {},
  });
  let first: BrokerBackend | undefined;
  let second: BrokerBackend | undefined;
  try {
    first = await BrokerBackend.connect(broker.url, "test-secret");
    const terminal = await first.spawn({
      cmd: [
        "node",
        "-e",
        "console.log('BROKER_READY'); setInterval(()=>{},1000)",
      ],
      cwd: workspace,
      ownerId: "kept-session",
      agent: "codex",
      size: { cols: 80, rows: 24 },
    });
    const originalPid = terminal.pid;
    const handoff = new UpdateHandoff(process.pid,
      () => first!.request("acquire", {windowId:"installer-test",sequence:0}),
      () => first!.gracefulShutdown());
    const request = {id:"installer-test",expiresAt:Date.now()+30_000,pids:[process.pid],phase:"prepare"};
    expect(await handoff.handle(request)).toBe("ready");
    expect(await handoff.handle({...request,phase:"exit"})).toBe("exiting");
    expect(broker.backend.get(terminal.id)?.isAlive()).toBe(true);
    second = await BrokerBackend.connect(broker.url, "test-secret");
    expect(second.list()).toHaveLength(1);
    const attached = second.get(terminal.id)!;
    expect(attached.pid).toBe(originalPid);
    expect(attached.isAlive()).toBe(true);
    const text = await new Promise<string>((resolve) => {
      let output = "";
      attached.subscribe({
        onData: (bytes) => {
          output += new TextDecoder().decode(bytes);
          if (output.includes("BROKER_READY")) resolve(output);
        },
        onExit() {},
      });
    });
    expect(text).toContain("BROKER_READY");
    const unauthorized = await fetch(broker.url + "/status");
    expect(unauthorized.status).toBe(401);
  } finally {
    await first?.shutdown();
    await second?.shutdown();
    await broker.stop();
  }
}, 20_000);

test("a broker crash cannot leave its owned terminal running invisibly", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-crash-"));
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "../src/terminal-broker.ts"),
    ],
    {
      env: {
        ...process.env,
        TREETOP_TERMINAL_BROKER: "0",
        SUPERGIT_WORKSPACE: workspace,
        TREETOP_BROKER_TOKEN: "crash-secret",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    },
  );
  let client: BrokerBackend | undefined;
  let childPid = 0;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    let descriptor: any;
    for (let i = 0; i < 100; i++) {
      try {
        descriptor = JSON.parse(
          await readFile(join(workspace, "terminal-broker.json"), "utf8"),
        );
        break;
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(descriptor).toBeDefined();
    client = await BrokerBackend.connect(descriptor.url, "crash-secret");
    const terminal = await client.spawn({
      cmd: ["node", "-e", "setInterval(()=>{},1000)"],
      cwd: workspace,
      size: { cols: 80, rows: 24 },
    });
    childPid = terminal.pid;
    expect(alive(childPid)).toBe(true);
    await client.shutdown();
    proc.kill("SIGKILL");
    await proc.exited;
    for (let i = 0; i < 100 && alive(childPid); i++) await Bun.sleep(50);
    expect(alive(childPid)).toBe(false);
  } finally {
    await client?.shutdown();
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    if (childPid && alive(childPid)) {
      if (process.platform === "win32")
        await Bun.spawn(["taskkill", "/PID", String(childPid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
      else process.kill(childPid, "SIGKILL");
    }
  }
}, 20_000);

test("restore requires an explicit generation-bound selection and cannot launch twice", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-restore-"));
  await writeFile(
    join(workspace, "background-snapshot.json"),
    JSON.stringify({
      protocol: 1,
      generation: "old",
      savedAt: new Date().toISOString(),
      terminals: [
        {
          id: "old-terminal",
          agent: "shell",
          cmd: ["node", "-e", "setInterval(()=>{},1000)"],
          cwd: workspace,
          size: { cols: 80, rows: 24 },
        },
      ],
      commands: [],
    }),
  );
  const broker = await startTerminalBroker({
    workspace,
    token: "restore-secret",
    log: () => {},
  });
  const client = await BrokerBackend.connect(broker.url, "restore-secret");
  try {
    const status = await client.request("status");
    expect(broker.backend.list()).toHaveLength(0);
    expect(status.restore.candidates[0].selected).toBe(false);
    // Bun 1.3.14 async rejects.toThrow can stall WebSocket IO; await the rejection explicitly.
    const invalid = await client
      .request("restore", { id: "wrong", selected: [] })
      .then(
        () => "unexpected success",
        (error) => error.message,
      );
    expect(invalid).toContain("stale");
    const selection = {
      id: status.restore.id,
      selected: ["terminal:old-terminal"],
    };
    const first = await client.request("restore", selection);
    const second = await client.request("restore", selection);
    expect(first.results[0].ok).toBe(true);
    expect(second).toEqual(first);
    expect((await client.request("status")).restore.id).toBe(status.restore.id);
    await client.request("restoreAck", { id: status.restore.id });
    expect((await client.request("status")).restore).toBeNull();
    expect(broker.backend.list().filter((row) => !row.exitedAt)).toHaveLength(
      1,
    );
    await client.stopAll();
    expect(broker.backend.list().filter((row) => !row.exitedAt)).toHaveLength(
      0,
    );
  } finally {
    await client.shutdown();
    await broker.stop();
  }
}, 20_000);

test("saved internal and background command registrations survive daemon replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-broker-commands-"));
  const workspacePath = join(root, "workspace");
  const workspace = await Workspace.open(workspacePath);
  const repo = await workspace.addRepo(root);
  const links = [];
  for (const runMode of ["internal", "shell"] as const)
    links.push(
      await workspace.addCustomLink(repo.id, {
        kind: "command",
        cmd: 'node -e "setInterval(()=>{},1000)"',
        runMode,
      }),
    );
  const broker = await startTerminalBroker({
    workspace: workspacePath,
    token: "command-secret",
    log: () => {},
  });
  let client = await BrokerBackend.connect(broker.url, "command-secret");
  try {
    for (const link of links)
      await client.projectCommands.control("start", repo.id, link.id);
    const running = client.projectCommands.list();
    expect(running.map((row) => row.runMode)).toEqual(["internal", "shell"]);
    await client.shutdown();
    client = await BrokerBackend.connect(broker.url, "command-secret");
    expect(client.projectCommands.list().map((row) => row.pid)).toEqual(
      running.map((row) => row.pid),
    );
    for (const link of links)
      expect(
        (await client.projectCommands.control("start", repo.id, link.id))
          .status,
      ).toBe("already_running");
    expect(broker.backend.list().filter((row) => !row.exitedAt)).toHaveLength(
      2,
    );
    await client.stopAll();
    expect(client.projectCommands.list()).toEqual([]);
    expect(broker.backend.list().filter((row) => !row.exitedAt)).toEqual([]);
  } finally {
    await client.shutdown();
    await broker.stop();
  }
}, 20_000);

test("native Codex turn ownership and events survive a daemon disconnect", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let end!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    end = resolve;
  });
  let spawns = 0;
  let turnIndex = 0;
  const enqueue = (value: unknown) =>
    controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const adapter = new CodexAppServerAdapter({
    spawn: () => {
      spawns++;
      return {
        pid: 12345,
        exited,
        kill: () => {
          end(0);
        },
        stdout: new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        stdin: {
          write(line: string) {
            const request = JSON.parse(line);
            if (request.method === "initialize")
              enqueue({ id: request.id, result: {} });
            if (request.method === "thread/resume")
              enqueue({
                id: request.id,
                result: { thread: { id: "thread-owned" } },
              });
            if (request.method === "turn/start")
              enqueue({
                id: request.id,
                result: {
                  turn: { id: turnIndex++ ? "turn-next" : "turn-owned" },
                },
              });
          },
        },
      };
    },
  });
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-native-"));
  const broker = await startTerminalBroker({
    workspace,
    token: "native-secret",
    codexAdapter: adapter,
    log: () => {},
  });
  let client = await BrokerBackend.connect(broker.url, "native-secret");
  let proxy = new BrokerCodexAdapter(client);
  try {
    await proxy.startTurn({
      threadId: "thread-owned",
      cwd: workspace,
      text: "test turn",
    });
    expect(proxy.activeTurn("thread-owned")).toBe("turn-owned");
    await proxy.close();
    await client.shutdown();
    expect(adapter.activeTurn("thread-owned")).toBe("turn-owned");
    client = await BrokerBackend.connect(broker.url, "native-secret");
    proxy = new BrokerCodexAdapter(client);
    expect(spawns).toBe(1);
    expect(proxy.activeTurn("thread-owned")).toBe("turn-owned");
    const completed = new Promise<void>((resolve) =>
      proxy.subscribe("thread-owned", (event) => {
        if (event.method === "turn/completed") resolve();
      }),
    );
    enqueue({
      method: "turn/completed",
      params: { threadId: "thread-owned", turn: { id: "turn-owned" } },
    });
    await completed;
    expect(proxy.activeTurn("thread-owned")).toBeUndefined();
    const other = await client.spawn({
      cmd: ["node", "-e", "setInterval(()=>{},1000)"],
      cwd: workspace,
      size: { cols: 80, rows: 24 },
    });
    const next = await proxy.startTurn({
      threadId: "thread-owned",
      cwd: workspace,
      text: "next fixture turn",
    });
    controller.close();
    end(1);
    for (let i = 0; i < 100 && proxy.activeTurn("thread-owned"); i++)
      await Bun.sleep(10);
    expect(proxy.activeTurn("thread-owned")).toBeUndefined();
    await next.completed;
    expect(broker.backend.get(other.id)?.isAlive()).toBe(true);
  } finally {
    await proxy.close();
    await client.shutdown();
    await broker.stop();
  }
}, 20_000);

test("real daemon replacement reconnects to the same broker, terminal and PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-daemon-handoff-"));
  const workspace = join(root, "workspace");
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reserve.port!;
  await reserve.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    SUPERGIT_WORKSPACE: workspace,
    SUPERGIT_PORT: String(port),
    SUPERGIT_BIND: "127.0.0.1",
    TREETOP_TERMINAL_BROKER: "1",
    TREETOP_SIDE_INSTANCE: "1",
    SUPERGIT_FETCH_INTERVAL_MS: "0",
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
  };
  const launch = () =>
    Bun.spawn(
      [process.execPath, "run", join(import.meta.dir, "../src/server.ts")],
      { env, stdin: "ignore", stdout: "ignore", stderr: "inherit" },
    );
  let daemon = launch();
  let brokerClient: BrokerBackend | undefined;
  const healthy = async () => {
    for (let i = 0; i < 150; i++) {
      if (daemon.exitCode !== null)
        throw new Error(`Fixture daemon exited ${daemon.exitCode}`);
      try {
        if (
          (
            await fetch(url + "/api/health", {
              signal: AbortSignal.timeout(300),
            })
          ).ok
        )
          return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Fixture daemon startup timed out");
  };
  try {
    await healthy();
    const spawnResponse = await fetch(url + "/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: ["node", "-e", "setInterval(()=>{},1000)"],
        cwd: root,
        ownerId: "handoff-owner",
        cols: 80,
        rows: 24,
      }),
    });
    expect(spawnResponse.status).toBe(200);
    const terminal = (await spawnResponse.json()) as any;
    const before = (await (
      await fetch(url + "/api/background/status")
    ).json()) as any;
    expect(before.connected).toBe(true);
    daemon.kill("SIGTERM");
    await daemon.exited;
    daemon = launch();
    await healthy();
    const after = (await (
      await fetch(url + "/api/background/status")
    ).json()) as any;
    expect(after.generation).toBe(before.generation);
    const terminals = (await (
      await fetch(url + "/api/terminals")
    ).json()) as any[];
    expect(terminals.filter((row) => !row.exitedAt)).toHaveLength(1);
    expect(terminals[0].id).toBe(terminal.id);
    expect(terminals[0].pid).toBe(terminal.pid);
  } finally {
    // Authenticate directly to this fixture broker even when fixture daemon startup failed.
    try {
      const descriptor = JSON.parse(
        await readFile(join(workspace, "terminal-broker.json"), "utf8"),
      );
      brokerClient = await BrokerBackend.connect(
        descriptor.url,
        descriptor.token,
      );
      await brokerClient.request("shutdown");
    } catch (error) {
      console.warn("Fixture broker cleanup:", String(error));
    }
    await brokerClient?.shutdown();
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }
}, 45_000);

test("another UI cancels an expired cleanup proposal before any terminal is stopped", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-return-"));
  const log: string[] = [];
  const broker = await startTerminalBroker({
    workspace,
    token: "lease-secret",
    graceMs: 150,
    log: (line) => log.push(line),
  });
  const client = await BrokerBackend.connect(broker.url, "lease-secret");
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending: Promise<unknown> = Promise.resolve();
  try {
    const terminal = await client.spawn({
      cmd: ["node", "-e", "setInterval(()=>{},1000)"],
      cwd: workspace,
      size: { cols: 80, rows: 24 },
      ownerId: "returning",
    });
    for (
      let i = 0;
      i < 100 && !log.some((line) => line.includes("cleanup proposed"));
      i++
    )
      await Bun.sleep(20);
    expect(log.some((line) => line.includes("cleanup proposed"))).toBe(true);
    let sequence = 0;
    await client.renew("returning-ui", ++sequence);
    heartbeat = setInterval(() => {
      heartbeatPending = client.renew("returning-ui", ++sequence);
    }, 50);
    await Bun.sleep(1150);
    expect(broker.backend.get(terminal.id)?.isAlive()).toBe(true);
    expect(log.some((line) => line.includes("cleanup cancelled"))).toBe(true);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await heartbeatPending;
    await client.shutdown();
    await broker.stop();
  }
}, 20_000);

test("concurrent owners attach once and releasing one window cannot stop another window's terminal", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-viewers-"));
  const broker = await startTerminalBroker({
    workspace,
    token: "view-secret",
    resourceGraceMs: 80,
    log: () => {},
  });
  const first = await BrokerBackend.connect(broker.url, "view-secret");
  const second = await BrokerBackend.connect(broker.url, "view-secret");
  try {
    const options = {
      cmd: ["node", "-e", "setInterval(()=>{},1000)"],
      cwd: workspace,
      size: { cols: 80, rows: 24 },
      ownerId: "shared-owner",
    };
    const [a, b] = await Promise.all([
      first.spawn(options),
      second.spawn(options),
    ]);
    expect(a.id).toBe(b.id);
    await first.renew("first-window", 1);
    await first.request("viewers", { id: a.id, count: 1 });
    await second.request("viewers", { id: a.id, count: 1 });
    await first.releaseTerminal(a.id);
    await first.request("viewers", { id: a.id, count: 0 });
    await Bun.sleep(200);
    expect(broker.backend.get(a.id)?.isAlive()).toBe(true);
    await second.releaseTerminal(a.id);
    await second.request("viewers", { id: a.id, count: 0 });
    for (let i = 0; i < 100 && broker.backend.get(a.id)?.isAlive(); i++)
      await Bun.sleep(25);
    expect(broker.backend.get(a.id)?.isAlive()).toBe(false);
  } finally {
    await first.shutdown();
    await second.shutdown();
    await broker.stop();
  }
}, 20_000);

test("stopping a saved watcher confirms its child exits, even when it ignores Ctrl+C", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-watcher-exit-"));
  await writeFile(
    join(root, "watcher.mjs"),
    "import{writeFileSync}from'node:fs';writeFileSync('watcher.pid',String(process.pid));process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  );
  const workspacePath = join(root, "workspace");
  const workspace = await Workspace.open(workspacePath);
  const repo = await workspace.addRepo(root);
  const link = await workspace.addCustomLink(repo.id, {
    kind: "command",
    cmd: "node watcher.mjs",
    runMode: "internal",
  });
  const broker = await startTerminalBroker({
    workspace: workspacePath,
    token: "watcher-secret",
    log: () => {},
  });
  const client = await BrokerBackend.connect(broker.url, "watcher-secret");
  let childPid = 0;
  const alive = () => {
    try {
      process.kill(childPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await client.projectCommands.control("start", repo.id, link.id);
    for (let i = 0; i < 100; i++) {
      try {
        childPid = Number(await readFile(join(root, "watcher.pid"), "utf8"));
        if (childPid) break;
      } catch {}
      await Bun.sleep(25);
    }
    expect(childPid).toBeGreaterThan(0);
    const result = await client.projectCommands.control(
      "stop",
      repo.id,
      link.id,
    );
    expect(result.confirmed).toBe(true);
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(25);
    expect(alive()).toBe(false);
  } finally {
    if (childPid && alive()) {
      if (process.platform === "win32")
        await Bun.spawn(["taskkill", "/PID", String(childPid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited;
      else process.kill(childPid, "SIGKILL");
    }
    await client.shutdown();
    await broker.stop();
  }
}, 30_000);

test("one-shot speech cleanup belongs to the broker and survives daemon detachment", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let end!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    end = resolve;
  });
  let stopped = false;
  let spawns = 0;
  const enqueue = (value: unknown) =>
    controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const adapter = new CodexAppServerAdapter({
    spawn: () => (
      spawns++,
      {
        pid: 12346,
        exited,
        kill: () => end(0),
        stdout: new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        stdin: {
          write(line: string) {
            const request = JSON.parse(line);
            if (request.method === "initialize")
              enqueue({ id: request.id, result: {} });
            if (request.method === "thread/start")
              enqueue({
                id: request.id,
                result: { thread: { id: "speech-owned" } },
              });
            if (request.method === "thread/realtime/start") {
              enqueue({ id: request.id, result: {} });
              enqueue({
                method: "thread/realtime/sdp",
                params: { threadId: "speech-owned", sdp: "fixture-answer" },
              });
            }
            if (request.method === "thread/realtime/stop") {
              stopped = true;
              enqueue({ id: request.id, result: {} });
            }
          },
        },
      }
    ),
  });
  const workspace = await mkdtemp(join(tmpdir(), "treetop-broker-speech-"));
  const broker = await startTerminalBroker({
    workspace,
    token: "speech-secret",
    codexAdapter: adapter,
    speechCleanupMs: 50,
    log: () => {},
  });
  const client = await BrokerBackend.connect(broker.url, "speech-secret");
  const proxy = new BrokerCodexAdapter(client);
  try {
    await proxy.startRealtimeVoice({
      cwd: workspace,
      sdp: "fixture-offer",
      speechOnly: true,
    });
    await proxy.close();
    await client.shutdown();
    for (let i = 0; i < 100 && !stopped; i++) await Bun.sleep(10);
    expect(stopped).toBe(true);
    const secondClient = await BrokerBackend.connect(
      broker.url,
      "speech-secret",
    );
    const secondProxy = new BrokerCodexAdapter(secondClient);
    try {
      await secondProxy.startRealtimeVoice({
        cwd: workspace,
        sdp: "second-offer",
        speechOnly: true,
      });
      controller.close();
      end(1);
      await Bun.sleep(100);
      expect(spawns).toBe(1); // An orphaned cleanup timer must never respawn Codex.
    } finally {
      await secondProxy.close();
      await secondClient.shutdown();
    }
  } finally {
    await proxy.close();
    await client.shutdown();
    await broker.stop();
  }
}, 10_000);

test("Stop all waits for an already requested command launch before confirming no processes remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-stop-during-launch-"));
  const workspacePath = join(root, "workspace");
  const workspace = await Workspace.open(workspacePath);
  const repo = await workspace.addRepo(root);
  const link = await workspace.addCustomLink(repo.id, {
    kind: "command",
    cmd: 'node -e "setInterval(()=>{},1000)"',
    runMode: "internal",
  });
  const broker = await startTerminalBroker({
    workspace: workspacePath,
    token: "launch-secret",
    log: () => {},
  });
  const client = await BrokerBackend.connect(broker.url, "launch-secret");
  try {
    const launching = client.projectCommands.control("start", repo.id, link.id);
    await client.stopAll();
    await launching;
    expect(broker.commands.list()).toEqual([]);
    expect(broker.backend.list().filter((record) => !record.exitedAt)).toEqual(
      [],
    );
  } finally {
    await client.shutdown();
    await broker.stop();
  }
}, 20_000);
