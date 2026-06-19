import { describe, it, expect } from "bun:test";
import {
  buildVisualWorkDisplayEntries,
  buildVisualTranscriptItems,
  cleanVisualUserText,
  cleanVisualToolResultText,
  lastUserMessageBurst,
  lastUserMessageWithContext,
  visualFileEditSummaryForBlock,
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

  it("keeps ordinary text unchanged", () => {
    expect(cleanVisualUserText("please keep this")).toBe("please keep this");
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

    expect(items.map((item) => item.kind)).toEqual(["message", "message"]);
    expect(items[1]).toMatchObject({
      kind: "message",
      blocks: [{ type: "thinking", text: "working" }],
    });
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

  it("leaves ordinary tool results alone", () => {
    expect(cleanVisualToolResultText("tests passed")).toEqual({
      title: "Tool result",
      body: "tests passed",
      wrappedCodexChunk: false,
    });
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
