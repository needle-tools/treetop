import { describe, it, expect } from "bun:test";
import {
  applyVisualTranscriptDeltaPatches,
  buildVisualWorkDisplayEntries,
  buildVisualTranscriptItems,
  cleanVisualUserText,
  cleanVisualToolResultText,
  formatVisualWorkDuration,
  lastUserMessageBurst,
  lastUserMessageWithContext,
  latestVisualPlan,
  mergeVisualSessionMessages,
  reuseStableVisualTranscriptItems,
  visualPlanFromBlock,
  visualPlanFromPayload,
  visualToolCallPayloadLanguage,
  visualToolCallPayloadText,
  visualToolPreviewText,
  visualWorkSummary,
  visualUserImageAttachments,
  visualFileEditSummaryForBlock,
  visualThinkingSummary,
  withoutDuplicateOptimisticUserMessages,
  type Message,
} from "../src/last-user-message";

function msg(role: string, text: string, timestamp?: string): Message {
  return {
    role,
    blocks: [{ type: "text", text }],
    timestamp,
  };
}

function ts(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("formatVisualWorkDuration", () => {
  const start = "2026-06-22T10:00:00.000Z";

  it("keeps short durations compact", () => {
    expect(formatVisualWorkDuration(start, "2026-06-22T10:00:05.900Z")).toBe(
      "5s",
    );
    expect(formatVisualWorkDuration(start, "2026-06-22T10:02:00.000Z")).toBe(
      "2m",
    );
    expect(formatVisualWorkDuration(start, "2026-06-22T10:02:03.000Z")).toBe(
      "2m 3s",
    );
  });

  it("formats hours instead of rolling them into minutes", () => {
    expect(formatVisualWorkDuration(start, "2026-06-22T11:59:32.000Z")).toBe(
      "1hr 59m 32s",
    );
  });

  it("formats multi-day work with day and hour units", () => {
    expect(formatVisualWorkDuration(start, "2026-06-25T14:12:05.000Z")).toBe(
      "3d 4h 12m 5s",
    );
  });
});

describe("lastUserMessageBurst", () => {
  it("returns undefined for empty messages", () => {
    expect(lastUserMessageBurst([])).toBeUndefined();
  });

  it("returns the last user message", () => {
    const msgs = [
      msg("user", "hello", ts(-60000)),
      msg("assistant", "hi there", ts(-50000)),
      msg("user", "how are you?", ts(-5000)),
    ];
    expect(lastUserMessageBurst(msgs)).toBe("how are you?");
  });

  it("joins burst messages within 30s", () => {
    const msgs = [
      msg("user", "old message", ts(-120000)),
      msg("assistant", "response", ts(-90000)),
      msg("user", "first", ts(-10000)),
      msg("user", "second", ts(-5000)),
    ];
    expect(lastUserMessageBurst(msgs)).toBe("first\nsecond");
  });

  it("stops at the burst boundary (>30s gap)", () => {
    const msgs = [
      msg("user", "before the gap", ts(-120000)),
      msg("assistant", "response", ts(-90000)),
      msg("user", "after the gap", ts(-5000)),
    ];
    expect(lastUserMessageBurst(msgs)).toBe("after the gap");
  });

  it("skips assistant messages when collecting burst", () => {
    const msgs = [
      msg("user", "first", ts(-10000)),
      msg("assistant", "reply", ts(-8000)),
      msg("user", "second", ts(-5000)),
    ];
    expect(lastUserMessageBurst(msgs)).toBe("first\nsecond");
  });

  it("skips user messages with empty text blocks", () => {
    const msgs = [
      msg("user", "real message", ts(-5000)),
      msg("user", "", ts(-3000)),
    ];
    expect(lastUserMessageBurst(msgs)).toBe("real message");
  });

  it("skips Codex turn-aborted control messages", () => {
    const msgs = [
      msg("user", "fix the TUI overlay parsing", ts(-60000)),
      msg(
        "user",
        "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>",
        ts(-10000),
      ),
      msg("user", "continue plz", ts(-5000)),
    ];
    expect(lastUserMessageBurst(msgs)).toBe("continue plz");
    expect(lastUserMessageWithContext(msgs, lastUserMessageBurst(msgs))).toBe(
      "continue plz",
    );
  });
});

describe("lastUserMessageWithContext", () => {
  it("returns undefined when burst is undefined", () => {
    expect(lastUserMessageWithContext([], undefined)).toBeUndefined();
  });

  it("returns burst as-is when >= 10 chars with a space", () => {
    const msgs = [msg("user", "a long message here", ts(-5000))];
    expect(lastUserMessageWithContext(msgs, "a long message here")).toBe(
      "a long message here",
    );
  });

  it("returns burst as-is when short but no prior message exists", () => {
    const msgs = [msg("user", "yes", ts(-5000))];
    expect(lastUserMessageWithContext(msgs, "yes")).toBe("yes");
  });

  it("prepends prior message when burst is short (<10 chars)", () => {
    const msgs = [
      msg("user", "should we deploy to prod?", ts(-120000)),
      msg("assistant", "that sounds good", ts(-90000)),
      msg("user", "yes", ts(-5000)),
    ];
    const burst = lastUserMessageBurst(msgs)!;
    expect(burst).toBe("yes");
    expect(lastUserMessageWithContext(msgs, burst)).toBe(
      "should we deploy to prod?\n[…]\nyes",
    );
  });

  it("prepends prior message when burst is a single word", () => {
    const msgs = [
      msg("user", "commit these changes", ts(-120000)),
      msg("assistant", "done", ts(-90000)),
      msg("user", "push", ts(-5000)),
    ];
    const burst = lastUserMessageBurst(msgs)!;
    expect(lastUserMessageWithContext(msgs, burst)).toBe(
      "commit these changes\n[…]\npush",
    );
  });

  it("does not prepend when burst has >= 10 chars and a space", () => {
    const msgs = [
      msg("user", "old context", ts(-120000)),
      msg("assistant", "reply", ts(-90000)),
      msg("user", "short text here", ts(-5000)),
    ];
    const burst = lastUserMessageBurst(msgs)!;
    expect(lastUserMessageWithContext(msgs, burst)).toBe("short text here");
  });

  it("handles multi-message burst that is still short", () => {
    const msgs = [
      msg("user", "can you fix the bug in server.ts?", ts(-120000)),
      msg("assistant", "sure, done", ts(-90000)),
      msg("user", "ok", ts(-10000)),
      msg("user", "thx", ts(-5000)),
    ];
    const burst = lastUserMessageBurst(msgs)!;
    expect(burst).toBe("ok\nthx");
    expect(lastUserMessageWithContext(msgs, burst)).toBe(
      "can you fix the bug in server.ts?\n[…]\nok\nthx",
    );
  });
});

describe("cleanVisualUserText", () => {
  it("removes Codex image envelopes and inline image references", () => {
    expect(
      cleanVisualUserText(
        '<image name=[Image #1] path="/tmp/screen.png">\nhey remove this[Image #1]',
      ),
    ).toBe("hey remove this");
  });

  it("extracts Codex user image envelopes before cleaning text", () => {
    expect(
      visualUserImageAttachments(
        '<image name=[Image #1] path="/tmp/screen.png">\n<image name=[Image #2] path="/tmp/other.jpg">\nhey[Image #1][Image #2]',
      ),
    ).toEqual([
      { label: "Image #1", path: "/tmp/screen.png" },
      { label: "Image #2", path: "/tmp/other.jpg" },
    ]);
  });

  it("handles live Codex image envelope variants and drops orphan tags", () => {
    const text = [
      'before <image name="Image #1" path="/tmp/live one.png">',
      "<image name=[Image #2] file_path='/tmp/live-two.webp'>",
      "<image name=>",
      "after [Image #1][Image #2]",
    ].join("\n");
    expect(visualUserImageAttachments(text)).toEqual([
      { label: "Image #1", path: "/tmp/live one.png" },
      { label: "Image #2", path: "/tmp/live-two.webp" },
    ]);
    expect(cleanVisualUserText(text)).toBe("before after");
  });

  it("keeps ordinary text unchanged", () => {
    expect(cleanVisualUserText("please keep this")).toBe("please keep this");
  });
});

describe("visual plan extraction", () => {
  it("extracts a typed plan block", () => {
    const plan = visualPlanFromBlock({
      type: "plan",
      explanation: "Work in clear phases.",
      planItems: [
        { step: "Read the session", status: "completed" },
        { step: "Add UI", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    });

    expect(plan).toMatchObject({
      explanation: "Work in clear phases.",
      completed: 1,
      inProgress: 1,
      total: 3,
      items: [
        { step: "Read the session", status: "completed" },
        { step: "Add UI", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
    });
  });

  it("normalizes live plan payloads at the boundary", () => {
    expect(
      visualPlanFromPayload({
        explanation: "Newest snapshot.",
        plan: [
          { step: "Old step", status: "completed" },
          { step: "Next step", status: "in_progress" },
        ],
      }),
    ).toMatchObject({
      explanation: "Newest snapshot.",
      completed: 1,
      inProgress: 1,
      total: 2,
      items: [
        { step: "Old step", status: "completed" },
        { step: "Next step", status: "in_progress" },
      ],
    });
  });

  it("returns the latest normalized plan snapshot", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        blocks: [
          {
            type: "plan",
            planItems: [{ step: "Old step", status: "in_progress" }],
          },
        ],
      },
      {
        role: "assistant",
        blocks: [
          {
            type: "plan",
            explanation: "Newest snapshot.",
            planItems: [
              { step: "Old step", status: "completed" },
              { step: "Next step", status: "in_progress" },
            ],
          },
        ],
      },
    ];

    expect(latestVisualPlan(messages)).toMatchObject({
      explanation: "Newest snapshot.",
      completed: 1,
      inProgress: 1,
      total: 2,
      items: [
        { step: "Old step", status: "completed" },
        { step: "Next step", status: "in_progress" },
      ],
    });
  });

  it("does not treat raw tool_use plan calls as display plans", () => {
    expect(
      latestVisualPlan([
        {
          role: "assistant",
          blocks: [
            {
              type: "tool_use",
              toolName: "update_plan",
              toolInput: {
                plan: [{ step: "Should be normalized first", status: "pending" }],
              },
            },
          ],
        },
      ]),
    ).toBeUndefined();
  });
});

describe("buildVisualTranscriptItems", () => {
  it("keeps user turns as right-alignable message items", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "please fix it", "2026-06-19T10:00:00.000Z"),
    ]);

    expect(items).toEqual([
      {
        kind: "message",
        message: msg("user", "please fix it", "2026-06-19T10:00:00.000Z"),
        blocks: [{ type: "text", text: "please fix it" }],
        messageIndex: 0,
      },
    ]);
  });

  it("collapses completed thinking and tool work before the response", () => {
    const user = msg("user", "make it nicer", "2026-06-19T10:00:00.000Z");
    const thinking: Message = {
      role: "assistant",
      timestamp: "2026-06-19T10:00:10.000Z",
      blocks: [{ type: "thinking", text: "checking the UI" }],
    };
    const tool: Message = {
      role: "tool",
      timestamp: "2026-06-19T10:00:30.000Z",
      blocks: [{ type: "tool_result", text: "tests passed" }],
    };
    const response = msg("assistant", "Done.", "2026-06-19T10:01:15.000Z");

    const items = buildVisualTranscriptItems([
      user,
      thinking,
      tool,
      response,
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    expect(items[1]).toMatchObject({
      kind: "work",
      startedAt: "2026-06-19T10:00:00.000Z",
      endedAt: "2026-06-19T10:01:15.000Z",
    });
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1].entries.map((entry) => entry.blocks[0]?.type)).toEqual([
      "thinking",
      "tool_result",
    ]);
  });

  it("leaves in-progress work expanded until a response exists", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "continue", "2026-06-19T10:00:00.000Z"),
      {
        role: "assistant",
        timestamp: "2026-06-19T10:00:10.000Z",
        blocks: [{ type: "thinking", text: "working" }],
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(["message", "work"]);
    expect(items[1]).toMatchObject({
      kind: "work",
      open: true,
      entries: [
        {
          blocks: [{ type: "thinking", text: "working" }],
        },
      ],
    });
  });

  it("marks user messages during an open Codex task as steering", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "implement this", "2026-06-19T10:00:00.000Z"),
      {
        role: "system",
        timestamp: "2026-06-19T10:00:01.000Z",
        blocks: [{ type: "marker", text: "[Task started]" }],
      },
      msg("assistant", "I’ll start.", "2026-06-19T10:00:02.000Z"),
      msg("user", "also keep it small", "2026-06-19T10:00:03.000Z"),
      msg("assistant", "Noted.", "2026-06-19T10:00:04.000Z"),
      msg("user", "and add a test", "2026-06-19T10:00:05.000Z"),
      {
        role: "system",
        timestamp: "2026-06-19T10:00:06.000Z",
        blocks: [{ type: "marker", text: "[Task complete]" }],
      },
      msg("assistant", "Done.", "2026-06-19T10:00:07.000Z"),
      msg("user", "new turn", "2026-06-19T10:00:08.000Z"),
    ]);

    const userMessages = items
      .filter((item) => item.kind === "message" && item.message.role === "user")
      .map((item) => item.message);

    expect(userMessages.map((message) => message.blocks[0]?.text)).toEqual([
      "implement this",
      "also keep it small",
      "and add a test",
      "new turn",
    ]);
    expect(userMessages.map((message) => message.intent)).toEqual([
      undefined,
      "steer",
      "steer",
      undefined,
    ]);
  });

  it("keeps the active turn expanded instead of showing a final response", () => {
    const items = buildVisualTranscriptItems(
      [
        msg("user", "continue", "2026-06-19T10:00:00.000Z"),
        {
          role: "assistant",
          timestamp: "2026-06-19T10:00:10.000Z",
          blocks: [{ type: "thinking", text: "checking" }],
        },
        msg(
          "assistant",
          "Partial streamed answer",
          "2026-06-19T10:00:20.000Z",
        ),
      ],
      { active: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "work"]);
    expect(items[1]).toMatchObject({
      kind: "work",
      open: true,
      entries: [
        { blocks: [{ type: "thinking", text: "checking" }] },
        { blocks: [{ type: "text", text: "Partial streamed answer" }] },
      ],
    });
  });

  it("ends active work at a turn-aborted marker", () => {
    const items = buildVisualTranscriptItems(
      [
        msg("user", "continue", "2026-06-19T10:00:00.000Z"),
        {
          role: "assistant",
          timestamp: "2026-06-19T10:00:10.000Z",
          blocks: [{ type: "thinking", text: "working" }],
        },
        {
          role: "system",
          timestamp: "2026-06-19T10:00:15.000Z",
          blocks: [{ type: "marker", text: "[Turn aborted]" }],
        },
      ],
      { active: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "work"]);
    expect(items[1]).toMatchObject({
      kind: "work",
      endedAt: "2026-06-19T10:00:15.000Z",
      open: undefined,
    });
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1].entries.map((entry) => entry.blocks[0]?.type)).toEqual([
      "thinking",
      "marker",
    ]);
  });

  it("splits mixed assistant work and response blocks", () => {
    const mixed: Message = {
      role: "assistant",
      timestamp: "2026-06-19T10:00:20.000Z",
      blocks: [
        { type: "thinking", text: "checking" },
        { type: "text", text: "Here is the answer." },
      ],
    };
    const items = buildVisualTranscriptItems([
      msg("user", "question", "2026-06-19T10:00:00.000Z"),
      mixed,
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[2]?.kind !== "message") throw new Error("expected message item");
    expect(items[2].blocks).toEqual([
      { type: "text", text: "Here is the answer." },
    ]);
  });

  it("treats assistant media as response content", () => {
    const mediaMessage: Message = {
      role: "assistant",
      timestamp: "2026-06-19T10:00:20.000Z",
      blocks: [
        { type: "thinking", text: "generating" },
        { type: "media", text: "generated image" },
      ],
    };
    const items = buildVisualTranscriptItems([
      msg("user", "make an image", "2026-06-19T10:00:00.000Z"),
      mediaMessage,
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[2]?.kind !== "message") throw new Error("expected message item");
    expect(items[2].blocks).toEqual([{ type: "media", text: "generated image" }]);
  });

  it("folds post-response system chatter into the turn work before the final response", () => {
    const user = msg("user", "fix the bug", "2026-06-19T10:00:00.000Z");
    const earlyResponse = msg(
      "assistant",
      "I'll take a look.",
      "2026-06-19T10:00:05.000Z",
    );
    const tool: Message = {
      role: "tool",
      timestamp: "2026-06-19T10:00:20.000Z",
      blocks: [{ type: "tool_result", text: "patched file" }],
    };
    const system: Message = {
      role: "system",
      timestamp: "2026-06-19T10:01:00.000Z",
      blocks: [{ type: "text", text: "[task complete]" }],
    };
    const finalResponse = msg(
      "assistant",
      "Done.",
      "2026-06-19T10:01:15.000Z",
    );

    const items = buildVisualTranscriptItems([
      user,
      earlyResponse,
      tool,
      system,
      finalResponse,
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1].entries.map((entry) => entry.message.role)).toEqual([
      "assistant",
      "tool",
      "system",
    ]);
    if (items[2]?.kind !== "message") throw new Error("expected message item");
    expect(items[2].blocks).toEqual([{ type: "text", text: "Done." }]);
  });

  it("keeps duplicate Codex compaction rows inside one work range", () => {
    const user = msg("user", "keep going", "2026-06-22T10:15:00.000Z");
    const before: Message = {
      role: "assistant",
      timestamp: "2026-06-22T10:40:00.000Z",
      blocks: [{ type: "thinking", text: "I’m still refactoring." }],
    };
    const compactedA: Message = {
      role: "system",
      timestamp: "2026-06-22T10:43:31.612Z",
      blocks: [{ type: "marker", text: "[Context compacted]" }],
    };
    const compactedB: Message = {
      role: "system",
      timestamp: "2026-06-22T10:43:31.661Z",
      blocks: [{ type: "marker", text: "[Context compacted]" }],
    };
    const after: Message = {
      role: "assistant",
      timestamp: "2026-06-22T10:44:00.000Z",
      blocks: [{ type: "tool_use", toolName: "exec_command" }],
    };
    const final: Message = {
      role: "assistant",
      timestamp: "2026-06-22T10:46:00.000Z",
      blocks: [{ type: "text", text: "Done." }],
    };

    const items = buildVisualTranscriptItems([
      user,
      before,
      compactedA,
      compactedB,
      after,
      final,
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1].entries.map((entry) => entry.blocks[0]?.type)).toEqual([
      "thinking",
      "marker",
      "tool_use",
    ]);
    expect(visualWorkSummary(items[1].entries)).toEqual({
      steps: 2,
      compactions: 1,
    });
    const displayEntries = buildVisualWorkDisplayEntries(items[1].entries);
    expect(displayEntries).toContainEqual(
      expect.objectContaining({
        kind: "marker",
        markerKind: "compacted",
        markerLabel: "Context compacted",
      }),
    );
    expect(items[1].endedAt).toBe("2026-06-22T10:46:00.000Z");
  });

  it("does not treat non-assistant text/media rows as the final response", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "please inspect this", "2026-06-19T10:00:00.000Z"),
      {
        role: "system",
        timestamp: "2026-06-19T10:00:01.000Z",
        blocks: [{ type: "text", text: "[Task started]" }],
      },
      {
        role: "tool",
        timestamp: "2026-06-19T10:00:05.000Z",
        blocks: [{ type: "tool_result", text: "tool wrote text" }],
      },
      {
        role: "assistant",
        timestamp: "2026-06-19T10:00:10.000Z",
        blocks: [{ type: "tool_use", toolName: "exec_command" }],
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(["message", "work"]);
    expect(items[1]).toMatchObject({
      kind: "work",
      open: true,
    });
  });

  it("groups a Codex turn with multiple commentary/tool bursts under the user", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "fix these two UI bugs", "2026-06-19T14:20:48.142Z"),
      msg(
        "assistant",
        "I’ll inspect the transcript.",
        "2026-06-19T14:21:14.303Z",
      ),
      {
        role: "assistant",
        timestamp: "2026-06-19T14:21:14.401Z",
        blocks: [{ type: "tool_use", toolName: "exec_command" }],
      },
      {
        role: "tool",
        timestamp: "2026-06-19T14:21:14.501Z",
        blocks: [{ type: "tool_result", text: "Chunk ID: abc Output: ok" }],
      },
      msg(
        "assistant",
        "The rendering bug is isolated.",
        "2026-06-19T14:21:34.452Z",
      ),
      {
        role: "assistant",
        timestamp: "2026-06-19T14:21:34.456Z",
        blocks: [{ type: "tool_use", toolName: "exec_command" }],
      },
      {
        role: "tool",
        timestamp: "2026-06-19T14:21:34.526Z",
        blocks: [{ type: "tool_result", text: "Chunk ID: def Output: ok" }],
      },
      msg(
        "assistant",
        "Done, both are fixed.",
        "2026-06-19T14:22:20.000Z",
      ),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1].entries).toHaveLength(6);
    if (items[2]?.kind !== "message") throw new Error("expected message item");
    expect(items[2].blocks).toEqual([
      { type: "text", text: "Done, both are fixed." },
    ]);
  });
});

