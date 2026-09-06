import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditSessionCorpora,
  sessionAuditThresholdFailures,
} from "../../../scripts/audit-agent-sessions";

describe("auditSessionCorpora", () => {
  test("measures parser, protocol, tool pairing, and nicifier coverage with bounded examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "supergit-session-audit-"));
    const claudeRoot = join(root, "claude");
    const codexRoot = join(root, "codex");
    await mkdir(claudeRoot);
    await mkdir(codexRoot);

    await writeFile(
      join(claudeRoot, "claude.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: "claude-1",
          cwd: "/repo",
          message: { role: "user", content: "check it" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: { command: "git status --short" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: "" },
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "second protocol record for the same call",
              },
            ],
          },
        }),
        JSON.stringify({ type: "progress", data: { type: "hook_progress" } }),
        JSON.stringify({ type: "future_claude_shape", payload: {} }),
        "{not-json",
      ].join("\n"),
    );

    await writeFile(
      join(codexRoot, "codex.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "run it" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-2",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "git status --short && frobnicate --all",
            }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "frobnicate --all" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "done",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
              },
              total_token_usage: {
                input_tokens: 18_197_866,
                output_tokens: 95_682,
                total_tokens: 18_293_548,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 0,
              },
              total_token_usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 258_400,
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
              last_token_usage: {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 19_103,
              },
              total_token_usage: {
                input_tokens: 18_197_866,
                output_tokens: 95_682,
                total_tokens: 18_293_548,
              },
              model_context_window: 258_400,
            },
          },
        }),
        JSON.stringify({ type: "future_codex_shape", payload: {} }),
      ].join("\n"),
    );

    const report = await auditSessionCorpora({
      roots: [
        { agent: "claude", path: claudeRoot },
        { agent: "codex", path: codexRoot },
      ],
      exampleLimit: 1,
      progress: false,
    });

    expect(report.totals).toMatchObject({
      files: 2,
      rows: 15,
      validJsonRows: 14,
      malformedRows: 1,
      unknownRows: 2,
      commands: 3,
      nicifiedCommands: 2,
      fullyNicifiedCommands: 1,
      partiallyNicifiedCommands: 1,
    });
    expect(report.totals.protocolCoveragePct).toBeCloseTo(85.71, 1);
    expect(report.totals.nicifierCoveragePct).toBeCloseTo(66.67, 1);
    expect(report.totals.fullNicifierCoveragePct).toBeCloseTo(33.33, 1);
    expect(report.providers.codex.nicifierFamilies.git).toMatchObject({
      commands: 1,
      nicifiedCommands: 1,
      fullyNicifiedCommands: 0,
      partiallyNicifiedCommands: 1,
    });
    expect(report.providers.claude.sessions).toMatchObject({
      total: 1,
      withUser: 1,
      withAssistant: 1,
      empty: 0,
    });
    expect(report.providers.claude.tools).toMatchObject({
      calls: 1,
      results: 2,
      matchedResults: 2,
      sameIdAdditionalRecords: 1,
      sameIdEquivalentRecords: 0,
      sameIdOverlappingRecords: 0,
      sameIdDifferentRecords: 1,
      unmatchedResults: 0,
      resultsWithoutId: 0,
    });
    expect(report.providers.codex.tokens).toMatchObject({
      rows: 3,
      messages: 1,
      contextSnapshots: 2,
      invalid: 0,
    });
    expect(report.providers.codex.tokenInvalidExamples).toEqual([]);
    expect(report.providers.codex.topUnnicifiedCommandHeads[0]).toEqual({
      value: "frobnicate",
      count: 2,
    });
    expect(report.providers.codex.unknownExamples).toHaveLength(1);
    expect(report.providers.codex.unknownExamples[0]?.shape).toBe(
      "future_codex_shape",
    );
    expect(report.providers.codex.topUnknownShapes[0]).toEqual({
      value: "future_codex_shape",
      count: 1,
    });
    expect(report.providers.codex.topNonRenderedShapes).toContainEqual({
      value: "session_meta",
      count: 1,
    });
    expect(
      sessionAuditThresholdFailures(report, {
        protocol: 90,
        nicifier: 60,
        maxMalformed: 0,
        maxUnknown: 1,
      }),
    ).toEqual([
      "protocol coverage 85.7143% is below 90%",
      "complete nicifier coverage 33.3333% is below 60%",
      "malformed rows 1 exceed 0",
      "unknown rows 2 exceed 1",
    ]);
  });
});
