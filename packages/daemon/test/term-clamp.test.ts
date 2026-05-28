/**
 * Regression contract for the bug where xterm.js would propose 2 cols
 * before its container had laid out, the daemon happily spawned a PTY
 * at 2 cols, zsh wrapped the prompt onto itself, and every keystroke
 * looked like it "cleared the row" while quotes got swallowed and zsh
 * landed in `dquote>`.
 *
 * Two layers:
 *   1. Pure-function unit tests for the clamp itself.
 *   2. End-to-end PTY spawn through NodePtyBackend at a clamped size,
 *      asserting `stty size` round-trips the expected dimensions
 *      (proves the clamped value reaches node-pty intact).
 */

import { test, expect, describe, afterAll } from "bun:test";
import { clampCols, clampRows, MIN_COLS, MIN_ROWS } from "../src/term-clamp";
import { NodePtyBackend } from "../src/terminals/node-pty-backend";

describe("clampCols / clampRows", () => {
  test("near-zero cols floor up to 80 (the FitAddon-before-layout case)", () => {
    expect(clampCols(0)).toBe(80);
    expect(clampCols(1)).toBe(80);
    expect(clampCols(2)).toBe(80); // the actual observed garbage value
    expect(clampCols(MIN_COLS - 1)).toBe(80);
  });

  test("near-zero rows floor up to 24", () => {
    expect(clampRows(0)).toBe(24);
    expect(clampRows(1)).toBe(24);
    expect(clampRows(MIN_ROWS - 1)).toBe(24);
  });

  test("at-floor values pass through (boundary)", () => {
    expect(clampCols(MIN_COLS)).toBe(MIN_COLS);
    expect(clampRows(MIN_ROWS)).toBe(MIN_ROWS);
  });

  test("sane values pass through unchanged", () => {
    expect(clampCols(80)).toBe(80);
    expect(clampCols(120)).toBe(120);
    expect(clampRows(24)).toBe(24);
    expect(clampRows(50)).toBe(50);
  });

  test("absurdly large values clamp down to a ceiling", () => {
    expect(clampCols(100_000)).toBeLessThanOrEqual(1000);
    expect(clampRows(100_000)).toBeLessThanOrEqual(1000);
  });

  test("non-numeric / NaN / undefined fall back to defaults", () => {
    expect(clampCols(undefined)).toBe(80);
    expect(clampCols(null)).toBe(80);
    expect(clampCols("not a number")).toBe(80);
    expect(clampCols(NaN)).toBe(80);
    expect(clampRows(undefined)).toBe(24);
    expect(clampRows(null)).toBe(24);
  });

  test("fractional values floor to integers (node-pty wants ints)", () => {
    expect(clampCols(80.7)).toBe(80);
    expect(clampRows(24.9)).toBe(24);
  });
});

describe.skipIf(process.platform === "win32")(
  "PTY round-trip with clamped dimensions",
  () => {
    const backend = new NodePtyBackend();

    afterAll(async () => {
      await backend.shutdown();
    });

    // The bug presented as zsh seeing a 2-col terminal. Prove that when
    // we spawn with the clamped value (80x24), `stty size` inside the
    // PTY echoes back 24 80 — i.e. dimensions truly land at node-pty,
    // not just at the JSON layer.
    test("spawn at clamped 80x24 → stty size reports 24 80", async () => {
      const cols = clampCols(2);
      const rows = clampRows(2);
      expect(cols).toBe(80);
      expect(rows).toBe(24);

      const handle = await backend.spawn({
        cmd: ["bash", "-c", "stty size; exit 0"],
        cwd: "/tmp",
        size: { cols, rows },
      });

      let output = "";
      const done = new Promise<void>((resolve) => {
        handle.subscribe({
          onData(chunk) {
            output += new TextDecoder().decode(chunk);
          },
          onExit() {
            resolve();
          },
        });
      });
      await done;

      // `stty size` prints "<rows> <cols>" — assert both made the trip
      // intact. The bug would have shown e.g. "24 2" here.
      expect(output).toMatch(/\b24\s+80\b/);
    }, 10_000);

    test("spawn at sane 120x40 round-trips unchanged", async () => {
      const handle = await backend.spawn({
        cmd: ["bash", "-c", "stty size; exit 0"],
        cwd: "/tmp",
        size: { cols: 120, rows: 40 },
      });

      let output = "";
      const done = new Promise<void>((resolve) => {
        handle.subscribe({
          onData(chunk) {
            output += new TextDecoder().decode(chunk);
          },
          onExit() {
            resolve();
          },
        });
      });
      await done;

      expect(output).toMatch(/\b40\s+120\b/);
    }, 10_000);
  },
);
