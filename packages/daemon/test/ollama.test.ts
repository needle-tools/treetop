import { test, expect, describe } from "bun:test";
import { normalizeApiModels, parseOllamaListOutput } from "../src/ollama";
import { parseOllamaJsonl } from "../src/sessions";

describe("normalizeApiModels", () => {
  test("extracts name + size + parameterSize from /api/tags payload", () => {
    const body = {
      models: [
        {
          name: "llama3.2:3b",
          model: "llama3.2:3b",
          size: 2_000_000_000,
          details: { parameter_size: "3.0B" },
        },
        {
          name: "gemma:7b",
          size: 4_500_000_000,
          details: { parameter_size: "7.0B", family: "gemma" },
        },
      ],
    };
    const out = normalizeApiModels(body);
    expect(out).toEqual([
      { name: "llama3.2:3b", size: 2_000_000_000, parameterSize: "3.0B" },
      { name: "gemma:7b", size: 4_500_000_000, parameterSize: "7.0B" },
    ]);
  });

  test("falls back to `model` field when `name` is missing", () => {
    const out = normalizeApiModels({ models: [{ model: "foo:latest" }] });
    expect(out).toEqual([
      { name: "foo:latest", size: undefined, parameterSize: undefined },
    ]);
  });

  test("returns [] on garbage input", () => {
    expect(normalizeApiModels(null)).toEqual([]);
    expect(normalizeApiModels({})).toEqual([]);
    expect(normalizeApiModels({ models: "nope" })).toEqual([]);
    expect(normalizeApiModels({ models: [null, 5, "x"] })).toEqual([]);
  });

  test("skips entries without name/model", () => {
    const out = normalizeApiModels({
      models: [{ size: 1 }, { name: "ok:1" }],
    });
    expect(out).toEqual([
      { name: "ok:1", size: undefined, parameterSize: undefined },
    ]);
  });
});

