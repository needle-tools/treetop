import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Architectural rule: the daemon must not import anything from packages/ui.
 *
 * Why: the daemon ships to remote boxes via auto-provision. If it imports
 * UI code, the install-payload has to ship the entire UI tree (including
 * packages/ui/src/assets/) — and that has bitten us twice:
 *
 *   1. Path length: a deep asset path (>100 chars in the tarball) tripped
 *      a GNU LongLink tar header which electrobun's extractor.exe rejects
 *      with "TarUnsupportedFileType" → installer exits 1.
 *   2. Remote install cost: the UI's `bun install` and Vite build add
 *      ~30–60s and a pile of deps the remote daemon never needs (the UI
 *      runs on the operator's laptop and talks to the remote over the
 *      forward-only SSH tunnel — the remote serves API only).
 *
 * Keeping the boundary as a test means a future drive-by import that
 * pulls in a UI type or constant gets caught immediately, instead of
 * surfacing as a mysterious installer failure on the next Windows build.
 */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SRC_ROOT = join(import.meta.dir, "..", "src");

const FORBIDDEN = [
  /from\s+['"][^'"]*\bpackages[\\/]ui\b[^'"]*['"]/,
  /from\s+['"](?:\.{1,2}[\\/])+ui[\\/]/,
  /require\(\s*['"][^'"]*\bpackages[\\/]ui\b[^'"]*['"]\s*\)/,
  /require\(\s*['"](?:\.{1,2}[\\/])+ui[\\/]/,
  /import\(\s*['"][^'"]*\bpackages[\\/]ui\b[^'"]*['"]\s*\)/,
];

test("daemon source does not import from packages/ui", async () => {
  const files = await walk(SRC_ROOT);
  const violations: string[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip comment-only lines so prose like "// matches packages/ui/src/foo"
      // doesn't trip the regex.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const pat of FORBIDDEN) {
        if (pat.test(line)) {
          violations.push(`${relative(SRC_ROOT, file)}:${i + 1}  ${line.trim()}`);
          break;
        }
      }
    }
  }

  expect(
    violations,
    `Daemon code must not import from packages/ui. Found:\n  ${violations.join("\n  ")}`,
  ).toEqual([]);
});