describe("reuseStableVisualTranscriptItems", () => {
  it("preserves unchanged transcript item identities when the live tail grows", () => {
    const user = msg("user", "fix it", "2026-06-19T10:00:00.000Z");
    const firstAnswer = msg(
      "assistant",
      "I’ll inspect it.",
      "2026-06-19T10:00:02.000Z",
    );
    const secondUser = msg("user", "continue", "2026-06-19T10:00:10.000Z");
    const liveThinking: Message = {
      id: "live-thinking",
      role: "assistant",
      timestamp: "2026-06-19T10:00:12.000Z",
      blocks: [{ type: "thinking", text: "checking" }],
    };
    const previous = buildVisualTranscriptItems(
      [user, firstAnswer, secondUser, liveThinking],
      { active: true },
    );

    const grownThinking: Message = {
      ...liveThinking,
      blocks: [{ type: "thinking", text: "checking more" }],
    };
    const nextRaw = buildVisualTranscriptItems(
      [user, firstAnswer, secondUser, grownThinking],
      { active: true },
    );
    const next = reuseStableVisualTranscriptItems(previous, nextRaw);

    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(previous[1]);
    expect(next[2]).toBe(previous[2]);
    expect(next[3]).not.toBe(previous[3]);
  });

  it("preserves unchanged work entries inside a growing live work item", () => {
    const user = msg("user", "fix it", "2026-06-19T10:00:00.000Z");
    const toolUse: Message = {
      id: "tool-use",
      role: "assistant",
      timestamp: "2026-06-19T10:00:01.000Z",
      blocks: [{ type: "tool_use", toolName: "exec_command" }],
    };
    const toolResult: Message = {
      id: "tool-result",
      role: "tool",
      timestamp: "2026-06-19T10:00:02.000Z",
      blocks: [{ type: "tool_result", text: "first line" }],
    };
    const previous = buildVisualTranscriptItems([user, toolUse, toolResult], {
      active: true,
    });

    const grownToolResult: Message = {
      ...toolResult,
      blocks: [{ type: "tool_result", text: "first line\nsecond line" }],
    };
    const nextRaw = buildVisualTranscriptItems(
      [user, toolUse, grownToolResult],
      { active: true },
    );
    const next = reuseStableVisualTranscriptItems(previous, nextRaw);

    if (previous[1]?.kind !== "work" || next[1]?.kind !== "work") {
      throw new Error("expected live work items");
    }
    expect(next[1].entries[0]).toBe(previous[1].entries[0]);
    expect(next[1].entries[1]).not.toBe(previous[1].entries[1]);
  });

  it("skips expensive signatures for unchanged message object references", () => {
    const user = msg("user", "profile this", "2026-06-19T10:00:00.000Z");
    const toolUse: Message = {
      id: "heavy-tool-use",
      role: "assistant",
      timestamp: "2026-06-19T10:00:01.000Z",
      blocks: [
        {
          type: "tool_use",
          toolName: "apply_patch",
          toolInput: {
            patch: "x".repeat(200_000),
          },
        },
      ],
    };
    const previous = buildVisualTranscriptItems([user, toolUse], {
      active: true,
    });
    const nextRaw = buildVisualTranscriptItems([user, toolUse], {
      active: true,
    });

    const stringify = JSON.stringify;
    let stringifyCalls = 0;
    JSON.stringify = ((value: unknown) => {
      stringifyCalls += 1;
      return stringify(value);
    }) as typeof JSON.stringify;
    let next: ReturnType<typeof buildVisualTranscriptItems>;
    try {
      next = reuseStableVisualTranscriptItems(previous, nextRaw);
    } finally {
      JSON.stringify = stringify;
    }

    expect(next![0]).toBe(previous[0]);
    expect(next![1]).toBe(previous[1]);
    expect(stringifyCalls).toBe(0);
  });
});

