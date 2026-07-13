import { describe, it, expect } from "bun:test";
import {
  applyVisualTranscriptDeltaPatches,
  buildVisualWorkDisplayEntries,
  buildVisualTranscriptItems,
  buildVisibleVisualWorkDisplayEntries,
  cleanVisualUserText,
  cleanVisualToolResultText,
  formatVisualDurationSeconds,
  formatVisualWorkDuration,
  lastUserMessageBurst,
  lastUserMessageWithContext,
  latestVisualGoal,
  latestVisualPlan,
  mergeVisualSessionMessages,
  reuseStableVisualTranscriptItems,
  shouldShowLiveToolTimer,
  shouldShowLiveWorkTimer,
  visualPlanFromBlock,
  visualPlanFromPayload,
  visualPathPreviewTargets,
  visualToolCallPayloadLanguage,
  visualToolCallPayloadText,
  visualToolConfigAssignments,
  visualToolConfigSummaryLabel,
  visualToolConfigTooltipText,
  visualToolCommandResultBadges,
  visualToolApprovalBadge,
  visualToolLauncherLabel,
  visualToolPreviewParts,
  visualToolPreviewText,
  visualToolWaitForDurationLabel,
  visualToolEnvAssignments,
  visualToolEnvSummaryLabel,
  visualToolEnvTooltipText,
  visualToolFetchResultBadges,
  visualToolIconNameForPreview,
  visualToolTestResultBadges,
  visualToolInlineScript,
  visualToolInlineScriptLanguageLabel,
  visualToolInlineScriptPreviewText,
  visualToolMediaBlocks,
  visualFileEditCountBadge,
  visualObservedProcessOwnerToolUseBlock,
  visualToolRemoteHostLabel,
  visualWorkSummary,
  visualUserImageAttachments,
  visualFileEditTotals,
  visualFileEditSummaryForBlock,
  visualObservedProcessOutput,
  visualThinkingSummary,
  updateVisualTranscriptItems,
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

  it("reuses the same duration formatter for elapsed tool timers", () => {
    expect(formatVisualDurationSeconds(1)).toBe("1s");
    expect(formatVisualDurationSeconds(119 * 60 + 32)).toBe("1hr 59m 32s");
    expect(formatVisualDurationSeconds(3 * 86400 + 4 * 3600 + 12 * 60 + 5)).toBe(
      "3d 4h 12m 5s",
    );
  });

  it("shows work timers only for the active open tail", () => {
    expect(
      shouldShowLiveWorkTimer({
        active: true,
        open: true,
      }),
    ).toBe(true);
    expect(
      shouldShowLiveWorkTimer({
        active: true,
        open: true,
        tail: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveWorkTimer({
        active: false,
        open: true,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveWorkTimer({
        active: true,
        open: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveWorkTimer({
        active: true,
        open: true,
        endedAt: "2026-06-22T10:00:01.000Z",
      }),
    ).toBe(false);
  });

  it("shows tool timers for any unresolved active tool, not only the tail", () => {
    expect(
      shouldShowLiveToolTimer({
        active: true,
        open: true,
        hasFinalResult: false,
      }),
    ).toBe(true);
    expect(
      shouldShowLiveToolTimer({
        active: true,
        open: true,
        hasFinalResult: true,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveToolTimer({
        active: false,
        open: true,
        hasFinalResult: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveToolTimer({
        active: true,
        open: false,
        hasFinalResult: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveToolTimer({
        active: true,
        open: true,
        endedAt: "2026-06-22T10:00:01.000Z",
        hasFinalResult: false,
      }),
    ).toBe(false);
    expect(
      shouldShowLiveToolTimer({
        active: true,
        open: true,
        hasFinalResult: false,
        canStillRun: false,
      }),
    ).toBe(false);
  });

  it("formats browser wait timers with elapsed and timeout", () => {
    const block = {
      type: "tool_use",
      toolName: "wait_for",
      toolInput: {
        text: ["facevarying_normals_matrix", "Loading done", "Clear"],
        timeout: 60_000,
      },
    };
    expect(
      visualToolWaitForDurationLabel(
        block,
        "2026-06-22T10:00:00.000Z",
        "2026-06-22T10:00:04.200Z",
      ),
    ).toBe("4s / 60s");
    expect(
      visualToolWaitForDurationLabel(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: { cmd: "sleep 60" },
        },
        "2026-06-22T10:00:00.000Z",
        "2026-06-22T10:00:04.200Z",
      ),
    ).toBeUndefined();
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

describe("latestVisualGoal", () => {
  it("uses the newest normalized goal state without requiring transcript text", () => {
    const messages: Message[] = [
      {
        role: "system",
        blocks: [
          {
            type: "goal",
            goalObjective: "Make Treetop smooth.",
            goalStatus: "active",
            goalTokensUsed: 1000,
          },
        ],
      },
      {
        role: "system",
        blocks: [
          {
            type: "goal",
            goalObjective: "Make Treetop smooth.",
            goalStatus: "blocked",
            goalTokensUsed: 2500,
            goalTimeUsedSeconds: 125,
          },
        ],
      },
    ];

    expect(latestVisualGoal(messages)).toEqual({
      objective: "Make Treetop smooth.",
      status: "blocked",
      tokensUsed: 2500,
      timeUsedSeconds: 125,
      updatedAt: undefined,
      threadId: undefined,
    });
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

  it("cleans Codex request envelopes and extracts mentioned image files", () => {
    const text = [
      "# Files mentioned by the user:",
      "",
      "codex-clipboard-d0e93634.png:",
      "/var/folders/9l/codex-clipboard-d0e93634.png",
      "",
      "## My request for Codex:",
      "Thanks, that sounds great. But seems something about our handling of these files is still wrong.",
      "[Image #1]",
    ].join("\n");

    expect(cleanVisualUserText(text)).toBe(
      "Thanks, that sounds great. But seems something about our handling of these files is still wrong.",
    );
    expect(visualUserImageAttachments(text)).toEqual([
      {
        label: "codex-clipboard-d0e93634.png",
        path: "/var/folders/9l/codex-clipboard-d0e93634.png",
      },
    ]);
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

  it("folds user messages during an open Codex task into the work round as steering", () => {
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

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
      "message",
    ]);
    if (items[1]?.kind !== "work") throw new Error("expected steering work item");
    expect(
      items[1].entries
        .filter((entry) => entry.message.role === "user")
        .map((entry) => [entry.message.blocks[0]?.text, entry.message.intent]),
    ).toEqual([
      ["also keep it small", "steer"],
      ["and add a test", "steer"],
    ]);
    expect(
      items[1].entries.map((entry) =>
        entry.blocks.map((block) => block.text ?? block.type).join(" "),
      ),
    ).toEqual([
      "[Task started]",
      "I’ll start.",
      "also keep it small",
      "Noted.",
      "and add a test",
      "[Task complete]",
    ]);
    expect(visualWorkSummary(items[1].entries)).toMatchObject({
      steerings: 2,
    });
  });

  it("does not surface progress responses before later steering as final answers", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "validate externally", "2026-06-01T10:00:00.000Z"),
      {
        role: "system",
        timestamp: "2026-06-01T10:00:01.000Z",
        blocks: [{ type: "marker", text: "[Task started]" }],
      },
      msg(
        "assistant",
        "One remaining cleanup.",
        "2026-06-20T15:09:39.000Z",
      ),
      msg("user", "also run tests", "2026-06-20T15:10:00.000Z"),
      {
        role: "assistant",
        timestamp: "2026-06-20T15:10:20.000Z",
        blocks: [{ type: "tool_use", toolName: "exec_command" }],
      },
      {
        role: "system",
        timestamp: "2026-06-20T15:20:30.000Z",
        blocks: [{ type: "marker", text: "[Task complete]" }],
      },
      msg("assistant", "Done.", "2026-06-20T15:20:37.000Z"),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(
      items[1].entries.map((entry) => [
        entry.message.role,
        entry.message.intent,
        entry.blocks[0]?.text ?? entry.blocks[0]?.type,
      ]),
    ).toEqual([
      ["system", undefined, "[Task started]"],
      ["assistant", undefined, "One remaining cleanup."],
      ["user", "steer", "also run tests"],
      ["assistant", undefined, "tool_use"],
      ["system", undefined, "[Task complete]"],
    ]);
    if (items[2]?.kind !== "message") throw new Error("expected final response");
    expect(items[2].blocks).toEqual([{ type: "text", text: "Done." }]);
  });

  it("keeps clipped progress before explicit steering inside the same work round", () => {
    const steering = {
      ...msg(
        "user",
        "Woah is this a subdivision bug?",
        "2026-07-02T10:00:34.000Z",
      ),
      intent: "steer" as const,
    };
    const toolUse: Message = {
      role: "assistant",
      timestamp: "2026-07-02T10:00:37.000Z",
      blocks: [{ type: "tool_use", toolName: "exec_command" }],
    };

    const items = buildVisualTranscriptItems(
      [
        msg(
          "assistant",
          "The helper is lower in the file than I first expected.",
          "2026-07-02T10:00:32.000Z",
        ),
        steering,
        toolUse,
        msg(
          "assistant",
          "Good catch. I’m checking the authored mesh schema now.",
          "2026-07-02T10:00:41.000Z",
        ),
      ],
      { active: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["work"]);
    if (items[0]?.kind !== "work") throw new Error("expected work item");
    expect(visualWorkSummary(items[0].entries)).toMatchObject({
      steerings: 1,
    });
    expect(
      items[0].entries.map((entry) => [
        entry.message.role,
        entry.message.intent,
        entry.blocks[0]?.text ?? entry.blocks[0]?.type,
      ]),
    ).toEqual([
      [
        "assistant",
        undefined,
        "The helper is lower in the file than I first expected.",
      ],
      ["user", "steer", "Woah is this a subdivision bug?"],
      ["assistant", undefined, "tool_use"],
      [
        "assistant",
        undefined,
        "Good catch. I’m checking the authored mesh schema now.",
      ],
    ]);
  });

  it("attaches later pre-user task-start markers so clarifications become steering", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "previous request", "2026-07-02T03:54:00.000Z"),
      {
        role: "system",
        timestamp: "2026-07-02T03:55:00.000Z",
        blocks: [{ type: "marker", text: "[Task complete]" }],
      },
      msg("assistant", "Previous done.", "2026-07-02T03:55:09.000Z"),
      {
        role: "system",
        timestamp: "2026-07-02T05:39:56.344Z",
        blocks: [{ type: "marker", text: "[Task started]" }],
      },
      msg(
        "user",
        "OK, time for an audit",
        "2026-07-02T05:39:56.660Z",
      ),
      msg(
        "assistant",
        "npm run check is running.",
        "2026-07-02T05:41:45.416Z",
      ),
      msg(
        "user",
        "my question was in particular about that active goal.",
        "2026-07-02T05:41:48.508Z",
      ),
      msg(
        "assistant",
        "Got it. I’ll answer specifically as an audit.",
        "2026-07-02T05:42:06.403Z",
      ),
      {
        role: "system",
        timestamp: "2026-07-02T05:49:50.624Z",
        blocks: [{ type: "marker", text: "[Task complete]" }],
      },
      msg("assistant", "Final audit.", "2026-07-02T05:49:50.624Z"),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
      "work",
      "message",
    ]);
    if (items[3]?.kind !== "work") throw new Error("expected audit work item");
    expect(visualWorkSummary(items[3].entries)).toMatchObject({
      steerings: 1,
    });
    expect(
      items[3].entries.map((entry) => [
        entry.message.role,
        entry.message.intent,
        entry.blocks[0]?.text ?? entry.blocks[0]?.type,
      ]),
    ).toEqual([
      ["system", undefined, "[Task started]"],
      ["assistant", undefined, "npm run check is running."],
      [
        "user",
        "steer",
        "my question was in particular about that active goal.",
      ],
      [
        "assistant",
        undefined,
        "Got it. I’ll answer specifically as an audit.",
      ],
      ["system", undefined, "[Task complete]"],
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

  it("promotes an aborted steered turn to the work headline", () => {
    const items = buildVisualTranscriptItems([
      msg("user", "continue", "2026-06-19T10:00:00.000Z"),
      {
        role: "system",
        timestamp: "2026-06-19T10:00:01.000Z",
        blocks: [{ type: "marker", text: "[Task started]" }],
      },
      {
        ...msg("user", "actually stop here", "2026-06-19T10:00:02.000Z"),
        intent: "steer",
      },
      {
        role: "system",
        timestamp: "2026-06-19T10:00:03.000Z",
        blocks: [
          {
            type: "marker",
            text: "[Turn aborted] The user interrupted the previous turn.",
          },
        ],
      },
    ]);

    expect(items.map((item) => item.kind)).toEqual(["message", "work"]);
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1]).toMatchObject({
      terminalMarkerKind: "aborted",
      terminalMarkerLabel: "Turn aborted",
    });
    expect(visualWorkSummary(items[1].entries)).toEqual({
      steps: 0,
      compactions: 0,
      steerings: 1,
      subagents: 0,
    });
    expect(items[1].entries.map((entry) => entry.message.role)).toEqual([
      "system",
      "user",
      "system",
    ]);
    expect(items[1].entries[1]!.message.intent).toBe("steer");
    expect(
      buildVisibleVisualWorkDisplayEntries(items[1]).map((entry) =>
        entry.kind === "marker" ? entry.markerLabel : entry.entry.message.role,
      ),
    ).toEqual(["Task started", "user"]);
  });

  it("ends active work at a task-complete marker", () => {
    const items = buildVisualTranscriptItems(
      [
        msg("user", "continue", "2026-06-19T10:00:00.000Z"),
        {
          role: "system",
          timestamp: "2026-06-19T10:00:01.000Z",
          blocks: [{ type: "marker", text: "[Task started]" }],
        },
        {
          role: "system",
          timestamp: "2026-06-19T10:00:15.000Z",
          blocks: [{ type: "marker", text: "[Task complete]" }],
        },
      ],
      { active: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["message"]);
  });

  it("keeps completed work expanded when no final response exists", () => {
    const items = buildVisualTranscriptItems(
      [
        msg("user", "continue", "2026-06-19T10:00:00.000Z"),
        {
          role: "system",
          timestamp: "2026-06-19T10:00:01.000Z",
          blocks: [{ type: "marker", text: "[Task started]" }],
        },
        {
          role: "assistant",
          timestamp: "2026-06-19T10:00:10.000Z",
          blocks: [{ type: "tool_use", toolName: "exec_command" }],
        },
        {
          role: "system",
          timestamp: "2026-06-19T10:00:15.000Z",
          blocks: [{ type: "marker", text: "[Task complete]" }],
        },
      ],
      { active: true },
    );

    expect(items.map((item) => item.kind)).toEqual(["message", "work"]);
    expect(items[1]).toMatchObject({
      kind: "work",
      open: true,
    });
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(items[1].entries.map((entry) => entry.blocks[0]?.type)).toEqual([
      "marker",
      "tool_use",
      "marker",
    ]);
  });

  it("ends stale started work when a later user turn begins", () => {
    const items = buildVisualTranscriptItems(
      [
        msg("user", "do the deploy", "2026-06-19T10:00:00.000Z"),
        {
          role: "system",
          timestamp: "2026-06-19T10:00:01.000Z",
          blocks: [{ type: "marker", text: "[Task started]" }],
        },
        msg("user", "that env file stays the same?", "2026-06-19T15:56:00.000Z"),
        msg("assistant", "Correct.", "2026-06-19T15:56:11.000Z"),
      ],
      { active: false },
    );

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
    ]);
  });

  it("ends active work at an unretryable failure marker", () => {
    const items = buildVisualTranscriptItems(
      [
        msg("user", "continue", "2026-06-19T10:00:00.000Z"),
        {
          role: "system",
          timestamp: "2026-06-19T10:00:01.000Z",
          blocks: [{ type: "marker", text: "[Task started]" }],
        },
        {
          role: "system",
          timestamp: "2026-06-19T10:00:15.000Z",
          blocks: [
            {
              type: "marker",
              text: "[Turn failed: Context window exceeded]",
            },
          ],
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
    expect(buildVisualWorkDisplayEntries(items[1].entries)).toContainEqual(
      expect.objectContaining({
        kind: "marker",
        markerKind: "failed",
        markerLabel: "Context window full",
      }),
    );
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

  it("attaches generated image media from the work range to the final response", () => {
    const imageTool: Message = {
      role: "assistant",
      timestamp: "2026-07-02T15:42:10.000Z",
      blocks: [
        {
          type: "tool_use",
          toolName: "image_generation_call",
          toolUseId: "ig-1",
          toolInput: { prompt: "duberman" },
        },
      ],
    };
    const imageResult: Message = {
      role: "tool",
      timestamp: "2026-07-02T15:42:10.100Z",
      blocks: [
        {
          type: "tool_result",
          toolName: "image_generation_call",
          toolUseId: "ig-1",
          text: "Generated image",
        },
      ],
    };
    const imageMedia: Message = {
      role: "assistant",
      timestamp: "2026-07-02T15:42:10.200Z",
      blocks: [
        {
          type: "media",
          text: "generated image",
          toolName: "image_generation_call",
          toolUseId: "ig-1",
        },
      ],
    };
    const finalResponse = msg(
      "assistant",
      "Generated your Duberman image.",
      "2026-07-02T15:42:11.000Z",
    );

    const items = buildVisualTranscriptItems([
      msg("user", "make an image", "2026-07-02T15:40:48.000Z"),
      imageTool,
      imageResult,
      imageMedia,
      finalResponse,
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "work",
      "message",
    ]);
    if (items[1]?.kind !== "work") throw new Error("expected work item");
    expect(
      items[1].entries.some((entry) =>
        entry.blocks.some((block) => block.type === "media"),
      ),
    ).toBe(true);
    if (items[2]?.kind !== "message") throw new Error("expected message item");
    expect(items[2].blocks).toEqual([
      {
        type: "media",
        text: "generated image",
        toolName: "image_generation_call",
        toolUseId: "ig-1",
      },
      { type: "text", text: "Generated your Duberman image." },
    ]);
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
      steerings: 0,
      subagents: 0,
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

  it("collapses quick tool starts and results by tool-use id even when they are not adjacent", () => {
    const entries = [
      {
        message: {
          role: "assistant",
          timestamp: "2026-07-02T15:40:00.000Z",
          blocks: [
            { type: "tool_use", toolName: "spawn_agent", toolUseId: "call-1" },
          ],
        },
        blocks: [
          { type: "tool_use", toolName: "spawn_agent", toolUseId: "call-1" },
        ],
        messageIndex: 0,
      },
      {
        message: msg(
          "assistant",
          "Carson is on it.",
          "2026-07-02T15:40:00.200Z",
        ),
        blocks: [{ type: "text", text: "Carson is on it." }],
        messageIndex: 1,
      },
      {
        message: {
          role: "tool",
          timestamp: "2026-07-02T15:40:00.800Z",
          blocks: [
            {
              type: "tool_result",
              toolName: "spawn_agent",
              toolUseId: "call-1",
              text: '{"agent_id":"agent-1","nickname":"Carson"}',
            },
          ],
        },
        blocks: [
          {
            type: "tool_result",
            toolName: "spawn_agent",
            toolUseId: "call-1",
            text: '{"agent_id":"agent-1","nickname":"Carson"}',
          },
        ],
        messageIndex: 2,
      },
    ];

    const display = buildVisualWorkDisplayEntries(entries);

    expect(display.map((entry) => entry.entry.blocks[0]?.type)).toEqual([
      "tool_use",
      "text",
    ]);
    expect(display[0]?.pairedResult?.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "spawn_agent",
      toolUseId: "call-1",
    });
  });

  it("keeps long-running tool results visible at the result point", () => {
    const entries = [
      {
        message: {
          role: "assistant",
          timestamp: "2026-07-02T15:40:00.000Z",
          blocks: [
            { type: "tool_use", toolName: "exec_command", toolUseId: "call-1" },
          ],
        },
        blocks: [
          { type: "tool_use", toolName: "exec_command", toolUseId: "call-1" },
        ],
        messageIndex: 0,
      },
      {
        message: msg(
          "assistant",
          "Still running.",
          "2026-07-02T15:40:02.000Z",
        ),
        blocks: [{ type: "text", text: "Still running." }],
        messageIndex: 1,
      },
      {
        message: {
          role: "tool",
          timestamp: "2026-07-02T15:40:03.000Z",
          blocks: [
            {
              type: "tool_result",
              toolName: "exec_command",
              toolUseId: "call-1",
              text: "done",
            },
          ],
        },
        blocks: [
          {
            type: "tool_result",
            toolName: "exec_command",
            toolUseId: "call-1",
            text: "done",
          },
        ],
        messageIndex: 2,
      },
    ];

    const display = buildVisualWorkDisplayEntries(entries);

    expect(display.map((entry) => entry.entry.blocks[0]?.type)).toEqual([
      "tool_use",
      "text",
      "tool_result",
    ]);
    expect(display[2]?.pairedToolUse?.blocks[0]).toMatchObject({
      type: "tool_use",
      toolUseId: "call-1",
    });
  });

  it("collapses a redundant subagent notification after the matching wait result", () => {
    const entries = [
      {
        message: {
          role: "assistant",
          timestamp: "2026-07-02T15:40:00.000Z",
          blocks: [
            {
              type: "tool_use",
              toolName: "wait_agent",
              toolUseId: "call-wait",
              toolInput: { targets: ["agent-1"] },
            },
          ],
        },
        blocks: [
          {
            type: "tool_use",
            toolName: "wait_agent",
            toolUseId: "call-wait",
            toolInput: { targets: ["agent-1"] },
          },
        ],
        messageIndex: 0,
      },
      {
        message: {
          role: "tool",
          timestamp: "2026-07-02T15:40:03.000Z",
          blocks: [
            {
              type: "tool_result",
              toolName: "wait_agent",
              toolUseId: "call-wait",
              text: JSON.stringify({
                status: {
                  "agent-1": { completed: "Subagent report." },
                },
              }),
            },
          ],
        },
        blocks: [
          {
            type: "tool_result",
            toolName: "wait_agent",
            toolUseId: "call-wait",
            text: JSON.stringify({
              status: {
                "agent-1": { completed: "Subagent report." },
              },
            }),
          },
        ],
        messageIndex: 1,
      },
      {
        message: {
          role: "assistant",
          timestamp: "2026-07-02T15:40:03.100Z",
          blocks: [
            {
              type: "subagent",
              text: "Subagent report.",
              subagentId: "agent-1",
              subagentAction: "notification",
              subagentStatus: "completed",
              subagentResult: "Subagent report.",
            },
          ],
        },
        blocks: [
          {
            type: "subagent",
            text: "Subagent report.",
            subagentId: "agent-1",
            subagentAction: "notification",
            subagentStatus: "completed",
            subagentResult: "Subagent report.",
          },
        ],
        messageIndex: 2,
      },
    ];

    const display = buildVisualWorkDisplayEntries(entries);

    expect(display.map((entry) => entry.entry.blocks[0]?.type)).toEqual([
      "tool_use",
      "tool_result",
    ]);
    expect(display[1]?.pairedToolUse?.blocks[0]).toMatchObject({
      type: "tool_use",
      toolName: "wait_agent",
    });
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

describe("updateVisualTranscriptItems", () => {
  it("rebuilds only from the affected tail user turn when a live message grows", () => {
    const firstUser = msg("user", "fix it", "2026-06-19T10:00:00.000Z");
    const firstAnswer = msg(
      "assistant",
      "Done.",
      "2026-06-19T10:00:02.000Z",
    );
    const secondUser = msg("user", "continue", "2026-06-19T10:00:10.000Z");
    const liveTool: Message = {
      id: "tool-use",
      role: "assistant",
      timestamp: "2026-06-19T10:00:12.000Z",
      blocks: [{ type: "tool_use", toolName: "exec_command" }],
    };
    const liveResult: Message = {
      id: "tool-result",
      role: "tool",
      timestamp: "2026-06-19T10:00:13.000Z",
      blocks: [{ type: "tool_result", text: "one" }],
    };
    const previousMessages = [
      firstUser,
      firstAnswer,
      secondUser,
      liveTool,
      liveResult,
    ];
    const previousItems = buildVisualTranscriptItems(previousMessages, {
      active: true,
    });
    const grownResult: Message = {
      ...liveResult,
      blocks: [{ type: "tool_result", text: "one\ntwo" }],
    };

    const next = updateVisualTranscriptItems({
      previousMessages,
      previousItems,
      previousActive: true,
      messages: [firstUser, firstAnswer, secondUser, liveTool, grownResult],
      active: true,
    });

    expect(next[0]).toBe(previousItems[0]);
    expect(next[1]).toBe(previousItems[1]);
    expect(next[2]).toBe(previousItems[2]);
    expect(next[3]).not.toBe(previousItems[3]);
    expect(next.map((item) => item.kind)).toEqual(
      buildVisualTranscriptItems(
        [firstUser, firstAnswer, secondUser, liveTool, grownResult],
        { active: true },
      ).map((item) => item.kind),
    );
  });

  it("keeps an appended live steering message inside the open work round", () => {
    const user = msg(
      "user",
      "validate externally",
      "2026-06-20T15:00:00.000Z",
    );
    const taskStarted: Message = {
      role: "system",
      timestamp: "2026-06-20T15:00:01.000Z",
      blocks: [{ type: "marker", text: "[Task started]" }],
    };
    const progress = msg(
      "assistant",
      "One remaining cleanup.",
      "2026-06-20T15:09:39.000Z",
    );
    const previousMessages = [user, taskStarted, progress];
    const previousItems = buildVisualTranscriptItems(previousMessages, {
      active: true,
    });
    const steering = msg(
      "user",
      "also run tests",
      "2026-06-20T15:10:00.000Z",
    );
    const toolUse: Message = {
      id: "test-tool-use",
      role: "assistant",
      timestamp: "2026-06-20T15:10:05.000Z",
      blocks: [{ type: "tool_use", toolName: "exec_command" }],
    };

    const next = updateVisualTranscriptItems({
      previousMessages,
      previousItems,
      previousActive: true,
      messages: [...previousMessages, steering, toolUse],
      active: true,
    });

    expect(next.map((item) => item.kind)).toEqual(["message", "work"]);
    if (next[1]?.kind !== "work") throw new Error("expected open work item");
    expect(
      next[1].entries.map((entry) => [
        entry.message.role,
        entry.message.intent,
        entry.blocks[0]?.text ?? entry.blocks[0]?.type,
      ]),
    ).toEqual([
      ["system", undefined, "[Task started]"],
      ["assistant", undefined, "One remaining cleanup."],
      ["user", "steer", "also run tests"],
      ["assistant", undefined, "tool_use"],
    ]);
  });

  it("reclassifies preceding live progress when an active steering row is appended", () => {
    const user = msg(
      "user",
      "build fixture coverage",
      "2026-07-02T10:00:00.000Z",
    );
    const taskStarted: Message = {
      role: "system",
      timestamp: "2026-07-02T10:00:01.000Z",
      blocks: [{ type: "marker", text: "[Task started]" }],
    };
    const progress = msg(
      "assistant",
      "I’m building the fixture set around visible final outcomes.",
      "2026-07-02T10:00:05.000Z",
    );
    const previousMessages = [user, taskStarted, progress];
    const stalePreviousItems = buildVisualTranscriptItems(previousMessages);
    expect(stalePreviousItems.map((item) => item.kind)).toEqual([
      "message",
      "message",
    ]);

    const steering = msg(
      "user",
      "hey dude what the heck",
      "2026-07-02T10:00:06.000Z",
    );
    const thinking: Message = {
      role: "assistant",
      timestamp: "2026-07-02T10:00:07.000Z",
      blocks: [{ type: "thinking", text: "Exploring MaterialX implementation" }],
    };

    const next = updateVisualTranscriptItems({
      previousMessages,
      previousItems: stalePreviousItems,
      previousActive: true,
      messages: [...previousMessages, steering, thinking],
      active: true,
    });

    expect(next.map((item) => item.kind)).toEqual(["message", "work"]);
    if (next[1]?.kind !== "work") throw new Error("expected active work item");
    expect(visualWorkSummary(next[1].entries)).toMatchObject({
      steerings: 1,
    });
    expect(
      next[1].entries.map((entry) => [
        entry.message.role,
        entry.message.intent,
        entry.blocks[0]?.text ?? entry.blocks[0]?.type,
      ]),
    ).toEqual([
      ["system", undefined, "[Task started]"],
      [
        "assistant",
        undefined,
        "I’m building the fixture set around visible final outcomes.",
      ],
      ["user", "steer", "hey dude what the heck"],
      ["assistant", undefined, "Exploring MaterialX implementation"],
    ]);
  });

  it("keeps a normal live follow-up after a completed turn out of steering", () => {
    const firstUser = msg(
      "user",
      "fix the layout",
      "2026-07-06T10:00:00.000Z",
    );
    const taskStarted: Message = {
      role: "system",
      timestamp: "2026-07-06T10:00:01.000Z",
      blocks: [{ type: "marker", text: "[Task started]" }],
    };
    const finalAnswer = msg(
      "assistant",
      "Done.",
      "2026-07-06T10:00:10.000Z",
    );
    const secondUser = msg(
      "user",
      "now commit it",
      "2026-07-06T10:00:20.000Z",
    );
    secondUser.id = "codex-optimistic-user-normal";
    const nextThinking: Message = {
      role: "assistant",
      timestamp: "2026-07-06T10:00:21.000Z",
      blocks: [{ type: "thinking", text: "Preparing commit" }],
    };

    const items = buildVisualTranscriptItems(
      [firstUser, taskStarted, finalAnswer, secondUser, nextThinking],
      { active: true },
    );

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
      "work",
    ]);
    const followUp = items[2];
    if (followUp?.kind !== "message") throw new Error("expected follow-up");
    expect(followUp.message.role).toBe("user");
    expect(followUp.message.intent).toBeUndefined();
    expect(visualWorkSummary(items[3]?.kind === "work" ? items[3].entries : []))
      .toMatchObject({
        steerings: 0,
      });
  });

  it("appends a new user turn without remaking earlier transcript items", () => {
    const firstUser = msg("user", "fix it", "2026-06-19T10:00:00.000Z");
    const firstAnswer = msg(
      "assistant",
      "Done.",
      "2026-06-19T10:00:02.000Z",
    );
    const previousMessages = [firstUser, firstAnswer];
    const previousItems = buildVisualTranscriptItems(previousMessages);
    const secondUser = msg("user", "continue", "2026-06-19T10:00:10.000Z");

    const next = updateVisualTranscriptItems({
      previousMessages,
      previousItems,
      previousActive: false,
      messages: [firstUser, firstAnswer, secondUser],
      active: false,
    });

    expect(next[0]).toBe(previousItems[0]);
    expect(next[1]).toBe(previousItems[1]);
    expect(next[2]).toMatchObject({
      kind: "message",
      message: secondUser,
      messageIndex: 2,
    });
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
  it("places optimistic user rows after their send-time anchor", () => {
    const before = msg("assistant", "before", "2026-06-19T10:00:00.000Z");
    before.id = "before";
    const liveAssistant = msg(
      "assistant",
      "working",
      "2026-06-19T10:00:02.000Z",
    );
    const optimistic: Message = {
      id: "codex-optimistic-user-queued",
      role: "user",
      timestamp: "2026-06-19T10:00:01.000Z",
      optimisticAfterMessageId: "before",
      optimisticAfterMessageIndex: 0,
      blocks: [{ type: "text", text: "queued follow-up" }],
    };

    expect(
      mergeVisualSessionMessages([before, liveAssistant], [optimistic]).map(
        (message) => message.blocks[0]?.text,
      ),
    ).toEqual(["before", "queued follow-up", "working"]);
  });

  it("does not timestamp-sort new optimistic user rows above older app-server rows", () => {
    const priorUser = msg("user", "older request", "2026-06-19T09:59:00.000Z");
    priorUser.id = "prior-user";
    const priorAssistant = msg("assistant", "older reply");
    priorAssistant.id = "prior-assistant";
    const optimistic: Message = {
      id: "codex-optimistic-user-latest",
      role: "user",
      timestamp: "2026-06-19T10:00:01.000Z",
      optimisticAfterMessageId: "prior-assistant",
      optimisticAfterMessageIndex: 1,
      blocks: [{ type: "text", text: "latest request" }],
    };

    expect(
      mergeVisualSessionMessages([priorUser, priorAssistant], [optimistic]).map(
        (message) => message.blocks[0]?.text,
      ),
    ).toEqual(["older request", "older reply", "latest request"]);
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

  it("matches optimistic image sends to canonical app-server user rows", () => {
    const optimistic: Message = {
      id: "codex-optimistic-user-image",
      role: "user",
      timestamp: "2026-06-19T10:00:01.000Z",
      blocks: [
        {
          type: "media",
          mediaKind: "image",
          path: "/tmp/codex-clipboard.png",
          title: "codex-clipboard.png",
          alt: "codex-clipboard.png",
          mimeType: "image/png",
          hasAlpha: false,
        },
        {
          type: "text",
          text: "Seems we can still end up with this wrong shape:",
        },
      ],
    };
    const canonical: Message = {
      id: "codex-user-user-1",
      role: "user",
      timestamp: "2026-06-19T10:00:02.000Z",
      blocks: [
        {
          type: "media",
          mediaKind: "image",
          path: "/tmp/codex-clipboard.png",
          title: "Image",
          alt: "Image",
        },
        {
          type: "text",
          text: "Seems we can still end up with this wrong shape:",
        },
      ],
    };

    expect(mergeVisualSessionMessages([canonical], [optimistic])).toEqual([
      canonical,
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
        blockFields: {
          toolName: "exec_command",
          toolUseId: "call-1",
          streaming: true,
        },
        timestamp: "2026-06-21T20:00:03.000Z",
      },
      {
        id: "codex-output-call-1",
        role: "tool",
        type: "tool_result",
        delta: " chunk",
        blockFields: {
          toolName: "exec_command",
          toolUseId: "call-1",
          streaming: true,
        },
        timestamp: "2026-06-21T20:00:04.000Z",
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
          text: "stdout chunk",
          toolName: "exec_command",
          toolUseId: "call-1",
          streaming: true,
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

  it("strips Codex running process poll metadata and keeps observed output", () => {
    expect(
      cleanVisualToolResultText(
        "Chunk ID: b96e6e\nWall time: 30.0028 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n450/700\n",
      ),
    ).toEqual({
      title: "Process output",
      body: "450/700",
      wrappedCodexChunk: true,
      wallTimeSeconds: 30.0028,
      originalTokenCount: 2,
      processRunning: true,
      processSessionId: 55249,
    });
  });

  it("summarizes write_stdin polls as read-log rows", () => {
    expect(
      visualObservedProcessOutput(
        {
          type: "tool_use",
          toolName: "write_stdin",
          toolInput: {
            session_id: 55249,
            chars: "",
            yield_time_ms: 30000,
          },
        },
        {
          type: "tool_result",
          toolName: "write_stdin",
          text: "Chunk ID: 07acea\nWall time: 30.0019 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n500/700\n",
        },
      ),
    ).toEqual({
      title: "Read logs",
      preview: "500/700",
      processSessionId: 55249,
      wallTimeSeconds: 30.0019,
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

  it("removes markdown title wrappers from single-line thinking summaries", () => {
    expect(visualThinkingSummary("**Extracting PLY scores and visuals**")).toEqual({
      title: "Extracting PLY scores and visuals",
      body: "",
    });
  });
});

describe("visual tool payload display helpers", () => {
  it("shows command approval decisions as concise badges", () => {
    expect(
      visualToolApprovalBadge({
        type: "tool_use",
        toolName: "exec_command",
        approvalDecision: "approved",
        approvalPolicy: "on-request",
        sandboxPolicy: "workspace-write",
      }),
    ).toEqual({
      label: "approved by you",
      title:
        "Approval policy: on-request\nDecision: approved\nSandbox: workspace-write",
      tone: "approved",
    });

    expect(
      visualToolApprovalBadge({
        type: "tool_use",
        toolName: "exec_command",
        approvalPolicy: "never",
        sandboxPolicy: "danger-full-access",
      }),
    ).toBeUndefined();
  });

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

    expect(visualToolPreviewText(block)).toBe("Run Bun tests last-user-message.test.ts");
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

    expect(visualToolPreviewText(block)).toBe("Run npm tests");
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

    expect(visualToolPreviewText(block)).toBe("Read create.three.js:60-155");
    expect(visualToolPreviewParts(block)).toEqual([
      { kind: "text", text: "Read " },
      {
        kind: "path",
        text: "create.three.js:60-155",
        path: "usd-wasm/src/create.three.js",
        range: ":60-155",
      },
    ]);
    expect(visualToolCallPayloadText(block)).toContain(
      "/bin/zsh -lc \\\"sed -n '60,155p' usd-wasm/src/create.three.js\\\"",
    );
  });

  it("formats reusable path preview targets with parent and ambiguity context", () => {
    expect(
      visualPathPreviewTargets([
        "src/routes/a/+page.svelte:1-20",
        "src/routes/b/+page.svelte",
        "/repo/skills/imagegen/SKILL.md",
      ]),
    ).toEqual([
      {
        kind: "path",
        text: "a/+page.svelte:1-20",
        path: "src/routes/a/+page.svelte",
        range: ":1-20",
      },
      {
        kind: "path",
        text: "b/+page.svelte",
        path: "src/routes/b/+page.svelte",
        range: "",
      },
      {
        kind: "path",
        text: "imagegen/SKILL.md",
        path: "/repo/skills/imagegen/SKILL.md",
        range: "",
      },
    ]);
  });

  it("normalizes Unix shell launch wrappers before previewing commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "/usr/bin/env bash -lc 'git diff --stat'",
      },
    };

    expect(visualToolPreviewText(block)).toBe("Review diff stats");
    expect(visualToolLauncherLabel(block)).toBe("bash");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput:
          'exec_command {"cmd":"/bin/zsh -lc \'git status --short\'","workdir":"/repo"}',
      }),
    ).toBe("Check git status");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput:
          'exec_command {"cmd":"/bin/zsh -lc \'git diff --check\'","workdir":"/repo"}',
      }),
    ).toBe("Check diff whitespace");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput:
          'exec_command {"cmd":"/bin/zsh -lc \'git diff --stat\'","workdir":"/repo"}',
      }),
    ).toBe("Review diff stats");
  });

  it("summarizes common git commands around the intent and paths", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git status --short" },
      }),
    ).toBe("Check git status");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "git diff -- packages/ui/src/SessionView.svelte packages/ui/src/codex-event-stream.ts",
        },
      }),
    ).toBe("Review diff SessionView.svelte, codex-event-stream.ts");

    expect(
      visualToolPreviewParts({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "git diff -- packages/ui/src/SessionView.svelte packages/ui/src/codex-event-stream.ts",
        },
      }),
    ).toEqual([
      { kind: "text", text: "Review diff " },
      {
        kind: "path",
        text: "SessionView.svelte",
        path: "packages/ui/src/SessionView.svelte",
        range: "",
      },
      { kind: "text", text: ", " },
      {
        kind: "path",
        text: "codex-event-stream.ts",
        path: "packages/ui/src/codex-event-stream.ts",
        range: "",
      },
    ]);

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git diff --cached --stat" },
      }),
    ).toBe("Review staged diff stats");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git diff --check" },
      }),
    ).toBe("Check diff whitespace");
    expect(
      visualToolIconNameForPreview({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git -C /Users/herbst/git/OpenUSD diff --check" },
      }),
    ).toBe("git");

    const stageBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "git add -- domain.ts i18n.ts store.ts routes/+page.server.ts routes/+page.svelte",
      },
    };
    expect(visualToolPreviewText(stageBlock)).toBe(
      "Stage domain.ts, i18n.ts, store.ts, routes/+page.server.ts, routes/+page.svelte",
    );
    expect(visualToolCommandResultBadges(stageBlock)).toEqual([
      {
        label: "5 files",
        tone: "neutral",
        title: "5 files staged",
      },
    ]);

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git rev-list --count needle/main..HEAD" },
      }),
    ).toBe("Count commits needle/main..HEAD");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "git rev-list --count needle/main..HEAD && git diff --check",
        },
      }),
    ).toBe("Count commits needle/main..HEAD · Check diff whitespace");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "git check-ignore -v full_assets/Kitchen_set full_assets/Kitchen_set_draco/Kitchen_set_draco.usda || true",
        },
      }),
    ).toBe(
      "Check git ignore for Kitchen_set, Kitchen_set_draco.usda",
    );

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: 'git show HEAD:packages/ui/src/SessionView.svelte | rg -n "codexAppHistoryKey"',
        },
      }),
    ).toBe('Search SessionView.svelte from HEAD for "codexAppHistoryKey"');

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git ls-files tests/fixtures | head -80" },
      }),
    ).toBe("List tracked files in tests/fixtures");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "git log --oneline -5" },
      }),
    ).toBe("Show recent commits");
  });

  it("summarizes common test and check commands", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "bun test packages/ui/test/codex-event-stream.test.ts --grep loads",
        },
      }),
    ).toBe("Run Bun tests codex-event-stream.test.ts");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx vitest run src/lib/audioMix.test.js src/lib/timelineTracks.test.js",
        },
      }),
    ).toBe("Run Vitest tests audioMix.test.js, timelineTracks.test.js");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "uv run --project local-models/server --group dev pytest local-models/server/tests/test_app.py",
        },
      }),
    ).toBe("Run Pytest tests test_app.py");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "npx playwright test tests/e2e/app.spec.js --project=chromium" },
      }),
    ).toBe("Run Playwright tests app.spec.js");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "npx tsc --noEmit" },
      }),
    ).toBe("Run TypeScript check");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "npx svelte-check --fail-on-warnings=false" },
      }),
    ).toBe("Run Svelte check");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "bash -n scripts/setup_optional_models.sh scripts/moebius/inpaint.sh",
        },
      }),
    ).toBe(
      "Check shell syntax setup_optional_models.sh, inpaint.sh",
    );
  });

  it("shows test result badges from paired command output", () => {
    const bun = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: { cmd: "bun test packages/ui/test/last-user-message.test.ts" },
    };
    expect(
      visualToolTestResultBadges(bun, {
        type: "tool_result",
        text: "Chunk ID: b1\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 10\nOutput:\n(pass) one\n(pass) two\n(skip) later\n1 todo\n\n 2 pass\n 0 fail\n 1 skip\n 1 todo",
      }),
    ).toEqual([
      { label: "✓2", tone: "success", title: "2 tests passed" },
      { label: "skip 1", tone: "neutral", title: "1 test skipped" },
      { label: "todo 1", tone: "neutral", title: "1 todo test" },
    ]);

    expect(
      visualToolTestResultBadges(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: { cmd: "npx vitest run src/lib/audioMix.test.js" },
        },
        {
          type: "tool_result",
          text: "Chunk ID: v1\nWall time: 0.1000 seconds\nProcess exited with code 1\nOriginal token count: 10\nOutput:\nTest Files  1 failed | 2 passed (3)\nTests  3 failed | 20 passed (23)\nWarnings  2",
        },
      ),
    ).toEqual([
      { label: "✕3", tone: "danger", title: "3 tests failed" },
      { label: "⚠2", tone: "warning", title: "2 warnings" },
      { label: "✓20", tone: "success", title: "20 tests passed" },
    ]);

    expect(
      visualToolTestResultBadges(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: {
            cmd: "npx playwright test tests/e2e/api-and-pipeline.spec.js --project=chromium",
          },
        },
        {
          type: "tool_result",
          text: "Exit code: 1\nWall time: 34.0000 seconds\nOutput:\nRunning 3 tests using 1 worker\n  ✘  1 tests/e2e/api-and-pipeline.spec.js:12:1 › subtitle blocks in Cut mode (30.0s)\n  ✓  2 tests/e2e/api-and-pipeline.spec.js:34:1 › opens timeline (1.0s)\n  ✓  3 tests/e2e/api-and-pipeline.spec.js:52:1 › exports captions (1.2s)",
        },
      ),
    ).toEqual([
      { label: "✕1", tone: "danger", title: "1 test failed" },
      { label: "✓2", tone: "success", title: "2 tests passed" },
    ]);

    expect(
      visualToolTestResultBadges(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: { cmd: "pytest local-models/server/tests/test_app.py" },
        },
        {
          type: "tool_result",
          text: "Chunk ID: p1\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 10\nOutput:\n================ 7 passed, 2 warnings in 1.20s ================",
        },
      ),
    ).toEqual([
      { label: "⚠2", tone: "warning", title: "2 warnings" },
      { label: "✓7", tone: "success", title: "7 tests passed" },
    ]);

    const svelte = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: { cmd: "npx svelte-check --fail-on-warnings=false" },
    };
    expect(
      visualToolTestResultBadges(svelte, {
        type: "tool_result",
        text: "Chunk ID: s1\nWall time: 13.0000 seconds\nProcess exited with code 0\nOriginal token count: 10\nOutput:\nLoading svelte-check in workspace: /repo\nGetting Svelte diagnostics...\nsvelte-check found 0 errors and 13 warnings in 8 files",
      }),
    ).toEqual([
      { label: "⚠13", tone: "warning", title: "13 Svelte warnings" },
    ]);
    expect(
      visualToolTestResultBadges(svelte, {
        type: "tool_result",
        text: "Chunk ID: s2\nWall time: 13.0000 seconds\nProcess exited with code 0\nOriginal token count: 10\nOutput:\nsvelte-check found 0 errors and 0 warnings",
      }),
    ).toEqual([
      { label: "✓", tone: "success", title: "No Svelte diagnostics" },
    ]);
  });

  it("summarizes process cleanup commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "/bin/zsh -lc 'kill 60465 60466 60467 60475 || true'",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Stop processes 60465, 60466, 60467, 60475",
    );
    expect(visualToolCallPayloadText(block)).toContain(
      "kill 60465 60466 60467 60475",
    );
  });

  it("summarizes process inspection commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ps -axo pid,ppid,stat,etime,%cpu,%mem,command | rg 'run-three-matrix|playwright test --'",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      'Check processes for "run-three-matrix|playwright test --"',
    );
    expect(visualToolCallPayloadText(block)).toContain("ps -axo");
  });

  it("summarizes pgrep process inspection commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "pgrep -af 'ssh -N -L 45600:127.0.0.1:45600 felix-win' || true",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      'Check processes for "ssh -N -L 45600:127.0.0.1:45600 felix-win"',
    );
    expect(visualToolIconNameForPreview(block)).toBe("process_check");
    expect(visualToolCallPayloadText(block)).toContain("pgrep -af");
  });

  it("summarizes lsof port checks without hiding the raw command", () => {
    const processOnPort = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "lsof -ti tcp:5173 | xargs -r ps -o pid=,command= -p",
      },
    };
    const listeningPort = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "lsof -nP -iTCP:5254 -sTCP:LISTEN || true",
      },
    };
    const listenerScan = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "lsof -iTCP -sTCP:LISTEN -n -P | rg ':3001|:5173|:4173'",
      },
    };

    expect(visualToolPreviewText(processOnPort)).toBe("Check port 5173");
    expect(visualToolPreviewText(listeningPort)).toBe("Check port 5254");
    expect(visualToolPreviewText(listenerScan)).toBe(
      "Check ports 3001, 5173, 4173",
    );
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: 'lsof -nP -iTCP -sTCP:LISTEN | rg "5173|vite|node"',
        },
      }),
    ).toBe("Check listeners for 5173, vite, node");
    expect(visualToolCallPayloadText(processOnPort)).toContain(
      "lsof -ti tcp:5173",
    );
  });

  it("summarizes listener and log chains without setup sleeps", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "sleep 3; lsof -nP -iTCP:55173 -sTCP:LISTEN || true; tail -n 50 logs/cursor-labeler-vite-55173.log",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Check port 55173 · Read logs cursor-labeler-vite-55173.log last 50",
    );
    expect(visualToolCallPayloadText(block)).toContain("sleep 3; lsof");
  });

  it("summarizes tail log reads as log previews", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "tail -80 /tmp/usd-wg-assets-5173.log",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read logs usd-wg-assets-5173.log last 80",
    );
    expect(visualToolPreviewParts(block)).toContainEqual({
      kind: "path",
      text: "usd-wg-assets-5173.log",
      path: "/tmp/usd-wg-assets-5173.log",
      range: "",
    });
  });

  it("summarizes screen session listings", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "screen -ls | sed -n '1,80p'",
      },
    };

    expect(visualToolPreviewText(block)).toBe("List screen sessions");
    expect(visualToolIconNameForPreview(block)).toBe("list");
    expect(visualToolCallPayloadText(block)).toContain("screen -ls");
  });

  it("summarizes wc counts", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "wc -l packages/ui/src/SessionView.svelte packages/ui/src/VisualTranscript.svelte",
        },
      }),
    ).toBe("Count lines in SessionView.svelte, VisualTranscript.svelte");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "wc -c < bookmarklet.txt",
        },
      }),
    ).toBe("Count bytes in bookmarklet.txt");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "find submodules/glTF-Sample-Assets/Models -path '*/glTF-Binary/*.glb' | wc -l",
        },
      }),
    ).toBe("Count items in Models");
  });

  it("summarizes disk usage checks", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "du -sh full_assets/Kitchen_set full_assets/Kitchen_set_draco && du -ch full_assets/Kitchen_set/assets/**/*.geom.usd | tail -1",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Check size of Kitchen_set, Kitchen_set_draco, assets/**/*.geom.usd",
    );
    expect(visualToolPreviewParts(block)).toContainEqual({
      kind: "path",
      text: "Kitchen_set",
      path: "full_assets/Kitchen_set",
      range: "",
    });
  });

  it("summarizes jq JSON queries", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "jq '.scripts' package.json",
        },
      }),
    ).toBe("Query JSON package.json .scripts");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "cat package.json | jq '.scripts'",
        },
      }),
    ).toBe("Query JSON package.json .scripts");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "curl -fsS http://127.0.0.1:8765/api/health | jq '{status, config}'",
        },
      }),
    ).toBe("Query JSON 127.0.0.1:8765/api/health {status, config}");
  });

  it("summarizes awk text processing without hiding raw commands", () => {
    const direct = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "awk -F, '{print $1}' data/results.csv",
      },
    };
    const pipedFile = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "cat packages/ui/package.json | awk '/svelte/ {print $1}'",
      },
    };
    const pipedFetch = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "curl -fsS http://127.0.0.1:8765/metrics | awk '/http_requests/ {print $2}'",
      },
    };

    expect(visualToolPreviewText(direct)).toBe(
      "Process text in results.csv with awk {print $1}",
    );
    expect(visualToolPreviewParts(direct)).toContainEqual({
      kind: "path",
      text: "results.csv",
      path: "data/results.csv",
      range: "",
    });
    expect(visualToolPreviewText(pipedFile)).toBe(
      "Process text in ui/package.json with awk /svelte/ {print $1}",
    );
    expect(visualToolPreviewText(pipedFetch)).toBe(
      "Process text from 127.0.0.1:8765/metrics with awk /http_requests/ {print $2}",
    );
    expect(visualToolCallPayloadText(direct)).toContain("awk -F,");
  });

  it("summarizes Windows filesystem cleanup and creation commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "powershell -NoProfile -Command \"Remove-Item -Recurse -Force C:\\Users\\needle\\nextcloud-maik-test -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force C:\\Users\\needle\\nextcloud-maik-test\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Delete folder nextcloud-maik-test · Create folder nextcloud-maik-test",
    );
    expect(visualToolPreviewParts(block)).toEqual([
      { kind: "text", text: "Delete folder " },
      {
        kind: "path",
        text: "nextcloud-maik-test",
        path: "C:\\Users\\needle\\nextcloud-maik-test",
        range: "",
      },
      { kind: "text", text: " · " },
      { kind: "text", text: "Create folder " },
      {
        kind: "path",
        text: "nextcloud-maik-test",
        path: "C:\\Users\\needle\\nextcloud-maik-test",
        range: "",
      },
    ]);
    expect(visualToolCallPayloadText(block)).toContain("Remove-Item");
  });

  it("summarizes Unix filesystem cleanup and creation commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "rm -rf /tmp/supergit-test && mkdir -p /tmp/supergit-test && touch /tmp/supergit-test/ready.txt",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Delete folder supergit-test · Create folder supergit-test · Create file ready.txt",
    );
    expect(visualToolPreviewParts(block)).toContainEqual({
      kind: "path",
      text: "supergit-test",
      path: "/tmp/supergit-test",
      range: "",
    });
    expect(visualToolCommandResultBadges(block)).toEqual([
      {
        label: "3 paths",
        tone: "neutral",
        title: "3 paths touched",
      },
    ]);

    expect(
      visualToolCommandResultBadges({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: { cmd: "mkdir -p /tmp/one-folder" },
      }),
    ).toEqual([]);
  });

  it("ignores shell option setup when summarizing chained filesystem commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "set -euo pipefail; mkdir -p .git/info; exclude=.git/info/exclude; touch \"$exclude\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Create folder info · Create file $exclude",
    );
    expect(visualToolCallPayloadText(block)).toContain("set -euo pipefail");
  });

  it("summarizes file copy and move commands with file-count badges", () => {
    const copyBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: { cmd: "cp src/App.svelte /tmp/App.svelte" },
    };
    expect(visualToolPreviewText(copyBlock)).toBe(
      "Copy App.svelte -> App.svelte",
    );
    expect(visualToolCommandResultBadges(copyBlock)).toEqual([
      {
        label: "2 files",
        tone: "neutral",
        title: "2 files copied",
      },
    ]);

    const moveBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: { cmd: "mv old-name.ts new-name.ts" },
    };
    expect(visualToolPreviewText(moveBlock)).toBe(
      "Move old-name.ts -> new-name.ts",
    );
    expect(visualToolCommandResultBadges(moveBlock)).toEqual([
      {
        label: "2 files",
        tone: "neutral",
        title: "2 files moved",
      },
    ]);
  });

  it("keeps mkdir folder chips when a command chain has an image transform", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "mkdir -p tests/unit/fixtures/materialx-paths/renders && magick tests/unit/fixtures/materialx-paths/source.png tests/unit/fixtures/materialx-paths/renders/output.png",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Create folder renders · Convert image source.png -> output.png",
    );
    expect(visualToolPreviewParts(block)[1]).toEqual({
      kind: "path",
      text: "renders",
      path: "tests/unit/fixtures/materialx-paths/renders",
      range: "",
    });
  });

  it("summarizes image conversion commands with clickable input and output paths", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "magick /tmp/custom-nodedef-voronoi-2.png -crop 900x650+575+135 -resize 420x303 /tmp/custom-nodedef-voronoi-crop.png",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Convert image custom-nodedef-voronoi-2.png -> custom-nodedef-voronoi-crop.png",
    );
    expect(visualToolPreviewParts(block)).toEqual([
      { kind: "text", text: "Convert image " },
      {
        kind: "path",
        text: "custom-nodedef-voronoi-2.png",
        path: "/tmp/custom-nodedef-voronoi-2.png",
        range: "",
      },
      { kind: "text", text: " -> " },
      {
        kind: "path",
        text: "custom-nodedef-voronoi-crop.png",
        path: "/tmp/custom-nodedef-voronoi-crop.png",
        range: "",
      },
    ]);
    expect(visualToolCallPayloadText(block)).toContain("magick /tmp/custom");
  });

  it("summarizes screenshot and snapshot tools around their output files", () => {
    expect(
      visualToolIconNameForPreview({
        type: "tool_use",
        toolName: "take_screenshot",
        toolInput: {
          filePath: "/tmp/custom-nodedef-canvas.png",
        },
      }),
    ).toBe("take_screenshot");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "take_screenshot",
        toolInput: {
          uid: "3_34",
          filePath: "/tmp/custom-nodedef-canvas.png",
          format: "png",
        },
      }),
    ).toBe("Capture screenshot custom-nodedef-canvas.png");
    expect(
      visualToolPreviewParts({
        type: "tool_use",
        toolName: "take_screenshot",
        toolInput: {
          filePath: "/tmp/custom-nodedef-canvas.png",
        },
      }),
    ).toEqual([
      { kind: "text", text: "Capture screenshot " },
      {
        kind: "path",
        text: "custom-nodedef-canvas.png",
        path: "/tmp/custom-nodedef-canvas.png",
        range: "",
      },
    ]);
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "take_snapshot",
        toolInput: {
          verbose: true,
          filePath: "/tmp/snapshot.txt",
        },
      }),
    ).toBe("Capture snapshot snapshot.txt");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "view_image",
        toolInput: {
          path: "/tmp/custom-nodedef-canvas.png",
        },
      }),
    ).toBe("View image custom-nodedef-canvas.png");
  });

  it("summarizes browser click tools around the action instead of raw JSON", () => {
    const click = {
      type: "tool_use",
      toolName: "click",
      toolInput: {
        uid: "12_45",
        includeSnapshot: true,
      },
    };
    const doubleClick = {
      type: "tool_use",
      toolName: "click",
      toolInput: {
        uid: "12_45",
        dblClick: true,
      },
    };

    expect(visualToolPreviewText(click)).toBe("Click element 12_45");
    expect(visualToolPreviewText(doubleClick)).toBe("Double-click element 12_45");
    expect(visualToolIconNameForPreview(click)).toBe("click");
  });

  it("promotes image-producing tools to inline media blocks", () => {
    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "take_screenshot",
        toolUseId: "shot-1",
        toolInput: {
          uid: "3_34",
          filePath: "/tmp/custom-nodedef-canvas.png",
          format: "png",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/custom-nodedef-canvas.png",
        title: "Screenshot",
        toolName: "take_screenshot",
        toolUseId: "shot-1",
      }),
    ]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "take_snapshot",
        toolInput: {
          filePath: "/tmp/snapshot.txt",
        },
      }),
    ).toEqual([]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "view_image",
        toolInput: {
          path: "/tmp/custom-nodedef-canvas.png",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/custom-nodedef-canvas.png",
        title: "Image",
      }),
    ]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          workdir: "/Users/herbst/git/shapes",
          cmd: "magick input.png -crop 128x128 output.webp",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/Users/herbst/git/shapes/input.png",
        title: "Input image",
      }),
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/Users/herbst/git/shapes/output.webp",
        title: "Output image",
      }),
    ]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          workdir: "/Users/herbst/git/ml-sharp",
          cmd: "mkdir -p outputs/production-regression/interior-12 && cd outputs/production-regression/interior-12 && npx --yes agent-browser --session sharp-corpus upload source.png to @e20",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/Users/herbst/git/ml-sharp/outputs/production-regression/interior-12/source.png",
        title: "Uploaded image",
      }),
    ]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "exec_command",
        toolInput:
          'const result = await tools.exec_command({"cmd":"magick input.png output.webp","workdir":"/Users/herbst/git/shapes"});',
      }),
    ).toEqual([
      expect.objectContaining({
        path: "/Users/herbst/git/shapes/input.png",
        title: "Input image",
      }),
      expect.objectContaining({
        path: "/Users/herbst/git/shapes/output.webp",
        title: "Output image",
      }),
    ]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "ssh cloud-staging 'magick /tmp/input.png /tmp/output.webp'",
        },
      }),
    ).toEqual([]);

    expect(
      visualToolMediaBlocks({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "magick /tmp/custom-nodedef-voronoi-2.png -crop 900x650+575+13 -resize 420x300 /tmp/custom-nodedef-crop.webp",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/custom-nodedef-voronoi-2.png",
        title: "Input image",
      }),
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/custom-nodedef-crop.webp",
        title: "Output image",
      }),
    ]);

    expect(
      visualToolMediaBlocks(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolUseId: "browser-shot-1",
          toolInput: {
            cmd: "npx --yes agent-browser --session mlsharp screenshot /tmp/reference-view2.png",
          },
        },
        {
          type: "tool_result",
          toolUseId: "browser-shot-1",
          text: [
            "Chunk ID: 8185",
            "Wall time: 0.0000 seconds",
            "Process exited with code 0",
            "Output:",
            "✓ Screenshot saved to /tmp/reference-view2.png",
          ].join("\n"),
        },
      ),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/reference-view2.png",
        title: "Screenshot",
        toolName: "exec_command",
        toolUseId: "browser-shot-1",
      }),
    ]);

    expect(
      visualToolMediaBlocks(
        {
          type: "tool_use",
          toolName: "take_screenshot",
          toolUseId: "browser-shot-2",
          toolInput: {},
        },
        {
          type: "tool_result",
          toolUseId: "browser-shot-2",
          text: JSON.stringify({
            message: "Screenshot saved",
            filePath: "/tmp/devtools-shot.webp",
          }),
        },
      ),
    ).toEqual([
      expect.objectContaining({
        type: "media",
        mediaKind: "image",
        path: "/tmp/devtools-shot.webp",
        title: "Screenshot",
      }),
    ]);
  });

  it("summarizes curl fetch commands around the URL", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "curl -sS -D - -o /tmp/medikit-root.html --max-time 10 http://100.120.22.46:46100/medikit/auth/sign-in",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Fetch 100.120.22.46:46100/medikit/auth/sign-in to medikit-root.html",
    );
    expect(visualToolPreviewParts(block)).toEqual([
      { kind: "text", text: "Fetch " },
      { kind: "text", text: "100.120.22.46:46100/medikit/auth/sign-in" },
      { kind: "text", text: " to " },
      {
        kind: "path",
        text: "medikit-root.html",
        path: "/tmp/medikit-root.html",
        range: "",
      },
    ]);
    expect(visualToolCallPayloadText(block)).toContain("curl -sS");
  });

  it("summarizes curl retry loops as wait-for-url checks", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "for i in {1..30}; do curl -fsS http://100.120.22.46:18088/health && exit 0; sleep 2; done; exit 1",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Wait for 100.120.22.46:18088/health",
    );
    expect(visualToolCallPayloadText(block)).toContain("for i in {1..30}");
  });

  it("summarizes file loops over checker commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: 'for f in catmull_clark_cube.usda catmull_clark_facevarying_st.usda catmull_clark_lefthanded.usda; do usdchecker "$f"; done',
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Check USD files catmull_clark_cube.usda, catmull_clark_facevarying_st.usda, catmull_clark_lefthanded.usda",
    );
    expect(visualToolPreviewParts(block)).toContainEqual({
      kind: "path",
      text: "catmull_clark_cube.usda",
      path: "catmull_clark_cube.usda",
      range: "",
    });
    expect(visualPathPreviewTargets(["catmull_clark_cube.usda"])).toEqual([
      {
        kind: "path",
        text: "catmull_clark_cube.usda",
        path: "catmull_clark_cube.usda",
        range: "",
      },
    ]);
  });

  it("shows fetch result size and failures from paired command output", () => {
    const curl = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "curl -fsS https://example.com/status.json",
      },
    };

    expect(
      visualToolFetchResultBadges(curl, {
        type: "tool_result",
        text: "Chunk ID: c1\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\n{\"ok\":true}",
      }),
    ).toEqual([
      {
        label: "11 B",
        tone: "neutral",
        title: "11 bytes fetched",
      },
    ]);

    expect(
      visualToolFetchResultBadges(curl, {
        type: "tool_result",
        text: "Chunk ID: c2\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nHTTP/1.1 200 OK\ncontent-length: 1536\n\n",
      }),
    ).toEqual([
      {
        label: "1.5 KB",
        tone: "neutral",
        title: "1,536 bytes fetched",
      },
    ]);

    expect(
      visualToolFetchResultBadges(curl, {
        type: "tool_result",
        text: "Chunk ID: c3\nWall time: 0.1000 seconds\nProcess exited with code 22\nOriginal token count: 0\nOutput:",
      }),
    ).toEqual([
      {
        label: "exit 22",
        tone: "danger",
        title: "Fetch command failed",
      },
    ]);

    expect(
      visualToolFetchResultBadges(curl, {
        type: "tool_result",
        text: "Chunk ID: c4\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 0\nOutput:",
      }),
    ).toEqual([
      {
        label: "no result",
        tone: "danger",
        title: "Fetch command completed without visible response data",
      },
    ]);

    expect(
      visualToolFetchResultBadges(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: {
            cmd: "curl -fsS -o /tmp/status.json https://example.com/status.json",
          },
        },
        {
          type: "tool_result",
          text: "Chunk ID: c5\nWall time: 0.1000 seconds\nProcess exited with code 0\nOriginal token count: 0\nOutput:",
        },
      ),
    ).toEqual([]);
  });

  it("summarizes wget fetch commands", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "wget --timeout 5 https://example.com/status.json",
        },
      }),
    ).toBe("Fetch example.com/status.json");
  });

  it("lifts inline env assignments out of command previews", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "PORT=5199 npm run start",
      },
    };

    expect(visualToolPreviewText(block)).toBe("npm run start");
    expect(visualToolEnvSummaryLabel(block)).toBe("ENV");
    expect(visualToolEnvTooltipText(block)).toBe("PORT=5199");
    expect(visualToolEnvAssignments(block)).toEqual([
      { name: "PORT", value: "5199" },
    ]);
    expect(visualToolCallPayloadText(block)).toContain("PORT=5199");
  });

  it("lifts zsh-wrapped inline env assignments out of command previews", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "/bin/zsh -lc 'PORT=5199 VITE_HOST=0.0.0.0 npm run start'",
      },
    };

    expect(visualToolPreviewText(block)).toBe("npm run start");
    expect(visualToolLauncherLabel(block)).toBe("zsh");
    expect(visualToolEnvSummaryLabel(block)).toBe("ENV");
    expect(visualToolEnvTooltipText(block)).toBe(
      "PORT=5199\nVITE_HOST=0.0.0.0",
    );
    expect(visualToolEnvAssignments(block)).toEqual([
      { name: "PORT", value: "5199" },
      { name: "VITE_HOST", value: "0.0.0.0" },
    ]);
  });

  it("lifts exported inline env assignments out of command previews", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "export AGENT_BROWSER_SESSION=medikit-path-cookie-$(date +%s) npx --yes agent-browser open 'http://localhost:5173/medikit/auth/sign-in'",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Open browser localhost:5173/medikit/auth/sign-in",
    );
    expect(visualToolEnvSummaryLabel(block)).toBe("ENV");
    expect(visualToolEnvTooltipText(block)).toBe(
      "AGENT_BROWSER_SESSION=medikit-path-cookie-$(date +%s)",
    );
    expect(visualToolEnvAssignments(block)).toEqual([
      {
        name: "AGENT_BROWSER_SESSION",
        value: "medikit-path-cookie-$(date +%s)",
      },
    ]);
  });

  it("lifts env wrapper assignments out of chained command previews", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "mkdir -p thumbnails && env PXR_PLUGINPATH_NAME=/Users/herbst/OpenUSD-26.05-native/plugin/usd PYTHONPATH=/Users/herbst/OpenUSD-26.05-native/lib/python usdrecord --imageWidth 420 --camera Camera usd-wasm/tests/fixtures/custom_geomprops.usdshade.usda usd-wasm/tests/fixtures/thumbnails/custom.png",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Create folder thumbnails · usdrecord --imageWidth 420 --camera Camera usd-wasm/tests/fixtures/custom_geomprops.usdshade.usda usd-wasm/tests/fixtures/thumbnails/custom.png",
    );
    expect(visualToolEnvSummaryLabel(block)).toBe("ENV");
    expect(visualToolEnvAssignments(block)).toEqual([
      {
        name: "PXR_PLUGINPATH_NAME",
        value: "/Users/herbst/OpenUSD-26.05-native/plugin/usd",
      },
      {
        name: "PYTHONPATH",
        value: "/Users/herbst/OpenUSD-26.05-native/lib/python",
      },
    ]);
    expect(visualToolEnvTooltipText(block)).toBe(
      "PXR_PLUGINPATH_NAME=/Users/herbst/OpenUSD-26.05-native/plugin/usd\nPYTHONPATH=/Users/herbst/OpenUSD-26.05-native/lib/python",
    );
    expect(visualToolPreviewParts(block)[1]).toEqual({
      kind: "path",
      text: "thumbnails",
      path: "thumbnails",
      range: "",
    });
  });

  it("summarizes CMake configure commands and lifts flags into a compact badge", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/opt/homebrew -DABSL_PROPAGATE_CXX_STD=ON",
      },
    };

    expect(visualToolPreviewText(block)).toBe("Configure CMake . -> build");
    expect(visualToolConfigSummaryLabel(block)).toBe("6 FLAGS");
    expect(visualToolConfigTooltipText(block)).toBe(
      "SOURCE=.\nBUILD=build\nGENERATOR=Ninja\nCMAKE_BUILD_TYPE=Release\nCMAKE_PREFIX_PATH=/opt/homebrew\nABSL_PROPAGATE_CXX_STD=ON",
    );
    expect(visualToolConfigAssignments(block)).toEqual([
      { name: "SOURCE", value: "." },
      { name: "BUILD", value: "build" },
      { name: "GENERATOR", value: "Ninja" },
      { name: "CMAKE_BUILD_TYPE", value: "Release" },
      { name: "CMAKE_PREFIX_PATH", value: "/opt/homebrew" },
      { name: "ABSL_PROPAGATE_CXX_STD", value: "ON" },
    ]);
    expect(visualToolCallPayloadText(block)).toContain("cmake -S");
  });

  it("summarizes plain CMake build commands without configure flags", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "cmake --build build --target install",
      },
    };

    expect(visualToolPreviewText(block)).toBe("Build CMake build");
    expect(visualToolConfigAssignments(block)).toEqual([]);
  });

  it("summarizes agent-browser CLI commands as browser actions", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx agent-browser --session obj-debug console",
        },
      }),
    ).toBe("Check console messages");
    expect(
      visualToolIconNameForPreview({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx agent-browser --session obj-debug console",
        },
      }),
    ).toBe("list_console_messages");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx agent-browser --session obj-debug snapshot -i && npx agent-browser --session obj-debug console",
        },
      }),
    ).toBe("Capture browser snapshot (interactive) · Check console messages");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx agent-browser --session obj-debug click @e8 && npx agent-browser --session obj-debug snapshot -i",
        },
      }),
    ).toBe("Click browser element @e8 · Capture browser snapshot (interactive)");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx --yes agent-browser --session mlsharp upload @e20 /Users/herbst/Downloads/round_of_57/03_lanczos_4k/06.png && npx --yes agent-browser --session mlsharp snapshot -i",
        },
      }),
    ).toBe(
      "Upload 06.png to @e20 · Capture browser snapshot (interactive)",
    );
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx --yes agent-browser --session mlsharp wait 110000",
        },
      }),
    ).toBe("Wait for browser 110s");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "npx --yes agent-browser --session mlsharp get text body",
        },
      }),
    ).toBe("Read browser body text");
  });

  it("summarizes CMake configure commands after newline-separated setup", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "perl -pi -e 's#old#new#g' $(rg -l old src)\ncmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/opt/homebrew",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "perl -pi -e 's#old#new#g' $(rg -l old src) · Configure CMake . -> build",
    );
    expect(visualToolConfigSummaryLabel(block)).toBe("5 FLAGS");
  });

  it("normalizes ssh launch wrappers before previewing remote file reads", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "/bin/zsh -lc \"ssh -o BatchMode=yes -o ConnectTimeout=8 cloud-staging 'cd /data/coolify/applications/vk4800s4gookog480gc0g0s0 && sed -n '\\''1,40p'\\'' compose-pr-34.yaml'\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe("Read compose-pr-34.yaml:1-40");
    expect(visualToolPreviewParts(block)).toContainEqual({
      kind: "path",
      text: "compose-pr-34.yaml:1-40",
      path: "/data/coolify/applications/vk4800s4gookog480gc0g0s0/compose-pr-34.yaml",
      range: ":1-40",
    });
    expect(visualToolLauncherLabel(block)).toBe("zsh");
    expect(visualToolRemoteHostLabel(block)).toBe("cloud-staging");
    expect(visualToolCallPayloadText(block)).toContain("ssh -o BatchMode=yes");
  });

  it("summarizes ssh local tunnel commands", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ssh -N -L 45101:127.0.0.1:45100 felix-win",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Open tunnel localhost:45101 -> felix-win:45100",
    );
    expect(visualToolIconNameForPreview(block)).toBe("port_check");
    expect(visualToolCallPayloadText(block)).toContain(
      "ssh -N -L 45101:127.0.0.1:45100 felix-win",
    );

    const boundBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ssh -fN -L 0.0.0.0:45101:localhost:45100 user@felix-win",
      },
    };

    expect(visualToolPreviewText(boundBlock)).toBe(
      "Open tunnel *:45101 -> felix-win:45100",
    );
  });

  it("summarizes PowerShell file reads over ssh as remote path chips", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ssh felix-win 'cd /d E:\\git\\medikit && powershell -NoProfile -Command \"(Get-Content frontend\\src\\App.svelte -TotalCount 80)\"'",
      },
    };

    expect(visualToolPreviewText(block)).toBe("Read App.svelte:1-80");
    expect(visualToolRemoteHostLabel(block)).toBe("felix-win");
    expect(visualToolPreviewParts(block)).toContainEqual({
      kind: "path",
      text: "App.svelte:1-80",
      path: "E:\\git\\medikit\\frontend\\src\\App.svelte",
      range: ":1-80",
    });
  });

  it("summarizes PowerShell drive and directory inspection over ssh", () => {
    const drivesBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ssh felix-win 'Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize Name,Root,Used,Free'",
      },
    };
    expect(visualToolPreviewText(drivesBlock)).toBe("Check Windows drives");
    expect(visualToolRemoteHostLabel(drivesBlock)).toBe("felix-win");

    const directoriesBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ssh felix-win 'Get-ChildItem -Path C:\\,D:\\,E:\\ -Directory -ErrorAction SilentlyContinue | Select-Object FullName'",
      },
    };
    expect(visualToolPreviewText(directoriesBlock)).toBe(
      "Read directories C:, D:, E:",
    );
    expect(visualToolPreviewParts(directoriesBlock)).toContainEqual({
      kind: "path",
      text: "D:",
      path: "D:\\",
      range: "",
    });
    expect(visualToolRemoteHostLabel(directoriesBlock)).toBe("felix-win");
  });

  it("normalizes ssh launch wrappers before previewing remote searches", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ssh deploy@cloud-staging 'cd /srv/app && rg -n \"needle\" packages'",
      },
    };

    expect(visualToolPreviewText(block)).toBe('Search packages for "needle"');
    expect(visualToolRemoteHostLabel(block)).toBe("cloud-staging");
  });

  it("normalizes docker compose exec wrappers before previewing container reads", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "docker compose -f nextcloud/docker-compose.yaml exec -T nextcloud sh -lc \"cd /var/www/html && sed -n '450,525p' custom_apps/integration_openai/lib/Config.php\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe("Read Config.php:450-525");
    expect(visualToolRemoteHostLabel(block)).toBe("docker nextcloud");
  });

  it("normalizes docker exec wrappers before previewing container searches", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "docker exec -i coolify sh -lc \"grep -RIn 'tts_url' config\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe('Search config for "tts_url"');
    expect(visualToolRemoteHostLabel(block)).toBe("docker coolify");
  });

  it("summarizes Docker container checks and nearby container directory reads", () => {
    const checkBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' | rg 'open-webui|ollama'",
      },
    };

    expect(visualToolPreviewText(checkBlock)).toBe(
      'Check containers for "open-webui|ollama"',
    );
    expect(visualToolIconNameForPreview(checkBlock)).toBe("process_check");

    const readBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "docker exec fhir-patient-journey-open-webui-1 sh -lc 'cd /app/backend && ls -lah data && find data -maxdepth 2 -type f | sort'",
      },
    };

    expect(visualToolPreviewText(readBlock)).toBe("Read directory data");
    expect(visualToolRemoteHostLabel(readBlock)).toBe(
      "docker fhir-patient-journey-open-webui-1",
    );
    expect(visualToolPreviewParts(readBlock)).toContainEqual({
      kind: "path",
      text: "data",
      path: "/app/backend/data",
      range: "",
    });
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
      "Read hydra.d.ts:1-70, bindings.d.ts:35-60",
    );
  });

  it("keeps enough parent path when read filenames are ambiguous", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "sed -n '1,80p' src/routes/pageA/+page.svelte && sed -n '1,80p' src/routes/pageB/+page.svelte",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read pageA/+page.svelte:1-80, pageB/+page.svelte:1-80",
    );
    expect(visualToolPreviewParts(block)).toEqual([
      { kind: "text", text: "Read " },
      {
        kind: "path",
        text: "pageA/+page.svelte:1-80",
        path: "src/routes/pageA/+page.svelte",
        range: ":1-80",
      },
      { kind: "text", text: ", " },
      {
        kind: "path",
        text: "pageB/+page.svelte:1-80",
        path: "src/routes/pageB/+page.svelte",
        range: ":1-80",
      },
    ]);
  });

  it("keeps parent context for conventional filenames", () => {
    const skillRead = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "sed -n '1,220p' /Users/herbst/.agents/skills/agent-browser/SKILL.md",
      },
    };
    const routeRead = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "sed -n '1,90p' src/routes/dashboard/+page.svelte",
      },
    };
    const packageRead = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "cat packages/ui/package.json",
      },
    };

    expect(visualToolPreviewText(skillRead)).toBe(
      "Read agent-browser/SKILL.md:1-220",
    );
    expect(visualToolPreviewParts(skillRead)).toEqual([
      { kind: "text", text: "Read " },
      {
        kind: "path",
        text: "agent-browser/SKILL.md:1-220",
        path: "/Users/herbst/.agents/skills/agent-browser/SKILL.md",
        range: ":1-220",
      },
    ]);
    expect(visualToolPreviewText(routeRead)).toBe(
      "Read dashboard/+page.svelte:1-90",
    );
    expect(visualToolPreviewText(packageRead)).toBe("Read ui/package.json");
  });

  it("summarizes mixed read and search chains without hiding the raw command", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "sed -n '1,90p' src/conversionFamilies.ts && rg -n \"needle-engine-usdc|geometryBackend\"",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      'Read conversionFamilies.ts:1-90 · Search for "needle-engine-usdc|geometryBackend"',
    );
    expect(visualToolPreviewParts(block)).toEqual([
      { kind: "text", text: "Read " },
      {
        kind: "path",
        text: "conversionFamilies.ts:1-90",
        path: "src/conversionFamilies.ts",
        range: ":1-90",
      },
      { kind: "text", text: " · " },
      { kind: "text", text: 'Search ' },
      { kind: "text", text: 'for "needle-engine-usdc|geometryBackend"' },
    ]);
    expect(visualToolCallPayloadText(block)).toContain("sed -n");
  });

  it("shows visible result counts for search commands with paired output", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "rg -n \"get(By|AllBy|queryBy)(Text|Role).*name:\" packages/ui/test",
      },
    };
    const result = {
      type: "tool_result",
      toolName: "exec_command",
      text: [
        "Chunk ID: abc123 Wall time: 0.1000 seconds Process exited with code 0 Original token count: 12 Output:",
        "packages/ui/test/a.test.ts:12:expect(getByRole('button', { name: 'Save' }))",
        "packages/ui/test/b.test.ts:44:expect(queryByText('Done'))",
        "",
      ].join("\n"),
    };

    expect(visualToolPreviewText(block)).toBe(
      'Search test for "get(By|AllBy|queryBy)(Text|Role).*name:"',
    );
    expect(visualToolCommandResultBadges(block, result)).toEqual([
      {
        label: "2 results",
        tone: "neutral",
        title: "2 visible search results",
      },
    ]);
  });

  it("shows no results for successful empty search output", () => {
    expect(
      visualToolCommandResultBadges(
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: { cmd: "rg -n \"missing\" src" },
        },
        {
          type: "tool_result",
          toolName: "exec_command",
          text: "Chunk ID: abc123 Wall time: 0.1000 seconds Process exited with code 0 Original token count: 0 Output:",
        },
      ),
    ).toEqual([
      {
        label: "no results",
        tone: "neutral",
        title: "Search returned no visible result lines",
      },
    ]);
  });

  it("ignores label-only print commands between read summaries", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "printf '%s\\n' '--- ml-sharp root ---'; sed -n '1,80p' README.md; printf '%s\\n' '--- instructions ---'; sed -n '1,120p' AGENTS.md",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read README.md:1-80, AGENTS.md:1-120",
    );
    expect(visualToolCallPayloadText(block)).toContain("printf");
  });

  it("ignores setup ls commands before read summaries", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "ls scripts && sed -n '1,240p' scripts/analyze_conversions.py",
        },
      }),
    ).toBe("Read analyze_conversions.py:1-240");
  });

  it("summarizes find commands with name patterns", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "find /Users/herbst/OpenUSD-26.05-native -maxdepth 3 -type f \\( -name '*.py' -o -name '*.h' \\)",
        },
      }),
    ).toBe("Find *.py, *.h in OpenUSD-26.05-native");
    expect(
      visualToolPreviewParts({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "find /Users/herbst/OpenUSD-26.05-native -maxdepth 3 -type f \\( -name '*.py' -o -name '*.h' \\)",
        },
      }),
    ).toEqual([
      { kind: "text", text: "Find *.py, *.h in " },
      {
        kind: "path",
        text: "OpenUSD-26.05-native",
        path: "/Users/herbst/OpenUSD-26.05-native",
        range: "",
      },
    ]);
  });

  it("summarizes directory inspection chains", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: "ls -lah && find . -maxdepth 2 -type f | sort",
        },
      }),
    ).toBe("Read directory .");

    const filesBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "ls -l usd-wasm/.cache/usd-three-matrix-status.json usd-wasm/tests/three-matrix/THREE-MATRIX.md",
      },
    };
    expect(visualToolPreviewText(filesBlock)).toBe(
      "Read usd-three-matrix-status.json, THREE-MATRIX.md",
    );
    expect(visualToolPreviewParts(filesBlock)).toContainEqual({
      kind: "path",
      text: "usd-three-matrix-status.json",
      path: "usd-wasm/.cache/usd-three-matrix-status.json",
      range: "",
    });
  });

  it("surfaces inline scripts separately from the raw tool payload", () => {
    const heredocBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "python3 - <<'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY",
      },
    };

    expect(visualToolPreviewText(heredocBlock)).toBe(
      "import json print(json.dumps({'ok': True}))",
    );
    expect(visualToolInlineScriptLanguageLabel(heredocBlock)).toBe("Python");
    expect(visualToolInlineScriptPreviewText(heredocBlock)).toBe(
      "import json print(json.dumps({'ok': True}))",
    );
    expect(visualToolInlineScript(heredocBlock)).toEqual({
      language: "python",
      title: "Python script",
      code: "import json\nprint(json.dumps({'ok': True}))",
    });
    expect(visualToolCallPayloadText(heredocBlock)).toContain("python3 -");

    const sameLineHeredocBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "TMPDIR=/tmp node <<NODE import { mkdtempSync } from 'node:fs';\nconsole.log(mkdtempSync('treetop-'));\nNODE",
      },
    };
    expect(visualToolPreviewText(sameLineHeredocBlock)).toBe(
      "import { mkdtempSync } from 'node:fs'; console.log(mkdtempSync('treetop-'));",
    );
    expect(visualToolInlineScriptLanguageLabel(sameLineHeredocBlock)).toBe(
      "JavaScript",
    );
    expect(visualToolInlineScript(sameLineHeredocBlock)).toEqual({
      language: "js",
      title: "JavaScript script",
      code: "import { mkdtempSync } from 'node:fs';\nconsole.log(mkdtempSync('treetop-'));",
    });
    expect(visualToolEnvSummaryLabel(sameLineHeredocBlock)).toBe("ENV");

    const evalBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "node -e \"const fs = require('fs'); console.log(fs.existsSync('package.json'));\"",
      },
    };
    expect(visualToolPreviewText(evalBlock)).toBe(
      "const fs = require('fs'); console.log(fs.existsSync('package.json'));",
    );
    expect(visualToolInlineScriptLanguageLabel(evalBlock)).toBe("JavaScript");
    expect(visualToolInlineScript(evalBlock)).toEqual({
      language: "js",
      title: "JavaScript script",
      code: "const fs = require('fs');\nconsole.log(fs.existsSync('package.json'));",
    });

    const directScriptBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "node .codex/skills/session-understanding/scripts/scan-agent-sessions.mjs --days 1 --limit 30",
      },
    };
    expect(visualToolInlineScriptLanguageLabel(directScriptBlock)).toBe(
      "JavaScript",
    );
    expect(visualToolInlineScript(directScriptBlock)).toBeUndefined();
    expect(visualToolPreviewText(directScriptBlock)).toBe(
      "scan-agent-sessions.mjs --days 1 --limit 30",
    );
    expect(visualToolPreviewParts(directScriptBlock)).toEqual([
      {
        kind: "path",
        text: "scan-agent-sessions.mjs",
        path: ".codex/skills/session-understanding/scripts/scan-agent-sessions.mjs",
        range: "",
      },
      { kind: "text", text: " --days 1 --limit 30" },
    ]);
  });

  it("summarizes browser tool calls and formats evaluate_script functions", () => {
    const scriptBlock = {
      type: "tool_use",
      toolName: "evaluate_script",
      toolInput: {
        function:
          "async () => {\n  const wait = (ms) => new Promise((r) => setTimeout(r, ms));\n  await wait(50);\n  return document.title;\n}",
      },
    };

    expect(visualToolPreviewText(scriptBlock)).toBe(
      "async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); await wait(50); return document.title; }",
    );
    expect(visualToolInlineScriptLanguageLabel(scriptBlock)).toBe("JavaScript");
    expect(visualToolInlineScript(scriptBlock)).toEqual({
      language: "js",
      title: "JavaScript script",
      code: "async () => {\n  const wait = (ms) => new Promise((r) => setTimeout(r, ms));\n  await wait(50);\n  return document.title;\n}",
    });
    expect(visualToolCallPayloadText(scriptBlock)).toContain(
      '"function": "async () =>',
    );

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "navigate_page",
        toolInput: {
          type: "url",
          url: "http://127.0.0.1:5173/?host=three&model=Gingerbread",
        },
      }),
    ).toBe("Navigate to http://127.0.0.1:5173/?host=three&model=Gingerbread");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "navigate_page",
        toolInput: {
          type: "reload",
        },
      }),
    ).toBe("Reload page");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "list_console_messages",
        toolInput: {
          pageSize: 200,
          types: ["warn", "error"],
        },
      }),
    ).toBe("Check console for warnings and errors");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "list_console_messages",
        toolInput: {
          pageSize: 100,
        },
      }),
    ).toBe("Check console messages");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "list_network_requests",
        toolInput: {
          pageSize: 120,
          resourceTypes: ["document", "fetch", "xhr"],
        },
      }),
    ).toBe("Check network requests for documents, fetch, and XHR");
    expect(
      visualToolIconNameForPreview({
        type: "tool_use",
        toolName: "list_network_requests",
        toolInput: {
          resourceTypes: ["fetch"],
        },
      }),
    ).toBe("list_network_requests");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "wait_for",
        toolInput: {
          text: ["Environment", "File", "Select or Drop File"],
        },
      }),
    ).toBe("Wait for Environment, File, Select or Drop File");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "list_pages",
        toolInput: {},
      }),
    ).toBe("List browser pages");
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "emulate",
        toolInput: {
          networkConditions: "Slow 3G",
        },
      }),
    ).toBe("Emulate Slow 3G");
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
      'Search src for "GetStage()"',
    );
    expect(visualToolCallPayloadText(block)).toContain("rg -n");
  });

  it("normalizes Windows command launch wrappers before previewing commands", () => {
    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "exec_command",
        toolInput: {
          cmd: 'powershell.exe -NoProfile -Command "rg -n \\"GetStage\\(\\)\\" usd-wasm/src"',
        },
      }),
    ).toBe('Search src for "GetStage()"');

    const cmdBlock = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: 'cmd.exe /d /s /c "type packages\\ui\\src\\last-user-message.ts"',
      },
    };
    expect(visualToolPreviewText(cmdBlock)).toBe(
      "Read last-user-message.ts",
    );
    expect(visualToolLauncherLabel(cmdBlock)).toBe("cmd");
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
      "Read projectModel.js:414-424",
    );
    expect(visualToolCallPayloadText(block)).toContain("nl -ba");
  });

  it("summarizes numbered line reads with multiple sed ranges", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "nl -ba pxr/imaging/hdSt/mesh.cpp | sed -n '520,690p;2484,2507p;2633,2668p;2708,2763p;2844,2887p'",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read mesh.cpp:520-690, mesh.cpp:2484-2507, mesh.cpp:2633-2668, mesh.cpp:2708-2763, mesh.cpp:2844-2887",
    );
    expect(visualToolCallPayloadText(block)).toContain("nl -ba");
  });

  it("summarizes chained numbered line reads piped through sed", () => {
    const block = {
      type: "tool_use",
      toolName: "exec_command",
      toolInput: {
        cmd: "nl -ba /Users/herbst/git/three.js/examples/jsm/transpiler/Transpiler.js | sed -n '1,90p'; nl -ba /Users/herbst/git/three.js/examples/jsm/transpiler/ShaderToyDecoder.js | sed -n '20,80p'",
      },
    };

    expect(visualToolPreviewText(block)).toBe(
      "Read Transpiler.js:1-90, ShaderToyDecoder.js:20-80",
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
    ).toBe("Read VisualTranscript.svelte:100-150");

    expect(
      visualToolPreviewText({
        type: "tool_use",
        toolName: "Grep",
        toolInput: {
          pattern: "visualToolPreviewText",
          path: "packages/ui/src",
        },
      }),
    ).toBe('Search src for "visualToolPreviewText"');
  });
});

