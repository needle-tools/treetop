import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, readTailChunk } from "../src/activity";

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
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/Users/me/src/foo.ts" },
          },
        ],
      },
    });
    expect(r).toBe("Edit(/Users/me/src/foo.ts)");
  });

  test("assistant tool_use with `command` falls back to that", () => {
    const r = summarize("claude", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "bun test" } },
        ],
      },
    });
    expect(r).toBe("Bash(bun test)");
  });

  test("long file paths are tail-truncated", () => {
    const path = "/very/deep/nested/" + "x/".repeat(60) + "file.ts";
    const r = summarize("claude", {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: path } },
        ],
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

describe("readTailChunk", () => {
  async function tempFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "supergit-activity-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, content);
    return path;
  }

  test("returns null for a missing file", async () => {
    expect(await readTailChunk("/no/such/file.jsonl", 0)).toBeNull();
  });

  test("reads new bytes appended after offset", async () => {
    const path = await tempFile("line1\nline2\n");
    const r = await readTailChunk(path, 6); // skip "line1\n"
    expect(r).not.toBeNull();
    expect(r!.text).toBe("line2\n");
    expect(r!.newOffset).toBe(12);
  });

  test("returns empty text when file has not grown", async () => {
    const path = await tempFile("hello\n");
    const r = await readTailChunk(path, 6);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("");
    expect(r!.newOffset).toBe(6);
  });

  test("handles file truncation (offset > current size)", async () => {
    const path = await tempFile("short");
    const r = await readTailChunk(path, 9999);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("");
    expect(r!.newOffset).toBe(5);
  });

  test("does not crash with negative length (the race scenario)", async () => {
    const path = await tempFile("ab");
    // Simulate: offset was bumped past file size by a concurrent call.
    // readTailChunk must not crash — it should return a reset offset.
    const r = await readTailChunk(path, 5000);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("");
    expect(r!.newOffset).toBe(2);
  });
});
