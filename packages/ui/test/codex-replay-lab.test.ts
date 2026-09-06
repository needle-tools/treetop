import { describe, expect, test } from "bun:test";
import {
  codexReplayItemsUntil,
  codexReplayMessagesUntil,
  createCodexReplaySessionTransport,
  createCodexReplayPlayback,
  filterCodexReplayTextForThread,
  filterCodexReplaySessions,
  summarizeCodexReplaySessions,
  parseCodexReplayTextAsync,
  parseCodexReplayText,
  parseCodexReplaySessionFixture,
  setCodexReplayPlaybackStep,
} from "../src/codex-replay-lab";

describe("Codex replay lab parser", () => {
  test("builds the selected thread page from its recorded app-server response", () => {
    const recording = [
      JSON.stringify({
        seq: 1,
        direction: "server",
        message: {
          id: 7,
          result: {
            thread: { id: "thread-a", cwd: "/repo/a", turns: [] },
            initialTurnsPage: {
              data: [{ id: "turn-a", items: [] }],
              nextCursor: "older-a",
            },
          },
        },
      }),
      JSON.stringify({
        seq: 2,
        direction: "server",
        message: {
          id: 8,
          result: {
            thread: { id: "thread-b", cwd: "/repo/b", turns: [] },
          },
        },
      }),
      JSON.stringify({
        seq: 3,
        direction: "server",
        message: {
          id: 9,
          result: {
            thread: { id: "thread-b", cwd: "/repo/b", turns: [] },
            model: "gpt-test",
            initialTurnsPage: {
              data: [{ id: "turn-b", items: [] }],
              nextCursor: "older-b",
            },
          },
        },
      }),
      JSON.stringify({
        seq: 4,
        direction: "server",
        message: {
          method: "turn/started",
          params: {
            threadId: "thread-b",
            turn: { id: "turn-live", items: [] },
          },
        },
      }),
    ].join("\n");

    const fixture = parseCodexReplaySessionFixture(recording, "thread-b");

    expect(fixture.threadId).toBe("thread-b");
    expect(fixture.cwd).toBe("/repo/b");
    expect(fixture.page).toEqual({
      thread: {
        id: "thread-b",
        cwd: "/repo/b",
        turns: [{ id: "turn-b", items: [] }],
      },
      model: "gpt-test",
      nextCursor: "older-b",
    });
    expect(fixture.events.map((event) => event.method)).toEqual([
      "turn/started",
    ]);
  });

  test("feeds recorded events through a SessionView-compatible transport", async () => {
    const fixture = parseCodexReplaySessionFixture(
      [
        JSON.stringify({
          seq: 1,
          direction: "server",
          message: {
            id: 4,
            result: {
              thread: { id: "thread-b", cwd: "/repo/b", turns: [] },
              initialTurnsPage: { data: [] },
            },
          },
        }),
        JSON.stringify({
          seq: 2,
          direction: "server",
          message: {
            method: "turn/started",
            params: { threadId: "thread-b", turn: { id: "turn-1" } },
          },
        }),
        JSON.stringify({
          seq: 3,
          direction: "server",
          message: {
            method: "turn/completed",
            params: { threadId: "thread-b", turn: { id: "turn-1" } },
          },
        }),
      ].join("\n"),
      "thread-b",
    );
    const transport = createCodexReplaySessionTransport(fixture);
    const states: string[] = [];
    const methods: string[] = [];

    expect(await transport.readThread()).toEqual(fixture.page);
    const unsubscribe = transport.subscribe("thread-b", {
      onState: (state) => states.push(state),
      onEvent: (event) => methods.push(event.method),
    });
    transport.setStep(1);
    transport.setStep(2);
    unsubscribe();

    expect(states).toEqual(["live"]);
    expect(methods).toEqual(["turn/started", "turn/completed"]);
  });

  test("summarizes and filters session coverage", () => {
    const sessions = [
      { threadId: "both", hasTranscript: true },
      { threadId: "rpc-only", hasTranscript: false },
      { threadId: "also-both", hasTranscript: true },
    ];

    expect(summarizeCodexReplaySessions(sessions)).toEqual({
      total: 3,
      rpc: 3,
      transcript: 2,
      both: 2,
      rpcOnly: 1,
    });
    expect(
      filterCodexReplaySessions(sessions, "both").map((item) => item.threadId),
    ).toEqual(["both", "also-both"]);
    expect(
      filterCodexReplaySessions(sessions, "rpc-only").map(
        (item) => item.threadId,
      ),
    ).toEqual(["rpc-only"]);
  });

  test("replays captured app-server JSON-RPC frames through the live visual shape", () => {
    const replay = parseCodexReplayText(
      JSON.stringify({
        id: "rec-1",
        startedAt: "2026-08-27T10:00:00.000Z",
        frames: [
          {
            seq: 1,
            at: "2026-08-27T10:00:00.000Z",
            direction: "client",
            message: {
              id: 1,
              method: "turn/start",
              params: {
                input: [{ type: "text", text: "Please inspect this." }],
              },
            },
          },
          {
            seq: 2,
            at: "2026-08-27T10:00:01.000Z",
            direction: "server",
            message: {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  type: "function_call",
                  id: "call-1",
                  call_id: "call-1",
                  name: "exec_command",
                  arguments: JSON.stringify({ cmd: "pwd", workdir: "/repo" }),
                },
              },
            },
          },
          {
            seq: 3,
            at: "2026-08-27T10:00:02.000Z",
            direction: "server",
            message: {
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: {
                  type: "function_call_output",
                  call_id: "call-1",
                  output: "/repo",
                },
              },
            },
          },
        ],
      }),
    );

    expect(replay.warnings).toEqual([]);
    expect(replay.steps).toHaveLength(3);
    expect(codexReplayMessagesUntil(replay, 1)[0]).toMatchObject({
      role: "user",
      blocks: [{ type: "text", text: "Please inspect this." }],
    });
    const items = codexReplayItemsUntil(replay, replay.steps.length);
    expect(items.some((item) => item.kind === "message")).toBe(true);
    expect(items.some((item) => item.kind === "work")).toBe(true);
  });

  test("accepts normalized event JSONL and keeps recorder order", () => {
    const replay = parseCodexReplayText(
      [
        JSON.stringify({
          kind: "notification",
          method: "item/started",
          receivedAt: "2026-08-27T10:00:00.000Z",
          seq: 1,
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "function_call",
              id: "call-1",
              call_id: "call-1",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: "pwd" }),
            },
          },
        }),
        JSON.stringify({
          event: {
            kind: "notification",
            method: "item/completed",
            receivedAt: "2026-08-27T10:00:01.000Z",
            seq: 2,
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                type: "function_call_output",
                call_id: "call-1",
                output: "/repo",
              },
            },
          },
        }),
      ].join("\n"),
    );

    expect(replay.warnings).toEqual([]);
    expect(replay.steps.map((step) => step.label)).toEqual([
      "item/started",
      "item/completed",
    ]);
    expect(codexReplayMessagesUntil(replay, 2).length).toBeGreaterThan(0);
  });

  test("filters multi-thread app-server recordings to the selected thread", () => {
    const text = [
      JSON.stringify({
        seq: 1,
        direction: "client",
        message: {
          method: "turn/start",
          params: {
            threadId: "thread-a",
            input: [{ type: "text", text: "from a" }],
          },
        },
      }),
      JSON.stringify({
        seq: 2,
        direction: "client",
        message: {
          method: "turn/start",
          params: {
            threadId: "thread-b",
            input: [{ type: "text", text: "from b" }],
          },
        },
      }),
      JSON.stringify({
        seq: 3,
        direction: "server",
        message: {
          method: "item/started",
          params: {
            threadId: "thread-b",
            turnId: "turn-b",
            item: {
              type: "function_call",
              id: "call-b",
              call_id: "call-b",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: "pwd" }),
            },
          },
        },
      }),
    ].join("\n");

    const filtered = parseCodexReplayText(
      filterCodexReplayTextForThread(text, "thread-b"),
    );

    expect(filtered.steps.map((step) => step.seq)).toEqual([2, 3]);
    expect(codexReplayMessagesUntil(filtered, filtered.steps.length)).toEqual([
      {
        id: "codex-replay-user-2",
        role: "user",
        timestamp: undefined,
        intent: undefined,
        blocks: [{ type: "text", text: "from b" }],
      },
      {
        id: "codex-tool-call-b",
        role: "assistant",
        timestamp: "1970-01-01T00:00:00.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolUseId: "call-b",
            toolInput: { cmd: "pwd" },
          },
        ],
      },
    ]);
  });

  test("filters object recordings without changing their container key", () => {
    const text = JSON.stringify({
      id: "recording",
      events: [
        {
          message: {
            method: "turn/start",
            params: { threadId: "thread-a" },
          },
        },
        {
          message: {
            method: "turn/start",
            params: { threadId: "thread-b" },
          },
        },
      ],
    });

    const filtered = JSON.parse(
      filterCodexReplayTextForThread(text, "thread-b"),
    );

    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].message.params.threadId).toBe("thread-b");
    expect(filtered.frames).toBeUndefined();
  });

  test("steps replay playback incrementally and keeps rendering bounded", () => {
    const replay = {
      mode: "transcript" as const,
      steps: Array.from({ length: 12 }, (_, index) => ({
        kind: "message" as const,
        seq: index + 1,
        label: "User message",
        message: {
          id: `message-${index}`,
          role: "user" as const,
          timestamp: `2026-08-27T10:00:${String(index).padStart(2, "0")}.000Z`,
          blocks: [{ type: "text" as const, text: `message ${index}` }],
        },
      })),
      warnings: [],
    };

    let playback = createCodexReplayPlayback(replay, {
      visibleMessageLimit: 5,
    });
    expect(playback.stepIndex).toBe(0);
    expect(playback.renderedMessageCount).toBe(0);

    playback = setCodexReplayPlaybackStep(playback, 8);
    expect(playback.stepIndex).toBe(8);
    expect(playback.totalMessageCount).toBe(8);
    expect(playback.renderedMessageCount).toBe(5);
    expect(
      playback.messages
        .slice(-1)[0]
        ?.blocks.find((block) => block.type === "text"),
    ).toMatchObject({ text: "message 7" });

    playback = setCodexReplayPlaybackStep(playback, 9);
    expect(playback.stepIndex).toBe(9);
    expect(playback.totalMessageCount).toBe(9);
    expect(playback.renderedMessageCount).toBe(5);

    playback = setCodexReplayPlaybackStep(playback, 3);
    expect(playback.stepIndex).toBe(3);
    expect(playback.totalMessageCount).toBe(3);
    expect(playback.renderedMessageCount).toBe(3);
  });

  test("accepts regular Codex session JSONL as a transcript", () => {
    const replay = parseCodexReplayText(
      [
        JSON.stringify({
          timestamp: "2026-08-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-session",
            timestamp: "2026-08-27T09:59:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Please inspect this." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "call-1",
            call_id: "call-1",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "pwd", workdir: "/repo" }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "/repo",
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:04.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        }),
      ].join("\n"),
    );

    expect(replay.mode).toBe("transcript");
    expect(replay.id).toBe("thread-session");
    expect(replay.warnings).toEqual([]);
    expect(replay.steps.map((step) => step.label)).toEqual([
      "User message",
      "exec_command",
      "exec_command result",
      "Assistant message",
    ]);
    expect(codexReplayMessagesUntil(replay, replay.steps.length)).toEqual([
      {
        id: "codex-transcript-message-2",
        role: "user",
        timestamp: "2026-08-27T10:00:01.000Z",
        blocks: [{ type: "text", text: "Please inspect this." }],
      },
      {
        id: "codex-transcript-tool-3",
        role: "assistant",
        timestamp: "2026-08-27T10:00:02.000Z",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolInput: { cmd: "pwd", workdir: "/repo" },
            toolUseId: "call-1",
          },
        ],
      },
      {
        id: "codex-transcript-result-4",
        role: "tool",
        timestamp: "2026-08-27T10:00:03.000Z",
        blocks: [
          {
            type: "tool_result",
            toolName: "exec_command",
            toolUseId: "call-1",
            text: "/repo",
          },
        ],
      },
      {
        id: "codex-transcript-message-5",
        role: "assistant",
        timestamp: "2026-08-27T10:00:04.000Z",
        blocks: [{ type: "text", text: "Done." }],
      },
    ]);
    expect(codexReplayItemsUntil(replay, replay.steps.length)).toEqual(
      codexReplayItemsUntil(replay, replay.steps.length + 100),
    );
  });

  test("collapses Codex transcript bootstrap rows and filters event-message duplicates", () => {
    const replay = parseCodexReplayText(
      [
        JSON.stringify({
          timestamp: "2026-08-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "thread-session",
            timestamp: "2026-08-27T09:59:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:00.100Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "giant developer prompt" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:00.200Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /repo\n\n<environment_context>hidden</environment_context>",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Render this actual turn." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Render this actual turn.",
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Duplicate transport row.",
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Actual assistant row." }],
          },
        }),
      ].join("\n"),
    );

    const messages = codexReplayMessagesUntil(replay, replay.steps.length);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({
      role: "system",
      blocks: [
        {
          type: "system_reminder",
          tagName: "Developer context",
          text: "giant developer prompt",
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: "system",
      blocks: [
        {
          type: "system_reminder",
          tagName: "Injected user context",
          text: "# AGENTS.md instructions for /repo\n\n<environment_context>hidden</environment_context>",
        },
      ],
    });
    expect(messages.slice(2).flatMap((message) => message.blocks)).toEqual([
      { type: "text", text: "Render this actual turn." },
      { type: "text", text: "Actual assistant row." },
    ]);
  });

  test("reports progress while parsing JSONL drops", async () => {
    const progress: string[] = [];
    const replay = await parseCodexReplayTextAsync(
      [
        JSON.stringify({
          timestamp: "2026-08-27T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "thread-session" },
        }),
        JSON.stringify({
          timestamp: "2026-08-27T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hi" }],
          },
        }),
      ].join("\n"),
      {
        chunkSize: 1,
        onProgress: (state) => progress.push(state.label),
      },
    );

    expect(replay.mode).toBe("transcript");
    expect(progress).toContain("Parsing line 1 / 2");
    expect(progress).toContain("Parsing line 2 / 2");
  });
});
