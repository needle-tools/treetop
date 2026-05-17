/**
 * Sanitize PTY dimensions received from the browser.
 *
 * The xterm.js FitAddon can briefly propose near-zero columns when its
 * container hasn't laid out yet (Svelte onMount races flex-parent
 * settle on terminal columns that mount alongside neighbour activity).
 * If we forward `cols: 2` to node-pty, zsh draws the prompt at 2 cols
 * wide, wraps onto itself, and every keystroke overwrites the prompt.
 *
 * Visible symptom: "input clears the row" and zsh slides into `dquote>`
 * because the user's `"` gets visually lost in the redraw collision.
 *
 * Floor of 20x5 is below any usable display but well above the
 * garbage-layout range. Ceiling of 1000x1000 caps malformed huge
 * values from a buggy resize observer.
 */

export const MIN_COLS = 20;
export const MIN_ROWS = 5;
export const MAX_COLS = 1000;
export const MAX_ROWS = 1000;

export function clampCols(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < MIN_COLS) return 80;
  return Math.min(Math.floor(v), MAX_COLS);
}

export function clampRows(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < MIN_ROWS) return 24;
  return Math.min(Math.floor(v), MAX_ROWS);
}
