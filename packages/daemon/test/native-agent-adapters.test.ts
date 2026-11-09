import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  CodexAppServerAdapter,
  CodexAppEventTransportBatcher,
  CodexAppServerRpc,
  CodexCliEventAdapter,
  connectCodexCliEventProcess,
  createCodexCliIdentityProxy,
  spawnCodexTerminalWithIdentity,
  classifyRealtimeVoiceError,
  codexAppServerCommand,
  listCodexModelsFresh,
  realtimeVoiceStartParams,
  resolveCodexBinary,
  voiceContextPrompt,
  type CodexAppServerEvent,
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

describe("CodexAppEventTransportBatcher", () => {
  test("batches a high-rate event stream without dropping or reordering events", () => {
    const batcher = new CodexAppEventTransportBatcher();
    const flushed: CodexAppServerEvent[][] = [];
    for (let seq = 1; seq <= 10_000; seq += 1) {
      const batch = batcher.push({
        kind: "notification",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", itemId: "message-1", delta: "x" },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-09-29T00:00:00.000Z",
        seq,
      });
      if (batch) flushed.push(batch);
    }
    const tail = batcher.drain();
    if (tail.length) flushed.push(tail);

    expect(flushed.length).toBeLessThan(50);
    expect(flushed.flat().map((event) => event.seq)).toEqual(
      Array.from({ length: 10_000 }, (_, index) => index + 1),
    );
  });
});

