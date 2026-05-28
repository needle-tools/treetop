import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractFirstJsonObject,
  repairClaudeJson,
} from "../src/claude-json-repair";

describe("extractFirstJsonObject", () => {
  test("returns null for empty string", () => {
    expect(extractFirstJsonObject("")).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(extractFirstJsonObject("[1,2,3]")).toBeNull();
    expect(extractFirstJsonObject("hello")).toBeNull();
  });

  test("returns the whole string for valid JSON", () => {
    const input = '{"a": 1, "b": "hello"}';
    const result = extractFirstJsonObject(input)!;
    expect(result.json).toEqual({ a: 1, b: "hello" });
    expect(result.source).toBe(input);
  });

  test("extracts first object when a second chunk is appended", () => {
    const first = '{"allowedTools": ["Bash"], "enabled": true}';
    const second = '{"allowedTools": ["Bash"], "enabled": true}';
    const result = extractFirstJsonObject(first + second)!;
    expect(result.json).toEqual({ allowedTools: ["Bash"], enabled: true });
    expect(result.source).toBe(first);
  });

  test("extracts first object when trailing garbage is appended", () => {
    const first = '{"key": "value"}';
    const result = extractFirstJsonObject(first + "nd !== null, 10000);")!;
    expect(result.json).toEqual({ key: "value" });
    expect(result.source).toBe(first);
  });

  test("handles nested braces correctly", () => {
    const input = '{"a": {"b": {"c": 1}}, "d": 2}extra stuff';
    const result = extractFirstJsonObject(input)!;
    expect(result.json).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  test("handles strings containing braces", () => {
    const input = '{"code": "if (x) { return }"}trailing';
    const result = extractFirstJsonObject(input)!;
    expect(result.json).toEqual({ code: "if (x) { return }" });
  });

  test("handles escaped quotes in strings", () => {
    const input = '{"msg": "say \\"hello\\""}extra';
    const result = extractFirstJsonObject(input)!;
    expect(result.json).toEqual({ msg: 'say "hello"' });
  });

  test("handles strings containing backslashes", () => {
    const input = '{"path": "C:\\\\Users\\\\foo"}extra';
    const result = extractFirstJsonObject(input)!;
    expect(result.json).toEqual({ path: "C:\\Users\\foo" });
  });

  test("returns null for truncated JSON (unclosed brace)", () => {
    expect(extractFirstJsonObject('{"a": 1, "b":')).toBeNull();
  });
});

describe("repairClaudeJson", () => {
  async function makeTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "claude-json-repair-"));
  }

  test("returns null when .claude.json does not exist", async () => {
    const dir = await makeTempDir();
    const result = await repairClaudeJson(dir);
    expect(result).toBeNull();
  });

  test("returns null when .claude.json is valid", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, ".claude.json"),
      JSON.stringify({ allowedTools: ["Bash"] }),
      "utf-8",
    );
    const result = await repairClaudeJson(dir);
    expect(result).toBeNull();
  });

  test("repairs double-JSON corruption and creates backup", async () => {
    const dir = await makeTempDir();
    const original = '{"a":1}{"a":1}';
    await writeFile(join(dir, ".claude.json"), original, "utf-8");

    const result = await repairClaudeJson(dir);
    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe(dir);
    expect(result!.original).toBe(original);

    // Repaired file should be valid JSON
    const repaired = await readFile(join(dir, ".claude.json"), "utf-8");
    expect(JSON.parse(repaired)).toEqual({ a: 1 });

    // Backup should contain the original broken content
    const backup = await readFile(result!.backupPath, "utf-8");
    expect(backup).toBe(original);
  });

  test("repairs trailing garbage and creates backup", async () => {
    const dir = await makeTempDir();
    const original = '{"tools":["Read"]}nd !== null, 10000);';
    await writeFile(join(dir, ".claude.json"), original, "utf-8");

    const result = await repairClaudeJson(dir);
    expect(result).not.toBeNull();

    const repaired = await readFile(join(dir, ".claude.json"), "utf-8");
    expect(JSON.parse(repaired)).toEqual({ tools: ["Read"] });

    const backup = await readFile(result!.backupPath, "utf-8");
    expect(backup).toBe(original);
  });

  test("returns null for completely unrecoverable content", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".claude.json"), "not json at all", "utf-8");

    const result = await repairClaudeJson(dir);
    expect(result).toBeNull();

    // Original should be untouched
    const content = await readFile(join(dir, ".claude.json"), "utf-8");
    expect(content).toBe("not json at all");
  });

  test("backup file name contains timestamp", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".claude.json"), '{"a":1}garbage', "utf-8");

    const result = await repairClaudeJson(dir);
    expect(result!.backupPath).toMatch(/\.claude\.json\.corrupt\.\d{4}-/);
  });
});
