import { test, expect, describe } from "bun:test";
import { sampleSessionForSummary } from "../src/ollama-summarize";
import type { NormalizedMessage } from "../src/sessions";

/** Build a user/assistant text message. */
function txt(role: "user" | "assistant", text: string): NormalizedMessage {
  return { role, blocks: [{ type: "text", text }] };
}

/** A long stretch of N text messages, alternating roles. Each body
 *  is short so the budget never kicks in for these tests. */
function stretch(n: number): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(txt(i % 2 === 0 ? "user" : "assistant", `m${i}`));
  }
  return out;
}

describe("sampleSessionForSummary", () => {
  test("returns empty diagnostics for an empty session", () => {
    const s = sampleSessionForSummary([]);
    expect(s.prompt).toBe("");
    expect(s.totalMessages).toBe(0);
    expect(s.includedMessages).toBe(0);
    expect(s.truncatedMessages).toBe(0);
    expect(s.estimatedTokens).toBe(0);
  });

  test("returns empty when only non-text blocks are present", () => {
    // Sessions that ran tool calls but never produced user/assistant
    // text — the prompt would be useless to summarise.
    const messages: NormalizedMessage[] = [
      { role: "assistant", blocks: [{ type: "tool_use", toolName: "Read" }] },
      { role: "user", blocks: [{ type: "tool_result", text: "ok" }] },
      { role: "assistant", blocks: [{ type: "thinking", text: "hmm" }] },
    ];
    const s = sampleSessionForSummary(messages);
    expect(s.prompt).toBe("");
    expect(s.totalMessages).toBe(0);
    expect(s.includedMessages).toBe(0);
  });

  test("skips system + tool roles", () => {
    const messages: NormalizedMessage[] = [
      { role: "system", blocks: [{ type: "text", text: "you are a helper" }] },
      txt("user", "hello"),
      { role: "tool", blocks: [{ type: "text", text: "output" }] },
      txt("assistant", "hi"),
    ];
    const s = sampleSessionForSummary(messages);
    expect(s.totalMessages).toBe(2);
    expect(s.prompt).toContain("User: hello");
    expect(s.prompt).toContain("Assistant: hi");
    expect(s.prompt).not.toContain("you are a helper");
    expect(s.prompt).not.toContain("output");
  });

  test("drops thinking, tool_use, tool_result, system_reminder, ide_context, command, marker-only mixed blocks", () => {
    const messages: NormalizedMessage[] = [
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "internal reasoning" },
          { type: "text", text: "the visible answer" },
          { type: "tool_use", toolName: "Write" },
        ],
      },
      {
        role: "user",
        blocks: [
          { type: "ide_context", text: "<file>" },
          { type: "system_reminder", text: "<reminder>" },
          { type: "command", text: "/clear" },
          { type: "text", text: "actual user prompt" },
        ],
      },
    ];
    const s = sampleSessionForSummary(messages);
    expect(s.includedMessages).toBe(2);
    expect(s.prompt).toContain("the visible answer");
    expect(s.prompt).toContain("actual user prompt");
    expect(s.prompt).not.toContain("internal reasoning");
    expect(s.prompt).not.toContain("/clear");
    expect(s.prompt).not.toContain("<file>");
    expect(s.prompt).not.toContain("<reminder>");
  });

  test("N <= target: every message included in order, no omission markers", () => {
    const s = sampleSessionForSummary(stretch(10), { targetMessages: 30 });
    expect(s.includedMessages).toBe(10);
    expect(s.totalMessages).toBe(10);
    expect(s.prompt).not.toMatch(/messages omitted/);
    // Order preserved.
    const firstM0 = s.prompt.indexOf("m0");
    const firstM9 = s.prompt.indexOf("m9");
    expect(firstM0).toBeGreaterThanOrEqual(0);
    expect(firstM9).toBeGreaterThan(firstM0);
  });

  test("N >> target: head + middle + tail with two omission markers", () => {
    // 100 messages, target 30 → head 12, mid 6, tail 12 = 30 included.
    const s = sampleSessionForSummary(stretch(100), { targetMessages: 30 });
    expect(s.totalMessages).toBe(100);
    expect(s.includedMessages).toBe(30);
    // First chunk: m0..m11 should all be in the prompt.
    for (let i = 0; i < 12; i++) {
      expect(s.prompt).toContain(`m${i}`);
    }
    // Last chunk: m88..m99 should be in the prompt.
    for (let i = 88; i < 100; i++) {
      expect(s.prompt).toContain(`m${i}`);
    }
    // Two omission markers, in order, with non-zero counts.
    const matches = [...s.prompt.matchAll(/\[… (\d+) messages omitted …\]/g)];
    expect(matches.length).toBe(2);
    const omittedTotal = matches.reduce((acc, m) => acc + Number(m[1]), 0);
    // 100 total - 30 included = 70 omitted (sum across both markers).
    expect(omittedTotal).toBe(70);
  });

  test("per-message truncation: oversized body gets clipped with the truncated suffix", () => {
    const long = "x".repeat(5000);
    const messages: NormalizedMessage[] = [txt("user", long)];
    const s = sampleSessionForSummary(messages, {
      targetMessages: 30,
      maxMsgChars: 200,
    });
    expect(s.truncatedMessages).toBe(1);
    expect(s.prompt).toContain("…<truncated>");
    // The full original body must not have survived.
    expect(s.prompt).not.toContain(long);
    // Clipped body length is bounded.
    expect(s.prompt.length).toBeLessThan(long.length);
  });

  test("budget enforcement: shrinks per-message size first, then count, until under budget", () => {
    // 50 messages, each ~1 KB. Default per-msg cap 2 KB, default
    // budget 32 KB → wouldn't fit. The sampler must shrink and
    // surface a prompt within budget.
    const messages: NormalizedMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(
        txt(i % 2 === 0 ? "user" : "assistant", `[${i}] ` + "y".repeat(1024)),
      );
    }
    const s = sampleSessionForSummary(messages, {
      targetMessages: 30,
      maxMsgChars: 2048,
      budgetChars: 8 * 1024,
    });
    expect(s.prompt.length).toBeLessThanOrEqual(8 * 1024);
    expect(s.totalMessages).toBe(50);
    expect(s.includedMessages).toBeGreaterThan(0);
    // At least some messages had to be clipped.
    expect(s.truncatedMessages).toBeGreaterThan(0);
  });

  test("estimatedTokens matches chars/4 of the rendered prompt", () => {
    const s = sampleSessionForSummary(stretch(10));
    expect(s.estimatedTokens).toBe(Math.ceil(s.prompt.length / 4));
  });

  test("preserves chronological order across head/mid/tail", () => {
    const s = sampleSessionForSummary(stretch(100), { targetMessages: 30 });
    // m0 < m50 (middle) < m99 in prompt order.
    const i0 = s.prompt.indexOf("m0");
    const i50 = s.prompt.indexOf("m50");
    const i99 = s.prompt.indexOf("m99");
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(i50).toBeGreaterThan(i0);
    expect(i99).toBeGreaterThan(i50);
  });

  test("renders role labels as `User:` / `Assistant:` separated by blank lines", () => {
    const s = sampleSessionForSummary([
      txt("user", "hello"),
      txt("assistant", "hi"),
    ]);
    // Blank line between turns so a small model parses them cleanly.
    expect(s.prompt).toBe("User: hello\n\nAssistant: hi");
  });
});

