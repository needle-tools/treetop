import { describe, expect, test } from "bun:test";
import { codexAppHistoryMessagesFromThread } from "../src/codex-event-stream";
import {
  parseClaudeJsonl,
  parseCodexJsonl,
  parseOllamaJsonl,
  type NormalizedBlock,
  type NormalizedMessage,
} from "../../daemon/src/sessions";
import {
  buildVisualTranscriptItems,
  buildVisualWorkDisplayEntries,
  cleanVisualToolResultText,
  latestVisualGoal,
  latestVisualPlan,
  visualSubagentMetaFromBlock,
  visualSubagentMetaFromBlocks,
  visualTranscriptSubagents,
  visualWorkSubagents,
} from "../src/last-user-message";

function jsonl(entries: object[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function onlyWorkItem(messages: NormalizedMessage[]) {
  const items = buildVisualTranscriptItems<NormalizedBlock, NormalizedMessage>(
    messages,
  );
  const work = items.find((item) => item.kind === "work");
  if (!work || work.kind !== "work") {
    throw new Error("expected a visual work item");
  }
  return { items, work };
}

describe("visual transcript provider flow", () => {
  test("keeps Codex transcript timing and usage when a turn has no tools", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-09-10T11:02:55.516Z",
          type: "event_msg",
          payload: { type: "task_started" },
        },
        {
          timestamp: "2026-09-10T11:02:56.176Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
        {
          timestamp: "2026-09-10T11:03:00.333Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi!" }],
          },
        },
        {
          timestamp: "2026-09-10T11:03:00.362Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 21_678,
                cached_input_tokens: 0,
                output_tokens: 15,
                reasoning_output_tokens: 0,
                total_tokens: 21_693,
              },
            },
          },
        },
        {
          timestamp: "2026-09-10T11:03:00.367Z",
          type: "event_msg",
          payload: { type: "task_complete" },
        },
      ]),
    );

    const { items, work } = onlyWorkItem(session.messages);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    expect(work).toMatchObject({
      startedAt: "2026-09-10T11:02:56.176Z",
      endedAt: "2026-09-10T11:03:00.367Z",
    });
    expect(
      work.entries.find((entry) => entry.message.tokenUsage)?.message
        .tokenUsage,
    ).toEqual({
      input: 21_678,
      cachedInput: 0,
      cacheWriteInput: 0,
      output: 15,
      reasoningOutput: 0,
      total: 21_693,
    });
  });

  test("turns Codex JSONL into paired command work and marker badges", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-19T10:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "check the event stream" }],
          },
        },
        {
          timestamp: "2026-06-19T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I'll inspect it." }],
          },
        },
        {
          timestamp: "2026-06-19T10:00:10.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: 'rg "codex-app/events|Codex app" packages/ui/src',
            }),
            call_id: "call-1",
          },
        },
        {
          timestamp: "2026-06-19T10:00:12.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output:
              "Chunk ID: abc123 Wall time: 0.1234 seconds Process exited with code 0 Original token count: 2 Output: found",
          },
        },
        {
          timestamp: "2026-06-19T10:00:13.000Z",
          type: "event_msg",
          payload: { type: "task_complete" },
        },
        {
          timestamp: "2026-06-19T10:01:15.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        },
      ]),
    );

    const { items, work } = onlyWorkItem(session.messages);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
      "message",
    ]);
    expect(work.endedAt).toBe("2026-06-19T10:00:13.000Z");

    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    const commandEntry = displayEntries.find((entry) =>
      entry.entry.blocks.some(
        (block) =>
          block.type === "tool_use" && block.toolName === "exec_command",
      ),
    );
    expect(commandEntry?.entry.blocks[0]).toMatchObject({
      type: "tool_use",
      toolName: "exec_command",
      toolUseId: "call-1",
      toolInput: {
        cmd: 'rg "codex-app/events|Codex app" packages/ui/src',
      },
    });
    expect(commandEntry?.pairedResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call-1",
    });
    expect(
      cleanVisualToolResultText(commandEntry?.pairedResult?.blocks[0]?.text),
    ).toMatchObject({
      title: "Command output",
      body: "found",
      wallTimeSeconds: 0.1234,
      exitCode: 0,
    });

    expect(displayEntries).toContainEqual(
      expect.objectContaining({
        kind: "marker",
        markerKind: "complete",
        markerLabel: "Task complete",
      }),
    );
  });

  test("normalizes short Codex exec tool names into command work", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-01T10:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "inspect files" }],
          },
        },
        {
          timestamp: "2026-06-01T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec",
            call_id: "call-exec",
            arguments: JSON.stringify({
              cmd: "sed -n '1,120p' src/TextureGenerator.js",
              workdir: "/repo",
            }),
          },
        },
        {
          timestamp: "2026-06-01T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-exec",
            output:
              "Chunk ID: abc123\nWall time: 0.1234 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\nimport three",
          },
        },
      ]),
    );

    const { work } = onlyWorkItem(session.messages);
    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    const commandEntry = displayEntries.find((entry) =>
      entry.entry.blocks.some(
        (block) =>
          block.type === "tool_use" && block.toolUseId === "call-exec",
      ),
    );

    expect(commandEntry?.entry.blocks[0]).toMatchObject({
      type: "tool_use",
      toolName: "exec_command",
      toolUseId: "call-exec",
      toolInput: {
        cmd: "sed -n '1,120p' src/TextureGenerator.js",
        workdir: "/repo",
      },
    });
    expect(commandEntry?.pairedResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "exec_command",
      toolUseId: "call-exec",
    });
  });

  test("normalizes Codex subagent spawn, wait, and notification rows", () => {
    const subagentId = "019f27fe-0f3d-7a50-8371-3344fbaee5d0";
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-07-03T12:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "compare the importer" }],
          },
        },
        {
          timestamp: "2026-07-03T12:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-spawn",
            arguments: JSON.stringify({
              agent_type: "explorer",
              model: "gpt-5.5",
              reasoning_effort: "xhigh",
              message: "Inspect OpenUSD material imports.",
            }),
          },
        },
        {
          timestamp: "2026-07-03T12:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-spawn",
            output: JSON.stringify({
              agent_id: subagentId,
              nickname: "Leibniz",
            }),
          },
        },
        {
          timestamp: "2026-07-03T12:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "wait_agent",
            call_id: "call-wait",
            arguments: JSON.stringify({
              targets: [subagentId],
              timeout_ms: 3600000,
            }),
          },
        },
        {
          timestamp: "2026-07-03T12:00:04.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-wait",
            output: JSON.stringify({
              status: {
                [subagentId]: {
                  completed: "**Findings**\n\n- First finding.",
                },
              },
            }),
          },
        },
        {
          timestamp: "2026-07-03T12:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "<subagent_notification>\n" +
                  JSON.stringify({
                    agent_path: subagentId,
                    status: { completed: "**Findings**\n\n- First finding." },
                  }) +
                  "\n</subagent_notification>",
              },
            ],
          },
        },
        {
          timestamp: "2026-07-03T12:00:06.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The subagent found it." }],
          },
        },
      ]),
    );

    const spawnUse = session.messages
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === "tool_use" && block.toolName === "spawn_agent",
      );
    const spawnResult = session.messages
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === "tool_result" && block.toolUseId === "call-spawn",
      );
    expect(visualSubagentMetaFromBlocks(spawnUse, spawnResult)).toMatchObject({
      action: "spawn",
      status: "running",
      id: subagentId,
      nickname: "Leibniz",
      type: "explorer",
      model: "gpt-5.5",
      effort: "xhigh",
      task: "Inspect OpenUSD material imports.",
    });

    const waitUse = session.messages
      .flatMap((message) => message.blocks)
      .find(
        (block) => block.type === "tool_use" && block.toolName === "wait_agent",
      );
    const waitResult = session.messages
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === "tool_result" && block.toolUseId === "call-wait",
      );
    expect(visualSubagentMetaFromBlocks(waitUse, waitResult)).toMatchObject({
      action: "wait",
      status: "completed",
      id: subagentId,
      result: "**Findings**\n\n- First finding.",
    });

    const notification = session.messages.find((message) =>
      message.blocks.some((block) => block.type === "subagent"),
    );
    expect(notification?.role).toBe("assistant");
    expect(visualSubagentMetaFromBlock(notification?.blocks[0])).toMatchObject({
      action: "notification",
      status: "completed",
      id: subagentId,
    });

    const { work } = onlyWorkItem(session.messages);
    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    expect(
      displayEntries.some(
        (entry) =>
          entry.entry.blocks[0]?.type === "tool_use" &&
          entry.entry.blocks[0]?.toolName === "spawn_agent",
      ),
    ).toBe(true);
    expect(
      displayEntries.some(
        (entry) => entry.entry.blocks[0]?.type === "subagent",
      ),
    ).toBe(false);
    const displayedWait = displayEntries.find(
      (entry) =>
        entry.entry.blocks[0]?.type === "tool_use" &&
        entry.entry.blocks[0]?.toolName === "wait_agent",
    );
    expect(
      visualSubagentMetaFromBlocks(
        displayedWait?.entry.blocks[0],
        displayedWait?.pairedResult?.blocks[0],
      ),
    ).toMatchObject({
      action: "wait",
      status: "completed",
      id: subagentId,
    });
  });

  test("keeps the parent's full plaintext task and skills without listing the parent as a child", () => {
    const task = "Inspect the rendering.\nSender: retain this payload line.\nTask name: retain this too.";
    const session = parseCodexJsonl(jsonl([
      { type: "session_meta", payload: { id: "child", parent_thread_id: "parent", agent_path: "/root/reviewer" } },
      { type: "response_item", payload: { type: "message", role: "developer",
        content: [{ type: "input_text", text: "<skills_instructions>Read the rendering skill.</skills_instructions>" }] } },
      { type: "response_item", payload: { type: "agent_message", author: "/root", recipient: "/root/reviewer",
        content: [{ type: "input_text", text: `Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\n${task}` }] } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", id: "send-parent",
        kind: "interacted", agent_thread_id: "parent", agent_path: "/root" } } },
    ]));
    expect(session.messages.flatMap(message => message.blocks).some(block =>
      block.type === "context_update" && block.text?.includes("Read the rendering skill."))).toBe(true);
    expect(session.messages.find(message => message.role === "user")?.blocks[0]?.text).toBe(`Task from root\n${task}`);
    expect(visualTranscriptSubagents(buildVisualTranscriptItems(session.messages))).toEqual([]);
  });

  test("renders every native collaboration receiver with the same metadata as app-server history", () => {
    const item = { type: "collabAgentToolCall", id: "wait", tool: "wait", status: "completed", receiverThreadIds: ["a", "b"], prompt: null,
      agentsStates: { a: { status: "completed", message: "A complete" }, b: { status: "running", message: null } } };
    const user = { role: "user", blocks: [{ type: "text", text: "Review" }] };
    const session = parseCodexJsonl(jsonl([
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review" }] } },
      { type: "event_msg", payload: { type: "item_completed", item: { ...item, type: "CollabAgentToolCall", receiver_thread_ids: item.receiverThreadIds, agents_states: item.agentsStates } } },
    ]));
    const live = codexAppHistoryMessagesFromThread({ turns: [{ id: "turn", items: [item] }] });
    const transcriptRoster = visualTranscriptSubagents(buildVisualTranscriptItems(session.messages));
    const liveRoster = visualTranscriptSubagents(buildVisualTranscriptItems([user, ...live]));
    expect(transcriptRoster.map(agent => agent.id)).toEqual(["a", "b"]);
    expect(transcriptRoster).toEqual(liveRoster);
  });

  test("keeps readable task metadata when a child task body is encrypted", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-10-08T08:58:24.000Z",
          type: "session_meta",
          payload: {
            id: "01a11a4e-5a46-7ee1-81d8-560f780287ce",
            agent_path: "/root/headphones_reference_02",
            parent_thread_id: "parent-thread",
          },
        },
        {
          timestamp: "2026-10-08T08:58:25.000Z",
          type: "response_item",
          payload: {
            type: "agent_message",
            author: "/root",
            recipient: "/root/headphones_reference_02",
            content: [
              {
                type: "input_text",
                text: [
                  "Message Type: NEW_TASK",
                  "Task name: /root/headphones_reference_02",
                  "Sender: /root",
                  "Payload:",
                ].join("\n"),
              },
              { type: "encrypted_content", data: "gAAAAA-encrypted-task" },
            ],
          },
        },
      ]),
    );

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      blocks: [
        {
          type: "text",
          text: "Task from root\nheadphones_reference_02\nTask text is encrypted in this recording.",
        },
      ],
    });
  });

  test("normalizes Codex SubAgentActivity rows and keeps one badge per child", () => {
    const childId = "01a0874c-317f-7b63-ad0d-3b22af3faa93";
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-09-09T17:51:50.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "check the type surface" }],
          },
        },
        {
          timestamp: "2026-09-09T17:51:52.678Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-spawn-audio",
            arguments: JSON.stringify({
              task_name: "audio_types",
              model: "gpt-5.6-luna",
              message: `gAAAAABq${"x".repeat(120)}`,
            }),
          },
        },
        {
          timestamp: "2026-09-09T17:51:52.750Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "SubAgentActivity",
              id: "call-spawn-audio",
              kind: "started",
              agent_thread_id: childId,
              agent_path: "/root/audio_types",
            },
          },
        },
        {
          timestamp: "2026-09-09T18:03:49.658Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "SubAgentActivity",
              id: "subagent-completed-audio",
              kind: "completed",
              agent_thread_id: childId,
              agent_path: "/root/audio_types",
            },
          },
        },
      ]),
    );

    const activities = session.messages.filter((message) =>
      message.blocks.some((block) => block.type === "subagent"),
    );
    expect(activities).toHaveLength(2);
    expect(activities[0]?.blocks[0]).toMatchObject({
      type: "subagent",
      toolUseId: "call-spawn-audio",
      subagentId: childId,
      subagentNickname: "audio_types",
      subagentAction: "spawn",
      subagentStatus: "running",
    });
    expect(activities[1]?.blocks[0]).toMatchObject({
      type: "subagent",
      subagentId: childId,
      subagentAction: "notification",
      subagentStatus: "completed",
    });

    const { work } = onlyWorkItem(session.messages);
    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    const agents = visualWorkSubagents(displayEntries);
    expect(agents).toEqual([
      expect.objectContaining({
        id: childId,
        nickname: "audio_types",
        status: "completed",
      }),
    ]);
    expect(agents[0]?.task).toBeUndefined();
    expect(
      displayEntries.filter(
        (entry) => entry.entry.blocks[0]?.type === "subagent",
      ),
    ).toHaveLength(1);
    expect(visualTranscriptSubagents(onlyWorkItem(session.messages).items)).toEqual([
      expect.objectContaining({
        id: childId,
        nickname: "audio_types",
        model: "gpt-5.6-luna",
        status: "completed",
      }),
    ]);
  });

  test("joins current Codex collaboration rows without inventing wait agents", () => {
    const childId = "01a115d7-d6d0-7970-a07c-8a63d1364f94";
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-10-07T12:10:00.000Z",
          type: "session_meta",
          payload: { id: "parent" },
        },
        {
          timestamp: "2026-10-07T12:10:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Review the implementation." }],
          },
        },
        {
          timestamp: "2026-10-07T12:10:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-spawn-review",
            arguments: JSON.stringify({
              task_name: "implementation_review",
              model: "gpt-6-astra",
              reasoning_effort: "high",
              message: `gAAAAABq${"x".repeat(120)}`,
            }),
          },
        },
        {
          timestamp: "2026-10-07T12:10:02.100Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "SubAgentActivity",
              id: "call-spawn-review",
              kind: "started",
              agent_thread_id: childId,
              agent_path: "/root/implementation_review",
            },
          },
        },
        {
          timestamp: "2026-10-07T12:10:02.200Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-spawn-review",
            output: JSON.stringify({ task_name: "/root/implementation_review" }),
          },
        },
        {
          timestamp: "2026-10-07T12:10:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "wait_agent",
            call_id: "call-wait-any",
            arguments: JSON.stringify({ timeout_ms: 30_000 }),
          },
        },
        {
          timestamp: "2026-10-07T12:10:33.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-wait-any",
            output: JSON.stringify({ timed_out: true }),
          },
        },
        {
          timestamp: "2026-10-07T12:10:34.000Z",
          type: "response_item",
          payload: {
            type: "agent_message",
            author: "/root/implementation_review",
            recipient: "/root",
            content: [
              {
                type: "output_text",
                text:
                  "Message Type: FINAL_ANSWER\n" +
                  "Task name: implementation_review\n" +
                  "Sender: /root/implementation_review\n" +
                  "Payload:\nThe implementation is sound.",
              },
            ],
          },
        },
        {
          timestamp: "2026-10-07T12:10:34.100Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "list_agents",
            call_id: "call-list",
            arguments: "{}",
          },
        },
        {
          timestamp: "2026-10-07T12:10:34.200Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-list",
            output: JSON.stringify({
              agents: [
                { agent_name: "/root", agent_status: "running" },
                {
                  agent_name: "/root/implementation_review",
                  agent_status: { completed: "The implementation is sound." },
                },
              ],
            }),
          },
        },
        {
          timestamp: "2026-10-07T12:10:35.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-spawn-full",
            arguments: JSON.stringify({
              task_name: "extra_review",
              message: `gAAAAABq${"y".repeat(120)}`,
            }),
          },
        },
        {
          timestamp: "2026-10-07T12:10:35.100Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-spawn-full",
            output: "collab spawn failed: agent thread limit reached",
          },
        },
      ]),
    );

    const agents = visualTranscriptSubagents(onlyWorkItem(session.messages).items);
    expect(agents).toHaveLength(2);
    expect(agents).toContainEqual(
      expect.objectContaining({
        id: childId,
        nickname: "implementation_review",
        model: "gpt-6-astra",
        effort: "high",
        status: "completed",
        result: "The implementation is sound.",
      }),
    );
    expect(agents).toContainEqual(
      expect.objectContaining({
        nickname: "extra_review",
        status: "failed",
        result: "collab spawn failed: agent thread limit reached",
      }),
    );
    expect(agents.every((agent) => agent.action !== "wait")).toBe(true);
    expect(agents.every((agent) => agent.task === undefined)).toBe(true);
    expect(
      session.messages
        .flatMap((message) => message.blocks)
        .filter(
          (block) =>
            block.type === "subagent" &&
            block.subagentId === childId &&
            block.subagentResult === "The implementation is sound.",
        ),
    ).toHaveLength(2);
  });

  test("attaches Codex turn approval context to command tools", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-30T10:00:00.000Z",
          type: "turn_context",
          payload: {
            turn_id: "turn-1",
            approval_policy: "on-request",
            sandbox_policy: { type: "workspace-write" },
          },
        },
        {
          timestamp: "2026-06-30T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "bun test" }),
            call_id: "call-approval",
          },
        },
      ]),
    );

    const block = session.messages
      .flatMap((message) => message.blocks)
      .find((candidate) => candidate.type === "tool_use");

    expect(block).toMatchObject({
      type: "tool_use",
      toolName: "exec_command",
      approvalPolicy: "on-request",
      sandboxPolicy: "workspace-write",
    });
  });

  test("shows Codex developer-context updates but keeps injected user wrappers out of turns", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-01T16:43:41.257Z",
          type: "event_msg",
          payload: { type: "task_started" },
        },
        {
          timestamp: "2026-06-01T16:43:41.258Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "<permissions instructions>\nFilesystem sandboxing enabled\n</permissions instructions>",
              },
            ],
          },
        },
        {
          timestamp: "2026-06-01T16:43:41.260Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>/Users/herbst/git/pdf.js</cwd>\n</environment_context>",
              },
            ],
          },
        },
        {
          timestamp: "2026-06-16T11:29:21.985Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>',
              },
            ],
          },
        },
        {
          timestamp: "2026-06-01T16:43:41.317Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>/Users/herbst/git/pdf.js</cwd>\n</environment_context>\nAudit the print feature PR.",
              },
            ],
          },
        },
        {
          timestamp: "2026-06-01T16:43:48.151Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "I’ll inspect the local diff first.",
          },
        },
        {
          timestamp: "2026-06-01T16:43:48.165Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "I’ll inspect the local diff first." },
            ],
          },
        },
      ]),
    );

    const items = buildVisualTranscriptItems(session.messages);

    expect(session.messages).toHaveLength(4);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "message",
      blocks: [
        {
          type: "context_update",
          contextRole: "developer",
          contextPhase: "set",
          contextCategory: "Permissions instructions",
          contextCharacters: 84,
        },
      ],
    });
    expect(items[1]).toMatchObject({
      kind: "message",
      blocks: [{ type: "text", text: "Audit the print feature PR." }],
    });
    expect(items[2]).toMatchObject({
      kind: "message",
      blocks: [{ type: "text", text: "I’ll inspect the local diff first." }],
    });
  });

  test("surfaces Codex goal state without rendering repeated goal prompts", () => {
    const objective = "Make the UI smooth.";
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-26T00:00:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "create_goal",
            arguments: JSON.stringify({ objective }),
            call_id: "goal-1",
          },
        },
        {
          timestamp: "2026-06-26T00:00:00.010Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "goal-1",
            output: JSON.stringify({
              goal: {
                threadId: "thread-1",
                objective,
                status: "active",
                tokensUsed: 0,
                timeUsedSeconds: 0,
                updatedAt: 1782432282,
              },
            }),
          },
        },
        {
          timestamp: "2026-06-26T00:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `<goal_context>
Continue working toward the active thread goal.

<objective>
${objective}
</objective>
</goal_context>`,
              },
            ],
          },
        },
        {
          timestamp: "2026-06-26T00:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Now fix the sidebar." }],
          },
        },
      ]),
    );

    expect(latestVisualGoal(session.messages)).toMatchObject({
      objective,
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      threadId: "thread-1",
    });
    expect(buildVisualTranscriptItems(session.messages)).toEqual([
      expect.objectContaining({
        kind: "message",
        blocks: [{ type: "text", text: "Now fix the sidebar." }],
      }),
    ]);
  });

  test("keeps Codex tool output visible when the matching call is outside the retained slice", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-19T10:00:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "check the logs" }],
          },
        },
        {
          timestamp: "2026-06-19T10:00:12.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-from-before-the-window",
            output:
              "Chunk ID: abc123 Wall time: 0.2500 seconds Process exited with code 0 Original token count: 2 Output: restored prior state prefs shape for repro",
          },
        },
        {
          timestamp: "2026-06-19T10:00:30.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Found it." }],
          },
        },
      ]),
    );

    const { work } = onlyWorkItem(session.messages);
    const displayEntries = buildVisualWorkDisplayEntries(work.entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]?.pairedResult).toBeUndefined();
    expect(displayEntries[0]?.entry.blocks[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call-from-before-the-window",
    });
    expect(
      cleanVisualToolResultText(displayEntries[0]?.entry.blocks[0]?.text),
    ).toMatchObject({
      title: "Command output",
      body: "restored prior state prefs shape for repro",
      wallTimeSeconds: 0.25,
      exitCode: 0,
    });
  });

  test("turns Codex update_plan calls into the latest visual plan", () => {
    const session = parseCodexJsonl(
      jsonl([
        {
          timestamp: "2026-06-19T22:24:16.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "add todo UI" }],
          },
        },
        {
          timestamp: "2026-06-19T22:24:18.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "update_plan",
            call_id: "plan-call-1",
            arguments: JSON.stringify({
              explanation: "Implement the todo plan surface.",
              plan: [
                { step: "Inspect sample JSONL", status: "completed" },
                { step: "Add composer plan pane", status: "in_progress" },
                { step: "Verify parser/UI behavior", status: "pending" },
              ],
            }),
          },
        },
        {
          timestamp: "2026-06-19T22:24:20.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "On it." }],
          },
        },
      ]),
    );

    expect(latestVisualPlan(session.messages)).toMatchObject({
      explanation: "Implement the todo plan surface.",
      completed: 1,
      inProgress: 1,
      total: 3,
    });
    const { work } = onlyWorkItem(session.messages);
    expect(work.entries[0]?.blocks[0]).toMatchObject({
      type: "plan",
      toolName: "update_plan",
      toolInput: {
        explanation: "Implement the todo plan surface.",
      },
      planItems: [
        { step: "Inspect sample JSONL", status: "completed" },
        { step: "Add composer plan pane", status: "in_progress" },
        { step: "Verify parser/UI behavior", status: "pending" },
      ],
    });
  });

  test("turns Claude JSONL into paired Bash work", () => {
    const session = parseClaudeJsonl(
      jsonl([
        {
          timestamp: "2026-06-19T11:00:00.000Z",
          type: "user",
          message: {
            role: "user",
            content: "run the focused tests",
          },
        },
        {
          timestamp: "2026-06-19T11:00:10.000Z",
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Running them now." },
              {
                type: "tool_use",
                id: "tu-1",
                name: "Bash",
                input: {
                  command: "bun test packages/ui/test/last-user-message.test.ts",
                },
              },
            ],
          },
        },
        {
          timestamp: "2026-06-19T11:00:12.000Z",
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-1",
                content: "1 pass",
              },
            ],
          },
        },
        {
          timestamp: "2026-06-19T11:00:30.000Z",
          type: "assistant",
          message: {
            role: "assistant",
            content: "Done.",
          },
        },
      ]),
    );

    const { items, work } = onlyWorkItem(session.messages);
    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);

    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    const commandEntry = displayEntries.find((entry) =>
      entry.entry.blocks.some(
        (block) => block.type === "tool_use" && block.toolName === "Bash",
      ),
    );
    const commandBlock = commandEntry?.entry.blocks.find(
      (block) => block.type === "tool_use",
    );
    expect(commandBlock).toMatchObject({
      type: "tool_use",
      toolName: "Bash",
      toolInput: {
        command: "bun test packages/ui/test/last-user-message.test.ts",
      },
      toolUseId: "tu-1",
    });
    expect(commandEntry?.pairedResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      text: "1 pass",
      toolUseId: "tu-1",
    });
  });

  test("turns Ollama JSONL into plain user and assistant messages", () => {
    const session = parseOllamaJsonl(
      jsonl([
        {
          kind: "header",
          termId: "ollama-1",
          spawnCwd: "/Users/me/proj",
          model: "qwen3-coder:30b",
          createdAt: "2026-06-19T12:00:00.000Z",
        },
        {
          kind: "turn",
          ts: "2026-06-19T12:00:01.000Z",
          role: "user",
          content: "hello qwen",
        },
        {
          kind: "turn",
          ts: "2026-06-19T12:00:03.000Z",
          role: "assistant",
          content: "Hi! What can I help with?",
        },
      ]),
    );

    const items = buildVisualTranscriptItems(session.messages);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
    expect(items[0]).toMatchObject({
      kind: "message",
      blocks: [{ type: "text", text: "hello qwen" }],
    });
    expect(items[1]).toMatchObject({
      kind: "message",
      blocks: [{ type: "text", text: "Hi! What can I help with?" }],
    });
  });
});
