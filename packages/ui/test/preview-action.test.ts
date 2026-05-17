import { describe, expect, test } from "bun:test";
import {
  buildPreviewItems,
  extractLatestAction,
  summarizeToolInput,
  type PreviewActionMessage,
} from "../src/preview-action";

/**
 * Test fixtures below mimic the shape of real Claude session JSONL
 * the daemon normalises into `NormalizedMessage` (role + blocks
 * with type/text/toolName/toolInput) — but every string is
 * synthetic / anonymised. Never paste real chat content into these
 * tests, both for privacy and so the assertions don't drift if the
 * real-world data changes.
 */
function userMsg(text: string, opts: { timestamp?: string } = {}): PreviewActionMessage {
  return {
    role: "user",
    timestamp: opts.timestamp,
    blocks: [{ type: "text", text }],
  };
}
function aiText(text: string, opts: { timestamp?: string } = {}): PreviewActionMessage {
  return {
    role: "assistant",
    timestamp: opts.timestamp,
    blocks: [{ type: "text", text }],
  };
}
function aiToolUse(
  name: string,
  input: Record<string, unknown>,
  opts: { timestamp?: string } = {},
): PreviewActionMessage {
  return {
    role: "assistant",
    timestamp: opts.timestamp,
    blocks: [{ type: "tool_use", toolName: name, toolInput: input }],
  };
}
function aiMixed(
  blocks: PreviewActionMessage["blocks"],
  opts: { timestamp?: string } = {},
): PreviewActionMessage {
  return { role: "assistant", timestamp: opts.timestamp, blocks };
}

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
    // Hits the DETAIL_MAX_LEN cap (90 chars including the ellipsis).
    expect(out.length).toBe(90);
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

