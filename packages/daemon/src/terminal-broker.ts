import { withTreetopMcp } from "./mcp";
import { CodexAppServerAdapter } from "./codex-app-server";
import { ClaudeCliAdapter } from "./claude-cli-adapter";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { NodePtyBackend } from "./terminals/node-pty-backend";
import { restoreCandidates, resumeTerminalCommand } from "./background-restore";
import { BackgroundLease } from "./background-lease";
import { ProjectCommands, createCommandLauncher } from "./project-commands";
import { Workspace } from "./workspace";
import { scheduleReconnectCleanup } from "./orphan-cleanup";

import {
  BROKER_PROTOCOL,
  BROKER_DESCRIPTOR,
  BROKER_SNAPSHOT,
} from "./background-protocol";

/** Replay one terminal at a time without overflowing the live-stream limit. */
export async function replayBrokerTerminals(
  ws: { readyState: number; getBufferedAmount(): number; close(code: number, reason: string): void },
  ids: string[],
  attach: (id: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  const drained = async () => {
    do {
      await Bun.sleep(1);
      if (ws.readyState !== 1) return false;
      if (Date.now() >= deadline) {
        ws.close(1013, "reconnect for replay");
        return false;
      }
    } while (ws.getBufferedAmount() > 0);
    return true;
  };
  for (const id of ids) {
    if (!(await drained())) return false;
    attach(id);
  }
  return drained();
}

export async function startTerminalBroker(options: {
  workspace: string;
  token: string;
  port?: number;
  graceMs?: number;
  resourceGraceMs?: number;
  speechCleanupMs?: number;
  log?: (event: string) => void;
  codexAdapter?: CodexAppServerAdapter;
}) {
  const workspacePath = resolve(options.workspace);
  // Authentication is kept in this closure/private descriptor, never inherited
  // by helpers, agents, dev servers, or their diagnostic environment snapshots.
  delete process.env.TREETOP_BROKER_TOKEN;
  await mkdir(workspacePath, { recursive: true });
  const generation = crypto.randomUUID();
  const logPath = join(workspacePath, "terminal-broker.log");
  const log =
    options.log ??
    ((event: string) => {
      try {
        if (existsSync(logPath) && statSync(logPath).size > 2 * 1024 * 1024)
          renameSync(logPath, logPath + ".prev");
        appendFileSync(
          logPath,
          `${new Date().toISOString()} pid=${process.pid} broker=${generation} ${event}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        console.error("Broker logging failed", error);
      }
    });
  let previousSnapshot: any;
  try {
    previousSnapshot = JSON.parse(
      await readFile(join(workspacePath, BROKER_SNAPSHOT), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log(`restore snapshot unreadable: ${error}`);
  }
  let restore = restoreCandidates(previousSnapshot);
  const restoreId = restore.length ? crypto.randomUUID() : undefined;
  let restorePending = restore.length > 0;
  let restoreDecision: Promise<any> | undefined;
  const backend = new NodePtyBackend();
  const workspace = await Workspace.open(workspacePath);
  if (restore.length) {
    const [titles, prefs] = await Promise.all([
      workspace.listSessionTitles(),
      workspace.getPrefs(),
    ]);
    try {
      const sessions = Object.values(
        JSON.parse(prefs["supergit:openSessions"] ?? "{}"),
      ).flat() as any[];
      for (const row of restore)
        if (row.terminal) {
          const terminal = row.terminal;
          const session = sessions.find(
            (session) =>
              session.attachTermId === terminal.id ||
              session.source === terminal.ownerId ||
              session.resumeSessionId === terminal.ownerId,
          );
          row.title =
            titles[session?.source] ??
            titles[`shell:${terminal.id}`] ??
            `${row.title}${terminal.ownerId ? ` (${terminal.ownerId.slice(0, 8)})` : ""}`;
        }
    } catch (error) {
      log(`restore titles unavailable: ${error}`);
    }
  }
  const clients = new Set<any>();
  const spawnLocks = new Map<string, Promise<any>>();
  const released = new Set<string>();
  const unused = new Set<string>();
  const resourceTimers = new Map<string, () => void>();
  let stopping = false;
  let snapshotFrozen = false;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshotWrite = Promise.resolve();
  const pendingOperations = new Set<Promise<unknown>>();
  function track<T>(operation: () => Promise<T>): Promise<T> {
    if (stopping)
      throw new Error("Broker is stopping; no new operations accepted");
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => pendingOperations.delete(promise));
    pendingOperations.add(promise);
    return promise;
  }
  async function settlePendingOperations() {
    if (!pendingOperations.size) return;
    log(
      `waiting for in-flight operations count=${pendingOperations.size} before stopping resources`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...pendingOperations]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "In-flight launch did not settle; exits cannot be confirmed",
                ),
              ),
            30_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const send = (ws: any, value: unknown) => {
    if (ws.readyState !== 1) return;
    if (ws.getBufferedAmount() > 1024 * 1024) {
      log("controller backpressure; reconnecting with bounded replay");
      ws.close(1013, "reconnect for replay");
      return;
    }
    ws.send(JSON.stringify(value));
  };
  const publish = (value: unknown) => {
    for (const ws of clients) send(ws, value);
  };
  let mcpUrl = `http://127.0.0.1:${process.env.SUPERGIT_PORT ?? process.env.PORT ?? 27787}/mcp`;
  const codex =
    options.codexAdapter ??
    new CodexAppServerAdapter({
      mcpUrl: () => mcpUrl,
      recordingDir: join(workspacePath, ".debugging", "codex-app-recordings"),
    });
  const claude = new ClaudeCliAdapter({ mcpUrl: () => mcpUrl });
  const speechTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const nativeJobs = new Map<string, ReturnType<typeof claude.sendTurn>>();
  const finishedNativeJobs = new Map<string, any>();
  let nativeHistory: any[] = [];
  let nativeHistoryBytes = 0;
  const unsubscribeCodex = codex.subscribe(
    undefined,
    (event) => {
      const bytes = JSON.stringify(event).length;
      // Never retain a voice audio stream for reconnection replay.
      if (!event.method.includes("audio")) {
        nativeHistory.push({ event, bytes });
        nativeHistoryBytes += bytes;
        while (nativeHistory.length > 300 || nativeHistoryBytes > 512 * 1024)
          nativeHistoryBytes -= nativeHistory.shift()!.bytes;
      }
      publish({ event: "native", value: { kind: "codex", value: event } });
    },
    { replay: false },
  );
  const nativeState = () => ({
    kind: "state",
    ...codex.backgroundState(),
    events: nativeHistory.map((row) => row.event),
    jobs: [...nativeJobs]
      .map(([id, job]) => ({ id, pid: job.pid, running: true }))
      .concat([...finishedNativeJobs.values()]),
  });
  const commands = new ProjectCommands({
    workspace,
    changed: (change) => {
      publish({
        event: "commands",
        running: commands.list(),
        untracked: commands.untracked(),
        change,
      });
      if (change.kind === "command_exit")
        log(`command exited repo=${change.repoId} command=${change.linkId}`);
      saveSnapshot();
    },
    launch: createCommandLauncher({
      terminalBackend: backend,
      backgroundViaPty: true,
      openExternal: async () => {
        throw new Error(
          "External launches belong to the desktop launcher, not the broker",
        );
      },
      terminalEnv: () =>
        Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      backgroundEnv: () => {
        const env = { ...process.env };
        delete env.PORT;
        delete env.PORTLESS_URL;
        delete env.NODE_EXTRA_CA_CERTS;
        return env;
      },
      onInternalSpawn: (handle) => announce(handle.id, true),
    }),
  });
  const snapshotValue = () => ({
    protocol: BROKER_PROTOCOL,
    generation,
    savedAt: new Date().toISOString(),
    terminals: backend.list().filter((record) => !record.exitedAt),
    commands: commands.list(),
  });
  async function flushSnapshot(clear = false) {
    const value = clear
      ? { ...snapshotValue(), terminals: [], commands: [] }
      : restorePending
        ? previousSnapshot
        : snapshotValue();
    snapshotWrite = snapshotWrite
      .catch((error) => log(`snapshot previous write failed: ${error}`))
      .then(async () => {
        const path = join(workspacePath, BROKER_SNAPSHOT);
        await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
        await rename(path + ".tmp", path);
      });
    await snapshotWrite;
  }
  function saveSnapshot() {
    if (restorePending || snapshotFrozen || snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      void flushSnapshot().catch((error) => log(`snapshot failed: ${error}`));
    }, 100);
  }
  function attach(ws: any, id: string) {
    if (ws.data.subscriptions.has(id)) return;
    const handle = backend.get(id);
    const record = backend.list().find((record) => record.id === id);
    if (!handle || !record) return;
    send(ws, {
      event: "record",
      record,
      revision: handle.inputRevision?.() ?? 0,
      env: backend.getEnvSnapshot(id),
    });
    const unsubscribe = handle.subscribe({
      onData: (bytes) =>
        send(ws, {
          event: "data",
          id,
          data: Buffer.from(bytes).toString("base64"),
          at: new Date().toISOString(),
        }),
      onState: (state) => send(ws, { event: "state", id, state }),
      onExit: (exit) => {
        send(ws, { event: "exit", id, exit });
        log(`terminal exited id=${id} pid=${record.pid} code=${exit.code}`);
        released.delete(id);
        unused.delete(id);
        cancelResourceTimer(id);
        queueMicrotask(() => {
          ws.data.subscriptions.get(id)?.();
          ws.data.subscriptions.delete(id);
          ws.data.viewers.delete(id);
        });
        saveSnapshot();
      },
    });
    ws.data.subscriptions.set(id, unsubscribe);
  }
  function viewers(id: string) {
    return [...clients].reduce(
      (count, client) => count + (client.data.viewers.get(id) ?? 0),
      0,
    );
  }
  function cancelResourceTimer(id: string) {
    resourceTimers.get(id)?.();
    resourceTimers.delete(id);
  }
  function scheduleResourceCleanup(id: string) {
    if (
      resourceTimers.has(id) ||
      viewers(id) ||
      (!released.has(id) && !unused.has(id))
    )
      return;
    const delay = options.resourceGraceMs ?? (unused.has(id) ? 90_000 : 60_000);
    resourceTimers.set(
      id,
      scheduleReconnectCleanup(() => {
        resourceTimers.delete(id);
        if (viewers(id) || !lease.hasFreshUi()) {
          log(
            `resource cleanup deferred id=${id} viewers=${viewers(id)} freshUi=${lease.hasFreshUi()}`,
          );
          return;
        }
        log(`closed/unattached resource cleanup id=${id}`);
        void backend
          .get(id)
          ?.kill()
          .catch((error) => log(`resource cleanup failed id=${id}: ${error}`));
      }, delay),
    );
  }
  function announce(id: string, command = false) {
    const record = backend.list().find((record) => record.id === id);
    log(
      `terminal created id=${id} pid=${record?.pid} agent=${record?.agent ?? "shell"}`,
    );
    for (const ws of clients) attach(ws, id);
    if (!command) {
      unused.add(id);
      scheduleResourceCleanup(id);
    }
    saveSnapshot();
  }
  const cancelInterrupted = backend.onCodexInterrupted((ownerId) =>
    publish({ event: "interrupted", ownerId }),
  );
  const status = () => ({
    protocol: BROKER_PROTOCOL,
    pid: process.pid,
    stopping,
    terminals: backend.list().filter((record) => !record.exitedAt).length,
    sessions:
      backend
        .list()
        .filter((record) => !record.exitedAt && record.agent !== "shell")
        .length +
      codex.backgroundState().activeTurns.length +
      nativeJobs.size,
    commands: commands.list().length,
    shells: backend
      .list()
      .filter(
        (record) =>
          !record.exitedAt &&
          record.agent === "shell" &&
          !commands.list().some((command) => command.termId === record.id),
      ).length,
    restore: restorePending
      ? {
          id: restoreId,
          savedAt: previousSnapshot.savedAt,
          candidates: restore.map(({ terminal, command, ...row }) => ({
            ...row,
            ownerId: terminal?.ownerId,
            terminalId: terminal?.id ?? command?.termId,
          })),
        }
      : null,
    controllers: clients.size,
    logPath,
    ...lease.status(),
    generation,
    leaseGeneration: lease.status().generation,
  });
  async function stopResources(fence: () => boolean = () => true) {
    if (stopping) throw new Error("Broker stop is already in progress");
    stopping = true;
    try {
      await settlePendingOperations();
      if (!fence()) return false;
      for (const timer of speechTimers.values()) clearTimeout(timer);
      speechTimers.clear();
      await codex.close();
      for (const [id, job] of nativeJobs) {
        if (!fence()) return false;
        job.kill("SIGTERM");
        const ended = await Promise.race([
          job.exited.then(() => true),
          Bun.sleep(2000).then(() => false),
        ]);
        if (!ended) job.kill("SIGKILL");
        if (
          !(await Promise.race([
            job.exited.then(() => true),
            Bun.sleep(3000).then(() => false),
          ]))
        )
          throw new Error(`Native job exit unconfirmed id=${id}`);
      }
      for (const command of commands.list()) {
        if (!fence()) {
          log("cleanup cancelled: UI lease renewed before next command");
          return false;
        }
        log(
          `stopping command repo=${command.repoId} command=${command.linkId} pid=${command.pid}`,
        );
        await commands.control("stop", command.repoId, command.linkId);
      }
      for (const record of backend
        .list()
        .filter((record) => !record.exitedAt)) {
        if (!fence()) {
          log("cleanup cancelled: UI lease renewed before next terminal");
          return false;
        }
        const handle = backend.get(record.id)!;
        log(`stopping terminal id=${record.id} pid=${record.pid}`);
        await handle.kill();
        const deadline = Date.now() + 5000;
        while (handle.isAlive() && Date.now() < deadline) await Bun.sleep(25);
        if (handle.isAlive())
          throw new Error(`Terminal exit unconfirmed id=${record.id}`);
      }
      return true;
    } finally {
      stopping = false;
    }
  }
  let expiryAttempts = 0;
  let expiryRetry: ReturnType<typeof setTimeout> | undefined;
  async function expireResources(generation: number) {
    try {
      log(
        `cleanup proposed leaseGeneration=${generation}; checking again before termination`,
      );
      await Bun.sleep(1000);
      if (!lease.isCurrent(generation)) {
        log("cleanup cancelled: UI reconnected during decision window");
        return;
      }
      if (!restorePending) await flushSnapshot();
      snapshotFrozen = true;
      if (
        (await stopResources(() => lease.isCurrent(generation))) &&
        lease.isCurrent(generation)
      ) {
        log("idle cleanup complete; broker exiting");
        await stop(false);
        if (import.meta.main) process.exit(0);
      } else snapshotFrozen = false;
    } catch (error) {
      snapshotFrozen = false;
      log(`cleanup failed attempt=${++expiryAttempts}: ${error}`);
      if (!lease.isCurrent(generation)) return;
      if (expiryAttempts >= 3 && import.meta.main) {
        log(
          "bounded cleanup retries exhausted while UI absent; exiting under OS process ownership",
        );
        process.exit(1);
      }
      expiryRetry = setTimeout(() => {
        if (lease.isCurrent(generation)) void expireResources(generation);
      }, 5000);
    }
  }
  const lease = new BackgroundLease({
    graceMs: options.graceMs,
    log,
    expire: (generation) => {
      expiryAttempts = 0;
      void expireResources(generation);
    },
  });
  const server = Bun.serve<{
    subscriptions: Map<string, () => void>;
    viewers: Map<string, number>;
    client: string;
  }>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: 1024 * 1024,
    fetch(req, server) {
      const url = new URL(req.url);
      const authorized =
        req.headers.get("authorization") === `Bearer ${options.token}` ||
        (url.pathname === "/io" &&
          url.searchParams.get("token") === options.token);
      if (!authorized)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (url.pathname === "/status") return Response.json(status());
      if (
        url.pathname === "/io" &&
        server.upgrade(req, {
          data: {
            subscriptions: new Map(),
            viewers: new Map(),
            client: crypto.randomUUID(),
          },
        })
      )
        return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      async open(ws) {
        clients.add(ws);
        log(`controller connected id=${ws.data.client} total=${clients.size}`);
        send(ws, {
          event: "hello",
          protocol: BROKER_PROTOCOL,
          generation,
          recordIds: backend.list().map((record) => record.id),
          running: commands.list(),
          untracked: commands.untracked(),
          native: nativeState(),
        });
        // Each terminal can replay 256 KiB (larger after base64 encoding).
        // Yield between terminals so the socket can drain before the next
        // replay. Otherwise a healthy reconnect trips send's 1 MiB limit
        // before "ready", and every subsequent reconnect repeats the burst.
        if (!(await replayBrokerTerminals(ws, backend.list().map((record) => record.id),
          (id) => attach(ws, id)))) return;
        send(ws, { event: "ready", status: status() });
      },
      async message(ws, message) {
        let request: any;
        try {
          request = JSON.parse(String(message));
          if (
            typeof request.id !== "number" ||
            typeof request.method !== "string"
          )
            throw new Error("Invalid broker request");
          const args = request.args ?? {};
          let value: unknown;
          if (request.method === "lease") {
            value = {
              renewed: lease.renew(args.windowId, args.sequence),
              ...status(),
            };
            for (const id of new Set([...released, ...unused]))
              scheduleResourceCleanup(id);
          } else if (request.method === "acquire") {
            lease.renew(args.windowId, args.sequence);
            // A returning UI waits for any already-committed stop to finish.
            // Subsequent resources are fenced by the renewed lease.
            while (stopping) await Bun.sleep(25);
            value = status();
          } else if (request.method === "status") value = status();
          else if (request.method === "mcpUrl") {
            if (
              typeof args.url !== "string" ||
              !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(args.url)
            )
              throw new Error("Invalid local MCP endpoint");
            mcpUrl = args.url;
            value = { ok: true };
          } else if (request.method === "nativeSend") {
            if (stopping) throw new Error("Broker is stopping");
            if (args.agent !== "claude")
              throw new Error("Unsupported native agent");
            const job = claude.sendTurn(args);
            const id = crypto.randomUUID();
            nativeJobs.set(id, job);
            const finish = (error?: unknown) => {
              nativeJobs.delete(id);
              const value = {
                kind: "jobExit",
                id,
                running: false,
                ...(error ? { error: String(error) } : {}),
              };
              finishedNativeJobs.set(id, value);
              if (finishedNativeJobs.size > 200)
                finishedNativeJobs.delete(
                  finishedNativeJobs.keys().next().value!,
                );
              publish({ event: "native", value });
            };
            void job.exited.then(
              () => finish(),
              (error) => finish(error),
            );
            value = { id, pid: job.pid };
          } else if (request.method === "nativeKill") {
            nativeJobs.get(args.id)?.kill(args.signal);
            value = { ok: true };
          } else if (request.method === "codex") {
            const methods = [
              "startSession",
              "startRealtimeVoice",
              "appendRealtimeSpeech",
              "stopRealtimeVoice",
              "startTurn",
              "steerTurn",
              "listModels",
              "interruptTurn",
              "getGoal",
              "setGoal",
              "clearGoal",
              "archiveThread",
              "readThread",
              "respondToRequest",
              "startRecording",
              "recordingSnapshot",
              "stopRecording",
              "enforceRecordingRetention",
            ];
            if (!methods.includes(args.method) || !Array.isArray(args.args))
              throw new Error("Invalid Codex broker method");
            if (stopping) throw new Error("Broker is stopping");
            await track(async () => {
              value = await (codex as any)[args.method](...args.args);
              if (
                args.method === "startRealtimeVoice" &&
                args.args[0]?.speechOnly === true
              ) {
                const threadId = (value as any).threadId;
                const ownerGeneration =
                  codex.backgroundState().processGeneration;
                speechTimers.set(
                  threadId,
                  setTimeout(() => {
                    speechTimers.delete(threadId);
                    const owner = codex.backgroundState();
                    if (
                      !owner.pid ||
                      owner.processGeneration !== ownerGeneration
                    ) {
                      log(
                        `one-shot speech cleanup skipped: original owner exited thread=${threadId}`,
                      );
                      return;
                    }
                    log(`one-shot speech cleanup thread=${threadId}`);
                    void codex
                      .stopRealtimeVoice(threadId)
                      .catch((error) =>
                        log(`one-shot speech cleanup failed: ${error}`),
                      );
                  }, options.speechCleanupMs ?? 100_000),
                );
              } else if (args.method === "stopRealtimeVoice") {
                clearTimeout(speechTimers.get(args.args[0]));
                speechTimers.delete(args.args[0]);
              }
              if (args.method === "startTurn") {
                const turn = value as any;
                void turn.completed.catch((error: unknown) =>
                  log(
                    `native turn ended thread=${turn.threadId} turn=${turn.turnId}: ${error}`,
                  ),
                );
                value = { threadId: turn.threadId, turnId: turn.turnId };
              }
            });
          } else if (request.method === "restore") {
            if (
              args.id !== restoreId ||
              !Array.isArray(args.selected) ||
              args.selected.some(
                (id: unknown) =>
                  typeof id !== "string" ||
                  !restore.some((row) => row.id === id),
              )
            )
              throw new Error("Restore selection is stale or invalid");
            if (!restoreDecision) {
              restoreDecision = track(async () => {
                const results = [];
                for (const row of restore.filter((row) =>
                  args.selected.includes(row.id),
                )) {
                  try {
                    let termId: string | undefined;
                    if (row.command) {
                      const result = await commands.control(
                        "start",
                        row.command.repoId,
                        row.command.linkId,
                        row.command.repoPath,
                      );
                      termId = result.termId as string | undefined;
                    } else {
                      const record = row.terminal;
                      const resumeCmd = resumeTerminalCommand(record);
                      const handle = await backend.spawn({
                        cmd: withTreetopMcp(resumeCmd, mcpUrl, record.cwd),
                        resumeCmd,
                        cwd: record.cwd,
                        size: record.size,
                        agent: record.agent,
                        ownerId: record.ownerId,
                      });
                      announce(handle.id);
                      termId = handle.id;
                    }
                    results.push({ id: row.id, ok: true, termId });
                  } catch (error) {
                    results.push({
                      id: row.id,
                      ok: false,
                      error: String(error),
                    });
                    log(`restore failed id=${row.id}: ${error}`);
                  }
                }
                await flushSnapshot();
                log(
                  `restore decision selected=${args.selected.length} restored=${results.filter((row) => row.ok).length}`,
                );
                return { results };
              });
            }
            value = await restoreDecision;
          } else if (request.method === "restoreAck") {
            if (args.id !== restoreId || !restoreDecision)
              throw new Error("No completed restore decision to acknowledge");
            await restoreDecision;
            restorePending = false;
            log(
              "restore acknowledged; UI reconciliation and saved selection complete",
            );
            await flushSnapshot();
            value = { ok: true };
          } else if (request.method === "shutdown") {
            log("explicit stop and shutdown requested");
            snapshotFrozen = true;
            await stopResources();
            await flushSnapshot(true);
            value = { stopped: true };
            send(ws, { reply: request.id, value });
            setTimeout(() => {
              void stop(false).then(() => {
                if (import.meta.main) process.exit(0);
              });
            }, 100);
            return;
          } else if (request.method === "stopAll") {
            log("explicit Stop all requested");
            snapshotFrozen = true;
            try {
              value = { stopped: await stopResources() };
              await flushSnapshot(true);
              restorePending = false;
            } finally {
              snapshotFrozen = false;
            }
          } else if (request.method === "command") {
            if (stopping)
              throw new Error("Broker is stopping; no launches accepted");
            if (!["start", "stop", "restart"].includes(args.action))
              throw new Error("Invalid command action");
            value = await track(() =>
              commands.control(
                args.action,
                args.repoId,
                args.commandId,
                args.repoPath,
              ),
            );
          } else if (request.method === "spawn") {
            if (stopping)
              throw new Error("Broker is stopping; no launches accepted");
            const spawn = async () => {
              const existing =
                args.ownerId &&
                backend
                  .list()
                  .find(
                    (record) =>
                      record.ownerId === args.ownerId &&
                      resolve(record.cwd) === resolve(args.cwd) &&
                      !record.exitedAt,
                  );
              if (existing) return existing;
              const handle = await backend.spawn(args);
              announce(handle.id);
              return backend.list().find((record) => record.id === handle.id);
            };
            if (args.ownerId) {
              const key = `${args.ownerId}\0${resolve(args.cwd)}`;
              let pending = spawnLocks.get(key);
              if (!pending) {
                pending = track(spawn);
                spawnLocks.set(key, pending);
              }
              try {
                value = await pending;
              } finally {
                if (spawnLocks.get(key) === pending) spawnLocks.delete(key);
              }
            } else value = await track(spawn);
          } else {
            const handle = backend.get(args.id);
            if (!handle) throw new Error("Terminal not found");
            switch (request.method) {
              case "write":
                handle.write(new Uint8Array(Buffer.from(args.data, "base64")));
                publish({
                  event: "revision",
                  id: args.id,
                  revision: handle.inputRevision?.() ?? 0,
                });
                break;
              case "resize":
                handle.resize(args.size);
                break;
              case "muted":
                handle.setOutputMuted?.(false);
                break; // Always drain into bounded broker buffers while UI is absent.
              case "kill":
                log(`explicit terminal stop id=${args.id} pid=${handle.pid}`);
                await handle.kill();
                break;
              case "viewers": {
                ws.data.viewers.set(
                  args.id,
                  Math.max(0, Math.min(1000, Number(args.count) || 0)),
                );
                if (viewers(args.id)) {
                  released.delete(args.id);
                  unused.delete(args.id);
                  cancelResourceTimer(args.id);
                } else scheduleResourceCleanup(args.id);
                break;
              }
              case "release":
                released.add(args.id);
                scheduleResourceCleanup(args.id);
                log(
                  `column released id=${args.id} viewers=${viewers(args.id)}`,
                );
                break;
              case "bind":
                handle.bindSessionOwner?.(args.ownerId);
                publish({
                  event: "record",
                  record: backend
                    .list()
                    .find((record) => record.id === args.id),
                  revision: handle.inputRevision?.() ?? 0,
                });
                saveSnapshot();
                break;
              default:
                throw new Error("Unknown broker operation");
            }
            value = { ok: true };
          }
          send(ws, { reply: request.id, value });
        } catch (error) {
          log(
            `operation failed method=${request?.method ?? "invalid"}: ${error instanceof Error ? error.message : "invalid request"}`,
          );
          send(ws, {
            reply: request?.id,
            error:
              error instanceof Error ? error.message : "Broker request failed",
          });
        }
      },
      close(ws) {
        clients.delete(ws);
        for (const unsubscribe of ws.data.subscriptions.values()) unsubscribe();
        if (!clients.size)
          for (const record of backend.list())
            backend.get(record.id)?.setOutputMuted?.(false);
        for (const id of ws.data.viewers.keys()) scheduleResourceCleanup(id);
        log(
          `controller disconnected id=${ws.data.client} remaining=${clients.size}; UI lease remains bounded`,
        );
      },
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const descriptor = {
    protocol: BROKER_PROTOCOL,
    generation,
    url,
    token: options.token,
    pid: process.pid,
    workspace: workspacePath,
  };
  const descriptorPath = join(workspacePath, BROKER_DESCRIPTOR);
  await writeFile(descriptorPath + ".tmp", JSON.stringify(descriptor), {
    mode: 0o600,
  });
  await rename(descriptorPath + ".tmp", descriptorPath);
  log(
    `started protocol=${BROKER_PROTOCOL} port=${server.port} graceMs=${options.graceMs ?? 900000}`,
  );
  async function stop(clear = true) {
    lease.dispose();
    if (expiryRetry) clearTimeout(expiryRetry);
    for (const cancel of resourceTimers.values()) cancel();
    resourceTimers.clear();
    if (snapshotTimer) clearTimeout(snapshotTimer);
    try {
      if (clear) {
        snapshotFrozen = true;
        await stopResources();
        await flushSnapshot(true);
      }
    } finally {
      unsubscribeCodex();
      cancelInterrupted();
      await backend.gracefulShutdown();
      for (const client of clients)
        client.close(1000, "broker stopped; reconnect explicitly");
      await server.stop(true);
    }
    const current = JSON.parse(
      await readFile(descriptorPath, "utf8").catch(() => "{}"),
    );
    if (current.generation === generation)
      await unlink(descriptorPath).catch(() => {});
    log("stopped; no child resources retained");
  }
  return { url, backend, commands, lease, stop, status };
}

if (import.meta.main) {
  const workspace = process.env.SUPERGIT_WORKSPACE;
  const token = process.env.TREETOP_BROKER_TOKEN;
  if (!workspace || !token)
    throw new Error("Broker workspace and authentication token required");
  delete process.env.TREETOP_BROKER_TOKEN;
  const { protectBrokerChildren } = await import("./background-process-owner");
  (globalThis as any)[Symbol.for("treetop.broker.process-owner")] =
    await protectBrokerChildren((message) => console.log(message));
  const broker = await startTerminalBroker({ workspace, token });
  process.on("SIGTERM", () => {
    void broker.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(
          "Broker shutdown failed; exiting under OS process ownership",
          error,
        );
        process.exit(1);
      },
    );
  });
  process.on("SIGINT", () => {
    void broker.stop().then(
      () => process.exit(0),
      (error) => {
        console.error(
          "Broker shutdown failed; exiting under OS process ownership",
          error,
        );
        process.exit(1);
      },
    );
  });
}
