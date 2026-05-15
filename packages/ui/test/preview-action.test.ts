import { describe, expect, test } from "bun:test";
import {
  extractLatestAction,
  summarizeToolInput,
  type PreviewActionMessage,
} from "../src/preview-action";

describe("summarizeToolInput", () => {
  test("returns undefined for non-objects", () => {
    expect(summarizeToolInput(undefined)).toBeUndefined();
    expect(summarizeToolInput(null)).toBeUndefined();
    expect(summarizeToolInput("file.ts")).toBeUndefined();
    expect(summarizeToolInput(42)).toBeUndefined();
  });

  test("picks file_path when present", () => {
    expect(summarizeToolInput({ file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  test("falls through to path / command / pattern in priority order", () => {
    // path beats command (it's earlier in the allowlist)
    expect(summarizeToolInput({ path: "/tmp/x", command: "ls" })).toBe("/tmp/x");
    expect(summarizeToolInput({ command: "git status" })).toBe("git status");
    expect(summarizeToolInput({ pattern: "*.svelte" })).toBe("*.svelte");
    expect(summarizeToolInput({ url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(summarizeToolInput({ query: "needle" })).toBe("needle");
    expect(summarizeToolInput({ notebook_path: "n.ipynb" })).toBe("n.ipynb");
  });

  test("ignores empty strings and non-string values", () => {
    expect(summarizeToolInput({ file_path: "" })).toBeUndefined();
    expect(summarizeToolInput({ file_path: 7 })).toBeUndefined();
    expect(summarizeToolInput({ file_path: null })).toBeUndefined();
  });

  test("truncates long values with an ellipsis", () => {
    const long = "a".repeat(120);
    const out = summarizeToolInput({ file_path: long })!;
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  test("returns undefined for objects without any recognised field", () => {
    expect(summarizeToolInput({ foo: "bar", baz: 1 })).toBeUndefined();
  });
});

describe("extractLatestAction", () => {
  test("returns null for empty / non-array input", () => {
    expect(extractLatestAction([])).toBeNull();
    expect(extractLatestAction(undefined as unknown as PreviewActionMessage[])).toBeNull();
  });

  test("returns null when there are no tool_use blocks", () => {
    const msgs: PreviewActionMessage[] = [
      { role: "user", blocks: [{ type: "text" }] },
      { role: "assistant", blocks: [{ type: "text" }] },
    ];
    expect(extractLatestAction(msgs)).toBeNull();
  });

  test("returns null when tool_use is on a non-assistant message", () => {
    // Defensive: user-role messages should never carry tool_use,
    // and if they ever did, the panel shouldn't pretend the user is
    // 'doing' the action.
    const msgs: PreviewActionMessage[] = [
      {
        role: "user",
        blocks: [{ type: "tool_use", toolName: "Edit", toolInput: { file_path: "x" } }],
      },
    ];
    expect(extractLatestAction(msgs)).toBeNull();
  });

  test("returns null when the tool_use block has no toolName", () => {
    const msgs: PreviewActionMessage[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_use", toolInput: { file_path: "x" } }],
      },
    ];
    expect(extractLatestAction(msgs)).toBeNull();
  });

  test("picks the most recent tool_use across messages", () => {
    const msgs: PreviewActionMessage[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", toolName: "Read", toolInput: { file_path: "a.ts" } },
        ],
      },
      { role: "user", blocks: [{ type: "text" }] },
      {
        role: "assistant",
        blocks: [
          { type: "text" },
          { type: "tool_use", toolName: "Edit", toolInput: { file_path: "b.ts" } },
        ],
      },
    ];
    expect(extractLatestAction(msgs)).toEqual({
      kind: "action",
      toolName: "Edit",
      detail: "b.ts",
    });
  });

  test("walks to the LAST tool_use within the latest assistant message", () => {
    // When an assistant message bundles multiple tool calls, the
    // chip should reflect the *latest* call in that message —
    // that's the action still in flight.
    const msgs: PreviewActionMessage[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", toolName: "Read", toolInput: { file_path: "a.ts" } },
          { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" } },
        ],
      },
    ];
    expect(extractLatestAction(msgs)).toEqual({
      kind: "action",
      toolName: "Bash",
      detail: "ls",
    });
  });

  test("omits detail when toolInput has no recognised field", () => {
    const msgs: PreviewActionMessage[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_use", toolName: "Thinking", toolInput: {} }],
      },
    ];
    expect(extractLatestAction(msgs)).toEqual({
      kind: "action",
      toolName: "Thinking",
      detail: undefined,
    });
  });

  test("skips assistant messages with no blocks but keeps walking back", () => {
    const msgs: PreviewActionMessage[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_use", toolName: "Edit", toolInput: { file_path: "x.ts" } }],
      },
      { role: "assistant" },
      { role: "assistant", blocks: [{ type: "text" }] },
    ];
    expect(extractLatestAction(msgs)).toEqual({
      kind: "action",
      toolName: "Edit",
      detail: "x.ts",
    });
  });
});
