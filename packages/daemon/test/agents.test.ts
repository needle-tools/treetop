/**
 * Tests for the agent scanners. We build small fixture filesystems in temp
 * directories and call the scanners with explicit roots so we don't touch
 * the real ~/.claude / ~/.codex / VSCode storage.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  agentsForWorktree,
  claudeProjectDirForCwd,
  readJsonlField,
  readClaudeSessionMeta,
  scanClaudeUserMessages,
  scanCodexMessageCount,
  scanCodexContextTokens,
  scanCodexTokenUsage,
  scanClaude,
  scanCodex,
  scanCopilot,
  scanImported,
  groupSessionsByFolder,
  type AgentSession,
} from "../src/agents";

async function tempDir(prefix = "supergit-agents-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("readJsonlField", () => {
  test("returns null when file is missing", async () => {
    expect(await readJsonlField("/no/such/file", "cwd")).toBeNull();
  });

  test("returns null when no line has the field", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(file, '{"type":"summary"}\n{"foo":"bar"}\n');
    expect(await readJsonlField(file, "cwd")).toBeNull();
  });

  test("returns the first string value of the field", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      '{"type":"summary"}\n{"cwd":"/Users/marcel/foo","other":1}\n{"cwd":"/other"}\n',
    );
    expect(await readJsonlField(file, "cwd")).toBe("/Users/marcel/foo");
  });

  test("skips non-JSON lines without throwing", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(file, "garbage\n{not json\n{\"cwd\":\"/ok\"}\n");
    expect(await readJsonlField(file, "cwd")).toBe("/ok");
  });
});

describe("readClaudeSessionMeta", () => {
  test("returns empty object when file is missing", async () => {
    expect(await readClaudeSessionMeta("/no/such/file")).toEqual({});
  });

  test("prefers an explicit summary over the first user message", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "summary", summary: "Fix auth bug" }),
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: { role: "user", content: "long unrelated prompt" },
        }),
      ].join("\n"),
    );
    const r = await readClaudeSessionMeta(file);
    expect(r.title).toBe("Fix auth bug");
    expect(r.cwd).toBe("/proj");
  });

  test("falls back to the first user message text", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: { role: "user", content: "Please update the README" },
      }),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "Please update the README",
    );
  });

  test("strips <ide_*> wrappers before using the user text as a title", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: {
          role: "user",
          content:
            "<ide_opened_file>opened /a.ts</ide_opened_file>\nLet's refactor it",
        },
      }),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe("Let's refactor it");
  });

  test("handles array-style content blocks", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: {
          role: "user",
          content: [{ type: "text", text: "Implement the feature" }],
        },
      }),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "Implement the feature",
    );
  });

  test("truncates titles longer than 120 chars with an ellipsis", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    const longPrompt = "x ".repeat(200).trim();
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: { role: "user", content: longPrompt },
      }),
    );
    const r = await readClaudeSessionMeta(file);
    expect(r.title?.length).toBeLessThanOrEqual(120);
    expect(r.title?.endsWith("…")).toBe(true);
  });

  test("falls back to the last user message when the first is empty after stripping wrappers", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        // First user message: pure command wrapper that becomes empty after
        // cleanForTitle().
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: {
            role: "user",
            content: "<command-name>/init</command-name>",
          },
        }),
        // Later user message with real text.
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "Make the dashboard live-update sessions",
          },
        }),
      ].join("\n"),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "Make the dashboard live-update sessions",
    );
  });

  test("returns the most recent user message in lastUserMessage", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: { role: "user", content: "first ask" },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "follow-up question" },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "and one more thing" },
        }),
      ].join("\n"),
    );
    const meta = await readClaudeSessionMeta(file);
    expect(meta.lastUserMessage).toBe("and one more thing");
  });

  test("falls back to the first assistant text when no user text exists", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "user", cwd: "/proj", message: { role: "user", content: "<ide_opened_file>/a.ts</ide_opened_file>" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I'll read the file first." },
            ],
          },
        }),
      ].join("\n"),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "I'll read the file first.",
    );
  });
});

describe("scanClaudeUserMessages", () => {
  test("returns empty stats when the file is missing", async () => {
    expect(await scanClaudeUserMessages("/no/such/file")).toEqual({
      lastUserMessages: [],
      userMessageCount: 0,
      totalMessageCount: 0,
    });
  });

  test("totalMessageCount sums user + assistant turns, skips tool_result-only", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        // 1 real user
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: { role: "user", content: "hi" },
        }),
        // 1 assistant
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "hello" },
        }),
        // tool result wrapped as a user message — should NOT count
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
          },
        }),
        // 1 more user
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "again" },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.totalMessageCount).toBe(3);
    expect(stats.userMessageCount).toBe(2);
  });

  test("captures first user message, last 3, and total count", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: `prompt ${i}` },
        }),
      );
    }
    await writeFile(file, lines.join("\n"));
    const stats = await scanClaudeUserMessages(file);
    expect(stats.firstUserMessage).toBe("prompt 1");
    expect(stats.lastUserMessages).toEqual([
      "prompt 5",
      "prompt 6",
      "prompt 7",
    ]);
    expect(stats.userMessageCount).toBe(7);
  });

  test("returns fewer than 3 in lastUserMessages when there aren't that many", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "only ask" },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.firstUserMessage).toBe("only ask");
    expect(stats.lastUserMessages).toEqual(["only ask"]);
    expect(stats.userMessageCount).toBe(1);
  });

  test("skips lines whose user content is empty after stripping wrappers", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "<command-name>/init</command-name>",
          },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "real prompt" },
        }),
        JSON.stringify({ type: "assistant", message: { content: "ack" } }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.firstUserMessage).toBe("real prompt");
    expect(stats.userMessageCount).toBe(1);
    expect(stats.lastUserMessages).toEqual(["real prompt"]);
  });

  test("caps each captured message to a reasonable length", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    const huge = "y ".repeat(800).trim();
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: huge },
      }),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.firstUserMessage?.length ?? 0).toBeLessThanOrEqual(400);
    expect(stats.firstUserMessage?.endsWith("…")).toBe(true);
  });

  test("captures lastContextTokens + model from the most recent assistant usage", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: "hello",
            usage: {
              input_tokens: 3,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 0,
              output_tokens: 5,
            },
          },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "again" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: "ok",
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 50000,
              output_tokens: 7,
            },
          },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.lastContextTokens).toBe(4 + 1000 + 50000);
    expect(stats.model).toBe("claude-opus-4-7");
  });

  test("ignores assistant turns without a usage block when picking the latest", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: "first",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        }),
        // Subsequent assistant turn with no usage — must not clobber the
        // previous good reading.
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "later, no usage" },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.lastContextTokens).toBe(10);
    expect(stats.model).toBe("claude-sonnet-4-6");
  });

  test("returns undefined context tokens when no assistant turn carries usage", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "no usage block here" },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.lastContextTokens).toBeUndefined();
    expect(stats.model).toBeUndefined();
  });

  test("a compact_boundary AFTER the last usage clears the reading (post-/compact, awaiting next turn)", async () => {
    // Mirrors what Claude Code writes in real sessions: a usage-bearing
    // assistant turn, then a `system / compact_boundary` line. Until a
    // NEW assistant turn lands with fresh usage, the previous reading
    // is stale — show nothing rather than the pre-compact value.
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: "before compact",
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 100_000,
              cache_read_input_tokens: 100_000,
              output_tokens: 50,
            },
          },
        }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          compactMetadata: { trigger: "auto", preTokens: 200_005 },
        }),
        // Post-compact "continued from previous" user message exists
        // in real files; including it to prove the parser doesn't
        // accidentally treat the summary as a new usage reading.
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content:
              "This session is being continued from a previous conversation that ran out of context.",
          },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.lastContextTokens).toBeUndefined();
  });

  test("a fresh assistant usage AFTER a compact_boundary overrides the reset (chip refills)", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: "before",
            usage: {
              input_tokens: 5,
              cache_creation_input_tokens: 100_000,
              cache_read_input_tokens: 100_000,
              output_tokens: 50,
            },
          },
        }),
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "manual", preTokens: 200_005 },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: "after compact",
            usage: {
              input_tokens: 1,
              cache_creation_input_tokens: 5_000,
              cache_read_input_tokens: 0,
              output_tokens: 20,
            },
          },
        }),
      ].join("\n"),
    );
    const stats = await scanClaudeUserMessages(file);
    expect(stats.lastContextTokens).toBe(5_001);
    expect(stats.model).toBe("claude-opus-4-7");
  });
});

describe("scanClaude", () => {
  test("returns empty when root does not exist", async () => {
    expect(await scanClaude("/no/such/claude/root")).toEqual([]);
  });

  test("returns empty when root exists but is empty", async () => {
    expect(await scanClaude(await tempDir())).toEqual([]);
  });

  test("picks up jsonl sessions with cwd metadata", async () => {
    const root = await tempDir();
    const proj = join(root, "-Users-marcel-git-supergit");
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, "abc-123.jsonl"),
      '{"type":"summary","summary":"x"}\n{"cwd":"/Users/marcel/git/supergit","type":"user"}\n',
    );

    const sessions = await scanClaude(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agent).toBe("claude");
    expect(sessions[0]?.cwd).toBe(resolve("/Users/marcel/git/supergit"));
    expect(sessions[0]?.sessionId).toBe("abc-123");
  });

  test("skips files without a cwd field", async () => {
    const root = await tempDir();
    const proj = join(root, "-x");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "empty.jsonl"), '{"type":"summary"}\n');
    expect(await scanClaude(root)).toEqual([]);
  });
});

describe("scanCodexMessageCount", () => {
  test("returns 0 when the file is missing", async () => {
    expect(await scanCodexMessageCount("/no/such/file")).toBe(0);
  });

  test("counts 0.130 response_item user/assistant pairs, skips developer/system + events", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "x", cwd: "/p" },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "policy" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "yo" }],
          },
        }),
      ].join("\n"),
    );
    expect(await scanCodexMessageCount(file)).toBe(2);
  });

  test("counts pre-0.130 flat-format role+content lines", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ role: "user", content: "hi", cwd: "/p" }),
        JSON.stringify({ role: "assistant", content: "yo" }),
        JSON.stringify({ role: "user", content: "again" }),
      ].join("\n"),
    );
    expect(await scanCodexMessageCount(file)).toBe(3);
  });
});

describe("scanCodexContextTokens", () => {
  test("returns 0 when the file is missing", async () => {
    expect(await scanCodexContextTokens("/no/such/file")).toBe(0);
  });

  test("estimates from 0.130 response_item content as chars/4", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    // 8-char user text + 12-char assistant text = 20 chars → 5 tokens.
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "x", cwd: "/p" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "abcdefgh" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ABCDEFGHIJKL" }],
          },
        }),
        // developer/system messages must not contribute
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "MASSIVE POLICY TEXT" }],
          },
        }),
      ].join("\n"),
    );
    expect(await scanCodexContextTokens(file)).toBe(5);
  });

  test("estimates from pre-0.130 flat role+content lines", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    // 4 + 8 = 12 chars → 3 tokens
    await writeFile(
      file,
      [
        JSON.stringify({ role: "user", content: "abcd", cwd: "/p" }),
        JSON.stringify({ role: "assistant", content: "ABCDEFGH" }),
      ].join("\n"),
    );
    expect(await scanCodexContextTokens(file)).toBe(3);
  });
});

describe("scanCodexTokenUsage", () => {
  test("returns all-undefined on a missing file", async () => {
    expect(await scanCodexTokenUsage("/no/such/file")).toEqual({
      lastInputTokens: undefined,
      modelContextWindow: undefined,
      model: undefined,
    });
  });

  test("returns all-undefined when no token_count events are present", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "x", cwd: "/p" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        }),
      ].join("\n"),
    );
    expect(await scanCodexTokenUsage(file)).toEqual({
      lastInputTokens: undefined,
      modelContextWindow: undefined,
      model: undefined,
    });
  });

  test("ignores token_count events whose info is null (no tokens yet)", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "token_count", info: null },
        }),
      ].join("\n"),
    );
    expect(await scanCodexTokenUsage(file)).toEqual({
      lastInputTokens: undefined,
      modelContextWindow: undefined,
      model: undefined,
    });
  });

  test("extracts last_token_usage.input_tokens + model_context_window from the latest token_count event", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    // Two token_count events; the later one wins.
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5.5", cwd: "/p" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 0,
                output_tokens: 50,
                reasoning_output_tokens: 10,
                total_tokens: 150,
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 0,
                output_tokens: 50,
                reasoning_output_tokens: 10,
                total_tokens: 150,
              },
              model_context_window: 258_400,
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 242_571,
                cached_input_tokens: 144_896,
                output_tokens: 2_775,
                reasoning_output_tokens: 1_106,
                total_tokens: 245_346,
              },
              last_token_usage: {
                input_tokens: 49_868,
                cached_input_tokens: 20_864,
                output_tokens: 670,
                reasoning_output_tokens: 496,
                total_tokens: 50_538,
              },
              model_context_window: 258_400,
            },
          },
        }),
      ].join("\n"),
    );
    const usage = await scanCodexTokenUsage(file);
    // We expose `lastInputTokens` as "what the model saw on the most
    // recent turn" — that's Codex's analog of Claude's full input
    // (input_tokens already includes cached_input_tokens, unlike
    // Claude's disjoint cache_read / cache_creation split, so we DO
    // NOT add cached_input_tokens on top).
    expect(usage.lastInputTokens).toBe(49_868);
    expect(usage.modelContextWindow).toBe(258_400);
    expect(usage.model).toBe("gpt-5.5");
  });

  test("uses the latest turn_context.payload.model when multiple are present", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5", cwd: "/p" },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5.5", cwd: "/p" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1 },
              last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1 },
              model_context_window: 200_000,
            },
          },
        }),
      ].join("\n"),
    );
    const usage = await scanCodexTokenUsage(file);
    expect(usage.model).toBe("gpt-5.5");
    expect(usage.lastInputTokens).toBe(1);
    expect(usage.modelContextWindow).toBe(200_000);
  });
});

describe("scanCodex", () => {
  test("returns empty when no candidate root exists", async () => {
    expect(await scanCodex(["/no/such/root"])).toEqual([]);
  });

  test("returns sessions from the first root that exists (flat layout)", async () => {
    const a = await tempDir("supergit-codex-a-");
    const b = await tempDir("supergit-codex-b-");
    await writeFile(
      join(b, "session-1.jsonl"),
      '{"cwd":"/Users/marcel/codex/proj","type":"event"}\n',
    );
    const sessions = await scanCodex(["/missing", a, b]);
    // a exists but is empty -> not returned; b yields one
    expect(sessions).toHaveLength(0); // a is the first existing, but empty
    const sessions2 = await scanCodex([b]);
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0]?.agent).toBe("codex");
    expect(sessions2[0]?.cwd).toBe(resolve("/Users/marcel/codex/proj"));
  });

  test("recurses into date-partitioned subdirs (codex 0.130+ layout)", async () => {
    // Codex 0.130 puts each session at:
    //   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<id>.jsonl
    // and stores cwd + session id under session_meta.payload, not at
    // the top level. Earlier versions used a flat root with a top-level
    // `cwd` field — both must still resolve.
    const root = await tempDir("supergit-codex-recurse-");
    const dated = join(root, "2026", "05", "12");
    await mkdir(dated, { recursive: true });
    await writeFile(
      join(dated, "rollout-2026-05-12T17-35-32-019e1bc1-9658-7a70-8529-42744e0c08ed.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-12T10:35:34.510Z",
        type: "session_meta",
        payload: {
          id: "019e1bc1-9658-7a70-8529-42744e0c08ed",
          cwd: "/Users/marcel/needle-engine",
          cli_version: "0.130.0",
        },
      }) + "\n",
    );
    const sessions = await scanCodex([root]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe(resolve("/Users/marcel/needle-engine"));
    // Prefer the payload.id (what `codex resume <id>` accepts) over
    // the filename, which is "rollout-<iso>-<id>" — calling resume
    // with that would fail.
    expect(sessions[0]?.sessionId).toBe(
      "019e1bc1-9658-7a70-8529-42744e0c08ed",
    );
  });

  test("the global history.jsonl is not treated as a session", async () => {
    // ~/.codex/history.jsonl is codex's shell-style command history,
    // not a session file. It has no cwd / no session_meta and would
    // confuse the agent strip if we picked it up.
    const root = await tempDir("supergit-codex-history-");
    // Drop a top-level history-like file with miscellaneous fields.
    await writeFile(
      join(root, "history.jsonl"),
      '{"command":"test","timestamp":"2026-05-12"}\n',
    );
    const sessions = await scanCodex([root]);
    expect(sessions).toEqual([]);
  });

  test("falls back to top-level `cwd` when session_meta isn't present", async () => {
    // Backwards compat: pre-0.130 codex (and the test-codex-rendering
    // fixture) put `cwd` on every line at the top level. Don't break
    // those when adding session_meta support.
    const root = await tempDir("supergit-codex-flat-");
    await writeFile(
      join(root, "flat.jsonl"),
      '{"cwd":"/proj","role":"user","content":"hi"}\n',
    );
    const sessions = await scanCodex([root]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe(resolve("/proj"));
    expect(sessions[0]?.sessionId).toBe("flat");
  });
});

describe("scanCopilot", () => {
  test("returns empty when root does not exist", async () => {
    expect(await scanCopilot("/no/such/copilot/root")).toEqual([]);
  });

  test("picks up workspaces that have a copilot-chat directory", async () => {
    const root = await tempDir("supergit-copilot-");
    const wsA = join(root, "hash-a");
    const wsB = join(root, "hash-b");
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    await writeFile(
      join(wsA, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/marcel/with-copilot" }),
    );
    await mkdir(join(wsA, "github.copilot-chat"), { recursive: true });
    await writeFile(
      join(wsB, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/marcel/without-copilot" }),
    );

    const sessions = await scanCopilot(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agent).toBe("copilot");
    expect(sessions[0]?.cwd).toBe(resolve("/Users/marcel/with-copilot"));
  });

  test("decodes percent-encoded file:// URIs", async () => {
    const root = await tempDir("supergit-copilot-enc-");
    const ws = join(root, "hash-x");
    await mkdir(ws, { recursive: true });
    await writeFile(
      join(ws, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/marcel/has%20space" }),
    );
    await mkdir(join(ws, "github.copilot-chat"), { recursive: true });
    const sessions = await scanCopilot(root);
    expect(sessions[0]?.cwd).toBe(resolve("/Users/marcel/has space"));
  });
});

describe("agentsForWorktree", () => {
  function s(
    cwd: string,
    agent: AgentSession["agent"] = "claude",
    lastActive = "2026-05-12T01:00:00Z",
  ): AgentSession {
    // Real scanners resolve() the cwd, so mirror that here.
    return { agent, cwd: resolve(cwd), lastActive, source: "" };
  }

  test("returns empty when no agent matches", () => {
    const sessions = [s("/elsewhere")];
    expect(agentsForWorktree("/repo", sessions)).toEqual([]);
  });

  test("matches an exact cwd", () => {
    const sessions = [s("/repo")];
    expect(agentsForWorktree("/repo", sessions)).toHaveLength(1);
  });

  test("matches a subdirectory of the worktree", () => {
    const sessions = [s("/repo/sub/dir")];
    expect(agentsForWorktree("/repo", sessions)).toHaveLength(1);
  });

  test("does not match a sibling path with the worktree as prefix", () => {
    const sessions = [s("/repo-sibling")];
    expect(agentsForWorktree("/repo", sessions)).toEqual([]);
  });

  test("sorts results newest-first", () => {
    const sessions = [
      s("/repo", "claude", "2026-05-12T01:00:00Z"),
      s("/repo", "codex", "2026-05-12T02:00:00Z"),
      s("/repo", "copilot", "2026-05-12T00:30:00Z"),
    ];
    const result = agentsForWorktree("/repo", sessions);
    expect(result.map((r) => r.agent)).toEqual(["codex", "claude", "copilot"]);
  });
});

describe("claudeProjectDirForCwd", () => {
  test("encodes / \\ : as -", async () => {
    const root = await tempDir("supergit-cpd-empty-");
    const got = await claudeProjectDirForCwd("C:\\git\\supergit", root);
    expect(got).toBe(join(root, "C--git-supergit"));
  });

  test("reuses an existing case-insensitive match instead of creating a new dir", async () => {
    const root = await tempDir("supergit-cpd-case-");
    // Pre-existing dir was created by Claude with lowercased casing.
    await mkdir(join(root, "c--git-supergit"), { recursive: true });
    const got = await claudeProjectDirForCwd("C:\\git\\supergit", root);
    expect(got).toBe(join(root, "c--git-supergit"));
  });

  test("returns the encoded path even when the projects root does not exist", async () => {
    const root = join(await tempDir("supergit-cpd-noroot-"), "does-not-exist");
    const got = await claudeProjectDirForCwd("/Users/me/proj", root);
    expect(got).toBe(join(root, "-Users-me-proj"));
  });
});

describe("scanImported", () => {
  test("returns [] when the imported-sessions directory does not exist", async () => {
    const ws = await tempDir("supergit-imported-empty-");
    expect(await scanImported(ws)).toEqual([]);
  });

  test("surfaces claude + codex imports with metadata from the sidecar", async () => {
    const ws = await tempDir("supergit-imported-");
    const claudeDir = join(ws, "imported-sessions", "marcels-mbp", "claude");
    const codexDir = join(ws, "imported-sessions", "alice-desktop", "codex");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    await writeFile(join(claudeDir, "sid-1.jsonl"), '{"hello":"world"}\n');
    await writeFile(
      join(claudeDir, "sid-1.manifest.json"),
      JSON.stringify({
        sid: "sid-1",
        title: "Refactor PTY scrub",
        originMachineLabel: "Marcel's MBP",
        localRepoPath: "/local/foo",
        localWorktreePath: "/local/foo/.worktrees/feat-x",
      }),
    );

    await writeFile(join(codexDir, "sid-2.jsonl"), "{}\n");
    await writeFile(
      join(codexDir, "sid-2.manifest.json"),
      JSON.stringify({
        sid: "sid-2",
        title: "Codex session",
        originMachineLabel: "Alice desktop",
        localRepoPath: "/local/bar",
      }),
    );

    const sessions = await scanImported(ws);
    expect(sessions.length).toBe(2);

    const c = sessions.find((s) => s.agent === "claude");
    const x = sessions.find((s) => s.agent === "codex");
    expect(c?.title).toBe("Refactor PTY scrub");
    expect(c?.importedFrom).toBe("Marcel's MBP");
    expect(c?.cwd).toBe(resolve("/local/foo/.worktrees/feat-x"));
    expect(c?.sessionId).toBe("sid-1");
    expect(x?.title).toBe("Codex session");
    expect(x?.cwd).toBe(resolve("/local/bar"));
    expect(x?.importedFrom).toBe("Alice desktop");
  });

  test("skips unknown agent subdirs", async () => {
    const ws = await tempDir("supergit-imported-unknown-");
    const dir = join(ws, "imported-sessions", "host", "skynet");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x.jsonl"), "{}");
    expect(await scanImported(ws)).toEqual([]);
  });

  test("still surfaces a session when its sidecar is missing — best-effort", async () => {
    const ws = await tempDir("supergit-imported-no-sidecar-");
    const dir = join(ws, "imported-sessions", "host", "claude");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "orphan.jsonl"), "{}");

    const sessions = await scanImported(ws);
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.sessionId).toBe("orphan");
    expect(sessions[0]?.title).toBeUndefined();
    expect(sessions[0]?.importedFrom).toBe("host");
  });

  test("claude import with importedJsonlPath points source at the claude-projects file (no sibling JSONL needed)", async () => {
    const ws = await tempDir("supergit-imported-cpd-");
    const cpd = await tempDir("supergit-imported-cpd-root-");
    const sidecarDir = join(ws, "imported-sessions", "marcels-mbp", "claude");
    const projDir = join(cpd, "-local-foo");
    await mkdir(sidecarDir, { recursive: true });
    await mkdir(projDir, { recursive: true });

    const jsonlPath = join(projDir, "sid-9.jsonl");
    await writeFile(jsonlPath, '{"cwd":"/local/foo"}\n');
    await writeFile(
      join(sidecarDir, "sid-9.manifest.json"),
      JSON.stringify({
        sid: "sid-9",
        title: "Claude in projects dir",
        originMachineLabel: "Marcel's MBP",
        localRepoPath: "/local/foo",
        importedJsonlPath: jsonlPath,
      }),
    );
    // Crucially: no sibling jsonl under imported-sessions/.../claude/.
    const sessions = await scanImported(ws);
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.source).toBe(jsonlPath);
    expect(sessions[0]?.sessionId).toBe("sid-9");
    expect(sessions[0]?.importedFrom).toBe("Marcel's MBP");
    expect(sessions[0]?.title).toBe("Claude in projects dir");
  });

  test("drops the entry when the sidecar points at a JSONL that no longer exists", async () => {
    const ws = await tempDir("supergit-imported-dangling-");
    const sidecarDir = join(ws, "imported-sessions", "host", "claude");
    await mkdir(sidecarDir, { recursive: true });
    await writeFile(
      join(sidecarDir, "sid-x.manifest.json"),
      JSON.stringify({
        sid: "sid-x",
        title: "Dangling",
        originMachineLabel: "host",
        localRepoPath: "/local/foo",
        importedJsonlPath: "/no/such/file.jsonl",
      }),
    );
    expect(await scanImported(ws)).toEqual([]);
  });
});


describe("groupSessionsByFolder", () => {
  function s(
    cwd: string,
    agent: AgentSession["agent"] = "claude",
    lastActive = "2026-05-12T01:00:00Z",
  ): AgentSession {
    return { agent, cwd: resolve(cwd), lastActive, source: "" };
  }

  test("groups multiple sessions sharing a cwd into one suggestion", () => {
    const sessions = [
      s("/repo/a", "claude", "2026-05-12T01:00:00Z"),
      s("/repo/a", "codex", "2026-05-12T02:00:00Z"),
      s("/repo/a", "claude", "2026-05-12T00:30:00Z"),
    ];
    const result = groupSessionsByFolder(sessions);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionCount).toBe(3);
    expect(result[0]!.lastActive).toBe("2026-05-12T02:00:00Z");
    expect(result[0]!.agents).toEqual(["claude", "codex"]);
  });

  test("skips sessions with empty cwd", () => {
    const sessions = [
      { agent: "claude", cwd: "", lastActive: "2026-05-12T01:00:00Z", source: "" } as AgentSession,
      s("/repo/b"),
    ];
    const result = groupSessionsByFolder(sessions);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(resolve("/repo/b"));
  });

  test("filters out folders in the suppress set", () => {
    const sessions = [s("/repo/a"), s("/repo/b")];
    const suppress = new Set<string>([
      process.platform === "win32"
        ? resolve("/repo/a").toLowerCase()
        : resolve("/repo/a"),
    ]);
    const result = groupSessionsByFolder(sessions, suppress);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(resolve("/repo/b"));
  });

  test("sorts suggestions newest-active first", () => {
    const sessions = [
      s("/repo/older", "claude", "2026-05-12T00:00:00Z"),
      s("/repo/newer", "claude", "2026-05-12T05:00:00Z"),
      s("/repo/middle", "claude", "2026-05-12T02:00:00Z"),
    ];
    const result = groupSessionsByFolder(sessions);
    expect(result.map((r) => r.name)).toEqual(["newer", "middle", "older"]);
  });

  test("returns empty when no sessions", () => {
    expect(groupSessionsByFolder([])).toEqual([]);
  });
});