describe("CodexAppServerAdapter", () => {
  test("prefers the standalone Codex CLI over the ChatGPT app bundle", () => {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    expect(
      resolveCodexBinary({
        env: {},
        findOnPath: () => "/Users/test/.bun/bin/codex",
        bundledPath: bundled,
        exists: (path) => path === bundled,
      }),
    ).toBe("/Users/test/.bun/bin/codex");
  });

  test("finds the Bun-installed CLI when the GUI daemon PATH only sees Homebrew", () => {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const bunCli = join("/Users/test", ".bun", "bin", "codex");
    expect(
      resolveCodexBinary({
        env: {},
        homeDir: "/Users/test",
        findOnPath: () => "/opt/homebrew/bin/codex",
        bundledPath: bundled,
        exists: (path) => path === bunCli || path === bundled,
      }),
    ).toBe(bunCli);
  });

  test("enables realtime conversations in the app-server process", () => {
    expect(codexAppServerCommand("/opt/codex")).toEqual([
      "/opt/codex",
      "app-server",
      "--enable",
      "realtime_conversation",
    ]);
  });

  test("classifies realtime availability failures without reporting server errors", () => {
    expect(
      classifyRealtimeVoiceError(
        "thread abc does not support realtime conversation",
      ),
    ).toEqual({
      status: 501,
      error: "Voice mode is unavailable in this Codex App Server version.",
    });
    expect(
      classifyRealtimeVoiceError(
        "unexpected status 403 Forbidden: Voice session access denied.",
      ),
    ).toEqual({
      status: 403,
      error: "Codex App Server denied this voice session.",
    });
    expect(classifyRealtimeVoiceError("timed out waiting for SDP")).toBeNull();
  });

  test("uses the bundled App Server's WebRTC v3 request shape", () => {
    expect(
      realtimeVoiceStartParams({
        threadId: "thr_voice",
        sdp: "browser-offer",
        prompt: "Current Treetop context.",
      }),
    ).toEqual({
      threadId: "thr_voice",
      outputModality: "audio",
      includeStartupContext: true,
      model: "gpt-live-1-codex",
      prompt: "Current Treetop context.",
      version: "v3",
      voice: "sol",
      transport: { type: "webrtc", sdp: "browser-offer" },
    });
  });

  test("names the registered context tool in the initial voice prompt", () => {
    const prompt = voiceContextPrompt({ product: "Treetop", cwd: "/repo" });

    expect(prompt).toContain("Use get_context for fresh state before acting");
    expect(prompt).not.toContain("get_treetop_context");
    expect(prompt).toContain('"cwd":"/repo"');
  });

  test("starts a Codex app-server thread and returns the session source", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const started = adapter.startSession({
      agent: "codex",
      cwd: "/repo",
    });

    await waitFor(() => fake.writes[0], "initialize request");
    expect(parseWrite(fake.writes, 0)).toEqual({
      id: 0,
      method: "initialize",
      params: {
        clientInfo: {
          name: "supergit",
          title: "supergit",
          version: "0.0.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
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
    await adapter.close();
  });

  test("starts a new Codex thread with the freshly resolved default model", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
    const started = adapter.startSession({
      agent: "codex",
      cwd: "/repo",
      model: "gpt-6.1-sol",
    });

    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread start request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/start",
      params: {
        cwd: "/repo",
        serviceName: "supergit",
        model: "gpt-6.1-sol",
      },
    });
    fake.enqueue({
      id: 1,
      result: { thread: { id: "thr_fresh", cwd: "/repo" } },
    });

    await expect(started).resolves.toMatchObject({
      sessionId: "thr_fresh",
      model: "gpt-6.1-sol",
    });
    await adapter.close();
  });

  test("restarts a silent Codex app-server after an RPC timeout", async () => {
    const first = fakeCodexProcess();
    const second = fakeCodexProcess();
    const processes = [first, second];
    let spawnCount = 0;
    let fireTimeout!: () => void;
    const adapter = new CodexAppServerAdapter({
      requestTimeoutMs: 5,
      scheduleRequestTimeout(callback) {
        const timer = setTimeout(callback, 60_000);
        fireTimeout = () => {
          clearTimeout(timer);
          callback();
        };
        return timer;
      },
      spawn: () => processes[spawnCount++]!.proc,
    });

    const stalled = adapter.listModels("/repo");
    await waitFor(() => first.writes[0], "first initialize request");
    first.enqueue({ id: 0, result: {} });
    await waitFor(() => first.writes[2], "first model list request");
    fireTimeout();

    await expect(stalled).rejects.toThrow(
      "codex app-server model/list timed out after 5ms",
    );
    expect(first.killed).toEqual(["SIGTERM"]);

    const recovered = adapter.listModels("/repo");
    await waitFor(() => second.writes[0], "replacement initialize request");
    second.enqueue({ id: 0, result: {} });
    await waitFor(() => second.writes[2], "replacement model list request");
    second.enqueue({ id: 1, result: { data: [], nextCursor: null } });

    await expect(recovered).resolves.toEqual([]);
    expect(spawnCount).toBe(2);
  });

  test("speech-only threads expose no tools and send explicit text without any audio-input RPC", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
    const started = adapter.startRealtimeVoice({ cwd: "/repo", sdp: "offer", speechOnly: true, prompt: "Read this message aloud" });
    await waitFor(() => fake.writes[0], "initialize"); fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread start");
    expect(parseWrite(fake.writes, 2).params).toMatchObject({ ephemeral: true, serviceName: "voice", dynamicTools: [] });
    fake.enqueue({ id: 1, result: { thread: { id: "one-shot" } } });
    await waitFor(() => fake.writes[3], "realtime start");
    expect(parseWrite(fake.writes, 3).params).toMatchObject({ includeStartupContext: false, version: "v3", transport: { type: "webrtc", sdp: "offer" } });
    fake.enqueue({ method: "thread/realtime/sdp", params: { threadId: "one-shot", sdp: "answer" } });
    fake.enqueue({ id: 2, result: {} });
    expect(await started).toEqual({ threadId: "one-shot", sdp: "answer" });
    const speech = adapter.appendRealtimeSpeech("one-shot", "Tests finished");
    await waitFor(() => fake.writes[4], "speech request");
    expect(parseWrite(fake.writes, 4)).toMatchObject({ method: "thread/realtime/appendText", params: { threadId: "one-shot", role: "user", text: "Please say exactly this message aloud now, without adding any words: Tests finished" } });
    fake.enqueue({ id: 3, result: {} }); await speech;
    fake.close();
  });

  test("starts and stops an ephemeral global realtime voice thread over WebRTC", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const started = adapter.startRealtimeVoice({
      cwd: "/repo",
      sdp: "browser-offer",
      prompt: "Current Treetop context: project alpha.",
    });

    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "voice thread start request");
    const voiceStart = parseWrite(fake.writes, 2);
    expect(voiceStart).toMatchObject({
      id: 1,
      method: "thread/start",
      params: {
        cwd: "/repo",
        ephemeral: true,
        serviceName: "voice",
      },
    });
    const tools = (
      voiceStart.params as { dynamicTools?: Array<{ name?: string }> }
    ).dynamicTools?.map((tool) => tool.name);
    expect(tools).toEqual([
      "get_context",
      "focus_project",
      "focus_session",
      "scroll_to",
      "read_session_messages",
      "read_recent_completions",
      "send_session_message",
      "set_zen_mode",
      "create_note",
      "read_note",
      "update_note",
      "create_sticker",
      "move_note",
      "move_sticker",
    ]);
    expect(
      (voiceStart.params as { developerInstructions?: string })
        .developerInstructions,
    ).toContain("Use get_context whenever");
    expect(
      (voiceStart.params as { developerInstructions?: string })
        .developerInstructions,
    ).not.toContain("get_treetop_context");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_voice" } } });

    await waitFor(() => fake.writes[3], "realtime start request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "thread/realtime/start",
      params: {
        threadId: "thr_voice",
        outputModality: "audio",
        includeStartupContext: true,
        model: "gpt-live-1-codex",
        prompt: "Current Treetop context: project alpha.",
        version: "v3",
        voice: "sol",
        transport: { type: "webrtc", sdp: "browser-offer" },
      },
    });
    fake.enqueue({ id: 2, result: {} });
    fake.enqueue({
      method: "thread/realtime/sdp",
      params: { threadId: "thr_voice", sdp: "server-answer" },
    });

    await expect(started).resolves.toEqual({
      threadId: "thr_voice",
      sdp: "server-answer",
    });

    const stopped = adapter.stopRealtimeVoice("thr_voice");
    await waitFor(() => fake.writes[4], "realtime stop request");
    expect(parseWrite(fake.writes, 4)).toEqual({
      id: 3,
      method: "thread/realtime/stop",
      params: { threadId: "thr_voice" },
    });
    fake.enqueue({ id: 3, result: {} });
    await stopped;
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
      params: {
        threadId: "thr_existing",
        cwd: "/repo",
        excludeTurns: true,
      },
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
        serviceTier: "priority",
        summary: "auto",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
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
        serviceTier: "priority",
        summary: "auto",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
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
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "high", description: "deep" },
              { effort: "ultra", description: "deepest" },
            ],
            defaultServiceTier: "priority",
            serviceTiers: [
              { id: "default", name: "standard" },
              { serviceTier: "priority", displayName: "fast" },
            ],
            additionalSpeedTiers: ["priority"],
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
        supportedReasoningEfforts: ["low", "high", "ultra"],
        defaultServiceTier: "priority",
        serviceTiers: [
          { id: "default", name: "standard", description: undefined },
          { id: "priority", name: "fast", description: undefined },
        ],
        additionalSpeedTiers: ["priority"],
      },
    ]);
  });

  test("lists models through an isolated app-server and closes it afterwards", async () => {
    const fake = fakeCodexProcess();
    const listed = listCodexModelsFresh("/repo", {
      spawn: () => fake.proc,
    });

    await waitFor(() => fake.writes[0], "catalog initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "catalog model list request");
    fake.enqueue({
      id: 1,
      result: {
        data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol" }],
        nextCursor: null,
      },
    });

    await expect(listed).resolves.toEqual([
      {
        id: "gpt-6.1-sol",
        model: "gpt-6.1-sol",
        displayName: undefined,
        description: undefined,
        isDefault: false,
        defaultReasoningEffort: undefined,
      },
    ]);
    expect(fake.killed).toEqual(["SIGTERM"]);
  });

  test("records app-server json-rpc traffic automatically with a bounded buffer", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({
      spawn: () => fake.proc,
      recordingFrameLimit: 3,
    });

    const models = adapter.listModels("/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "model list request");
    fake.enqueue({
      id: 1,
      result: {
        data: [{ id: "codex", model: "gpt-5.6-sol" }],
        nextCursor: null,
      },
    });
    await models;

    const recording = adapter.recordingSnapshot();
    expect(recording?.frames).toHaveLength(3);
    expect(recording?.frames.map((frame) => frame.direction)).toEqual([
      "client",
      "client",
      "server",
    ]);
    expect(recording?.frames[1]?.message).toEqual({
      id: 1,
      method: "model/list",
      params: { limit: 100 },
    });
    expect(recording?.frames[2]?.message).toMatchObject({
      id: 1,
      result: { data: [{ id: "codex" }] },
    });

    const saved = adapter.stopRecording();
    expect(saved?.frames).toHaveLength(3);
    expect(adapter.recordingSnapshot()?.frames).toEqual([]);
  });

  test("persists app-server json-rpc replay frames beyond the bounded buffer", async () => {
    const recordingDir = mkdtempSync(join(tmpdir(), "supergit-codex-rpc-"));
    try {
      const fake = fakeCodexProcess();
      const adapter = new CodexAppServerAdapter({
        spawn: () => fake.proc,
        recordingDir,
        recordingFrameLimit: 2,
      });

      const models = adapter.listModels("/repo");
      await waitFor(() => fake.writes[0], "initialize request");
      fake.enqueue({ id: 0, result: {} });
      await waitFor(() => fake.writes[2], "model list request");
      fake.enqueue({
        id: 1,
        result: {
          data: [{ id: "codex", model: "gpt-5.6-sol" }],
          nextCursor: null,
        },
      });
      await models;

      const recording = adapter.recordingSnapshot();
      expect(recording?.frames).toHaveLength(2);
      expect(recording?.path?.endsWith(".jsonl")).toBe(true);

      const replayRows = readFileSync(recording!.path!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(replayRows).toHaveLength(5);
      expect(replayRows.map((row) => row.direction)).toEqual([
        "client",
        "server",
        "client",
        "client",
        "server",
      ]);
      expect(replayRows.some((row) => row.seq === 1)).toBe(true);
      expect(replayRows.some((row) => row.seq === 5)).toBe(true);
      expect(replayRows[3]?.message).toEqual({
        id: 1,
        method: "model/list",
        params: { limit: 100 },
      });
    } finally {
      rmSync(recordingDir, { recursive: true, force: true });
    }
  });

  test("keeps the RPC stream alive when recording disk writes fail", async () => {
    const recordingDir = mkdtempSync(join(tmpdir(), "treetop-codex-rpc-"));
    try {
      const fake = fakeCodexProcess();
      const adapter = new CodexAppServerAdapter({
        spawn: () => fake.proc,
        recordingDir,
      });
      const recordingPath = adapter.recordingSnapshot()!.path!;
      chmodSync(recordingPath, 0o444);

      const models = adapter.listModels("/repo");
      await waitFor(() => fake.writes[0], "initialize after recording failure");
      fake.enqueue({ id: 0, result: {} });
      await waitFor(() => fake.writes[2], "model list after recording failure");
      fake.enqueue({ id: 1, result: { data: [], nextCursor: null } });

      await expect(models).resolves.toEqual([]);
      expect(fake.killed).toEqual([]);
      expect(adapter.recordingSnapshot()?.path).toBeUndefined();
      expect(adapter.recordingSnapshot()?.frames.length).toBeGreaterThan(0);
    } finally {
      rmSync(recordingDir, { recursive: true, force: true });
    }
  });

  test("rolls and evicts disk recordings under the configured byte cap", async () => {
    const recordingDir = mkdtempSync(join(tmpdir(), "supergit-codex-rpc-"));
    try {
      const fake = fakeCodexProcess();
      const adapter = new CodexAppServerAdapter({
        spawn: () => fake.proc,
        recordingDir,
        recordingMaxBytes: 1_600,
        recordingSegmentMaxBytes: 450,
      });

      for (let attempt = 0; attempt < 6; attempt++) {
        const models = adapter.listModels("/repo");
        if (attempt === 0) {
          await waitFor(() => fake.writes[0], "initialize request");
          fake.enqueue({ id: 0, result: {} });
        }
        const requestIndex = attempt + 2;
        await waitFor(
          () => fake.writes[requestIndex],
          `model list request ${attempt}`,
        );
        fake.enqueue({
          id: attempt + 1,
          result: {
            data: [
              {
                id: `codex-${attempt}`,
                model: "gpt-5.6-sol",
                description: "x".repeat(80),
              },
            ],
            nextCursor: null,
          },
        });
        await models;
      }

      const files = readdirSync(recordingDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(recordingDir, name));
      const totalBytes = files.reduce(
        (total, path) => total + statSync(path).size,
        0,
      );
      expect(files.length).toBeGreaterThan(1);
      expect(totalBytes).toBeLessThanOrEqual(1_600);
      expect(
        files.some((path) =>
          readFileSync(path, "utf8").includes("codex-5"),
        ),
      ).toBe(true);
      expect(JSON.stringify(adapter.recordingSnapshot()?.frames)).toContain(
        "codex-5",
      );

      const activePath = adapter.recordingSnapshot()!.path!;
      writeFileSync(
        join(recordingDir, "saved-recording.json"),
        "x".repeat(1_400),
      );
      adapter.enforceRecordingRetention();
      const retainedFiles = readdirSync(recordingDir).map((name) =>
        join(recordingDir, name),
      );
      expect(
        retainedFiles.reduce(
          (total, path) => total + statSync(path).size,
          0,
        ),
      ).toBeLessThanOrEqual(1_600);
      expect(existsSync(activePath)).toBe(true);
    } finally {
      rmSync(recordingDir, { recursive: true, force: true });
    }
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

  test("fresh SSE subscriptions can skip buffered events already owned by thread history", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
    const firstEvents: unknown[] = [];
    const off = adapter.subscribe("thr_existing", (event) =>
      firstEvents.push(event),
    );

    const models = adapter.listModels("/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "model list request");
    fake.enqueue({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_existing",
        turnId: "turn_existing",
        itemId: "message_existing",
        delta: "already represented by thread/read",
      },
    });
    await waitFor(() => firstEvents[0], "buffered app-server event");
    fake.enqueue({ id: 1, result: { data: [], nextCursor: null } });
    await models;
    off();

    const freshEvents: unknown[] = [];
    adapter.subscribe(
      "thr_existing",
      (event) => freshEvents.push(event),
      { replay: false },
    );

    expect(freshEvents).toEqual([]);
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

  test("interrupts active Codex turns observed from app-server events", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const session = adapter.startSession({ agent: "codex", cwd: "/repo" });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread start request");
    fake.enqueue({
      id: 1,
      result: { thread: { id: "thr_boot", cwd: "/repo" }, model: "gpt-5.5" },
    });
    await session;

    fake.enqueue({
      method: "turn/started",
      params: {
        threadId: "thr_existing",
        turnId: "turn_external",
        turn: { id: "turn_external" },
      },
    });
    await waitFor(
      () => adapter.activeTurn("thr_existing"),
      "event-derived active turn",
    );
    expect(adapter.activeTurn("thr_existing")).toBe("turn_external");

    const interrupt = adapter.interruptTurn("thr_existing");
    await waitFor(() => fake.writes[3], "turn interrupt request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "turn/interrupt",
      params: { threadId: "thr_existing", turnId: "turn_external" },
    });
    fake.enqueue({ id: 2, result: {} });
    await interrupt;

    fake.enqueue({
      method: "turn/completed",
      params: {
        threadId: "thr_existing",
        turn: { id: "turn_external" },
      },
    });
    await waitFor(
      () =>
        adapter.activeTurn("thr_existing") === undefined ? true : undefined,
      "event-derived active turn cleared",
    );
  });

  test("loads Codex app-server threads before reading turns", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const read = adapter.readThread({
      threadId: "thr_existing",
      cwd: "/repo",
      includeTurns: true,
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "thread resume request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/resume",
      params: {
        threadId: "thr_existing",
        cwd: "/repo",
        excludeTurns: true,
      },
    });
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });

    await waitFor(() => fake.writes[3], "thread read request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "thread/read",
      params: { threadId: "thr_existing", includeTurns: true },
    });
    fake.enqueue({
      id: 2,
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

  test("surfaces the Codex app-server thread model from thread/read", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const read = adapter.readThread({
      threadId: "thr_existing",
      cwd: "/repo",
      includeTurns: true,
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "thread resume request");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });

    await waitFor(() => fake.writes[3], "thread read request");
    fake.enqueue({
      id: 2,
      result: {
        thread: {
          id: "thr_existing",
          settings: { model: "gpt-5.5" },
          turns: [],
        },
      },
    });

    await expect(read).resolves.toEqual({
      thread: {
        id: "thr_existing",
        settings: { model: "gpt-5.5" },
        turns: [],
      },
      model: "gpt-5.5",
    });
  });

  test("bootstraps the first Codex app-server turns page through thread/resume", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const read = adapter.readThread({
      threadId: "thr_existing",
      cwd: "/repo",
      turnsLimit: 50,
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "thread resume request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/resume",
      params: {
        threadId: "thr_existing",
        cwd: "/repo",
        excludeTurns: true,
        initialTurnsPage: {
          limit: 50,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
    });
    fake.enqueue({
      id: 1,
      result: {
        thread: { id: "thr_existing" },
        initialTurnsPage: {
          data: [{ id: "turn_2" }, { id: "turn_1" }],
          nextCursor: "cursor-even-older",
          backwardsCursor: "cursor-newer",
        },
      },
    });

    await expect(read).resolves.toEqual({
      thread: { id: "thr_existing" },
      turns: [{ id: "turn_2" }, { id: "turn_1" }],
      nextCursor: "cursor-even-older",
      backwardsCursor: "cursor-newer",
    });
    expect(fake.writes).toHaveLength(3);
  });

  test("treats an unmaterialized new Codex thread as empty history", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const started = adapter.startSession({ agent: "codex", cwd: "/repo" });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });
    await waitFor(() => fake.writes[2], "thread start request");
    fake.enqueue({
      id: 1,
      result: {
        thread: { id: "thr_new", cwd: "/repo", turns: [] },
        model: "gpt-5.5",
      },
    });
    await started;

    const read = adapter.readThread({
      threadId: "thr_new",
      cwd: "/repo",
      turnsLimit: 4,
    });
    await waitFor(() => fake.writes[3], "thread read request");
    fake.enqueue({
      id: 2,
      result: { thread: { id: "thr_new", cwd: "/repo", turns: [] } },
    });
    await waitFor(() => fake.writes[4], "turns list request");
    fake.enqueue({
      id: 3,
      error: {
        code: -32600,
        message:
          "thread thr_new is not materialized yet; thread/turns/list is unavailable before first user message",
      },
    });

    await expect(read).resolves.toEqual({
      thread: { id: "thr_new", cwd: "/repo", turns: [] },
      turns: [],
    });

    const olderPage = adapter.readThread({
      threadId: "thr_new",
      cwd: "/repo",
      turnsLimit: 4,
      turnsCursor: "cursor-older",
    });
    await waitFor(() => fake.writes[5], "older-page thread read request");
    fake.enqueue({
      id: 4,
      result: { thread: { id: "thr_new", cwd: "/repo", turns: [] } },
    });
    await waitFor(() => fake.writes[6], "older-page turns list request");
    fake.enqueue({
      id: 5,
      error: {
        code: -32600,
        message:
          "thread thr_new is not materialized yet; thread/turns/list is unavailable before first user message",
      },
    });
    await expect(olderPage).rejects.toThrow("is not materialized yet");
  });

  test("pages older Codex app-server turns from the loaded thread cursor", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const read = adapter.readThread({
      threadId: "thr_existing",
      cwd: "/repo",
      turnsLimit: 50,
      turnsCursor: "cursor-older",
    });
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "thread resume request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/resume",
      params: {
        threadId: "thr_existing",
        cwd: "/repo",
        excludeTurns: true,
      },
    });
    fake.enqueue({ id: 1, result: { thread: { id: "thr_existing" } } });

    await waitFor(() => fake.writes[3], "thread read request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "thread/read",
      params: { threadId: "thr_existing", includeTurns: false },
    });
    fake.enqueue({ id: 2, result: { thread: { id: "thr_existing" } } });

    await waitFor(() => fake.writes[4], "turns list request");
    expect(parseWrite(fake.writes, 4)).toEqual({
      id: 3,
      method: "thread/turns/list",
      params: {
        threadId: "thr_existing",
        cursor: "cursor-older",
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      },
    });
    fake.enqueue({
      id: 3,
      result: {
        data: [{ id: "turn_2" }, { id: "turn_1" }],
        nextCursor: "cursor-even-older",
        backwardsCursor: "cursor-newer",
      },
    });

    await expect(read).resolves.toEqual({
      thread: { id: "thr_existing" },
      turns: [{ id: "turn_2" }, { id: "turn_1" }],
      nextCursor: "cursor-even-older",
      backwardsCursor: "cursor-newer",
    });
  });

  test("reads, pauses, resumes, edits, and clears Codex thread goals over app-server RPC", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const goal = adapter.getGoal("thr_existing", "/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "goal get request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/goal/get",
      params: { threadId: "thr_existing" },
    });
    fake.enqueue({
      id: 1,
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
    await waitFor(() => fake.writes[3], "goal pause request");
    expect(parseWrite(fake.writes, 3)).toEqual({
      id: 2,
      method: "thread/goal/set",
      params: { threadId: "thr_existing", status: "paused" },
    });
    fake.enqueue({
      id: 2,
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
    await waitFor(() => fake.writes[4], "goal edit request");
    expect(parseWrite(fake.writes, 4)).toEqual({
      id: 3,
      method: "thread/goal/set",
      params: {
        threadId: "thr_existing",
        objective: "Make it calm and fast.",
        status: "active",
      },
    });
    fake.enqueue({
      id: 3,
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
    await waitFor(() => fake.writes[5], "goal clear request");
    expect(parseWrite(fake.writes, 5)).toEqual({
      id: 4,
      method: "thread/goal/clear",
      params: { threadId: "thr_existing" },
    });
    fake.enqueue({ id: 4, result: {} });
    await clear;
  });

  test("archives a Codex thread through the app-server protocol", async () => {
    const fake = fakeCodexProcess();
    const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });

    const archived = adapter.archiveThread("thr_existing", "/repo");
    await waitFor(() => fake.writes[0], "initialize request");
    fake.enqueue({ id: 0, result: {} });

    await waitFor(() => fake.writes[2], "thread archive request");
    expect(parseWrite(fake.writes, 2)).toEqual({
      id: 1,
      method: "thread/archive",
      params: { threadId: "thr_existing" },
    });
    fake.enqueue({ id: 1, result: {} });

    await expect(archived).resolves.toBeUndefined();
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
  test("answers current-time callbacks without presenting them as approvals", async () => {
    const fake = fakeCodexProcess();
    const rpc = new CodexAppServerRpc(fake.proc);
    const events: unknown[] = [];
    rpc.onEvent((event) => events.push(event));
    const before = Math.floor(Date.now() / 1000);

    fake.enqueue({
      id: 21,
      method: "currentTime/read",
      params: { threadId: "thr_time" },
    });
    await waitFor(() => fake.writes[0], "current-time response");
    const after = Math.floor(Date.now() / 1000);

    const response = parseWrite(fake.writes, 0) as {
      id: number;
      result: { currentTimeAt: number };
    };
    expect(response.id).toBe(21);
    expect(response.result.currentTimeAt).toBeGreaterThanOrEqual(before);
    expect(response.result.currentTimeAt).toBeLessThanOrEqual(after);
    expect(events).toEqual([]);
    rpc.close();
  });

  test("times out unanswered requests without poisoning later responses", async () => {
    const fake = fakeCodexProcess();
    const rpc = new CodexAppServerRpc(fake.proc, undefined, 5);

    const stuck = rpc.request("turn/start", { threadId: "thr_stuck" });
    await waitFor(() => fake.writes[0], "stuck request write");
    await expect(stuck).rejects.toThrow(
      "codex app-server turn/start timed out after 5ms",
    );

    fake.enqueue({ id: 0, result: { turn: { id: "too_late" } } });
    const next = rpc.request("thread/read", { threadId: "thr_ok" });
    await waitFor(() => fake.writes[1], "next request write");
    fake.enqueue({ id: 1, result: { thread: { id: "thr_ok" } } });
    await expect(next).resolves.toEqual({ thread: { id: "thr_ok" } });
    rpc.close();
  });

  test("records exact app-server json-rpc traffic in order", async () => {
    const fake = fakeCodexProcess();
    const frames: unknown[] = [];
    const rpc = new CodexAppServerRpc(fake.proc, (frame) => {
      frames.push(frame);
    });

    const init = rpc.request("initialize", { clientInfo: { name: "test" } });
    await waitFor(() => fake.writes[0], "initialize write");
    fake.enqueue({
      id: 9,
      method: "item/approval/request",
      params: { threadId: "thr_app", turnId: "turn_1" },
    });
    await waitFor(
      () =>
        frames.some(
          (frame) =>
            typeof frame === "object" &&
            frame !== null &&
            (frame as { direction?: unknown }).direction === "server",
        )
          ? true
          : undefined,
      "recorded server request",
    );
    rpc.respond(9, { result: { decision: "approved" } });
    fake.enqueue({ id: 0, result: { ok: true } });
    await init;

    expect(frames).toMatchObject([
      {
        direction: "client",
        raw: JSON.stringify({
          id: 0,
          method: "initialize",
          params: { clientInfo: { name: "test" } },
        }),
        message: {
          id: 0,
          method: "initialize",
          params: { clientInfo: { name: "test" } },
        },
      },
      {
        direction: "server",
        raw: JSON.stringify({
          id: 9,
          method: "item/approval/request",
          params: { threadId: "thr_app", turnId: "turn_1" },
        }),
        message: {
          id: 9,
          method: "item/approval/request",
          params: { threadId: "thr_app", turnId: "turn_1" },
        },
      },
      {
        direction: "client",
        raw: JSON.stringify({
          id: 9,
          result: { decision: "approved" },
        }),
        message: {
          id: 9,
          result: { decision: "approved" },
        },
      },
      {
        direction: "server",
        raw: JSON.stringify({ id: 0, result: { ok: true } }),
        message: {
          id: 0,
          result: { ok: true },
        },
      },
    ]);
    rpc.close();
  });

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
  test("headless Claude receives the Treetop MCP connection and cwd", async () => {
    let spawned: { cmd: string[]; cwd: string } | undefined;
    const adapter = new ClaudeCliAdapter({
      mcpUrl: () => "http://127.0.0.1:50001/mcp",
      spawn(opts) {
        spawned = opts;
        return { pid: 1, exited: Promise.resolve(0), kill() {} };
      },
      async stat() { return {}; },
    });
    const run = adapter.sendTurn({ agent: "claude", sessionId: "session", cwd: "/repo", text: "add a command" });
    await run.exited;
    expect(spawned!.cmd).toContain("--mcp-config");
    const config = JSON.parse(spawned!.cmd[spawned!.cmd.indexOf("--mcp-config") + 1]!);
    expect(new URL(config.mcpServers.treetop.url).searchParams.get("cwd")).toBe("/repo");
    expect(spawned!.cmd.slice(-1)).toEqual(["add a command"]);
    expect(spawned!.cmd).toContain("--append-system-prompt");
  });
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


test("native Codex external notifications use toolOutput with empty user input", async () => {
  const fake = fakeCodexProcess();
  const adapter = new CodexAppServerAdapter({ spawn: () => fake.proc });
  expect(adapter.canReceiveExternalEvents("thr_watch")).toBe(false);
  await expect(adapter.notifyExternalEvent("thr_watch", { method: "notifications/resources/updated" })).rejects.toThrow("loaded native");
  const started = adapter.startSession({ agent: "codex", cwd: "/repo" });
  await waitFor(() => fake.writes[0], "initialize");
  fake.enqueue({ id: 0, result: {} });
  await waitFor(() => fake.writes[2], "start thread");
  fake.enqueue({ id: 1, result: { thread: { id: "thr_watch", cwd: "/repo" } } });
  await started;
  expect(adapter.canReceiveExternalEvents("thr_watch")).toBe(true);
  const notification = { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "treetop://terminals/test/output" } };
  const delivered = adapter.notifyExternalEvent("thr_watch", notification);
  await waitFor(() => fake.writes[3], "external event delivery");
  const frame = parseWrite(fake.writes, 3);
  expect(frame.method).toBe("turn/start");
  const params = frame.params as Record<string, unknown>;
  expect(params.input).toEqual([]);
  expect(params.toolOutput).toEqual({ namespace: "treetop", name: "resource_notification", output: JSON.stringify(notification) });
  expect(params.text).toBeUndefined();
  fake.enqueue({ id: frame.id, result: { turn: { id: "turn_event" } } });
  await delivered;
  await adapter.close();
});

test("CLI events attach only to an already loaded thread and use external tool output", async () => {
  const fake = fakeCodexProcess();
  const adapter = new CodexCliEventAdapter({ connect: async () => fake.proc });
  const eligible = adapter.canReceiveExternalEvents("cli-thread");
  await waitFor(() => fake.writes[0], "CLI initialize");
  fake.enqueue({ id: 0, result: {} });
  await waitFor(() => fake.writes[2], "CLI loaded threads");
  expect(parseWrite(fake.writes, 2).method).toBe("thread/loaded/list");
  fake.enqueue({ id: 1, result: { data: ["cli-thread"], nextCursor: null } });
  expect(await eligible).toBe(true);
  const notification = { method: "notifications/resources/updated", params: { uri: "treetop://terminals/test/output" } };
  const delivery = adapter.notifyExternalEvent("cli-thread", notification);
  await waitFor(() => fake.writes[3], "CLI delivery eligibility");
  fake.enqueue({ id: 2, result: { data: ["cli-thread"], nextCursor: null } });
  await waitFor(() => fake.writes[4], "CLI event");
  expect(parseWrite(fake.writes, 4)).toMatchObject({ method: "turn/start", params: {
    threadId: "cli-thread", input: [], toolOutput: { namespace: "treetop", name: "resource_notification", output: JSON.stringify(notification) },
  } });
  fake.enqueue({ id: 3, result: { turn: { id: "external-turn" } } });
  await delivery;
  const missing = adapter.notifyExternalEvent("closed-thread", notification);
  await waitFor(() => fake.writes[5], "closed CLI thread check");
  fake.enqueue({ id: 4, result: { data: [], nextCursor: null } });
  await expect(missing).rejects.toThrow("not loaded");
  expect(fake.writes).toHaveLength(6);
  expect(fake.writes.some(raw => /thread\/resume|turn\/steer/.test(raw))).toBe(false);
  await adapter.close();
  expect(fake.killed).toEqual(["SIGTERM"]);
});

test.each(["inProgress", "completed"])("CLI Stop interrupts only its loaded active turn (%s)", async (status) => {
  const fake = fakeCodexProcess();
  const adapter = new CodexCliEventAdapter({ connect: async () => fake.proc });
  const stopping = adapter.interruptActiveTurn("cli-stop");
  await waitFor(() => fake.writes[0], "CLI initialize");
  fake.enqueue({ id: 0, result: {} });
  await waitFor(() => fake.writes[2], "loaded thread check");
  fake.enqueue({ id: 1, result: { data: ["cli-stop", "another-cli"], nextCursor: null } });
  await waitFor(() => fake.writes[3], "latest turn");
  expect(parseWrite(fake.writes, 3)).toMatchObject({ method: "thread/turns/list", params: {
    threadId: "cli-stop", limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  } });
  fake.enqueue({ id: 2, result: { data: [{ id: "owned-turn", status }], nextCursor: null } });
  if (status === "inProgress") {
    await waitFor(() => fake.writes[4], "interrupt active CLI turn");
    expect(parseWrite(fake.writes, 4)).toMatchObject({ method: "turn/interrupt", params: { threadId: "cli-stop", turnId: "owned-turn" } });
    fake.enqueue({ id: 3, result: {} });
  }
  await stopping;
  expect(fake.writes).toHaveLength(status === "inProgress" ? 5 : 4);
  await adapter.close();
});

test("CLI Stop does not resume an unloaded conversation", async () => {
  const fake = fakeCodexProcess();
  const adapter = new CodexCliEventAdapter({ connect: async () => fake.proc });
  const stopping = adapter.interruptActiveTurn("unloaded");
  await waitFor(() => fake.writes[0], "CLI initialize");
  fake.enqueue({ id: 0, result: {} });
  await waitFor(() => fake.writes[2], "loaded thread check");
  fake.enqueue({ id: 1, result: { data: [], nextCursor: null } });
  await stopping;
  expect(fake.writes).toHaveLength(3);
  await adapter.close();
});

test("terminal Stop waits for the Codex interrupt before killing its client and preserves it on failure", async () => {
  const adapter = new CodexCliEventAdapter();
  const calls: string[] = [];
  let release!: () => void;
  adapter.interruptActiveTurn = async (id) => {
    calls.push(id);
    await new Promise<void>(resolve => { release = resolve; });
  };
  const record = { agent: "codex", ownerId: "owned-cli", cmd: ["codex", "--remote", "unix://"] };
  const stopping = adapter.stopTerminal(record, async () => { calls.push("kill"); });
  expect(calls).toEqual(["owned-cli"]);
  release();
  await stopping;
  expect(calls).toEqual(["owned-cli", "kill"]);
  adapter.interruptActiveTurn = async () => { throw new Error("interrupt failed"); };
  await expect(adapter.stopTerminal(record, async () => { calls.push("bad-kill"); })).rejects.toThrow("interrupt failed");
  expect(calls).toEqual(["owned-cli", "kill"]);
  await adapter.stopTerminal({ agent: "shell", cmd: ["pwsh"] }, async () => { calls.push("shell-kill"); });
  expect(calls.at(-1)).toBe("shell-kill");
  await expect(adapter.stopTerminal({ ...record, ownerId: "__new__:codex:fresh" }, async () => { calls.push("guessed-kill"); })).rejects.toThrow("no resolved conversation ID");
  expect(calls).not.toContain("guessed-kill");
});

test("CLI event connector negotiates WebSocket and closes only its own connection", async () => {
  const frames: Record<string, any>[] = [];
  const daemon = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, raw) {
      const frame = JSON.parse(String(raw)); frames.push(frame);
      if (frame.id === undefined) return;
      const result = frame.method === "thread/loaded/list" ? { data: ["cli-live"], nextCursor: null } : {};
      ws.send(JSON.stringify({ id: frame.id, result }));
    } },
  });
  const adapter = new CodexCliEventAdapter({ connect: () => connectCodexCliEventProcess({
    upstream: () => createConnection({ port: daemon.port!, host: "127.0.0.1" }), timeoutMs: 1000,
  }) });
  try {
    expect(await adapter.canReceiveExternalEvents("cli-live")).toBe(true);
    await adapter.notifyExternalEvent("cli-live", { method: "notifications/resources/updated" });
    expect(frames.filter(frame => frame.method === "turn/start")).toHaveLength(1);
    expect(frames.at(-1)?.params.input).toEqual([]);
    expect(frames.at(-1)?.params.toolOutput.namespace).toBe("treetop");
    await adapter.close();
    const response = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(response.status).toBe(400);
  } finally { await adapter.close(); await daemon.stop(true); }
});


