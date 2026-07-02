import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CodexAppServerAdapter,
  CodexAppServerRpc,
  type CodexAppServerProcess,
} from "../src/codex-app-server";
import {
  ClaudeCliAdapter,
  type ClaudeSpawnedProcess,
} from "../src/claude-cli-adapter";
import { createNativeAgentRegistry } from "../src/native-agent-adapters";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(fn: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeCodexProcess(): {
  proc: CodexAppServerProcess;
  writes: string[];
  enqueue(obj: unknown): void;
  close(): void;
  killed: string[];
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const exited = deferred<number>();
  const killed: string[] = [];
  const writes: string[] = [];
  const proc: CodexAppServerProcess = {
    pid: 4242,
    stdin: {
      write(chunk: string) {
        writes.push(chunk);
      },
    },
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    exited: exited.promise,
    kill(signal?: string) {
      killed.push(signal ?? "SIGTERM");
      exited.resolve(0);
    },
  };
  return {
    proc,
    writes,
    enqueue(obj: unknown) {
      controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
    },
    close() {
      controller.close();
      exited.resolve(0);
    },
    killed,
  };
}

function parseWrite(writes: string[], index: number): Record<string, unknown> {
  const raw = writes[index];
  if (!raw) throw new Error(`missing write ${index}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("CodexAppServerAdapter", () => {
  test("starts a Codex app-server thread and returns the session source", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const started = adapter.startSession({
      agent: "codex",
      cwd: "/repo",
    });

    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread start request");
    expect(parseWrite(fake.writes, 1)).toEqual({
      method: "initialized",
      params: {},
    });
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/start",
      params: { cwd: "/repo", serviceName: "supergit" },
    });
    fake.enqueue({
      id: 1,
      result: {
        thread: {
          id: "thr_app",
          cwd: "/repo",
          path: "/Users/me/.codex/sessions/rollout-thr_app.jsonl",
        },
        model: "gpt-5.5",
      },
    });

    await expect(started).resolves.toEqual({
      agent: "codex",
      sessionId: "thr_app",
      cwd: "/repo",
      source: "/Users/me/.codex/sessions/rollout-thr_app.jsonl",
      model: "gpt-5.5",
    });
    expect(fake.killed).toEqual([]);
  });

  test("resumes a Codex thread and starts a turn over persistent app-server stdio", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({
      spawn: () => fake.proc,
      clientInfo: {
        name: "supergit_test",
        title: "supergit test",
        version: "0.0.0",
      },
    });

    const run = adapter.sendTurn({
      agent: "codex",
      sessionId: "thr_existing",
      cwd: "/repo",
      text: "continue here",
    });

    await waitFor(() => fake.writes[0], "initialize request");
    expect(parseWrite(fake.writes, 0)).toMatchObject({
      id: 0,
      method: "initialize",
    });
    fake.enqueue({ id: 0, result: { userAgent: "codex-test" } });

    await waitFor(() => fake.writes[2], "thread resume request");
    expect(parseWrite(fake.writes, 1)).toEqual({
      method: "initialized",
      params: {},
    });
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/resume",
      params: { threadId: "thr_existing", cwd: "/repo" },
    });
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });

    await waitFor(() => fake.writes[3], "turn start request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "turn/start",
      params: {
        threadId: "thr_existing",
        cwd: "/repo",
        input: [{ type: "text", text: "continue here", text_elements: [] }],
      },
    });
    fake.enqueue({ id: 2, result: { turn: { id: "turn_1" } } });
    fake.enqueue({
      method: "turn/completed",
      params: { turn: { id: "turn_1" }, status: "completed" },
    });

    await run.exited;
    expect(run.pid).toBe(4242);
    expect(fake.killed).toEqual([]);
  });

  test("starts a new Codex thread when no session id is provided", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const run = adapter.sendTurn({
      agent: "codex",
      cwd: "/repo",
      text: "new work",
    });

    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread start request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/start",
      params: { cwd: "/repo", serviceName: "supergit" },
    });
    fake.enqueue({ id: 1, result: { thread: { id: "thr_new" } } });

    await waitFor(() => fake.writes[3], "turn start request");
    expect(parseWrite(fake.writes, 3)).toMatchObject({
      id: 2,
      method: "turn/start",
      params: { threadId: "thr_new" },
    });
    fake.enqueue({ id: 2, result: { turn: { id: "turn_new" } } });
    fake.enqueue({
      method: "turn/completed",
      params: { turn: { id: "turn_new" } },
    });

    await run.exited;
  });

  test("passes native Codex turn settings to app-server", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const started = adapter.startTurn({
      threadId: "thr_existing",
      cwd: "/repo",
      text: "use these settings",
      overrides: {
        model: "gpt-5.1-codex-max",
        effort: "high",
        summary: "auto",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });

    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread resume request");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });
    await waitFor(() => fake.writes[3], "turn start request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "turn/start",
      params: {
        threadId: "thr_existing",
        cwd: "/repo",
        input: [
          {
            type: "text",
            text: "use these settings",
            text_elements: [],
          },
        ],
        model: "gpt-5.1-codex-max",
        effort: "high",
        summary: "auto",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/repo"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    });
    fake.enqueue({ id: 2, result: { turn: { id: "turn_settings" } } });
    fake.enqueue({
      method: "turn/completed",
      params: { turn: { id: "turn_settings" } },
    });
    await (await started).completed;
  });

  test("lists Codex models from the persistent app-server", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const models = adapter.listModels("/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "model list request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "model/list",
      params: { limit: 100 },
    });
    fake.enqueue({
      id: 1,
      result: {
        data: [
          {
            id: "codex-max",
            model: "gpt-5.1-codex-max",
            displayName: "Codex Max",
            description: "largest Codex model",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              "speed",
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "high", description: "deep" },
            ],
          },
        ],
        nextCursor: null,
      },
    });

    await expect(models).resolves.toEqual([
      {
        id: "codex-max",
        model: "gpt-5.1-codex-max",
        displayName: "Codex Max",
        description: "largest Codex model",
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["speed", "low", "high"],
      },
    ]);
  });

  test("emits live app-server events and answers approval requests", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
    const events: unknown[] = [];
    adapter.subscribe("thr_existing", (event) => events.push(event));

    const run = adapter.sendTurn({
      agent: "codex",
      sessionId: "thr_existing",
      cwd: "/repo",
      text: "run tests",
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread resume request");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });
    await waitFor(() => fake.writes[3], "turn start request");
    fake.enqueue({ id: 2, result: { turn: { id: "turn_approval" } } });

    fake.enqueue({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_existing",
        turnId: "turn_approval",
        itemId: "item_1",
        command: "bun test",
        cwd: "/repo",
      },
    });
    await waitFor(
      () => (events.length > 0 ? events[0] : undefined),
      "approval request event",
    );
    expect(
      events.find(
        (event) =>
          (event as { method?: string }).method ===
          "item/commandExecution/requestApproval",
      ),
    ).toMatchObject({
      kind: "request",
      id: 99,
      method: "item/commandExecution/requestApproval",
      threadId: "thr_existing",
      turnId: "turn_approval",
    });

    adapter.respondToRequest(99, { result: { decision: "accept" } });
    await waitFor(() => fake.writes[4], "approval response");
    expect(parseWrite(fake.writes, 4)).toEqual({
      id: 99,
      result: { decision: "accept" },
    });

    fake.enqueue({
      method: "turn/completed",
      params: { threadId: "thr_existing", turn: { id: "turn_approval" } },
    });
    await run.exited;
  });

  test("thread subscriptions do not receive unthreaded app-server events", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
    const threadEvents: unknown[] = [];
    const globalEvents: unknown[] = [];
    adapter.subscribe("thr_existing", (event) => threadEvents.push(event));
    adapter.subscribe(undefined, (event) => globalEvents.push(event));

    const models = adapter.listModels("/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "model list request");

    fake.enqueue({
      method: "mcpServer/startupStatus/updated",
      params: { name: "tools", status: "starting" },
    });
    await waitFor(
      () => (globalEvents.length > 0 ? true : undefined),
      "global unthreaded event",
    );
    expect(threadEvents).toEqual([]);
    expect(globalEvents).toContainEqual(
      expect.objectContaining({
        method: "mcpServer/startupStatus/updated",
      }),
    );

    fake.enqueue({ id: 1, result: { data: [] } });
    await expect(models).resolves.toEqual([]);
  });

  test("steers and interrupts active Codex turns over app-server RPC", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const turn = adapter.startTurn({
      threadId: "thr_existing",
      cwd: "/repo",
      text: "begin",
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread resume request");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });
    await waitFor(() => fake.writes[3], "turn start request");
    fake.enqueue({ id: 2, result: { turn: { id: "turn_live" } } });
    await turn;

    const steer = adapter.steerTurn({
      threadId: "thr_existing",
      expectedTurnId: "turn_live",
      text: "one more constraint",
    });
    await waitFor(() => fake.writes[4], "turn steer request");
    expect(parseWrite(fake.writes, 4)).toEqual({
      id: 3,
      method: "turn/steer",
      params: {
        threadId: "thr_existing",
        expectedTurnId: "turn_live",
        input: [
          { type: "text", text: "one more constraint", text_elements: [] },
        ],
      },
    });
    fake.enqueue({ id: 3, result: { turnId: "turn_live" } });
    await expect(steer).resolves.toEqual({ turnId: "turn_live" });

    const interrupt = adapter.interruptTurn("thr_existing");
    await waitFor(() => fake.writes[5], "turn interrupt request");
    expect(parseWrite(fake.writes, 5)).toEqual({
      id: 4,
      method: "turn/interrupt",
      params: { threadId: "thr_existing", turnId: "turn_live" },
    });
    fake.enqueue({ id: 4, result: {} });
    await interrupt;
  });

  test("reads Codex app-server thread turns through thread/read", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const read = adapter.readThread({
      threadId: "thr_existing",
      cwd: "/repo",
      includeTurns: true,
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "thread read request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/read",
      params: { threadId: "thr_existing", includeTurns: true },
    });
    fake.enqueue({
      id: 1,
      result: {
        thread: {
          id: "thr_existing",
          turns: [
            {
              id: "turn_1",
              status: "completed",
              itemsView: "full",
              items: [
                {
                  id: "user_1",
                  type: "userMessage",
                  content: [{ type: "text", text: "older context" }],
                },
              ],
            },
          ],
        },
      },
    });

    await expect(read).resolves.toEqual({
      thread: {
        id: "thr_existing",
        turns: [
          {
            id: "turn_1",
            status: "completed",
            itemsView: "full",
            items: [
              {
                id: "user_1",
                type: "userMessage",
                content: [{ type: "text", text: "older context" }],
              },
            ],
          },
        ],
      },
    });
  });

  test("reads, pauses, resumes, edits, and clears Codex thread goals over app-server RPC", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const goal = adapter.getGoal("thr_existing", "/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread resume request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/resume",
      params: { threadId: "thr_existing", cwd: "/repo" },
    });
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });

    await waitFor(() => fake.writes[3], "goal get request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "thread/goal/get",
      params: { threadId: "thr_existing" },
    });
    fake.enqueue({
      id: 2,
      result: {
        goal: {
          threadId: "thr_existing",
          goalId: "goal_1",
          objective: "Keep improving Treetop.",
          status: "active",
          tokenBudget: 12000,
          tokensUsed: 4000,
          timeUsedSeconds: 180,
          updatedAt: 1782432282000,
        },
      },
    });
    await expect(goal).resolves.toEqual({
      threadId: "thr_existing",
      goalId: "goal_1",
      objective: "Keep improving Treetop.",
      status: "active",
      tokenBudget: 12000,
      tokensUsed: 4000,
      timeUsedSeconds: 180,
      createdAt: undefined,
      updatedAt: 1782432282000,
    });

    const pause = adapter.setGoal({
      threadId: "thr_existing",
      cwd: "/repo",
      status: "paused",
    });
    await waitFor(() => fake.writes[4], "goal pause request");
    expect(parseWrite(fake.writes, 4)).toEqual({
      id: 3,
      method: "thread/goal/set",
      params: { threadId: "thr_existing", status: "paused" },
    });
    fake.enqueue({
      id: 3,
      result: { goal: { threadId: "thr_existing", status: "paused" } },
    });
    await expect(pause).resolves.toMatchObject({
      threadId: "thr_existing",
      status: "paused",
    });

    const edit = adapter.setGoal({
      threadId: "thr_existing",
      cwd: "/repo",
      objective: "Make it calm and fast.",
      status: "active",
    });
    await waitFor(() => fake.writes[5], "goal edit request");
    expect(parseWrite(fake.writes, 5)).toEqual({
      id: 4,
      method: "thread/goal/set",
      params: {
        threadId: "thr_existing",
        objective: "Make it calm and fast.",
        status: "active",
      },
    });
    fake.enqueue({
      id: 4,
      result: {
        goal: {
          threadId: "thr_existing",
          objective: "Make it calm and fast.",
          status: "active",
        },
      },
    });
    await expect(edit).resolves.toMatchObject({
      objective: "Make it calm and fast.",
      status: "active",
    });

    const clear = adapter.clearGoal("thr_existing", "/repo");
    await waitFor(() => fake.writes[6], "goal clear request");
    expect(parseWrite(fake.writes, 6)).toEqual({
      id: 5,
      method: "thread/goal/clear",
      params: { threadId: "thr_existing" },
    });
    fake.enqueue({ id: 5, result: {} });
    await clear;
  });

  test("emits a running-state event as soon as a Codex turn starts", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
    const events: unknown[] = [];
    adapter.subscribe("thr_existing", (event) => events.push(event));

    const turn = adapter.startTurn({
      threadId: "thr_existing",
      cwd: "/repo",
      text: "begin",
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread resume request");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });
    await waitFor(() => fake.writes[3], "turn start request");
    fake.enqueue({ id: 2, result: { turn: { id: "turn_live" } } });
    await turn;

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "notification",
        method: "turn/started",
        threadId: "thr_existing",
        turnId: "turn_live",
      }),
    );
  });
});

describe("CodexAppServerRpc", () => {
  test("does not confuse server-initiated requests with client responses", async () => {
    const fake = fakeCodexProcess();
    const rpc = new CodexAppServerRpc(fake.proc);
    const events: unknown[] = [];
    rpc.onEvent((event) => events.push(event));

    const init = rpc.request("initialize", {});
    await waitFor(() => fake.writes[0], "initialize write");
    fake.enqueue({
      id: 7,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thr_app",
        turnId: "turn_1",
        itemId: "item_file",
      },
    });
    await waitFor(
      () => (events.length ? events[0] : undefined),
      "server request",
    );
    expect(events[0]).toMatchObject({
      kind: "request",
      id: 7,
      method: "item/fileChange/requestApproval",
      threadId: "thr_app",
      turnId: "turn_1",
    });

    fake.enqueue({ id: 0, result: { ok: true } });
    await expect(init).resolves.toEqual({ ok: true });
    rpc.close();
  });
});

describe("ClaudeCliAdapter", () => {
  test("runs a headless Claude resume turn through the native adapter contract", async () => {
    const exited = deferred<number>();
    const spawned: { cmd: string[]; cwd: string }[] = [];
    const unlinked: string[] = [];
    const statCalls = new Map<string, number>();
    const adapter = new ClaudeCliAdapter({
      spawn(opts): ClaudeSpawnedProcess {
        spawned.push({ cmd: opts.cmd, cwd: opts.cwd });
        return {
          pid: 3131,
          exited: exited.promise,
          kill() {},
        };
      },
      async stat(path) {
        const count = statCalls.get(path) ?? 0;
        statCalls.set(path, count + 1);
        if (path.endsWith("bun.lockb") && count > 0) return;
        if (path.endsWith("bun.lock")) return;
        throw new Error(`missing ${path}`);
      },
      async unlink(path) {
        unlinked.push(path);
      },
    });

    const run = adapter.sendTurn({
      agent: "claude",
      sessionId: "claude_sid",
      cwd: "/repo",
      text: "please continue",
    });

    expect(spawned).toEqual([
      {
        cwd: "/repo",
        cmd: [
          "claude",
          "-p",
          "-r",
          "claude_sid",
          "--permission-mode",
          "bypassPermissions",
          "please continue",
        ],
      },
    ]);
    expect(run.pid).toBe(3131);
    exited.resolve(0);
    await run.exited;
    // The adapter builds this path with path.join, so the separator is
    // OS-native (backslashes on Windows CI). Build the expected value the same
    // way instead of hard-coding forward slashes.
    expect(unlinked).toEqual([join("/repo", "bun.lockb")]);
  });

  test("requires a session id for Claude resume sends", () => {
    const adapter = new ClaudeCliAdapter({
      spawn() {
        throw new Error("should not spawn");
      },
    });
    expect(() =>
      adapter.sendTurn({ agent: "claude", cwd: "/repo", text: "hello" }),
    ).toThrow(/claude needs sessionId/);
  });
});

describe("createNativeAgentRegistry", () => {
  test("dispatches starts/sends by agent and rejects unsupported providers", async () => {
    const calls: string[] = [];
    const registry = createNativeAgentRegistry({
      claude: {
        agent: "claude",
        sendTurn(req) {
          calls.push(`${req.agent}:${req.text}`);
          return { pid: 1, exited: Promise.resolve(), kill() {} };
        },
      },
      codex: {
        agent: "codex",
        async startSession(req) {
          calls.push(`start:${req.agent}`);
          return {
            agent: "codex",
            sessionId: "codex_sid",
            cwd: req.cwd,
          };
        },
        sendTurn(req) {
          calls.push(`${req.agent}:${req.text}`);
          return { pid: 2, exited: Promise.resolve(), kill() {} };
        },
      },
    });

    registry.sendTurn({
      agent: "claude",
      cwd: "/repo",
      sessionId: "c",
      text: "a",
    });
    registry.sendTurn({
      agent: "codex",
      cwd: "/repo",
      sessionId: "x",
      text: "b",
    });
    await expect(
      registry.startSession({ agent: "codex", cwd: "/repo" }),
    ).resolves.toMatchObject({ sessionId: "codex_sid" });

    expect(calls).toEqual(["claude:a", "codex:b", "start:codex"]);
    expect(() =>
      registry.sendTurn({ agent: "ollama", cwd: "/repo", text: "nope" }),
    ).toThrow(/sending to ollama not supported/);
    await expect(
      registry.startSession({ agent: "claude", cwd: "/repo" }),
    ).rejects.toThrow(/starting claude not supported/);
    await expect(
      registry.startSession({ agent: "ollama", cwd: "/repo" }),
    ).rejects.toThrow(/starting ollama not supported/);
  });
});