describe("withoutDuplicateOptimisticUserMessages", () => {
  it("replaces a local optimistic user row with the canonical transcript row", () => {
    const optimistic: Message = {
      id: "codex-optimistic-user-local",
      role: "user",
      timestamp: "2026-06-19T10:00:00.000Z",
      blocks: [{ type: "text", text: "commit this please" }],
    };
    const canonical = msg(
      "user",
      "commit this please",
      "2026-06-19T10:00:01.000Z",
    );

    expect(
      withoutDuplicateOptimisticUserMessages([optimistic, canonical]),
    ).toEqual([canonical]);
  });

  it("keeps intentionally repeated canonical user messages", () => {
    const first = msg("user", "again", "2026-06-19T10:00:00.000Z");
    const second = msg("user", "again", "2026-06-19T10:00:01.000Z");

    expect(withoutDuplicateOptimisticUserMessages([first, second])).toEqual([
      first,
      second,
    ]);
  });
});

describe("mergeVisualSessionMessages", () => {
  it("places optimistic user rows by timestamp before later live assistant updates", () => {
    const before = msg("assistant", "before", "2026-06-19T10:00:00.000Z");
    const liveAssistant = msg(
      "assistant",
      "working",
      "2026-06-19T10:00:02.000Z",
    );
    const optimistic: Message = {
      id: "codex-optimistic-user-queued",
      role: "user",
      timestamp: "2026-06-19T10:00:01.000Z",
      blocks: [{ type: "text", text: "queued follow-up" }],
    };

    expect(
      mergeVisualSessionMessages([before, liveAssistant], [optimistic]).map(
        (message) => message.blocks[0]?.text,
      ),
    ).toEqual(["before", "queued follow-up", "working"]);
  });

  it("drops optimistic rows when matching canonical user rows arrive", () => {
    const optimistic: Message = {
      id: "codex-optimistic-user-steer",
      role: "user",
      timestamp: "2026-06-19T10:00:01.000Z",
      intent: "steer",
      blocks: [{ type: "text", text: "steer this" }],
    };
    const canonical = msg("user", "steer this", "2026-06-19T10:00:02.000Z");

    expect(mergeVisualSessionMessages([canonical], [optimistic])).toEqual([
      { ...canonical, intent: "steer" },
    ]);
  });
});

