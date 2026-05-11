import { test, expect, describe } from "bun:test";
import { parseClaudeJsonl, parseCodexJsonl } from "../src/sessions";

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
});