describe("buildPreviewItems", () => {
  test("empty / non-array input → empty list (no preview)", () => {
    expect(buildPreviewItems([])).toEqual([]);
    expect(buildPreviewItems(undefined as unknown as PreviewActionMessage[])).toEqual([]);
  });

  test("typical conversation: user → AI text → user → AI text", () => {
    // Most common shape: a few alternating turns, all with plain
    // text. Order is strictly chronological (oldest at top, newest
    // at bottom), latest user is at the bottom because it's the
    // newest message.
    const items = buildPreviewItems([
      userMsg("q1"),
      aiText("r1"),
      userMsg("q2"),
      aiText("r2"),
    ]);
    expect(items).toEqual([
      { kind: "msg", role: "assistant", text: "r1", timestamp: undefined },
      { kind: "msg", role: "user", text: "q2", timestamp: undefined },
      { kind: "msg", role: "assistant", text: "r2", timestamp: undefined },
    ]);
  });

  test("user message just sent, AI hasn't replied → user at the bottom", () => {
    // Mid-stream: user typed, AI hasn't produced any blocks yet.
    // The latest user message must land AFTER the older AI replies
    // in chronological order (it's the newest), not pinned on top.
    const items = buildPreviewItems([
      aiText("r1"),
      aiText("r2"),
      userMsg("q1"),
    ]);
    expect(items[items.length - 1]).toEqual({
      kind: "msg",
      role: "user",
      text: "q1",
      timestamp: undefined,
    });
  });

  test("only assistant messages → no user bubble, no gap", () => {
    const items = buildPreviewItems([aiText("r1"), aiText("r2")]);
    expect(items).toEqual([
      { kind: "msg", role: "assistant", text: "r1", timestamp: undefined },
      { kind: "msg", role: "assistant", text: "r2", timestamp: undefined },
    ]);
  });

  test("more than 3 assistants → only the last 3 appear, older skipped via gap pill", () => {
    const items = buildPreviewItems([
      userMsg("q1"),
      aiText("r1"),
      aiText("r2"),
      aiText("r3"),
      aiText("r4"),
      aiText("r5"),
    ]);
    // user (q1) + last 3 AIs (r3, r4, r5); skipped: r1, r2 → gap of 2
    // between user and r3.
    const kinds = items.map((it) => it.kind);
    expect(kinds).toEqual(["msg", "gap", "msg", "msg", "msg"]);
    expect(items[0]).toMatchObject({ kind: "msg", role: "user", text: "q1" });
    expect(items[1]).toEqual({ kind: "gap", count: 2 });
    expect((items[2] as { text: string }).text).toBe("r3");
    expect((items[4] as { text: string }).text).toBe("r5");
  });

  test("consecutive user turns merge into one bubble when no timestamps gate them", () => {
    // Without timestamps the gap check is a no-op, so a rapid-fire
    // sequence of user messages collapses into a single burst bubble
    // (newline-joined in chronological order). No gap pill — every
    // user message is "included" for gap-math purposes.
    const items = buildPreviewItems([
      userMsg("q1"),
      userMsg("q2"),
      userMsg("q3"),
      aiText("r1"),
    ]);
    const userBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "user",
    );
    expect(userBubbles).toHaveLength(1);
    expect((userBubbles[0] as { text: string }).text).toBe("q1\nq2\nq3");
    expect(items.filter((it) => it.kind === "gap")).toEqual([]);
  });

  test("user messages within 30s of each other merge into one burst bubble", () => {
    const base = new Date("2026-01-01T12:00:00Z").getTime();
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const items = buildPreviewItems([
      userMsg("q1", { timestamp: at(0) }),
      userMsg("q2", { timestamp: at(10_000) }), // +10s
      userMsg("q3", { timestamp: at(25_000) }), // +25s
      aiText("r1", { timestamp: at(40_000) }),
    ]);
    const userBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "user",
    );
    expect(userBubbles).toHaveLength(1);
    expect((userBubbles[0] as { text: string }).text).toBe("q1\nq2\nq3");
  });

  test("gap > 30s breaks the burst — only the post-gap user message survives", () => {
    const base = new Date("2026-01-01T12:00:00Z").getTime();
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    const items = buildPreviewItems([
      userMsg("old1", { timestamp: at(0) }),
      userMsg("old2", { timestamp: at(5_000) }),
      // Big pause — anything beyond 30s breaks the burst.
      userMsg("fresh", { timestamp: at(120_000) }),
      aiText("r1", { timestamp: at(125_000) }),
    ]);
    const userBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "user",
    );
    expect(userBubbles).toHaveLength(1);
    expect((userBubbles[0] as { text: string }).text).toBe("fresh");
  });

  test("merged burst is clamped to ~300 chars with an ellipsis", () => {
    const long = "a".repeat(400);
    const items = buildPreviewItems([userMsg(long), userMsg("tail")]);
    const userBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "user",
    );
    expect(userBubbles).toHaveLength(1);
    const text = (userBubbles[0] as { text: string }).text;
    expect(text.length).toBe(300);
    expect(text.endsWith("…")).toBe(true);
  });

  test("assistant between user turns breaks the burst — only post-assistant user is kept", () => {
    const items = buildPreviewItems([
      userMsg("first ask"),
      aiText("answer"),
      userMsg("followup"),
    ]);
    const userBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "user",
    );
    expect(userBubbles).toHaveLength(1);
    expect((userBubbles[0] as { text: string }).text).toBe("followup");
  });

  test("assistant with mixed text + tool_use → bubbles and chips render inline in source order", () => {
    const items = buildPreviewItems([
      aiMixed([
        { type: "text", text: "starting" },
        { type: "tool_use", toolName: "Read", toolInput: { file_path: "a.ts" } },
        { type: "text", text: "ok found it" },
        { type: "tool_use", toolName: "Edit", toolInput: { file_path: "a.ts" } },
        { type: "text", text: "done" },
      ]),
    ]);
    expect(items.map((it) => it.kind)).toEqual([
      "msg",
      "action",
      "msg",
      "action",
      "msg",
    ]);
    expect((items[0] as { text: string }).text).toBe("starting");
    expect((items[1] as { toolName: string }).toolName).toBe("Read");
    expect((items[3] as { toolName: string }).toolName).toBe("Edit");
  });

  test("adjacent text blocks coalesce into a single bubble", () => {
    const items = buildPreviewItems([
      aiMixed([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "text", text: "third" },
      ]),
    ]);
    expect(items).toEqual([
      { kind: "msg", role: "assistant", text: "first second third", timestamp: undefined },
    ]);
  });

  test("latest AI message with NO text and NO tool_use → typing-placeholder bubble appears", () => {
    // Mid-stream guarantee: the panel must show at least one row
    // for the latest assistant turn even when its block stream
    // hasn't produced anything yet. Older AI messages have content
    // so they render normally.
    const items = buildPreviewItems([
      userMsg("q1"),
      aiText("r1"),
      aiText("r2"),
      { role: "assistant", blocks: [] },
    ]);
    const last = items[items.length - 1]!;
    expect(last.kind).toBe("msg");
    expect((last as { role: string }).role).toBe("assistant");
    expect((last as { text: string }).text.length).toBeGreaterThan(0);
  });

  test("the placeholder is NOT added when an earlier (non-latest) AI is empty", () => {
    const items = buildPreviewItems([
      userMsg("q1"),
      { role: "assistant", blocks: [] }, // earlier empty, should NOT trigger placeholder
      aiText("r2"),
    ]);
    // Only the populated r2 should render as an assistant bubble.
    const aiBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "assistant",
    );
    expect(aiBubbles).toHaveLength(1);
    expect((aiBubbles[0] as { text: string }).text).toBe("r2");
  });

  test("Now: chip at top is suppressed when the latest action is inside the visible window", () => {
    // The latest assistant message contains the latest tool_use,
    // and it's within the displayed last-3 window — so the inline
    // tool chip is enough; the redundant top chip must not appear.
    const items = buildPreviewItems([
      userMsg("q1"),
      aiToolUse("Edit", { file_path: "a.ts" }),
    ]);
    const topIsAction = items[0]?.kind === "action";
    expect(topIsAction).toBe(false);
    // The chip *is* there inline, just not at the top.
    const actions = items.filter((it) => it.kind === "action");
    expect(actions).toHaveLength(1);
  });

  test("Now: chip at top appears when the latest action is outside the visible window", () => {
    // Push the only tool_use far back in history; the displayed
    // last-3 AIs are all plain text. The top chip should surface
    // so the user still sees what the agent did most recently in
    // its overall toolset history.
    const items = buildPreviewItems([
      aiToolUse("Edit", { file_path: "old.ts" }),
      aiText("r1"),
      aiText("r2"),
      aiText("r3"),
      aiText("r4"),
      userMsg("q1"),
    ]);
    expect(items[0]?.kind).toBe("action");
    expect((items[0] as { toolName: string }).toolName).toBe("Edit");
    expect((items[0] as { detail?: string }).detail).toBe("old.ts");
  });

  test("realistic mid-edit shape: user → AI(read,text,edit,text) → no follow-up yet", () => {
    // Mirrors the shape Claude emits during a typical file edit:
    // user types a request, AI reads a file, narrates, edits the
    // file, narrates again. We expect the panel to walk all 4
    // blocks in source order with two chips and two bubbles.
    const items = buildPreviewItems([
      userMsg("apply the change"),
      aiMixed([
        { type: "tool_use", toolName: "Read", toolInput: { file_path: "x.ts" } },
        { type: "text", text: "found the spot" },
        {
          type: "tool_use",
          toolName: "Edit",
          toolInput: { file_path: "x.ts", command: "ignored" },
        },
        { type: "text", text: "applied" },
      ]),
    ]);
    const kinds = items.map((it) => it.kind);
    expect(kinds).toEqual(["msg", "action", "msg", "action", "msg"]);
    expect((items[0] as { role: string }).role).toBe("user");
    expect((items[1] as { toolName: string }).toolName).toBe("Read");
    expect((items[1] as { detail?: string }).detail).toBe("x.ts");
    expect((items[3] as { toolName: string }).toolName).toBe("Edit");
    // file_path is earlier in the allowlist than command, so the
    // detail prefers it.
    expect((items[3] as { detail?: string }).detail).toBe("x.ts");
  });

  test("system / tool roles are ignored entirely", () => {
    const items = buildPreviewItems([
      userMsg("q1"),
      { role: "system", blocks: [{ type: "text", text: "sys" }] },
      { role: "tool", blocks: [{ type: "text", text: "tres" }] },
      aiText("r1"),
    ]);
    expect(items).toEqual([
      { kind: "msg", role: "user", text: "q1", timestamp: undefined },
      { kind: "msg", role: "assistant", text: "r1", timestamp: undefined },
    ]);
  });

  test("guarantee: latest AI text message is always shown, even if older than the visible window", () => {
    // The last three assistant turns are all tool-only (mid-edit
    // burst). The most recent AI *text* response is older — and
    // must still appear so the panel always answers "what did the
    // agent actually say" rather than just "what is it doing".
    const items = buildPreviewItems([
      userMsg("q1"),
      aiText("here's the plan"), // <-- the only AI text reply
      aiToolUse("Edit", { file_path: "a.ts" }),
      aiToolUse("Edit", { file_path: "b.ts" }),
      aiToolUse("Edit", { file_path: "c.ts" }),
      userMsg("q2"),
    ]);
    const aiTextBubbles = items.filter(
      (it) =>
        it.kind === "msg" &&
        it.role === "assistant" &&
        (it as { text: string }).text === "here's the plan",
    );
    expect(aiTextBubbles).toHaveLength(1);
  });

  test("guarantee no-op: when the latest AI message already contains text", () => {
    // If the last assistant turn already has text, no extra
    // force-include is needed and no duplicate bubble appears.
    const items = buildPreviewItems([
      userMsg("q1"),
      aiText("first reply"),
      aiText("second reply"),
    ]);
    const aiTextBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "assistant",
    );
    expect(aiTextBubbles).toHaveLength(2);
  });

  test("Claude routes tool_result under role:'user' — those must NOT shadow the real typed user input", () => {
    // In Claude's JSONL, when an agent's tool produces output it
    // comes back as `{ role: "user", content: [{ type: "tool_result",
    // ... }] }` — same role discriminator as a typed user turn.
    // The dock must select the latest *typed* user message (the
    // one with a real text block), not the most recent
    // user-role-with-tool_result.
    const items = buildPreviewItems([
      { role: "user", blocks: [{ type: "text", text: "please refactor X" }] },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", toolName: "Read", toolInput: { file_path: "x.ts" } }],
      },
      {
        role: "user",
        blocks: [{ type: "tool_result", text: "<contents of x.ts>" }],
      },
      { role: "assistant", blocks: [{ type: "text", text: "ok refactored" }] },
    ]);
    const userBubbles = items.filter(
      (it) => it.kind === "msg" && it.role === "user",
    );
    expect(userBubbles).toHaveLength(1);
    expect((userBubbles[0] as { text: string }).text).toBe("please refactor X");
    // And the tool_result's "text" content must not appear as a
    // bubble or leak into any other rendered slot.
    const stringified = JSON.stringify(items);
    expect(stringified).not.toContain("<contents of x.ts>");
  });

  test("user message with ONLY a typed text block renders as a bubble", () => {
    // Smoke test: the most common typed-user-input shape coming
    // out of /api/session is a single text block.
    const items = buildPreviewItems([
      { role: "user", blocks: [{ type: "text", text: "hello" }] },
      { role: "assistant", blocks: [{ type: "text", text: "hi" }] },
    ]);
    expect(items[0]).toEqual({
      kind: "msg",
      role: "user",
      text: "hello",
      timestamp: undefined,
    });
  });

  test("timestamps are preserved on each rendered bubble", () => {
    const items = buildPreviewItems([
      userMsg("q1", { timestamp: "2026-05-16T10:00:00Z" }),
      aiText("r1", { timestamp: "2026-05-16T10:00:05Z" }),
    ]);
    expect(items[0]).toMatchObject({ timestamp: "2026-05-16T10:00:00Z" });
    expect(items[1]).toMatchObject({ timestamp: "2026-05-16T10:00:05Z" });
  });
});
