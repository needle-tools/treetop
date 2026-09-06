import { beforeEach, describe, expect, test } from "bun:test";
import {
  CODEX_APP_HISTORY_TURNS_PAGE_SIZE,
  __resetCodexEventStreamsForTests,
  __setCodexEventSourceCtorForTests,
  canRequestOlderCodexAppThreadHistory,
  codexAppHistoryMessagesFromThread,
  codexAppHistoryMessagesFromTurnPage,
  codexLiveMessagesFromEvent,
  codexLiveMessagesEndTurn,
  codexLiveMarkerFromEvent,
  codexLiveToolResultFromEvent,
  codexLiveToolUseFromEvent,
  codexAppHistoryKey,
  codexToolInputQuality,
  codexEventThreadIdForSession,
  codexEventVisualDelivery,
  CODEX_LIVE_OUTPUT_LIMIT,
  codexOutputDeltaNeedsToolUse,
  mergeCodexAppHistoryMessages,
  shouldLoadCodexAppThreadHistory,
  shouldRunCodexAppLiveSurface,
  shouldSubscribeCodexAppLiveState,
  shouldUseCodexAppHistorySource,
  shouldApplyCodexAppHistoryResponse,
  shouldApplyCodexAppMutation,
  subscribeCodexEvents,
  type CodexAppEvent,
  type CodexEventStreamState,
} from "../src/codex-event-stream";
import {
  buildVisualTranscriptItems,
  buildVisualWorkDisplayEntries,
  visualSubagentMetaFromBlocks,
  visualWorkImageBlocks,
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

  test("shares one EventSource for multiple subscribers on the same daemon", () => {
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

  test("classifies live app-server events by visual delivery cost", () => {
    expect(
      codexEventVisualDelivery({
        kind: "notification",
        method: "item/agentMessage/delta",
      }),
    ).toBe("batched-delta");
    expect(
      codexEventVisualDelivery({
        kind: "notification",
        method: "item/commandExecution/outputDelta",
      }),
    ).toBe("batched-delta");
    for (const method of [
      "account/rateLimits/updated",
      "turn/diff/updated",
      "item/reasoning/summaryPartAdded",
      "item/fileChange/patchUpdated",
    ]) {
      expect(codexEventVisualDelivery({ kind: "notification", method })).toBe(
        "ignore",
      );
    }
    expect(
      codexEventVisualDelivery({
        kind: "notification",
        method: "item/completed",
      }),
    ).toBe("immediate");
    expect(
      codexEventVisualDelivery({
        kind: "request",
        method: "item/commandExecution/requestApproval",
      }),
    ).toBe("immediate");
  });

  test("does not retain or dispatch known nonvisual app-server noise", () => {
    const received: string[] = [];
    const off = subscribeCodexEvents(undefined, "t1", {
      onEvent: (entry) => received.push(entry.method),
    });
    FakeEventSource.instances[0]?.emit("codex", {
      ...event("t1", 1),
      method: "turn/diff/updated",
      params: { threadId: "t1", diff: "large cumulative diff" },
    });
    const offReplay = subscribeCodexEvents(undefined, "t1", {
      onEvent: (entry) => received.push(`replay:${entry.method}`),
    });
    expect(received).toEqual([]);
    offReplay();
    off();
  });

  test("does not rebuild an existing tool-use message for every output delta", () => {
    const toolUse = { id: "codex-tool-exec-1" };
    expect(codexOutputDeltaNeedsToolUse([], toolUse)).toBe(true);
    expect(
      codexOutputDeltaNeedsToolUse(
        [
          {
            id: toolUse.id,
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                toolName: "exec_command",
                toolUseId: "exec-1",
              },
            ],
          },
        ],
        toolUse,
      ),
    ).toBe(false);
  });

  test("runs app-server live work only while the visual body is rendered", () => {
    expect(
      shouldRunCodexAppLiveSurface({
        visualAppSurface: true,
        mode: "read",
        nearViewport: true,
      }),
    ).toBe(true);
    expect(
      shouldRunCodexAppLiveSurface({
        visualAppSurface: true,
        mode: "read",
        nearViewport: false,
      }),
    ).toBe(false);
    expect(
      shouldRunCodexAppLiveSurface({
        visualAppSurface: true,
        mode: "terminal",
        nearViewport: true,
      }),
    ).toBe(false);
    expect(
      shouldRunCodexAppLiveSurface({
        visualAppSurface: false,
        mode: "read",
        nearViewport: true,
      }),
    ).toBe(false);
  });

  test("keeps app-server lifecycle subscribed even when the visual body is offscreen", () => {
    expect(
      shouldSubscribeCodexAppLiveState({
        visualAppSurface: true,
        mode: "read",
      }),
    ).toBe(true);
    expect(
      shouldRunCodexAppLiveSurface({
        visualAppSurface: true,
        mode: "read",
        nearViewport: false,
      }),
    ).toBe(false);
    expect(
      shouldSubscribeCodexAppLiveState({
        visualAppSurface: true,
        mode: "terminal",
      }),
    ).toBe(false);
  });

  test("keeps live visual panes app-server owned when a transcript source exists", () => {
    expect(
      shouldUseCodexAppHistorySource({
        liveSurfaceActive: true,
        transcriptSource: undefined,
      }),
    ).toBe(true);
    expect(
      shouldUseCodexAppHistorySource({
        liveSurfaceActive: true,
        transcriptSource: "/Users/me/.codex/sessions/thread-1.jsonl",
      }),
    ).toBe(true);
    expect(
      shouldUseCodexAppHistorySource({
        liveSurfaceActive: false,
        transcriptSource: undefined,
      }),
    ).toBe(false);
  });

  test("drops an app-server history response after the pane becomes transcript owned", () => {
    const current = {
      sourceActive: true,
      requestedThreadId: "thread-1",
      requestedCwd: "/repo",
      currentThreadId: "thread-1",
      currentCwd: "/repo",
    };
    expect(shouldApplyCodexAppHistoryResponse(current)).toBe(true);
    expect(
      shouldApplyCodexAppHistoryResponse({
        ...current,
        sourceActive: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyCodexAppHistoryResponse({
        ...current,
        currentThreadId: "thread-2",
      }),
    ).toBe(false);
    expect(
      shouldApplyCodexAppHistoryResponse({
        ...current,
        currentCwd: "/other",
      }),
    ).toBe(false);
  });

  test("drops queued app-server events after live ownership ends", () => {
    const current = {
      sourceActive: true,
      subscribedThreadId: "thread-1",
      eventThreadId: "thread-1" as string | undefined,
      currentThreadId: "thread-1" as string | undefined,
    };
    expect(shouldApplyCodexAppMutation(current)).toBe(true);
    expect(
      shouldApplyCodexAppMutation({ ...current, sourceActive: false }),
    ).toBe(false);
    expect(
      shouldApplyCodexAppMutation({
        ...current,
        currentThreadId: "thread-2",
      }),
    ).toBe(false);
    expect(
      shouldApplyCodexAppMutation({ ...current, eventThreadId: "thread-2" }),
    ).toBe(false);
    expect(
      shouldApplyCodexAppMutation({ ...current, eventThreadId: undefined }),
    ).toBe(true);
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
        visualAppSurface: true,
        threadId: "thread-1",
        cwd: "/repo",
        hasSession: true,
        loadedHistoryKey: "",
        loadingHistoryKey: "",
        failedHistoryKey: key,
      }),
    ).toBe(false);
    expect(
      shouldLoadCodexAppThreadHistory({
        visualAppSurface: true,
        threadId: "thread-1",
        cwd: "/repo",
        hasSession: true,
        loadedHistoryKey: "",
        loadingHistoryKey: "",
        failedHistoryKeys: new Set([key]),
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
          output:
            "Chunk ID: abc123\nWall time: 0.1234 seconds\nOutput:\nimport three",
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
    expect(
      codexLiveMessagesFromEvent(result, context)[0]?.blocks[0],
    ).toMatchObject({
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

  test("bounds oversized completed command output kept in the live visual model", () => {
    const completed: CodexAppEvent = {
      kind: "notification",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "call-large",
          command: "bun test",
          status: "completed",
          aggregatedOutput: `head:${"x".repeat(CODEX_LIVE_OUTPUT_LIMIT)}:tail`,
          exitCode: 0,
        },
      },
      receivedAt: "2026-09-02T09:00:00.000Z",
    };

    const result = codexLiveToolResultFromEvent(completed);
    expect(result?.text).toHaveLength(CODEX_LIVE_OUTPUT_LIMIT);
    expect(result?.text).toStartWith("Exit code: 0");
    expect(result?.text).toContain("output truncated for display");
    expect(result?.text).toEndWith(":tail");
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

  test("normalizes the recorded item/completed compaction shape exactly once", () => {
    const started: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        item: { type: "contextCompaction", id: "compact-1" },
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_787_865_324_462,
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-08-27T21:15:24.466Z",
      seq: 544,
    };
    const completed: CodexAppEvent = {
      ...started,
      method: "item/completed",
      params: {
        item: { type: "contextCompaction", id: "compact-1" },
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1_787_865_411_869,
      },
      receivedAt: "2026-08-27T21:16:51.870Z",
      seq: 547,
    };

    expect(codexLiveMessagesFromEvent(started)).toEqual([]);
    expect(codexLiveMessagesFromEvent(completed)).toEqual([
      {
        id: "codex-marker-compact-1",
        role: "system",
        timestamp: "2026-08-27T21:16:51.869Z",
        blocks: [{ type: "marker", text: "[Context compacted]" }],
      },
    ]);
    expect(
      codexLiveMessagesEndTurn(codexLiveMessagesFromEvent(completed)),
    ).toBe(false);
  });

  test("keeps retrying errors and warnings visible without ending the turn", () => {
    const retrying: CodexAppEvent = {
      kind: "notification",
      method: "error",
      params: {
        error: {
          message: "Reconnecting... 2/5",
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
        },
        willRetry: true,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-08-27T12:05:15.765Z",
      seq: 20,
    };
    const warning: CodexAppEvent = {
      kind: "notification",
      method: "warning",
      params: {
        threadId: "thread-1",
        message:
          "Falling back from WebSockets to HTTPS transport. stream disconnected before completion",
      },
      threadId: "thread-1",
      receivedAt: "2026-08-27T12:05:38.537Z",
      seq: 24,
    };

    expect(codexLiveMessagesFromEvent(retrying)[0]?.blocks).toEqual([
      { type: "marker", text: "[Retrying: Reconnecting... 2/5]" },
    ]);
    expect(codexLiveMessagesFromEvent(warning)[0]?.blocks).toEqual([
      {
        type: "marker",
        text: "[Warning: Falling back from WebSockets to HTTPS transport. stream disconnected before completion]",
      },
    ]);
    expect(codexLiveMessagesEndTurn(codexLiveMessagesFromEvent(retrying))).toBe(
      false,
    );
    expect(codexLiveMessagesEndTurn(codexLiveMessagesFromEvent(warning))).toBe(
      false,
    );
  });

  test("does not count a live post-compaction context snapshot as new tokens", () => {
    const context = {};
    const tokenEvent = (
      seq: number,
      last: Record<string, number>,
      total: Record<string, number>,
    ): CodexAppEvent => ({
      kind: "notification",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { last, total, modelContextWindow: 258_400 },
      },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: `2026-08-27T21:16:${seq}.000Z`,
      seq,
    });
    const cumulative = {
      totalTokens: 9_843_531,
      inputTokens: 9_802_403,
      cachedInputTokens: 8_000_000,
      outputTokens: 41_128,
      reasoningOutputTokens: 18_943,
    };

    expect(
      codexLiveMessagesFromEvent(
        tokenEvent(
          1,
          {
            totalTokens: 230_202,
            inputTokens: 229_998,
            cachedInputTokens: 220_000,
            outputTokens: 204,
            reasoningOutputTokens: 30,
          },
          cumulative,
        ),
        context,
      ),
    ).toHaveLength(1);
    expect(
      codexLiveMessagesFromEvent(
        tokenEvent(
          2,
          {
            totalTokens: 15_309,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          cumulative,
        ),
        context,
      ),
    ).toEqual([]);
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

  test("normalizes structured app-server reasoning summaries into thinking text", () => {
    const messages = codexAppHistoryMessagesFromThread({
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          startedAt: 1782122400,
          items: [
            {
              id: "reasoning-1",
              type: "reasoning",
              summary: [
                {
                  type: "summary_text",
                  text: "**Refactoring narration fragment projection for cut mode**",
                },
                {
                  type: "summary_text",
                  text: "**Verifying fragment merging and render order**",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(messages).toEqual([
      {
        id: "codex-plan-reasoning-1",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        blocks: [
          {
            type: "thinking",
            text: "**Refactoring narration fragment projection for cut mode**\n\n**Verifying fragment merging and render order**",
          },
        ],
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

    const merged = mergeCodexAppHistoryMessages(older, [...newer, liveTail]);

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

  test("normalizes app-server token_count rows as assistant token usage", () => {
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "token_count",
      params: {
        type: "token_count",
        turnId: "turn-usage",
        info: {
          last_token_usage: {
            input_tokens: 1234,
            cached_input_tokens: 1000,
            output_tokens: 286,
            reasoning_output_tokens: 29,
            total_tokens: 1520,
          },
        },
      },
      turnId: "turn-usage",
      receivedAt: "2026-06-22T10:00:00.000Z",
    });

    expect(live).toEqual([
      {
        id: "codex-usage-turn-usage-2026-06-22T10:00:00.000Z",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        tokensUsed: 286,
        tokenUsage: {
          input: 1234,
          cachedInput: 1000,
          cacheWriteInput: 0,
          output: 286,
          reasoningOutput: 29,
          total: 1520,
        },
        blocks: [],
      },
    ]);

    const history = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-usage",
          startedAt: 1782122400,
          items: [
            {
              id: "usage-item",
              type: "token_count",
              info: {
                last_token_usage: {
                  input_tokens: 1234,
                  cached_input_tokens: 1000,
                  output_tokens: 286,
                  reasoning_output_tokens: 29,
                  total_tokens: 1520,
                },
              },
            },
          ],
        },
      ],
    });

    expect(history).toEqual([
      {
        id: "codex-usage-usage-item",
        role: "assistant",
        timestamp: "2026-06-22T10:00:00.000Z",
        tokensUsed: 286,
        tokenUsage: {
          input: 1234,
          cachedInput: 1000,
          cacheWriteInput: 0,
          output: 286,
          reasoningOutput: 29,
          total: 1520,
        },
        blocks: [],
      },
    ]);
  });

  test("normalizes cumulative app-server token_count history as deltas", () => {
    const history = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-usage",
          startedAt: 1782122400,
          items: [
            {
              id: "usage-1",
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  total_tokens: 120,
                },
              },
            },
            {
              id: "usage-2",
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 145,
                  output_tokens: 35,
                  total_tokens: 180,
                },
              },
            },
          ],
        },
      ],
    });

    expect(history.map((message) => message.tokenUsage?.total)).toEqual([
      120, 60,
    ]);
    expect(history.map((message) => message.tokenUsage?.input)).toEqual([
      100, 45,
    ]);
    expect(history.map((message) => message.tokenUsage?.output)).toEqual([
      20, 15,
    ]);
  });

  test("normalizes live app-server token usage from turn updates", () => {
    const context = {};
    const first = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "turn/updated",
        params: {
          threadId: "thread-usage",
          turnId: "turn-usage",
          info: {
            total_token_usage: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
            },
          },
        },
        threadId: "thread-usage",
        turnId: "turn-usage",
        receivedAt: "2026-06-22T10:00:00.000Z",
      },
      context,
    );
    const second = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "turn/updated",
        params: {
          threadId: "thread-usage",
          turnId: "turn-usage",
          info: {
            total_token_usage: {
              input_tokens: 145,
              output_tokens: 35,
              total_tokens: 180,
            },
          },
        },
        threadId: "thread-usage",
        turnId: "turn-usage",
        receivedAt: "2026-06-22T10:00:01.000Z",
      },
      context,
    );

    expect(first[0]?.tokenUsage).toMatchObject({
      input: 100,
      output: 20,
      total: 120,
    });
    expect(second[0]?.tokenUsage).toMatchObject({
      input: 45,
      output: 15,
      total: 60,
    });
  });

  test("normalizes live app-server thread token usage notifications", () => {
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        tokenUsage: {
          last: {
            inputTokens: 2345,
            cachedInputTokens: 2000,
            cacheWriteInputTokens: 12,
            outputTokens: 91,
            reasoningOutputTokens: 17,
            totalTokens: 2453,
          },
          total: {
            inputTokens: 3000,
            cachedInputTokens: 2500,
            cacheWriteInputTokens: 12,
            outputTokens: 121,
            reasoningOutputTokens: 22,
            totalTokens: 3143,
          },
        },
      },
      threadId: "thread-usage",
      turnId: "turn-usage",
      receivedAt: "2026-06-22T10:00:02.000Z",
    });

    expect(live).toEqual([
      {
        id: "codex-usage-turn-usage-2026-06-22T10:00:02.000Z",
        role: "assistant",
        timestamp: "2026-06-22T10:00:02.000Z",
        tokensUsed: 91,
        tokenUsage: {
          input: 2345,
          cachedInput: 2000,
          cacheWriteInput: 12,
          output: 91,
          reasoningOutput: 17,
          total: 2453,
        },
        blocks: [],
      },
    ]);
  });

  test("normalizes root app-server usage fields in live events", () => {
    const live = codexLiveMessagesFromEvent({
      kind: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-usage",
        turnId: "turn-usage",
        last_token_usage: {
          input_tokens: 70,
          cached_input_tokens: 64,
          output_tokens: 12,
          reasoning_output_tokens: 3,
          total_tokens: 82,
        },
      },
      threadId: "thread-usage",
      turnId: "turn-usage",
      receivedAt: "2026-06-22T10:00:02.000Z",
    });

    expect(live).toEqual([
      {
        id: "codex-usage-turn-usage-2026-06-22T10:00:02.000Z",
        role: "assistant",
        timestamp: "2026-06-22T10:00:02.000Z",
        tokensUsed: 12,
        tokenUsage: {
          input: 70,
          cachedInput: 64,
          cacheWriteInput: 0,
          output: 12,
          reasoningOutput: 3,
          total: 82,
        },
        blocks: [],
      },
    ]);
  });

  test("prefers app-server last_token_usage over cumulative totals", () => {
    const context = {};
    const first = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "token_count",
        params: {
          type: "token_count",
          turnId: "turn-usage",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              output_tokens: 200,
              total_tokens: 1200,
            },
            last_token_usage: {
              input_tokens: 120,
              output_tokens: 30,
              total_tokens: 150,
            },
          },
        },
        turnId: "turn-usage",
        receivedAt: "2026-06-22T10:00:00.000Z",
      },
      context,
    );
    const second = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "token_count",
        params: {
          type: "token_count",
          turnId: "turn-usage",
          info: {
            total_token_usage: {
              input_tokens: 1300,
              output_tokens: 250,
              total_tokens: 1550,
            },
          },
        },
        turnId: "turn-usage",
        receivedAt: "2026-06-22T10:00:01.000Z",
      },
      context,
    );

    expect([first[0]?.tokenUsage?.total, second[0]?.tokenUsage?.total]).toEqual(
      [150, 350],
    );
    expect([first[0]?.tokenUsage?.input, second[0]?.tokenUsage?.input]).toEqual(
      [120, 300],
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
    expect(visualContract(buildVisualTranscriptItems([user, ...live]))).toEqual(
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
      displayEntries.some(
        (entry) => entry.entry.blocks[0]?.type === "subagent",
      ),
    ).toBe(false);

    const liveToolNames = new Map<string, string>();
    const live = [
      ...codexLiveMessagesFromEvent(
        {
          kind: "notification",
          method: "item/started",
          params: { item: spawnCall, threadId: "thread-1", turnId: "turn-1" },
          threadId: "thread-1",
          turnId: "turn-1",
          receivedAt: "2026-06-22T10:00:00.000Z",
        },
        { toolNames: liveToolNames },
      ),
      ...codexLiveMessagesFromEvent(
        {
          kind: "notification",
          method: "item/completed",
          params: { item: spawnOutput, threadId: "thread-1", turnId: "turn-1" },
          threadId: "thread-1",
          turnId: "turn-1",
          receivedAt: "2026-06-22T10:00:01.000Z",
        },
        { toolNames: liveToolNames },
      ),
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
    const attachedHistory = codexAppHistoryMessagesFromThread(
      {
        turns: [{ id: "turn-1", items: [spawnCall] }],
      },
      attachContext,
    );
    const attachedLiveOutput = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "item/completed",
        params: { item: spawnOutput, threadId: "thread-1", turnId: "turn-1" },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-06-22T10:00:01.000Z",
      },
      attachContext,
    );
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

  test("keeps app-server imageView items available to collapsed work summaries", () => {
    const messages = codexAppHistoryMessagesFromThread({
      turns: [
        {
          id: "turn-1",
          startedAt: 1782122400,
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "compare both renders" }],
            },
            {
              id: "image-baseline",
              type: "imageView",
              path: "/tmp/baseline.png",
            },
            {
              id: "image-candidate",
              type: "imageView",
              path: "/tmp/candidate.png",
            },
            {
              id: "answer-1",
              type: "agentMessage",
              text: "The candidate is cleaner.",
            },
          ],
        },
      ],
    });
    const work = buildVisualTranscriptItems(messages).find(
      (item) => item.kind === "work",
    );
    if (!work || work.kind !== "work") throw new Error("expected work item");

    expect(
      visualWorkImageBlocks(work.entries).map((block) => block.path),
    ).toEqual(["/tmp/baseline.png", "/tmp/candidate.png"]);
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
          text: "Chunk ID: 07acea\nWall time: 5.0019 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n500/700\n",
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

  test("normalizes app-server tool output image content in live and history", () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("image bytes").toString("base64")}`;
    const toolUse = {
      id: "call-preview",
      call_id: "call-preview",
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "node render-preview.mjs" }),
    };
    const toolResult = {
      id: "call-preview",
      call_id: "call-preview",
      type: "function_call_output",
      output: [
        { type: "input_text", text: "Preview generated." },
        {
          type: "input_image",
          image_url: {
            url: dataUrl,
          },
        },
      ],
    };
    const historyContext = {};
    const history = codexAppHistoryMessagesFromThread(
      { turns: [{ id: "turn-1", items: [toolUse, toolResult] }] },
      historyContext,
    );
    const liveContext = {};
    const live = [
      ...codexLiveMessagesFromEvent(
        {
          kind: "notification",
          method: "item/started",
          params: { item: toolUse, threadId: "thread-1", turnId: "turn-1" },
          threadId: "thread-1",
          turnId: "turn-1",
          receivedAt: "2026-06-22T10:00:00.000Z",
        },
        liveContext,
      ),
      ...codexLiveMessagesFromEvent(
        {
          kind: "notification",
          method: "item/completed",
          params: { item: toolResult, threadId: "thread-1", turnId: "turn-1" },
          threadId: "thread-1",
          turnId: "turn-1",
          receivedAt: "2026-06-22T10:00:01.000Z",
        },
        liveContext,
      ),
    ];

    expect(stripTimestamps(live)).toEqual(stripTimestamps(history));
    expect(live[1]?.blocks).toEqual([
      {
        type: "tool_result",
        toolName: "exec_command",
        toolUseId: "call-preview",
        text: "Preview generated.",
      },
      {
        type: "media",
        mediaKind: "image",
        mimeType: "image/png",
        url: dataUrl,
        title: "Image",
        alt: "Image",
      },
    ]);
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

  test("keeps prompt-bearing image generation input when live completion updates are sparse", () => {
    const context = {};
    const start = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "image-1",
            type: "imageGeneration",
            prompt: "a heroic Duberman sticker",
            status: "generating",
          },
        },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-07-02T15:41:04.000Z",
      },
      context,
    );
    const completed = codexLiveMessagesFromEvent(
      {
        kind: "notification",
        method: "item/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "image-1",
            type: "imageGeneration",
            status: "completed",
            savedPath: "/tmp/duberman.png",
          },
        },
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: "2026-07-02T15:42:10.000Z",
      },
      context,
    );

    expect(start[0]?.blocks[0]).toMatchObject({
      type: "tool_use",
      toolInput: {
        prompt: "a heroic Duberman sticker",
        status: "generating",
      },
    });
    expect(completed[0]?.blocks[0]).toMatchObject({
      type: "tool_use",
      toolName: "image_generation_call",
      toolInput: {
        prompt: "a heroic Duberman sticker",
        status: "generating",
      },
    });
    expect(completed[1]?.blocks[0]).toMatchObject({
      type: "tool_result",
      text: "Generated image",
      toolName: "image_generation_call",
    });
    expect(completed[2]?.blocks[0]).toMatchObject({
      type: "media",
      path: "/tmp/duberman.png",
      toolName: "image_generation_call",
    });
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
    const work = items.find((item) => item.kind === "work");
    if (!work || work.kind !== "work") throw new Error("expected work item");
    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]?.pairedMedia).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/duberman.png",
      }),
    ]);
    expect(visualWorkImageBlocks(work.entries)).toEqual([
      expect.objectContaining({ path: "/tmp/duberman.png" }),
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
