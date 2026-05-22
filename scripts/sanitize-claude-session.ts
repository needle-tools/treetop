#!/usr/bin/env bun
/**
 * Read a Claude session JSONL, replace all user content with placeholders,
 * and emit a sanitised version suitable for committing as a test fixture.
 *
 * Usage: bun run scripts/sanitize-claude-session.ts <input.jsonl> <output.jsonl>
 *
 * Preserves structure (field names, block types, role values) so the
 * parser is exercised against a realistic shape. Replaces:
 *   - cwd / sessionId / gitBranch / version / timestamp / uuid
 *   - any free-form text content (replaced with deterministic placeholder)
 *   - file_path / command / path tool inputs (replaced with stable values)
 */

import { readFile, writeFile } from "node:fs/promises";

// Fields whose VALUES are structural — keep them.
const STRUCTURAL_KEYS = new Set([
  "type",
  "role",
  "name",
  "isSidechain",
  "userType",
  "stop_reason",
  "stop_sequence",
]);

// Fields we replace with fixed deterministic values so a diff of the fixture
// vs reality stays clean.
function replaceField(key: string, _value: unknown): unknown | undefined {
  if (key === "cwd") return "/Users/test/repo";
  if (key === "sessionId") return "00000000-0000-0000-0000-000000000000";
  if (key === "gitBranch") return "main";
  if (key === "version") return "0.0.0";
  if (key === "timestamp") return "2026-01-01T00:00:00.000Z";
  if (key === "uuid" || key === "parentUuid" || key === "id" || key === "leafUuid")
    return "00000000-0000-0000-0000-000000000000";
  if (key === "model") return "claude-test";
  if (key === "tool_use_id") return "toolu_test_00000000";
  if (key === "summary") return "[summary redacted]";
  if (key === "file_path" || key === "path" || key === "filePath")
    return "/Users/test/repo/file.ts";
  if (key === "command") return "echo redacted";
  if (key === "old_string" || key === "new_string") return "[redacted]";
  if (key === "oldString" || key === "newString") return "[redacted]";
  if (key === "originalFile") return "[redacted text]";
  if (key === "structuredPatch") return [];
  if (key === "text") return "[redacted text]";
  if (key === "content" && typeof _value === "string") return "[redacted text]";
  return undefined; // signal "no override, recurse normally"
}

function sanitize(obj: unknown, parentKey = ""): unknown {
  if (typeof obj === "string") {
    if (parentKey === "" /* root string, unlikely */) return "[redacted]";
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => sanitize(v, parentKey));
  if (typeof obj === "object" && obj !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (STRUCTURAL_KEYS.has(k)) {
        out[k] = v;
        continue;
      }
      const replaced = replaceField(k, v);
      if (replaced !== undefined) {
        out[k] = replaced;
        continue;
      }
      out[k] = sanitize(v, k);
    }
    return out;
  }
  return obj;
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: sanitize-claude-session.ts <input.jsonl> <output.jsonl>");
    process.exit(1);
  }
  const raw = await readFile(input, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const sanitised = lines
    .map((l) => {
      try {
        return JSON.stringify(sanitize(JSON.parse(l)));
      } catch {
        return null;
      }
    })
    .filter((l): l is string => l !== null)
    .join("\n");
  await writeFile(output, sanitised + "\n");
  console.log(`wrote ${lines.length} sanitised lines -> ${output}`);
}

void main();