test("CLI identity proxy links only its own startup response without relying on log records", async () => {
  const fake = fakeCodexProcess();
  const identities: string[] = [];
  const proxy = await createCodexCliIdentityProxy({connect:async()=>fake.proc,onSession:id=>{identities.push(id);}});
  const ws = new WebSocket(proxy.url);
  const opened = new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('proxy connection failed'));});
  const received: Record<string,any>[] = [];
  ws.onmessage = event => received.push(JSON.parse(String(event.data)));
  try {
    expect((await fetch(proxy.url.replace('ws:', 'http:').replace(/\/[^/]+$/, '/wrong'))).status).toBe(404);
    await opened;
    const init = {id:0,method:'initialize',params:{clientInfo:{name:'codex_cli'}}};
    ws.send(JSON.stringify(init));
    await waitFor(()=>fake.writes[0],'forward initialize');
    expect(parseWrite(fake.writes,0)).toEqual(init);
    fake.enqueue({id:0,result:{}});
    await waitFor(()=>received[0],'initialize reply');
    fake.enqueue({method:'thread/started',params:{thread:{id:'unrelated-thread'}}});
    fake.enqueue({id:77,result:{thread:{id:'not-requested'}}});
    ws.send(JSON.stringify({id:'start',method:'thread/start',params:{cwd:'/repo'}}));
    await waitFor(()=>fake.writes[1],'forward startup');
    fake.enqueue({id:'start',result:{thread:{id:'exact-cli-thread',cwd:'/repo'}}});
    await waitFor(()=>identities[0],'exact identity');
    expect(identities).toEqual(['exact-cli-thread']);
    await waitFor(()=>received.find(row=>row.id==='start'),'unchanged startup reply');
    expect(received.find(row=>row.id==='start')).toEqual({id:'start',result:{thread:{id:'exact-cli-thread',cwd:'/repo'}}});
    expect(fake.writes).toHaveLength(2);
  } finally { proxy.close(); ws.close(); }
  expect(fake.killed).toHaveLength(1);
});


