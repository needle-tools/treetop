import { describe, expect, test } from "bun:test";
import { parseCodexJsonl } from "../../daemon/src/sessions";
import {
  analyzeCodexReplayTurns,
  collectCodexReplayDirectoryFiles,
  codexReplayProjectLabel,
  codexReplayItemsUntil,
  codexReplayMessagesUntil,
  createCodexReplaySessionTransport,
  createCodexReplayPlayback,
  createCodexReplayViewModel,
  filterCodexReplayTextForThread,
  filterCodexReplaySessions,
  filterCodexReplaySessionsByModel,
  formatReplayClock,
  summarizeCodexReplaySessions,
  parseCodexReplayBlobAsync,
  parseCodexReplayTextAsync,
  parseCodexReplayText,
  parseCodexReplaySessionFixture,
  inspectCodexReplayFilePrefix,
  listCodexReplaySessionModels,
  REPLAY_SESSION_LOCATIONS,
  summarizeCodexReplayPricingUsage,
  setCodexReplayPlaybackStep,
  replayDurationMs,
  replayElapsedMsAtStep,
  replayPlaybackTiming,
  replaySourceProgressAtStep,
  replayStepIndexAtElapsedMs,
  searchCodexReplaySessions,
  sortCodexReplaySessions,
} from "../src/codex-replay-lab";
import {
  buildVisualWorkDisplayEntries,
  buildVisualTranscriptItems,
  visualWorkOverview,
} from "../src/last-user-message";

test("documents loadable Codex and Claude session locations on macOS and Windows", () => {
  expect(REPLAY_SESSION_LOCATIONS).toEqual([
    {
      platform: "macOS",
      codex: [
        "~/.codex/sessions/YYYY/MM/DD/*.jsonl",
        "~/.codex/archived_sessions/*.jsonl",
      ],
      claude: ["~/.claude/projects/<project-folder>/*.jsonl"],
    },
    {
      platform: "Windows",
      codex: [
        "%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\*.jsonl",
        "%USERPROFILE%\\.codex\\archived_sessions\\*.jsonl",
      ],
      claude: ["%USERPROFILE%\\.claude\\projects\\<project-folder>\\*.jsonl"],
    },
  ]);
});

