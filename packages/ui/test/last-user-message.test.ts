import { describe, it, expect } from "bun:test";
import {
  lastUserMessageBurst,
  lastUserMessageWithContext,
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
    expect(
      lastUserMessageWithContext(msgs, lastUserMessageBurst(msgs)),
    ).toBe("continue plz");
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
