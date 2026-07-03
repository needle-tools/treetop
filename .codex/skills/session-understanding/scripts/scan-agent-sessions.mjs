#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const sinceMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
const roots = args.roots.length
  ? args.roots
  : [`${homedir()}/.codex/sessions`, `${homedir()}/.claude/projects`];

const summary = {
  days: args.days,
  roots: [],
  files: 0,
  rows: 0,
  malformedRows: 0,
  toolCalls: new Map(),
  toolResults: 0,
  commands: new Map(),
  commandHeads: new Map(),
  gitCommands: new Map(),
  testCommands: new Map(),
  examples: [],
};

for (const root of roots) {
  const resolved = resolve(expandHome(root));
  const rootStat = await statOrNull(resolved);
  if (!rootStat) continue;
  summary.roots.push(resolved);
  for await (const file of walkJsonl(resolved, sinceMs)) {
    await scanJsonl(file);
  }
}

printSummary(summary, args);

function parseArgs(argv) {
  const parsed = {
    days: 30,
    roots: [],
    limit: 25,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") parsed.days = Number(argv[++index] ?? parsed.days);
    else if (arg.startsWith("--days=")) parsed.days = Number(arg.slice(7));
    else if (arg === "--root") parsed.roots.push(argv[++index] ?? "");
    else if (arg.startsWith("--root=")) parsed.roots.push(arg.slice(7));
    else if (arg === "--limit") parsed.limit = Number(argv[++index] ?? parsed.limit);
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice(8));
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  parsed.days = Number.isFinite(parsed.days) && parsed.days > 0 ? parsed.days : 30;
  parsed.limit = Number.isFinite(parsed.limit) && parsed.limit > 0 ? parsed.limit : 25;
  parsed.roots = parsed.roots.filter(Boolean);
  return parsed;
}

function printHelp() {
  console.log(`scan-agent-sessions.mjs

Stream-scan Codex/Claude JSONL sessions for tool and command patterns.

Options:
  --days N       Include files modified in the last N days (default: 30)
  --root PATH    Scan a specific root. Can be repeated.
  --limit N      Number of top rows/examples to print (default: 25)
  --json         Print machine-readable JSON
`);
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function* walkJsonl(root, since) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkJsonl(path, since);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const info = await statOrNull(path);
    if (!info || info.mtimeMs < since) continue;
    yield path;
  }
}

async function scanJsonl(file) {
  summary.files += 1;
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    summary.rows += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      summary.malformedRows += 1;
      continue;
    }
    for (const tool of extractToolCalls(event)) {
      bump(summary.toolCalls, tool.name);
      const command = commandFromInput(tool.input);
      if (!command) continue;
      const normalized = normalizeCommand(command);
      bump(summary.commands, normalized);
      bump(summary.commandHeads, commandHead(normalized));
      if (isGitCommand(normalized)) bump(summary.gitCommands, normalized);
      if (isTestCommand(normalized)) bump(summary.testCommands, normalized);
      if (summary.examples.length < args.limit) {
        summary.examples.push({ file, tool: tool.name, command: normalized });
      }
    }
    if (isToolResult(event)) summary.toolResults += 1;
  }
}

function extractToolCalls(event) {
  const calls = [];
  const payload = event?.payload ?? event?.item;
  if (payload && typeof payload === "object") {
    const type = String(payload.type ?? "");
    if (type === "function_call" || type === "tool_use") {
      calls.push({
        name: String(payload.name ?? payload.toolName ?? "tool"),
        input: parseMaybeJson(payload.arguments ?? payload.input ?? payload.toolInput),
      });
    }
  }
  if (event?.type === "tool_use") {
    calls.push({
      name: String(event.name ?? event.toolName ?? "tool"),
      input: parseMaybeJson(event.arguments ?? event.input ?? event.toolInput),
    });
  }
  const content = event?.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      calls.push({ name: String(block.name ?? "tool"), input: parseMaybeJson(block.input) });
    }
  }
  return calls;
}

function isToolResult(event) {
  const payload = event?.payload ?? event?.item;
  if (payload && typeof payload === "object") {
    const type = String(payload.type ?? "");
    if (type === "function_call_output" || type === "tool_result") return true;
  }
  if (event?.type === "tool_result") return true;
  const content = event?.message?.content;
  return Array.isArray(content) && content.some((block) => block?.type === "tool_result");
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function commandFromInput(input) {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object") return "";
  for (const key of ["cmd", "command", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCommand(command) {
  let current = command.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i += 1) {
    const shell = current.match(
      /^(?:\/[\w/.-]+\/)?(?:zsh|bash|sh|dash|fish)\s+-[a-zA-Z]*c[a-zA-Z]*\s+(['"])([\s\S]*)\1$/,
    );
    if (shell) {
      current = shell[2].trim();
      continue;
    }
    const env = current.match(/^\/usr\/bin\/env\s+(?:-[^\s]+\s+)*(.*)$/);
    if (env) {
      current = env[1].trim();
      continue;
    }
    break;
  }
  return current;
}

function commandHead(command) {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (first.includes("=")) return "env";
  return first.split(/[\\/]/).pop() ?? first;
}

function isGitCommand(command) {
  return (
    /^git(?:\s|$)/.test(command) ||
    /\bgit\s+(?:show|diff|status|ls-files|log|add|commit)\b/.test(command)
  );
}

function isTestCommand(command) {
  return /\b(?:bun\s+test|npm\s+test|npm\s+run\s+test|pnpm\s+test|yarn\s+test|vitest|playwright\s+test|pytest|svelte-check|tsc\s+--noEmit)\b/.test(
    command,
  );
}

function bump(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function top(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function jsonReady(data, limit) {
  return {
    days: data.days,
    roots: data.roots,
    files: data.files,
    rows: data.rows,
    malformedRows: data.malformedRows,
    toolResults: data.toolResults,
    topTools: top(data.toolCalls, limit),
    topCommandHeads: top(data.commandHeads, limit),
    topCommands: top(data.commands, limit),
    topGitCommands: top(data.gitCommands, limit),
    topTestCommands: top(data.testCommands, limit),
    examples: data.examples.slice(0, limit),
  };
}

function printSummary(data, options) {
  const ready = jsonReady(data, options.limit);
  if (options.json) {
    console.log(JSON.stringify(ready, null, 2));
    return;
  }
  console.log(`Scanned ${ready.files} files, ${ready.rows} rows over ${ready.days}d`);
  console.log(`Roots: ${ready.roots.join(", ") || "(none found)"}`);
  console.log(`Malformed rows: ${ready.malformedRows}`);
  console.log(`Tool results: ${ready.toolResults}`);
  printSection("Top tools", ready.topTools);
  printSection("Top command heads", ready.topCommandHeads);
  printSection("Top git commands", ready.topGitCommands);
  printSection("Top test commands", ready.topTestCommands);
  printSection(
    "Command examples",
    ready.examples.map((item) => ({
      value: `${item.tool}: ${item.command}`,
      count: 1,
    })),
  );
}

function printSection(title, rows) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const row of rows) {
    console.log(`  ${String(row.count).padStart(5)}  ${row.value}`);
  }
}
