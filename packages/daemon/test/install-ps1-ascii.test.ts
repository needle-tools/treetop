import { test, expect } from "bun:test";
import { join } from "node:path";

/**
 * deploy/install.ps1 MUST be pure ASCII.
 *
 * Windows PowerShell 5.1 (the default on most Windows boxes) reads a script
 * with NO byte-order mark as the system ANSI codepage, NOT UTF-8. A no-BOM
 * UTF-8 file containing multi-byte chars (em dash, ellipsis, arrows, smart
 * quotes…) is therefore misdecoded — e.g. the arrow's UTF-8 bytes E2 86 92
 * become "â†'" under Windows-1252, and that stray 0x92 is an apostrophe that
 * opens an unterminated string. The whole script then fails to parse with
 * "The string is missing the terminator: '." and provisioning silently does
 * nothing (exit, blank log). This bit a real Windows provision.
 *
 * Keeping it ASCII-only makes it parse identically regardless of how
 * PowerShell guesses the encoding — no BOM games required. This guard fails
 * loudly if non-ASCII ever creeps back (invisible on macOS/Linux otherwise).
 */
test("deploy/install.ps1 is ASCII-only (Windows PowerShell 5.1 parses it)", async () => {
  const path = join(import.meta.dir, "../../../deploy/install.ps1");
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const offenders: Array<{ line: number; col: number; byte: number }> = [];
  let line = 1;
  let col = 1;
  for (const b of bytes) {
    if (b === 0x0a) {
      line++;
      col = 1;
      continue;
    }
    if (b > 0x7f) offenders.push({ line, col, byte: b });
    col++;
  }
  expect(
    offenders.length === 0
      ? "ok"
      : `non-ASCII bytes (Windows PowerShell 5.1 will mis-parse): ${offenders
          .slice(0, 10)
          .map((o) => `L${o.line}:${o.col}=0x${o.byte.toString(16)}`)
          .join(", ")}`,
  ).toBe("ok");
});
