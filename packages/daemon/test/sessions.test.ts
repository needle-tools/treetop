import { test, expect, describe, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, appendFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  parseClaudeJsonl,
  parseCodexJsonl,
  splitInjectedTags,
  isMarker,
  parseSessionFile,
  getSessionResponseJson as _getSessionResponseJson,
  getSessionsBatchResults,
  sessionCacheStats,
  tailParseSessionFile,
  clearParseCache,
  readSessionInlineMedia,
} from "../src/sessions";

async function getSessionResponseJson(
  ...args: Parameters<typeof _getSessionResponseJson>
): Promise<string> {
  const { body } = await _getSessionResponseJson(...args);
  return body;
}

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
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: "1 file changed",
          },
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
            content: [
              { type: "text", text: "line a" },
              { type: "text", text: "line b" },
            ],
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

  test("normalises Claude image content as media blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is in this?" },
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.test/shot.png",
              media_type: "image/png",
            },
          },
        ],
      },
    });
    const session = parseClaudeJsonl(line);
    expect(session.messages[0]?.blocks).toEqual([
      { type: "text", text: "what is in this?" },
      {
        type: "media",
        mediaKind: "image",
        mimeType: "image/png",
        url: "https://example.test/shot.png",
        title: "Image",
        alt: "Image",
      },
    ]);
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

  test("drops Claude Code's `isMeta` records (skill instructions, resume nudges, local-command-caveats)", () => {
    // Claude Code writes several flavours of system-injected records
    // into the JSONL with type=user + role=user. They are flagged
    // with `isMeta: true` so consumers can recognise them. The chat
    // preview was rendering one of these — a skill's full prose
    // ("# Needle Engine\nYou are an expert…") — as if the user had
    // typed it, because the parser only checked `type` / `role`.
    const skillInjection = JSON.stringify({
      type: "user",
      isMeta: true,
      sourceToolUseID: "toolu_skill_load_1",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "# Needle Engine\n\nYou are an expert in Needle Engine — a web-first 3D engine…",
          },
        ],
      },
    });
    const resumeNudge = JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "Continue from where you left off." },
    });
    const realUser = JSON.stringify({
      type: "user",
      message: { role: "user", content: "do the thing" },
    });
    const s = parseClaudeJsonl(
      [skillInjection, resumeNudge, realUser].join("\n"),
    );
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe("user");
    expect(s.messages[0]?.blocks[0]).toMatchObject({
      type: "text",
      text: "do the thing",
    });
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
    const text = [
      "not json",
      '{"type":"summary"}',
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "ok" },
      }),
    ].join("\n");
    const s = parseClaudeJsonl(text);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]?.blocks[0]).toEqual({
      type: "marker",
      text: "[Context compacted]",
    });
  });

  test("renders Claude summary records as compaction markers", () => {
    const text = [
      JSON.stringify({
        type: "summary",
        summary: "previous context",
        timestamp: "2026-05-26T12:00:00.000Z",
      }),
      JSON.stringify({
        type: "system",
        message: { role: "system", content: "y" },
      }),
    ].join("\n");
    expect(parseClaudeJsonl(text).messages).toEqual([
      {
        role: "system",
        blocks: [{ type: "marker", text: "[Context compacted]" }],
        timestamp: "2026-05-26T12:00:00.000Z",
      },
    ]);
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
    expect(blocks.map((b) => b.type)).toEqual(["text", "ide_context", "text"]);
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
    const path = join(import.meta.dir, "fixtures", "claude-real-sample.jsonl");
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

  test("normalises Codex image input and output content as media blocks", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-19T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Generated this:" },
          {
            type: "output_image",
            path: "/tmp/supergit/attachments/generated.png",
            mime_type: "image/png",
            filename: "generated.png",
          },
          {
            type: "input_image",
            image_url: {
              url: "https://example.test/reference.webp",
              media_type: "image/webp",
            },
          },
        ],
      },
    });
    const session = parseCodexJsonl(line);
    expect(session.messages[0]?.blocks).toEqual([
      { type: "text", text: "Generated this:" },
      {
        type: "media",
        mediaKind: "image",
        mimeType: "image/png",
        path: "/tmp/supergit/attachments/generated.png",
        title: "generated.png",
        alt: "generated.png",
      },
      {
        type: "media",
        mediaKind: "image",
        mimeType: "image/webp",
        url: "https://example.test/reference.webp",
        title: "Image",
        alt: "Image",
      },
    ]);
  });

  test("does not inline Codex image data URLs into parsed session blocks", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(100_000)}`;
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    const line = JSON.stringify({
      timestamp: "2026-06-19T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    });

    const session = parseCodexJsonl(line);
    expect(session.messages[0]?.blocks).toEqual([
      {
        type: "media",
        mediaKind: "image",
        mimeType: "image/png",
        title: "Image",
        alt: "Image",
        text: "[image/png data stored in source transcript]",
        inlineDataHash: hash,
      },
    ]);
  });

  test("keeps Codex image generation calls visible before media exists", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-19T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "image_generation_call",
        call_id: "call-img-1",
        prompt: "a tidy agent UI",
        status: "in_progress",
      },
    });
    const session = parseCodexJsonl(line);
    expect(session.messages[0]?.blocks).toEqual([
      {
        type: "tool_use",
        toolName: "image_generation_call",
        toolInput: {
          type: "image_generation_call",
          call_id: "call-img-1",
          prompt: "a tidy agent UI",
          status: "in_progress",
        },
        toolUseId: "call-img-1",
      },
    ]);
  });

  test("splits Codex protocol markers out of assistant output text", () => {
    const text = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: [
              "Done.",
              "",
              '::git-create-branch{cwd="/Users/me/proj" branch="codex/demo"}',
              '::git-commit{cwd="/Users/me/proj"}',
              '::git-push{cwd="/Users/me/proj" branch="codex/demo"}',
            ].join("\n"),
          },
        ],
      },
    });
    const s = parseCodexJsonl(text);
    expect(s.messages[0]?.blocks).toEqual([
      { type: "text", text: "Done.\n" },
      { type: "marker", text: "[Codex git create branch: codex/demo]" },
      { type: "marker", text: "[Codex git commit]" },
      { type: "marker", text: "[Codex git push: codex/demo]" },
    ]);
  });

  test("renders Codex response_item tool calls and outputs", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-05-26T12:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "pwd" }),
          call_id: "call-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "Output:\n/Users/me/proj",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:02.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n...",
          call_id: "call-2",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:03.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: "Success",
        },
      }),
    ].join("\n");
    const s = parseCodexJsonl(text);
    expect(s.messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(s.messages[0]?.blocks[0]).toEqual({
      type: "tool_use",
      toolName: "exec_command",
      toolInput: { cmd: "pwd" },
      toolUseId: "call-1",
    });
    expect(s.messages[1]?.blocks[0]).toEqual({
      type: "tool_result",
      toolName: "exec_command",
      toolUseId: "call-1",
      text: "Output:\n/Users/me/proj",
    });
    expect(s.messages[2]?.blocks[0]).toEqual({
      type: "tool_use",
      toolName: "apply_patch",
      toolInput: "*** Begin Patch\n...",
      toolUseId: "call-2",
    });
    expect(s.messages[3]?.blocks[0]).toEqual({
      type: "tool_result",
      toolName: "apply_patch",
      toolUseId: "call-2",
      text: "Success",
    });
  });

  test("renders Codex update_plan calls as structured plan blocks", () => {
    const text = JSON.stringify({
      timestamp: "2026-06-19T22:24:16.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "update_plan",
        call_id: "plan-call-1",
        arguments: JSON.stringify({
          explanation: "Tighten the visual transcript plan surface.",
          plan: [
            { step: "Read the sample session", status: "completed" },
            { step: "Add plan UI", status: "in_progress" },
            { step: "Verify behavior", status: "pending" },
          ],
        }),
      },
    });
    const s = parseCodexJsonl(text);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.blocks[0]).toEqual({
      type: "plan",
      explanation: "Tighten the visual transcript plan surface.",
      planItems: [
        { step: "Read the sample session", status: "completed" },
        { step: "Add plan UI", status: "in_progress" },
        { step: "Verify behavior", status: "pending" },
      ],
      toolName: "update_plan",
      toolInput: {
        explanation: "Tighten the visual transcript plan surface.",
        plan: [
          { step: "Read the sample session", status: "completed" },
          { step: "Add plan UI", status: "in_progress" },
          { step: "Verify behavior", status: "pending" },
        ],
      },
      toolUseId: "plan-call-1",
    });
  });

  test("renders Codex event markers and result events", () => {
    const text = [
      JSON.stringify({
        timestamp: "2026-05-26T12:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started" },
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call-patch",
          stdout: "Success. Updated files\n",
          stderr: "",
          success: true,
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:02.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "interrupted" },
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:03.000Z",
        type: "compacted",
      }),
      JSON.stringify({
        timestamp: "2026-05-26T12:00:04.000Z",
        type: "event_msg",
        payload: { type: "context_compacted" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: {} },
      }),
      JSON.stringify({ type: "turn_context", payload: { cwd: "/x" } }),
    ].join("\n");
    const s = parseCodexJsonl(text);
    expect(s.messages.map((m) => m.blocks[0]?.type)).toEqual([
      "marker",
      "tool_result",
      "marker",
      "marker",
      "marker",
    ]);
    expect(s.messages[0]?.blocks[0]?.text).toContain("Task started");
    expect(s.messages[1]?.role).toBe("tool");
    expect(s.messages[1]?.blocks[0]).toEqual({
      type: "tool_result",
      toolName: "apply_patch",
      toolUseId: "call-patch",
      text: "Success. Updated files\n",
    });
    expect(s.messages[2]?.blocks[0]?.text).toContain("interrupted");
    expect(s.messages[3]?.blocks[0]?.text).toContain("Context compacted");
    expect(s.messages[4]?.blocks[0]?.text).toContain("Context compacted");
  });

  test("still skips duplicate Codex message events and metadata noise", () => {
    const text = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      JSON.stringify({ type: "turn_context", payload: { cwd: "/x" } }),
    ].join("\n");
    expect(parseCodexJsonl(text).messages).toEqual([]);
  });
});

describe("parseCodexJsonl with a real sanitized fixture", () => {
  test("0.130 layout: extracts metadata, user prompt, and assistant reply", async () => {
    const text = await Bun.file(
      fileURLToPath(
        new URL("./fixtures/codex-real-sample.jsonl", import.meta.url),
      ),
    ).text();
    const s = parseCodexJsonl(text);
    expect(s.cwd).toBe("/Users/sanitized/proj");
    expect(s.sessionId).toBe("019e1bc1-9658-7a70-8529-42744e0c08ed");
    // Should find only the visible user prompt + the assistant reply.
    const userMsgs = s.messages.filter((m) => m.role === "user");
    const assistantMsgs = s.messages.filter((m) => m.role === "assistant");
    expect(userMsgs).toHaveLength(1);
    expect(assistantMsgs).toHaveLength(1);
    expect(userMsgs.some((m) => m.blocks[0]?.text === "test")).toBe(true);
    expect(
      assistantMsgs.some((m) => m.blocks[0]?.text === "Test received."),
    ).toBe(true);
    expect(s.messages.some((m) => m.blocks[0]?.text?.includes("<"))).toBe(
      false,
    );
    // event_msg / turn_context lines aren't messages.
    const everyHasContent = s.messages.every(
      (m) => m.blocks.length > 0 && m.blocks[0]?.text,
    );
    expect(everyHasContent).toBe(true);
  });
});

describe("getSessionResponseJson cache", () => {
  beforeEach(() => clearParseCache());

  function claudeLine(content: string, ts: string) {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content },
      timestamp: ts,
    });
  }

  function claudeAssistantLine(content: string, ts: string) {
    return JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content },
      timestamp: ts,
    });
  }

  function claudeToolResultLine(content: string, ts: string) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content }],
      },
      timestamp: ts,
    });
  }

  test("re-parses when the file's mtime+size changes (append)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, claudeLine("first", "2026-05-12T01:00:00Z") + "\n");

    const first = JSON.parse(await getSessionResponseJson("claude", path));
    expect(first.messages).toHaveLength(1);

    // Append a second line. Size changes, so even if mtime resolution is
    // coarse the cache must invalidate.
    await appendFile(path, claudeLine("second", "2026-05-12T01:00:01Z") + "\n");
    const second = JSON.parse(await getSessionResponseJson("claude", path));
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]?.blocks[0]?.text).toBe("second");
  });

  test("returns cached response when mtime+size are unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, claudeLine("only", "2026-05-12T01:00:00Z") + "\n");

    // Prime the cache.
    const fixedTime = new Date("2026-05-12T01:00:00Z");
    await utimes(path, fixedTime, fixedTime);
    await getSessionResponseJson("claude", path);

    // Overwrite the content but restore mtime+size so the cache key is
    // unchanged. A cache hit should return the original ("only") payload.
    const sameLengthReplacement =
      claudeLine("xxxx", "2026-05-12T01:00:00Z") + "\n";
    expect(sameLengthReplacement.length).toBe(
      (claudeLine("only", "2026-05-12T01:00:00Z") + "\n").length,
    );
    await writeFile(path, sameLengthReplacement);
    await utimes(path, fixedTime, fixedTime);

    const b = JSON.parse(await getSessionResponseJson("claude", path));
    expect(b.messages[0]?.blocks[0]?.text).toBe("only");
  });

  test("returns an empty session for a non-existent path", async () => {
    const s = JSON.parse(
      await getSessionResponseJson("claude", "/does/not/exist.jsonl"),
    );
    expect(s.messages).toEqual([]);
    expect(s.agent).toBe("claude");
  });

  test("exposes Codex inline image data as compact session media URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    const bytes = Buffer.from("image bytes");
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    await writeFile(
      path,
      JSON.stringify({
        timestamp: "2026-06-19T10:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: { url: dataUrl } }],
        },
      }) + "\n",
    );

    const body = await getSessionResponseJson("codex", path);
    expect(body).not.toContain(dataUrl);
    const session = JSON.parse(body);
    expect(session.messages[0]?.blocks[0]).toEqual({
      type: "media",
      mediaKind: "image",
      mimeType: "image/png",
      title: "Image",
      alt: "Image",
      url: `/api/session/media?source=${encodeURIComponent(path)}&hash=${hash}`,
    });

    const media = await readSessionInlineMedia(path, hash);
    expect(media.status).toBe(200);
    if (media.status === 200) {
      expect(media.mimeType).toBe("image/png");
      expect(Buffer.from(media.bytes).toString("utf-8")).toBe("image bytes");
    }
  });

  test("can return a bounded thumbnail for inline image data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    const bytes = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 3,
        background: "#ff3366",
      },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    await writeFile(
      path,
      JSON.stringify({
        timestamp: "2026-06-19T10:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: { url: dataUrl } }],
        },
      }) + "\n",
    );

    const media = await readSessionInlineMedia(path, hash, { maxSide: 30 });

    expect(media.status).toBe(200);
    if (media.status === 200) {
      expect(media.bytes.byteLength).toBeLessThan(bytes.byteLength);
      const meta = await sharp(media.bytes).metadata();
      expect(meta.width).toBe(30);
      expect(meta.height).toBe(15);
      expect(media.mimeType).toBe("image/png");
    }
  });

  test("does not re-encode inline image data that already fits the thumbnail cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    const bytes = await sharp({
      create: {
        width: 20,
        height: 10,
        channels: 3,
        background: "#33ccaa",
      },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    await writeFile(
      path,
      JSON.stringify({
        timestamp: "2026-06-19T10:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: { url: dataUrl } }],
        },
      }) + "\n",
    );

    const media = await readSessionInlineMedia(path, hash, { maxSide: 30 });

    expect(media.status).toBe(200);
    if (media.status === 200) {
      expect(Buffer.from(media.bytes)).toEqual(bytes);
      expect(media.mimeType).toBe("image/png");
    }
  });

  test("injects manualTitle into cached JSON without busting the cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, claudeLine("hi", "2026-05-12T01:00:00Z") + "\n");

    const fixedTime = new Date("2026-05-12T01:00:00Z");
    await utimes(path, fixedTime, fixedTime);

    const a = JSON.parse(await getSessionResponseJson("claude", path));
    expect(a.manualTitle).toBeUndefined();

    const b = JSON.parse(
      await getSessionResponseJson("claude", path, "my title"),
    );
    expect(b.manualTitle).toBe("my title");
    expect(b.messages).toHaveLength(1);
    // The "without title" cache entry must survive — a subsequent call
    // without a title still returns the bare session.
    const c = JSON.parse(await getSessionResponseJson("claude", path));
    expect(c.manualTitle).toBeUndefined();
  });

  test("escapes manualTitle so injection can't break the JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, claudeLine("hi", "2026-05-12T01:00:00Z") + "\n");

    const raw = await getSessionResponseJson(
      "claude",
      path,
      'evil "title" with\nnewline',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.manualTitle).toBe('evil "title" with\nnewline');
  });

  test("appends incrementally: a second poll after one new line shows N+1 messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, claudeLine("first", "2026-05-12T01:00:00Z") + "\n");

    const a = JSON.parse(await getSessionResponseJson("claude", path));
    expect(
      a.messages.map((m: { blocks: { text: string }[] }) => m.blocks[0]?.text),
    ).toEqual(["first"]);

    // Append one line — the tail parser should pick up just the new line.
    await appendFile(path, claudeLine("second", "2026-05-12T01:00:01Z") + "\n");
    const b = JSON.parse(await getSessionResponseJson("claude", path));
    expect(
      b.messages.map((m: { blocks: { text: string }[] }) => m.blocks[0]?.text),
    ).toEqual(["first", "second"]);

    // Append a third — same path again.
    await appendFile(path, claudeLine("third", "2026-05-12T01:00:02Z") + "\n");
    const c = JSON.parse(await getSessionResponseJson("claude", path));
    expect(c.messages).toHaveLength(3);
    expect(c.messages[2]?.blocks[0]?.text).toBe("third");
  });

  test("pins cwd / sessionId from the file head, not from the tail (long-session bug repro)", async () => {
    // Repro for a real session where a 22k-message Claude JSONL had the
    // session's original cwd (`/origin`) on the first line but later
    // messages recorded a sub-cwd (`/origin/sub`). Tail-only parsing
    // latched the sub-cwd, supergit launched `claude --resume` with that
    // wrong cwd, and Claude responded "No conversation found with session
    // ID" because the project directory it derives from cwd no longer
    // matched. The fix is to seed cwd/sessionId from the file's head and
    // let the tail provide only messages.
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-head-"));
    const path = join(dir, "session.jsonl");

    function lineWithCwd(
      cwd: string,
      sessionId: string,
      content: string,
      ts: string,
    ) {
      return JSON.stringify({
        type: "user",
        cwd,
        sessionId,
        message: { role: "user", content },
        timestamp: ts,
      });
    }
    // Head: the authoritative cwd + sessionId.
    await writeFile(
      path,
      lineWithCwd(
        "/origin",
        "head-session-id",
        "first",
        "2026-05-12T01:00:00Z",
      ) + "\n",
    );
    // Force the tail-read window to exclude the head by passing a tiny
    // tailBytes; the head meta read uses its own (larger) window.
    // First check the bug repro: without head pinning we'd see the tail
    // cwd. With the fix, head wins.
    await appendFile(
      path,
      lineWithCwd(
        "/origin/sub",
        "tail-session-id",
        "later",
        "2026-05-12T01:00:01Z",
      ) + "\n",
    );
    const result = await tailParseSessionFile("claude", path, 200, 64 * 1024);
    expect(result.cwd).toBe("/origin");
    expect(result.sessionId).toBe("head-session-id");
    // The tail still contributes its messages (the latest ones the UI
    // shows in the chat).
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("defers a partial last line until its trailing newline arrives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, claudeLine("first", "2026-05-12T01:00:00Z") + "\n");

    // Prime the cache.
    await getSessionResponseJson("claude", path);

    // Write a line *without* a trailing newline — simulates an agent
    // mid-write. The tail parser must not try to JSON.parse it yet.
    const half = claudeLine("inprogress", "2026-05-12T01:00:01Z");
    await appendFile(path, half);
    const b = JSON.parse(await getSessionResponseJson("claude", path));
    expect(b.messages).toHaveLength(1); // still just "first"

    // Finish the line by appending the missing newline.
    await appendFile(path, "\n");
    const c = JSON.parse(await getSessionResponseJson("claude", path));
    expect(c.messages).toHaveLength(2);
    expect(c.messages[1]?.blocks[0]?.text).toBe("inprogress");
  });

  test("caps cached/returned messages at MAX_CACHED_MESSAGES (~100), keeping the most recent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    // Build a file with more than the cap. We use 150 lines — the cap is
    // 100, so we expect the returned messages to be the last 100.
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(claudeLine(`msg-${i}`, `2026-05-12T01:00:00Z`));
    }
    await writeFile(path, lines.join("\n") + "\n");

    const a = JSON.parse(await getSessionResponseJson("claude", path));
    expect(a.messages).toHaveLength(100);
    // Most recent comes last, and it's "msg-149".
    expect(a.messages[99]?.blocks[0]?.text).toBe("msg-149");
    // First retained one is msg-50 (we dropped msg-0..msg-49).
    expect(a.messages[0]?.blocks[0]?.text).toBe("msg-50");

    // Append a few more — cache stays bounded.
    await appendFile(
      path,
      claudeLine("after-1", "2026-05-12T01:00:01Z") +
        "\n" +
        claudeLine("after-2", "2026-05-12T01:00:02Z") +
        "\n",
    );
    const b = JSON.parse(await getSessionResponseJson("claude", path));
    expect(b.messages).toHaveLength(100);
    expect(b.messages[99]?.blocks[0]?.text).toBe("after-2");
    expect(b.messages[98]?.blocks[0]?.text).toBe("after-1");
    // The trim still drops from the head — msg-52 is now the oldest kept.
    expect(b.messages[0]?.blocks[0]?.text).toBe("msg-52");
  });

  test("keeps the old tail and widens it to include the last two user turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    const lines: string[] = [
      claudeLine("old setup", "2026-05-12T01:00:00Z"),
      claudeAssistantLine("old done", "2026-05-12T01:00:01Z"),
      claudeLine("please fix the UI", "2026-05-12T01:00:02Z"),
    ];
    for (let i = 0; i < 120; i++) {
      lines.push(
        claudeToolResultLine(
          `tool-${i}`,
          `2026-05-12T01:${String(i + 3).padStart(2, "0")}:00Z`,
        ),
      );
    }
    lines.push(
      claudeAssistantLine("first fix done", "2026-05-12T03:03:00Z"),
      claudeLine("one more thing", "2026-05-12T03:04:00Z"),
      claudeAssistantLine("second fix done", "2026-05-12T03:05:00Z"),
    );
    await writeFile(path, lines.join("\n") + "\n");

    const parsed = JSON.parse(await getSessionResponseJson("claude", path));
    expect(parsed.messages.length).toBeGreaterThan(100);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.blocks[0]?.text).toBe("please fix the UI");
    expect(
      parsed.messages.filter((m: { role: string }) => m.role === "user").length,
    ).toBe(2);
    expect(parsed.messages.at(-1)?.blocks[0]?.text).toBe("second fix done");
  });

  test("does not shrink the old tail when it already has two user turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(claudeLine(`msg-${i}`, `2026-05-12T01:00:00Z`));
    }
    await writeFile(path, lines.join("\n") + "\n");

    const parsed = JSON.parse(await getSessionResponseJson("claude", path));
    expect(parsed.messages).toHaveLength(100);
    expect(parsed.messages[0]?.blocks[0]?.text).toBe("msg-50");
    expect(parsed.messages.at(-1)?.blocks[0]?.text).toBe("msg-149");
  });

  test("widens to the containing user turn even when the capped tail already has later users", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    const lines: string[] = [
      claudeLine("first user turn", "2026-05-12T01:00:00Z"),
    ];
    for (let i = 0; i < 50; i++) {
      lines.push(
        claudeToolResultLine(
          `first-turn-tool-${i}`,
          `2026-05-12T01:${String(i + 1).padStart(2, "0")}:00Z`,
        ),
      );
    }
    lines.push(
      claudeAssistantLine("first turn done", "2026-05-12T02:00:00Z"),
      claudeLine("second user turn", "2026-05-12T02:01:00Z"),
      claudeAssistantLine("second turn done", "2026-05-12T02:02:00Z"),
      claudeLine("third user turn", "2026-05-12T02:03:00Z"),
      claudeAssistantLine("third turn started", "2026-05-12T02:04:00Z"),
    );
    for (let i = 0; i < 74; i++) {
      lines.push(
        claudeToolResultLine(
          `third-turn-tool-${i}`,
          `2026-05-12T03:${String(i + 1).padStart(2, "0")}:00Z`,
        ),
      );
    }
    await writeFile(path, lines.join("\n") + "\n");

    const parsed = JSON.parse(await getSessionResponseJson("claude", path));
    expect(parsed.messages.length).toBeGreaterThan(100);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.blocks[0]?.text).toBe("first user turn");
    expect(parsed.messages.at(-1)?.blocks[0]?.text).toBe("third-turn-tool-73");
  });

  test("keeps the old tail and widens it to include the only recent user turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    const lines: string[] = [
      claudeLine("please inspect this", "2026-05-12T01:00:00Z"),
    ];
    for (let i = 0; i < 120; i++) {
      lines.push(
        claudeToolResultLine(
          `tool-${i}`,
          `2026-05-12T01:${String(i + 1).padStart(2, "0")}:00Z`,
        ),
      );
    }
    await writeFile(path, lines.join("\n") + "\n");

    const parsed = JSON.parse(await getSessionResponseJson("claude", path));
    expect(parsed.messages.length).toBeGreaterThan(100);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.blocks[0]?.text).toBe("please inspect this");
    expect(parsed.messages.at(-1)?.blocks[0]?.text).toBe("tool-119");
  });

  test("widens a too-small tail instead of returning orphan tool rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    const hugeToolText = "x".repeat(160 * 1024);
    const lines: string[] = [
      claudeLine("first visible user", "2026-05-12T01:00:00Z"),
    ];
    for (let i = 0; i < 64; i++) {
      lines.push(
        claudeToolResultLine(
          `${hugeToolText}-${i}`,
          `2026-05-12T01:${String(i + 1).padStart(2, "0")}:00Z`,
        ),
      );
    }
    lines.push(claudeLine("current user", "2026-05-12T03:00:00Z"));
    for (let i = 0; i < 20; i++) {
      lines.push(
        claudeToolResultLine(
          `current-tool-${i}`,
          `2026-05-12T03:${String(i + 1).padStart(2, "0")}:00Z`,
        ),
      );
    }
    await writeFile(path, lines.join("\n") + "\n");

    const parsed = JSON.parse(await getSessionResponseJson("claude", path));
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.blocks[0]?.text).toBe("first visible user");
    expect(
      parsed.messages.filter((m: { role: string }) => m.role === "user").length,
    ).toBe(2);
    expect(parsed.messages.at(-1)?.blocks[0]?.text).toBe("current-tool-19");
  });

  test("clips oversized strings inside tool_use.toolInput (Write/Edit content)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    const huge = "y".repeat(32 * 1024);
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "Write",
            input: { file_path: "/tmp/big.ts", content: huge },
          },
        ],
      },
      timestamp: "2026-05-12T01:00:00Z",
    });
    await writeFile(path, line + "\n");

    const s = JSON.parse(await getSessionResponseJson("claude", path));
    const blk = s.messages[0].blocks[0];
    expect(blk.type).toBe("tool_use");
    expect(blk.toolInput.file_path).toBe("/tmp/big.ts");
    // content was clipped — much shorter than the 32 KB original.
    expect(typeof blk.toolInput.content).toBe("string");
    expect(blk.toolInput.content.length).toBeLessThan(huge.length);
    expect(blk.toolInput.content).toContain("truncated by supergit");
  });

  test("clips oversized tool_result text in the cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");

    // A tool_result whose text exceeds the 16 KB clip — we use 32 KB so
    // the truncation is obvious.
    const huge = "x".repeat(32 * 1024);
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-1",
            content: huge,
          },
        ],
      },
      timestamp: "2026-05-12T01:00:00Z",
    });
    await writeFile(path, line + "\n");

    const s = JSON.parse(await getSessionResponseJson("claude", path));
    expect(s.messages).toHaveLength(1);
    const blk = s.messages[0].blocks[0];
    expect(blk.type).toBe("tool_result");
    // 16 KB + suffix — definitely shorter than the 32 KB original.
    expect(blk.text.length).toBeLessThan(huge.length);
    expect(blk.text).toContain("truncated by supergit");
  });

  test("falls back to a full re-parse if the file shrinks (truncation)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-session-cache-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      claudeLine("a", "2026-05-12T01:00:00Z") +
        "\n" +
        claudeLine("b", "2026-05-12T01:00:01Z") +
        "\n",
    );
    const before = JSON.parse(await getSessionResponseJson("claude", path));
    expect(before.messages).toHaveLength(2);

    // Replace the file with shorter content — simulates the agent
    // rolling its own log or starting fresh.
    await writeFile(path, claudeLine("only", "2026-05-12T01:00:02Z") + "\n");
    const after = JSON.parse(await getSessionResponseJson("claude", path));
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]?.blocks[0]?.text).toBe("only");
  });
});

describe("parseSessionFile", () => {
  test("returns an empty session for a non-existent path", async () => {
    const s = await parseSessionFile("claude", "/does/not/exist.jsonl");
    expect(s.messages).toEqual([]);
  });
});

describe("getSessionsBatchResults", () => {
  beforeEach(() => clearParseCache());

  function claudeLine(content: string, ts: string) {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content },
      timestamp: ts,
    });
  }

  const agentClaude = () => "claude" as const;
  const noTitle = () => undefined;

  test("first request (no etag) returns 200 with body + etag per source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-batch-"));
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    await writeFile(a, claudeLine("aaa", "2026-05-12T01:00:00Z") + "\n");
    await writeFile(b, claudeLine("bbb", "2026-05-12T01:00:00Z") + "\n");

    const results = await getSessionsBatchResults(
      [{ source: a }, { source: b }],
      agentClaude,
      noTitle,
    );

    expect(results).toHaveLength(2);
    const ra = results.find((r) => r.source === a)!;
    const rb = results.find((r) => r.source === b)!;
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.status === 200 && ra.etag).toBeTruthy();
    const parsedA = JSON.parse((ra as { body: string }).body);
    expect(parsedA.messages[0]?.blocks[0]?.text).toBe("aaa");
  });

  test("matching etag returns 304 with no body (unchanged session)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-batch-"));
    const a = join(dir, "a.jsonl");
    const fixed = new Date("2026-05-12T01:00:00Z");
    await writeFile(a, claudeLine("aaa", "2026-05-12T01:00:00Z") + "\n");
    await utimes(a, fixed, fixed);

    const [first] = await getSessionsBatchResults(
      [{ source: a }],
      agentClaude,
      noTitle,
    );
    expect(first.status).toBe(200);
    const etag = (first as { etag: string }).etag;

    const [second] = await getSessionsBatchResults(
      [{ source: a, etag }],
      agentClaude,
      noTitle,
    );
    expect(second.status).toBe(304);
    expect((second as { body?: string }).body).toBeUndefined();
  });

  test("stale etag after append returns 200 with the new body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-batch-"));
    const a = join(dir, "a.jsonl");
    await writeFile(a, claudeLine("first", "2026-05-12T01:00:00Z") + "\n");

    const [first] = await getSessionsBatchResults(
      [{ source: a }],
      agentClaude,
      noTitle,
    );
    const etag = (first as { etag: string }).etag;

    await appendFile(a, claudeLine("second", "2026-05-12T01:00:01Z") + "\n");
    const [second] = await getSessionsBatchResults(
      [{ source: a, etag }],
      agentClaude,
      noTitle,
    );
    expect(second.status).toBe(200);
    const parsed = JSON.parse((second as { body: string }).body);
    expect(parsed.messages).toHaveLength(2);
  });

  test("stale etag with message hashes returns a tail patch after append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-batch-"));
    const a = join(dir, "a.jsonl");
    await writeFile(a, claudeLine("first", "2026-05-12T01:00:00Z") + "\n");

    const [first] = await getSessionsBatchResults(
      [{ source: a }],
      agentClaude,
      noTitle,
    );
    expect(first.status).toBe(200);
    if (first.status !== 200) throw new Error("expected first full response");
    const firstParsed = JSON.parse(first.body);

    await appendFile(a, claudeLine("second", "2026-05-12T01:00:01Z") + "\n");
    const [second] = await getSessionsBatchResults(
      [
        {
          source: a,
          etag: first.etag,
          messageCursor: first.messageHashes.map((hash, index) => ({
            index,
            hash,
          })),
        },
      ],
      agentClaude,
      noTitle,
    );

    expect(second.status).toBe(206);
    if (second.status !== 206) throw new Error("expected patch response");
    expect(second.patch.oldStart).toBe(0);
    expect(second.patch.oldEnd).toBe(1);
    expect(second.patch.messages).toHaveLength(1);
    const patchedMessages = firstParsed.messages
      .slice(second.patch.oldStart, second.patch.oldEnd)
      .concat(second.patch.messages);
    expect(
      patchedMessages.map(
        (m: { blocks: Array<{ text?: string }> }) => m.blocks[0]?.text,
      ),
    ).toEqual(["first", "second"]);
  });

  test("unresolved source (resolver returns null) returns 403", async () => {
    const results = await getSessionsBatchResults(
      [{ source: "/outside/any/root.jsonl" }],
      () => null,
      noTitle,
    );
    expect(results[0]!.status).toBe(403);
  });

  test("injects manualTitle from getTitle into the 200 body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-batch-"));
    const a = join(dir, "a.jsonl");
    await writeFile(a, claudeLine("hi", "2026-05-12T01:00:00Z") + "\n");
    const [r] = await getSessionsBatchResults(
      [{ source: a }],
      agentClaude,
      (s) => (s === a ? "Pinned title" : undefined),
    );
    const parsed = JSON.parse((r as { body: string }).body);
    expect(parsed.manualTitle).toBe("Pinned title");
  });

  test("keeps hundreds of active on-disk sessions cached across append ticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supergit-batch-scale-"));
    const count = 200;
    const rowsPerSession = 40;
    const sources = await Promise.all(
      Array.from({ length: count }, async (_, sessionIndex) => {
        const source = join(dir, `session-${sessionIndex}.jsonl`);
        const rows = Array.from({ length: rowsPerSession }, (_, rowIndex) =>
          claudeLine(
            `session ${sessionIndex} row ${rowIndex} ${"x".repeat(64)}`,
            `2026-05-12T01:${String(rowIndex).padStart(2, "0")}:00Z`,
          ),
        ).join("\n");
        await writeFile(source, rows + "\n");
        return source;
      }),
    );

    const t0 = performance.now();
    const first = await getSessionsBatchResults(
      sources.map((source) => ({ source })),
      agentClaude,
      noTitle,
    );
    const firstMs = performance.now() - t0;
    expect(first.every((result) => result.status === 200)).toBe(true);
    expect(sessionCacheStats().entries).toBe(count);

    await Promise.all(
      sources.map((source, index) =>
        appendFile(
          source,
          claudeLine(
            `session ${index} appended ${"y".repeat(64)}`,
            "2026-05-12T02:00:00Z",
          ) + "\n",
        ),
      ),
    );

    const t1 = performance.now();
    const second = await getSessionsBatchResults(
      first.map((result) => ({
        source: result.source,
        etag: result.status === 200 ? result.etag : undefined,
      })),
      agentClaude,
      noTitle,
    );
    const appendMs = performance.now() - t1;

    expect(second.every((result) => result.status === 200)).toBe(true);
    expect(sessionCacheStats().entries).toBe(count);
    expect(firstMs).toBeLessThan(5_000);
    expect(appendMs).toBeLessThan(1_500);
  });
});