describe("sampleSessionForSummary with context-handoff budget", () => {
  function txt(role: "user" | "assistant", text: string): NormalizedMessage {
    return { role, blocks: [{ type: "text", text }] };
  }

  const CONTEXT_OPTS = {
    targetMessages: 60,
    maxMsgChars: 4096,
    budgetChars: 64 * 1024,
  };

  test("includes up to 60 messages with larger budget", () => {
    const msgs: NormalizedMessage[] = [];
    for (let i = 0; i < 80; i++) {
      msgs.push(txt(i % 2 === 0 ? "user" : "assistant", `message ${i}`));
    }
    const s = sampleSessionForSummary(msgs, CONTEXT_OPTS);
    expect(s.totalMessages).toBe(80);
    expect(s.includedMessages).toBeLessThanOrEqual(60);
    expect(s.includedMessages).toBeGreaterThan(30);
    expect(s.prompt).toContain("User:");
    expect(s.prompt).toContain("Assistant:");
  });

  test("allows individual messages up to 4096 chars before truncation", () => {
    const longText = "x".repeat(5000);
    const msgs = [txt("user", longText), txt("assistant", "short")];
    const s = sampleSessionForSummary(msgs, CONTEXT_OPTS);
    expect(s.truncatedMessages).toBe(1);
    expect(s.prompt).toContain("…<truncated>");
    expect(s.prompt.length).toBeLessThan(5000);
  });

  test("fits within 64KB budget even with many long messages", () => {
    const msgs: NormalizedMessage[] = [];
    for (let i = 0; i < 100; i++) {
      msgs.push(txt(i % 2 === 0 ? "user" : "assistant", "y".repeat(3000)));
    }
    const s = sampleSessionForSummary(msgs, CONTEXT_OPTS);
    expect(s.prompt.length).toBeLessThanOrEqual(64 * 1024);
    expect(s.includedMessages).toBeGreaterThan(0);
  });

  test("inserts gap markers for omitted messages", () => {
    const msgs: NormalizedMessage[] = [];
    for (let i = 0; i < 100; i++) {
      msgs.push(txt(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));
    }
    const s = sampleSessionForSummary(msgs, CONTEXT_OPTS);
    expect(s.prompt).toContain("messages omitted");
  });
});
