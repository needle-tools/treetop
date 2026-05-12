import { test, expect, describe } from "bun:test";
import {
  parseClaudeJsonl,
  parseCodexJsonl,
  splitInjectedTags,
  isMarker,
} from "../src/sessions";

describe("parseClaudeJsonl", () => {
  test("returns an empty session for empty input", () => {
    const s = parseClaudeJsonl("");
    expect(s.agent).toBe("claude");
    expect(s.messages).toEqual([]);
  });

  test("picks up cwd and sessionId from the first event that has them", () => {
    const text = [
      JSON.stringify({ type: "summary", summary: "x" }),
      JSON.stringify({
        type: "user",
        cwd: "/Users/me/repo",
        sessionId: "S-1",
        message: { role: "user", content: "hi" },
      }),
    ].join("\n");
    const s = parseClaudeJsonl(text);
    expect(s.cwd).toBe("/Users/me/repo");
    expect(s.sessionId).toBe("S-1");
  });

  test("converts string content to a single text block", () => {
    const text = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello world" },
      timestamp: "2026-05-12T01:00:00Z",
      uuid: "u-1",
    });
    const s = parseClaudeJsonl(text);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[0]?.blocks).toEqual([
      { type: "text", text: "hello world" },
    ]);
    expect(s.messages[0]?.timestamp).toBe("2026-05-12T01:00:00Z");
    expect(s.messages[0]?.id).toBe("u-1");
    expect(s.startedAt).toBe("2026-05-12T01:00:00Z");
    expect(s.endedAt).toBe("2026-05-12T01:00:00Z");
  });

  test("normalises an assistant message with text + tool_use", () => {
    const text = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "ok, running tests" },
          {
            type: "tool_use",
            id: "tu-1",
            name: "Bash",
            input: { command: "bun test" },
          },
        ],
      },
    });
    const s = parseClaudeJsonl(text);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("assistant");
    expect(s.messages[0]?.blocks).toEqual([
      { type: "text", text: "ok, running tests" },
      {
        type: "tool_use",
        toolName: "Bash",
        toolInput: { command: "bun test" },
        toolUseId: "tu-1",
      },
    ]);
  });

  test("renders tool_result both for string and structured content", () => {
    const stringForm = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "1 file changed" },
        ],
      },
    });
    const arrayForm = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-2",
            content: [{ type: "text", text: "line a" }, { type: "text", text: "line b" }],
          },
        ],
      },
    });
    const a = parseClaudeJsonl(stringForm);
    expect(a.messages[0]?.blocks[0]).toEqual({
      type: "tool_result",
      text: "1 file changed",
      toolUseId: "tu-1",
    });
    const b = parseClaudeJsonl(arrayForm);
    expect(b.messages[0]?.blocks[0]).toEqual({
      type: "tool_result",
      text: "line a\nline b",
      toolUseId: "tu-2",
    });
  });

  test("relabels role=user messages that only contain tool_result blocks as 'tool'", () => {
    // Anthropic's API convention: tool results are sent back to the model
    // as user-role messages. Claude Code writes those into the JSONL with
    // type=user. They are *not* actual user turns and must not be rendered
    // as "user" in the UI.
    const toolResultLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "exit code 0" },
        ],
      },
    });
    const userLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: "please run the tests" },
    });
    const session = parseClaudeJsonl([userLine, toolResultLine].join("\n"));
    expect(session.messages.map((m) => m.role)).toEqual(["user", "tool"]);
  });

  test("a user message that mixes real text with a tool_result stays 'user'", () => {
    // We only flip to "tool" when *every* block is a tool_result. A mixed
    // message (real user text plus an attached tool_result, rare but
    // possible) should keep role=user so the user's words aren't hidden.
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
          { type: "text", text: "ah and one more thing" },
        ],
      },
    });
    const session = parseClaudeJsonl(line);
    expect(session.messages[0]?.role).toBe("user");
  });

  test("skips lines that don't parse as JSON", () => {
    const text = ["not json", "{\"type\":\"summary\"}", JSON.stringify({
      type: "user",
      message: { role: "user", content: "ok" },
    })].join("\n");
    const s = parseClaudeJsonl(text);
    expect(s.messages).toHaveLength(1);
  });

  test("ignores summary and unknown types", () => {
    const text = [
      JSON.stringify({ type: "summary", summary: "x" }),
      JSON.stringify({ type: "system", message: { role: "system", content: "y" } }),
    ].join("\n");
    expect(parseClaudeJsonl(text).messages).toEqual([]);
  });
});

