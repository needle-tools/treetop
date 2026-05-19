import { test, expect, describe } from "bun:test";
import { normalizeApiModels, parseOllamaListOutput } from "../src/ollama";

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
