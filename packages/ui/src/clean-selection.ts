/**
 * Reconstruct a terminal selection as text, collapsing soft-wrap line
 * breaks so a command that visually spanned multiple rows pastes as one
 * runnable line.
 *
 * Why not just use xterm's `getSelection()`: xterm already collapses
 * soft-wrapped rows — but only when the buffer line carries
 * `isWrapped = true`. A Windows ConPTY never sets `isWrapped` (ConPTY
 * re-emits whole rows instead of relying on DECAWM autowrap), so every
 * wrapped row reads as a real newline and long commands paste broken
 * across lines. Reprocessing `getSelection()`'s output also can't be
 * trusted, because it has *already* collapsed wrapped rows on Unix, so a
 * line-index → buffer-row mapping no longer lines up.
 *
 * So the caller rebuilds the selection from the buffer itself — one
 * `SelectionRow` per buffer row, never pre-collapsed — and `joinSelectionRows`
 * decides each join from two signals:
 *   1. `isWrapped`  — authoritative on Unix PTYs; trusted whenever present.
 *   2. `fillsWidth` — the previous row reached the right edge with a
 *      non-whitespace cell (the ConPTY wrap signature). Used ONLY as a
 *      fallback when the whole selection carries no `isWrapped` flags, so
 *      Unix selections — where `isWrapped` is authoritative — never collapse
 *      a genuine full-width line into the next.
 *
 * Known limitation (Windows only): `fillsWidth` can't tell a soft-wrap from a
 * real command that just happens to end exactly at the last column with a
 * non-whitespace char — both look identical in the buffer. So on a ConPTY,
 * selecting e.g. a 20-col-wide `echo done-and-done!!` followed by `ls` glues
 * them into `echo done-and-done!!ls`. It needs the line to be *exactly* `cols`
 * wide AND end non-space AND sit in an all-unwrapped (Windows) selection, so
 * it's rare. The clean fix would be feeding xterm a `windowsPty` option so it
 * sets `isWrapped` itself, but that needs the daemon platform plumbed to each
 * terminal and wouldn't enable the heuristic we need on modern Win11 builds.
 * This is the same trade-off xterm's own Windows mode makes.
 *
 * Not fixable here at all: text copied from an agent TUI (Claude Code /
 * Codex) whose renderer *word-wraps its own output* to the terminal width.
 * Those breaks land on word boundaries and the rows end short of `cols`
 * with no `isWrapped` flag (confirmed: a 2-row selection at cols=86 reported
 * usedLen 78 and 73, lastCol blank, isWrapped=false). In the buffer that is
 * byte-for-byte identical to two genuinely separate lines (e.g. two list
 * items), so neither `isWrapped` nor `fillsWidth` can tell "one command
 * wrapped for display" from "two real lines" — the join information was
 * destroyed by the source app before it reached the terminal. This collapser
 * only recovers terminal soft-wraps (a long command wrapped by a shell), not
 * application word-wraps.
 */
export interface SelectionRow {
  /** The row's text, already trimmed to the selected column range. */
  text: string;
  /** xterm's per-line soft-wrap flag (buffer line `isWrapped`). */
  isWrapped: boolean;
  /** True when this row's last column holds a non-whitespace cell. */
  fillsWidth: boolean;
}

export function joinSelectionRows(rows: SelectionRow[]): string {
  if (rows.length === 0) return "";
  const anyWrapped = rows.some((r) => r.isWrapped);
  let out = rows[0]!.text;
  for (let i = 1; i < rows.length; i++) {
    const continuation =
      rows[i]!.isWrapped || (!anyWrapped && rows[i - 1]!.fillsWidth);
    out += (continuation ? "" : "\n") + rows[i]!.text;
  }
  return out;
}