describe("splitInjectedTags", () => {
  test("plain text returns a single text block", () => {
    expect(splitInjectedTags("just a normal message")).toEqual([
      { type: "text", text: "just a normal message" },
    ]);
  });

  test("ide_opened_file becomes an ide_context block", () => {
    const blocks = splitInjectedTags(
      "<ide_opened_file>The user opened /a/b/c.ts in the IDE.</ide_opened_file>",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("ide_context");
    expect(blocks[0]?.tagName).toBe("ide_opened_file");
    expect(blocks[0]?.text).toContain("/a/b/c.ts");
  });

  test("system-reminder becomes a system_reminder block", () => {
    const blocks = splitInjectedTags(
      "<system-reminder>budget low</system-reminder>",
    );
    expect(blocks[0]?.type).toBe("system_reminder");
    expect(blocks[0]?.tagName).toBe("system-reminder");
  });

  test("command-name / command-stdout become command blocks", () => {
    const blocks = splitInjectedTags(
      "<command-name>/help</command-name>\n<local-command-stdout>foo</local-command-stdout>",
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("command");
    expect(blocks[1]?.type).toBe("command");
  });

  test("splits mixed plain text + injected tags in order", () => {
    const input =
      "Hi there.\n<ide_opened_file>opened foo.ts</ide_opened_file>\nPlease implement X.";
    const blocks = splitInjectedTags(input);
    expect(blocks.map((b) => b.type)).toEqual([
      "text",
      "ide_context",
      "text",
    ]);
    expect(blocks[0]?.text).toBe("Hi there.");
    expect(blocks[2]?.text).toBe("Please implement X.");
  });

  test("Claude parser splits ide_opened_file out of user text content", () => {
    const text = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "Please do X.\n<ide_opened_file>opened src/foo.ts</ide_opened_file>",
      },
    });
    const session = parseClaudeJsonl(text);
    expect(session.messages[0]?.blocks.map((b) => b.type)).toEqual([
      "text",
      "ide_context",
    ]);
  });
});

describe("parseClaudeJsonl with a real sanitized fixture", () => {
  test("handles a 13-line session without throwing and produces valid blocks", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(
      import.meta.dir,
      "fixtures",
      "claude-real-sample.jsonl",
    );
    const raw = await readFile(path, "utf-8");
    const session = parseClaudeJsonl(raw);

    expect(session.agent).toBe("claude");
    expect(session.cwd).toBe("/Users/test/repo");
    expect(session.sessionId).toBe("00000000-0000-0000-0000-000000000000");
    expect(session.messages.length).toBeGreaterThan(0);

    const allowedRoles = new Set([
      "user",
      "assistant",
      "system",
      "tool",
    ] as const);
    const allowedBlocks = new Set([
      "text",
      "thinking",
      "tool_use",
      "tool_result",
      "ide_context",
      "system_reminder",
      "command",
    ] as const);
    for (const m of session.messages) {
      expect(allowedRoles.has(m.role)).toBe(true);
      expect(m.blocks.length).toBeGreaterThan(0);
      for (const b of m.blocks) {
        expect(allowedBlocks.has(b.type as never)).toBe(true);
      }
    }

    // The real session contained a `thinking` block — assert we picked it up.
    const hasThinking = session.messages.some((m) =>
      m.blocks.some((b) => b.type === "thinking"),
    );
    expect(hasThinking).toBe(true);

    // …and at least one tool_use / tool_result pair.
    const toolUses = session.messages.flatMap((m) =>
      m.blocks.filter((b) => b.type === "tool_use"),
    );
    const toolResults = session.messages.flatMap((m) =>
      m.blocks.filter((b) => b.type === "tool_result"),
    );
    expect(toolUses.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);
  });
});

describe("isMarker", () => {
  test("recognises [Request interrupted by user]", () => {
    expect(isMarker("[Request interrupted by user]")).toBe(true);
    expect(isMarker("  [Request interrupted by user]  ")).toBe(true);
    expect(isMarker("[Request interrupted by user for tool use]")).toBe(true);
  });

  test("recognises tool-rejection markers", () => {
    expect(isMarker("[Tool use rejected]")).toBe(true);
    expect(isMarker("[Tool use was rejected by user]")).toBe(true);
  });

  test("rejects normal bracketed text", () => {
    expect(isMarker("[hello]")).toBe(false);
    expect(isMarker("[Code] this is broken")).toBe(false);
    expect(isMarker("Please review [my code]")).toBe(false);
  });
});

