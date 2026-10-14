import { describe, expect, test } from "bun:test";
import {
  createCodexTranscriptNormalizer,
  createCodexContextUpdateNormalizer,
  createSessionContextTimeline,
  isCodexTranscriptRecord,
  sessionContextStateAtLine,
} from "@treetop/nicifier";
import { sessionContextTreeArtifacts } from "../src/session-context-source";

describe("recorded session context", () => {
  test("adapts the current context to the shared sparse tree hierarchy", () => {
    const state = {
      agent: "codex" as const,
      completeness: "recorded" as const,
      baseInstructions: "base rules",
      turnContext: { model: "gpt-6-astra" },
      items: [
        {
          id: "u1",
          sourceLine: 12,
          value: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the renderer" }],
          },
        },
        {
          id: "call1",
          sourceLine: 13,
          value: { type: "function_call", name: "exec_command" },
        },
      ],
      compactionCount: 0,
      opaqueItemCount: 0,
      limitations: [],
    };

    expect(sessionContextTreeArtifacts(state).map((artifact) => ({
      path: artifact.path,
      title: artifact.previewTitle,
      preview: artifact.preview,
    }))).toEqual([
      { path: "Instructions/Base instructions", title: "Base instructions", preview: '"base rules"' },
      { path: "Settings/Current turn", title: "Current turn settings", preview: '{\n  "model": "gpt-6-astra"\n}' },
      { path: "Messages/User/0001 · Fix the renderer", title: "Fix the renderer · transcript line 12", preview: expect.stringContaining('"role": "user"') },
      { path: "Tools/Calls/0002 · exec_command", title: "exec_command · transcript line 13", preview: expect.stringContaining('"function_call"') },
    ]);
  });
  test("normalizes Codex transcript records through one stateful shared stream", () => {
    const normalize = createCodexTranscriptNormalizer();
    expect(normalize.ingest({
      type: "session_meta",
      timestamp: "2026-09-13T00:00:00Z",
      payload: { id: "thread-1", cwd: "/repo" },
    })).toEqual({
      recognized: true,
      messages: [],
      metadata: {
        cwd: "/repo",
        sessionId: "thread-1",
        timestamp: "2026-09-13T00:00:00Z",
      },
    });
    normalize.ingest({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({ cmd: "pwd" }),
      },
    });
    expect(normalize.ingest({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "/repo",
      },
    }).messages).toEqual([{
      role: "tool",
      blocks: [{
        type: "tool_result",
        text: "/repo",
        toolName: "exec_command",
        toolUseId: "call-1",
      }],
      timestamp: undefined,
    }]);
  });

  test("projects forked subagent transcripts onto the child thread", () => {
    const normalize = createCodexTranscriptNormalizer();
    const childId = "01a0a95c-2d5c-7ac3-8f1a-72d96ab77a4c";
    const parentId = "01a0a939-9a9c-7982-a736-62a7592901f1";

    expect(normalize.ingest({
      type: "session_meta",
      payload: {
        id: childId,
        forked_from_id: parentId,
        parent_thread_id: parentId,
        cwd: "/repo",
      },
    }).metadata).toMatchObject({ sessionId: childId, cwd: "/repo" });

    normalize.ingest({
      type: "session_meta",
      payload: { id: parentId, cwd: "/repo" },
    });
    expect(normalize.ingest({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Inherited parent answer" }],
      },
    }).messages).toEqual([]);

    normalize.ingest({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_id: childId,
        thread_settings: { model: "gpt-5.6-luna" },
      },
    });
    expect(normalize.ingest({
      type: "event_msg",
      payload: { type: "task_started", thread_id: childId },
    }).messages[0]?.blocks[0]?.text).toBe("[Task started]");
    expect(normalize.ingest({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Child is inspecting the viewport" }],
      },
    }).messages[0]?.blocks[0]?.text).toBe("Child is inspecting the viewport");
  });

  test("surfaces visible inter-agent messages in a child transcript", () => {
    const normalize = createCodexTranscriptNormalizer();
    const result = normalize.ingest({
      type: "response_item",
      timestamp: "2026-09-16T08:36:27.024Z",
      payload: {
        type: "agent_message",
        author: "/root",
        recipient: "/root/viewport_adversary",
        content: [
          {
            type: "input_text",
            text: "Message Type: MESSAGE\nSender: /root\nPayload:\nCheck resize handling.",
          },
          { type: "encrypted_content", encrypted_content: "opaque" },
        ],
      },
    });

    expect(result.messages).toEqual([{
      role: "assistant",
      timestamp: "2026-09-16T08:36:27.024Z",
      blocks: [{
        type: "subagent",
        text: "Check resize handling.",
        subagentAction: "notification",
        subagentStatus: "running",
        subagentNickname: "root",
        subagentIsParent: true,
        subagentResult: "Check resize handling.",
      }],
    }]);
  });

  test("tail-only child deliveries never become human messages or use the recipient as their name", () => {
    const normalize = createCodexTranscriptNormalizer();
    const result = normalize.ingest({ type: "response_item", payload: {
      type: "agent_message", author: "/root/reviewer", recipient: "/root",
      content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/reviewer\nPayload:\nTests passed." }],
    } });
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[0]?.blocks[0]).toMatchObject({
      type: "subagent", subagentNickname: "reviewer", subagentStatus: "completed", subagentResult: "Tests passed.",
    });
  });

  test("usage checkpoints account cumulative progress once, including requests between checkpoints", () => {
    const normalize = createCodexTranscriptNormalizer();
    const ingest = (input: number) => normalize.ingest({ type: "event_msg", payload: {
      type: "token_count", info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 },
        total_token_usage: { input_tokens: input, cached_input_tokens: input * .8, output_tokens: input * .1, total_tokens: input * 1.1 },
      },
    } }).messages;
    expect(ingest(100)[0]?.tokenUsage?.input).toBe(100);
    expect(ingest(100)).toEqual([]);
    expect(ingest(300)[0]?.tokenUsage).toMatchObject({ input: 200, cachedInput: 160, output: 20 });
  });

  test("recognizes standalone response usage rows in bounded recordings", () => {
    expect(isCodexTranscriptRecord({ type: "token_usage_record", payload: { usage: { input_tokens: 10 } } })).toBe(true);
  });

  test("zero cumulative checkpoints reset the baseline without charging stale last usage", () => {
    const normalize = createCodexTranscriptNormalizer();
    const ingest = (total: number) => normalize.ingest({ type: "event_msg", payload: {
      type: "token_count", info: {
        last_token_usage: { input_tokens: 100, output_tokens: 10 },
        total_token_usage: { input_tokens: total, output_tokens: total / 10 },
      },
    } }).messages;
    expect(ingest(100)[0]?.tokenUsage?.input).toBe(100);
    expect(ingest(0)).toEqual([]);
    expect(ingest(300)[0]?.tokenUsage).toMatchObject({ input: 300, output: 30 });
  });

  test("plain inter-agent input envelopes keep the same role and parent attribution as structured deliveries", () => {
    const text = "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\nReview the change.";
    for (const content of [[{ type: "input_text", text }], [text]]) {
      const result = createCodexTranscriptNormalizer().ingest({ type: "response_item", payload: {
        type: "message", role: "user", content,
      } });
      expect(result.messages[0]?.role).toBe("assistant");
      expect(result.messages[0]?.blocks[0]).toMatchObject({
        type: "subagent", subagentNickname: "root", subagentIsParent: true,
        subagentMessage: "Review the change.",
      });
      expect(result.messages[0]?.blocks[0]?.subagentResult).toBeUndefined();
    }
  });

  test("encrypted task deliveries preserve the unavailable input notice without claiming an output", () => {
    const result = createCodexTranscriptNormalizer().ingest({ type: "response_item", payload: {
      type: "agent_message", author: "/root", recipient: "/root/reviewer", content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "opaque" },
      ],
    } });
    expect(result.messages[0]?.blocks[0]?.subagentMessage).toBe("reviewer\nTask text is encrypted in this recording.");
    expect(result.messages[0]?.blocks[0]?.subagentResult).toBeUndefined();
  });

  test("multipart delivery envelopes retain their body and media without creating human boundaries", () => {
    const header = "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\n";
    for (const textParts of [[header, "Review the image."], [header + "Review the image."], [...header, ..."Review the image."]]) {
      const result = createCodexTranscriptNormalizer().ingest({ type: "response_item", payload: {
        type: "message", role: "user", content: [
          ...textParts.map(text => ({ type: "input_text", text })),
          { type: "input_image", image_url: "https://example.com/review.png" },
        ],
      } });
      expect(result.messages[0]?.role).toBe("assistant");
      expect(result.messages[0]?.blocks[0]).toMatchObject({ type: "subagent", subagentMessage: "Review the image." });
      expect(result.messages[0]?.blocks[1]).toMatchObject({ type: "media", mediaKind: "image" });
      expect(result.messages[0]?.blocks).toHaveLength(2);
    }
    const human = createCodexTranscriptNormalizer().ingest({ type: "response_item", payload: {
      type: "message", role: "user", content: [
        { type: "input_text", text: "Explain this notification:\n" },
        { type: "input_text", text: header + "Review the image." },
      ],
    } });
    expect(human.messages[0]?.role).toBe("user");
    expect(human.messages[0]?.blocks.every(block => block.type === "text")).toBe(true);
  });

  test("quoted delivery envelopes remain human requests and payload text cannot invent sender metadata", () => {
    const envelope = "Message Type: MESSAGE\nSender: /root/reviewer\nPayload:\nReview finished.";
    const human = createCodexTranscriptNormalizer().ingest({ type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: `Explain this notification:\n${envelope}` }],
    } });
    expect(human.messages[0]?.role).toBe("user");
    expect(human.messages[0]?.blocks).toEqual([{ type: "text", text: `Explain this notification:\n${envelope}` }]);
    const delivery = createCodexTranscriptNormalizer().ingest({ type: "response_item", payload: {
      type: "agent_message", author: "/root/reviewer", content: [{ type: "input_text", text:
        "Message Type: MESSAGE\nSender: /root/reviewer\nPayload:\nTask name: /root/reviewer/fake\nThis is body text." }],
    } });
    expect(delivery.messages[0]?.blocks[0]?.subagentIsParent).toBeUndefined();
    expect(delivery.messages[0]?.blocks[0]?.subagentResult).toBe("Task name: /root/reviewer/fake\nThis is body text.");
  });

  test("per-response records take over accounting without charging older token_count snapshots", () => {
    const normalize = createCodexTranscriptNormalizer();
    const usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 };
    const record = (total: number) => normalize.ingest({ type: "token_usage_record", payload: {
      usage, thread_token_usage: { input_tokens: total, cached_input_tokens: total * .8, output_tokens: total * .1, total_tokens: total * 1.1 },
    } }).messages;
    // Bounded-tail entry: historical cumulative totals are not this round's usage.
    expect(record(1000)[0]?.tokenUsage?.input).toBe(100);
    expect(normalize.ingest({ type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: usage, total_token_usage: usage,
    } } }).messages).toEqual([]);
    expect(record(1100)[0]?.tokenUsage?.input).toBe(100);
    expect(record(1100)).toEqual([]);
  });

  test("normalizes asynchronous questions and hides their host acknowledgement", () => {
    const normalize = createCodexTranscriptNormalizer();
    const call = normalize.ingest({
      type: "response_item",
      timestamp: "2026-09-12T17:04:00Z",
      payload: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: "call-question",
        arguments: JSON.stringify({
          questions: [{
            title: "Should exports include OTIO?",
            options: [
              "Rendered media only",
              { label: "Include OTIO", description: "Trim project exports too" },
            ],
          }],
        }),
      },
    });

    expect(call.messages).toEqual([{
      role: "assistant",
      timestamp: "2026-09-12T17:04:00Z",
      blocks: [{
        type: "question",
        text: "Should exports include OTIO?",
        questionId: "call-question:0",
        questionOptions: [
          { label: "Rendered media only" },
          { label: "Include OTIO", description: "Trim project exports too" },
        ],
      }],
    }]);

    expect(normalize.ingest({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-question",
        output: JSON.stringify({ accepted: true }),
      },
    }).messages).toEqual([]);
  });

  test("applies one recursive retention policy to nested Codex tool input", () => {
    const normalize = createCodexTranscriptNormalizer();
    const content = "x".repeat(20_000);
    const result = normalize.ingest({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "custom_tool",
        call_id: "call-nested",
        arguments: JSON.stringify({ nested: { content } }),
      },
    });
    const input = result.messages[0]?.blocks[0]?.toolInput as {
      nested?: { content?: string };
    };
    expect(input.nested?.content?.length).toBeLessThan(content.length);
    expect(input.nested?.content).toEndWith("… [truncated by Treetop]");
  });

  test("normalizes context updates into canonical messages and tracks changes", () => {
    const normalize = createCodexContextUpdateNormalizer();
    const firstText = "<skills_instructions>\nold tools\n</skills_instructions>";
    const changedText = "<skills_instructions>\nnew tools and rules\n</skills_instructions>";
    const item = (text: string) => ({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text }],
    });

    expect(normalize(item(firstText))).toEqual({
      role: "system",
      title: "Developer context set",
      blocks: [{
        type: "context_update",
        text: firstText,
        contextRole: "developer",
        contextPhase: "set",
        contextCategory: "Skills instructions",
        contextCharacters: firstText.length,
      }],
    });
    expect(normalize(item(changedText))).toEqual({
      role: "system",
      title: "Developer context changed",
      blocks: [{
        type: "context_update",
        text: changedText,
        contextRole: "developer",
        contextPhase: "changed",
        contextCategory: "Skills instructions",
        contextCharacters: changedText.length,
        contextPreviousCharacters: firstText.length,
        contextDeltaCharacters: changedText.length - firstText.length,
        contextDiff: [
          "@@ Skills instructions changed @@",
          " <skills_instructions>",
          "-old tools",
          "+new tools and rules",
          " </skills_instructions>",
        ].join("\n"),
      }],
    });
    expect(normalize(item(changedText))).toEqual({
      role: "system",
      title: "Developer context reapplied",
      blocks: [{
        type: "context_update",
        text: changedText,
        contextRole: "developer",
        contextPhase: "reapplied",
        contextCategory: "Skills instructions",
        contextCharacters: changedText.length,
        contextPreviousCharacters: changedText.length,
        contextDeltaCharacters: 0,
      }],
    });
  });

  test("diffs a model switch against the recorded base instructions", () => {
    const normalize = createCodexTranscriptNormalizer();
    normalize.ingest({
      type: "session_meta",
      payload: {
        base_instructions: {
          text: "You are Codex 5.\nKeep replies concise.",
          limit: 20_000,
        },
      },
    });

    const result = normalize.ingest({
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: [
            "<model_switch>",
            "The user was previously using a different model.",
            "Please continue with these instructions:",
            "",
            "You are Codex 6.",
            "Keep replies concise.",
            "",
            "</model_switch>",
          ].join("\n"),
        }],
      },
    });

    expect(result.messages[0]?.blocks[0]).toMatchObject({
      type: "context_update",
      contextCategory: "Model instructions",
      contextPhase: "changed",
      contextPreviousCharacters: 38,
    });
    expect(result.messages[0]?.blocks[0]?.contextDiff).toContain("-You are Codex 5.");
    expect(result.messages[0]?.blocks[0]?.contextDiff).toContain("+You are Codex 6.");
    expect(result.messages[0]?.blocks[0]?.contextDiff).not.toContain("previously using a different model");
  });

  test("tracks independent developer context categories without inventing replacements", () => {
    const normalize = createCodexContextUpdateNormalizer();
    const originalCollaboration = "<collaboration_mode>Default</collaboration_mode>";
    const item = (value: string) => ({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: value }],
    });

    const collaboration = normalize(item(
      originalCollaboration,
    ));
    const model = normalize(item(
      "<model_switch>\n<skills_instructions>large nested block</skills_instructions>\n</model_switch>",
    ));
    const changedCollaboration = normalize(item(
      "<collaboration_mode>Plan</collaboration_mode>",
    ));

    expect(collaboration?.blocks[0]).toMatchObject({
      contextCategory: "Collaboration instructions",
      contextPhase: "set",
    });
    expect(model?.blocks[0]).toMatchObject({
      contextCategory: "Model instructions",
      contextPhase: "set",
    });
    expect(changedCollaboration?.blocks[0]).toMatchObject({
      contextCategory: "Collaboration instructions",
      contextPhase: "changed",
      contextPreviousCharacters: originalCollaboration.length,
    });
    expect(changedCollaboration?.blocks[0].contextDiff).toContain(
      "-<collaboration_mode>Default</collaboration_mode>",
    );
    expect(changedCollaboration?.blocks[0].contextDiff).toContain(
      "+<collaboration_mode>Plan</collaboration_mode>",
    );
  });

  test("bounds large context diffs while preserving both sides of the change", () => {
    const normalize = createCodexContextUpdateNormalizer();
    const item = (lines: string[]) => ({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: ["<skills_instructions>", ...lines, "</skills_instructions>"].join("\n"),
      }],
    });
    normalize(item(Array.from({ length: 400 }, (_, index) => `old ${index}`)));

    const changed = normalize(item(
      Array.from({ length: 400 }, (_, index) => `new ${index}`),
    ));
    const diff = changed?.blocks[0].contextDiff ?? "";

    expect(diff).toContain("-old 0");
    expect(diff).toContain("-old 399");
    expect(diff).toContain("+new 0");
    expect(diff).toContain("+new 399");
    expect(diff).toContain("removed lines omitted");
    expect(diff).toContain("added lines omitted");
    expect(diff.split("\n").length).toBeLessThan(350);

    const alternating = createCodexContextUpdateNormalizer();
    alternating(item(Array.from({ length: 400 }, (_, index) => `line ${index}`)));
    const scattered = alternating(item(
      Array.from({ length: 400 }, (_, index) => index % 2 ? `changed ${index}` : `line ${index}`),
    ))?.blocks[0].contextDiff ?? "";
    expect(scattered).toContain("diff lines omitted");
    expect(scattered.split("\n").length).toBeLessThanOrEqual(402);
  });

  test("reconstructs Codex input and replaces history at compaction boundaries", () => {
    const timeline = createSessionContextTimeline([
      { type: "session_meta", payload: { id: "s1", base_instructions: { text: "base" } } },
      { type: "turn_context", payload: { model: "gpt-6-astra", cwd: "/repo" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } },
      {
        type: "compacted",
        payload: {
          replacement_history: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "summary" }] },
          ],
          window_number: 2,
        },
      },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] } },
    ]);

    const before = sessionContextStateAtLine(timeline, 4);
    expect(before.items.map((item) => item.value)).toHaveLength(2);
    expect(before.baseInstructions).toEqual({ text: "base" });
    expect(before.turnContext).toMatchObject({ model: "gpt-6-astra", cwd: "/repo" });

    const compacted = sessionContextStateAtLine(timeline, 5);
    expect(compacted.items.map((item) => item.value)).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "summary" }] },
    ]);
    expect(compacted.compactionCount).toBe(1);

    const after = sessionContextStateAtLine(timeline, 6);
    expect(after.items.map((item) => (item.value as { role?: string }).role)).toEqual(["developer", "user"]);
    expect(after.completeness).toBe("recorded");
  });

  test("follows the active Claude parent chain and excludes sidechains", () => {
    const timeline = createSessionContextTimeline([
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, message: { role: "user", content: "one" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
      { type: "assistant", uuid: "side", parentUuid: "u1", isSidechain: true, message: { role: "assistant", content: "ignore" } },
      { type: "attachment", uuid: "attachment", parentUuid: "a1", isSidechain: false, attachment: { type: "file", filename: "notes.txt" } },
      { type: "user", uuid: "u2", parentUuid: "attachment", isSidechain: false, message: { role: "user", content: "three" } },
    ]);
    const state = sessionContextStateAtLine(timeline, 5);
    expect(state.agent).toBe("claude");
    expect(state.items.map((item) => item.id)).toEqual(["u1", "a1", "attachment", "u2"]);
    expect(state.completeness).toBe("partial");
  });

  test("preserves opaque Codex items instead of pretending their contents are inspectable", () => {
    const timeline = createSessionContextTimeline([
      { type: "session_meta", payload: { id: "s1" } },
      { type: "response_item", payload: { type: "reasoning", encrypted_content: "ciphertext" } },
    ]);
    const state = sessionContextStateAtLine(timeline, 2);
    expect(state.opaqueItemCount).toBe(1);
    expect(state.limitations).toContain("Opaque provider-managed items are shown as recorded but cannot be decrypted.");
  });
});