test("Stop on a private CLI identity transport still interrupts the real turn before closing the terminal", async () => {
  const adapter = new CodexCliEventAdapter();
  const calls: string[] = [];
  adapter.interruptActiveTurn = async id => {calls.push(id);};
  await adapter.stopTerminal({agent:'codex',ownerId:'owned-thread',cmd:['codex','--remote','ws://127.0.0.1:12345/treetop-cli-01234567-89ab-cdef-0123-456789abcdef']},async()=>{calls.push('kill');});
  expect(calls).toEqual(['owned-thread','kill']);
});


test("new CLI spawn keeps the same terminal and binds its exact startup identity, closing only its transport on exit", async () => {
  const fake = fakeCodexProcess();
  let spawned: import('../src/terminals/types').SpawnOptions | undefined;
  let exit!: () => void;
  const bound: string[] = [];
  const handle = {id:'same-terminal',isAlive:()=>true,bindSessionOwner:(id:string)=>{bound.push(id);},
    subscribe:(subscriber:any)=>{exit=()=>subscriber.onExit({code:0});return ()=>{};}} as unknown as import('../src/terminals/types').TerminalHandle;
  const options = {cmd:['codex','--remote','unix://','-c','model="chosen"'],cwd:'/repo',size:{cols:80,rows:24},agent:'codex',ownerId:'__new__:codex:client'};
  const result = await spawnCodexTerminalWithIdentity({spawn:async value=>{spawned=value;return handle;}},options,()=>{},async()=>fake.proc);
  expect(result).toBe(handle);
  expect(spawned!.resumeCmd).toEqual(options.cmd);
  expect(options.cmd[2]).toBe('unix://');
  expect(spawned!.cmd.slice(3)).toEqual(options.cmd.slice(3));
  const ws = new WebSocket(spawned!.cmd[2]!);
  try {
    await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('proxy connection failed'));});
    ws.send(JSON.stringify({id:1,method:'thread/start',params:{cwd:'/repo'}}));
    await waitFor(()=>fake.writes[0],'CLI startup');
    fake.enqueue({id:1,result:{thread:{id:'real-session'}}});
    await waitFor(()=>bound[0],'bind terminal');
    expect(bound).toEqual(['real-session']);
    exit();
    await waitFor(()=>fake.killed.length ? true : undefined,'terminal exit transport cleanup');
    expect(fake.killed).toHaveLength(1);
  } finally {exit();ws.close();}
});


test("failed CLI spawn releases its private transport without starting a conversation", async () => {
  const fake = fakeCodexProcess();
  await expect(spawnCodexTerminalWithIdentity({spawn:async()=>{throw new Error('PTY failed');}},
    {cmd:['codex','--remote','unix://'],agent:'codex',ownerId:'__new__:codex:new',cwd:'/repo',size:{cols:80,rows:24}},
    ()=>{},async()=>fake.proc)).rejects.toThrow('PTY failed');
  expect(fake.killed).toHaveLength(1);
  expect(fake.writes).toHaveLength(0);
});
