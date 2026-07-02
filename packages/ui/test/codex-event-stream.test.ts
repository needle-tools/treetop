import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetCodexEventStreamsForTests,
  __setCodexEventSourceCtorForTests,
  codexAppHistoryMessagesFromThread,
  codexLiveMessagesFromEvent,
  codexLiveMarkerFromEvent,
  codexLiveToolResultFromEvent,
  codexLiveToolUseFromEvent,
  codexToolInputQuality,
  codexEventThreadIdForSession,
  mergeCodexAppHistoryMessages,
  subscribeCodexEvents,
  type CodexAppEvent,
  type CodexEventStreamState,
} from "../src/codex-event-stream";
import { buildVisualTranscriptItems } from "../src/last-user-message";

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