describe("applyVisualTranscriptDeltaPatches", () => {
  it("coalesces streamed deltas and preserves untouched message identities", () => {
    const existing = msg("user", "run tests", "2026-06-21T20:00:00.000Z");
    existing.id = "user-1";
    const messages = [existing];

    const next = applyVisualTranscriptDeltaPatches(messages, [
      {
        id: "codex-agent-item-1",
        role: "assistant",
        type: "text",
        delta: "First",
        timestamp: "2026-06-21T20:00:01.000Z",
      },
      {
        id: "codex-agent-item-1",
        role: "assistant",
        type: "text",
        delta: " second",
        timestamp: "2026-06-21T20:00:02.000Z",
      },
      {
        id: "codex-output-call-1",
        role: "tool",
        type: "tool_result",
        delta: "stdout",
        blockFields: { toolName: "exec_command", toolUseId: "call-1" },
        timestamp: "2026-06-21T20:00:03.000Z",
      },
    ]);

    expect(next[0]).toBe(existing);
    expect(next[1]).toMatchObject({
      id: "codex-agent-item-1",
      role: "assistant",
      blocks: [{ type: "text", text: "First second" }],
    });
    expect(next[2]).toMatchObject({
      id: "codex-output-call-1",
      role: "tool",
      blocks: [
        {
          type: "tool_result",
          text: "stdout",
          toolName: "exec_command",
          toolUseId: "call-1",
        },
      ],
    });
  });
});