describe("parseOllamaJsonl", () => {
  function build(entries: object[]): string {
    return entries.map((e) => JSON.stringify(e)).join("\n");
  }

  test("reads header metadata and exit timestamp", () => {
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/Users/me/proj",
        spawnCwd: "/Users/me/proj",
        model: "gemma4:latest",
        createdAt: "2026-01-01T00:00:00Z",
      },
      { kind: "exit", ts: "2026-01-01T00:00:10Z", code: 0 },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.agent).toBe("ollama");
    expect(out.cwd).toBe("/Users/me/proj");
    expect(out.sessionId).toBe("t-1");
    expect(out.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(out.endedAt).toBe("2026-01-01T00:00:10Z");
    expect(out.messages).toEqual([]);
  });

  test("ignores legacy PTY output entries", () => {
    // Pre-cleanup sessions contained `kind: "output"` chunks of raw
    // PTY bytes. The new parser doesn't try to recover turns from
    // them — they render as header-only.
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/p",
        spawnCwd: "/p",
        model: "m",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "output",
        ts: "2026-01-01T00:00:01Z",
        data: ">>> Send a message (/? for help)hi\nhello\n",
      },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.messages).toEqual([]);
  });

  test("returns an empty session on garbage input", () => {
    expect(parseOllamaJsonl("").messages).toEqual([]);
    expect(parseOllamaJsonl("not json\nalso garbage").messages).toEqual([]);
  });

  test("builds messages from structured `turn` entries", () => {
    // API-driven sessions write one `turn` entry per user/assistant
    // turn. The parser should take them verbatim — no PTY parsing,
    // no ANSI stripping, no placeholder repaint dance.
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/p",
        spawnCwd: "/p",
        model: "qwen3-coder:30b",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:01Z",
        role: "user",
        content: "hello qwen",
        model: "qwen3-coder:30b",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:03Z",
        role: "assistant",
        content: "Hi! What can I help with?",
        model: "qwen3-coder:30b",
      },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.messages).toEqual([
      {
        role: "user",
        blocks: [{ type: "text", text: "hello qwen" }],
        timestamp: "2026-01-01T00:00:01Z",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Hi! What can I help with?" }],
        author: "qwen3-coder:30b",
        timestamp: "2026-01-01T00:00:03Z",
      },
    ]);
  });

  test("turn entries beat output entries in the same file", () => {
    // Mixed file: a pre-cleanup session captured via PTY (output
    // entries) that was later continued via the chat API (turn
    // entries). Output entries are ignored entirely; only turns
    // contribute to the rendered conversation.
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/p",
        spawnCwd: "/p",
        model: "m",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "output",
        ts: "2026-01-01T00:00:01Z",
        data: ">>> Send a message (/? for help)pty hello\npty world\n",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:02Z",
        role: "user",
        content: "api hello",
        model: "m",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:03Z",
        role: "assistant",
        content: "api world",
        model: "m",
      },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.messages.map((m) => [m.role, m.blocks[0]?.text])).toEqual([
      ["user", "api hello"],
      ["assistant", "api world"],
    ]);
  });

  test("per-turn model attribution from turn entries", () => {
    // turn entries carry their own model — overrides whatever the
    // header said. Lets a multi-model conversation (user switched
    // models mid-chat) attribute each assistant bubble correctly.
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/p",
        spawnCwd: "/p",
        model: "gemma4:latest",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:01Z",
        role: "user",
        content: "q1",
        model: "gemma4:latest",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:02Z",
        role: "assistant",
        content: "gemma reply",
        model: "gemma4:latest",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:03Z",
        role: "user",
        content: "q2",
        model: "qwen3-coder:30b",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:04Z",
        role: "assistant",
        content: "qwen reply",
        model: "qwen3-coder:30b",
      },
    ]);
    const out = parseOllamaJsonl(text);
    const assistants = out.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.author)).toEqual([
      "gemma4:latest",
      "qwen3-coder:30b",
    ]);
  });

  test("turn entries with no model fall back to header model", () => {
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/p",
        spawnCwd: "/p",
        model: "fallback:latest",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:01Z",
        role: "user",
        content: "hi",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:02Z",
        role: "assistant",
        content: "hello",
      },
    ]);
    const out = parseOllamaJsonl(text);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant?.author).toBe("fallback:latest");
  });

  test("skips malformed turn entries without crashing", () => {
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/p",
        spawnCwd: "/p",
        model: "m",
        createdAt: "2026-01-01T00:00:00Z",
      },
      { kind: "turn", role: "user" }, // missing content
      { kind: "turn", role: "weird", content: "x" }, // bad role
      {
        kind: "turn",
        ts: "2026-01-01T00:00:02Z",
        role: "user",
        content: "real",
      },
      {
        kind: "turn",
        ts: "2026-01-01T00:00:03Z",
        role: "assistant",
        content: "ok",
      },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.messages.map((m) => [m.role, m.blocks[0]?.text])).toEqual([
      ["user", "real"],
      ["assistant", "ok"],
    ]);
  });
});

describe("parseOllamaListOutput", () => {
  test("parses the classic `ollama list` table", () => {
    const text = [
      "NAME                ID              SIZE      MODIFIED",
      "llama3.2:3b         abc123          2.0 GB    2 days ago",
      "gemma:7b            def456          4.5 GB    1 week ago",
    ].join("\n");
    const out = parseOllamaListOutput(text);
    expect(out.map((m) => m.name)).toEqual(["llama3.2:3b", "gemma:7b"]);
    expect(out[0]!.size).toBe(2 * 1024 ** 3);
    expect(out[1]!.size).toBe(Math.round(4.5 * 1024 ** 3));
  });

  test("returns [] on empty output", () => {
    expect(parseOllamaListOutput("")).toEqual([]);
    expect(parseOllamaListOutput("\n\n")).toEqual([]);
  });

  test("tolerates output without a header row", () => {
    const text = "phi3:mini  xyz  1.0 GB  yesterday";
    const out = parseOllamaListOutput(text);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("phi3:mini");
  });

  test("parses MB-sized models", () => {
    const text = [
      "NAME       ID    SIZE      MODIFIED",
      "tiny:1m    abc   350 MB    just now",
    ].join("\n");
    const out = parseOllamaListOutput(text);
    expect(out[0]!.size).toBe(350 * 1024 ** 2);
  });
});
