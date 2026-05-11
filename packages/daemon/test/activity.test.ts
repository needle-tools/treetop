import { test, expect, describe } from "bun:test";
import { summarize } from "../src/activity";

describe("summarize (claude)", () => {
  test("returns null for non-objects", () => {
    expect(summarize("claude", null)).toBeNull();
    expect(summarize("claude", "string")).toBeNull();
    expect(summarize("claude", 42)).toBeNull();
  });

  test("string user message → '← prompt'", () => {
    const r = summarize("claude", {
      type: "user",
      message: { content: "hello world" },
    });
    expect(r).toBe("← hello world");
  });

  test("truncates long user messages", () => {
    const long = "x".repeat(200);
    const r = summarize("claude", {
      type: "user",
      message: { content: long },
    });
    expect(r?.endsWith("…")).toBe(true);
    expect(r!.length).toBeLessThanOrEqual(82);
  });

  test("array content (user, text blocks) collapses to one line", () => {
    const r = summarize("claude", {
      type: "user",
      message: {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    });
    expect(r).toBe("← first second");
  });

  test("assistant tool_use returns 'name(target)'", () => {
    const r = summarize("claude", {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/Users/me/src/foo.ts" } }],
      },
    });
    expect(r).toBe("Edit(/Users/me/src/foo.ts)");
  });

  test("assistant tool_use with `command` falls back to that", () => {
    const r = summarize("claude", {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
      },
    });
    expect(r).toBe("Bash(bun test)");
  });

  test("long file paths are tail-truncated", () => {
    const path = "/very/deep/nested/" + "x/".repeat(60) + "file.ts";
    const r = summarize("claude", {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: path } }],
      },
    });
    expect(r?.startsWith("Read(…")).toBe(true);
    expect(r?.endsWith("file.ts)")).toBe(true);
  });

  test("assistant text-only response → '→ ...'", () => {
    const r = summarize("claude", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Sure, here's the plan" }],
      },
    });
    expect(r).toBe("→ Sure, here's the plan");
  });

  test("returns null for unknown entry types", () => {
    expect(summarize("claude", { type: "summary", summary: "x" })).toBeNull();
    expect(summarize("claude", { type: "tool_result" })).toBeNull();
  });
});

describe("summarize (codex)", () => {
  test("role + content → arrowed line", () => {
    expect(summarize("codex", { role: "user", content: "hi" })).toBe("← hi");
    expect(summarize("codex", { role: "assistant", content: "ok" })).toBe(
      "→ ok",
    );
  });

  test("falls back to type for other events", () => {
    expect(summarize("codex", { type: "tool_call" })).toBe("tool_call");
  });

  test("returns null when nothing matches", () => {
    expect(summarize("codex", { foo: 1 })).toBeNull();
  });
});