describe("buildVisualWorkDisplayEntries", () => {
  it("collapses an adjacent tool result into its tool use", () => {
    const toolUse = {
      message: {
        role: "assistant",
        blocks: [
          { type: "tool_use", text: "exec_command", toolUseId: "call-1" },
        ],
      },
      blocks: [{ type: "tool_use", text: "exec_command", toolUseId: "call-1" }],
      messageIndex: 1,
    };
    const toolResult = {
      message: {
        role: "tool",
        blocks: [
          { type: "tool_result", text: "tests passed", toolUseId: "call-1" },
        ],
      },
      blocks: [
        { type: "tool_result", text: "tests passed", toolUseId: "call-1" },
      ],
      messageIndex: 2,
    };

    const entries = buildVisualWorkDisplayEntries([toolUse, toolResult]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toBe(toolUse);
    expect(entries[0]?.pairedResult).toBe(toolResult);
  });

  it("shows read-log output at the result point without a duplicate poll-start row", () => {
    const toolUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "write_stdin",
            toolUseId: "call-1",
            toolInput: { session_id: 55249, chars: "" },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "write_stdin",
          toolUseId: "call-1",
          toolInput: { session_id: 55249, chars: "" },
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
            toolName: "write_stdin",
            toolUseId: "call-1",
            text: "Chunk ID: 07acea\nWall time: 30.0019 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n500/700\n",
          },
        ],
      },
      blocks: [
        {
          type: "tool_result",
          toolName: "write_stdin",
          toolUseId: "call-1",
          text: "Chunk ID: 07acea\nWall time: 30.0019 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n500/700\n",
        },
      ],
      messageIndex: 2,
    };

    const entries = buildVisualWorkDisplayEntries([toolUse, toolResult]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toBe(toolResult);
    expect(entries[0]?.pairedToolUse).toBe(toolUse);
  });

  it("keeps write_stdin starts visible until read-log output arrives", () => {
    const toolUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "write_stdin",
            toolUseId: "call-1",
            toolInput: { session_id: 55249, chars: "" },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "write_stdin",
          toolUseId: "call-1",
          toolInput: { session_id: 55249, chars: "" },
        },
      ],
      messageIndex: 1,
    };

    const entries = buildVisualWorkDisplayEntries([toolUse]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toBe(toolUse);
    expect(entries[0]?.pairedResult).toBeUndefined();
  });

  it("attributes grouped tool results back to their tool use ids", () => {
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

    expect(entries).toHaveLength(3);
    expect(entries[0]?.entry).toBe(firstToolUse);
    expect(entries[0]?.pairedResult).toBe(firstResult);
    expect(entries[1]?.entry).toBe(secondToolUse);
    expect(entries[1]?.pairedResult).toBe(secondResult);
    expect(entries[2]?.entry).toBe(firstResult);
    expect(entries[2]?.pairedToolUse).toBe(firstToolUse);
  });

  it("uses running process log reads to show live test counters", () => {
    const testToolUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolUseId: "test-call",
            toolInput: { cmd: "npm run test:assets" },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "exec_command",
          toolUseId: "test-call",
          toolInput: { cmd: "npm run test:assets" },
        },
      ],
      messageIndex: 1,
    };
    const runningResult = {
      message: {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            toolUseId: "test-call",
            text: "Chunk ID: run\nWall time: 52.0000 seconds\nProcess running with session ID 55249\nOriginal token count: 1\nOutput:\nstarting\n",
          },
        ],
      },
      blocks: [
        {
          type: "tool_result",
          toolUseId: "test-call",
          text: "Chunk ID: run\nWall time: 52.0000 seconds\nProcess running with session ID 55249\nOriginal token count: 1\nOutput:\nstarting\n",
        },
      ],
      messageIndex: 2,
    };
    const pollUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "write_stdin",
            toolUseId: "poll-call",
            toolInput: { session_id: 55249, chars: "" },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "write_stdin",
          toolUseId: "poll-call",
          toolInput: { session_id: 55249, chars: "" },
        },
      ],
      messageIndex: 3,
    };
    const pollResult = {
      message: {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            toolUseId: "poll-call",
            text: "Chunk ID: poll\nWall time: 5.0000 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n(pass) loads assets\n(pass) renders thumbnail\nWarnings 1\n",
          },
        ],
      },
      blocks: [
        {
          type: "tool_result",
          toolUseId: "poll-call",
          text: "Chunk ID: poll\nWall time: 5.0000 seconds\nProcess running with session ID 55249\nOriginal token count: 2\nOutput:\n(pass) loads assets\n(pass) renders thumbnail\nWarnings 1\n",
        },
      ],
      messageIndex: 4,
    };

    const entries = buildVisualWorkDisplayEntries([
      testToolUse,
      runningResult,
      pollUse,
      pollResult,
    ]);
    const observed = visualObservedProcessOutput(
      pollUse.blocks[0],
      pollResult.blocks[0],
    );
    const owner = visualObservedProcessOwnerToolUseBlock(entries, observed);

    expect(owner).toBe(testToolUse.blocks[0]);
    expect(visualToolTestResultBadges(owner, pollResult.blocks[0])).toEqual([
      { label: "⚠1", tone: "warning", title: "1 warning" },
      { label: "✓2", tone: "success", title: "2 tests passed" },
    ]);
  });

  it("carries a paired tool use name onto sparse delayed tool results", () => {
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
    const interveningNote = {
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "still checking" }],
      },
      blocks: [{ type: "text", text: "still checking" }],
      messageIndex: 2,
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
      messageIndex: 3,
    };

    const entries = buildVisualWorkDisplayEntries([
      toolUse,
      interveningNote,
      toolResult,
    ]);

    expect(entries[2]?.entry.blocks[0]).toMatchObject({
      type: "tool_result",
      toolName: "exec_command",
      toolUseId: "call-1",
    });
    expect(entries[2]?.pairedToolUse).toBe(toolUse);
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

  it("resolves Chrome DevTools click UIDs from the latest preceding snapshot", () => {
    const snapshotUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "take_snapshot",
            toolUseId: "snap-1",
            toolInput: { verbose: false },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "take_snapshot",
          toolUseId: "snap-1",
          toolInput: { verbose: false },
        },
      ],
      messageIndex: 1,
    };
    const snapshotResult = {
      message: {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            toolName: "take_snapshot",
            toolUseId: "snap-1",
            text: [
              "## Latest page snapshot",
              'uid=3_0 RootWebArea "Demo app"',
              '  uid=3_12 button "Play" description="Start playback"',
              '  uid=3_13 tab "Settings" selectable',
            ].join("\n"),
          },
        ],
      },
      blocks: [
        {
          type: "tool_result",
          toolName: "take_snapshot",
          toolUseId: "snap-1",
          text: [
            "## Latest page snapshot",
            'uid=3_0 RootWebArea "Demo app"',
            '  uid=3_12 button "Play" description="Start playback"',
            '  uid=3_13 tab "Settings" selectable',
          ].join("\n"),
        },
      ],
      messageIndex: 2,
    };
    const clickUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "click",
            toolInput: { uid: "3_12", includeSnapshot: true },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "click",
          toolInput: { uid: "3_12", includeSnapshot: true },
        },
      ],
      messageIndex: 3,
    };
    const doubleClickUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "click",
            toolInput: { uid: "3_13", dblClick: true },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "click",
          toolInput: { uid: "3_13", dblClick: true },
        },
      ],
      messageIndex: 4,
    };

    const entries = buildVisualWorkDisplayEntries([
      snapshotUse,
      snapshotResult,
      clickUse,
      doubleClickUse,
    ]);

    const clickBlock = entries[1]?.entry.blocks[0];
    const doubleClickBlock = entries[2]?.entry.blocks[0];
    expect(visualToolPreviewText(clickBlock)).toBe("Click element 3_12");
    expect(
      visualToolPreviewText(clickBlock, entries[1]?.previewContext),
    ).toBe("Click button Play");
    expect(
      visualToolPreviewText(doubleClickBlock, entries[2]?.previewContext),
    ).toBe("Double-click tab Settings");
  });

  it("resolves agent-browser refs from the latest preceding snapshot", () => {
    const snapshotUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolUseId: "snap-1",
            toolInput: {
              cmd: "npx --yes agent-browser --session mlsharp snapshot -i",
            },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "exec_command",
          toolUseId: "snap-1",
          toolInput: {
            cmd: "npx --yes agent-browser --session mlsharp snapshot -i",
          },
        },
      ],
      messageIndex: 1,
    };
    const snapshotResult = {
      message: {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            toolName: "exec_command",
            toolUseId: "snap-1",
            text: [
              "@e18 [heading] \"Upload source files\"",
              "@e20 [button] \"Select image\"",
              "@e21 [input] \"Caption\"",
            ].join("\n"),
          },
        ],
      },
      blocks: [
        {
          type: "tool_result",
          toolName: "exec_command",
          toolUseId: "snap-1",
          text: [
            "@e18 [heading] \"Upload source files\"",
            "@e20 [button] \"Select image\"",
            "@e21 [input] \"Caption\"",
          ].join("\n"),
        },
      ],
      messageIndex: 2,
    };
    const uploadUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolInput: {
              cmd: "npx --yes agent-browser --session mlsharp upload @e20 /Users/herbst/Downloads/06.png",
            },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: {
            cmd: "npx --yes agent-browser --session mlsharp upload @e20 /Users/herbst/Downloads/06.png",
          },
        },
      ],
      messageIndex: 3,
    };
    const fillUse = {
      message: {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolInput: {
              cmd: "npx --yes agent-browser --session mlsharp fill @e21 hello",
            },
          },
        ],
      },
      blocks: [
        {
          type: "tool_use",
          toolName: "exec_command",
          toolInput: {
            cmd: "npx --yes agent-browser --session mlsharp fill @e21 hello",
          },
        },
      ],
      messageIndex: 4,
    };

    const entries = buildVisualWorkDisplayEntries([
      snapshotUse,
      snapshotResult,
      uploadUse,
      fillUse,
    ]);

    const uploadBlock = entries[1]?.entry.blocks[0];
    const fillBlock = entries[2]?.entry.blocks[0];
    expect(
      visualToolPreviewText(uploadBlock, entries[1]?.previewContext),
    ).toBe("Upload 06.png to button Select image");
    expect(visualToolPreviewText(fillBlock, entries[2]?.previewContext)).toBe(
      "Fill browser element input Caption",
    );
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
  it("totals file edit stats for compact edit rows", () => {
    expect(
      visualFileEditCountBadge({
        title: "Edited 2 files",
        files: [
          { path: "src/App.svelte", action: "edited" },
          { path: "src/routes/+page.svelte", action: "edited" },
        ],
      }),
    ).toEqual({
      label: "2 files",
      tone: "neutral",
      title: "2 files edited",
    });
    expect(
      visualFileEditCountBadge({
        title: "Edited App.svelte",
        files: [{ path: "src/App.svelte", action: "edited" }],
      }),
    ).toBeUndefined();

    expect(
      visualFileEditTotals({
        title: "Edited authz.test.ts",
        files: [
          {
            path: "authz.test.ts",
            action: "edited",
            additions: 21,
            deletions: 0,
          },
        ],
      }),
    ).toEqual({ additions: 21, deletions: 0 });

    expect(
      visualFileEditTotals({
        title: "Edited generated.ts",
        files: [{ path: "generated.ts", action: "edited" }],
      }),
    ).toEqual({});
  });

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