describe("cleanVisualToolResultText", () => {
  it("strips Codex command chunk metadata and keeps the command output", () => {
    expect(
      cleanVisualToolResultText(
        'Chunk ID: 5f747b Wall time: 0.0000 seconds Process exited with code 0 Original token count: 538 Output: src/App.svelte | 2 +-',
      ),
    ).toEqual({
      title: "Command output",
      body: "src/App.svelte | 2 +-",
      wrappedCodexChunk: true,
      wallTimeSeconds: 0,
      exitCode: 0,
      originalTokenCount: 538,
    });
  });

  it("renders empty successful Codex command chunks as a quiet completion", () => {
    expect(
      cleanVisualToolResultText(
        "Chunk ID: ddaf07 Wall time: 0.0000 seconds Process exited with code 0 Original token count: 0 Output:",
      ),
    ).toEqual({
      title: "Command completed",
      body: "",
      wrappedCodexChunk: true,
      wallTimeSeconds: 0,
      exitCode: 0,
      originalTokenCount: 0,
    });
  });

  it("renders non-zero Codex command chunks as failed without exposing raw exit copy", () => {
    expect(
      cleanVisualToolResultText(
        "Chunk ID: abc123 Wall time: 0.4210 seconds Process exited with code 2 Original token count: 4 Output:",
      ),
    ).toEqual({
      title: "Command failed",
      body: "",
      wrappedCodexChunk: true,
      wallTimeSeconds: 0.421,
      exitCode: 2,
      originalTokenCount: 4,
    });
  });

  it("strips plain command result metadata and keeps the output", () => {
    expect(
      cleanVisualToolResultText(
        "Exit code: 0\nWall time: 0.25 seconds\nOutput:\nrestored prior state prefs shape for repro",
      ),
    ).toEqual({
      title: "Command output",
      body: "restored prior state prefs shape for repro",
      wrappedCodexChunk: true,
      wallTimeSeconds: 0.25,
      exitCode: 0,
      originalTokenCount: undefined,
    });
  });

  it("leaves ordinary tool results alone", () => {
    expect(cleanVisualToolResultText("tests passed")).toEqual({
      title: "Tool result",
      body: "tests passed",
      wrappedCodexChunk: false,
    });
  });
});

