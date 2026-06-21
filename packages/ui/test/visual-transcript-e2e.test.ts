import { describe, expect, test } from "bun:test";
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
  latestVisualPlan,
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
    ]);

    const displayEntries = buildVisualWorkDisplayEntries(work.entries);
    const commandEntry = displayEntries.find((entry) =>
      entry.entry.blocks.some(
        (block) =>
          block.type === "tool_use" && block.toolName === "exec_command",
      ),
    );
    expect(commandEntry?.pairedResult?.blocks[0]?.toolUseId).toBe("call-1");
    expect(commandEntry?.entry.blocks[0]).toMatchObject({
      type: "tool_use",
      toolName: "exec_command",
      toolUseId: "call-1",
      toolInput: {
        cmd: 'rg "codex-app/events|Codex app" packages/ui/src',
      },
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