describe("Codex replay lab parser", () => {
  test("normalizes wrapped edits and image envelopes like the session parser", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /repo/src/app.css",
      "@@",
      "-color: red;",
      "+color: grey;",
      "*** End Patch",
    ].join("\n");
    const dataUrl = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
    const text = [
      JSON.stringify({
        timestamp: "2026-09-09T09:29:04.249Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Match these greys" },
            {
              type: "input_text",
              text: '<image name=[Image #1] path="/repo/reference.png">',
            },
            { type: "input_image", image_url: dataUrl },
            { type: "input_text", text: "</image>" },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-09T09:30:26.257Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-patch",
          input: `const patch = ${JSON.stringify(patch)};\nconst r = await tools.apply_patch(patch); text(r);`,
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-09T09:30:26.284Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-patch",
          output: "Success",
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-09T09:30:26.267Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "exec-patch",
          success: true,
          changes: {
            "/repo/src/app.css": {
              type: "update",
              unified_diff: "@@\n-color: red;\n+color: grey;",
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-09-09T09:30:30.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      }),
    ].join("\n");

    const replay = parseCodexReplayText(text);
    const messages = codexReplayMessagesUntil(replay, replay.steps.length);
    const userBlocks = messages.find((message) => message.role === "user")!
      .blocks;
    expect(userBlocks.filter((block) => block.type === "media")).toHaveLength(
      1,
    );
    expect(userBlocks.filter((block) => block.type === "text")).toEqual([
      { type: "text", text: "Match these greys" },
    ]);

    const work = buildVisualTranscriptItems(messages, { active: false }).find(
      (item) => item.kind === "work",
    );
    expect(work?.kind).toBe("work");
    if (!work || work.kind !== "work") return;
    const entries = buildVisualWorkDisplayEntries(work.entries);
    const overview = visualWorkOverview(work, entries);
    expect(overview.changedFiles).toEqual([
      {
        path: "/repo/src/app.css",
        label: "app.css",
        additions: 2,
        deletions: 2,
        diff: [
          "*** Update File: /repo/src/app.css",
          "@@",
          "-color: red;",
          "+color: grey;",
          "@@",
          "-color: red;",
          "+color: grey;",
        ].join("\n"),
      },
    ]);

    const productionMessages = parseCodexJsonl(text).messages;
    const productionWork = buildVisualTranscriptItems(productionMessages, {
      active: false,
    }).find((item) => item.kind === "work");
    expect(productionWork?.kind).toBe("work");
    if (!productionWork || productionWork.kind !== "work") return;
    const productionOverview = visualWorkOverview(
      productionWork,
      buildVisualWorkDisplayEntries(productionWork.entries),
    );
    expect({
      messageCount: messages.length,
      actionCount: overview.actionCount,
      categories: overview.categories,
      changedFiles: overview.changedFiles,
    }).toEqual({
      messageCount: productionMessages.length,
      actionCount: productionOverview.actionCount,
      categories: productionOverview.categories,
      changedFiles: productionOverview.changedFiles,
    });
  });

  test("enumerates nested session handles without opening file bodies", async () => {
    let getFileCalls = 0;
    const sessionHandle = {
      kind: "file" as const,
      name: "session.jsonl",
      getFile: async () => {
        getFileCalls += 1;
        return new File([], "session.jsonl");
      },
    };
    const ignoredHandle = {
      kind: "file" as const,
      name: "notes.txt",
      getFile: async () => new File([], "notes.txt"),
    };
    const nested = {
      kind: "directory" as const,
      name: "09",
      async *entries() {
        yield [sessionHandle.name, sessionHandle] as const;
        yield [ignoredHandle.name, ignoredHandle] as const;
      },
    };
    const root = {
      kind: "directory" as const,
      name: "sessions",
      async *entries() {
        yield [nested.name, nested] as const;
      },
    };

    const files = await collectCodexReplayDirectoryFiles(root);

    expect(files.map((file) => file.relativePath)).toEqual([
      "09/session.jsonl",
    ]);
    expect(files[0]?.handle).toBe(sessionHandle);
    expect(getFileCalls).toBe(0);
  });

  test("derives a session name from a bounded file prefix", async () => {
    const head = [
      JSON.stringify({
        timestamp: "2026-09-09T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "folder-session", cwd: "/repo/folder" },
      }),
      JSON.stringify({
        timestamp: "2026-09-09T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Make folder loading lazy" }],
        },
      }),
    ].join("\n");
    const sourceText = `${head}\n${"x".repeat(256 * 1024)}`;
    const requestedRanges: Array<[number, number]> = [];
    const file = {
      size: sourceText.length,
      slice(start?: number, end?: number) {
        requestedRanges.push([start ?? 0, end ?? sourceText.length]);
        return new Blob([sourceText.slice(start, end)]);
      },
    };

    const overview = await inspectCodexReplayFilePrefix(file, {
      maxBytes: 64 * 1024,
    });

    expect(requestedRanges).toContainEqual([0, 64 * 1024]);
    expect(
      requestedRanges.reduce((total, [start, end]) => total + end - start, 0),
    ).toBe(160 * 1024);
    expect(overview).toMatchObject({
      agent: "codex",
      sessionId: "folder-session",
      cwd: "/repo/folder",
      startedAt: "2026-09-09T10:00:00.000Z",
      title: "Make folder loading lazy",
    });
  });

  test("samples large files for line estimates without reading the body", async () => {
    const line = `${"x".repeat(99)}\n`;
    const sourceText = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "sampled-session", cwd: "/repo" },
      }),
      "\n",
      line.repeat(10_000),
    ].join("");
    let bytesRequested = 0;
    const file = {
      size: sourceText.length,
      slice(start?: number, end?: number) {
        bytesRequested += (end ?? sourceText.length) - (start ?? 0);
        return new Blob([sourceText.slice(start, end)]);
      },
    };

    const overview = await inspectCodexReplayFilePrefix(file, {
      maxBytes: 128 * 1024,
      lineSampleBytes: 16 * 1024,
    });

    expect(bytesRequested).toBeLessThan(256 * 1024);
    expect(overview?.lineCountExact).toBe(false);
    expect(overview?.lineCount).toBeGreaterThan(9_900);
    expect(overview?.lineCount).toBeLessThan(10_100);
  });

  test("widens the bounded title window only when the first pass has no name", async () => {
    const sourceText = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "late-title", cwd: "/repo" },
      }),
      "\n",
      JSON.stringify({ type: "bootstrap", text: "x".repeat(150 * 1024) }),
      "\n",
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Found after bootstrap" }],
        },
      }),
      "\n",
      "tail".repeat(300 * 1024),
    ].join("");
    const source = {
      size: sourceText.length,
      slice: (start?: number, end?: number) =>
        new Blob([sourceText.slice(start, end)]),
    };

    const overview = await inspectCodexReplayFilePrefix(source);

    expect(overview?.title).toBe("Found after bootstrap");
  });

  test("sorts folder sessions by exact size and sampled line count", () => {
    const sessions = [
      {
        title: "Small dense",
        mtimeMs: 3,
        transcript: { size: 100, lineCount: 80 },
      },
      {
        title: "Large sparse",
        mtimeMs: 2,
        transcript: { size: 10_000, lineCount: 12 },
      },
      {
        title: "Middle",
        mtimeMs: 1,
        transcript: { size: 1_000, lineCount: 40 },
      },
    ];

    expect(
      sortCodexReplaySessions(sessions, "size").map((s) => s.title),
    ).toEqual(["Large sparse", "Middle", "Small dense"]);
    expect(
      sortCodexReplaySessions(sessions, "lines").map((s) => s.title),
    ).toEqual(["Small dense", "Middle", "Large sparse"]);
  });

  test("lists detected models and filters to the selected model", () => {
    const sessions = [
      { title: "Older GPT", models: ["gpt-5.3-codex"], mtimeMs: 1 },
      { title: "Opus", models: ["claude-opus-4-6"], mtimeMs: 3 },
      {
        title: "Changed model",
        models: ["gpt-5.2-codex", "gpt-5.3-codex"],
        mtimeMs: 2,
      },
    ] as const;

    expect(listCodexReplaySessionModels(sessions)).toEqual([
      "claude-opus-4-6",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
    ]);
    expect(
      filterCodexReplaySessionsByModel(sessions, "gpt-5.3-codex").map(
        (session) => session.title,
      ),
    ).toEqual(["Older GPT", "Changed model"]);
  });

  test("searches session project paths and derives compact project labels", () => {
    const sessions = [
      {
        title: "Unrelated title",
        threadId: "session-a",
        transcript: {
          path: "/Users/herbst/.codex/sessions/a.jsonl",
          cwd: "/Users/herbst/git/Needle/fastvid",
        },
      },
      {
        title: "Another session",
        threadId: "session-b",
        transcript: {
          path: "/Users/herbst/.codex/sessions/b.jsonl",
          cwd: "/Users/herbst/git/supergit",
        },
      },
    ];

    expect(
      searchCodexReplaySessions(sessions, "needle").map(
        (session) => session.threadId,
      ),
    ).toEqual(["session-a"]);
    expect(
      searchCodexReplaySessions(sessions, "SUPERGIT").map(
        (session) => session.threadId,
      ),
    ).toEqual(["session-b"]);
    expect(codexReplayProjectLabel("/Users/herbst/git/Needle/fastvid/")).toBe(
      "fastvid",
    );
    expect(codexReplayProjectLabel("C:\\Users\\herbst\\git\\treetop")).toBe(
      "treetop",
    );
  });

  test("adapts server sessions and dropped files through one replay view model", async () => {
    const droppedReplay = await parseCodexReplayBlobAsync(
      new Blob([
        [
          JSON.stringify({
            timestamp: "2026-09-09T10:00:00.000Z",
            type: "session_meta",
            payload: { id: "shared-session", cwd: "/repo/shared" },
          }),
          JSON.stringify({
            timestamp: "2026-09-09T10:00:01.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Same transcript" }],
            },
          }),
        ].join("\n"),
      ]),
    );
    const dropped = createCodexReplayViewModel({
      replay: droppedReplay,
      title: "dropped.jsonl",
      mtimeMs: 123,
      fileSizeBytes: 456,
    });
    const server = createCodexReplayViewModel({
      session: dropped.session,
      title: "server session",
      mtimeMs: 789,
      source: "/sessions/shared.jsonl",
      lineCount: 2,
      fileSizeBytes: 456,
    });

    expect(server.playback.messages).toEqual(dropped.playback.messages);
    expect(server.session).toEqual(dropped.session);
    expect(server.entry.transcript?.path).toBe("/sessions/shared.jsonl");
    expect(server.replay).toMatchObject({
      lineCount: 2,
      fileSizeBytes: 456,
    });
    expect(dropped.entry.transcript?.path).toBe("");
  });

  test("streams a dropped Claude JSONL blob into the same local transcript view", async () => {
    const source = new Blob([
      [
        JSON.stringify({
          type: "mode",
          mode: "normal",
          sessionId: "claude-session",
        }),
        JSON.stringify({
          type: "file-history-snapshot",
          messageId: "snapshot-1",
          snapshot: {},
        }),
        JSON.stringify({
          type: "user",
          uuid: "u-1",
          sessionId: "claude-session",
          cwd: "/repo/claude",
          timestamp: "2026-09-09T10:00:00.000Z",
          message: { role: "user", content: "Inspect this" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a-1",
          sessionId: "claude-session",
          cwd: "/repo/claude",
          timestamp: "2026-09-09T10:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
              { type: "text", text: "Done" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "/tmp/a" },
              },
            ],
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              cache_read_input_tokens: 3,
            },
          },
        }),
        JSON.stringify({
          type: "summary",
          timestamp: "2026-09-09T10:00:02.000Z",
        }),
      ].join("\n"),
    ]);

    const replay = await parseCodexReplayBlobAsync(source);
    const messages = codexReplayMessagesUntil(replay, replay.steps.length);

    expect(replay).toMatchObject({
      agent: "claude",
      mode: "transcript",
      id: "claude-session",
      cwd: "/repo/claude",
    });
    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        blocks: [{ type: "text", text: "Inspect this" }],
      }),
      expect.objectContaining({
        role: "assistant",
        model: "claude-sonnet-4-6",
        tokenUsage: expect.objectContaining({
          input: 15,
          cachedInput: 3,
          output: 4,
        }),
      }),
      expect.objectContaining({
        role: "system",
        blocks: [{ type: "marker", text: "Context compacted" }],
      }),
    ]);
  });

  test("streams a dropped Codex JSONL blob into a local transcript", async () => {
    const rows = [
      JSON.stringify({
        timestamp: "2026-09-07T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-local", cwd: "/repo/local" },
      }),
      JSON.stringify({
        timestamp: "2026-09-07T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Dropped locally" }],
        },
      }),
      "not json",
      JSON.stringify({
        timestamp: "2026-09-07T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Rendered locally" }],
        },
      }),
    ];
    const source = new Blob([rows.join("\n")]);
    const progress: number[] = [];

    const replay = await parseCodexReplayBlobAsync(source, {
      onProgress: (update) => progress.push(update.parsed),
    });

    expect(replay).toMatchObject({
      mode: "transcript",
      id: "session-local",
      cwd: "/repo/local",
      lineCount: 4,
      fileSizeBytes: source.size,
    });
    expect(codexReplayMessagesUntil(replay, replay.steps.length)).toEqual([
      expect.objectContaining({
        role: "user",
        blocks: [{ type: "text", text: "Dropped locally" }],
      }),
      expect.objectContaining({
        role: "assistant",
        blocks: [{ type: "text", text: "Rendered locally" }],
      }),
    ]);
    expect(replay.warnings).toEqual(["Skipped line 3: not JSON"]);
    expect(progress.at(-1)).toBe(source.size);
  });

  test("clips retained output from a large dropped JSONL row", async () => {
    const source = new Blob([
      JSON.stringify({
        type: "session_meta",
        payload: { id: "session-large", cwd: "/repo" },
      }),
      "\n",
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "x".repeat(128 * 1024),
        },
      }),
    ]);

    const replay = await parseCodexReplayBlobAsync(source);
    const output = codexReplayMessagesUntil(replay, replay.steps.length)[0]
      ?.blocks[0]?.text;

    expect(output?.length).toBeLessThan(20 * 1024);
    expect(output).toEndWith("… [truncated by Treetop]");
  });

  test("attributes dropped transcript usage across turn-context model changes", async () => {
    const usage = (input: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: input,
              cached_input_tokens: 0,
              output_tokens: 10,
              reasoning_output_tokens: 2,
              total_tokens: input + 10,
            },
          },
        },
      });
    const source = new Blob([
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "session-models", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5.6-terra" },
        }),
        usage(100),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-6-astra" },
        }),
        usage(200),
      ].join("\n"),
    ]);

    const replay = await parseCodexReplayBlobAsync(source);
    const messages = codexReplayMessagesUntil(replay, replay.steps.length);

    expect(
      summarizeCodexReplayPricingUsage(messages).map((entry) => entry.model),
    ).toEqual(["gpt-5.6-terra", "gpt-6-astra"]);
    expect(
      createCodexReplayViewModel({
        replay,
        title: "model changes",
        mtimeMs: 1,
      }).entry.models,
    ).toEqual(["gpt-5.6-terra", "gpt-6-astra"]);
  });

  test("skips an oversized JSONL row and continues with later messages", async () => {
    const source = new Blob([
      JSON.stringify({
        type: "session_meta",
        payload: { id: "session-oversized", cwd: "/repo" },
      }),
      "\n",
      JSON.stringify({ type: "ignored", payload: "x".repeat(17 << 20) }),
      "\n",
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Still parsed" }],
        },
      }),
    ]);

    const replay = await parseCodexReplayBlobAsync(source);

    expect(replay.lineCount).toBe(3);
    expect(replay.warnings).toContain(
      "Skipped line 2: exceeds 16 MiB safety limit",
    );
    expect(codexReplayMessagesUntil(replay, replay.steps.length)[0]).toEqual(
      expect.objectContaining({
        blocks: [{ type: "text", text: "Still parsed" }],
      }),
    );
  });

  test("scores suspicious turn activity without blaming tool time on model throughput", () => {
    const toolBlocks = Array.from({ length: 12 }, (_, index) => ({
      type: "tool_use" as const,
      toolName: "exec_command",
      toolUseId: `tool-${index}`,
    }));
    const analysis = analyzeCodexReplayTurns([
      {
        role: "user",
        timestamp: "2026-09-04T10:00:00.000Z",
        blocks: [{ type: "text", text: "Run the audit" }],
      },
      {
        role: "assistant",
        timestamp: "2026-09-04T10:00:05.000Z",
        blocks: toolBlocks,
      },
      {
        role: "assistant",
        timestamp: "2026-09-04T10:00:10.000Z",
        blocks: [],
        tokenUsage: {
          input: 30_000,
          cachedInput: 5_000,
          cacheWriteInput: 0,
          output: 100,
          reasoningOutput: 20,
          total: 30_120,
        },
      },
      {
        role: "user",
        timestamp: "2026-09-04T10:01:00.000Z",
        blocks: [{ type: "text", text: "Answer directly" }],
      },
      {
        role: "assistant",
        timestamp: "2026-09-04T10:01:20.000Z",
        blocks: [],
        tokenUsage: {
          input: 100,
          cachedInput: 90,
          cacheWriteInput: 0,
          output: 30,
          reasoningOutput: 0,
          total: 160,
        },
      },
    ]);

    expect(analysis.turns).toHaveLength(2);
    expect(analysis.turns[0]).toEqual(
      expect.objectContaining({
        toolCallCount: 12,
        newInputTokens: 25_000,
        outputTokens: 100,
      }),
    );
    expect(analysis.turns[0]?.issues.map((issue) => issue.kind)).toEqual([
      "high-tool-usage",
      "high-new-input",
    ]);
    expect(analysis.turns[1]).toEqual(
      expect.objectContaining({
        durationMs: 20_000,
        tokensPerSecond: 1.5,
        toolCallCount: 0,
      }),
    );
    expect(analysis.turns[1]?.issues.map((issue) => issue.kind)).toEqual([
      "low-throughput",
    ]);
    expect(analysis.issueTurnCount).toBe(2);
  });

  test("keeps ordinary turns visible in the heat map without inventing issues", () => {
    const analysis = analyzeCodexReplayTurns([
      {
        role: "user",
        timestamp: "2026-09-04T10:00:00.000Z",
        blocks: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        timestamp: "2026-09-04T10:00:02.000Z",
        blocks: [{ type: "text", text: "Hi" }],
        tokenUsage: {
          input: 80,
          cachedInput: 70,
          cacheWriteInput: 0,
          output: 40,
          reasoningOutput: 0,
          total: 120,
        },
      },
    ]);

    expect(analysis.turns).toHaveLength(1);
    expect(analysis.turns[0]?.issues).toEqual([]);
    expect(analysis.turns[0]?.heat).toBeGreaterThan(0);
    expect(analysis.issueTurnCount).toBe(0);
  });

  test("attributes replay turn and session prices across model changes", () => {
    const messages = [
      {
        role: "user" as const,
        timestamp: "2026-09-06T16:44:34.000Z",
        blocks: [{ type: "text" as const, text: "Start" }],
      },
      {
        role: "assistant" as const,
        timestamp: "2026-09-06T16:45:00.000Z",
        model: "gpt-5.6-terra",
        blocks: [],
        tokenUsage: {
          input: 1_000_000,
          cachedInput: 0,
          cacheWriteInput: 0,
          output: 0,
          reasoningOutput: 0,
          total: 1_000_000,
        },
      },
      {
        role: "user" as const,
        timestamp: "2026-09-06T18:01:47.000Z",
        blocks: [{ type: "text" as const, text: "Continue" }],
      },
      {
        role: "assistant" as const,
        timestamp: "2026-09-06T18:02:00.000Z",
        model: "gpt-6-astra",
        blocks: [],
        tokenUsage: {
          input: 0,
          cachedInput: 0,
          cacheWriteInput: 0,
          output: 1_000_000,
          reasoningOutput: 0,
          total: 1_000_000,
        },
      },
    ];

    const usage = summarizeCodexReplayPricingUsage(messages);
    expect(usage.map((segment) => segment.model)).toEqual([
      "gpt-5.6-terra",
      "gpt-6-astra",
    ]);
    expect(usage.map((segment) => segment.usage.total)).toEqual([
      1_000_000, 1_000_000,
    ]);

    const analysis = analyzeCodexReplayTurns(messages);
    expect(analysis.turns[0]?.estimatedCostUsd).toBeGreaterThan(0);
    expect(analysis.turns[1]?.estimatedCostUsd).toBeGreaterThan(0);
    expect(analysis.totalEstimatedCostUsd).toBeCloseTo(
      analysis.turns[0]!.estimatedCostUsd! +
        analysis.turns[1]!.estimatedCostUsd!,
    );
  });

  test("uses the user's request rather than ambient browser context as the turn label", () => {
    const analysis = analyzeCodexReplayTurns([
      {
        role: "user",
        blocks: [
          {
            type: "text",
            text: `<in-app-browser-context source="ambient-ui-state">
Current page details that are not part of the request.
</in-app-browser-context>
## My request for Codex:
Narrate this page live`,
          },
        ],
      },
    ]);

    expect(analysis.turns[0]?.label).toBe("Narrate this page live");
  });

  test("renders escaped Codex request text cleanly in turn labels", () => {
    const analysis = analyzeCodexReplayTurns([
      {
        role: "user",
        blocks: [
          {
            type: "text",
            text: "Some bugs:&#x20;1\\) detached object\\. 2\\) bad timing",
          },
        ],
      },
    ]);

    expect(analysis.turns[0]?.label).toBe(
      "Some bugs: 1) detached object. 2) bad timing",
    );
  });

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
      { threadId: "both", hasTranscript: true, rpcFrameCount: 2 },
      { threadId: "rpc-only", hasTranscript: false, rpcFrameCount: 1 },
      { threadId: "also-both", hasTranscript: true, rpcFrameCount: 3 },
      { threadId: "transcript-only", hasTranscript: true, rpcFrameCount: 0 },
    ];

    expect(summarizeCodexReplaySessions(sessions)).toEqual({
      total: 4,
      rpc: 3,
      transcript: 3,
      both: 2,
      rpcOnly: 1,
      transcriptOnly: 1,
    });
    expect(
      filterCodexReplaySessions(sessions, "both").map((item) => item.threadId),
    ).toEqual(["both", "also-both"]);
    expect(
      filterCodexReplaySessions(sessions, "rpc-only").map(
        (item) => item.threadId,
      ),
    ).toEqual(["rpc-only"]);
    expect(
      filterCodexReplaySessions(sessions, "transcript-only").map(
        (item) => item.threadId,
      ),
    ).toEqual(["transcript-only"]);
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

  test("maps replay steps onto transcript time for realtime playback", () => {
    const replay = {
      mode: "transcript" as const,
      steps: [
        { at: "2026-09-09T10:00:00.000Z" },
        { at: "2026-09-09T10:00:02.000Z" },
        {},
        { at: "2026-09-09T10:00:12.000Z" },
      ],
    };

    expect(replayElapsedMsAtStep(replay, 0)).toBe(0);
    expect(replayElapsedMsAtStep(replay, 2)).toBe(2_000);
    expect(replayElapsedMsAtStep(replay, 3)).toBe(2_000);
    expect(replayDurationMs(replay)).toBe(12_000);
    expect(replayStepIndexAtElapsedMs(replay, 0)).toBe(1);
    expect(replayStepIndexAtElapsedMs(replay, 1_999)).toBe(1);
    expect(replayStepIndexAtElapsedMs(replay, 2_000)).toBe(3);
    expect(replayStepIndexAtElapsedMs(replay, 11_999)).toBe(3);
    expect(replayStepIndexAtElapsedMs(replay, 12_000)).toBe(4);
  });

  test("formats replay clock time without losing hour-scale sessions", () => {
    expect(formatReplayClock(0)).toBe("0:00");
    expect(formatReplayClock(62_000)).toBe("1:02");
    expect(formatReplayClock(3_661_000)).toBe("1:01:01");
  });

  test("defines realtime multipliers and fixed step rates independently", () => {
    expect(replayPlaybackTiming("time:10")).toEqual({
      mode: "time",
      multiplier: 10,
      tickMs: 50,
    });
    expect(replayPlaybackTiming("steps:5")).toEqual({
      mode: "steps",
      stepsPerSecond: 5,
      tickMs: 200,
    });
  });

  test("tracks exact source bytes and lines as a streamed replay advances", async () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "progress", cwd: "/repo" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "first 🧪" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "second" }],
        },
      }),
    ];
    const text = `${lines.join("\n")}\n`;
    const replay = await parseCodexReplayBlobAsync(new Blob([text]));

    expect(replaySourceProgressAtStep(replay, 0)).toEqual({
      lineCount: 0,
      fileSizeBytes: 0,
      exact: true,
    });
    expect(replaySourceProgressAtStep(replay, 1)).toEqual({
      lineCount: 2,
      fileSizeBytes: new TextEncoder().encode(`${lines[0]}\n${lines[1]}\n`)
        .byteLength,
      exact: true,
    });
    expect(replaySourceProgressAtStep(replay, replay.steps.length)).toEqual({
      lineCount: 3,
      fileSizeBytes: new TextEncoder().encode(text).byteLength,
      exact: true,
    });
  });

  test("falls back to proportional source progress without raw offsets", () => {
    const replay = {
      mode: "transcript" as const,
      lineCount: 40,
      fileSizeBytes: 1_000,
      steps: [{}, {}, {}, {}],
    };

    expect(replaySourceProgressAtStep(replay, 1)).toEqual({
      lineCount: 10,
      fileSizeBytes: 250,
      exact: false,
    });
  });

  test("opens a dropped transcript at the end while retaining replay state", () => {
    const replay = parseCodexReplayText(
      [
        JSON.stringify({
          timestamp: "2026-09-09T10:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-09-09T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "second" }],
          },
        }),
      ].join("\n"),
    );

    const playback = createCodexReplayPlayback(replay, {
      stepIndex: replay.steps.length,
    });
    expect(playback.stepIndex).toBe(replay.steps.length);
    expect(playback.totalMessageCount).toBe(2);
    expect(
      setCodexReplayPlaybackStep(playback, 1).messages.map(
        (message) => message.role,
      ),
    ).toEqual(["user"]);
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

  test("keeps Codex subagent activity when a transcript is dropped", () => {
    const replay = parseCodexReplayText(
      [
        JSON.stringify({
          timestamp: "2026-09-09T17:51:52.750Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "SubAgentActivity",
              id: "call-spawn-audio",
              kind: "started",
              agent_thread_id: "01a0874c-317f-7b63-ad0d-3b22af3faa93",
              agent_path: "/root/audio_types",
            },
          },
        }),
      ].join("\n"),
    );

    expect(replay.steps).toEqual([
      expect.objectContaining({
        kind: "message",
        message: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              type: "subagent",
              subagentNickname: "audio_types",
              subagentAction: "spawn",
              subagentStatus: "running",
            }),
          ],
        }),
      }),
    ]);
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
