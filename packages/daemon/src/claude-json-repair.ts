/**
 * Detect and repair corrupted .claude.json files.
 *
 * On Windows, when supergit hard-kills Claude Code PTYs during shutdown,
 * .claude.json can end up with a second JSON chunk appended — making the
 * whole file unparseable. This module detects that pattern, backs up the
 * original, and writes the repaired version.
 */

import { readFile, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface RepairResult {
  repoPath: string;
  backupPath: string;
  original: string;
  repaired: string;
}

/**
 * Try to extract the first complete top-level JSON object from a string
 * that may contain trailing garbage (a second JSON chunk, partial write, etc.).
 *
 * Returns the parsed object and the cleaned source string, or null if
 * no valid JSON object can be recovered.
 */
export function extractFirstJsonObject(raw: string): {
  json: unknown;
  source: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;

  // Walk the string tracking brace depth, respecting string literals.
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(0, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          return { json: parsed, source: candidate };
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Check a single .claude.json file for corruption.
 * Returns null if the file is fine (or doesn't exist).
 * If corrupted and repairable, backs up the original and writes the fix.
 */
export async function repairClaudeJson(
  repoPath: string,
): Promise<RepairResult | null> {
  const filePath = join(repoPath, ".claude.json");

  try {
    await access(filePath);
  } catch {
    return null; // file doesn't exist, nothing to do
  }

  const raw = await readFile(filePath, "utf-8");

  // Fast path: file parses fine
  try {
    JSON.parse(raw);
    return null;
  } catch {
    // fall through to repair
  }

  const extracted = extractFirstJsonObject(raw);
  if (!extracted) return null; // can't recover anything useful

  // Back up the broken original before touching it
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(repoPath, `.claude.json.corrupt.${ts}`);
  await copyFile(filePath, backupPath);

  // Write the repaired version (pretty-printed to match Claude Code's format)
  const repaired = JSON.stringify(extracted.json, null, 2) + "\n";
  await writeFile(filePath, repaired, "utf-8");

  return {
    repoPath,
    backupPath,
    original: raw,
    repaired,
  };
}

/**
 * Scan all monitored repos and repair any corrupted .claude.json files.
 * Returns the list of repairs performed.
 */
export async function repairAllClaudeJson(
  repoPaths: string[],
): Promise<RepairResult[]> {
  const results: RepairResult[] = [];
  for (const repoPath of repoPaths) {
    try {
      const result = await repairClaudeJson(repoPath);
      if (result) results.push(result);
    } catch (err) {
      console.error(
        `supergit: failed to check .claude.json in ${repoPath}:`,
        err,
      );
    }
  }
  return results;
}