describe("visualThinkingSummary", () => {
  it("removes duplicated thinking labels and markdown title wrappers", () => {
    expect(
      visualThinkingSummary(
        "thinking **Exploring response options**\nI am checking the transcript rows.",
      ),
    ).toEqual({
      title: "Exploring response options",
      body: "I am checking the transcript rows.",
    });
  });
});

describe("visual tool payload display helpers", () => {
  it("keeps collapsed exec_command previews readable while expanded payloads stay complete", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "bun test packages/ui/test/last-user-message.test.ts",
        workdir: "/Users/herbst/git/supergit",
        yield_time_ms: 1000,
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "bun test packages/ui/test/last-user-message.test.ts",
    );
    expect(visualToolCallPayloadLanguage(block)).toBe("json");
    expect(visualToolCallPayloadText(block)).toContain(
      '"workdir": "/Users/herbst/git/supergit"',
    );
  });

  it("keeps Claude Bash commands readable while preserving the full payload", () => {
    const block = {
      type: "tool_use",
      toolName: "Bash",
      toolInput: {
        command: "npm test",
        description: "run focused tests",
      },
    };

    expect(visualToolPreviewText(block)).toBe("npm test");
    expect(visualToolCallPayloadText(block)).toContain(
      '"description": "run focused tests"',
    );
  });

  it("summarizes sed file reads while preserving the raw command payload", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "/bin/zsh -lc \"sed -n '60,155p' usd-wasm/src/create.three.js\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read usd-wasm/src/create.three.js:60-155",
    );
    expect(visualToolCallPayloadText(block)).toContain(
      "/bin/zsh -lc \\\"sed -n '60,155p' usd-wasm/src/create.three.js\\\"",
    );
  });

  it("summarizes combined sed reads as one readable preview", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "sed -n '1,70p' usd-wasm/src/types/hydra.d.ts && sed -n '35,60p' usd-wasm/src/types/bindings.d.ts",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read usd-wasm/src/types/hydra.d.ts:1-70, usd-wasm/src/types/bindings.d.ts:35-60",
    );
  });

  it("summarizes rg searches without hiding the real command", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "/bin/zsh -lc 'rg -n \"GetStage\\(\\)\" usd-wasm/src'",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      'Search usd-wasm/src for "GetStage()"',
    );
    expect(visualToolCallPayloadText(block)).toContain("rg -n");
  });

  it("summarizes numbered line reads piped through sed", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: '/bin/zsh -lc "nl -ba src/lib/projectModel.js | sed -n \'414,424p\'"',
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read src/lib/projectModel.js:414-424",
    );
    expect(visualToolCallPayloadText(block)).toContain("nl -ba");
  });

  it("summarizes structured read and grep tool payloads", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "Read",
        toolInput: {
          file_path: "packages/ui/src/VisualTranscript.svelte",
          offset: 100,
          limit: 51,
        },
      }),
    ).toBe("Read packages/ui/src/VisualTranscript.svelte:100-150");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "Grep",
        toolInput: {
          pattern: "visualToolPreviewText",
          path: "packages/ui/src",
        },
      }),
    ).toBe('Search packages/ui/src for "visualToolPreviewText"');
  });
});

