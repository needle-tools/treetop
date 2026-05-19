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
    expect(out).toEqual([{ name: "foo:latest", size: undefined, parameterSize: undefined }]);
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
    expect(out).toEqual([{ name: "ok:1", size: undefined, parameterSize: undefined }]);
  });
});

describe("parseOllamaJsonl", () => {
  function build(entries: object[]): string {
    return entries.map((e) => JSON.stringify(e)).join("\n");
  }

  test("recovers user/assistant turns from captured PTY output", () => {
    const text = build([
      {
        kind: "header",
        termId: "t-1",
        wt: "/Users/me/proj",
        spawnCwd: "/Users/me/proj",
        model: "gemma4:latest",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "output",
        ts: "2026-01-01T00:00:01Z",
        data: ">>> Send a message (/? for help)hello gemma\nHello! How can I help you today?\n\n",
      },
      {
        kind: "output",
        ts: "2026-01-01T00:00:05Z",
        data: ">>> Send a message (/? for help)what's 2+2?\n2+2 = 4\n",
      },
      { kind: "exit", ts: "2026-01-01T00:00:10Z", code: 0 },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.agent).toBe("ollama");
    expect(out.cwd).toBe("/Users/me/proj");
    expect(out.sessionId).toBe("t-1");
    expect(out.startedAt).toBe("2026-01-01T00:00:00Z");
    expect(out.endedAt).toBe("2026-01-01T00:00:10Z");
    expect(out.messages.map((m) => [m.role, m.blocks[0]?.text ?? ""])).toEqual([
      ["user", "hello gemma"],
      ["assistant", "Hello! How can I help you today?"],
      ["user", "what's 2+2?"],
      ["assistant", "2+2 = 4"],
    ]);
  });

  test("ignores TUI placeholder repaints and ANSI escapes", () => {
    // The Ollama TUI repaints `Send a message (/? for help)` multiple
    // times on the prompt line, often with ANSI cursor moves between.
    // Both should be stripped so the user input survives clean.
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
        data:
          ">>> Send a message (/? for help)\x1B[KSend a message (/? for help)who are you?\n" +
          "\x1B[1mI am a helper.\x1B[0m\n\n",
      },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.messages).toEqual([
      { role: "user", blocks: [{ type: "text", text: "who are you?" }] },
      { role: "assistant", blocks: [{ type: "text", text: "I am a helper." }] },
    ]);
  });

  test("skips banners before the first prompt", () => {
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
        data: "Loading model m...\nReady.\n>>> Send a message (/? for help)hi\nhello\n",
      },
    ]);
    const out = parseOllamaJsonl(text);
    expect(out.messages.length).toBe(2);
    expect(out.messages[0]?.role).toBe("user");
    expect(out.messages[0]?.blocks[0]?.text).toBe("hi");
  });

  test("returns an empty session on garbage input", () => {
    expect(parseOllamaJsonl("").messages).toEqual([]);
    expect(parseOllamaJsonl("not json\nalso garbage").messages).toEqual([]);
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