describe("parseClaudeJsonl with interrupt markers", () => {
  test("emits a 'marker' block for a standalone interrupt message", () => {
    const sample = JSON.stringify({
      type: "user",
      message: { role: "user", content: "[Request interrupted by user]" },
    });
    const s = parseClaudeJsonl(sample);
    expect(s.messages[0]?.blocks).toEqual([
      { type: "marker", text: "[Request interrupted by user]" },
    ]);
  });

  test("emits 'marker' inside an array content block too", () => {
    const sample = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Request interrupted by user for tool use]" },
        ],
      },
    });
    const s = parseClaudeJsonl(sample);
    expect(s.messages[0]?.blocks[0]?.type).toBe("marker");
  });
});

describe("parseCodexJsonl", () => {
  test("returns an empty session for empty input", () => {
    expect(parseCodexJsonl("").messages).toEqual([]);
  });

  test("handles role + content lines", () => {
    const text = [
      JSON.stringify({ role: "user", content: "hi", cwd: "/proj" }),
      JSON.stringify({ role: "assistant", content: "hello there" }),
    ].join("\n");
    const s = parseCodexJsonl(text);
    expect(s.cwd).toBe("/proj");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1]?.blocks[0]).toEqual({
      type: "text",
      text: "hello there",
    });
  });

  test("handles tool_call shape", () => {
    const text = JSON.stringify({
      type: "tool_call",
      name: "read_file",
      input: { path: "/a" },
    });
    const s = parseCodexJsonl(text);
    expect(s.messages[0]?.blocks[0]).toEqual({
      type: "tool_use",
      toolName: "read_file",
      toolInput: { path: "/a" },
    });
  });

  test("clamps unexpected roles to 'user'", () => {
    const text = JSON.stringify({ role: "weird", content: "x" });
    expect(parseCodexJsonl(text).messages[0]?.role).toBe("user");
  });

  test("falls back to top-level text/message fields", () => {
    const text = [
      JSON.stringify({ role: "user", text: "via text" }),
      JSON.stringify({ role: "assistant", message: "via message" }),
    ].join("\n");
    const s = parseCodexJsonl(text);
    expect(s.messages[0]?.blocks[0]?.text).toBe("via text");
    expect(s.messages[1]?.blocks[0]?.text).toBe("via message");
  });

  test("extracts cwd + sessionId from session_meta.payload (codex 0.130+)", () => {
    const text = JSON.stringify({
      type: "session_meta",
      payload: {
        id: "019e1bc1-9658-7a70-8529-42744e0c08ed",
        cwd: "/Users/me/proj",
        cli_version: "0.130.0",
      },
    });
    const s = parseCodexJsonl(text);
    expect(s.cwd).toBe("/Users/me/proj");
    expect(s.sessionId).toBe("019e1bc1-9658-7a70-8529-42744e0c08ed");
    // session_meta is metadata only, not a message.
    expect(s.messages).toEqual([]);
  });

  test("renders response_item messages (codex 0.130+)", () => {
    const text = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "world" }],
        },
      }),
    ].join("\n");
    const s = parseCodexJsonl(text);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[0]?.blocks[0]).toEqual({ type: "text", text: "hello" });
    expect(s.messages[1]?.blocks[0]).toEqual({ type: "text", text: "world" });
  });

  test("event_msg and turn_context lines are skipped (not rendered as messages)", () => {
    const text = [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "turn_context", payload: { cwd: "/x" } }),
    ].join("\n");
    expect(parseCodexJsonl(text).messages).toEqual([]);
  });
});

describe("parseCodexJsonl with a real sanitized fixture", () => {
  test("0.130 layout: extracts metadata, user prompt, and assistant reply", async () => {
    const text = await Bun.file(
      new URL("./fixtures/codex-real-sample.jsonl", import.meta.url).pathname,
    ).text();
    const s = parseCodexJsonl(text);
    expect(s.cwd).toBe("/Users/sanitized/proj");
    expect(s.sessionId).toBe("019e1bc1-9658-7a70-8529-42744e0c08ed");
    // Should find the user prompt + the assistant reply.
    const userMsgs = s.messages.filter((m) => m.role === "user");
    const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect(userMsgs.some((m) => m.blocks[0]?.text === "test")).toBe(true);
    expect(
      assistantMsgs.some((m) => m.blocks[0]?.text === "Test received."),
    ).toBe(true);
    // event_msg / turn_context lines aren't messages.
    const everyHasContent = s.messages.every(
      (m) => m.blocks.length > 0 && m.blocks[0]?.text,
    );
    expect(everyHasContent).toBe(true);
  });
});