describe("buildVisualWorkDisplayEntries", () => {
  it("pairs a tool use with the immediately following tool result", () => {
    const toolUse = {
      message: {
        role: "assistant",
        blocks: [{ type: "tool_use", text: "exec_command" }],
      },
      blocks: [{ type: "tool_use", text: "exec_command" }],
      messageIndex: 1,
    };
    const toolResult = {
      message: {
        role: "tool",
        blocks: [{ type: "tool_result", text: "tests passed" }],
      },
      blocks: [{ type: "tool_result", text: "tests passed" }],
      messageIndex: 2,
    };

    const entries = buildVisualWorkDisplayEntries([toolUse, toolResult]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toBe(toolUse);
    expect(entries[0]?.pairedResult).toBe(toolResult);
  });

  it("pairs grouped tool results back to their tool use ids", () => {
    const firstToolUse = {
      message: {
        role: "assistant",
        blocks: [{ type: "tool_use", text: "exec_command", toolUseId: "a" }],
      },
      blocks: [{ type: "tool_use", text: "exec_command", toolUseId: "a" }],
      messageIndex: 1,
    };
    const secondToolUse = {
      message: {
        role: "assistant",
        blocks: [{ type: "tool_use", text: "exec_command", toolUseId: "b" }],
      },
      blocks: [{ type: "tool_use", text: "exec_command", toolUseId: "b" }],
      messageIndex: 2,
    };
    const secondResult = {
      message: {
        role: "tool",
        blocks: [{ type: "tool_result", text: "second", toolUseId: "b" }],
      },
      blocks: [{ type: "tool_result", text: "second", toolUseId: "b" }],
      messageIndex: 3,
    };
    const firstResult = {
      message: {
        role: "tool",
        blocks: [{ type: "tool_result", text: "first", toolUseId: "a" }],
      },
      blocks: [{ type: "tool_result", text: "first", toolUseId: "a" }],
      messageIndex: 4,
    };

    const entries = buildVisualWorkDisplayEntries([
      firstToolUse,
      secondToolUse,
      secondResult,
      firstResult,
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.entry).toBe(firstToolUse);
    expect(entries[0]?.pairedResult).toBe(firstResult);
    expect(entries[1]?.entry).toBe(secondToolUse);
    expect(entries[1]?.pairedResult).toBe(secondResult);
  });

  it("carries a paired tool use name onto sparse tool results", () => {
    const toolUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolUseId: "call-1",
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "exec_command",
          toolUseId: "call-1",
        },
      ],
      messageIndex: 1,
    };
    const toolResult = {
      message: {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            text: "tests passed",
            toolUseId: "call-1",
          },
        ],
      },
      blocks: [
        {
          type: "tool_result",
          text: "tests passed",
          toolUseId: "call-1",
        },
      ],
      messageIndex: 2,
    };

    const entries = buildVisualWorkDisplayEntries([toolUse, toolResult]);

    expect(entries[0]?.pairedResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "exec_command",
      toolUseId: "call-1",
    });
    expect(toolResult.blocks[0]).not.toHaveProperty("toolName");
  });

  it("keeps standalone tool results visible", () => {
    const toolResult = {
      message: {
        role: "tool",
        blocks: [{ type: "tool_result", text: "tests passed" }],
      },
      blocks: [{ type: "tool_result", text: "tests passed" }],
      messageIndex: 2,
    };

    const entries = buildVisualWorkDisplayEntries([toolResult]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toBe(toolResult);
    expect(entries[0]?.pairedResult).toBeUndefined();
  });

  it("classifies marker-only rows for badge rendering", () => {
    const marker = {
      message: {
        role: "system",
        blocks: [{ type: "marker", text: "[Task complete]" }],
      },
      blocks: [{ type: "marker", text: "[Task complete]" }],
      messageIndex: 2,
    };

    const entries = buildVisualWorkDisplayEntries([marker]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "marker",
      markerKind: "complete",
      markerLabel: "Task complete",
    });
    expect(entries[0]?.entry).toBe(marker);
  });

  it("classifies compaction and abort markers as distinct badges", () => {
    const entries = buildVisualWorkDisplayEntries([
      {
        message: {
          role: "system",
          blocks: [{ type: "marker", text: "[Context compacted]" }],
        },
        blocks: [{ type: "marker", text: "[Context compacted]" }],
        messageIndex: 4,
      },
      {
        message: {
          role: "system",
          blocks: [{ type: "marker", text: "[Turn aborted: interrupted]" }],
        },
        blocks: [{ type: "marker", text: "[Turn aborted: interrupted]" }],
        messageIndex: 5,
      },
    ]);

    expect(entries).toMatchObject([
      {
        kind: "marker",
        markerKind: "compacted",
        markerLabel: "Context compacted",
      },
      {
        kind: "marker",
        markerKind: "aborted",
        markerLabel: "Turn aborted",
      },
    ]);
  });
});

