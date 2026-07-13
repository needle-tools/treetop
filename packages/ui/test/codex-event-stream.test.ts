import { beforeEach, describe, expect, test } from "bun:test";
import {
  CODEX_APP_HISTORY_TURNS_PAGE_SIZE,
  __resetCodexEventStreamsForTests,
  __setCodexEventSourceCtorForTests,
  canRequestOlderCodexAppThreadHistory,
  codexAppHistoryMessagesFromThread,
  codexAppHistoryMessagesFromTurnPage,
  codexLiveMessagesFromEvent,
  codexLiveMarkerFromEvent,
  codexLiveToolResultFromEvent,
  codexLiveToolUseFromEvent,
  codexAppHistoryKey,
  codexToolInputQuality,
  codexEventThreadIdForSession,
  mergeCodexAppHistoryMessages,
  shouldLoadCodexAppThreadHistory,
  subscribeCodexEvents,
  type CodexAppEvent,
  type CodexEventStreamState,
} from "../src/codex-event-stream";
import {
  buildVisualTranscriptItems,
  buildVisualWorkDisplayEntries,
  visualSubagentMetaFromBlocks,
  visualWorkSummary,
} from "../src/last-user-message";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(evt: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (evt: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function event(threadId: string, seq: number): CodexAppEvent {
  return {
    kind: "notification",
    method: "turn/status",
    params: { active: true },
    threadId,
    receivedAt: "2026-06-18T00:00:00.000Z",
    seq,
  };
}

describe("codex event stream hub", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    __resetCodexEventStreamsForTests();
    __setCodexEventSourceCtorForTests(FakeEventSource);
  });

  test("shares one EventSource for multiple subscribers on the same daemon and thread", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    const offA = subscribeCodexEvents(undefined, "t1", {
      onEvent: (e) => a.push(e),
    });
    const offB = subscribeCodexEvents(undefined, "t1", {
      onEvent: (e) => b.push(e),
    });

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/codex-app/events");

    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([1]);

    offA();
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    offB();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  test("keeps one shared stream per daemon, not per thread", () => {
    subscribeCodexEvents(undefined, "t1", { onEvent: () => {} });
    subscribeCodexEvents(undefined, "t2", { onEvent: () => {} });
    subscribeCodexEvents("remote-1", "t1", { onEvent: () => {} });

    expect(FakeEventSource.instances.map((es) => es.url)).toEqual([
      "/api/codex-app/events",
      "/api/daemons/remote-1/codex-app/events",
    ]);
  });

  test("filters shared daemon events by subscriber thread", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    subscribeCodexEvents(undefined, "t1", { onEvent: (e) => a.push(e) });
    subscribeCodexEvents(undefined, "t2", { onEvent: (e) => b.push(e) });

    expect(FakeEventSource.instances.length).toBe(1);
    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    FakeEventSource.instances[0]?.emit("codex", event("t2", 2));
    FakeEventSource.instances[0]?.emit("codex", {
      kind: "notification",
      method: "mcpServer/startupStatus/updated",
      params: { name: "server", status: "starting" },
      receivedAt: "2026-06-18T00:00:00.000Z",
      seq: 3,
    });

    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([2]);
  });

  test("replays hub history to later subscribers", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    subscribeCodexEvents(undefined, "t1", { onEvent: (e) => a.push(e) });
    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    FakeEventSource.instances[0]?.emit("codex", event("t2", 2));
    subscribeCodexEvents(undefined, "t1", { onEvent: (e) => b.push(e) });

    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([1]);
  });

  test("reports connection state to each subscriber", () => {
    const states: CodexEventStreamState[] = [];

    subscribeCodexEvents(undefined, "t1", { onState: (s) => states.push(s) });
    FakeEventSource.instances[0]?.onopen?.();
    FakeEventSource.instances[0]?.onerror?.();

    expect(states).toEqual(["connecting", "live", "reconnecting"]);
  });

  test("opens app-server events only for live Codex app read sessions", () => {
    expect(
      codexEventThreadIdForSession({
        agent: "codex",
        mode: "read",
        sessionId: "thread-1",
        liveCodexApp: true,
      }),
    ).toBe("thread-1");
    expect(
      codexEventThreadIdForSession({
        agent: "codex",
        mode: "read",
        sessionId: "historical-codex-jsonl",
        liveCodexApp: false,
      }),
    ).toBeUndefined();
    expect(
      codexEventThreadIdForSession({
        agent: "codex",
        mode: "terminal",
        sessionId: "thread-1",
        liveCodexApp: true,
      }),
    ).toBeUndefined();
  });

  test("loads app-server history once the visual pane has thread, cwd, and synthetic session", () => {
    const key = codexAppHistoryKey("thread-1", "/repo");
    expect(
      shouldLoadCodexAppThreadHistory({
        visualAppSurface: true,
        threadId: "thread-1",
        cwd: "/repo",
        hasSession: true,
        loadedHistoryKey: "",
        loadingHistoryKey: "",
      }),
    ).toBe(true);
    expect(
      shouldLoadCodexAppThreadHistory({
        visualAppSurface: true,
        threadId: "thread-1",
        cwd: "/repo",
        hasSession: true,
        loadedHistoryKey: key,
        loadingHistoryKey: "",
      }),
    ).toBe(false);
    expect(
      shouldLoadCodexAppThreadHistory({
        visualAppSurface: true,
        threadId: "thread-1",
        cwd: "/repo",
        hasSession: true,
        loadedHistoryKey: "",
        loadingHistoryKey: key,
      }),
    ).toBe(false);
    expect(
      shouldLoadCodexAppThreadHistory({
        visualAppSurface: false,
        threadId: "thread-1",
        cwd: "/repo",
        hasSession: true,
        loadedHistoryKey: "",
        loadingHistoryKey: "",
      }),
    ).toBe(false);
  });

  test("pages older app-server history from the app-server cursor, not loaded message count", () => {
    expect(CODEX_APP_HISTORY_TURNS_PAGE_SIZE).toBeLessThan(100);
    expect(
      canRequestOlderCodexAppThreadHistory({
        threadId: "thread-1",
        cwd: "/repo",
        nextCursor: "older-page",
      }),
    ).toBe(true);
    expect(
      canRequestOlderCodexAppThreadHistory({
        threadId: "thread-1",
        cwd: "/repo",
        nextCursor: null,
      }),
    ).toBe(false);
    expect(
      canRequestOlderCodexAppThreadHistory({
        threadId: undefined,
        cwd: "/repo",
        nextCursor: "older-page",
      }),
    ).toBe(false);
  });

  test("normalizes live command item events into paired tool-use rows", () => {
    const start: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "call-1",
          command: "/bin/zsh -lc 'rg visual transcript packages/ui/src'",
          cwd: "/repo",
          processId: "123",
          status: "inProgress",
          aggregatedOutput: null,
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };
    const output: CodexAppEvent = {
      kind: "notification",
      method: "item/commandExecution/outputDelta",
      params: { itemId: "call-1", delta: "stdout chunk" },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:01.000Z",
    };

    expect(codexLiveToolUseFromEvent(start)).toEqual({
      id: "codex-tool-call-1",
      toolName: "exec_command",
      toolInput: {
        command: "/bin/zsh -lc 'rg visual transcript packages/ui/src'",
        cwd: "/repo",
      },
      toolUseId: "call-1",
      inputQuality: 3,
    });
    expect(codexLiveToolUseFromEvent(output)).toEqual({
      id: "codex-tool-call-1",
      toolName: "exec_command",
      toolInput: undefined,
      toolUseId: "call-1",
      inputQuality: 0,
    });
    expect(
      codexToolInputQuality(codexLiveToolUseFromEvent(start)?.toolInput),
    ).toBeGreaterThan(
      codexToolInputQuality(codexLiveToolUseFromEvent(output)?.toolInput),
    );
  });

  test("normalizes response-style exec tool calls into command tool rows", () => {
    const start: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          type: "function_call",
          id: "call-exec",
          call_id: "call-exec",
          name: "exec",
          arguments: JSON.stringify({
            cmd: "sed -n '1,120p' src/TextureGenerator.js",
            workdir: "/repo",
          }),
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };
    const result: CodexAppEvent = {
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          type: "function_call_output",
          call_id: "call-exec",
          output: "Chunk ID: abc123\nWall time: 0.1234 seconds\nOutput:\nimport three",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:01.000Z",
    };

    const context = {};
    expect(codexLiveToolUseFromEvent(start, context)).toEqual({
      id: "codex-tool-call-exec",
      toolName: "exec_command",
      toolInput: {
        cmd: "sed -n '1,120p' src/TextureGenerator.js",
        workdir: "/repo",
      },
      toolUseId: "call-exec",
      inputQuality: 3,
    });
    expect(codexLiveToolResultFromEvent(result, context)).toEqual({
      id: "codex-output-call-exec",
      toolName: "exec_command",
      toolUseId: "call-exec",
      text: "Chunk ID: abc123\nWall time: 0.1234 seconds\nOutput:\nimport three",
    });
    expect(codexLiveMessagesFromEvent(result, context)[0]?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "exec_command",
      toolUseId: "call-exec",
    });
  });

  test("normalizes live Codex Desktop custom-tool JavaScript wrappers", () => {
    const start: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          type: "custom_tool_call",
          id: "call-js-wrapper",
          call_id: "call-js-wrapper",
          name: "exec",
          input:
            'const r = await tools.exec_command({cmd:"npm run check",workdir:"/repo",yield_time_ms:10000,max_output_tokens:12000}); text(r.output);',
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(start)).toEqual({
      id: "codex-tool-call-js-wrapper",
      toolName: "exec_command",
      toolInput: {
        cmd: "npm run check",
        workdir: "/repo",
        yield_time_ms: 10000,
        max_output_tokens: 12000,
      },
      toolUseId: "call-js-wrapper",
      inputQuality: 5,
    });
  });

  test("normalizes completed live command item snapshots into tool results", () => {
    const completed: CodexAppEvent = {
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "call-1",
          command: "git diff -- packages/ui/src/SessionView.svelte",
          cwd: "/repo",
          status: "completed",
          aggregatedOutput: "diff --git a/packages/ui/src/SessionView.svelte",
          durationMs: 154,
          exitCode: 0,
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:02.000Z",
    };

    expect(codexLiveToolResultFromEvent(completed)).toEqual({
      id: "codex-output-call-1",
      toolName: "exec_command",
      toolUseId: "call-1",
      text: "Exit code: 0\nWall time: 0.1540 seconds\nOutput:\ndiff --git a/packages/ui/src/SessionView.svelte",
    });
  });

  test("normalizes unretryable context-window errors into failed turn markers", () => {
    const event: CodexAppEvent = {
      kind: "notification",
      method: "error",
      params: {
        error: {
          message:
            "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
          codexErrorInfo: "contextWindowExceeded",
          additionalDetails: null,
        },
        willRetry: false,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-30T04:22:46.776Z",
    };

    expect(codexLiveMarkerFromEvent(event)).toEqual({
      id: "codex-marker-turn-1",
      text: "[Turn failed: Context window exceeded]",
    });
  });

  test("normalizes live app-server compaction events into context markers", () => {
    const event: CodexAppEvent = {
      kind: "notification",
      method: "context_compacted",
      params: {
        type: "context_compacted",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-30T04:22:46.776Z",
      seq: 42,
    };

    expect(codexLiveMarkerFromEvent(event)).toEqual({
      id: "codex-marker-turn-1-context-42",
      text: "[Context compacted]",
    });
    expect(codexLiveMessagesFromEvent(event)).toEqual([
      {
        id: "codex-marker-turn-1-context-42",
        role: "system",
        timestamp: "2026-06-30T04:22:46.776Z",
        blocks: [{ type: "marker", text: "[Context compacted]" }],
      },
    ]);
  });

  test("keeps completed commands with empty output visible", () => {
    const messages = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "call-empty",
              type: "commandExecution",
              command: "git diff --check",
              status: "completed",
              aggregatedOutput: "",
              durationMs: 12,
              exitCode: 0,
            },
          ],
        },
      ],
    });

    expect(messages.at(-1)).toEqual({
      id: "codex-output-call-empty",
      role: "tool",
      timestamp: undefined,
      blocks: [
        {
          type: "tool_result",
          toolName: "exec_command",
          toolUseId: "call-empty",
          text: "Exit code: 0\nWall time: 0.0120 seconds\nOutput:\n",
        },
      ],
    });
  });

  test("keeps immediately completed commands visible without timing fields", () => {
    const completed: CodexAppEvent = {
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "call-immediate",
          command: "true",
          cwd: "/repo",
          status: "completed",
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:02.000Z",
    };

    expect(codexLiveToolResultFromEvent(completed)).toEqual({
      id: "codex-output-call-immediate",
      toolName: "exec_command",
      toolUseId: "call-immediate",
      text: "Exit code: 0\nWall time: 0.0000 seconds\nOutput:\n",
    });
  });

  test("normalizes command approval request payloads as command input", () => {
    const request: CodexAppEvent = {
      kind: "request",
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "call-2",
        command: "bun test",
        cwd: "/repo",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(request)).toEqual({
      id: "codex-tool-call-2",
      toolName: "exec_command",
      toolInput: {
        command: "bun test",
        cwd: "/repo",
      },
      toolUseId: "call-2",
      inputQuality: 3,
    });
  });

  test("normalizes live dynamic tool-call requests before item snapshots arrive", () => {
    const request: CodexAppEvent = {
      kind: "request",
      id: 101,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-logs",
        namespace: null,
        tool: "write_stdin",
        arguments: {
          session_id: 55249,
          chars: "",
          yield_time_ms: 5000,
          max_output_tokens: 8000,
        },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(request)).toEqual({
      id: "codex-tool-call-logs",
      toolName: "write_stdin",
      toolInput: {
        session_id: 55249,
        chars: "",
        yield_time_ms: 5000,
        max_output_tokens: 8000,
      },
      toolUseId: "call-logs",
      inputQuality: 3,
    });
    expect(codexLiveMessagesFromEvent(request)).toEqual([
      {
        id: "codex-tool-call-logs",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "write_stdin",
            toolInput: {
              session_id: 55249,
              chars: "",
              yield_time_ms: 5000,
              max_output_tokens: 8000,
            },
            toolUseId: "call-logs",
          },
        ],
      },
    ]);
  });

  test("preserves command approval metadata on live command items", () => {
    const event: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        itemId: "call-approved",
        item: {
          id: "call-approved",
          type: "commandExecution",
          command: "git status --short",
          cwd: "/repo",
          approvalPolicy: "on-request",
          approvalDecision: "approved",
          sandboxPolicy: { type: "workspace-write" },
        },
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(event)).toMatchObject({
      toolName: "exec_command",
      toolUseId: "call-approved",
      approvalPolicy: "on-request",
      approvalDecision: "approved",
      sandboxPolicy: "workspace-write",
    });
  });

  test("normalizes live file-change events without dropping the patch payload", () => {
    const event: CodexAppEvent = {
      kind: "notification",
      method: "item/fileChange/patchUpdated",
      params: {
        itemId: "patch-1",
        changes: [{ path: "packages/ui/src/SessionView.svelte" }],
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(event)).toEqual({
      id: "codex-file-patch-1",
      toolName: "file change",
      toolInput: [{ path: "packages/ui/src/SessionView.svelte" }],
      toolUseId: "patch-1",
      inputQuality: 1,
    });
  });

  test("normalizes live view_image tool events into visible media", () => {
    const event: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          id: "view-1",
          type: "dynamicToolCall",
          tool: "view_image",
          arguments: JSON.stringify({
            path: "/tmp/asset-preview.png",
            detail: "high",
          }),
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(event)).toEqual({
      id: "codex-tool-view-1",
      toolName: "view_image",
      toolInput: {
        path: "/tmp/asset-preview.png",
        detail: "high",
      },
      toolUseId: "view-1",
      inputQuality: 2,
      mediaBlock: {
        type: "media",
        mediaKind: "image",
        path: "/tmp/asset-preview.png",
        title: "asset-preview.png",
        alt: "asset-preview.png",
      },
    });
  });

  test("normalizes app-server thread/read turns into visual transcript messages", () => {
    const messages = codexAppHistoryMessagesFromThread({
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          startedAt: 1782122400,
          status: "completed",
          itemsView: "full",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                { type: "localImage", path: "/tmp/input.png" },
                { type: "text", text: "please inspect this" },
              ],
            },
            {
              id: "call-1",
              type: "commandExecution",
              command: "rg visual packages/ui/src",
              cwd: "/repo",
              commandActions: [],
              status: "completed",
              aggregatedOutput: "packages/ui/src/SessionView.svelte",
              durationMs: 42,
              exitCode: 0,
            },
            {
              id: "agent-1",
              type: "agentMessage",
              text: "Found it.",
            },
          ],
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "codex-user-user-1",
        role: "user",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "media",
            mediaKind: "image",
            path: "/tmp/input.png",
            title: "Image",
            alt: "Image",
          },
          { type: "text", text: "please inspect this" },
        ],
      },
      {
        id: "codex-tool-call-1",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolInput: {
              command: "rg visual packages/ui/src",
              cwd: "/repo",
              commandActions: [],
            },
            toolUseId: "call-1",
          },
        ],
      },
      {
        id: "codex-output-call-1",
        role: "tool",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "tool_result",
            toolName: "exec_command",
            toolUseId: "call-1",
            text: "Exit code: 0\nWall time: 0.0420 seconds\nOutput:\npackages/ui/src/SessionView.svelte",
          },
        ],
      },
      {
        id: "codex-agent-agent-1",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [{ type: "text", text: "Found it." }],
      },
    ]);
  });

  test("normalizes app-server paged turns from newest-first to chronological messages", () => {
    const messages = codexAppHistoryMessagesFromTurnPage({
      id: "thread-1",
      turns: [
        {
          id: "turn-newer",
          startedAt: 1782122460,
          items: [
            {
              id: "user-newer",
              type: "userMessage",
              content: [{ type: "text", text: "newer turn" }],
            },
          ],
        },
        {
          id: "turn-older",
          startedAt: 1782122400,
          items: [
            {
              id: "user-older",
              type: "userMessage",
              content: [{ type: "text", text: "older turn" }],
            },
          ],
        },
      ],
    });

    expect(messages.map((message) => message.id)).toEqual([
      "codex-user-user-older",
      "codex-user-user-newer",
    ]);
  });

  test("prepends older app-server turn pages without dropping live/newer rows", () => {
    const newer = codexAppHistoryMessagesFromTurnPage({
      turns: [
        {
          id: "turn-newer",
          startedAt: 1782122460,
          items: [
            {
              id: "user-newer",
              type: "userMessage",
              content: [{ type: "text", text: "newer turn" }],
            },
          ],
        },
      ],
    });
    const older = codexAppHistoryMessagesFromTurnPage({
      turns: [
        {
          id: "turn-older",
          startedAt: 1782122400,
          items: [
            {
              id: "user-older",
              type: "userMessage",
              content: [{ type: "text", text: "older turn" }],
            },
          ],
        },
      ],
    });
    const liveTail = {
      id: "live-tail",
      role: "assistant" as const,
      blocks: [{ type: "text" as const, text: "still running" }],
    };

    const merged = mergeCodexAppHistoryMessages(older, [
      ...newer,
      liveTail,
    ]);

    expect(merged.map((message) => message.id)).toEqual([
      "codex-user-user-older",
      "codex-user-user-newer",
      "live-tail",
    ]);
  });

  test("normalizes completed app-server history and live item snapshots to the same visual contract", () => {
    const timestamp = "2026-06-22T10:00:00.000Z";
    const commandItem = {
      id: "call-1",
      type: "commandExecution",
      command: "rg visual packages/ui/src",
      cwd: "/repo",
      commandActions: [],
      status: "completed",
      aggregatedOutput: "packages/ui/src/SessionView.svelte",
      durationMs: 42,
      exitCode: 0,
      approvalPolicy: "on-request",
      approvalDecision: "approved",
      sandboxPolicy: { type: "workspace-write" },
    };
    const history = codexAppHistoryMessagesFromThread({
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          startedAt: 1782122400,
          status: "completed",
          itemsView: "full",
          items: [commandItem],
        },
      ],
    });
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/completed",
      params: {
        item: commandItem,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: timestamp,
    });

    expect(live).toEqual(history);

    const user = {
      id: "codex-user-user-1",
      role: "user" as const,
      timestamp,
      blocks: [{ type: "text" as const, text: "please inspect this" }],
    };
    const response = {
      id: "codex-agent-agent-1",
      role: "assistant" as const,
      timestamp,
      blocks: [{ type: "text" as const, text: "Found it." }],
    };

    expect(
      visualContract(buildVisualTranscriptItems([user, ...live, response])),
    ).toEqual(
      visualContract(buildVisualTranscriptItems([user, ...history, response])),
    );
  });

  test("normalizes app-server history and live view_image snapshots to the same visual contract", () => {
    const viewImageItem = {
      id: "view-1",
      type: "dynamicToolCall",
      tool: "view_image",
      arguments: JSON.stringify({
        path: "/tmp/asset-preview.png",
        detail: "high",
      }),
    };
    const history = codexAppHistoryMessagesFromThread({
      turns: [{ id: "turn-1", items: [viewImageItem] }],
    });
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/started",
      params: {
        item: viewImageItem,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    });

    expect(stripTimestamps(live)).toEqual(stripTimestamps(history));
    const user = {
      role: "user" as const,
      blocks: [{ type: "text" as const, text: "show it" }],
    };
    expect(
      visualContract(buildVisualTranscriptItems([user, ...live])),
    ).toEqual(
      visualContract(buildVisualTranscriptItems([user, ...history])),
    );
  });

  test("normalizes app-server subagent history and live snapshots to the same visual contract", () => {
    const subagentId = "019f27fe-0f3d-7a50-8371-3344fbaee5d0";
    const spawnItem = {
      id: "call-spawn",
      type: "dynamicToolCall",
      tool: "spawn_agent",
      arguments: {
        agent_type: "explorer",
        model: "gpt-5.5",
        reasoning_effort: "xhigh",
        message: "Inspect OpenUSD material imports.",
      },
      result: {
        agent_id: subagentId,
        nickname: "Leibniz",
      },
    };
    const waitItem = {
      id: "call-wait",
      type: "dynamicToolCall",
      tool: "wait_agent",
      arguments: {
        targets: [subagentId],
        timeout_ms: 3600000,
      },
      result: {
        status: {
          [subagentId]: {
            completed: "**Findings**\n\n- First finding.",
          },
        },
      },
    };
    const history = codexAppHistoryMessagesFromThread({
      turns: [{ id: "turn-1", items: [spawnItem, waitItem] }],
    });
    const spawnStartedItem = { ...spawnItem };
    delete (spawnStartedItem as Partial<typeof spawnItem>).result;
    const liveStart = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/started",
      params: {
        item: spawnStartedItem,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T09:59:59.000Z",
    });
    expect(liveStart).toEqual([
      {
        id: "codex-tool-call-spawn",
        role: "assistant",
        timestamp: "2026-06-22T09:59:59.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "spawn_agent",
            toolInput: spawnItem.arguments,
            toolUseId: "call-spawn",
            subagentAction: "spawn",
            subagentStatus: "running",
            subagentType: "explorer",
            subagentModel: "gpt-5.5",
            subagentEffort: "xhigh",
            subagentMessage: "Inspect OpenUSD material imports.",
          },
        ],
      },
    ]);
    const live = [
      ...codexLiveMessagesFromEvent({
        kind: "notification",
        method: "item/completed",
        params: {
          item: spawnItem,
          threadId: "thread-1",
          turnId: "turn-1",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-06-22T10:00:00.000Z",
      }),
      ...codexLiveMessagesFromEvent({
        kind: "notification",
        method: "item/completed",
        params: {
          item: waitItem,
          threadId: "thread-1",
          turnId: "turn-1",
        },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-06-22T10:00:01.000Z",
      }),
    ];

    expect(stripTimestamps(live)).toEqual(stripTimestamps(history));

    const historyEntries = buildVisualWorkDisplayEntries(
      buildVisualTranscriptItems([
        { role: "user", blocks: [{ type: "text", text: "start" }] },
        ...history,
      ]).find((item) => item.kind === "work")?.entries ?? [],
    );
    const spawn = historyEntries.find(
      (entry) => entry.entry.blocks[0]?.toolName === "spawn_agent",
    );
    const wait = historyEntries.find(
      (entry) => entry.entry.blocks[0]?.toolName === "wait_agent",
    );
    expect(
      visualSubagentMetaFromBlocks(
        spawn?.entry.blocks[0],
        spawn?.pairedResult?.blocks[0],
      ),
    ).toMatchObject({
      action: "spawn",
      id: subagentId,
      nickname: "Leibniz",
      type: "explorer",
    });
    expect(
      visualSubagentMetaFromBlocks(
        wait?.entry.blocks[0],
        wait?.pairedResult?.blocks[0],
      ),
    ).toMatchObject({
      action: "wait",
      status: "completed",
      id: subagentId,
      result: "**Findings**\n\n- First finding.",
    });
  });

  test("normalizes response-style app-server subagent calls into visible work entries", () => {
    const subagentId = "019f2814-918b-7ba2-bc07-ed683bb1a769";
    const spawnCall = {
      id: "call-spawn",
      call_id: "call-spawn",
      type: "function_call",
      name: "spawn_agent",
      arguments: JSON.stringify({
        agent_type: "explorer",
        model: "gpt-5.5",
        reasoning_effort: "xhigh",
        message: "Compare hdEmscripten against hdStorm.",
      }),
    };
    const spawnOutput = {
      call_id: "call-spawn",
      type: "function_call_output",
      output: JSON.stringify({
        agent_id: subagentId,
        nickname: "Aristotle",
      }),
    };
    const waitCall = {
      id: "call-wait",
      call_id: "call-wait",
      type: "function_call",
      name: "wait_agent",
      arguments: JSON.stringify({
        targets: [subagentId],
        timeout_ms: 3600000,
      }),
    };
    const waitOutput = {
      call_id: "call-wait",
      type: "function_call_output",
      output: JSON.stringify({
        status: {
          [subagentId]: {
            completed: "Fresh subagent found five remaining differences.",
          },
        },
      }),
    };
    const notificationText =
      "<subagent_notification>\n" +
      JSON.stringify({
        agent_path: subagentId,
        status: {
          completed: "Fresh subagent found five remaining differences.",
        },
      }) +
      "\n</subagent_notification>";
    const history = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-1",
          startedAt: 1782122400,
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                {
                  type: "text",
                  text: "Let a strong subagent compare the implementations.",
                },
              ],
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "I’ll do another clean-room pass with a fresh strong explorer.",
            },
            spawnCall,
            spawnOutput,
            {
              id: "assistant-2",
              type: "agentMessage",
              text: "Aristotle is running independently now.",
            },
            waitCall,
            waitOutput,
            {
              id: "subagent-notification",
              type: "userMessage",
              content: [{ type: "text", text: notificationText }],
            },
            {
              id: "assistant-3",
              type: "agentMessage",
              text: "Fresh subagent found five remaining differences.",
            },
          ],
        },
      ],
    });

    const items = buildVisualTranscriptItems(history);
    const work = items.find((item) => item.kind === "work");
    expect(work?.kind).toBe("work");
    if (!work || work.kind !== "work") return;
    expect(visualWorkSummary(work.entries)).toMatchObject({
      subagents: 1,
    });
    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    const spawn = displayEntries.find(
      (entry) => entry.entry.blocks[0]?.toolName === "spawn_agent",
    );
    const wait = displayEntries.find(
      (entry) => entry.entry.blocks[0]?.toolName === "wait_agent",
    );
    expect(
      visualSubagentMetaFromBlocks(
        spawn?.entry.blocks[0],
        spawn?.pairedResult?.blocks[0],
      ),
    ).toMatchObject({
      action: "spawn",
      id: subagentId,
      nickname: "Aristotle",
      type: "explorer",
    });
    expect(
      visualSubagentMetaFromBlocks(
        wait?.entry.blocks[0],
        wait?.pairedResult?.blocks[0],
      ),
    ).toMatchObject({
      action: "wait",
      id: subagentId,
      status: "completed",
      result: "Fresh subagent found five remaining differences.",
    });
    expect(
      displayEntries.some((entry) => entry.entry.blocks[0]?.type === "subagent"),
    ).toBe(false);

    const liveToolNames = new Map<string, string>();
    const live = [
      ...codexLiveMessagesFromEvent({
        kind: "notification",
        method: "item/started",
        params: { item: spawnCall, threadId: "thread-1", turnId: "turn-1" },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-06-22T10:00:00.000Z",
      }, { toolNames: liveToolNames }),
      ...codexLiveMessagesFromEvent({
        kind: "notification",
        method: "item/completed",
        params: { item: spawnOutput, threadId: "thread-1", turnId: "turn-1" },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-06-22T10:00:01.000Z",
      }, { toolNames: liveToolNames }),
    ];
    expect(live.map((message) => message.blocks[0]?.type)).toEqual([
      "tool_use",
      "tool_result",
    ]);
    expect(live[1]?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "spawn_agent",
      subagentAction: "spawn",
      subagentId,
      subagentNickname: "Aristotle",
    });

    const attachContext = {};
    const attachedHistory = codexAppHistoryMessagesFromThread({
      turns: [{ id: "turn-1", items: [spawnCall] }],
    }, attachContext);
    const attachedLiveOutput = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/completed",
      params: { item: spawnOutput, threadId: "thread-1", turnId: "turn-1" },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:01.000Z",
    }, attachContext);
    expect(attachedHistory[0]?.blocks[0]).toMatchObject({
      type: "tool_use",
      toolName: "spawn_agent",
    });
    expect(attachedLiveOutput[0]?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "spawn_agent",
      subagentAction: "spawn",
      subagentId,
      subagentNickname: "Aristotle",
    });
  });

  test("normalizes app-server view_image calls into visible media", () => {
    const messages = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-1",
          startedAt: 1782122400,
          items: [
            {
              id: "view-1",
              type: "dynamicToolCall",
              tool: "view_image",
              arguments: {
                path: "/tmp/asset-preview.png",
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "codex-tool-view-1",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "view_image",
            toolInput: {
              path: "/tmp/asset-preview.png",
              detail: "high",
            },
            toolUseId: "view-1",
          },
          {
            type: "media",
            mediaKind: "image",
            path: "/tmp/asset-preview.png",
            title: "asset-preview.png",
            alt: "asset-preview.png",
          },
        ],
      },
    ]);
  });

  test("normalizes app-server write_stdin history and live results as read logs", () => {
    const writeStdinItem = {
      id: "call-logs",
      type: "dynamicToolCall",
      tool: "write_stdin",
      arguments: {
        session_id: 55249,
        chars: "",
        yield_time_ms: 5000,
        max_output_tokens: 8000,
      },
      result:
        "Chunk ID: 07acea\nWall time: 5.0019 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n500/700\n",
    };
    const history = codexAppHistoryMessagesFromThread({
      turns: [{ id: "turn-1", items: [writeStdinItem] }],
    });
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: writeStdinItem,
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    });

    expect(stripTimestamps(live)).toEqual(stripTimestamps(history));

    const work = buildVisualTranscriptItems([
      {
        role: "user" as const,
        blocks: [{ type: "text" as const, text: "keep watching the logs" }],
      },
      ...live,
    ]).find((item) => item.kind === "work");
    if (!work || work.kind !== "work") {
      throw new Error("expected work item");
    }
    const entries = buildVisualWorkDisplayEntries(work.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pairedToolUse?.blocks[0]?.toolName).toBe("write_stdin");
    expect(entries[0]?.entry.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "write_stdin",
      text: expect.stringContaining("500/700"),
    });
  });

  test("normalizes app-server write_stdin content items in live and history", () => {
    const writeStdinItem = {
      id: "call-logs",
      type: "dynamicToolCall",
      tool: "write_stdin",
      arguments: {
        session_id: 55249,
        chars: "",
        yield_time_ms: 5000,
        max_output_tokens: 8000,
      },
      status: "completed",
      contentItems: [
        {
          type: "inputText",
          text:
            "Chunk ID: 07acea\nWall time: 5.0019 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n500/700\n",
        },
      ],
      success: true,
      durationMs: 5002,
    };
    const history = codexAppHistoryMessagesFromThread({
      turns: [{ id: "turn-1", items: [writeStdinItem] }],
    });
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: writeStdinItem,
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    });

    expect(stripTimestamps(live)).toEqual(stripTimestamps(history));
    expect(live).toContainEqual(
      expect.objectContaining({
        id: "codex-output-call-logs",
        role: "tool",
        blocks: [
          expect.objectContaining({
            type: "tool_result",
            toolName: "write_stdin",
            text: expect.stringContaining("500/700"),
          }),
        ],
      }),
    );
  });

  test("normalizes app-server write_stdin starts before results arrive", () => {
    const messages = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "call-logs",
          type: "dynamicToolCall",
          tool: "write_stdin",
          arguments: {
            session_id: 55249,
            chars: "",
            yield_time_ms: 5000,
            max_output_tokens: 8000,
          },
        },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    });

    expect(messages).toEqual([
      {
        id: "codex-tool-call-logs",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "write_stdin",
            toolInput: {
              session_id: 55249,
              chars: "",
              yield_time_ms: 5000,
              max_output_tokens: 8000,
            },
            toolUseId: "call-logs",
          },
        ],
      },
    ]);
  });

  test("uses app-server item lifecycle timestamps for live item messages", () => {
    const started = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/started",
      params: {
        startedAtMs: Date.parse("2026-06-22T10:00:03.000Z"),
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "call-logs",
          type: "dynamicToolCall",
          tool: "write_stdin",
          arguments: { session_id: 55249, chars: "" },
        },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    });
    const completed = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/completed",
      params: {
        completedAtMs: Date.parse("2026-06-22T10:00:04.000Z"),
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "call-logs",
          type: "dynamicToolCall",
          tool: "write_stdin",
          arguments: { session_id: 55249, chars: "" },
          result: "done",
        },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:01.000Z",
    });

    expect(started[0]?.timestamp).toBe("2026-06-22T10:00:03.000Z");
    expect(completed[0]?.timestamp).toBe("2026-06-22T10:00:04.000Z");
  });

  test("normalizes app-server image generation starts as visible tool calls", () => {
    const messages = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "image-1",
          type: "imageGeneration",
          prompt: "duberman",
          status: "generating",
        },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-07-02T15:41:04.000Z",
    });

    expect(messages).toEqual([
      {
        id: "codex-tool-image-1",
        role: "assistant",
        timestamp: "2026-07-02T15:41:04.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "image_generation_call",
            toolInput: { prompt: "duberman", status: "generating" },
            toolUseId: "image-1",
          },
        ],
      },
    ]);
  });

  test("normalizes app-server image generation history and live snapshots to the same visual contract", () => {
    const userItem = {
      id: "user-1",
      type: "userMessage",
      content: [{ type: "text", text: "make a duberman" }],
    };
    const imageItem = {
      id: "image-1",
      type: "imageGeneration",
      prompt: "duberman",
      status: "completed",
      savedPath: "/tmp/duberman.png",
    };
    const finalItem = {
      id: "answer-1",
      type: "agentMessage",
      text: "Generated your Duberman image.",
    };
    const history = codexAppHistoryMessagesFromThread({
      turns: [{ id: "turn-1", items: [userItem, imageItem, finalItem] }],
    });
    const live = [
      {
        id: "codex-user-user-1",
        role: "user" as const,
        blocks: [{ type: "text" as const, text: "make a duberman" }],
      },
      ...codexLiveMessagesFromEvent({
        kind: "notification",
        method: "item/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: imageItem,
        },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-07-02T15:42:10.000Z",
      }),
      {
        id: "codex-agent-answer-1",
        role: "assistant" as const,
        timestamp: "2026-07-02T15:42:11.000Z",
        blocks: [{ type: "text" as const, text: finalItem.text }],
      },
    ];

    expect(visualContract(buildVisualTranscriptItems(live))).toEqual(
      visualContract(buildVisualTranscriptItems(history)),
    );
    const items = buildVisualTranscriptItems(history);
    const response = items.findLast((item) => item.kind === "message");
    if (!response || response.kind !== "message") {
      throw new Error("expected final message");
    }
    expect(response.blocks.map((block) => block.type)).toEqual([
      "media",
      "text",
    ]);
  });

  test("merges app-server history before live events without duplicating item ids", () => {
    const history = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "agent-1",
              type: "agentMessage",
              text: "partial",
            },
          ],
        },
      ],
    });
    const live = [
      {
        id: "codex-agent-agent-1",
        role: "assistant" as const,
        blocks: [{ type: "text" as const, text: "partial plus live tail" }],
      },
      {
        id: "codex-agent-agent-2",
        role: "assistant" as const,
        blocks: [{ type: "text" as const, text: "new live message" }],
      },
    ];

    expect(mergeCodexAppHistoryMessages(history, live)).toEqual([
      live[0],
      live[1],
    ]);
  });
});

function stripTimestamps(messages: Array<{ timestamp?: string }>): unknown[] {
  return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

function visualContract(
  items: ReturnType<typeof buildVisualTranscriptItems>,
): unknown[] {
  return items.map((item) => {
    if (item.kind === "message") {
      return {
        kind: item.kind,
        role: item.message.role,
        blockTypes: item.blocks.map((block) => block.type),
      };
    }
    if (item.kind === "marker") {
      return { kind: item.kind, markerKind: item.markerKind };
    }
    return {
      kind: item.kind,
      open: item.open,
      entryBlocks: item.entries.map((entry) =>
        entry.blocks.map((block) => ({
          type: block.type,
          toolName: block.toolName,
          toolUseId: block.toolUseId,
        })),
      ),
    };
  });
}
