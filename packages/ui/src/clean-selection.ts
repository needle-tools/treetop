/**
 * Clean a terminal selection by removing soft-wrap newlines.
 *
 * xterm.js's `getSelection()` inserts `\n` at every line boundary,
 * including soft-wrapped lines (where the terminal wrapped a long line
 * at its column width). This makes copied commands unusable when they
 * span multiple visual rows.
 *
 * `isWrapped` is a per-line callback (0-indexed within the selection)
 * that returns true when that line is a continuation of the previous
 * (i.e. a soft wrap, not a real newline). In xterm.js, this maps to
 * `buffer.getLine(y).isWrapped`.
 */
export function cleanSelection(
  raw: string,
  isWrapped: (lineIndex: number) => boolean,
): string {
  const lines = raw.split("\n");
  if (lines.length <= 1) return raw;

  let result = lines[0]!;
  for (let i = 1; i < lines.length; i++) {
    if (isWrapped(i)) {
      result += lines[i];
    } else {
      result += "\n" + lines[i];
    }
  }
  return result;
}