describe("visualFileEditSummaryForBlock", () => {
  it("summarizes Codex apply_patch input into edited files with line counts", () => {
    expect(
      visualFileEditSummaryForBlock({
        type: "tool_use",
        toolName: "apply_patch",
        toolInput: [
          "*** Begin Patch",
          "*** Update File: packages/ui/src/SessionView.svelte",
          "@@",
          "-  old line",
          "+  new line",
          "+  another line",
          "*** Update File: packages/ui/src/codex-event-stream.ts",
          "@@",
          "+export function reconnect() {}",
          "*** End Patch",
        ].join("\n"),
      }),
    ).toEqual({
      title: "Edited 2 files",
      files: [
        {
          path: "packages/ui/src/SessionView.svelte",
          action: "edited",
          additions: 2,
          deletions: 1,
          raw: [
            "*** Update File: packages/ui/src/SessionView.svelte",
            "@@",
            "-  old line",
            "+  new line",
            "+  another line",
          ].join("\n"),
        },
        {
          path: "packages/ui/src/codex-event-stream.ts",
          action: "edited",
          additions: 1,
          deletions: 0,
          raw: [
            "*** Update File: packages/ui/src/codex-event-stream.ts",
            "@@",
            "+export function reconnect() {}",
          ].join("\n"),
        },
      ],
    });
  });

  it("summarizes Codex app-server file change arrays", () => {
    expect(
      visualFileEditSummaryForBlock({
        type: "tool_use",
        toolName: "file change",
        toolInput: {
          changes: [
            { path: "src/App.svelte", action: "modify" },
            { path: "src/new.ts", action: "add" },
          ],
        },
      }),
    ).toEqual({
      title: "Edited 2 files",
      files: [
        { path: "src/App.svelte", action: "edited" },
        { path: "src/new.ts", action: "added" },
      ],
    });
  });

  it("summarizes direct live file-change arrays", () => {
    expect(
      visualFileEditSummaryForBlock({
        type: "tool_use",
        toolName: "file change",
        toolInput: [
          {
            path: "src/App.svelte",
            action: "modify",
            unified_diff: "@@\n-old\n+new\n+extra\n",
          },
        ],
      }),
    ).toEqual({
      title: "Edited App.svelte",
      files: [
        {
          path: "src/App.svelte",
          action: "edited",
          additions: 2,
          deletions: 1,
          raw: "@@\n-old\n+new\n+extra\n",
        },
      ],
    });
  });

  it("summarizes keyed Codex patch_apply_end changes with line counts", () => {
    expect(
      visualFileEditSummaryForBlock({
        type: "tool_use",
        toolName: "file change",
        toolInput: {
          changes: {
            "/repo/deploy/registry.env.template": {
              type: "update",
              unified_diff: [
                "@@ -11 +11,2 @@",
                " MEDIKIT_LOGTO_BOOTSTRAP_IMAGE=latest",
                "+MEDIKIT_DOCKER_FLAVOR=remote",
                "",
              ].join("\n"),
            },
          },
        },
      }),
    ).toEqual({
      title: "Edited registry.env.template",
      files: [
        {
          path: "/repo/deploy/registry.env.template",
          action: "edited",
          additions: 1,
          deletions: 0,
          raw: "@@ -11 +11,2 @@\n MEDIKIT_LOGTO_BOOTSTRAP_IMAGE=latest\n+MEDIKIT_DOCKER_FLAVOR=remote\n",
        },
      ],
    });
  });

  it("summarizes Claude edit tool inputs", () => {
    expect(
      visualFileEditSummaryForBlock({
        type: "tool_use",
        toolName: "Edit",
        toolInput: {
          file_path: "/repo/src/App.svelte",
          old_string: "old\nline\n",
          new_string: "new\nline\nextra\n",
        },
      }),
    ).toEqual({
      title: "Edited App.svelte",
      files: [
        {
          path: "/repo/src/App.svelte",
          action: "edited",
          additions: 3,
          deletions: 2,
        },
      ],
    });
  });
});
