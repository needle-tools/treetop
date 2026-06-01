import { test, expect, describe } from "bun:test";
import { joinSelectionRows, type SelectionRow } from "../src/clean-selection";

/** Terse row builder. `w` = isWrapped, `f` = fillsWidth. */
function row(text: string, w = false, f = false): SelectionRow {
  return { text, isWrapped: w, fillsWidth: f };
}

describe("joinSelectionRows", () => {
  test("empty selection → empty string", () => {
    expect(joinSelectionRows([])).toBe("");
  });

  test("single row is returned verbatim", () => {
    expect(joinSelectionRows([row("hello world")])).toBe("hello world");
  });

  test("real newlines (no wrap signals) are preserved", () => {
    expect(
      joinSelectionRows([row("line 1"), row("line 2"), row("line 3")]),
    ).toBe("line 1\nline 2\nline 3");
  });

  test("isWrapped rows collapse without a newline (Unix PTY)", () => {
    // "sed -i 'some very long command that wr" wrapped at the column edge.
    const rows = [
      row("sed -i 'some very long command that wr"),
      row("aps at the column boundary'", /* isWrapped */ true),
    ];
    expect(joinSelectionRows(rows)).toBe(
      "sed -i 'some very long command that wraps at the column boundary'",
    );
  });

  test("Windows ConPTY: no isWrapped, full-width prev row → collapse", () => {
    // ConPTY never sets isWrapped, so we fall back to fillsWidth on the
    // PREVIOUS row. First row reached the edge (fillsWidth=true) → join.
    const rows = [
      row(
        "tar -czf - --exclude=node_modules -C C:\\git\\supergit .",
        false,
        true,
      ),
      row("| ssh root@host 'tar -xzf - -C /opt/supergit'"),
    ];
    expect(joinSelectionRows(rows)).toBe(
      "tar -czf - --exclude=node_modules -C C:\\git\\supergit ." +
        "| ssh root@host 'tar -xzf - -C /opt/supergit'",
    );
  });

  test("Windows ConPTY: prev row not full width → keep the newline", () => {
    const rows = [
      row("echo done", false, /* fillsWidth */ false),
      row("echo next"),
    ];
    expect(joinSelectionRows(rows)).toBe("echo done\necho next");
  });

  test("width fallback is disabled once ANY row is isWrapped", () => {
    // Unix safety: a genuine full-width real line (fillsWidth=true) must NOT
    // collapse into the next when the selection already proves isWrapped
    // works on this PTY. Row 1 is a true soft-wrap; row 2 is a full-width
    // *real* line; row 3 is the next real line and must stay separate.
    const rows = [
      row("first command that is long and wr"),
      row("apped here", /* isWrapped */ true),
      row(
        "a-second-real-line-that-fills-the-full-terminal-width",
        false,
        true,
      ),
      row("third real line"),
    ];
    expect(joinSelectionRows(rows)).toBe(
      "first command that is long and wrapped here\n" +
        "a-second-real-line-that-fills-the-full-terminal-width\n" +
        "third real line",
    );
  });

  test("multiple consecutive soft wraps collapse into one line", () => {
    const rows = [
      row("aaaa", false, true),
      row("bbbb", false, true),
      row("cccc", false, true),
      row("dddd"),
    ];
    expect(joinSelectionRows(rows)).toBe("aaaabbbbccccdddd");
  });

  test("mix of soft-wrap and real newlines (Windows fillsWidth path)", () => {
    const rows = [
      row("first line that is very long and wra", false, true), // wraps →
      row("ps to the next row"), // continuation, prev not full → real break after
      row("second real line"),
      row("third line also wraps at the col bo", false, true), // wraps →
      row("undary here"),
    ];
    expect(joinSelectionRows(rows)).toBe(
      "first line that is very long and wraps to the next row\n" +
        "second real line\n" +
        "third line also wraps at the col boundary here",
    );
  });
});
